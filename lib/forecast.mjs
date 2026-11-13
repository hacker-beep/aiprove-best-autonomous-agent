// Forecasters + bounty classification.
//
// Payload shapes follow the documented API contract (skill.md) as proven live
// on 2026-11-13 (all accepted with status provenance_ok):
//   Brier yes/no:  {"answer": "yes"|"no", "confidence": 0..1}
//   Abs-error $:   {"answer": <number>}                     (single close forecast)
//   Signal:        {"answer": "long"|"short", "confidence": 0..1}
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
import { crypto24hChange, cryptoNdChange, stockLastClose } from "./market.mjs";

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

const CRYPTO = { btc: "bitcoin", eth: "ethereum" };
const STOCKS = { spy: "SPY", nvda: "NVDA", gold: "GLD", gld: "GLD" };

function findAsset(slug, table) {
  const s = slug.toLowerCase();
  for (const [key, value] of Object.entries(table)) {
    if (s.includes(key)) return value;
  }
  return null;
}

/**
 * Classify a bounty into what this agent can autonomously complete.
 * Returns { kind: "brier"|"numeric"|"signal"|"skip", reason?, asset?, horizonDays? }.
 */
export function classify(bounty) {
  const slug = bounty.slug || "";
  const metric = (bounty.metric || "").toLowerCase();
  const cat = (bounty.cat || "").toLowerCase();

  if (metric.includes("brier")) {
    const coinId = findAsset(slug, CRYPTO);
    if (!coinId) return { kind: "skip", reason: "Brier bounty for an asset with no market-data mapping" };
    const horizonDays = /7d|7-day|7 day/.test(slug + " " + (bounty.title || "")) ? 7 : 1;
    return { kind: "brier", asset: coinId, horizonDays };
  }
  if (metric.includes("absolute error")) {
    const symbol = findAsset(slug, STOCKS);
    if (!symbol) return { kind: "skip", reason: "abs-error bounty for an asset with no price mapping" };
    return { kind: "numeric", asset: symbol };
  }
  if (cat === "trading" && /long or short|long\/short/i.test(bounty.brief || bounty.title || "")) {
    const coinId = findAsset(slug, CRYPTO);
    if (!coinId) return { kind: "skip", reason: "signal bounty for an asset with no market-data mapping" };
    return { kind: "signal", asset: coinId, horizonDays: 1 };
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

export async function buildPrediction(plan, log) {
  if (plan.kind === "brier") return forecastBrier(plan, log);
  if (plan.kind === "signal") return forecastSignal(plan, log);
  if (plan.kind === "numeric") return forecastNumeric(plan, log);
  throw new Error(`no forecaster for kind ${plan.kind}`);
}
