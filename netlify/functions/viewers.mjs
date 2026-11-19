// 실시간 접속자 수 — 구글 애널리틱스(GA4) 실시간 보고서의 '최근 5분 활성 사용자'
// 구글에는 1분에 한 번만 묻고, 그 결과를 CDN 캐시로 모든 방문자가 같이 씀
// 필요한 Netlify 환경변수: GA_PROPERTY_ID(숫자), GA_SA_EMAIL(서비스 계정 이메일), GA_SA_KEY(서비스 계정 private_key)
import { createSign } from 'node:crypto';

const b64u = s => Buffer.from(s).toString('base64url');

async function accessToken(email, key) {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claim = b64u(JSON.stringify({ iss: email, scope: 'https://www.googleapis.com/auth/analytics.readonly',
    aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 }));
  const sig = createSign('RSA-SHA256').update(`${head}.${claim}`).sign(key, 'base64url');
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }) });
  const j = await r.json();
  if (!j.access_token) throw new Error('token: ' + JSON.stringify(j).slice(0, 200));
  return j.access_token;
}

export default async () => {
  let body, ok = false;
  try {
    const pid = process.env.GA_PROPERTY_ID, email = process.env.GA_SA_EMAIL;
    const key = (process.env.GA_SA_KEY || '').replace(/\\n/g, '\n');
    if (!pid || !email || !key) throw new Error('env missing');
    const tok = await accessToken(email, key);
    const r = await fetch(`https://analyticsdata.googleapis.com/v1beta/properties/${pid}:runRealtimeReport`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ metrics: [{ name: 'activeUsers' }], minuteRanges: [{ name: 'last5', startMinutesAgo: 4, endMinutesAgo: 0 }] }) });
    const j = await r.json();
    if (!r.ok) throw new Error('ga: ' + JSON.stringify(j).slice(0, 200));
    const n = Number(j.rows?.[0]?.metricValues?.[0]?.value ?? 0);
    ok = true; body = { ok, n, time: new Date().toISOString() };
  } catch (e) { body = { ok: false, err: String(e.message || e).slice(0, 200) }; }
  return new Response(JSON.stringify(body), { status: ok ? 200 : 502, headers: {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'public, max-age=30',
    'Netlify-CDN-Cache-Control': ok ? 'public, durable, s-maxage=60, stale-while-revalidate=60' : 'public, durable, s-maxage=60' } });
};

export const config = { path: '/api/viewers' };
