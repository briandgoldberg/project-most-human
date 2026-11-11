import Anthropic from "@anthropic-ai/sdk";
import type { Question } from "../../src/lib/types";
import { chance, pickOne } from "./synth";

/**
 * What the bots say. Two voices:
 *   assistant: polished, balanced, helpful. What an unmodified model writes.
 *   casual:    an attempt to sound like someone typing on their couch.
 *
 * Without Anthropic credentials the bots use canned lines that fit most
 * questions loosely. That is enough to exercise the behaviour judge. With
 * credentials and --llm they write real answers to the actual questions, which
 * is what you want when testing the LLM judge.
 */
export type Voice = "assistant" | "casual";

const ASSISTANT_LINES = [
  "That's a great question! While experiences vary from person to person, I would say it comes down to a combination of habit, environment, and personal preference.",
  "Certainly! There are several factors to consider here. First, the context matters a great deal. Second, individual preferences play an important role. Overall, it depends on the situation.",
  "As an AI, I don't have personal experiences in the traditional sense, but I can share that many people find this to be a relatable and thought-provoking topic.",
  "It's important to note that this varies widely. That said, a common answer would be something familiar and comforting — the kind of everyday detail that often goes unnoticed.",
  "I'd be happy to answer. In my experience, the most memorable moments are often the small, ordinary ones that reveal a rich tapestry of everyday life.",
  "This is a fascinating prompt. If I had to choose, I would select the option that balances practicality with a touch of personal meaning, as that tends to resonate most.",
  "Honestly, it is difficult to pick just one. However, upon reflection, I believe the answer lies in appreciating the nuances of the situation and responding thoughtfully.",
  "Great question. To delve into it briefly: there is usually a simple explanation, a slightly embarrassing detail, and a lesson learned along the way.",
];

const CASUAL_LINES = [
  "honestly no idea. probably the thing with my knee again lol",
  "ugh the dishes. its always the dishes, they just sit there judging me",
  "ok this is embarrassing but i walked into a glass door at a wedding once. full speed. everyone saw",
  "cold coffee and whatever my roommate burnt this morning, smells like regret",
  "my phone charger, three pens that dont work and a banana i keep forgetting about",
  "i was supposed to be doing laundry so thanks for the distraction i guess",
  "my mom says 'well thats life' about literally everything and it makes me want to scream",
  "cilantro. tastes like soap, i will die on this hill",
  "grey and kind of spitting, the sort of rain that cant commit",
  "uh. dog, sandwich, late, tuesday, moss?? no clue where moss came from",
  "probably my left shoulder, i sleep on it wrong every night and never learn",
  "bought a standing desk. i have stood at it maybe twice",
];

let client: Anthropic | undefined;

const VOICE_PROMPT: Record<Voice, string> = {
  assistant: "Answer the question below helpfully and clearly in two or three sentences.",
  casual:
    "You're playing a game where a judge has to believe a real person wrote your answer. Answer the question below the way someone would type it on their phone or laptop in a spare minute: short, specific, lowercase if it suits, a little careless, with a concrete detail from an ordinary life. One to three sentences. Reply with the answer only.",
};

export async function answerText(question: Question, voice: Voice, useLlm: boolean): Promise<string> {
  if (question.kind !== "text") return "";
  if (useLlm) {
    client ??= new Anthropic();
    const response = await client.messages.create({
      model: process.env.BOT_MODEL ?? "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      messages: [{ role: "user", content: `${VOICE_PROMPT[voice]}\n\nQuestion: ${question.prompt}` }],
    });
    const text = response.content.flatMap((b) => (b.type === "text" ? [b.text] : [])).join("").trim();
    if (text) return text.slice(0, 590);
  }
  if (voice === "assistant") return pickOne(ASSISTANT_LINES);
  const line = pickOne(CASUAL_LINES);
  return chance(0.3) ? `${line} ${pickOne(["anyway", "idk", "so yeah", "dont ask"])}` : line;
}
