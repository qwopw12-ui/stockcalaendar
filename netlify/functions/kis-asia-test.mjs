// 테스트용: 한국투자 Open API 해외지수 분봉(FHKST03030200)이 실시간인지 확인 — 야간선물 함수가 저장한 토큰을 그대로 사용(새 토큰 발급 안 함)
import { getStore } from "@netlify/blobs";
const REST = process.env.KIS_REST_URL || "https://openapi.koreainvestment.com:9443";
const env = (k) => globalThis.Netlify?.env?.get(k) ?? process.env[k] ?? "";
const CODES = ["JP#NI225", "TW#WT", "SHANG", "HK#HS"];

export default async () => {
  const out = { now: new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 19) + " KST", res: {} };
  try {
    const c = await getStore({ name: "kis-night", consistency: "strong" }).get("token", { type: "json" });
    if (!c?.token) return Response.json({ ...out, error: "no token" }, { headers: { "cache-control": "no-store" } });
    for (const code of CODES) {
      const u = `${REST}/uapi/overseas-price/v1/quotations/inquire-time-indexchartprice?FID_COND_MRKT_DIV_CODE=N&FID_INPUT_ISCD=${encodeURIComponent(code)}&FID_HOUR_CLS_CODE=0&FID_PW_DATA_INCU_YN=N`;
      try {
        const r = await fetch(u, { headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${c.token}`,
          appkey: env("KIS_APP_KEY"), appsecret: env("KIS_APP_SECRET"), tr_id: "FHKST03030200", custtype: "P" } });
        const j = await r.json();
        out.res[code] = { rt_cd: j.rt_cd, msg: j.msg1, output1: j.output1, first: (j.output2 || []).slice(0, 3), count: (j.output2 || []).length };
      } catch (e) { out.res[code] = { error: e.message }; }
      await new Promise(r => setTimeout(r, 120));
    }
  } catch (e) { out.error = e.message; }
  return Response.json(out, { headers: { "cache-control": "no-store" } });
};

export const config = { path: "/api/kis-asia-test" };
