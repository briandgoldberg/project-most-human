import { leaveFeedback } from "@/lib/feedback";
import { readJsonBody, respond } from "@/lib/http";
import { currentPlayer } from "@/lib/session";

/** A signed-in player's feedback or question, kept for the owner to read. */
export async function POST(request: Request) {
  return respond(async () => {
    const body = await readJsonBody(request);
    return leaveFeedback(await currentPlayer(), { text: body.text, email: body.email, page: body.page });
  });
}
