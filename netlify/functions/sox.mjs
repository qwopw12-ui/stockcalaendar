// 필라델피아 반도체지수(SOX) 현재값 — 서버에서 받아 30초간 CDN 캐시
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function fromYahoo() {
  for (const host of ['query1', 'query2']) {
    try {
      const r = await fetch(`https://${host}.finance.yahoo.com/v8/finance/chart/%5ESOX?range=1d&interval=5m`, { headers: { 'User-Agent': UA } });
      if (!r.ok) continue;
      const m = (await r.json())?.chart?.result?.[0]?.meta;
      if (m && m.regularMarketPrice) {
        return { price: m.regularMarketPrice, prevClose: m.chartPreviousClose ?? m.previousClose,
                 time: m.regularMarketTime ? new Date(m.regularMarketTime * 1000).toISOString() : null, source: 'Yahoo Finance' };
      }
    } catch (e) {}
  }
  return null;
}

async function fromNaver() {
  try {
    const r = await fetch('https://api.stock.naver.com/index/.SOX/basic', { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
    if (!r.ok) return null;
    const j = await r.json();
    const num = s => Number(String(s ?? '').replace(/,/g, ''));
    const price = num(j.closePrice), chg = num(j.compareToPreviousClosePrice);
    const sign = j.compareToPreviousPrice?.code === '5' || j.compareToPreviousPrice?.name === 'FALLING' ? -1 : 1;
    if (!price) return null;
    const c = chg && chg > 0 ? chg * sign : chg;
    return { price, prevClose: price - c, time: j.localTradedAt || null, source: 'Naver' };
  } catch (e) { return null; }
}

export default async () => {
  const d = (await fromYahoo()) || (await fromNaver());
  const ok = !!(d && d.price);
  const body = ok ? { ok, ...d, chg: d.prevClose ? d.price - d.prevClose : null,
                      rate: d.prevClose ? (d.price / d.prevClose - 1) * 100 : null } : { ok: false };
  return new Response(JSON.stringify(body), { status: ok ? 200 : 502, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=30',
    'Netlify-CDN-Cache-Control': ok ? 'public, durable, s-maxage=30, stale-while-revalidate=120' : 'no-store' } });
};

export const config = { path: '/api/sox' };
