import { sessionStatus } from "@/lib/game";
import { readJsonBody, respond } from "@/lib/http";

/** Resume a session after a reload: the current question, or the result. */
export async function POST(request: Request) {
  return respond(async () => sessionStatus((await readJsonBody(request)).token));
}

export const maxDuration = 120;
