// Deterministic heuristic Solidity vulnerability analysis.
//
// Used by the autonomous agent for audit bounties (e.g. bughunt-stakepool):
// the agent fetches the challenge contract from the GitHub URL in the
// bounty's brief, runs these detectors over the source, and submits the
// findings as `<function>:<class>` tokens.
//
// The detectors are deliberately conservative and explainable: each finding
// carries a reason naming the exact pattern. They are heuristics, not a
// formal audit — but for a deliberately-vulnerable challenge contract the
// planted bugs are classic patterns, and the bounty scores set overlap with
// extra guesses costing nothing, so a high-recall heuristic pass is the
// right autonomous strategy.
//
// Detectors (class -> pattern):
//   reinitialization: an initializer guarded by require(!<initFlag>) that
//     never sets the flag to true, so it can run again and re-take ownership.
//   access-control:   a function that assigns the owner/admin state variable
//     with no msg.sender check and no onlyOwner-style modifier.
//   reentrancy:       an external call (transfer/transferFrom/call/send)
//     followed by a state-variable write in a function without nonReentrant.
//   unchecked-return: a bare external-call statement whose bool return is
//     never checked; reported once, at the earliest function where it occurs.
//   price-manipulation: a spot oracle price read (.price()) with no
//     staleness / TWAP validation anywhere in the containing function.
//   logic:            an assignment to a *Rate state variable without first
//     calling an accrual/update function, so elapsed time is repriced at the
//     new rate.

const EXTERNAL_CALL = /\.\s*(transfer|transferFrom|call|send|delegatecall)\s*\(/;
const ORACLE_READ = /\.\s*(price|latestAnswer|getPrice|latestRoundData)\s*\(/;
const VALIDATION_HINT = /updatedAt|stale|twap|timeWeighted|heartbeat|roundId/i;
const UPDATE_CALL = /(_update\w*|update\w*|accrue\w*|sync\w*|checkpoint\w*)\s*\(/;
const OWNER_LIKE = /^(owner|admin|governor)$/;

/** Extract a github.com/<owner>/<repo> URL from free text (e.g. a brief). */
export function extractGithubRepo(text) {
  const m = String(text || "").match(/github\.com\/([\w.-]+)\/([\w.-]+)/);
  if (!m) return null;
  // A URL at the end of a sentence carries trailing punctuation (".", ",",
  // ")") that is not part of the repo name — strip it, or the API 404s.
  const repo = m[2].replace(/\.git$/, "").replace(/[.,;:!?)]+$/, "");
  const owner = m[1].replace(/[.,;:!?)]+$/, "");
  return { owner, repo, url: `https://github.com/${owner}/${repo}` };
}

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/.*$/gm, "");
}

/** Split a contract source into { name, modifiers, body } per function. */
export function parseFunctions(src) {
  const clean = stripComments(src);
  const fns = [];
  const re = /function\s+(\w+)\s*\([^)]*\)\s*([^{;]*)\{/g;
  let m;
  while ((m = re.exec(clean)) !== null) {
    const name = m[1];
    const modifiers = m[2] || "";
    let depth = 0;
    let i = re.lastIndex - 1; // position of '{'
    const start = i;
    for (; i < clean.length; i++) {
      if (clean[i] === "{") depth++;
      else if (clean[i] === "}") {
        depth--;
        if (depth === 0) break;
      }
    }
    fns.push({ name, modifiers, body: clean.slice(start + 1, i) });
  }
  return fns;
}

/** Contract-level state variable names (declarations at <=4 spaces indent). */
export function parseStateVars(src) {
  const clean = stripComments(src);
  const vars = new Set();
  for (const line of clean.split("\n")) {
    if (/^\s{5,}/.test(line)) continue; // inside a function body
    const m = line.match(
      /^\s*(?:uint\d*|int\d*|address|bool|string|bytes\d*|mapping\s*\([^)]*\)|[A-Z]\w*)\s+(?:public\s+|private\s+|internal\s+|constant\s+|immutable\s+)*(\w+)\s*(?:=|;)/,
    );
    if (m) vars.add(m[1]);
  }
  return vars;
}

function assignmentTo(nameRe) {
  // Matches `name = ...`, `name[...] += ...`, `name -= ...` — but not `==`.
  return new RegExp(`\\b(?:${nameRe})\\b\\s*(\\[[^\\]]*\\])?\\s*[-+*/]?=(?!=)`);
}

