// 야간선물 탭이 10초마다 부르는 주소: /api/kis-night
// 응답은 Netlify CDN에 10초간 캐시 → 보는 사람이 몇 명이든 KIS 접속·함수 실행은 10초에 한 번 정도
import { refresh, view } from "../lib/kis-night.mjs";

export default async () => {
  try {
    const st = await refresh();
    return Response.json(view(st), { headers: {
      "cache-control": "public, max-age=0, must-revalidate",
      "netlify-cdn-cache-control": "public, s-maxage=4, stale-while-revalidate=4",
    } });
  } catch (e) {
    return Response.json({ error: e.message }, { status: 500, headers: { "cache-control": "no-store" } });
  }
};

export const config = { path: "/api/kis-night" };
