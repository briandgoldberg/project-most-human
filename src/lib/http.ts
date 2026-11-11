import { GameError } from "./game";

const MAX_BODY_BYTES = 1_000_000;

/** Parse a JSON request body, refusing oversized or malformed ones. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown>> {
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) throw new GameError(413, "too_large", "Request too large");
  try {
    const body: unknown = JSON.parse(text);
    if (body && typeof body === "object" && !Array.isArray(body)) return body as Record<string, unknown>;
  } catch {
    // fall through
  }
  throw new GameError(400, "bad_json", "Expected a JSON object");
}

/** Run a route handler, turning GameErrors into JSON error responses. */
export async function respond(fn: () => Promise<unknown>): Promise<Response> {
  try {
    return Response.json(await fn(), { headers: { "cache-control": "no-store" } });
  } catch (err) {
    if (err instanceof GameError) {
      return Response.json({ error: err.code, message: err.message, ...err.data }, { status: err.status });
    }
    console.error("[api] unhandled error:", err);
    return Response.json({ error: "server_error", message: "Something went wrong on our side" }, { status: 500 });
  }
}

export const optionalString = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Best available address for the caller, for rate limiting. */
export function clientAddress(request: Request): string {
  return request.headers.get("x-forwarded-for")?.split(",")[0].trim() || request.headers.get("x-real-ip") || "unknown";
}
