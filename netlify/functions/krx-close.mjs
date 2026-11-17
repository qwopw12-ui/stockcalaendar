// KRX 정규장 종가·시가총액을 받아 live.html에 넘겨주는 함수
// 주소: /api/krx-close?codes=005930,000660
// - 종가·상장주식수: 다음 금융 일별 시세(KRX 정규장 기준), 실패 시 네이버 일봉으로 대신
// - 시가총액: 상장주식수 × 기준 종가
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

// 다음 금융 일별 시세: KRX 정규장 종가(tradePrice)·상장주식수 — 최신일이 맨 앞
async function daumDays(code) {
  const r = await fetch(`https://finance.daum.net/api/quote/A${code}/days?symbolCode=A${code}&page=1&perPage=10&pagination=true`, {
    headers: { 'User-Agent': UA, Referer: `https://finance.daum.net/quotes/A${code}` },
  });
  if (!r.ok) throw new Error(`${r.status} daum ${code}`);
  const j = await r.json();
  return (j.data || []).map(d => ({
    date: String(d.date || '').slice(0, 10).replace(/-/g, ''),
    close: toNum(d.tradePrice),
    shares: toNum(d.listedSharesCount),
  })).filter(d => /^\d{8}$/.test(d.date) && d.close);
}

async function one(code) {
  const out = { code };
  const errors = [];
  const now = kst();
  const today = ymd(now);
  const minutes = now.getUTCHours() * 60 + now.getUTCMinutes();
  // KRX 정규장은 15:30 종가 확정 → 15:40 전이면 오늘 값은 아직 종가가 아니므로 직전 거래일 사용
  const todayFinished = minutes >= 15 * 60 + 40;

  try {
    const days = await daumDays(code);
    let i = 0;
    if (days[0] && days[0].date === today && !todayFinished) i = 1;
    const ref = days[i];
    if (ref) {
      out.date = ref.date; out.close = ref.close; out.source = 'daum';
      if (ref.shares) { out.shares = ref.shares; out.marketCap = ref.shares * ref.close; }
    }
  } catch (e) { errors.push(e.message); }

  // 다음이 안 될 때만 네이버 일봉(NXT 포함 최종가)으로 대신
  if (!out.close) {
    try {
      const rows = await dailyRows(code);
      let idx = rows.length - 1;
      if (rows[idx] && rows[idx].date === today && minutes < 20 * 60 + 5 && idx > 0) idx -= 1;
      if (rows[idx]) { out.date = rows[idx].date; out.close = rows[idx].close; out.source = 'naver'; }
      const poll = await get(`https://polling.finance.naver.com/api/realtime/domestic/stock/${code}`).then(j => j.datas[0]);
      const cap = toNum(poll.marketValueFullRaw), px = toNum(poll.closePriceRaw);
      if (cap && px && out.close) { out.shares = Math.round(cap / px); out.marketCap = out.shares * out.close; }
    } catch (e) { errors.push(e.message); }
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
  return json({ ok, fetchedAt: new Date().toISOString(), source: 'Daum Finance (KRX 정규장 종가)', stocks },
    ok ? 200 : 502,
    ok ? 'public, durable, s-maxage=600, stale-while-revalidate=3600' : 'no-store');
};

export const config = { path: '/api/krx-close' };
