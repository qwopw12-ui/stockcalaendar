// 롱숏 투표
// GET  /api/vote        → 지금 보여줄 거래일, 투표 중인지(open), 마감·판정 시각, 롱·숏 인원
// GET  /api/vote?hist=1 → 판정이 끝난 지난 거래일별 롱·숏 인원
// POST /api/vote {side, vid} → 투표 (마감 전까지 바꾸기 가능)
// 일정: 대상 거래일 T의 투표는 T 바로 앞 거래일 15:30 ~ 23:30(KST). 마감 후 T 15:30(장 마감)까지 결과 대기로 보여주고,
//       T 15:30이 지나면 다음 거래일 투표 시작. 주말·휴장일은 건너뜀.
// 저장: Netlify Blobs "longshort" — 키 `<거래일>/<long|short>/<vid>`, 30일 지난 기록은 vote-clean이 `sum/<거래일>`로 요약 후 삭제
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const KST = 9 * 3600e3, DAY = 864e5;
const HOL = ["2026-12-25", "2026-12-31", "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-01", "2027-03-03"];
const ymd = (d) => d.toISOString().slice(0, 10);
const isTD = (d) => { const w = d.getUTCDay(); return w > 0 && w < 6 && !HOL.includes(ymd(d)); };
const prevTD = (t) => { let p = new Date(t.getTime() - DAY); while (!isTD(p)) p = new Date(p.getTime() - DAY); return p; };
const iso = (kstMs) => new Date(kstMs - KST).toISOString();
function target(nowMs = Date.now()) {
  const k = nowMs + KST, today = new Date(Date.UTC(new Date(k).getUTCFullYear(), new Date(k).getUTCMonth(), new Date(k).getUTCDate()));
  let t = new Date(today.getTime() - DAY);
  for (;;) {
    t = new Date(t.getTime() + DAY);
    if (!isTD(t)) continue;
    const judge = t.getTime() + 15.5 * 3600e3;                     // T 15:30 KST
    if (k >= judge) continue;
    const p = prevTD(t), opens = p.getTime() + 15.5 * 3600e3, deadline = p.getTime() + 23.5 * 3600e3;
    return { day: ymd(t), open: k >= opens && k < deadline, opens: iso(opens), deadline: iso(deadline), judge: iso(judge) };
  }
}
const store = () => getStore({ name: "longshort", consistency: "strong" });
async function count(s, day) {
  const n = {};
  for (const side of ["long", "short"]) {
    let c = 0;
    for await (const page of s.list({ prefix: `${day}/${side}/`, paginate: true })) c += page.blobs.length;
    n[side] = c;
  }
  return n;
}
async function history(s, curDay) {
  const by = {};
  for await (const page of s.list({ paginate: true })) {
    for (const { key } of page.blobs) {
      const m = key.match(/^(\d{4}-\d{2}-\d{2})\/(long|short)\//);
      if (!m || m[1] >= curDay) continue;
      (by[m[1]] ??= { long: 0, short: 0 })[m[2]]++;
    }
  }
  for await (const page of s.list({ prefix: "sum/", paginate: true })) {
    for (const { key } of page.blobs) {
      const day = key.slice(4);
      if (by[day] || day >= curDay) continue;
      const v = await s.get(key, { type: "json" });
      if (v) by[day] = { long: v.long || 0, short: v.short || 0 };
    }
  }
  return Object.entries(by).map(([day, n]) => ({ day, ...n })).sort((a, b) => (a.day < b.day ? 1 : -1)).slice(0, 60);
}
const json = (b, st = 200, h = {}) => new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });

export default async (req, ctx) => {
  const s = store(), tg = target();
  if (req.method === "GET") {
    if (new URL(req.url).searchParams.get("hist")) {
      return json({ ok: true, day: tg.day, hist: await history(s, tg.day) }, 200, { "Cache-Control": "public, max-age=30", "Netlify-CDN-Cache-Control": "public, s-maxage=60" });
    }
    const n = await count(s, tg.day);
    return json({ ok: true, ...tg, ...n }, 200, { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, s-maxage=3, stale-while-revalidate=3" });
  }
  if (req.method !== "POST") return json({ ok: false }, 405);
  if (!tg.open) return json({ ok: false, error: "closed", ...tg }, 409);
  let b; try { b = await req.json(); } catch (e) { return json({ ok: false, error: "bad body" }, 400); }
  const side = b.side, vid = String(b.vid || "");
  if (!["long", "short"].includes(side) || !/^[a-z0-9]{16,40}$/.test(vid)) return json({ ok: false, error: "bad vote" }, 400);
  // 같은 IP에서 하루 40표까지 (통신사·회사 공용 IP 고려해 넉넉하게). IP는 되돌릴 수 없게 변환해 저장
  const ip = ctx?.ip || req.headers.get("x-nf-client-connection-ip") || "";
  const rk = `rl/${tg.day}/${createHash("sha256").update(ip + "|kant").digest("hex").slice(0, 20)}`;
  const used = Number(await s.get(rk)) || 0;
  if (used >= 40) return json({ ok: false, error: "too many" }, 429);
  await s.set(`${tg.day}/${side}/${vid}`, "1");
  await s.delete(`${tg.day}/${side === "long" ? "short" : "long"}/${vid}`);
  await s.set(rk, String(used + 1));
  return json({ ok: true, day: tg.day, side }, 200, { "Cache-Control": "no-store" });
};

export const config = { path: "/api/vote" };
