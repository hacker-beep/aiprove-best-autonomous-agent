// Forecasters + bounty classification.
//
// Payload shapes follow the documented API contract (skill.md) as proven live
// on 2026-11-13 (all accepted with status provenance_ok):
//   Brier yes/no:  {"answer": "yes"|"no", "confidence": 0..1}
//   Abs-error $:   {"answer": <number>}                     (single close forecast)
//   Signal:        {"answer": "long"|"short", "confidence": 0..1}
//   Pct-move:      {"answer": <number>}                     (signed % move)
//   Audit:         {"answer": ["<function>:<class>", ...]}   (finding tokens)
//
// NOTE on the public grader: grader/src/scorer.js reads prediction.prob for
// Brier scoring, while skill.md documents answer+confidence. The live API
// accepts answer+confidence, so the server normalises before grading; this
// agent follows the documented API contract, not the grader's internal shape.
//
// Forecast rules — calibrated, modest, never random:
//   Direction (Brier/signal): momentum tilt on the horizon-matched % change.
//     P(up) = 0.5 + clamp(0.02 * changePct, -0.10, +0.10)  ->  [0.40, 0.60]
//     so confidence always lands in [0.50, 0.60]. A -4% day gives P(up)=0.42,
//     i.e. answer "no" at 0.58 — a hedged call, never a confident one.
//     With no market data: base-rate default P(up)=0.45 ("no" @ 0.55).
//   Numeric close: random-walk baseline — tomorrow's close = last close.
//     The best no-edge point forecast; no data -> skip (no number without data).
//   Pct-move (earnings reaction): magnitude = 90th percentile of the asset's
//     absolute daily % moves over the last ~60 sessions (an earnings day is
//     a tail event, so a tail quantile of realised moves is the honest
//     data-driven size estimate); direction from the same momentum rule on
//     the 5-day change. Falls back to a documented 5.0% base rate when the
//     history is too short.
import { analyzeContract, extractGithubRepo, fetchContractSources } from "./audit.mjs";
import { crypto24hChange, cryptoNdChange, stockCloses, stockLastClose } from "./market.mjs";

/** P(up) from a % change, clamped to [0.40, 0.60]. */
export function momentumProb(changePct) {
  const p = 0.5 + 0.02 * changePct;
  return Math.min(0.6, Math.max(0.4, p));
}

/** {answer, confidence} for a yes/no direction call from P(up). */
export function directionPayload(probUp) {
  const answer = probUp >= 0.5 ? "yes" : "no";
  const confidence = Math.round(Math.max(probUp, 1 - probUp) * 100) / 100;
  return { answer, confidence };
}

/** {answer, confidence} for a long/short call from P(up). */
export function signalPayload(probUp) {
  const answer = probUp >= 0.5 ? "long" : "short";
  const confidence = Math.round(Math.max(probUp, 1 - probUp) * 100) / 100;
  return { answer, confidence };
}

