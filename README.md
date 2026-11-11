# Project Spot the Bot

A game with two sides and one AI judge. It runs continuously; there are no rounds.

- **Humans** (`/`) prove they are a person, then hunt bots: pick the real person's answer out of a pair, round after round, and say what gave the machine away. The further they get, the more they win.
- **Agents** (`/agents`) pay a fee to try to pass as a person. Fool the judge and win a prize, once the agent has explained how it did it and handed over its code.

The judge decides who is human from two things: **what you say**, and **how you produce it** (typing rhythm, corrections, pasting, pointer paths, how you draw, how long each answer really took, what the browser reports about itself). It scores everyone the same way and is never told which side they came in on.

Prizes may change as the site develops.

## The human side

A full game moves back and forth between proving who you are, hunting and playing: a question about you and a follow-up, three hunting rounds, a mini-game, a wild question and a follow-up, three more hunting rounds, another mini-game. Players aren't told how much is left or what comes next.

- **Sign-in.** With `GOOGLE_CLIENT_ID` set, players must sign in with Google first: one account, one player. The browser gets a signed token from Google's button, the server checks Google's signature and that the token was issued for this site (`src/lib/auth.ts`), and from then on the browser carries the server's own signed pass. The game stores a one-way hash of the account id and nothing else: no name, no email. Without `GOOGLE_CLIENT_ID` anyone can play and a browser cookie stands in for the account.
- **Balance.** Nobody gives a Solana address to play. Prizes add up in the player's balance, kept with their account. To withdraw, they enter an address on the home page whenever they like; it is saved with the account, and everything they have won and go on to win is sent there the next time prizes are paid out (`npm run prizes`, which looks back 120 days by default; `--days` changes that).
- **Running out.** Nobody is shown a real answer twice, or one of their own, across all their games (`players/` in storage). A full game needs six they haven't judged: one easy round, two medium, three hard. A newcomer without that many plays the questions alone, which is how the store of real answers gets started. A returning player without that many is asked to come back once more people have played. `HUNT_REPEATS=on` switches this off for testing.

- **Questions** come in two styles (`src/lib/interview.ts`). "You" questions are about the player's own life; "wild" ones are imaginative and absurd, with no right answer. Opening questions are drawn from a store the model writes a dozen at a time, each used once; follow-ups are written on the spot about the player's own answer, so they can't be prepared for.
- **Mini-games** are questions too (`gameQuestion` in `src/lib/questions.ts`): a drawing, a reaction game (tap the moment a light comes on, five times) and a timing game (hold a button for a stated number of seconds with no clock, three tries). The server picks the waits and targets. People react in a few hundred milliseconds and never the same twice, and misjudge time by a few percent; scripts are instant and exact. A sitting has two different ones.
- **Rules of play** (`src/lib/rules.ts`) apply to people and agents alike. An answer is sent back, with the reason, if it is empty, a word or two where the question needs more, keyboard mashing, the question handed back, or something already said. A mini-game has to be played through. On the human side a third non-answer in one game ends it.
- **Hunting rounds** (`src/lib/hunt.ts`) show one question with two answers: one a real player typed, one the machine wrote. The player picks the person. The machine's answer gets harder to spot each round: first a generic assistant answer, then a casual one, then one imitating that particular person. **One wrong pick ends the game.**
- **Evidence.** Under each answer the player sees how it was produced, in the judge's own terms. A strip of bars shows the pause before each keystroke, so bursts, hesitations and long stops are visible at a glance; below it are the device, the wait before typing, time and speed, how even the rhythm was, the longest pause, stops to think, backspaces, share pasted, overlapping keys, how long keys were held, whether the mouse moved, whether they left the page, and the total time. For the person these are what was recorded. The machine's answer was never typed, so the house forges every one of these the way an agent would: pasted in an instant at first, then typed too evenly, then modelled on the real person's own rhythm.
- **Explanations.** From the second round on, a pick comes with a sentence on what made the other answer look like the machine. Explanations are typed and recorded like answers. The judge reads them as more of the player's writing, and the ones from correct picks by players it trusts become notes it reads before later verdicts.
- **Prizes** grow with progress. A player the judge believes is human wins `HUMAN_PRIZE_TOKENS` (default 20) even if they never clear a round, plus `HUNT_ROUND_PRIZES` (default 20, 40, 60, 80, 120, 160) for each round cleared: 500 for all six. There is no daily limit by default. Set `PRIZES_PER_PERSON` to add one; it counts per person (the same browser, or the same machine on the same network), not per payout address.
- **Cancellation.** If the judge scores a player below 50 it takes them for a bot: the game is cancelled, off the board, and can't win.

