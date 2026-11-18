// 코스피200 야간선물 — 한국투자증권 KIS Open API
// 웹소켓(H0MFCNT0: KRX야간선물 실시간종목체결)에 잠깐 접속해 체결 1건을 받고 끊는다.
// 받은 가격은 Netlify Blobs에 세션(평일 18:00~익일 06:00 KST)별로 10초 단위로 쌓는다.
import { getStore } from "@netlify/blobs";
import WebSocketPkg from "ws";
import zlib from "node:zlib";

const WS = WebSocketPkg;                 // ws 패키지 사용(Node 기본 WebSocket은 KIS 서버와 접속이 실패하고 원인도 안 알려줌)
export const BUCKET = 5;                  // 차트 한 칸 = 5초
const FRESH_SEC = 4;                      // 이 시간 안에 받은 값이 있으면 KIS에 다시 묻지 않음
const KST = 9 * 3600 * 1000;
const DAY = 864e5;
const REST = process.env.KIS_REST_URL || "https://openapi.koreainvestment.com:9443";
const WS_URL = process.env.KIS_WS_URL || "ws://ops.koreainvestment.com:21000/tryitout";
const MASTER = "https://new.real.download.dws.co.kr/common/master/fo_idx_code_mts.mst.zip";
const TR_ID = "H0MFCNT0";
// H0MFCNT0 필드 위치 (한국투자증권 공식 저장소 krx_ngt_futures_ccnl.py 기준)
const F = { code: 0, prpr: 5, vrss: 2, sign: 3, ctrt: 4, oprc: 6, hgpr: 7, lwpr: 8, vol: 10 };

const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? "";
const store = () => getStore({ name: "kis-night", consistency: "strong" });
const kstDate = (ms) => new Date(ms + KST).toISOString().slice(0, 10).replaceAll("-", "");
const isWeekday = (ms) => { const d = new Date(ms + KST).getUTCDay(); return d >= 1 && d <= 5; };

// 표시할 세션: 평일 18:00 ~ 익일 06:00 KST. 주말 밤은 직전 금요일 세션.
export function session(nowMs = Date.now()) {
  const k = new Date(nowMs + KST);
  let start = Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate(), 18, 0) - KST;
  if (nowMs < start) start -= DAY;
  while (!isWeekday(start)) start -= DAY;
  const end = start + 12 * 3600 * 1000;
  return { id: kstDate(start), start: start / 1000, end: end / 1000, live: nowMs >= start && nowMs < end };
}

