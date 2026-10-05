import type { Result } from './contracts';
import type { ClassroomClock, ClassroomProjectionReply } from './classroom';

/** The projection window owns only these three operations. It cannot choose a session or path. */
export interface ClassroomDisplayApi {
  /** 只读绑定课堂的允许字段；版本未变时 view 为 null。不接受其他课堂或文件路径，越权返回 FORBIDDEN，结构无效返回 VALIDATION；可重试。 */
  readProjection(input: { knownRevision?: number }): Promise<Result<ClassroomProjectionReply>>;
  /** 无参数读取绑定课堂的实时计时及倒计时；不改库，可重试，失效绑定/旧工作区返回错误。 */
  readClock(): Promise<Result<ClassroomClock>>;
  /** 仅改变本展示窗口全屏状态，不改课堂进度；同值可重复调用，无取消，未授权窗口返回 FORBIDDEN。 */
  setFullscreen(input: { fullscreen: boolean }): Promise<Result<void>>;
}
