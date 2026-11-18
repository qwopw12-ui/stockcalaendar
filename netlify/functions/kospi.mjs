// 코스피 종가 — 예상 코스피(야간선물 등락률 환산)용. 10분간 CDN 캐시
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

export default async () => {
  let body = { ok: false };
  try {
    const r = await fetch('https://polling.finance.naver.com/api/realtime/domestic/index/KOSPI', { headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/' } });
    const d = (await r.json()).datas[0];
    const num = s => Number(String(s ?? '').replace(/,/g, ''));
    const price = num(d.closePriceRaw ?? d.closePrice);
    let chg = num(d.compareToPreviousClosePriceRaw ?? d.compareToPreviousClosePrice);
    const nm = d.compareToPreviousPrice?.name;
    if (nm === 'FALLING' || nm === 'LOWER_LIMIT') chg = -Math.abs(chg);
    if (price) body = { ok: true, close: price, prevClose: +(price - chg).toFixed(2), status: d.marketStatus,
                        date: String(d.localTradedAt || '').slice(0, 10) };
  } catch (e) {}
  return new Response(JSON.stringify(body), { status: body.ok ? 200 : 502, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
    'Netlify-CDN-Cache-Control': body.ok ? 'public, durable, s-maxage=600, stale-while-revalidate=600' : 'no-store' } });
};

export const config = { path: '/api/kospi' };