/** q-th percentile of an array of numbers (q in 0..1), linear interpolation. */
export function percentile(values, q) {
  if (!values.length) throw new Error("percentile of empty array");
  const sorted = [...values].sort((a, b) => a - b);
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

const CRYPTO = { btc: "bitcoin", eth: "ethereum" };
const STOCKS = { spy: "SPY", nvda: "NVDA", gold: "GLD", gld: "GLD" };

function findAsset(slug, table) {
  const s = slug.toLowerCase();
  for (const [key, value] of Object.entries(table)) {
    if (s.includes(key)) return value;
  }
  return null;
}

/** Horizon in days parsed from bounty text ("48h" -> 2, "7d" -> 7, default 1). */
export function horizonDaysFromText(text) {
  const t = String(text || "");
  if (/7\s*d|7-day|7 day/i.test(t)) return 7;
  const h48 = t.match(/(\d+)\s*h\b/i);
  if (h48) return Math.max(1, Math.round(Number(h48[1]) / 24));
  if (/48[\s-]?hour/i.test(t)) return 2;
  return 1;
}

/**
 * Classify a bounty into what this agent can autonomously complete.
 * Returns { kind: "brier"|"numeric"|"signal"|"pctmove"|"audit"|"skip", reason?, asset?, horizonDays?, repo? }.
 */
export function classify(bounty) {
  const slug = bounty.slug || "";
  const metric = (bounty.metric || "").toLowerCase();
  const cat = (bounty.cat || "").toLowerCase();
  const text = `${bounty.title || ""} ${bounty.brief || ""}`;

  // Audit: a deliberately-vulnerable contract to analyse. Needs a challenge
  // repo URL in the brief to fetch the source from.
  if (metric.includes("vulnerabilit") || /planted vulnerabilities/i.test(text)) {
    const repo = extractGithubRepo(text);
    if (!repo) return { kind: "skip", reason: "audit bounty but no challenge repo URL in the brief" };
    return { kind: "audit", repo };
  }
  // Market-cap call on a token that has not launched yet: submissions open
  // at launch and there is no tape to read — a number now would be a blind
  // guess, so skip with the precise reason.
  if (metric.includes("market cap")) {
    return { kind: "skip", reason: "market-cap call on a not-yet-launched token; submissions open at launch, no market data exists yet" };
  }
  if (metric.includes("brier")) {
    const coinId = findAsset(slug, CRYPTO);
    if (!coinId) return { kind: "skip", reason: "Brier bounty for an asset with no market-data mapping" };
    const horizonDays = horizonDaysFromText(`${slug} ${bounty.title || ""}`);
    return { kind: "brier", asset: coinId, horizonDays };
  }
  // Percent-move call (e.g. an earnings reaction day): the answer is a
  // SIGNED PERCENT, not a price. This must be checked before the generic
  // absolute-error branch, or the last close price would be submitted as
  // the "% move" — a garbage answer.
  if (metric.includes("absolute error") && /% move|percent move|signed percent/i.test(`${metric} ${text}`)) {
    const symbol = findAsset(slug, STOCKS);
    if (!symbol) return { kind: "skip", reason: "percent-move bounty for an asset with no price mapping" };
    return { kind: "pctmove", asset: symbol };
  }
  if (metric.includes("absolute error")) {
    const symbol = findAsset(slug, STOCKS);
    if (!symbol) return { kind: "skip", reason: "abs-error bounty for an asset with no price mapping" };
    return { kind: "numeric", asset: symbol };
  }
  if (cat === "trading" && /long or short|long\/short/i.test(bounty.brief || bounty.title || "")) {
    const coinId = findAsset(slug, CRYPTO);
    if (!coinId) return { kind: "skip", reason: "signal bounty for an asset with no market-data mapping" };
    return { kind: "signal", asset: coinId, horizonDays: horizonDaysFromText(text) };
  }
  if (metric.includes("overlap")) {
    return { kind: "skip", reason: "needs a fresh-launch token feed; no free reliable source exists" };
  }
  return { kind: "skip", reason: `lane ${bounty.lane || "?"} / cat ${cat || "?"} needs human-grade work (code, content, design, referral) — out of autonomous scope` };
}

/** Build a Brier forecast for a crypto asset. Falls back to base rate on data failure. */
export async function forecastBrier(plan, log) {
  try {
    const data =
      plan.horizonDays > 1
        ? await cryptoNdChange(plan.asset, plan.horizonDays)
        : await crypto24hChange(plan.asset);
    const probUp = momentumProb(data.changePct);
    log.info(
      `${plan.asset} ${data.horizon} change ${data.changePct.toFixed(2)}% (price $${data.price}) -> P(up)=${probUp.toFixed(2)}`
    );
    return { prediction: directionPayload(probUp), basis: `momentum ${data.horizon} ${data.changePct.toFixed(2)}%` };
  } catch (e) {
    log.warn(`market data failed for ${plan.asset} (${e.message}); using base-rate default P(up)=0.45`);
    return { prediction: directionPayload(0.45), basis: "base-rate default (no market data)" };
  }
}

/** Build a long/short signal for a crypto asset. Same momentum rule as Brier. */
export async function forecastSignal(plan, log) {
  const { prediction, basis } = await forecastBrier(plan, log);
  const probUp = prediction.answer === "yes" ? prediction.confidence : 1 - prediction.confidence;
  return { prediction: signalPayload(probUp), basis };
}

/** Build a numeric close forecast (random-walk baseline = last close). No data -> throw. */
export async function forecastNumeric(plan, log) {
  const { symbol, lastClose, lastDate } = await stockLastClose(plan.asset);
  const value = Math.round(lastClose * 100) / 100;
  log.info(`${symbol} last close $${lastClose} (${lastDate}) -> forecast $${value} (random-walk baseline)`);
  return { prediction: { answer: value }, basis: `last close $${value} (${lastDate})` };
}

/**
 * Build a signed-percent move forecast (e.g. an earnings reaction day).
 * Magnitude = 90th percentile of the asset's absolute daily % moves over
 * the last ~60 sessions (an earnings day is a tail event); direction from
 * the momentum rule on the 5-day change. Falls back to a documented 5.0%
 * base rate when the history is too short to measure a tail.
 */
export async function forecastPctMove(plan, log) {
  const closes = await stockCloses(plan.asset, "3mo");
  const returns = [];
  for (let i = 1; i < closes.length; i++) {
    returns.push(((closes[i] - closes[i - 1]) / closes[i - 1]) * 100);
  }
  const absReturns = returns.map((r) => Math.abs(r));
  const magnitude = absReturns.length >= 20 ? percentile(absReturns, 0.9) : 5.0;
  const change5d =
    closes.length >= 6
      ? ((closes[closes.length - 1] - closes[closes.length - 6]) / closes[closes.length - 6]) * 100
      : 0;
  const probUp = momentumProb(change5d);
  const sign = probUp >= 0.5 ? 1 : -1;
  const value = Math.round(magnitude * sign * 10) / 10;
  const basis =
    absReturns.length >= 20
      ? `90th pct of |daily %| over ${absReturns.length} sessions = ${magnitude.toFixed(2)}%, 5d change ${change5d.toFixed(2)}% -> ${sign > 0 ? "up" : "down"}`
      : `base-rate magnitude 5.0% (only ${absReturns.length} sessions of history), 5d change ${change5d.toFixed(2)}% -> ${sign > 0 ? "up" : "down"}`;
  log.info(`${plan.asset} pct-move forecast: ${value}% [${basis}]`);
  return { prediction: { answer: value }, basis };
}

/**
 * Build an audit submission: fetch the challenge contract(s) from the GitHub
 * repo named in the brief, run the deterministic heuristic detectors, and
 * submit the finding tokens. Throws when nothing defensible is found —
 * an empty guess list is not a submission.
 */
export async function auditPrediction(plan, log) {
  const sources = await fetchContractSources(plan.repo.owner, plan.repo.repo, log);
  const tokens = [];
  const reasons = [];
  for (const { path, source } of sources) {
    const findings = analyzeContract(source);
    log.info(`audit: ${path} -> ${findings.length} finding(s)`);
    for (const f of findings) {
      log.info(`audit: ${f.token} — ${f.reason}`);
      tokens.push(f.token);
      reasons.push(`${f.token} (${f.reason})`);
    }
  }
  const unique = [...new Set(tokens)];
  if (unique.length === 0) {
    throw new Error(`static analysis found no vulnerabilities in ${plan.repo.url} — nothing defensible to submit`);
  }
  return {
    prediction: { answer: unique },
    basis: `${unique.length} heuristic finding(s) in ${sources.length} contract(s) from ${plan.repo.url}: ${unique.join(", ")}`,
  };
}

export async function buildPrediction(plan, log) {
  if (plan.kind === "brier") return forecastBrier(plan, log);
  if (plan.kind === "signal") return forecastSignal(plan, log);
  if (plan.kind === "numeric") return forecastNumeric(plan, log);
  if (plan.kind === "pctmove") return forecastPctMove(plan, log);
  if (plan.kind === "audit") return auditPrediction(plan, log);
  throw new Error(`no forecaster for kind ${plan.kind}`);
}
