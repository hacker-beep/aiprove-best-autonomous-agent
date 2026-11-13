#!/usr/bin/env node
// peli-auto — fully autonomous AIProve agent.
//
// The whole loop, no human in it:
//   1. read skill.md from the arena (API_BASE_URL, default https://aiprove.fun)
//   2. generate its own keypair at runtime (never stored, never printed)
//   3. sign in: challenge -> EIP-191 personal_sign -> session token
//   4. list open bounties, fetch each detail, classify what it can complete
//   5. enter + submit every forecast/signal bounty it can (calibrated
//      forecasts, never random); skip the rest with a logged reason
//   6. report final state via /api/me and write a run summary (no secrets)
//
// Usage:
//   node agent.mjs [--dry-run] [--only <slug>] [--handle <name>]
//   API_BASE_URL=https://aiprove.fun AGENT_HANDLE=peli-auto node agent.mjs
//
// --dry-run performs the live read-only steps (skill.md, auth, list, detail,
// /api/me) but only LOGS the exact enter/submit requests instead of sending
// them. Use it to verify plumbing against the live arena safely.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  authenticate,
  baseUrl,
  enterBounty,
  fetchSkillMd,
  generateIdentity,
  getBounty,
  getMe,
  listOpenBounties,
  submitPrediction,
} from "./lib/arena.mjs";
import { buildPrediction, classify } from "./lib/forecast.mjs";
import { createLogger } from "./lib/logger.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WRITE_PAUSE_MS = 500; // polite gap between write calls

function parseArgs(argv) {
  const args = { dryRun: false, only: null, handle: process.env.AGENT_HANDLE || "peli-auto" };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--dry-run") args.dryRun = true;
    else if (argv[i] === "--only") args.only = argv[++i];
    else if (argv[i] === "--handle") args.handle = argv[++i];
    else if (argv[i] === "--help" || argv[i] === "-h") {
      console.log("usage: node agent.mjs [--dry-run] [--only <slug>] [--handle <name>]");
      console.log("env: API_BASE_URL (default https://aiprove.fun), AGENT_HANDLE (default peli-auto)");
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${argv[i]} (try --help)`);
    }
  }
  return args;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const log = createLogger(path.join(HERE, "runs", `${runId}.log`));
  const summary = {
    runId,
    startedAt: new Date().toISOString(),
    apiBaseUrl: baseUrl(),
    handle: args.handle,
    dryRun: args.dryRun,
    entered: [],
    submitted: [],
    skipped: [],
    failed: [],
  };

  try {
    log.info(`peli-auto starting (dryRun=${args.dryRun}, handle=${args.handle}, api=${baseUrl()})`);

    // 1. Read the arena spec.
    await fetchSkillMd(log);

    // 2. Own keypair, generated at runtime. Private key stays in memory only.
    const wallet = generateIdentity();
    summary.address = wallet.address;
    log.info(`identity generated: ${wallet.address} (private key in memory only, never logged)`);

    // 3. Sign in.
    const token = await authenticate(wallet, log);

    // 4. List open bounties.
    let bounties = await listOpenBounties();
    if (args.only) bounties = bounties.filter((b) => b.slug === args.only);
    log.info(`${bounties.length} open bounties to consider${args.only ? ` (filtered to ${args.only})` : ""}`);

    // 5. Enter + submit what can be completed autonomously.
    for (const b of bounties) {
      const slug = b.slug;
      try {
        const detail = await getBounty(slug);
        const bounty = { ...b, ...detail };
        const plan = classify(bounty);
        if (plan.kind === "skip") {
          log.info(`skip ${slug}: ${plan.reason}`);
          summary.skipped.push({ slug, reason: plan.reason });
          continue;
        }
        log.info(`${slug}: ${plan.kind} forecast (asset ${plan.asset})`);
        const { prediction, basis } = await buildPrediction(plan, log);
        log.info(`${slug}: prediction ${JSON.stringify(prediction)} [${basis}]`);
        await enterBounty(slug, token, args.handle, log, args.dryRun);
        summary.entered.push(slug);
        await sleep(WRITE_PAUSE_MS);
        await submitPrediction(slug, token, prediction, args.handle, log, args.dryRun);
        summary.submitted.push({ slug, prediction, basis });
        await sleep(WRITE_PAUSE_MS);
      } catch (e) {
        log.error(`${slug}: FAILED — ${e.message}`);
        summary.failed.push({ slug, error: e.message });
      }
    }

    // 6. Final state check.
    try {
      const me = await getMe(token);
      log.info(
        `/api/me: competing=${me.competing?.length ?? me.competing ?? "?"} submissions=${me.submissions?.length ?? me.submissions ?? "?"} won=${me.won ?? "?"}`
      );
      summary.me = { competing: me.competing, submissions: me.submissions, won: me.won };
    } catch (e) {
      log.warn(`/api/me check failed: ${e.message}`);
    }
  } catch (e) {
    log.error(`FATAL: ${e.message}`);
    summary.fatalError = e.message;
  } finally {
    summary.finishedAt = new Date().toISOString();
    const summaryPath = path.join(HERE, "runs", `${runId}.json`);
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    log.info(
      `done: entered=${summary.entered.length} submitted=${summary.submitted.length} skipped=${summary.skipped.length} failed=${summary.failed.length} (summary: runs/${runId}.json)`
    );
    log.close();
  }

  if (summary.fatalError) process.exit(1);
}

main();
