# Project Most Human

A daily game. An AI judge asks everyone the same few questions and scores how human each player seems, from 0 to 100. People play. Bots play too, pretending to be people. The most human player takes the pool.

The judge looks at two things: **what you say**, and **how you produce it** (typing rhythm, corrections, pasting, pointer paths, how you draw, how long each answer really took, what the browser reports about itself).

## Two doors, one judge

| | Daily competition | Training room |
|---|---|---|
| Where | `/` | `/train` |
| Who | Anyone | You and friends, behind a password. The house bots. |
| Cost | Entry fee, paid into the pool | Free |
| Questions | The day's set, same for everyone | A fresh draw every session |
| Outcome | A place on the board; top score wins the pool | A labelled training example |

The public page has no password field and its API ignores one. Training sessions never appear on the public board or count toward the pool.

**The judge is always blind.** For every session, in either door, it receives the questions, the answers and the behaviour readings, and nothing about who is playing. In the training room the truth (human or agent) is attached only after the score is final. That pair, what the judge thought and what was true, is what it learns from.

## Run it

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:3000 to play the competition in test mode (play tokens, no wallet). Open http://localhost:3000/train for the training room; the local password is `train-dev`.

For the AI judge to read answers, put an Anthropic API key in `.env.local` (see `.env.example`). Without one the judge scores behaviour only.

```bash
npm test
```

## How the judge works

1. **Readings.** The browser records how each answer is produced (`src/lib/telemetry/collector.ts`). The server reduces that to about 40 measurements per session (`features.ts`): keystroke-interval variation, key hold times, key overlap, correction rate, share of text pasted, pointer straightness and speed variation, drawing dynamics, server-observed answer times, and whether the client's story about timing matches when answers actually arrived.
2. **Rules** (`judge/heuristic.ts`). Hand-written starting knowledge: metronomic typing, text that appears without typing, straight-line pointers, automated-browser flags, and so on.
3. **Behaviour model** (`judge/model.ts`). A small logistic regression trained on the labelled sessions. It exists once there are at least 5 human and 5 agent sessions; retrain from the training room or with `npm run train`.
4. **AI judge** (`judge/llm.ts`). Claude reads the answers together with the readings and returns a score, private notes on what moved it, and a one-line remark for the player. It is also shown a handful of recent revealed cases, its own mistakes first, so it calibrates as data comes in.

The final score is half AI judge, half behaviour (rules blended with the model). If the AI judge is unavailable the behaviour score stands alone, so a player is never left unscored.

The server cannot make telemetry truthful: a bot can send well-formed lies. That is the game. What a bot cannot fake is the time the server sees pass between serving a question and receiving its answer, which is why questions are served one at a time.

## Training the judge

- **Humans:** you and friends play sessions in `/train` and choose "Me, a human". Use different devices: phone sessions look very different from keyboard sessions.
- **Agents:** point any agent at `/train` and choose "An AI agent", or run the house bots:

```bash
npm run bots
```

| Bot | What it does |
|---|---|
| `api-bot` | Calls the API directly. No browser, answers in a second. |
| `paster` | Pastes each answer, like someone relaying a chatbot. |
| `metronome` | Scripted typing at a fixed interval, straight-line pointer. |
| `humanizer` | Randomised rhythm, typos, pauses, curved pointer paths, casual writing. |
| `mimic-desktop` | Best desktop impersonation: overlapping keys, long-tailed pauses, distraction. |
| `mimic-phone` | Claims to be a phone, where there are fewer readings to get wrong. |
| `browser` (`--browser`) | Drives the real page in headless Chromium. Needs Playwright. |

Every house bot is recorded as an agent, however humanlike. Useful flags: `--only humanizer --count 5`, `--fast`, `--llm` (bots write real answers with Claude), `--url https://your-site`.

```bash
npm run training:report
```

```bash
npm run train
```

Training data is saved to `data/training/<date>.jsonl` (or the `pmh.log` table when using the database), one session per record: questions, answers, the feature vector, the raw telemetry (so new features can be computed later), the judge's verdict, and the truth.

## Money: testing before going live

Fees are paid in one SPL token on Solana, named by `TOKEN_MINT`. Changing coins, or moving from devnet to mainnet, is a change of environment variables.

| Stage | Setup | Risk |
|---|---|---|
| 1. Test mode | `PAYMENT_MODE=mock` (default) | None. Play tokens. |
| 2. Devnet | `npm run solana:setup` makes a throwaway token, treasury and funded player wallets | None. Devnet tokens are worthless. |
| 3. Mainnet, cheap coin | Buy a little of any existing meme coin; set `SOLANA_CLUSTER=mainnet-beta`, `TOKEN_MINT`, `TREASURY_WALLET` | Real, small. |
| 4. Your coin | Change `TOKEN_MINT` | Real. |

How a paid entry works: the server builds a transfer of the fee to the treasury, tagged with a one-time memo. The player's wallet (Phantom, Solflare, Backpack) signs and sends it. The server then reads the confirmed transaction from the chain and admits the player only if the treasury's balance of the right token rose by at least the fee, the memo matches, the entering wallet signed it, and the signature has not been used before. One entry per wallet per day.

Settling a round:

```bash
npm run payout -- --round 2026-11-11
```

That is a dry run showing the winner and the pool. Add `--execute --treasury-key <file>` to send it. The treasury's private key is only ever read by this command, never by the web server.

Devnet rehearsal: run `npm run solana:setup` (it will ask you to fund one wallet from https://faucet.solana.com, which is free), paste the settings it prints into `.env.local`, restart, then `npm run bots -- --paying --wallets .solana-dev/players` and `npm run payout`.

## Going to production

- **Passwords.** Set `TRAINING_PASSWORD` and `HOUSE_BOT_PASSWORD`. The dev passwords do not work in production.
- **Storage.** Locally, data is kept in files under `data/`. Serverless hosts such as Vercel keep no files, so there the app stores everything in a Supabase Postgres database instead: set `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `STORE_SECRET`. Set up a new database by running `supabase/migrations/0001_store.sql` and registering the hash of your `STORE_SECRET` as the comment at the top of that file describes. The app reaches the database only through four functions that require the secret; the tables are not exposed.
- **Scale.** A round is stored as one document that is rewritten on every answer. That is fine for hundreds of players a day; thousands will want entries split into their own rows.
- **RPC.** The public Solana endpoints are rate-limited; use a paid RPC on mainnet.
- **Treasury.** It is a single hot wallet holding the pool between payment and payout. Pay out promptly and keep its balance small, or move to an on-chain escrow program before pools get large.
- **Tokens with transfer fees** (some Token-2022 coins) deliver less than was sent, so entries would be rejected as underpaid. Use a coin without a transfer fee, or set the fee with that in mind.
- **Law.** Paying to enter a contest with a cash-value prize is regulated in many places. Get advice for the countries you plan to serve before turning on real payments.

## Layout

```
src/app/                 pages (/, /play, /train) and API routes
src/components/          lobby, entry form, game, training room
src/lib/game.ts          rounds, entering, answering, scoring, the label reveal
src/lib/judge/           rules, behaviour model, AI judge
src/lib/telemetry/       browser collector, sanitising, feature extraction
src/lib/payments/        Solana transfer building and on-chain verification
src/lib/training.ts      training-room access, dashboard, retraining
src/lib/questions.ts     the question bank and daily draw
src/lib/store.ts         storage: files locally, Supabase when hosted
supabase/migrations/     database schema for hosted storage
scripts/                 house bots, training, payout, devnet setup
```