// ───────── 종목코드 (코스피200 선물 최근월물) ─────────
function unzipFirst(buf) {
  let eocd = buf.length - 22;
  while (eocd >= 0 && buf.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  const cd = buf.readUInt32LE(eocd + 16);
  const method = buf.readUInt16LE(cd + 10), csize = buf.readUInt32LE(cd + 20), lho = buf.readUInt32LE(cd + 42);
  const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
  const data = buf.subarray(start, start + csize);
  return method === 8 ? zlib.inflateRawSync(data) : data;
}

async function frontMonthCode(s) {
  if (env("FUTURES_CODE")) return env("FUTURES_CODE");
  const day = kstDate(Date.now());
  const cached = await s.get("code", { type: "json" });
  if (cached?.day === day) return cached.code;
  const r = await fetch(MASTER);
  if (!r.ok) throw new Error(`종목 마스터 다운로드 실패 ${r.status}`);
  const text = unzipFirst(Buffer.from(await r.arrayBuffer())).toString("latin1");
  for (const line of text.split(/\r?\n/)) {
    const c = line.split("|").map((x) => x.trim());
    if (c.length >= 7 && c[0] === "1" && c[6] === "1") {     // 1=코스피200 선물, 월물구분 1=최근월물
      await s.setJSON("code", { day, code: c[1] });
      return c[1];
    }
  }
  throw new Error("최근월물을 찾지 못했습니다. 환경변수 FUTURES_CODE를 넣어주세요.");
}

async function approvalKey(s, renew = false) {
  const cached = await s.get("approval", { type: "json" });
  if (!renew && cached && Date.now() - cached.at < 12 * 3600 * 1000) return cached.key;
  const r = await fetch(`${REST}/oauth2/Approval`, {
    method: "POST", headers: { "content-type": "application/json; utf-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: env("KIS_APP_KEY"), secretkey: env("KIS_APP_SECRET") }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.approval_key) throw new Error(`접속키 발급 실패: ${j.error_description || j.msg1 || r.status}`);
  await s.setJSON("approval", { key: j.approval_key, at: Date.now() });
  return j.approval_key;
}

const num = (x) => { const v = parseFloat(x); return Number.isFinite(v) ? v : null; };

// ───────── 웹소켓: 1분에 한 번만 접속해서 ~22초 동안 들어오는 체결을 전부 받음 ─────────
// (몇 초마다 새로 접속하면 한투 서버가 연결을 끊어버림 → ECONNRESET)
function streamTicks(code, key, holdMs, onTick) {
  return new Promise((resolve) => {
    let done = false, got = 0;
    const ws = new WS(WS_URL, { handshakeTimeout: 6000, perMessageDeflate: false });
    const finish = (v = {}) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve({ got, ...v }); };
    const timer = setTimeout(() => finish(), holdMs);
    ws.on("open", () => ws.send(JSON.stringify({
      header: { approval_key: key, custtype: "P", tr_type: "1", "content-type": "utf-8" },
      body: { input: { tr_id: TR_ID, tr_key: code } },
    })));
    ws.on("message", (raw) => {
      const s = raw.toString();
      if (s[0] === "0" || s[0] === "1") {
        const parts = s.split("|");
        if (parts[1] !== TR_ID) return;
        const n = parseInt(parts[2], 10) || 1, f = parts[3].split("^"), w = f.length / n;
        for (let i = 0; i < n; i++) {
          const g = (k) => f[i * w + k];
          let chg = num(g(F.vrss)), rate = num(g(F.ctrt));
          if (g(F.sign) === "4" || g(F.sign) === "5") { chg = -Math.abs(chg); rate = -Math.abs(rate); }
          const p = num(g(F.prpr));
          if (p) { got++; onTick({ p, chg, rate, o: num(g(F.oprc)), h: num(g(F.hgpr)), l: num(g(F.lwpr)), vol: num(g(F.vol)) }); }
        }
        return;
      }
      try {
        const j = JSON.parse(s);
        if (j.header?.tr_id === "PINGPONG") { ws.pong?.(raw); ws.send(s); return; }
        const b = j.body;
        if (b?.rt_cd && b.rt_cd !== "0") finish({ error: `KIS: ${b.msg1}`, authFail: /approval|appkey|접속키/i.test(b.msg1 || "") });
      } catch {}
    });
    ws.on("unexpected-response", (_q, r) => finish({ error: `웹소켓 접속 거부: HTTP ${r.statusCode}` }));
    ws.on("error", (e) => finish({ error: `웹소켓 오류: ${e.code || ""} ${e.message}`.trim() }));
    ws.on("close", () => finish());
  });
}

// ───────── REST 현재가 (보는 사람이 있을 때 5초마다, 웹소켓 안 씀) ─────────
async function accessToken(s, renew = false) {
  const c = await s.get("token", { type: "json" });
  if (!renew && c && Date.now() < c.exp - 600e3) return c.token;
  if (c?.tried && Date.now() - c.tried < 65e3 && !c.token) return null;     // 토큰 발급은 1분에 1번만 가능
  const r = await fetch(`${REST}/oauth2/tokenP`, {
    method: "POST", headers: { "content-type": "application/json; utf-8" },
    body: JSON.stringify({ grant_type: "client_credentials", appkey: env("KIS_APP_KEY"), appsecret: env("KIS_APP_SECRET") }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) { await s.setJSON("token", { ...(c || {}), tried: Date.now() }); return c?.token ?? null; }
  await s.setJSON("token", { token: j.access_token, exp: Date.now() + (j.expires_in || 86400) * 1000, tried: Date.now() });
  return j.access_token;
}

async function restQuote(s, code) {
  const token = await accessToken(s);
  if (!token) return null;
  const u = `${REST}/uapi/domestic-futureoption/v1/quotations/inquire-price?FID_COND_MRKT_DIV_CODE=CM&FID_INPUT_ISCD=${encodeURIComponent(code)}`;
  const r = await fetch(u, { headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${token}`,
    appkey: env("KIS_APP_KEY"), appsecret: env("KIS_APP_SECRET"), tr_id: "FHMIF10000000", custtype: "P" } });
  const j = await r.json().catch(() => ({}));
  const o = j.output1;
  if (j.rt_cd !== "0" || !o) return null;
  const p = num(o.futs_prpr);
  if (!p) return null;
  let chg = num(o.futs_prdy_vrss), rate = num(o.futs_prdy_ctrt);
  if (o.prdy_vrss_sign === "4" || o.prdy_vrss_sign === "5") { chg = -Math.abs(chg); rate = -Math.abs(rate); }
  return { p, chg, rate, o: num(o.futs_oprc), h: num(o.futs_hgpr), l: num(o.futs_lwpr), vol: num(o.acml_vol) };
}

// ───────── 상태 ─────────
const blank = (ses) => ({ id: ses.id, start: ses.start, end: ses.end, code: "", base: null, open: null,
  high: null, low: null, last: null, chg: null, rate: null, vol: null, points: [], fetched_at: 0, error: null, ticks: 0, rest_ok: null });

function apply(st, tick, nowSec) {
  if (tick.chg != null) st.base = Math.round((tick.p - tick.chg) * 100) / 100;   // 전일(주간장) 종가
  Object.assign(st, { last: tick.p, chg: tick.chg, rate: tick.rate,
    open: tick.o ?? st.open ?? tick.p, high: tick.h ?? st.high, low: tick.l ?? st.low, vol: tick.vol ?? st.vol, last_at: nowSec });
  const b = Math.floor(nowSec / BUCKET) * BUCKET;
  const pts = st.points, lastPt = pts[pts.length - 1];
  if (lastPt && lastPt[0] === b) lastPt[1] = tick.p;
  else if (!lastPt || lastPt[0] < b) pts.push([b, tick.p]);
  else {                                                     // 늦게 도착한 점은 제자리에 끼워 넣기
    const i = pts.findIndex((q) => q[0] >= b);
    if (pts[i][0] === b) pts[i][1] = tick.p; else pts.splice(i, 0, [b, tick.p]);
  }
  st.ticks++;
}

// 저장할 때 다른 호출이 그 사이 저장한 점과 합치기
async function save(s, key, st) {
  const cur = await s.get(key, { type: "json" });
  if (cur && cur.id === st.id) {
    const m = new Map(cur.points.map((q) => [q[0], q[1]]));
    for (const [t, p] of st.points) m.set(t, p);
    st.points = [...m.entries()].sort((x, y) => x[0] - y[0]);
    if ((cur.last_at || 0) > (st.last_at || 0)) for (const k of ["last", "chg", "rate", "base", "high", "low", "vol", "last_at"]) st[k] = cur[k];
  }
  await s.setJSON(key, st);
}

/** 수집기(1분마다): REST 현재가를 5초 간격으로 ~24초 동안 받아 쌓는다(보는 사람이 없어도 차트가 이어지게).
 *  REST가 야간 값을 못 주면 그때만 웹소켓으로 ~22초 받기. */
export async function collect() {
  const s = store(), ses = session(), key = `session-${ses.id}`;
  if (!ses.live) return;
  if (!env("KIS_APP_KEY") || !env("KIS_APP_SECRET")) return;
  const st = (await s.get(key, { type: "json" })) ?? blank(ses);
  try {
    st.code = await frontMonthCode(s);
    if (st.rest_ok !== false) {
      let ok = 0;
      for (let i = 0; i < 5; i++) {
        const t0 = Date.now();
        const q = await restQuote(s, st.code).catch(() => null);
        if (q && (st.open == null || Math.abs((q.o ?? 0) - st.open) < 0.01)) { apply(st, q, Date.now() / 1000); st.rest_ok = true; ok++; }
        else if (q) { st.rest_ok = false; break; }
        if (i < 4) await new Promise((r) => setTimeout(r, Math.max(0, 5000 - (Date.now() - t0))));
      }
      if (ok) { st.error = null; await save(s, key, st); return; }
    }
    const onTick = (t) => apply(st, t, Date.now() / 1000);
    let res = await streamTicks(st.code, await approvalKey(s), 22000, onTick);
    if (res.authFail) res = await streamTicks(st.code, await approvalKey(s, true), 3000, onTick);
    st.error = res.got ? null : (res.error || null);
  } catch (e) { st.error = e.message; }
  await save(s, key, st);
}

/** 화면 요청(5초마다): 웹소켓은 건드리지 않고 REST 현재가로 최신 값만 보탠다. */
export async function refresh() {
  const s = store(), ses = session(), key = `session-${ses.id}`;
  let st = (await s.get(key, { type: "json" })) ?? blank(ses);
  const now = Date.now() / 1000;
  if (!ses.live || st.rest_ok === false || now - st.fetched_at < FRESH_SEC || !st.code) return st;
  st.fetched_at = now;
  const q = await restQuote(s, st.code).catch(() => null);
  // 야간 값인지 확인: 웹소켓으로 받은 야간 시가와 같아야 채택 (다르면 주간 값이라 버림)
  if (q && (st.open == null || Math.abs((q.o ?? 0) - st.open) < 0.01)) { apply(st, q, now); st.rest_ok = true; st.error = null; }
  else if (q) st.rest_ok = false;
  await save(s, key, st);
  return st;
}

export function view(st) {
  const ses = session();
  // 18:00 시작점: 첫 체결이 18:00보다 늦게 잡혔으면 KIS가 준 야간 시가를 18:00 자리에 둬서 선이 18:00부터 시작하게
  let points = st.points;
  if (st.open != null && points.length && points[0][0] > st.start) points = [[st.start, st.open], ...points];
  return {
    start: st.start, end: st.end, bucket: BUCKET, live: ses.live && ses.id === st.id,
    code: st.code, base: st.base, open: st.open, high: st.high, low: st.low,
    last: st.last, chg: st.chg, rate: st.rate, vol: st.vol, error: st.error, points,
  };
}