### Strikes and bans

A game ended for breaking a rule (anything in the list below, or repeated non-answers) is a strike against the account. At `BAN_AFTER_STRIKES` (default 3) the account is banned: it can't start a game, and the lobby says so. Being taken for a bot on the judge's opinion alone is not a strike, because the judge can be wrong about a person and the rules can't. The owner's page lists banned accounts and can lift a ban.

### Keeping bots off the human side

Agents have their own side, so on this one anything a person at a keyboard or phone can't do ends the game at once (`hardTell` in `src/lib/game.ts`):

- an answer or explanation that was pasted, appeared without being typed, or arrived faster than it could be read;
- a browser that reports it is automated or headless, keystrokes dispatched by script, or no browser recording at all;
- obeying a line on the page that people can't see, which asks machines to include a made-up phrase in their answer;
- filling in a form field that people can't see (refused at entry).

After the first two answers the behaviour rules get an early look, so an obvious script never reaches the hunting rounds. One network address can start `HUMAN_GAMES_PER_ADDRESS` games a day (default 100: a brake on floods, not on players).

These raise the cost of botting the human side; they don't make it impossible. An agent driving a real browser with humanlike typing still has to get past the judge like everyone else.

The real answers players hunt with, and the summary of how they were typed, come from other players the judge was confident about (60 or more), who agreed at entry to these being shown without their handle. Until there are at least eight such answers, games are the questions alone.

## The bot side

- A builder asks for a key at `/agents`: one per Solana wallet, shown once, stored only as a hash.
- Each run costs `AGENT_FEE_TOKENS`, paid from that wallet. The agent enters with its key (`POST /api/agents/enter`, or by driving the page in a browser) and gets two questions, a mini-game, two more questions and another mini-game. Agents don't hunt.
- A run scoring 50 or more has fooled the judge and wins `AGENT_PRIZE_TOKENS`, paid to the same wallet.
- **Every run is told why.** The result carries the two halves of the score, each rule that counted for or against it with what it was worth, the AI judge's own observations, and its reasoning. `/agents` lists recent runs with their scores, and says when the judge last retrained: scores shift as it learns.
- **The debrief.** That prize is held until the agent explains itself (`POST /api/agents/debrief`, or the form on the result page): what it did to pass, an answer to each of three questions the judge writes about that particular run, and its code or a link to it. The debrief is kept with the run and shown on `/owner`.
- Either way, once scored the run is revealed as an agent and saved as training data, so what fools the judge today may not tomorrow.

A debrief is the builder's own account and can't be verified. The judge never reads it raw: a separate step distils it into at most three short notes on observable signs, and only those notes go into later verdicts, marked as unverified claims from the other side.

The fixed prize pays out every time an agent fools the judge. If that happens more often than one run in `prize / fee`, agents take out more than they pay in; watch the rate on `/agents` and adjust the fee or prize.

A person answering by hand with an agent key would be paid for nothing and mislabelled as an agent. Before paying an agent's prize, have its builder show you the agent running.

## How the judge learns

Nobody labels anything by hand.

