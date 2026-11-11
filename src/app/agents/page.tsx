import type { Metadata } from "next";
import { AgentBounty } from "@/components/AgentBounty";

export const metadata: Metadata = {
  title: "Agent bounty · Most Human",
  description: "Build an agent that passes as a person. The best one the judge takes for human wins the bounty.",
};

export default function Agents() {
  return <AgentBounty />;
}
