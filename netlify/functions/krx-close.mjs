// 기준 종가(NXT 애프터마켓 20:00 최종가)·시가총액을 네이버 증권에서 받아 live.html에 넘겨주는 함수
// 주소: /api/krx-close?codes=005930,000660
// - 기준 종가: 네이버 일봉(siseJson) 종가 = NXT 애프터마켓까지 반영된 20:00 최종가
// - 시가총액: 네이버 시총 ÷ 현재가로 상장주식수를 구한 뒤 × 기준 종가
// 결과는 Netlify CDN에 10분간 캐시되어 함수 호출은 많아야 10분에 한 번입니다.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function get(url, as = 'json') {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return as === 'json' ? r.json() : r.text();
}

const toNum = v => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

const kst = (offsetDays = 0) => new Date(Date.now() + 9 * 3600e3 + offsetDays * 86400e3);
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, '');

// 네이버 KRX 일봉: [['날짜','시가','고가','저가','종가','거래량','외국인소진율'], ["20261117", ...], ...]
async function dailyRows(code) {
  const txt = await get(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${ymd(kst(-372))}&endTime=${ymd(kst())}&timeframe=day`, 'text');
  const arr = JSON.parse(txt.trim().replace(/'/g, '"'));
  return arr.slice(1)
    .filter(r => Array.isArray(r) && r.length >= 5)
    .map(r => ({ date: String(r[0]).trim(), high: toNum(r[2]), low: toNum(r[3]), close: toNum(r[4]) }))
    .filter(r => /^\d{8}$/.test(r.date) && r.close);
}

async function one(code) {
  const out = { code, basis: 'NXT' };
  const errors = [];
  let poll = null, rows = [];

  await Promise.all([
    get(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`)
      .then(j => poll = j && j.datas && j.datas[0]).catch(e => errors.push(e.message)),
    dailyRows(code).then(r => rows = r).catch(e => errors.push(e.message)),
  ]);

  const now = kst();
  const today = ymd(now);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // 네이버 일봉 종가 = NXT 애프터마켓까지 끝난 20:00 최종가.
  // 오늘 20:05 전이면 오늘 봉은 아직 확정이 아니므로 직전 거래일 사용.
  const todayFinished = minutes >= 20 * 60 + 5;

  if (rows.length) {
    let idx = rows.length - 1;
    if (rows[idx].date === today && !todayFinished && idx > 0) idx -= 1;
    out.date = rows[idx].date;
    out.close = rows[idx].close;
  }

  if (poll) {
    // 시가총액 = 상장주식수(네이버 시총 ÷ 현재가) × 기준 종가
    const cap = toNum(poll.marketValueFullRaw), px = toNum(poll.closePriceRaw || poll.closePrice);
    if (cap && px) {
      out.shares = Math.round(cap / px);
      if (out.close) out.marketCap = out.shares * out.close;
    }
  }

  if (errors.length) out.errors = errors;
  return out;
}

const json = (obj, status, cdn) => new Response(JSON.stringify(obj), {
  status,
  headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Cache-Control': 'public, max-age=60',
    'Netlify-CDN-Cache-Control': cdn,
  },
});

export default async (req) => {
  const url = new URL(req.url);
  const codes = (url.searchParams.get('codes') || '005930,000660')
    .split(',').map(s => s.trim()).filter(s => /^\d{6}$/.test(s)).slice(0, 10);

  const stocks = await Promise.all(codes.map(one));
  const ok = stocks.some(s => s.close && s.date);
  return json({ ok, fetchedAt: new Date().toISOString(), source: 'Naver Finance 일봉 (NXT 포함 20:00 최종가)', stocks },
    ok ? 200 : 502,
    ok ? 'public, durable, s-maxage=600, stale-while-revalidate=3600' : 'no-store');
};

export const config = { path: '/api/krx-close' };
