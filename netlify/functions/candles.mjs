// 일봉: /api/candles?sym=KOSPI|KOSDAQ|NASDAQ|005930|000660 → [[YYYYMMDD,시,고,저,종,거래량],...] 최근 약 400거래일, CDN 30분 캐시
const DOM = new Set(["KOSPI", "KOSDAQ", "005930", "000660"]);
const UA = { "User-Agent": "Mozilla/5.0" };
async function domestic(sym) {
  const t = await (await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${sym}&timeframe=day&count=400&requestType=0`, { headers: UA })).text();
  return [...t.matchAll(/data="([^"]+)"/g)].map(m => m[1].split("|")).map(x => [x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]);
}
async function nasdaq() {
  const p = n => String(n).padStart(2, "0"), d = new Date(), s = new Date(Date.now() - 600 * 864e5);
  const f = x => `${x.getUTCFullYear()}${p(x.getUTCMonth() + 1)}${p(x.getUTCDate())}0000`;
  const j = await (await fetch(`https://api.stock.naver.com/chart/foreign/index/.IXIC/day?startDateTime=${f(s)}&endDateTime=${f(new Date(d.getTime() + 864e5))}`, { headers: UA })).json();
  return j.map(x => [x.localDate, +x.openPrice, +x.highPrice, +x.lowPrice, +x.closePrice, +x.accumulatedTradingVolume || 0]);
}
export default async (req) => {
  const sym = new URL(req.url).searchParams.get("sym") || "KOSPI";
  if (!DOM.has(sym) && sym !== "NASDAQ") return new Response("{}", { status: 400 });
  try {
    const rows = (sym === "NASDAQ" ? await nasdaq() : await domestic(sym)).filter(x => x[4] > 0).slice(-400);
    if (rows.length < 20) throw new Error("short");
    return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};
export const config = { path: "/api/candles" };
