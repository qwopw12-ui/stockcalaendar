// 롱숏 투표: GET /api/vote → 지금 투표 중인 거래일과 롱·숏 인원, POST /api/vote {side, vid} → 투표(마감 전까지 바꾸기 가능)
// 저장: Netlify Blobs "longshort" — 키 `<거래일>/<long|short>/<vid>` (한 사람 한 키, 편 바꾸면 반대쪽 키 삭제)
import { getStore } from "@netlify/blobs";
import { createHash } from "node:crypto";

const KST = 9 * 3600e3, DAY = 864e5;
const HOL = ["2026-12-25", "2026-12-31", "2027-01-01", "2027-02-08", "2027-02-09", "2027-03-01", "2027-03-03"];
const ymd = (d) => d.toISOString().slice(0, 10);
const isTD = (d) => { const w = d.getUTCDay(); return w > 0 && w < 6 && !HOL.includes(ymd(d)); };
// 투표 대상: 마감(대상 거래일 전날 23:30 KST)이 아직 안 지난 가장 가까운 거래일
function target(nowMs = Date.now()) {
  const k = new Date(nowMs + KST);
  let t = new Date(Date.UTC(k.getUTCFullYear(), k.getUTCMonth(), k.getUTCDate()));
  for (;;) {
    t = new Date(t.getTime() + DAY);
    if (!isTD(t)) continue;
    const deadline = t.getTime() - DAY + 23.5 * 3600e3;          // KST 기준 시각(UTC로 표현)
    if (k.getTime() < deadline) return { day: ymd(t), deadline: new Date(deadline - KST).toISOString() };
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
const json = (b, st = 200, h = {}) => new Response(JSON.stringify(b), { status: st, headers: { "Content-Type": "application/json; charset=utf-8", ...h } });

export default async (req, ctx) => {
  const s = store(), tg = target();
  if (req.method === "GET") {
    const n = await count(s, tg.day);
    return json({ ok: true, ...tg, ...n }, 200, { "Cache-Control": "public, max-age=0, must-revalidate", "Netlify-CDN-Cache-Control": "public, s-maxage=3, stale-while-revalidate=3" });
  }
  if (req.method !== "POST") return json({ ok: false }, 405);
  let b; try { b = await req.json(); } catch (e) { return json({ ok: false, error: "bad body" }, 400); }
  const side = b.side, vid = String(b.vid || "");
  if (!["long", "short"].includes(side) || !/^[a-z0-9]{16,40}$/.test(vid)) return json({ ok: false, error: "bad vote" }, 400);
  // 같은 IP에서 하루 40표까지 (통신사·회사 공용 IP 고려해 넉넉하게)
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
