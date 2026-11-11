import "./env";
import { writeFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { readTraining } from "../src/lib/store";
import { FEATURE_KEYS } from "../src/lib/telemetry/features";

/**
 * Summarise the training set: how much there is, how often the judge was
 * right, and who fooled it. Optionally write the feature table as CSV.
 *
 *   npm run training:report
 *   npm run training:report -- --csv training.csv
 */
const { values: args } = parseArgs({ options: { csv: { type: "string" } } });

async function main() {
  const examples = await readTraining();
  if (examples.length === 0) {
    console.log("No training data yet. Labelled sessions land in data/training/ as people and house bots play in the training room.");
    return;
  }
  const pct = (n: number, d: number) => (d ? `${((n / d) * 100).toFixed(0)}%` : "n/a");
  const humans = examples.filter((e) => e.label === "human");
  const agents = examples.filter((e) => e.label === "agent");
  console.log(`${examples.length} labelled examples across ${new Set(examples.map((e) => e.roundId)).size} round(s)`);
  console.log(`  humans: ${humans.length}, judged human ${pct(humans.filter((e) => e.judgeCorrect).length, humans.length)} of the time`);
  console.log(`  agents: ${agents.length}, caught ${pct(agents.filter((e) => e.judgeCorrect).length, agents.length)} of the time`);

  const byCohort = new Map<string, number>();
  for (const e of examples) byCohort.set(e.cohortId, (byCohort.get(e.cohortId) ?? 0) + 1);
  console.log(`  cohorts: ${[...byCohort].map(([id, n]) => `${id} (${n})`).join(", ")}`);

  const fooled = agents.filter((e) => !e.judgeCorrect).sort((a, b) => b.judge.score - a.judge.score);
  if (fooled.length) {
    console.log("\nAgents that passed as human:");
    for (const e of fooled.slice(0, 15)) console.log(`  ${e.judge.score.toFixed(1).padStart(5)}  ${e.handle}  (${e.roundId})`);
  }
  const wronged = humans.filter((e) => !e.judgeCorrect).sort((a, b) => a.judge.score - b.judge.score);
  if (wronged.length) {
    console.log("\nHumans judged to be machines:");
    for (const e of wronged.slice(0, 15)) console.log(`  ${e.judge.score.toFixed(1).padStart(5)}  ${e.handle}  (${e.roundId})`);
  }

  if (args.csv) {
    const header = ["entryId", "roundId", "cohort", "label", "judgeScore", ...FEATURE_KEYS];
    const rows = examples.map((e) =>
      [e.entryId, e.roundId, e.cohortId, e.label, e.judge.score, ...FEATURE_KEYS.map((k) => e.features[k] ?? "")].join(","),
    );
    writeFileSync(args.csv, [header.join(","), ...rows].join("\n") + "\n");
    console.log(`\nWrote ${rows.length} rows to ${args.csv}`);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
