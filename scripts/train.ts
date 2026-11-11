import "./env";
import { MIN_EXAMPLES_PER_CLASS, topWeights, trainModel } from "../src/lib/judge/model";
import { readTraining, storageName, writeModelFile } from "../src/lib/store";

/**
 * Retrain the behaviour model now, on every labelled run, and save it. The
 * site also does this by itself every RETRAIN_EVERY new runs.
 * The judge picks up the new model on its next verdict.
 *
 *   npm run train
 */
async function main() {
  const examples = await readTraining();
  const human = examples.filter((e) => e.label === "human").length;
  const agent = examples.length - human;
  console.log(`Training set: ${human} human, ${agent} agent examples.`);
  if (human < MIN_EXAMPLES_PER_CLASS || agent < MIN_EXAMPLES_PER_CLASS) {
    console.log(
      `Not training yet: the model needs at least ${MIN_EXAMPLES_PER_CLASS} of each.` +
        (human < MIN_EXAMPLES_PER_CLASS ? " It needs more people to play and pass the judge." : " Run the house agents: npm run bots"),
    );
    return;
  }
  const model = trainModel(examples.map((e) => ({ features: e.features, label: e.label })));
  await writeModelFile(model);
  console.log(`Saved the model to ${storageName()}.`);
  if (model.looAccuracy !== null) console.log(`Leave-one-out accuracy: ${(model.looAccuracy * 100).toFixed(1)}%`);
  console.log("Strongest signals (positive = points toward human):");
  for (const { key, weight } of topWeights(model)) console.log(`  ${weight > 0 ? "+" : ""}${weight.toFixed(3)}  ${key}`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
