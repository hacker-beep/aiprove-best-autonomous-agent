import test from "node:test";
import assert from "node:assert/strict";
import {
  classify,
  directionPayload,
  horizonDaysFromText,
  momentumProb,
  percentile,
  signalPayload,
} from "../lib/forecast.mjs";
import { redact } from "../lib/logger.mjs";

test("momentumProb: neutral day -> 0.50", () => {
  assert.equal(momentumProb(0), 0.5);
});

test("momentumProb: -3.95% day (BTC 2026-11-13) -> 0.421, hedged", () => {
  const p = momentumProb(-3.947);
  assert.ok(p > 0.42 && p < 0.43, `got ${p}`);
});

test("momentumProb: clamps to [0.40, 0.60] on extreme moves", () => {
  assert.equal(momentumProb(-20), 0.4);
  assert.equal(momentumProb(20), 0.6);
  assert.equal(momentumProb(-100), 0.4);
});

test("directionPayload: prob < 0.5 -> no, confidence mirrored", () => {
  assert.deepEqual(directionPayload(0.42), { answer: "no", confidence: 0.58 });
  assert.deepEqual(directionPayload(0.55), { answer: "yes", confidence: 0.55 });
  assert.deepEqual(directionPayload(0.5), { answer: "yes", confidence: 0.5 });
});

test("directionPayload: confidence never exceeds 0.60 for in-range probs", () => {
  for (const p of [0.4, 0.45, 0.5, 0.55, 0.6]) {
    assert.ok(directionPayload(p).confidence <= 0.6);
    assert.ok(directionPayload(p).confidence >= 0.5);
  }
});

test("signalPayload: maps prob to long/short with same confidence rule", () => {
  assert.deepEqual(signalPayload(0.43), { answer: "short", confidence: 0.57 });
  assert.deepEqual(signalPayload(0.58), { answer: "long", confidence: 0.58 });
});

test("classify: known Brier bounties", () => {
  assert.deepEqual(classify({ slug: "btc-tomorrow", metric: "Brier score", cat: "forecast" }), {
    kind: "brier",
    asset: "bitcoin",
    horizonDays: 1,
  });
  assert.deepEqual(
    classify({ slug: "forecast-btc-7d", title: "Call BTC's 7-day direction", metric: "Brier score", cat: "forecast" }),
    { kind: "brier", asset: "bitcoin", horizonDays: 7 }
  );
  assert.deepEqual(classify({ slug: "forecast-eth-24h", metric: "Brier score", cat: "forecast" }), {
    kind: "brier",
    asset: "ethereum",
    horizonDays: 1,
  });
});

test("classify: known numeric bounties", () => {
  assert.deepEqual(classify({ slug: "spy-close-1dollar", metric: "Absolute error, $", cat: "forecast" }), {
    kind: "numeric",
    asset: "SPY",
  });
  assert.deepEqual(classify({ slug: "forecast-gold-tomorrow", metric: "Absolute error, $", cat: "forecast" }), {
    kind: "numeric",
    asset: "GLD",
  });
  assert.deepEqual(classify({ slug: "forecast-nvda-3d", metric: "Absolute error, $", cat: "forecast" }), {
    kind: "numeric",
    asset: "NVDA",
  });
});

test("classify: signal bounty", () => {
  const r = classify({
    slug: "signal-eth-pnl-24h",
    title: "Long or short ETH for 24 hours",
    brief: "Submit a single directional call on ETH, long or short, held for 24 hours.",
    metric: "Realized PnL on your call",
    cat: "trading",
  });
  assert.deepEqual(r, { kind: "signal", asset: "ethereum", horizonDays: 1 });
});

test("classify: top5-pons skipped (no launch feed)", () => {
  const r = classify({ slug: "top5-pons-24h", metric: "Overlap with realized top 5", cat: "forecast" });
  assert.equal(r.kind, "skip");
  assert.match(r.reason, /launch/);
});

test("classify: code/content/design bounties skipped", () => {
  for (const b of [
    { slug: "code-golf-expr", metric: "Bytes, all tests pass", cat: "development", lane: "AutoGrade" },
    { slug: "write-article-aiprove", metric: "Poster rubric", cat: "content", lane: "PosterJudge" },
    { slug: "best-autonomous-agent", metric: "Bounties completed autonomously", cat: "development", lane: "AutoGrade" },
    { slug: "refer-most-agents", metric: "Verified referrals", cat: "marketing", lane: "AutoGrade" },
  ]) {
    assert.equal(classify(b).kind, "skip", b.slug);
  }
});

