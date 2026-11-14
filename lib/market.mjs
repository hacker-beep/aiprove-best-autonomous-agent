// Market data from free, keyless public sources. No API keys anywhere.
//  - Crypto (BTC/ETH): CoinGecko public API — 24h change + 7d change.
//  - Stocks/ETF (SPY/NVDA/GLD): Yahoo Finance chart API — daily closes.
// Every fetch is best-effort with a timeout; on failure the caller falls back
// to a documented base-rate forecast (Brier) or skips (numeric).

const UA = { "user-agent": "aiprove-autonomous-agent/1.0" };

async function fetchJson(url, timeoutMs = 15000) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${new URL(url).host}`);
  return res.json();
}

/** 24h % change for a CoinGecko coin id (e.g. "bitcoin"). */
export async function crypto24hChange(coinId) {
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/simple/price?ids=${coinId}&vs_currencies=usd&include_24hr_change=true`
  );
  const change = data?.[coinId]?.usd_24h_change;
  if (typeof change !== "number") throw new Error(`no 24h change for ${coinId}`);
  return { coinId, horizon: "24h", changePct: change, price: data[coinId].usd };
}

/** N-day % change from CoinGecko market chart (first vs last close). */
export async function cryptoNdChange(coinId, days) {
  const data = await fetchJson(
    `https://api.coingecko.com/api/v3/coins/${coinId}/market_chart?vs_currency=usd&days=${days}`
  );
  const prices = data?.prices;
  if (!Array.isArray(prices) || prices.length < 2) throw new Error(`no chart for ${coinId}`);
  const first = prices[0][1];
  const last = prices[prices.length - 1][1];
  return { coinId, horizon: `${days}d`, changePct: ((last - first) / first) * 100, price: last };
}

/** Last daily close for a Yahoo symbol (e.g. "SPY", "NVDA", "GLD"). */
export async function stockLastClose(symbol) {
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=5d&interval=1d`
  );
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close?.filter((c) => c != null);
  const times = result?.timestamp;
  if (!closes?.length) throw new Error(`no closes for ${symbol}`);
  const lastClose = closes[closes.length - 1];
  const lastDate = times?.length
    ? new Date(times[times.length - 1] * 1000).toISOString().slice(0, 10)
    : "unknown";
  return { symbol, lastClose, lastDate };
}

/** Daily closes for a Yahoo symbol over a range (e.g. "3mo"). Oldest first. */
export async function stockCloses(symbol, range = "3mo") {
  const data = await fetchJson(
    `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?range=${range}&interval=1d`
  );
  const result = data?.chart?.result?.[0];
  const closes = result?.indicators?.quote?.[0]?.close?.filter((c) => c != null);
  if (!closes?.length) throw new Error(`no closes for ${symbol}`);
  return closes;
}
