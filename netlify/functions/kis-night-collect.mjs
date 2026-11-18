// 아무도 안 보고 있어도 야간장 동안 2분마다 가격 저장 (평일 18:00~05:59 KST = 월~금 09:00~20:59 UTC)
import { refresh } from "../lib/kis-night.mjs";
export default async () => { await refresh({ force: true }); };
export const config = { schedule: "* 9-21 * * 1-5" };
