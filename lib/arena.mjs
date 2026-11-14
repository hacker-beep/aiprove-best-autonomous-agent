// Arena API client for aiprove.fun (REST surface from /skill.md).
// Auth: GET /api/auth/challenge?address= -> EIP-191 personal_sign ->
// POST /api/auth/verify -> Bearer session token.
// The session token is held in memory only and never logged (see logger redaction).
//
// Robustness: every arena call runs with a timeout and retries on transient
// failures (network errors, timeouts, HTTP 429/5xx), so one dropped request
// does not cost the run. Re-entering a bounty this identity already entered
// is treated as success, not failure.
import { Wallet } from "ethers";

export const DEFAULT_BASE_URL = "https://aiprove.fun";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_ATTEMPTS = 3;
const RETRY_DELAYS_MS = [500, 1500];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function isTransient(status) {
  return status === 429 || status >= 500;
}

async function fetchWithRetry(url, options = {}) {
  const method = options.method || "GET";
  let lastError = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url, { ...options, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (!res.ok && isTransient(res.status) && attempt < MAX_ATTEMPTS) {
        lastError = new Error(`${method} ${url} -> HTTP ${res.status}`);
        await res.text().catch(() => {});
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      return res;
    } catch (err) {
      if (attempt < MAX_ATTEMPTS) {
        lastError = err;
        await sleep(RETRY_DELAYS_MS[attempt - 1]);
        continue;
      }
      throw new Error(`${method} ${url} -> failed after ${MAX_ATTEMPTS} attempts: ${err.message}`);
    }
  }
  throw lastError;
}

export function baseUrl() {
  return (process.env.API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export async function fetchSkillMd(log) {
  const url = `${baseUrl()}/skill.md`;
  const res = await fetchWithRetry(url, { headers: { accept: "text/markdown" } });
  if (!res.ok) throw new Error(`skill.md fetch failed: HTTP ${res.status}`);
  const text = await res.text();
  const endpoints = ["/api/auth/challenge", "/api/auth/verify", "/api/bounties", "/enter", "/submit"];
  const found = endpoints.filter((e) => text.includes(e));
  log.info(`read skill.md (${text.length} chars, ${found.length}/${endpoints.length} endpoints recognised)`);
  if (found.length < endpoints.length) {
    throw new Error(`skill.md missing endpoints: ${endpoints.filter((e) => !found.includes(e)).join(", ")}`);
  }
  return text;
}

/** Generate a fresh throwaway identity for this run. The private key lives
 *  only in memory and is never printed or written anywhere. */
export function generateIdentity() {
  return Wallet.createRandom();
}

export async function authenticate(wallet, log) {
  const address = wallet.address;
  const chRes = await fetchWithRetry(`${baseUrl()}/api/auth/challenge?address=${address}`);
  if (!chRes.ok) throw new Error(`challenge failed: HTTP ${chRes.status}`);
  const { challenge } = await chRes.json();
  if (!challenge) throw new Error("challenge response had no challenge string");
  log.info(`challenge received (${challenge.length} chars) for ${address}`);

  const signature = await wallet.signMessage(challenge);
  const vRes = await fetchWithRetry(`${baseUrl()}/api/auth/verify`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ address, signature }),
  });
  const vBody = await vRes.json().catch(() => ({}));
  if (!vRes.ok || !vBody.token) {
    throw new Error(`verify failed: HTTP ${vRes.status} ${JSON.stringify(vBody).slice(0, 200)}`);
  }
  const expires = vBody.expiresAt
    ? new Date(Number(vBody.expiresAt)).toISOString()
    : "unknown";
  log.info(`authenticated as ${address} (session token received, ${vBody.token.length} chars, expires ${expires})`);
  return vBody.token;
}

async function getJson(path, token) {
  const headers = token ? { authorization: `Bearer ${token}` } : {};
  const res = await fetchWithRetry(`${baseUrl()}${path}`, { headers });
  if (!res.ok) throw new Error(`GET ${path} failed: HTTP ${res.status}`);
  return res.json();
}

export async function listOpenBounties() {
  const data = await getJson("/api/bounties?status=open");
  return Array.isArray(data) ? data : data.bounties || [];
}

export async function getBounty(slug) {
  const data = await getJson(`/api/bounties/${slug}`);
  return data.bounty || data;
}

export async function getMe(token) {
  return getJson("/api/me", token);
}

async function postJson(path, token, body) {
  const res = await fetchWithRetry(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`POST ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
    err.status = res.status;
    err.body = data;
    throw err;
  }
  return data;
}

function isAlreadyEntered(err) {
  if (err.status === 409) return true;
  const msg = `${err.message} ${JSON.stringify(err.body || {})}`.toLowerCase();
  return /already (entered|competing|registered)/.test(msg);
}

/** Enter a bounty (free). In dry-run, logs the exact request instead of sending.
 *  Re-entering is treated as success: the goal (being entered) is satisfied. */
export async function enterBounty(slug, token, handle, log, dryRun) {
  const body = { handle };
  if (dryRun) {
    log.dry(`POST ${baseUrl()}/api/bounties/${slug}/enter | Authorization: Bearer <redacted> | body: ${JSON.stringify(body)}`);
    return { dryRun: true };
  }
  try {
    const data = await postJson(`/api/bounties/${slug}/enter`, token, body);
    log.info(`entered ${slug} (entry id ${data.id || data.entryId || "n/a"})`);
    return data;
  } catch (err) {
    if (isAlreadyEntered(err)) {
      log.info(`${slug} was already entered by this identity — continuing to submit`);
      return { alreadyEntered: true };
    }
    throw err;
  }
}

/** Submit a prediction. In dry-run, logs the exact request instead of sending. */
export async function submitPrediction(slug, token, prediction, handle, log, dryRun) {
  const body = { prediction, handle };
  if (dryRun) {
    log.dry(`POST ${baseUrl()}/api/bounties/${slug}/submit | Authorization: Bearer <redacted> | body: ${JSON.stringify(body)}`);
    return { dryRun: true };
  }
  const data = await postJson(`/api/bounties/${slug}/submit`, token, body);
  log.info(`submitted ${slug}: status=${data.status || "ok"} submission=${data.submissionId || data.id || "n/a"}`);
  return data;
}
