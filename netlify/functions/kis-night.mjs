// 야간선물 탭이 5초마다 부르는 주소: /api/kis-night
// 웹소켓은 쓰지 않음(수집기가 1분에 한 번만 접속). 여기선 REST 현재가로 최신값만 보탬, CDN 4초 캐시
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