test("classify: unknown-asset Brier bounty skipped, not crashed", () => {
  const r = classify({ slug: "forecast-doge-24h", metric: "Brier score", cat: "forecast" });
  assert.equal(r.kind, "skip");
});

test("classify: percent-move bounty is pctmove, NOT numeric (no price-as-percent)", () => {
  const r = classify({
    slug: "nvda-jensen-earnings",
    title: "Call the NVDA move, first earnings after Jensen",
    brief: "Submit a single signed percent for the move from Tuesday's close to Wednesday's close, e.g. 4.2 for up 4.2%.",
    metric: "Absolute error of your predicted % move vs the real reaction-day close",
    cat: "forecast",
  });
  assert.deepEqual(r, { kind: "pctmove", asset: "NVDA" });
});

test("classify: audit bounty resolves the challenge repo from the brief", () => {
  const r = classify({
    slug: "bughunt-stakepool",
    title: "Audit StakePool.sol — find the planted vulnerabilities",
    brief: "StakePool.sol is published at https://github.com/AIProveRH/stakepool-challenge. Find the planted vulnerabilities.",
    metric: "Vulnerabilities correctly identified (set overlap vs answer key)",
    cat: "development",
  });
  assert.deepEqual(r, {
    kind: "audit",
    repo: { owner: "AIProveRH", repo: "stakepool-challenge", url: "https://github.com/AIProveRH/stakepool-challenge" },
  });
});

test("classify: audit bounty without a repo URL is skipped", () => {
  const r = classify({
    slug: "bughunt-mystery",
    metric: "Vulnerabilities correctly identified",
    cat: "development",
    brief: "Find the bugs in this contract (no link given).",
  });
  assert.equal(r.kind, "skip");
  assert.match(r.reason, /repo/);
});

test("classify: not-yet-launched market-cap call is skipped with the launch reason", () => {
  const r = classify({
    slug: "prove-mc-3d",
    metric: "Absolute error of your predicted market cap (ETH) vs the real figure at launch + 72h",
    cat: "forecast",
  });
  assert.equal(r.kind, "skip");
  assert.match(r.reason, /launch/);
});

test("classify: 48h signal bounty gets a 2-day horizon", () => {
  const r = classify({
    slug: "eth-signal-pnl-hard",
    title: "Best 48h ETH trading signal, net PnL after fees",
    brief: "Submit a directional ETH signal (long or short, with size/confidence) for the next 48 hours.",
    metric: "Net directional PnL after fees, replayed vs real ETH price",
    cat: "trading",
  });
  assert.deepEqual(r, { kind: "signal", asset: "ethereum", horizonDays: 2 });
});

test("horizonDaysFromText: 24h -> 1, 48h -> 2, 7d -> 7", () => {
  assert.equal(horizonDaysFromText("forecast-eth-24h"), 1);
  assert.equal(horizonDaysFromText("next 48 hours"), 2);
  assert.equal(horizonDaysFromText("48h ETH signal"), 2);
  assert.equal(horizonDaysFromText("forecast-btc-7d"), 7);
  assert.equal(horizonDaysFromText("Call BTC's 7-day direction"), 7);
  assert.equal(horizonDaysFromText("no horizon here"), 1);
});

test("percentile: median and 90th percentile interpolate", () => {
  assert.equal(percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.equal(percentile([1, 2, 3, 4, 5], 0.9), 4.6);
  assert.equal(percentile([10], 0.9), 10);
});

test("redact: masks Bearer tokens and 64-hex private keys", () => {
  const fakeKey = "0x" + "ab".repeat(32);
  const out = redact(`Authorization: Bearer abcDEF123.token here, key=${fakeKey}`);
  assert.ok(!out.includes("abcDEF123"));
  assert.ok(!out.includes("ab".repeat(32)));
  assert.ok(out.includes("Bearer <redacted>"));
  assert.ok(out.includes("0x<redacted-private-key>"));
});

test("redact: leaves normal addresses alone", () => {
  const addr = "0x8d76807fB9723385a432D198243e2e2F830B4d80";
  assert.ok(redact(`agent ${addr}`).includes(addr));
});
