// 정규장 시간대 일봉 (Hyperliquid 해외 거래소 가격으로 만듦 — KRX 데이터 사용 안 함)
// /api/hlbars?sym=KR200|SMSN|SKHX|XYZ100 → [[YYYYMMDD,시,고,저,종,거래량],...]
// - KR200·SMSN·SKHX: 한국 정규장 시간(09:00~15:30 KST)의 30분봉을 모아 하루 봉으로. 휴장일 제외. 삼성·하이닉스는 ECB 일별 기준환율로 원화 환산
// - XYZ100(나스닥100): 미국 정규장 시간(뉴욕 09:30~16:00)
// 종가 = 정규장 마감 시각 가격. CDN 캐시 30분(15:20~16:30 KST엔 2분)
const API = "https://api.hyperliquid.xyz/info";
const KST = 9 * 3600e3, M30 = 1800e3;
// KRX 휴장일(평일) — 2025-10 이후
const HOL = new Set(["2025-10-03", "2025-10-06", "2025-10-07", "2025-10-08", "2025-10-09", "2025-12-25", "2025-12-31", "2026-01-01",
  "2026-02-16", "2026-02-17", "2026-02-18", "2026-03-02", "2026-05-01", "2026-05-05", "2026-05-25", "2026-06-03", "2026-07-17",
  "2026-08-17", "2026-09-24", "2026-09-25", "2026-10-05", "2026-10-09", "2026-12-25", "2026-12-31", "2027-01-01", "2027-02-08",
  "2027-02-09", "2027-03-01", "2027-03-03"]);
const SYM = { KR200: "kr", SMSN: "kr", SKHX: "kr", XYZ100: "us" };

// 하이퍼리퀴드는 간격별 최근 5000개 봉만 줌 → 30분봉(약 104일, 정확한 15:30 종가) + 1시간봉(약 208일, 오래된 구간)
async function snap(coin, interval, ms) {
  const now = Date.now();
  for (let i = 0; i < 3; i++) {
  const r = await fetch(API, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "candleSnapshot", req: { coin, interval, startTime: now - 4990 * ms, endTime: now } }) });
  const d = r.ok ? await r.json().catch(() => null) : null;
  if (Array.isArray(d) && d.length) return d;
  await new Promise(z => setTimeout(z, 400 * (i + 1)));
  }
  throw new Error("hyperliquid 응답 없음 " + coin + " " + interval);
}
const etOffsetH = (ms) => { // 그 시각 뉴욕의 UTC 오프셋(시간) 4 또는 5
  const h = +new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "numeric", hour12: false }).format(new Date(ms));
  return ((new Date(ms).getUTCHours() - h) + 24) % 24;
};
// step: 봉 길이(분). 1시간봉이면 한국은 09:00~15:00(종가=15:00), 미국은 10:00~16:00 시작 봉 사용(근사)
function sessions(ks, kind, step) {
  const by = new Map();
  for (const k of ks) {
    let d;
    if (kind === "kr") d = new Date(k.t + KST);
    else d = new Date(k.t - etOffsetH(k.t) * 3600e3);
    const day = d.toISOString().slice(0, 10), m = d.getUTCHours() * 60 + d.getUTCMinutes(), w = d.getUTCDay();
    if (w === 0 || w === 6) continue;
    if (kind === "kr") { if (HOL.has(day) || m < 540 || m + step > 930) continue; }          // 봉이 09:00~15:30 안에 들어감
    else if (step === 30 ? (m < 570 || m >= 960) : (m < 600 || m >= 960)) continue;            // 뉴욕 정규장
    const b = by.get(day);
    if (!b) by.set(day, { day, o: +k.o, h: +k.h, l: +k.l, c: +k.c, v: +k.v });
    else { b.h = Math.max(b.h, +k.h); b.l = Math.min(b.l, +k.l); b.c = +k.c; b.v += +k.v; }
  }
  return by;
}
async function sessionBars(coin, kind) {
  const h1 = await snap(coin, "1h", 3600e3), m30 = await snap(coin, "30m", M30);
  const old = sessions(h1, kind, 60), fresh = sessions(m30, kind, 30);
  const first30 = m30.length ? m30[0].t : Infinity, firstDay = new Date(first30 + (kind === "kr" ? KST : 0)).toISOString().slice(0, 10);
  const out = new Map();
  for (const [d, b] of old) if (d <= firstDay) out.set(d, b);                               // 30분봉 시작일(하루치 불완전)까진 1시간봉
  for (const [d, b] of fresh) if (d > firstDay) out.set(d, b);
  return [...out.values()].sort((a, b) => (a.day < b.day ? -1 : 1));
}
export async function bars(sym) {
  const kind = SYM[sym]; if (!kind) throw new Error("sym");
  let rows = await sessionBars("xyz:" + sym, kind);
  if (sym === "SMSN" || sym === "SKHX") {                                                 // 원화 환산: 유럽중앙은행(ECB) 일별 기준환율(Frankfurter), 없는 날은 직전 값
    const a = rows[0].day, b = rows[rows.length - 1].day;
    const j = await (await fetch(`https://api.frankfurter.dev/v1/${a}..${b}?from=USD&to=KRW`)).json();
    const fx = Object.entries(j.rates || {}).map(([d, v]) => [d, v.KRW]).sort();
    let i = 0, f = fx.length ? fx[0][1] : null;
    rows = rows.map(r => { while (i < fx.length && fx[i][0] <= r.day) f = fx[i++][1]; return { ...r, o: r.o * f, h: r.h * f, l: r.l * f, c: r.c * f }; });
  }
  const r2 = (x) => Math.round(x * 100) / 100;
  return rows.slice(-400).map(b => [b.day.replace(/-/g, ""), r2(b.o), r2(b.h), r2(b.l), r2(b.c), Math.round(b.v)]);
}
function cacheHdr() {
  const k = new Date(Date.now() + KST), m = k.getUTCHours() * 60 + k.getUTCMinutes();
  return m >= 920 && m <= 990 ? { "Cache-Control": "public, max-age=60", "Netlify-CDN-Cache-Control": "public, s-maxage=120" }
    : { "Cache-Control": "public, max-age=300", "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600" };
}
export default async (req) => {
  const sym = new URL(req.url).searchParams.get("sym") || "";
  try {
    return new Response(JSON.stringify(await bars(sym)), { headers: { "Content-Type": "application/json; charset=utf-8", ...cacheHdr() } });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e.message || e) }), { status: 502, headers: { "Cache-Control": "no-store" } });
  }
};
export const config = { path: "/api/hlbars" };
