// 야간장 동안 1분마다: 한투 웹소켓에 한 번 접속해 ~22초 동안 실제 체결을 모두 저장 (평일 18:00~05:59 KST)
import { collect } from "../lib/kis-night.mjs";
export default async () => { await collect(); };
export const config = { schedule: "* 9-21 * * 1-5" };
