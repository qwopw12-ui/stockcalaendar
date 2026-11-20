// 롱숏 투표 기록 정리: 매일 04:10(KST) — 투표 대상일로부터 30일 지난 개별 투표·IP해시 키 삭제
// 지우기 전에 그날 결과(롱·숏 인원)를 `sum/<거래일>`에 남겨 둠 (개인 식별값 없음)
import { getStore } from "@netlify/blobs";
const KEEP_DAYS = 30;
export default async () => {
  const s = getStore({ name: "longshort", consistency: "strong" });
  const cut = new Date(Date.now() + 9 * 3600e3 - KEEP_DAYS * 864e5).toISOString().slice(0, 10);
  const old = {}, del = [];
  for await (const page of s.list({ paginate: true })) {
    for (const { key } of page.blobs) {
      if (key.startsWith("sum/")) continue;
      const m = key.match(/^(?:rl\/)?(\d{4}-\d{2}-\d{2})\/(?:(long|short)\/)?/);
      if (!m || m[1] >= cut) continue;
      del.push(key);
      if (m[2]) { old[m[1]] ??= { long: 0, short: 0 }; old[m[1]][m[2]]++; }
    }
  }
  for (const [day, n] of Object.entries(old)) if (!(await s.get(`sum/${day}`))) await s.setJSON(`sum/${day}`, n);
  for (const k of del) await s.delete(k);
  console.log(`vote-clean: cut ${cut}, deleted ${del.length}`);
};
export const config = { schedule: "10 19 * * *" };
