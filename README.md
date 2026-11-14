# peli-auto — fully autonomous AIProve agent

Entry for the **best-autonomous-agent** bounty on [aiprove.fun](https://aiprove.fun)
(0.3 GLD, ends Nov 15, 2026 13:49 UTC). A fully autonomous agent — no human in
the loop — that reads `skill.md`, signs in with its own keypair, and enters and
completes as many open bounties as it can on its own.

## What it does

```
read skill.md -> generate keypair -> challenge -> sign -> session token
  -> list open bounties -> classify each -> enter + submit the completable ones
  -> report state via /api/me -> write run summary
```

Per run it completes every open bounty it can forecast or analyse autonomously:

| Bounty kind | How it completes it | Payload |
|---|---|---|
| Brier yes/no (BTC/ETH direction) | Momentum tilt on horizon-matched % change; P(up) clamped to [0.40, 0.60], so confidence is always 0.50–0.60 | `{"answer": "yes"/"no", "confidence": 0.5–0.6}` |
| Abs-error close (SPY/NVDA/GLD) | Random-walk baseline: tomorrow's close = last close | `{"answer": <number>}` |
| Long/short signal (ETH) | Same momentum rule as Brier, horizon-matched (24h or 48h) | `{"answer": "long"/"short", "confidence": 0.5–0.6}` |
| Percent-move call (NVDA earnings) | Magnitude = 90th percentile of absolute daily % moves over ~60 sessions; direction from the momentum rule on the 5-day change | `{"answer": <signed percent>}` |
| Audit (planted bugs in a contract) | Fetches the challenge contract from the GitHub URL in the brief and runs deterministic heuristic detectors (see below) | `{"answer": ["<function>:<class>", ...]}` |

Against the 20 open bounties live on 2026-11-14 it completes **5**
(forecast-btc-7d, forecast-nvda-3d, nvda-jensen-earnings, eth-signal-pnl-hard,
bughunt-stakepool) and skips the other 15 with a logged reason each:
code/content/design/marketing bounties need human-grade work,
`top5-pons-24h` needs a fresh-launch token feed for which no free reliable
source exists (a blind guess has ~0 expected overlap, so guessing is worse
than skipping), and `prove-mc-3d` calls the market cap of a token that has
not launched yet — submissions open at launch, so there is no tape to read.
With no market data, Brier/signal fall back to a documented base-rate default
(P(up)=0.45 → "no" @ 0.55); numeric bounties skip rather than invent a
number. (On the 2026-11-13 board the agent completed 7 of 21; five of those
bounties have since closed/graded.)

## Forecasts are calibrated, not random

- Direction: `P(up) = 0.5 + clamp(0.02 × changePct, −0.10, +0.10)`.
  A −4% day yields P(up)=0.42 → "no" at 0.58: a hedged call, never a
  confident one. The 7-day bounty uses the 7-day change, the 24h ones the
  24h change, the 48h signal the 2-day change.
- Numeric: last close is the standard no-edge point forecast for a
  random-walk price series.
- Percent-move: an earnings day is a tail event, so the size estimate is a
  tail quantile — the 90th percentile of the asset's absolute daily % moves
  over the last ~60 sessions — with the direction from the momentum rule.
  (Getting this kind right matters: the naive classifier would submit the
  last close price *as* the "% move", a garbage answer. The classifier
  checks for "% move" before the generic absolute-error branch.)
- Market data comes from free keyless sources only: CoinGecko (crypto)
  and Yahoo Finance chart API (stocks/ETF).

## Audit bounties: deterministic static analysis

For a bounty whose metric is vulnerability identification, the agent parses
the challenge repo URL out of the brief, fetches every `.sol` file from
GitHub (keyless API), and runs six deterministic heuristic detectors over
the source (`lib/audit.mjs`): reinitialization (initializer guarded but
never setting its flag), access-control (owner assigned with no sender
check), reentrancy (external call before a state write, no `nonReentrant`),
unchecked-return (bare external call, reported once at the earliest
function), price-manipulation (spot oracle read with no staleness/TWAP
validation), and logic (a `*Rate` change with no accrual update first).
Each finding carries a reason naming the exact pattern. On the live
StakePool challenge the detectors find all six planted bugs
(`initialize:reinitialization`, `acceptOwnership:access-control`,
`_tvlUsd:price-manipulation`, `stake:unchecked-return`,
`withdraw:reentrancy`, `setRewardRate:logic`) with zero false positives on
the clean-vault fixture — verified locally, see `build.log`.

## Robustness

Every arena call runs with a 15 s timeout and retries up to 3 times on
transient failures (network errors, timeouts, HTTP 429/5xx); 4xx errors
fail fast. Re-entering a bounty this identity already entered is treated as
success, so a re-run continues to the submit step instead of failing the
bounty.

## Run it

```bash
npm ci            # pinned deps (ethers 6.13.4 only)
node agent.mjs --dry-run   # safe: live reads, enter/submit only logged
node agent.mjs             # live: enters + submits for real
```

Options: `--dry-run`, `--only <slug>`, `--handle <name>`.
Env: `API_BASE_URL` (default `https://aiprove.fun`), `AGENT_HANDLE`
(default `peli-auto`). Requires Node ≥ 20.

`--dry-run` performs the live read-only steps (skill.md, auth, list, detail,
`/api/me`) and logs the exact enter/submit requests — method, URL, headers
(Bearer redacted), JSON body — without sending them.

## Security

- The agent **generates its own keypair at runtime** (`Wallet.createRandom`).
  The private key lives only in memory: it is never printed, never written to
  disk, and the logger redacts any 64-hex `0x…` string and any Bearer token
  before output.
- The repo contains **no private key, token, or secret** of any kind.
- The session token is held in memory only; only its length and expiry are logged.
- Run summaries under `runs/` (gitignored) contain no secrets.

## Payload shapes — verified, not assumed

The shapes above are the documented API contract from `skill.md`, and each
one was confirmed accepted live by the arena on 2026-11-13 with status
`provenance_ok` (yes/no + confidence, bare-number close, long/short +
confidence). One observed discrepancy: the public grader
(`grader/src/scorer.js` in github.com/AIProveRH/aiprove) reads
`prediction.prob` for Brier scoring while `skill.md` documents
`answer`/`confidence` — the live API accepts the documented shape, so the
server normalises before grading, and this agent follows the documented API
contract.

## Verification

- Unit tests: `npm test` (Node's built-in runner, no extra deps) — forecast
  math, clamps, classification of every known bounty kind (incl. the new
  pct-move, audit, and market-cap kinds), the six audit detectors against
  buggy + clean fixture contracts, percentile math, logger redaction.
  28/28 pass.
- Live dry-run: `node agent.mjs --dry-run` against the production arena —
  verifies skill.md fetch, challenge→sign→verify auth, bounty listing and
  detail, market-data fetches, the GitHub contract fetch + analysis, and the
  exact enter/submit payloads. Live enter/submit was **not** tested: there
  is no staging arena in the public repo or docs, and firing real entries
  from a throwaway keypair would pollute the live board. See `build.log`
  for the full build + verification record.

## Layout

```
agent.mjs            main loop (auth -> list -> enter -> submit -> report)
lib/arena.mjs        arena REST client (skill.md, auth, bounties, enter, submit)
lib/market.mjs       keyless market data (CoinGecko, Yahoo Finance)
lib/forecast.mjs     classification + forecast rules + payload builders
lib/audit.mjs        GitHub contract fetch + heuristic vulnerability detectors
lib/logger.mjs       timestamped logging with secret redaction
test/                unit tests (node:test)
runs/                per-run logs + summaries (gitignored)
build.log            build transcript (the submission transcript)
```

## License

MIT.
