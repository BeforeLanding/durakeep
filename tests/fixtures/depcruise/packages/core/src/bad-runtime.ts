// 故意违规：业务包依赖 runtime-pi
import { x } from "../../runtime-pi/src/index.ts";
export const y = x;
