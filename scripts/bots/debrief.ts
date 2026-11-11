/**
 * The house's own agents explain themselves like any other agent that fools
 * the judge: what they did, an answer to each of the judge's questions, and
 * where their code is. Returns whether a debrief was owed and sent.
 */
export async function sendDebrief(url: string, token: string, about: { what: string; file: string }): Promise<boolean> {
  const post = async (pathname: string, body: unknown) => {
    const res = await fetch(new URL(pathname, url), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  const status = await post("/api/session", { token });
  const result = status.json.result as { debrief?: { questions: string[]; done: boolean } } | undefined;
  if (!result?.debrief || result.debrief.done) return false;

  const explanation = `House test agent. ${about.what}`;
  const answers = result.debrief.questions.map(
    () => `This is one of the house's own scripted agents, so there is nobody to ask: everything it did is in ${about.file}. ${about.what}`,
  );
  const sent = await post("/api/agents/debrief", { token, explanation, answers, code: `${about.file} in the game's own repository` });
  if (sent.status !== 200) throw new Error(`debrief rejected: ${sent.json.message}`);
  return true;
}

/** The session token the game page keeps in the browser, for bots that drive the page. */
export const SESSION_KEY = "pmh.session";