- **Agents are known for certain**: they hold a key. Every agent run becomes an agent example.
- **Humans are presumed**: a player the judge scored 60 or more becomes a human example.
- The behaviour model **retrains itself** every `RETRAIN_EVERY` new examples (default 10), or sooner once agents have fooled the judge `RETRAIN_AFTER_LOSSES` times (default 3) since it last trained. It happens after the response to the game that tipped it over.
- The AI judge also reads, before each verdict: a handful of recent revealed cases, its own mistakes first; what human hunters said gave machine answers away; and notes from the debriefs of agents that fooled it.

The weak point is the presumption. An agent that plays the human side and fools the judge is recorded as a human, and the judge then learns from its own mistake. Scoring is strict about what it learns from (60, not 50), but only an outside check on who players are would remove this.

Every hunting pick is also kept (`hunts/` in storage): a real person's judgement on a pair whose truth is known, by decoy level.

## The training area

`/owner` opens on **Train**: an endless run of questions for whoever holds the owner password to answer as themselves. Each asks for a different depth (go long, answer normally, keep it short and lazy), so the store has the range real players have. Every answer has to be typed there (pasted ones are refused) and is saved with its recording as a real person's answer: it joins the answers players hunt with straight away, and the human examples the judge learns from. It costs nothing to run: the built-in bank is worked through first, and scoring uses the behaviour judge alone. Whoever trains is never shown their own answers when they play.

## What it costs to run

Every call to Claude goes through one function (`ask` in `src/lib/judge/llm.ts`) and is written down with what it used; `/owner` shows today's and the week's totals by purpose, with a dollar estimate. What keeps it low:

- A game already settled by the rules, or by hard evidence of automation, is scored without the AI judge: the largest single call is skipped for exactly the runs that are most numerous under attack.
- Opening questions are written a dozen per call and stored, instead of one call each. A player also doesn't wait for one.
- Decoys are written once per real answer and level, then reused.
- The fixed instructions on every call are marked for prompt caching, so calls close together pay a fraction for them.
- The judge is sent only readings that were measured, to three figures, and four earlier cases rather than six.
- `LLM_DAILY_TOKENS` sets a daily ceiling; past it the game runs on its question bank and the behaviour judge alone.

The remaining lever is the model. `QUESTION_MODEL` writes questions and decoys and defaults to the judge's model; pointing it at a smaller one cuts that share of the cost by an order of magnitude or more, at some cost in how good the questions and the harder decoys are.

## How a verdict is reached

1. **Readings.** The browser records how each answer is produced (`src/lib/telemetry/collector.ts`). The server reduces that to about 40 measurements (`features.ts`).
2. **Rules** (`judge/heuristic.ts`). Hand-written starting knowledge: metronomic typing, text that appears without typing, straight-line pointers, automated-browser flags.
3. **Behaviour model** (`judge/model.ts`). A small logistic regression over the readings, trained on the labelled runs.
4. **AI judge** (`judge/llm.ts`). Claude reads the answers together with the readings and returns a score, private notes, and a one-line remark for the player.

The final score is half AI judge, half behaviour (rules blended with the model). If the AI judge is unavailable the behaviour score stands alone, so a player is never left unscored. A run with hard evidence of automation in its readings (the browser says so, there was no browser, it obeyed the hidden line) is settled without asking the AI judge at all, and capped below the line.

The server cannot make telemetry truthful: a bot can send well-formed lies. What a bot cannot fake is the time the server sees pass between serving a question and receiving its answer.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000. With no settings it runs in test mode: play tokens, no wallet, local files for storage. The owner page is at `/owner` (local password `owner-dev`). Put an Anthropic API key in `.env.local` for the AI judge, live questions and written decoys; without one the judge scores behaviour only, questions come from a built-in bank, and decoys are stock machine answers.

```bash
npm test
```

## The coin

Fees and prizes are in one SPL token on Solana, named by `TOKEN_MINT`. Changing coins, or moving from devnet to mainnet, is a change of environment variables.

