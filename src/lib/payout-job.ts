import { config } from "./config";
import { GameError, markPrizePaid, prizesOwed } from "./game";
import { TokenRefused, verifyToken } from "./jwt";

/**
 * The website's side of the daily payout.
 *
 * Paying needs the treasury's key, which the website never holds: a job on
 * GitHub holds it. That job has no copy of the website's secrets either.
 * Instead it proves who it is. GitHub signs a short-lived token for every
 * workflow run, saying which repository, branch and workflow file it is; the
 * job presents that token here, and if it is the payout workflow on the main
 * branch of the right repository, it is told what is owed and where, and its
 * word is taken on what it has paid.
 */

const GITHUB_KEYS = "https://token.actions.githubusercontent.com/.well-known/jwks";
const GITHUB_ISSUER = "https://token.actions.githubusercontent.com";

const refuse = (why: string): never => {
  console.warn(`[payouts] refused: ${why}`);
  throw new GameError(401, "not_the_payout_job", "Only the payout job may ask this");
};

/** Check that a request comes from the payout workflow itself. `authorization` is the request's Authorization header. */
export async function requirePayoutJob(authorization: string | null | undefined, now = Date.now()): Promise<{ run: string; event: string }> {
  const job = config().payoutJob;
  if (!job.repository) throw new GameError(404, "payouts_off", "Payouts through the website aren't set up");
  const token = /^Bearer (.+)$/i.exec(authorization ?? "")?.[1];
  if (!token) return refuse("no token");
  const claims = await verifyToken(
    token,
    {
      keysUrl: GITHUB_KEYS,
      // For running the flow locally without GitHub. Never read in production.
      testKeys: process.env.NODE_ENV !== "production" ? process.env.GITHUB_TEST_JWKS : undefined,
      issuers: [GITHUB_ISSUER],
      audience: job.audience,
    },
    now,
  ).catch((err) => (err instanceof TokenRefused ? refuse(err.message) : Promise.reject(err)));

  const ref = `refs/heads/${job.branch}`;
  if (claims.repository !== job.repository) return refuse(`from repository ${String(claims.repository)}`);
  // Names can be given up and taken by someone else; GitHub's numbers for a repository and its owner can't.
  if (job.repositoryId && String(claims.repository_id) !== job.repositoryId) return refuse("repository id doesn't match");
  if (job.ownerId && String(claims.repository_owner_id) !== job.ownerId) return refuse("owner id doesn't match");
  if (claims.ref !== ref) return refuse(`from ${String(claims.ref)}, not the ${job.branch} branch`);
  if (claims.job_workflow_ref !== `${job.repository}/${job.workflow}@${ref}`) return refuse(`from workflow ${String(claims.job_workflow_ref)}`);
  if (claims.event_name !== "schedule" && claims.event_name !== "workflow_dispatch") return refuse(`started by ${String(claims.event_name)}`);
  return { run: String(claims.run_id ?? ""), event: String(claims.event_name) };
}

/** What the payout job needs to do its work: what is owed, and the coin and treasury to pay it from. */
export async function payoutBrief(days: number) {
  const cfg = config();
  const owed = await prizesOwed(Math.max(1, Math.min(365, Math.round(days) || 120)));
  return {
    owed: owed.map((e) => ({ id: e.id, roundId: e.roundId, handle: e.handle, wallet: e.wallet ?? null, prize: { tokens: e.prize!.tokens, reason: e.prize!.reason } })),
    pay: {
      paymentMode: cfg.paymentMode,
      symbol: cfg.tokenSymbol,
      cluster: cfg.solana.cluster,
      mint: cfg.solana.mint ?? null,
      treasury: cfg.solana.treasury ?? null,
      // The job uses the same connection to the chain as the website. It carries a key, so the job keeps it out of its log.
      rpcUrl: cfg.solana.rpcUrl,
    },
  };
}

const ROUND_ID = /^\d{4}-\d{2}-\d{2}$/;
const ENTRY_ID = /^[A-Za-z0-9_-]{6,40}$/;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

/** Record that a prize has been sent, with the transaction that sent it. */
export async function recordPayout(input: { roundId: unknown; id: unknown; signature: unknown }): Promise<void> {
  const { roundId, id, signature } = input;
  if (typeof roundId !== "string" || !ROUND_ID.test(roundId) || typeof id !== "string" || !ENTRY_ID.test(id)) {
    throw new GameError(400, "bad_prize", "That isn't a prize");
  }
  if (signature !== undefined && (typeof signature !== "string" || !SIGNATURE.test(signature))) {
    throw new GameError(400, "bad_signature", "That isn't a transaction signature");
  }
  await markPrizePaid({ roundId, id }, signature);
}
