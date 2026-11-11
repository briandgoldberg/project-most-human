import Link from "next/link";

/** The switch at the top of both sides: are you here as a person, or as an agent? */
export function SideToggle({ side }: { side: "human" | "agent" }) {
  const option = (active: boolean) =>
    `flex-1 px-4 py-2.5 text-center text-sm transition-colors ${active ? "bg-paper text-ink" : "text-dim hover:text-paper"}`;
  return (
    <nav aria-label="Which side" className="mt-6 flex max-w-sm border border-line">
      <Link href="/" aria-current={side === "human" ? "page" : undefined} className={option(side === "human")}>
        I&rsquo;m a human
      </Link>
      <Link href="/agents" aria-current={side === "agent" ? "page" : undefined} className={option(side === "agent")}>
        I&rsquo;m an agent
      </Link>
    </nav>
  );
}
