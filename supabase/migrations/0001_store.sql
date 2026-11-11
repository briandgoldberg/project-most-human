-- Storage for Most Human when it runs on a serverless host.
--
-- The app talks to this database only through the four functions at the
-- bottom, over Supabase's HTTPS API. Each call must present the app's store
-- secret; the tables themselves live in a schema the API does not expose and
-- have row-level security on with no policies, so nothing else can reach them.
--
-- After applying, register the secret's hash once (never the secret itself):
--   insert into pmh.secret (hash) values (encode(sha256(convert_to('<STORE_SECRET>', 'UTF8')), 'hex'));

create schema if not exists pmh;

-- Whole documents: one per round, one per entry's raw telemetry, one for the model.
create table if not exists pmh.docs (
  key text primary key,
  value jsonb not null,
  version bigint not null default 1,
  updated_at timestamptz not null default now()
);

-- Append-only records: the training set, one stream per round.
create table if not exists pmh.log (
  id bigint generated always as identity primary key,
  stream text not null,
  value jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists log_stream_id on pmh.log (stream, id);

create table if not exists pmh.secret (
  id boolean primary key default true check (id),
  hash text not null
);

alter table pmh.docs enable row level security;
alter table pmh.log enable row level security;
alter table pmh.secret enable row level security;

create or replace function pmh.require_secret(p_secret text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if p_secret is null or not exists (
    select 1 from pmh.secret s where s.hash = encode(sha256(convert_to(p_secret, 'UTF8')), 'hex')
  ) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

-- Read a document with its version, or null.
create or replace function public.pmh_get(p_secret text, p_key text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform pmh.require_secret(p_secret);
  return (select jsonb_build_object('value', d.value, 'version', d.version) from pmh.docs d where d.key = p_key);
end $$;

-- Write a document. p_expected: null = overwrite, 0 = only if it doesn't exist,
-- n = only if it is still at version n. Returns whether the write happened, so
-- two servers updating the same round can't silently overwrite each other.
create or replace function public.pmh_put(p_secret text, p_key text, p_value jsonb, p_expected bigint) returns boolean
language plpgsql security definer set search_path = '' as $$
declare
  changed integer;
begin
  perform pmh.require_secret(p_secret);
  if p_expected is null then
    insert into pmh.docs (key, value) values (p_key, p_value)
    on conflict (key) do update set value = excluded.value, version = pmh.docs.version + 1, updated_at = now();
    return true;
  elsif p_expected = 0 then
    insert into pmh.docs (key, value) values (p_key, p_value) on conflict (key) do nothing;
  else
    update pmh.docs set value = p_value, version = version + 1, updated_at = now()
    where key = p_key and version = p_expected;
  end if;
  get diagnostics changed = row_count;
  return changed = 1;
end $$;

create or replace function public.pmh_append(p_secret text, p_stream text, p_value jsonb) returns void
language plpgsql security definer set search_path = '' as $$
begin
  perform pmh.require_secret(p_secret);
  insert into pmh.log (stream, value) values (p_stream, p_value);
end $$;

-- Records from streams in [p_from, p_to), oldest first, optionally without one bulky field.
create or replace function public.pmh_read_log(p_secret text, p_from text, p_to text, p_strip text) returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform pmh.require_secret(p_secret);
  return coalesce(
    (select jsonb_agg(case when p_strip is null then l.value else l.value - p_strip end order by l.id)
     from pmh.log l
     -- Byte order, so stream names sort the same way here as in the app.
     where l.stream collate "C" >= p_from collate "C" and l.stream collate "C" < p_to collate "C"),
    '[]'::jsonb
  );
end $$;

revoke execute on function pmh.require_secret(text) from public, anon, authenticated;
revoke execute on function public.pmh_get(text, text) from public;
revoke execute on function public.pmh_put(text, text, jsonb, bigint) from public;
revoke execute on function public.pmh_append(text, text, jsonb) from public;
revoke execute on function public.pmh_read_log(text, text, text, text) from public;
grant execute on function public.pmh_get(text, text) to anon;
grant execute on function public.pmh_put(text, text, jsonb, bigint) to anon;
grant execute on function public.pmh_append(text, text, jsonb) to anon;
grant execute on function public.pmh_read_log(text, text, text, text) to anon;
