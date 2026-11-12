import { readJsonBody, respond } from "@/lib/http";
import { payoutBrief, recordPayout, requirePayoutJob } from "@/lib/payout-job";

/** For the payout job: what is owed, and what to pay it with. */
export async function GET(request: Request) {
  return respond(async () => {
    await requirePayoutJob(request.headers.get("authorization"));
    return payoutBrief(Number(new URL(request.url).searchParams.get("days")));
  });
}

/** For the payout job: record a prize it has sent. */
export async function POST(request: Request) {
  return respond(async () => {
    await requirePayoutJob(request.headers.get("authorization"));
    const body = await readJsonBody(request);
    await recordPayout({ roundId: body.roundId, id: body.id, signature: body.signature });
    return { ok: true };
  });
}

// Looking back over months of games takes a while.
export const maxDuration = 60;
