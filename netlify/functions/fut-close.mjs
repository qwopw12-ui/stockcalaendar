// 코스피200 선물 주간장 종가 (야간 추정지수 기준값용)
// 주소: /api/fut-close?d=YYYYMMDD → 그 날짜(없으면 그 이전 최근 거래일) 주간 종가
// 출처: 네이버 금융 선물 일봉. Netlify CDN에 10분 캐시.
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
export default async (req) => {
  const d = new URL(req.url).searchParams.get('d') || '';
  const out = (o, s = 200, age = 600) => new Response(JSON.stringify(o), { status: s, headers: {
    'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=60', 'Netlify-CDN-Cache-Control': `public, s-maxage=${age}` } });
  if (!/^\d{8}$/.test(d)) return out({ error: 'd=YYYYMMDD 필요' }, 400, 60);
  try {
    const r = await fetch('https://fchart.stock.naver.com/sise.nhn?symbol=FUT&timeframe=day&count=10&requestType=0', { headers: { 'User-Agent': UA, Referer: 'https://finance.naver.com/' } });
    if (!r.ok) throw new Error('naver ' + r.status);
    const txt = await r.text();
    const rows = [...txt.matchAll(/data="(\d{8})\|[^|]*\|[^|]*\|[^|]*\|([\d.]+)\|/g)].map(m => ({ date: m[1], close: +m[2] }));
    const row = rows.filter(x => x.date <= d).pop();
    if (!row) throw new Error('해당 날짜 없음');
    return out({ date: row.date, close: row.close });
  } catch (e) { return out({ error: String(e.message || e) }, 502, 60); }
};
export const config = { path: '/api/fut-close' };