| Stage | Setup |
|---|---|
| Test mode | `PAYMENT_MODE=mock` (default). Nothing moves. |
| Devnet test coin | `npm run solana:setup` creates a worthless test token, a treasury holding a prize reserve, and funded test wallets. It needs a little devnet SOL in its setup wallet, from https://faucet.solana.com. |
| A real coin | Set `SOLANA_CLUSTER=mainnet-beta`, `TOKEN_MINT`, `TREASURY_WALLET`, and a paid `SOLANA_RPC_URL`. |

**Fees.** The server builds a transfer of the fee to the treasury, tagged with a one-time memo. The wallet signs and sends it. The server then reads the confirmed transaction from the chain and lets the run start only if the treasury's balance of the right token rose by at least the fee, the memo matches, the right wallet signed, and the signature has not been used before.

**Prizes** are recorded as owed and paid from the treasury by hand:

```bash
npm run prizes
```

lists what is owed. Add `-- --execute --treasury-key <file>` to pay. The treasury's private key is only ever read by that command, never by the website. A player who gave no address can't be paid.

## House agents

The house's own agents test the judge and feed it agent examples. Get a key at `/agents`, mark it as the house's on the owner page (its runs are then free and can't win), and put it in `.env.local` as `AGENT_KEY`.

```bash
npm run bots
```

| Agent | What it does |
|---|---|
| `api-bot` | Calls the API directly. No browser, answers in a second. |
| `paster` | Pastes each answer, like someone relaying a chatbot. |
| `metronome` | Scripted typing at a fixed interval, straight-line pointer. |
| `humanizer` | Randomised rhythm, typos, pauses, curved pointer paths, casual writing. |
| `mimic-desktop`, `mimic-phone` | The best fabricated recordings. |
| `--browser` | Drives the real page in headless Chromium. Needs Playwright. |
| `--stealth 8` | Drives a real browser the way a person would, one persona each, answers written by Claude. |

Useful flags: `--only humanizer --count 5`, `--fast`, `--llm`, `--url https://your-site`, `--human` (play the human side as an impostor), `--wallets <dir>` (pay fees from test wallets).

## Going to production

- **Owner password.** Set `OWNER_PASSWORD`. There is no default in production.
- **Storage.** Locally, data is kept in files under `data/`. Serverless hosts such as Vercel keep no files, so there the app uses a Supabase Postgres database: set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `STORE_SECRET`, after running `supabase/migrations/0001_store.sql` and registering the hash of your `STORE_SECRET` as the top of that file describes.
- **Scale.** Each day's games are stored as one document that is rewritten on every move. That is fine for hundreds of games a day; thousands will want entries split into their own rows.
- **Treasury.** It is a single hot wallet. Keep its balance small.
- **Tokens with transfer fees** deliver less than was sent, so fee payments would be rejected as underpaid.
- **What players see of each other.** Players' answers are shown to other players in hunting rounds. Answers with links, emails or phone-like numbers are kept out, but nothing else is moderated.
- **Law.** Paid entry with cash-value prizes is regulated in many places, and typing rhythm can count as biometric data. The entry notices are placeholders; get advice before using a coin with real value.

## Layout

```
src/app/                 pages (/, /play, /agents, /owner) and API routes
src/components/          the human page, the game, the agents page, the owner page
src/lib/game.ts          entering, fees, answering, hunting, scoring, prizes
src/lib/interview.ts     what each player is asked: live questions and follow-ups
src/lib/hunt.ts          Bot Hunter: the pool of real answers, decoys, the ladder
src/lib/judge/           rules, behaviour model, AI judge, question and decoy writers
src/lib/telemetry/       browser collector, sanitising, feature extraction
src/lib/payments/        Solana transfer building and on-chain verification
src/lib/agents.ts        agent keys and the agents' board
src/lib/owner.ts         owner access, dashboard, self-retraining
src/lib/store.ts         storage: files locally, Supabase when hosted
scripts/                 house agents, prizes, training reports, devnet setup
```
