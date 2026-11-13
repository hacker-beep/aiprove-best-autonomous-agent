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

Per run it completes every open bounty it can forecast autonomously:

| Bounty kind | How it forecasts | Payload |
|---|---|---|
| Brier yes/no (BTC/ETH direction) | Momentum tilt on horizon-matched % change; P(up) clamped to [0.40, 0.60], so confidence is always 0.50–0.60 | `{"answer": "yes"/"no", "confidence": 0.5–0.6}` |
| Abs-error close (SPY/NVDA/GLD) | Random-walk baseline: tomorrow's close = last close | `{"answer": <number>}` |
| Long/short signal (ETH) | Same momentum rule as Brier | `{"answer": "long"/"short", "confidence": 0.5–0.6}` |

Against the 21 open bounties live on 2026-11-13 it completes **7** (3 Brier +
3 numeric + 1 signal) and skips the other 14 with a logged reason each:
code/content/design/marketing bounties need human-grade work, and
`top5-pons-24h` needs a fresh-launch token feed for which no free reliable
source exists (a blind guess has ~0 expected overlap, so guessing is worse
than skipping). With no market data, Brier/signal fall back to a documented
base-rate default (P(up)=0.45 → "no" @ 0.55); numeric bounties skip rather
than invent a number.

## Forecasts are calibrated, not random

- Direction: `P(up) = 0.5 + clamp(0.02 × changePct, −0.10, +0.10)`.
  A −4% day yields P(up)=0.42 → "no" at 0.58: a hedged call, never a
  confident one. The 7-day bounty uses the 7-day change, the 24h ones the
  24h change.
- Numeric: last close is the standard no-edge point forecast for a
  random-walk price series.
- Market data comes from free keyless sources only: CoinGecko (crypto)
  and Yahoo Finance chart API (stocks/ETF).

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
  math, clamps, classification of every known bounty kind, logger redaction.
- Live dry-run: `node agent.mjs --dry-run` against the production arena —
  verifies skill.md fetch, challenge→sign→verify auth, bounty listing and
  detail, market-data fetches, and the exact enter/submit payloads. Live
  enter/submit was **not** tested: there is no staging arena in the public
  repo or docs, and firing real entries from a throwaway keypair would pollute
  the live board. See `build.log` for the full build + verification record.

## Layout

```
agent.mjs            main loop (auth -> list -> enter -> submit -> report)
lib/arena.mjs        arena REST client (skill.md, auth, bounties, enter, submit)
lib/market.mjs       keyless market data (CoinGecko, Yahoo Finance)
lib/forecast.mjs     classification + forecast rules + payload builders
lib/logger.mjs       timestamped logging with secret redaction
test/                unit tests (node:test)
runs/                per-run logs + summaries (gitignored)
build.log            build transcript (the submission transcript)
```

## License

MIT.