function detectReinitialization(fn) {
  // Guarded by require(!<flag>) or require(<flag> == false) where the flag
  // (or the function) is init-like, but the flag is never set to true.
  const flags = new Set();
  for (const m of fn.body.matchAll(/require\s*\(\s*!(\w+)/g)) flags.add(m[1]);
  for (const m of fn.body.matchAll(/require\s*\(\s*(\w+)\s*==\s*false/g)) flags.add(m[1]);
  for (const flag of flags) {
    if (!/init/i.test(flag) && !/init/i.test(fn.name)) continue;
    if (!new RegExp(`\\b${flag}\\s*=\\s*true\\b`).test(fn.body)) {
      return {
        token: `${fn.name}:reinitialization`,
        reason: `${fn.name} is guarded by require(!${flag}) but never sets ${flag} = true, so it can run again`,
      };
    }
  }
  return null;
}

function detectAccessControl(fn) {
  if (/constructor|init/i.test(fn.name)) return null; // init sets owner by design
  if (/(onlyOwner|onlyAdmin|onlyRole|auth)\b/.test(fn.modifiers)) return null;
  const m = fn.body.match(/\b(owner|admin|governor)\s*=(?!=)/);
  if (!m) return null;
  // A real sender check is a require/if/assert mentioning msg.sender — a
  // bare `owner = msg.sender` assignment is the bug, not a check.
  if (/(require|if|assert)\s*\([^)]*msg\.sender/.test(fn.body)) return null;
  return {
    token: `${fn.name}:access-control`,
    reason: `${fn.name} assigns ${m[1]} with no msg.sender check and no access-control modifier`,
  };
}

function detectReentrancy(fn, stateVars) {
  if (/nonReentrant/.test(fn.modifiers)) return null;
  const calls = [...fn.body.matchAll(new RegExp(EXTERNAL_CALL, "g"))];
  if (calls.length === 0 || stateVars.size === 0) return null;
  const writeRe = assignmentTo([...stateVars].map((v) => v.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"));
  for (const call of calls) {
    const after = fn.body.slice(call.index + call[0].length);
    const w = after.match(writeRe);
    if (w) {
      return {
        token: `${fn.name}:reentrancy`,
        reason: `${fn.name} makes an external call (${call[0].trim()}) before writing state (${w[0].trim()}), with no nonReentrant guard`,
      };
    }
  }
  return null;
}

function detectUncheckedReturn(fns) {
  // One report, at the earliest function with a bare unchecked external call.
  for (const fn of fns) {
    for (const line of fn.body.split("\n")) {
      if (!EXTERNAL_CALL.test(line)) continue;
      if (/require\s*\(|return\b|if\s*\(|emit\b/.test(line)) continue;
      if (/=/.test(line.split(/\. *(transfer|transferFrom|call|send|delegatecall)/)[0])) continue; // assigned
      return {
        token: `${fn.name}:unchecked-return`,
        reason: `${fn.name} calls ${line.trim().slice(0, 80)} as a bare statement and ignores the bool return`,
      };
    }
  }
  return null;
}

function detectPriceManipulation(fn) {
  if (!ORACLE_READ.test(fn.body)) return null;
  if (VALIDATION_HINT.test(fn.body)) return null;
  return {
    token: `${fn.name}:price-manipulation`,
    reason: `${fn.name} reads a spot oracle price with no staleness or TWAP validation`,
  };
}

function detectRateLogic(fn) {
  const m = fn.body.match(/\b(\w*[Rr]ate)\s*=(?!=)/);
  if (!m) return null;
  const before = fn.body.slice(0, m.index);
  if (UPDATE_CALL.test(before)) return null; // accrual updated first: fine
  return {
    token: `${fn.name}:logic`,
    reason: `${fn.name} changes ${m[1]} without first calling an accrual/update function, so elapsed time is repriced at the new rate`,
  };
}

/**
 * Run all detectors over one contract source.
 * Returns [{ token, reason }] in source order, deduplicated by token.
 */
export function analyzeContract(source) {
  const fns = parseFunctions(source);
  const stateVars = parseStateVars(source);
  const findings = [];
  const seen = new Set();
  const push = (f) => {
    if (f && !seen.has(f.token)) {
      seen.add(f.token);
      findings.push(f);
    }
  };
  for (const fn of fns) {
    push(detectReinitialization(fn));
    push(detectAccessControl(fn));
    push(detectReentrancy(fn, stateVars));
    push(detectPriceManipulation(fn));
    push(detectRateLogic(fn));
  }
  // Unchecked-return is reported once, at the earliest function.
  push(detectUncheckedReturn(fns));
  // Keep source order: re-sort by first appearance of the function name.
  const order = new Map(fns.map((f, i) => [f.name, i]));
  findings.sort((a, b) => (order.get(a.token.split(":")[0]) ?? 99) - (order.get(b.token.split(":")[0]) ?? 99));
  return findings;
}

const GH_UA = { "user-agent": "aiprove-autonomous-agent/1.0", accept: "application/vnd.github+json" };

async function ghFetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: GH_UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`GitHub API ${url} -> HTTP ${res.status}`);
  return res.json();
}

async function ghFetchText(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: GH_UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`fetch ${url} -> HTTP ${res.status}`);
  return res.text();
}

/**
 * Fetch every .sol file in a GitHub repo (root + one level of contracts/src).
 * Returns [{ path, source }]. Throws if no Solidity source is found.
 */
export async function fetchContractSources(owner, repo, log) {
  const list = await ghFetchJson(`https://api.github.com/repos/${owner}/${repo}/contents`);
  const solFiles = [];
  const dirs = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (item.type === "file" && item.name.endsWith(".sol")) solFiles.push(item);
    else if (item.type === "dir" && /^(contracts|src)$/i.test(item.name)) dirs.push(item);
  }
  for (const dir of dirs) {
    const sub = await ghFetchJson(dir.url);
    for (const item of Array.isArray(sub) ? sub : []) {
      if (item.type === "file" && item.name.endsWith(".sol")) solFiles.push(item);
    }
  }
  if (solFiles.length === 0) throw new Error(`no .sol files found in ${owner}/${repo}`);
  const sources = [];
  for (const f of solFiles) {
    const source = await ghFetchText(f.download_url);
    log?.info(`audit: fetched ${f.path} (${source.length} chars) from ${owner}/${repo}`);
    sources.push({ path: f.path, source });
  }
  return sources;
}
