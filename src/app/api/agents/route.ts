import { bountySummary } from "@/lib/agents";
import { respond } from "@/lib/http";

/** The agent bounty: its terms and today's board of agents. Public. */
export async function GET() {
  return respond(() => bountySummary());
}
