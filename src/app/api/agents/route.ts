import { agentSummary } from "@/lib/agents";
import { respond } from "@/lib/http";

/** The bot side at a glance: the fee, the pot, and how recent agents did. Public. */
export async function GET() {
  return respond(() => agentSummary());
}
