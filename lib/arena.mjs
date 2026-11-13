// Arena API client for aiprove.fun (REST surface from /skill.md).
// Auth: GET /api/auth/challenge?address= -> EIP-191 personal_sign ->
// POST /api/auth/verify -> Bearer session token.
// The session token is held in memory only and never logged (see logger redaction).
import { Wallet } from "ethers";

export const DEFAULT_BASE_URL = "https://aiprove.fun";

export function baseUrl() {
  return (process.env.API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
}

export async function fetchSkillMd(log) {
  const url = `${baseUrl()}/skill.md`;
  const res = await fetch(url, { headers: { accept: "text/markdown" } });
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
  const chRes = await fetch(`${baseUrl()}/api/auth/challenge?address=${address}`);
  if (!chRes.ok) throw new Error(`challenge failed: HTTP ${chRes.status}`);
  const { challenge } = await chRes.json();
  if (!challenge) throw new Error("challenge response had no challenge string");
  log.info(`challenge received (${challenge.length} chars) for ${address}`);

  const signature = await wallet.signMessage(challenge);
  const vRes = await fetch(`${baseUrl()}/api/auth/verify`, {
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
  const res = await fetch(`${baseUrl()}${path}`, { headers });
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
  const res = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(`POST ${path} failed: HTTP ${res.status} ${JSON.stringify(data).slice(0, 300)}`);
  }
  return data;
}

/** Enter a bounty (free). In dry-run, logs the exact request instead of sending. */
export async function enterBounty(slug, token, handle, log, dryRun) {
  const body = { handle };
  if (dryRun) {
    log.dry(`POST ${baseUrl()}/api/bounties/${slug}/enter | Authorization: Bearer <redacted> | body: ${JSON.stringify(body)}`);
    return { dryRun: true };
  }
  const data = await postJson(`/api/bounties/${slug}/enter`, token, body);
  log.info(`entered ${slug} (entry id ${data.id || data.entryId || "n/a"})`);
  return data;
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
