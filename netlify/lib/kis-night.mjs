// 코스피200 야간선물 — 한국투자증권 KIS Open API
// 웹소켓(H0MFCNT0: KRX야간선물 실시간종목체결)에 잠깐 접속해 체결 1건을 받고 끊는다.
// 받은 가격은 Netlify Blobs에 세션(평일 18:00~익일 06:00 KST)별로 10초 단위로 쌓는다.
import { getStore } from "@netlify/blobs";
import WebSocketPkg from "ws";
import zlib from "node:zlib";

const WS = globalThis.WebSocket ?? WebSocketPkg;
export const BUCKET = 10;                 // 차트 한 칸 = 10초
const FRESH_SEC = 8;                      // 이 시간 안에 받은 값이 있으면 KIS에 다시 묻지 않음
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

// 웹소켓에 붙어서 체결 1건 받고 바로 끊기
function oneTick(code, key, waitMs = 6000) {
  return new Promise((resolve) => {
    let done = false;
    const ws = new WS(WS_URL);
    const finish = (v) => { if (done) return; done = true; clearTimeout(timer); try { ws.close(); } catch {} resolve(v); };
    const timer = setTimeout(() => finish({ quiet: true }), waitMs);
    const onOpen = () => ws.send(JSON.stringify({
      header: { approval_key: key, custtype: "P", tr_type: "1", "content-type": "utf-8" },
      body: { input: { tr_id: TR_ID, tr_key: code } },
    }));
    const onMsg = (raw) => {
      const s = typeof raw === "string" ? raw : (raw?.data ?? raw).toString();
      if (s[0] === "0" || s[0] === "1") {
        const parts = s.split("|");
        if (parts[1] !== TR_ID) return;
        const f = parts[3].split("^");
        let chg = num(f[F.vrss]), rate = num(f[F.ctrt]);
        if (f[F.sign] === "4" || f[F.sign] === "5") { chg = -Math.abs(chg); rate = -Math.abs(rate); }
        finish({ tick: { p: num(f[F.prpr]), chg, rate, o: num(f[F.oprc]), h: num(f[F.hgpr]), l: num(f[F.lwpr]), vol: num(f[F.vol]) } });
        return;
      }
      try {
        const b = JSON.parse(s).body;
        if (b?.rt_cd && b.rt_cd !== "0") finish({ error: `KIS: ${b.msg1}`, authFail: /approval|appkey|접속키/i.test(b.msg1 || "") });
      } catch {}
    };
    if (ws.on) { ws.on("open", onOpen); ws.on("message", onMsg); ws.on("error", (e) => finish({ error: `웹소켓 오류: ${e.message}` })); ws.on("close", () => finish({ quiet: true })); }
    else { ws.onopen = onOpen; ws.onmessage = onMsg; ws.onerror = () => finish({ error: "웹소켓 오류" }); ws.onclose = () => finish({ quiet: true }); }
  });
}

async function kisTick(s) {
  if (!env("KIS_APP_KEY") || !env("KIS_APP_SECRET")) return { error: "환경변수 KIS_APP_KEY / KIS_APP_SECRET이 없습니다." };
  const code = await frontMonthCode(s);
  let res = await oneTick(code, await approvalKey(s));
  if (res.authFail) res = await oneTick(code, await approvalKey(s, true));
  return { ...res, code };
}

// ───────── 상태 ─────────
const blank = (ses) => ({ id: ses.id, start: ses.start, end: ses.end, code: "", base: null, open: null,
  high: null, low: null, last: null, chg: null, rate: null, vol: null, points: [], fetched_at: 0, error: null, ticks: 0 });

function apply(st, tick, nowSec) {
  if (tick.chg != null) st.base = Math.round((tick.p - tick.chg) * 100) / 100;   // 전일(주간장) 종가
  Object.assign(st, { last: tick.p, chg: tick.chg, rate: tick.rate,
    open: tick.o ?? st.open ?? tick.p, high: tick.h ?? st.high, low: tick.l ?? st.low, vol: tick.vol ?? st.vol });
  const b = Math.floor(nowSec / BUCKET) * BUCKET;
  const lastPt = st.points[st.points.length - 1];
  if (lastPt && lastPt[0] === b) lastPt[1] = tick.p;
  else if (!lastPt || lastPt[0] < b) st.points.push([b, tick.p]);
  st.ticks++;
}

/** 필요하면 KIS에서 새 값을 받아 저장하고, 현재 상태를 돌려준다. */
export async function refresh({ force = false } = {}) {
  const s = store();
  const ses = session();
  const key = `session-${ses.id}`;
  let st = (await s.get(key, { type: "json" })) ?? blank(ses);
  const now = Date.now() / 1000;
  if (!ses.live || (!force && now - st.fetched_at < FRESH_SEC)) return st;

  st.fetched_at = now;                                   // 동시에 들어온 다른 호출이 중복 접속하지 않게 먼저 표시
  await s.setJSON(key, st);
  const res = await kisTick(s).catch((e) => ({ error: e.message }));

  const latest = (await s.get(key, { type: "json" })) ?? st;   // 그 사이 저장된 점이 있으면 합치기
  if (latest.points.length > st.points.length) st = { ...latest, fetched_at: now };
  if (res.code) st.code = res.code;
  if (res.tick?.p) { apply(st, res.tick, now); st.error = null; }
  else if (res.error) st.error = res.error;
  await s.setJSON(key, st);
  return st;
}

export function view(st) {
  const ses = session();
  return {
    start: st.start, end: st.end, bucket: BUCKET, live: ses.live && ses.id === st.id,
    code: st.code, base: st.base, open: st.open, high: st.high, low: st.low,
    last: st.last, chg: st.chg, rate: st.rate, vol: st.vol, error: st.error, points: st.points,
  };
}
