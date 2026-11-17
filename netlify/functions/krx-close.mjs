// KRX 종가·시가총액·52주 범위를 네이버 증권에서 받아 live.html에 넘겨주는 함수
// 주소: /api/krx-close?codes=005930,000660
// 결과는 Netlify CDN에 10분간 캐시되어 함수 호출은 많아야 10분에 한 번입니다.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

async function getJson(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://m.stock.naver.com/' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

async function getText(url) {
  const r = await fetch(url, { headers: { 'User-Agent': UA, 'Referer': 'https://finance.naver.com/' } });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.text();
}

const toNum = v => {
  if (v == null) return null;
  const n = Number(String(v).replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? n : null;
};

// "1,086조 5,285억" → 원 단위 숫자
function parseKrwCap(s) {
  if (!s) return null;
  const jo = /([\d,]+)\s*조/.exec(s), eok = /([\d,]+)\s*억/.exec(s);
  if (!jo && !eok) return null;
  return (jo ? toNum(jo[1]) * 1e12 : 0) + (eok ? toNum(eok[1]) * 1e8 : 0);
}

// 한국시간 기준 YYYYMMDD, 분 단위 시각
function kstNow() {
  const d = new Date(Date.now() + 9 * 3600e3);
  const ymd = d.toISOString().slice(0, 10).replace(/-/g, '');
  return { ymd, minutes: d.getUTCHours() * 60 + d.getUTCMinutes() };
}

// 네이버 일봉: [['날짜','시가','고가','저가','종가','거래량','외국인소진율'], ["20261117", ...], ...]
async function dailyRows(code) {
  const now = kstNow();
  const start = new Date(Date.now() + 9 * 3600e3 - 20 * 86400e3).toISOString().slice(0, 10).replace(/-/g, '');
  const txt = await getText(`https://api.finance.naver.com/siseJson.naver?symbol=${code}&requestType=1&startTime=${start}&endTime=${now.ymd}&timeframe=day`);
  const arr = JSON.parse(txt.trim().replace(/'/g, '"'));
  return arr.slice(1).filter(r => Array.isArray(r) && r.length >= 5)
    .map(r => ({ date: String(r[0]).trim(), close: toNum(r[4]) }))
    .filter(r => /^\d{8}$/.test(r.date) && r.close);
}

async function one(code) {
  const now = kstNow();
  const out = { code };
  const errors = [];

  let basic = null, integ = null, rows = [];
  await Promise.all([
    getJson(`https://m.stock.naver.com/api/stock/${code}/basic`).then(j => basic = j).catch(e => errors.push(e.message)),
    getJson(`https://m.stock.naver.com/api/stock/${code}/integration`).then(j => integ = j).catch(e => errors.push(e.message)),
    dailyRows(code).then(r => rows = r).catch(e => errors.push(e.message)),
  ]);

  const marketOpen = basic && /OPEN/i.test(String(basic.marketStatus || ''));
  // 장중이거나 오늘 15:35 이전이면 오늘 봉은 아직 종가가 아니므로 직전 거래일 종가를 씀
  const todayUnfinished = marketOpen || now.minutes < 15 * 60 + 35;

  if (rows.length) {
    let last = rows[rows.length - 1];
    if (last.date === now.ymd && todayUnfinished && rows.length > 1) last = rows[rows.length - 2];
    out.date = last.date;
    out.close = last.close;
  } else if (basic) {
    // 일봉을 못 받으면 basic으로 대신 계산
    const price = toNum(basic.closePrice), chg = toNum(basic.compareToPreviousClosePrice);
    const tradedDate = String(basic.localTradedAt || '').slice(0, 10).replace(/-/g, '');
    if (marketOpen && price != null && chg != null) { out.close = price - chg; out.date = null; }
    else { out.close = price; out.date = tradedDate || null; }
  }

  if (integ && Array.isArray(integ.totalInfos)) {
    const info = Object.fromEntries(integ.totalInfos.map(i => [i.code, i.value]));
    out.high52 = toNum(info.highPriceOf52Weeks);
    out.low52 = toNum(info.lowPriceOf52Weeks);
    out.marketCap = parseKrwCap(info.marketValue);
  }
  if (errors.length) out.errors = errors;
  return out;
}

export default async (req) => {
  const url = new URL(req.url);
  const codes = (url.searchParams.get('codes') || '005930,000660')
    .split(',').map(s => s.trim()).filter(s => /^\d{6}$/.test(s)).slice(0, 10);

  const stocks = await Promise.all(codes.map(one));
  const ok = stocks.some(s => s.close);

  return new Response(JSON.stringify({ ok, fetchedAt: new Date().toISOString(), stocks }), {
    status: ok ? 200 : 502,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=60',
      'Netlify-CDN-Cache-Control': ok ? 'public, durable, s-maxage=600, stale-while-revalidate=3600' : 'no-store',
    },
  });
};

export const config = { path: '/api/krx-close' };
