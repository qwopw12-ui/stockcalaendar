// KRX 정규장 종가·시가총액·52주 범위를 네이버 증권에서 받아 live.html에 넘겨주는 함수
// 주소: /api/krx-close?codes=005930,000660
// - 종가·52주 범위: 네이버 KRX 일봉(siseJson, NXT 미포함) 기준
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
  // 시가총액은 KRX 정규장 종가 기준으로 계산
  const out = { code };
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
  const marketOpen = poll && /OPEN/i.test(String(poll.marketStatus || ''));
  // 장중이거나 오늘 15:35 이전이면 오늘 봉은 아직 확정 종가가 아님 → 직전 거래일 사용
  const todayUnfinished = marketOpen || minutes < 15 * 60 + 35;

  if (rows.length) {
    let idx = rows.length - 1;
    if (rows[idx].date === today && todayUnfinished && idx > 0) idx -= 1;
    const ref = rows[idx];
    out.date = ref.date;
    out.close = ref.close;

    // 52주(기준일 포함 직전 1년) 최고·최저 — 장중 고가/저가 기준
    const from = ymd(new Date(Date.UTC(+ref.date.slice(0, 4) - 1, +ref.date.slice(4, 6) - 1, +ref.date.slice(6, 8))));
    const yr = rows.slice(0, idx + 1).filter(r => r.date > from);
    if (yr.length) {
      out.high52 = Math.max(...yr.map(r => r.high || r.close));
      out.low52 = Math.min(...yr.map(r => r.low || r.close));
    }
  }

  if (poll) {
    const cap = toNum(poll.marketValueFullRaw), px = toNum(poll.closePriceRaw || poll.closePrice);
    if (cap && px) {
      const shares = Math.round(cap / px);
      out.shares = shares;
      if (out.close) out.marketCap = shares * out.close;
    }
    if (!out.close && px) out.close = px; // 일봉 실패 시 대비
  }

  // NXT(넥스트레이드) 애프터마켓 20:00 종가를 비교 기준으로 사용
  // - 그날 애프터마켓이 끝났으면(20:00 이후) 그 마감가
  // - 아직 거래 중(프리마켓~애프터마켓)이면 '현재가 − 전일 대비'로 직전 NXT 종가 계산
  const om = poll && poll.overMarketPriceInfo;
  if (om) {
    const over = toNum(om.overPrice), chg = toNum(om.compareToPreviousClosePrice);
    const tdate = String(om.localTradedAt || '').slice(0, 10).replace(/-/g, '');
    const finished = /AFTER_MARKET/i.test(om.tradingSessionType || '') && /CLOSE/i.test(om.overMarketStatus || '')
      && /^\d{8}$/.test(tdate) && (tdate < today || minutes >= 20 * 60);
    let nxtClose = null, nxtDate = null;
    if (over && finished) { nxtClose = over; nxtDate = tdate; }
    else if (over && chg != null) {
      nxtClose = over - chg;
      const prev = rows.filter(r => r.date < (tdate || today)).pop();
      nxtDate = prev ? prev.date : null;
    }
    if (nxtClose && nxtDate) {
      out.krxClose = out.close; out.krxDate = out.date;
      out.close = nxtClose; out.date = nxtDate; out.basis = 'NXT';
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
  return json({ ok, fetchedAt: new Date().toISOString(), source: 'Naver Finance (KRX 정규장 일봉)', stocks },
    ok ? 200 : 502,
    ok ? 'public, durable, s-maxage=600, stale-while-revalidate=3600' : 'no-store');
};

export const config = { path: '/api/krx-close' };
