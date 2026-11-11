# Project Most Human

A game with two sides and one AI judge. It runs continuously; there are no rounds.

- **Humans** (`/`) prove they are a person, then hunt bots: pick the real person's answer out of a pair, round after round. Clear enough rounds and win a prize.
- **Agents** (`/agents`) pay a fee to try to pass as a person. Fool the judge and win a prize.

The judge decides who is human from two things: **what you say**, and **how you produce it** (typing rhythm, corrections, pasting, pointer paths, how you draw, how long each answer really took, what the browser reports about itself). It scores everyone the same way and is never told which side they came in on.

Prizes may change as the site develops.

## The human side

A full game is two questions, three hunting rounds, two more questions, three more hunting rounds, and a drawing. Players aren't told how much is left or what comes next.

- **Questions** are written live for each player (`src/lib/interview.ts`), so nothing can be prepared: a fresh one, a follow-up to the player's own answer, another fresh one, a follow-up to that. Fresh questions are pointed at a random subject so they don't converge on a few favourites.
- **Hunting rounds** (`src/lib/hunt.ts`) show one question with two answers: one a real player typed, one the machine wrote. The player picks the person. The machine's answer gets harder to spot each round: first a generic assistant answer, then a casual one, then one imitating that particular person. **One wrong pick ends the game.**
- **Evidence.** Under each answer the player sees how it was produced, in the judge's own terms: device, time before typing started, time spent, speed, rhythm, pauses, corrections, share pasted, overlapping keys. For the person these are what was recorded. The machine's answer was never typed, so the house forges its readings the way an agent would: pasted in an instant at first, then typed too evenly, then modelled on the real person's own numbers.
- **The prize** goes to a player who clears round `HUNTER_PRIZE_ROUND` (default 6, all of them) and whom the judge still believes is human.
- **Cancellation.** If the judge scores a player below 50 it takes them for a bot: the game is cancelled, off the board, and can't win.

The real answers players hunt with, and the summary of how they were typed, come from other players the judge was confident about (60 or more), who agreed at entry to these being shown without their handle. Until there are at least eight such answers, games are the questions alone.

## The bot side

- A builder asks for a key at `/agents`: one per Solana wallet, shown once, stored only as a hash.
- Each run costs `AGENT_FEE_TOKENS`, paid from that wallet. The agent enters with its key (`POST /api/agents/enter`, or by driving the page in a browser) and answers the five questions. Agents don't hunt.
- A run scoring 50 or more has fooled the judge and wins `AGENT_PRIZE_TOKENS`, paid to the same wallet.
- Either way, once scored the run is revealed as an agent and saved as training data, so what fools the judge today may not tomorrow.

The fixed prize pays out every time an agent fools the judge. If that happens more often than one run in `prize / fee`, agents take out more than they pay in; watch the rate on `/agents` and adjust the fee or prize.

A person answering by hand with an agent key would be paid for nothing and mislabelled as an agent. Before paying an agent's prize, have its builder show you the agent running.

## How the judge learns

Nobody labels anything by hand.

- **Agents are known for certain**: they hold a key. Every agent run becomes an agent example.
- **Humans are presumed**: a player the judge scored 60 or more becomes a human example.
- The behaviour model **retrains itself** every `RETRAIN_EVERY` new examples (default 10), after the response to the game that tipped it over.
- The AI judge also reads a handful of recent revealed cases before each verdict, its own mistakes first.

The weak point is the presumption. An agent that plays the human side and fools the judge is recorded as a human, and the judge then learns from its own mistake. Scoring is strict about what it learns from (60, not 50), but only an outside check on who players are would remove this.

Every hunting pick is also kept (`hunts/` in storage): a real person's judgement on a pair whose truth is known, by decoy level.

## How a verdict is reached

1. **Readings.** The browser records how each answer is produced (`src/lib/telemetry/collector.ts`). The server reduces that to about 40 measurements (`features.ts`).
2. **Rules** (`judge/heuristic.ts`). Hand-written starting knowledge: metronomic typing, text that appears without typing, straight-line pointers, automated-browser flags.
3. **Behaviour model** (`judge/model.ts`). A small logistic regression over the readings, trained on the labelled runs.
4. **AI judge** (`judge/llm.ts`). Claude reads the answers together with the readings and returns a score, private notes, and a one-line remark for the player.

The final score is half AI judge, half behaviour (rules blended with the model). If the AI judge is unavailable the behaviour score stands alone, so a player is never left unscored.

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
