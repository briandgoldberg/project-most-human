import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { config } from "./config";
import { FOOLED_AT, GameError, agentBoard, bountyLeader, roundIdFor } from "./game";
import { isValidAddress } from "./payments/address";
import { readAgentKeys, readRound, updateAgentKeys } from "./store";
import type { AgentKey } from "./types";

/**
 * The agent bounty: keys for builders, and the board their agents are ranked on.
 *
 * A key looks like mh_agent_<id>_<secret>. Only a hash of the secret is kept,
 * so a lost key cannot be recovered, only replaced by the owner.
 */

const PREFIX = "mh_agent_";
const NAME = /^[A-Za-z0-9][A-Za-z0-9 _.-]{1,23}$/;
const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

/** Issue a key to a builder. One key per payout wallet. The key itself is returned once and never stored. */
export async function issueAgentKey(input: { name: unknown; wallet: unknown }): Promise<{ key: string; name: string }> {
  const name = (typeof input.name === "string" ? input.name : "").trim().replace(/\s+/g, " ");
  const wallet = typeof input.wallet === "string" ? input.wallet.trim() : "";
  if (!NAME.test(name)) throw new GameError(400, "bad_name", "Pick a builder name of 2 to 24 letters, numbers, spaces, or . _ -");
  if (!isValidAddress(wallet)) throw new GameError(400, "bad_wallet", "Give the Solana address the bounty should be paid to");

  const id = randomBytes(6).toString("hex");
  const secret = randomBytes(24).toString("base64url");
  await updateAgentKeys((keys) => {
    const taken = Object.values(keys);
    if (taken.some((k) => k.wallet === wallet)) {
      throw new GameError(409, "wallet_has_key", "That wallet already has an agent key. Each builder gets one.");
    }
    if (taken.some((k) => k.name.toLowerCase() === name.toLowerCase())) {
      throw new GameError(409, "name_taken", "That builder name is taken");
    }
    const key: AgentKey = { id, name, wallet, secretHash: sha256(secret), createdAt: Date.now() };
    keys[id] = key;
  });
  return { key: `${PREFIX}${id}_${secret}`, name };
}

/** The builder a presented key belongs to. Throws if it is malformed, unknown, wrong or switched off. */
export async function requireAgentKey(presented: unknown): Promise<AgentKey> {
  const refuse = () => new GameError(401, "bad_key", "That agent key isn't valid");
  if (typeof presented !== "string" || !presented.startsWith(PREFIX)) throw refuse();
  // mh_agent_<12 hex id>_<secret>; the secret may itself contain underscores.
  const body = presented.slice(PREFIX.length);
  const id = body.slice(0, 12);
  const secret = body.slice(13);
  if (body[12] !== "_" || !secret) throw refuse();
  const key = (await readAgentKeys())[id];
  const given = Buffer.from(sha256(secret), "hex");
  const stored = Buffer.from(key?.secretHash ?? "", "hex");
  if (!key || stored.length !== given.length || !timingSafeEqual(given, stored)) throw refuse();
  if (key.disabled) throw new GameError(403, "key_disabled", "This agent key has been switched off");
  return key;
}

export async function setAgentKeyDisabled(id: unknown, disabled: unknown): Promise<void> {
  await updateAgentKeys((keys) => {
    const key = typeof id === "string" ? keys[id] : undefined;
    if (!key) throw new GameError(404, "no_key", "No such agent key");
    key.disabled = disabled === true ? true : undefined;
  });
}

/** What anyone may see about the bounty: the terms and today's board. */
export async function bountySummary(roundId = roundIdFor()) {
  const cfg = config();
  const [state, keys] = await Promise.all([readRound(roundId), readAgentKeys()]);
  const board = state ? agentBoard(state) : [];
  const leading = state ? bountyLeader(state) : undefined;
  return {
    roundId,
    bounty: cfg.agentBounty,
    symbol: cfg.tokenSymbol,
    fooledAt: FOOLED_AT,
    entriesPerKey: cfg.agentEntriesPerKey,
    payout: state?.bountyPayout,
    board: board.slice(0, 100).map((e, i) => ({
      rank: i + 1,
      handle: e.handle,
      builder: keys[e.agentKeyId!]?.name ?? "unknown",
      score: e.result!.score,
      quip: e.result!.quip,
      fooled: e.result!.score >= FOOLED_AT,
      leading: e.id === leading?.id,
    })),
  };
}

/** For the owner: every key, and what it has done today. */
export async function agentKeysForOwner(roundId = roundIdFor()) {
  const [state, keys] = await Promise.all([readRound(roundId), readAgentKeys()]);
  const entries = state ? Object.values(state.entries).filter((e) => e.agentKeyId) : [];
  return Object.values(keys)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((k) => {
      const mine = entries.filter((e) => e.agentKeyId === k.id);
      const scores = mine.flatMap((e) => (e.result ? [e.result.score] : []));
      return {
        id: k.id,
        name: k.name,
        wallet: k.wallet,
        disabled: Boolean(k.disabled),
        entriesToday: mine.length,
        bestToday: scores.length ? Math.max(...scores) : null,
      };
    });
}
