// 일봉: /api/candles?sym=KOSPI|005930|000660 → [[YYYYMMDD,시,고,저,종,거래량],...] 최근 130일, CDN 30분 캐시
const OK = new Set(["KOSPI", "KOSDAQ", "005930", "000660"]);
export default async (req) => {
  const sym = new URL(req.url).searchParams.get("sym") || "KOSPI";
  if (!OK.has(sym)) return new Response("{}", { status: 400 });
  try {
    const r = await fetch(`https://fchart.stock.naver.com/sise.nhn?symbol=${sym}&timeframe=day&count=130&requestType=0`, { headers: { "User-Agent": "Mozilla/5.0" } });
    const t = await r.text();
    const rows = [...t.matchAll(/data="([^"]+)"/g)].map(m => m[1].split("|")).map(x => [x[0], +x[1], +x[2], +x[3], +x[4], +x[5]]).filter(x => x[4] > 0);
    if (rows.length < 20) throw new Error("short");
    return new Response(JSON.stringify(rows), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=300",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600" } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};
export const config = { path: "/api/candles" };
