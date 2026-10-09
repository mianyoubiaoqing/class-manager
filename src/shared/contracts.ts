import type { TeachingApi } from './teaching-workbench';
import type { ResourceApi } from './resource-library';
import type {
  deviceStatusInput,
  noiseMeasureInput,
  studentCallInput,
  studentCallReadInput,
  deviceCancelInput,
  DeviceStatuses,
  NoiseResult,
  StudentCallView,
  DeviceCancelReceipt,
} from './devices';
import type {
  ModelSettingsView,
  ModelCheckPreparation,
  ModelCheckReceipt,
  ModelLedgerView,
} from './model-providers';
import type {
  modelConfigurationInput,
  selectModelProviderInput,
  modelKeyInput,
  modelProviderInput,
  modelCheckPreparationInput,
  modelCheckConfirmationInput,
} from './model-providers';
import {
  growthEventSaveInput,
  growthReadInput,
  growthStudentInput,
  growthManualInput,
  growthPrepareInput,
  growthTokenInput,
  growthSummaryEditInput,
  growthSummaryDiscardInput,
  growthConfirmInput,
  type GrowthReceipt,
  type GrowthEventRevision,
  type GrowthTimeline,
  type GrowthPreparation,
  type GrowthSummaryView,
  type GrowthSummary,
  type GrowthConfirmReceipt,
  type GrowthSource,
} from './growth';
import { z } from 'zod';
import type {
  folderScanInput,
  folderReadInput,
  resourceLinkInput,
  FolderInventory,
  FolderReadReceipt,
} from './material-folders';
import {
  conversationFilesInput,
  conversationFileRemoveInput,
  type ConversationFile,
} from './conversation-files';
import {
  type StudentProfile,
  type AttendanceRecord,
  type AttendanceRoster,
  type PupilRevision,
  profileReadInput,
  profileSaveInput,
  attendanceClassInput,
  attendanceReadInput,
  attendanceSaveInput,
} from './pupils';
import type {
  historyEpochInput,
  historyReadInput,
  historySaveInput,
  historyRenameInput,
  historyWriteInput,
  ConversationHistory,
  ConversationHistoryCatalog,
} from './conversation-history';
import type {
  conversationPrepareInput,
  conversationGenerateInput,
  conversationExecuteInput,
  conversationTokenInput,
  conversationSessionInput,
  ConversationTask,
} from './conversation';
import type {
  scorePublicationReadInput,
  scorePublicationConfirmInput,
  ScorePublicationPreview,
  ScorePublicationReceipt,
} from './score-publication';
import type {
  rubricCreateInput,
  rubricReadInput,
  rubricListInput,
  RubricView,
  gradingCreateInput,
  gradingReadInput,
  gradingListInput,
  gradingEditInput,
  gradingRebindInput,
  gradingFreezeInput,
  gradingPrepareInput,
  gradingGenerateInput,
  gradingHistoryInput,
  GradingDraftView,
  GradingReviewView,
  GradingPreparationView,
  GradingReceipt,
  GradingFreezeReceipt,
  GradingAttemptView,
  GradingRevisionView,
} from './grading-records';
import type {
  classroomCreateInput,
  classroomReadInput,
  classroomListInput,
  classroomControlInput,
  countdownInput,
  ClassroomTeacherView,
  ClassroomCatalog,
  ClassroomClock,
  CountdownView,
} from './classroom';
import type { officeExportInput, officeOpenInput, OfficeExportReceipt } from './office-export';
import type {
  materialPreviewInput,
  materialConfirmInput,
  materialPreviewImageInput,
  materialReadInput,
  materialImageReadInput,
  materialListInput,
  MaterialPreview,
  MaterialSummary,
  StoredMaterial,
} from './material-records';
import type {
  lessonPrepareInput,
  lessonCreateInput,
  lessonTokenInput,
  lessonDraftReadInput,
  lessonListInput,
  lessonEditInput,
  lessonDiscardInput,
  lessonFreezeInput,
  lessonVersionReadInput,
  lessonReviseInput,
  LessonReceipt,
  LessonFreezeReceipt,
  LessonPreparationView,
  LessonDraftView,
  LessonVersionView,
  LessonDraftSummary,
  LessonVersionRecord,
} from './lesson-records';
import type {
  dutyPrepareInput,
  dutyAdjustInput,
  dutyTokenInput,
  dutyConfirmInput,
  dutyHistoryInput,
  dutyReadInput,
  dutyListInput,
  DutyPreparation,
  DutyConfirmation,
  DutyVersion,
  DutyVersionView,
  DutyPlanSummary,
} from './duty-records';
import type {
  scoreConfirmInput,
  scoreCancelInput,
  scoreFileInput,
  scoreHistoryInput,
  scoreListInput,
  scoreReadInput,
  scoreTemplateInput,
  studentScoreHistoryInput,
  ExamSummary,
  SelectedScorePreview,
  ScoreConfirmation,
  ScoreVersionView,
  StudentScoreHistory,
} from './score-commands';
import type { StoredScoreVersion } from './score-records';
import type {
  seatingPrepareInput,
  seatingAdjustInput,
  seatingTokenInput,
  seatingConfirmInput,
  seatingHistoryInput,
  seatingReadInput,
  SeatingPreparation,
  SeatingConfirmation,
  SeatingVersion,
  SeatingVersionView,
  SeatingPrintReceipt,
} from './seating-records';
import type {
  explanationPrepareInput,
  explanationTokenInput,
  explanationReadInput,
  explanationListInput,
  explanationEditInput,
  explanationDiscardInput,
  ExplanationPreparation,
  ExplanationDraftReceipt,
  ExplanationDraftView,
  ExplanationDraftSummary,
} from './explanation-drafts';

const id = z.uuid();
const text = (max: number) =>
  z
    .string()
    .trim()
    .min(1)
    .max(max)
    // eslint-disable-next-line no-control-regex -- User-visible names must reject embedded control characters.
    .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), '不能包含控制字符');
const revision = z.number().int().positive();
export const epochInput = z.object({ epoch: id }).strict();
export const createClassInput = epochInput.extend({ name: text(80) });
export const renameClassInput = createClassInput.extend({ id, expectedRevision: revision });
export const studentInput = epochInput
  .extend({
    id: id.optional(),
    expectedRevision: revision.optional(),
    classId: id,
    studentNumber: z
      .string()
      .trim()
      .toUpperCase()
      .regex(/^[A-Z0-9_-]{1,32}$/),
    displayName: text(60),
  })
  .refine((value) => Boolean(value.id) === Boolean(value.expectedRevision), '编辑需要版本号');
export const activationInput = epochInput.extend({
  id,
  expectedRevision: revision,
  active: z.boolean(),
});
export const restoreInput = epochInput.extend({ token: id });

export const saveDeepSeekKeyInput = z
  .object({
    apiKey: z.string().trim().min(5).max(200),
  })
  .strict();

export const checkDeepSeekInput = z
  .object({
    type: z.enum(['text', 'vision']),
  })
  .strict();

export const classroomSchema = z
  .object({
    id,
    name: text(80),
    revision,
    createdAt: z.iso.datetime(),
  })
  .strict();
export const studentSchema = z
  .object({
    id,
    studentNumber: z.string(),
    displayName: text(60),
    active: z.boolean(),
    revision,
    createdAt: z.iso.datetime(),
    classId: id,
    className: z.string(),
  })
  .strict();
export const enrollmentSchema = z
  .object({
    id,
    studentId: id,
    classId: id,
    validFrom: z.iso.datetime(),
    validTo: z.iso.datetime().nullable(),
  })
  .strict();
export const assetSchema = z
  .object({
    id,
    name: text(120),
    bytes: z.number().int().nonnegative(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

export type Classroom = z.infer<typeof classroomSchema>;
export type Student = z.infer<typeof studentSchema>;
export type Enrollment = z.infer<typeof enrollmentSchema>;
export type Asset = z.infer<typeof assetSchema>;
export type StudentInput = z.infer<typeof studentInput>;
export interface Snapshot {
  epoch: string;
  classes: Classroom[];
  students: Student[];
  enrollments: Enrollment[];
  assets: Asset[];
  schemaVersion: number;
  dataDirectory: string;
  recoveryCopies: number;
}
export interface RestorePreview {
  token: string;
  createdAt: string;
  classCount: number;
  studentCount: number;
  assetCount: number;
  examCount: number;
  scoreVersionCount: number;
  explanationDraftCount: number;
  seatingVersionCount: number;
  dutyVersionCount: number;
  materialVersionCount: number;
  lessonDraftCount: number;
  lessonVersionCount: number;
  teachingSessionCount: number;
  countdownCount: number;
  rubricVersionCount: number;
  gradingDraftCount: number;
  gradingReviewCount: number;
  gradingAttemptCount: number;
  gradingRevisionCount: number;
  gradingPublicationCount: number;
  growthEventCount: number;
  growthSummaryCount: number;
  growthEntryCount: number;
  attendanceCount: number;
  studentProfileCount: number;
}
export interface Receipt {
  path: string;
  createdAt: string;
}
export interface PublicError {
  code: string;
  message: string;
  operationId: string;
}
export type Result<T> = { ok: true; value: T } | { ok: false; error: PublicError };
export interface DeepSeekCredentialStatus {
  configured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
}

export interface DeepSeekTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface DeepSeekCheckResult {
  type: 'text' | 'vision';
  success: boolean;
  responseId?: string;
  model: string;
  durationMs: number;
  usage: DeepSeekTokenUsage | null;
  message: string;
  timestamp: string;
  promptVersion: string;
  credentialUpdatedAt?: string | null;
}

export interface DeepSeekCallRecord {
  id: string;
  responseId?: string;
  timestamp: string;
  type:
    | 'text_check'
    | 'vision_check'
    | 'score_explanation'
    | 'lesson_drafting'
    | 'grading'
    | 'growth_summary';
  requestModel: string;
  responseModel?: string;
  status: 'success' | 'failed' | 'interrupted' | 'in_progress';
  errorCode?: string;
  durationMs: number;
  usage?: DeepSeekTokenUsage;
  promptVersion: string;
  growthInput?: { source: GrowthSource; inputHash: string };
}

export interface DeepSeekLedgerSummary {
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  recentEntries: DeepSeekCallRecord[];
}

export interface DesktopApi extends TeachingApi, ResourceApi {
  readStudentProfile(input: z.input<typeof profileReadInput>): Promise<Result<StudentProfile>>;
  saveStudentProfile(
    input: z.input<typeof profileSaveInput>,
  ): Promise<Result<{ id: string; revision: number; replayed: boolean }>>;
  studentProfileHistory(
    input: z.input<typeof profileReadInput>,
  ): Promise<Result<PupilRevision<StudentProfile>[]>>;
  readAttendanceRoster(
    input: z.input<typeof attendanceClassInput>,
  ): Promise<Result<AttendanceRoster>>;
  listAttendance(input: z.input<typeof attendanceClassInput>): Promise<Result<AttendanceRecord[]>>;
  readAttendance(input: z.input<typeof attendanceReadInput>): Promise<Result<AttendanceRecord>>;
  attendanceHistory(
    input: z.input<typeof attendanceReadInput>,
  ): Promise<Result<PupilRevision<AttendanceRecord>[]>>;
  saveAttendance(
    input: z.input<typeof attendanceSaveInput>,
  ): Promise<Result<{ id: string; revision: number; replayed: boolean }>>;
  /** Waits for teacher-visible history to be saved before the main window closes. */
  onConversationHistoryClose(listener: () => Promise<boolean>): () => void;
  /** Teacher-visible transcripts encrypted locally; never includes pending tokens or raw model/tool history. */
  listConversationHistory(
    input: z.input<typeof historyEpochInput>,
  ): Promise<Result<ConversationHistoryCatalog>>;
  createConversationHistory(
    input: z.input<typeof historyEpochInput>,
  ): Promise<Result<ConversationHistory>>;
  readConversationHistory(
    input: z.input<typeof historyReadInput>,
  ): Promise<Result<ConversationHistory>>;
  saveConversationHistory(
    input: z.input<typeof historySaveInput>,
  ): Promise<Result<ConversationHistory>>;
  renameConversationHistory(
    input: z.input<typeof historyRenameInput>,
  ): Promise<Result<ConversationHistory>>;
  deleteConversationHistory(input: z.input<typeof historyWriteInput>): Promise<Result<void>>;
  /** 当前epoch/config及最多2000字输入准备10分钟请求，不联网/不读Key。
   * sessionId启用多轮脱敏上下文；缺省保留旧单提议模式。未配置/来源无效/BUSY拒绝，最多20任务，重开失效。 */
  prepareConversation(
    input: z.input<typeof conversationPrepareInput>,
  ): Promise<Result<ConversationTask>>;
  /** 原生对话框选择并本地提取附件；只回传描述，不返回路径或正文。发送时才外发。 */
  selectConversationFiles(
    input: z.input<typeof conversationFilesInput>,
  ): Promise<Result<ConversationFile[]>>;
  removeConversationFiles(
    input: z.input<typeof conversationFileRemoveInput>,
  ): Promise<Result<void>>;
  /** 原token/hash确认发送；session模式每轮最多16次模型往返，自动调用只读工具并回传脱敏结果。
   * 写入停在待确认；旧单提议模式仍一次调用。参数及尚未执行工具的传输格式错误最多纠正5次，可能计费；取消不重发，成功重复回放。 */
  generateConversation(
    input: z.input<typeof conversationGenerateInput>,
  ): Promise<Result<ConversationTask>>;
  /** 明确核对对象与确切动作hash后只执行Main持有的具名提议；原epoch/来源/CAS校验，不绕过原审核。
   * 事务开始后不可取消；成功重复仅回放原回执，回包不明不得重放，先查任务及原业务。配置变化/过期拒绝。 */
  executeConversation(
    input: z.input<typeof conversationExecuteInput>,
  ): Promise<Result<ConversationTask>>;
  /** 当前epoch会话token只读准备/来源/提议/执行状态，不重发或重写，可重复读取；重开/淘汰/恢复后拒绝。
   * 会话正文不入备份或诊断，正式结果在原业务持久记录中核对。 */
  readConversation(
    input: z.input<typeof conversationTokenInput>,
  ): Promise<Result<ConversationTask>>;
  /** 取消原token准备、提议和网络；完成不回滚，提交开始BUSY，取消可能仍计费。不再外发，重复取消安全。 */
  cancelConversation(
    input: z.input<typeof conversationTokenInput>,
  ): Promise<Result<ConversationTask>>;
  /** 清除当前epoch会话上下文/代号和任务，不撤销已写业务。活动任务需先停止；
   * 旧epoch/在途任务拒绝，无网络/费用，可重复，正文不写入日志或备份。 */
  clearConversationSession(input: z.input<typeof conversationSessionInput>): Promise<Result<void>>;
  /** 无输入，只读3家配置及脱敏Key状态，能力未验证时明确标记；不联网/取消任务，可重复读取。
   * 返回设置快照；凭据状态文件不可读会显示未配置，不把读失败冒充调用权限已通过。 */
  readModelSettings(): Promise<Result<ModelSettingsView>>;
  /** provider/预期UUID版本/1–160字符文本型号/图像型号或空串；Kimi只支持K2.6/K3，返回新设置。
   * 无联网，先取消旧任务/准备再保存；BUSY/CONFLICT/不支持型号/磁盘失败拒绝，失败前旧任务仍可能已取消。
   * 历史及用量保留，取消不保证停止收费；同旧revision重复保存冲突，刷新后才显式再次保存。 */
  configureModelProvider(
    input: z.input<typeof modelConfigurationInput>,
  ): Promise<Result<ModelSettingsView>>;
  /** provider/预期UUID版本切换并返回新设置；缺配置允许选中但调用拒绝，不自动回退或联网。
   * 先取消旧任务/准备再保存，BUSY/CONFLICT/磁盘失败拒绝；取消不能保证停止计费。
   * 旧revision不可重复消费，回包不明先读取设置和原供应商用量，不自动重试。 */
  selectModelProvider(
    input: z.input<typeof selectModelProviderInput>,
  ): Promise<Result<ModelSettingsView>>;
  /** provider/5–200字符Key仅本地加密保存，返回脱敏新设置；先取消旧准备/任务，不联网或自动检查。
   * BUSY/加密不可用/磁盘失败拒绝，部分本地写入可能已完成，回包不明读取状态；重复保存产生新revision。
   * 取消不能保证停止旧调用计费，不记录或返回完整Key；不得自动重发模型请求。 */
  saveModelProviderKey(input: z.input<typeof modelKeyInput>): Promise<Result<ModelSettingsView>>;
  /** provider删除指定Key并返回新设置；无网络，先取消旧任务/准备，历史和用量保留。
   * 重复删除安全并更新revision；BUSY/磁盘失败拒绝，回包不明先读取状态，取消不证明原调用未收费。 */
  deleteModelProviderKey(
    input: z.input<typeof modelProviderInput>,
  ): Promise<Result<ModelSettingsView>>;
  /** text/vision及当前revision准备固定合成检查，返回确切JSON/endpoint/token/hash；不联网或读取Key。
   * 新准备先撤销旧token；BUSY/CONFLICT/缺型号/图像禁用拒绝，失败也不得复用先前准备。
   * 可取消；重复准备生成新token，检查前必须重新核对并明确确认，无自动重试。 */
  prepareModelCheck(
    input: z.input<typeof modelCheckPreparationInput>,
  ): Promise<Result<ModelCheckPreparation>>;
  /** 原token/revision/hash与true确认后返回一次检查回执；token在读Key/外发前消费，失败不可重复使用。
   * BUSY/CONFLICT/缺Key/认证/网络/非法返回/响应上限/取消拒绝；30秒结束等待，超时仍可能已收费。
   * 支持取消，不自动重试或回退；回包不明核对原供应商用量，未知Token不冒充0，再显式重新准备。 */
  checkModelProvider(
    input: z.input<typeof modelCheckConfirmationInput>,
  ): Promise<Result<ModelCheckReceipt>>;
  /** 无输入，可重复清除检查准备并请求取消在途检查，返回void仅表示取消请求已接收。
   * 不联网/重试，原用量保留；不代表任务已完成、没收费或没发送，先等待结果并核对原供应商用量。 */
  cancelModelCheck(): Promise<Result<void>>;
  /** provider只读其独立账本快照，可重复读取；非法供应商/损坏文件/读取失败拒绝并保留原文件。
   * 无网络/任务取消/付费，未知Token不冒充0，不查询余额或计算假定费用。 */
  readModelLedger(input: z.input<typeof modelProviderInput>): Promise<Result<ModelLedgerView>>;
  /** 当前epoch只读两类外设未接入/就绪/故障状态；默认无采集或网络，无付费。
   * 旧epoch/忙/超时/非法返回拒绝，可重试；退出/恢复取消读取，测试状态不在发布环境冒充现场。 */
  readDeviceStatus(input: z.input<typeof deviceStatusInput>): Promise<Result<DeviceStatuses>>;
  /** 当前epoch/operationId/用途/100–5000ms请求一次测量；未接入返回unavailable且无数值。
   * 同ID/同内容会话内去重，冲突/旧epoch/非法量纲/超时拒绝，无自动重试或付费；可取消。
   * 相对幅度不能称为声压级或纪律判断，db_spl必须携带校准说明。 */
  measureNoise(input: z.input<typeof noiseMeasureInput>): Promise<Result<NoiseResult>>;
  /** 当前epoch/学生revision/操作ID/原因及合成和教师确认后请求呼叫；默认未接入不可执行。
   * 同ID/同内容去重，改目标或正文冲突；Adapter负责未来持久幂等。受理不等于送达，取消/超时结果不明先查询。
   * 校验/旧来源/忙/故障拒绝；无模型付费或自动重试，回包不明不得用新ID自动重发。 */
  requestStudentCall(input: z.input<typeof studentCallInput>): Promise<Result<StudentCallView>>;
  /** 当前epoch/操作ID查询原呼叫的确切目标和回执；Adapter可恢复未来通道持久结果。
   * 返回null仅表示没查到，不证明未发送；旧epoch/忙/非法回执/超时拒绝，可重试，无发送或付费。 */
  readStudentCall(
    input: z.input<typeof studentCallReadInput>,
  ): Promise<Result<StudentCallView | null>>;
  /** 当前epoch/操作ID/kind请求取消采样或呼叫；请求取消不等于实际撤销/未送达，须查询原呼叫。
   * 可重复，已结束保留原结果；旧epoch/忙/通道故障拒绝，无付费或自动重试。 */
  cancelDeviceTask(input: z.input<typeof deviceCancelInput>): Promise<Result<DeviceCancelReceipt>>;
  /** 当前 epoch/学生及完整事件内容保存不可变修订；更正需原ID/expectedRevision和说明。
   * requestId/相同内容幂等，冲突/旧epoch/停用学生/校验失败拒绝；本地无付费、取消或自动重试，回执不明先查时间线/修订。 */
  saveGrowthEvent(input: z.input<typeof growthEventSaveInput>): Promise<Result<GrowthReceipt>>;
  /** 按当前epoch/事件ID只读全部修订及更正说明；旧epoch/不存在拒绝，可重试，无付费或取消。 */
  growthEventHistory(
    input: z.input<typeof growthReadInput>,
  ): Promise<Result<GrowthEventRevision[]>>;
  /** 当前epoch/学生读取事件、草稿和正式条目及来源过期标志；历史正文保留。
   * 旧epoch/不存在拒绝；只读可重试，无付费或取消，也可查询回包不明的保存结果。 */
  growthTimeline(input: z.input<typeof growthStudentInput>): Promise<Result<GrowthTimeline>>;
  /** 明确合成/脱敏确认、阶段及确切来源建立独立人工草稿；正式更正可指定被接续条目。
   * requestId/同内容幂等；无事实/旧版本/更正冲突/校验失败拒绝，本地无付费、取消或自动重试，回执不明先查时间线。 */
  createGrowthSummary(input: z.input<typeof growthManualInput>): Promise<Result<GrowthReceipt>>;
  /** 核对当前epoch/阶段/学生及确切来源，返回实际外发事实和15分钟令牌；新准备作废旧令牌。
   * 无事实/旧来源/忙/未确认脱敏拒绝；不请求模型、不写草稿，可取消，失败不恢复旧授权。 */
  prepareGrowthSummary(
    input: z.input<typeof growthPrepareInput>,
  ): Promise<Result<GrowthPreparation>>;
  /** 明确确认准备令牌后，仅一次可能付费请求；认领2分钟内将合法返回保存为未复核草稿。
   * 过期/重复/来源变化/无凭据/网络或输出失败拒绝，无自动重试；取消先于提交准入则晚到不存，提交先赢则查询保留草稿。
   * 回包不明先刷新时间线，勿再次付费生成；本入口不创建正式条目。 */
  generateGrowthSummary(input: z.input<typeof growthTokenInput>): Promise<Result<GrowthReceipt>>;
  /** 当前epoch作废准备/认领并请求取消网络；提交准入已赢则不撤销草稿，需刷新查询。
   * 无付费，可重复；旧epoch/存储失败拒绝，失败不能当作已取消，晚到回复按准入次序处理。 */
  cancelGrowthSummary(input: z.input<typeof epochInput>): Promise<Result<void>>;
  /** 当前epoch/草稿ID只读来源、过期标记和正式entryId；回执不明以此查询，不另行生成。
   * 旧epoch/不存在拒绝，只读可重试，无付费或取消。 */
  readGrowthSummary(input: z.input<typeof growthReadInput>): Promise<Result<GrowthSummaryView>>;
  /** 当前epoch/草稿ID/expectedRevision保存教师复核正文并新增修订；不自动入档。
   * 冲突/非草稿/校验失败拒绝，本地无付费、取消或自动重试，回执不明先查修订。 */
  editGrowthSummary(input: z.input<typeof growthSummaryEditInput>): Promise<Result<GrowthReceipt>>;
  /** 当前epoch/草稿ID/expectedRevision标记放弃，保留历史；重复放弃拒绝，先读取原状态。
   * 冲突/已入档/旧epoch拒绝，本地无付费、取消或自动重试，回执不明先查原草稿。 */
  discardGrowthSummary(
    input: z.input<typeof growthSummaryDiscardInput>,
  ): Promise<Result<GrowthReceipt>>;
  /** 已保存教师复核、说明及两项明确确认后，按当前epoch/ID/expectedRevision事务创建正式条目。
   * 草稿ID为幂等键；重复确认返回同entryId。旧来源/未复核/冲突拒绝，无付费、取消或自动重试，回执不明先查询。
   * 更正创建新条目并接续原条目，原事实和正文不被改写。 */
  confirmGrowthSummary(
    input: z.input<typeof growthConfirmInput>,
  ): Promise<Result<GrowthConfirmReceipt>>;
  /** 当前epoch/草稿ID只读全部不可变修订；旧epoch/不存在拒绝，可重试，无付费或取消。 */
  growthSummaryHistory(input: z.input<typeof growthReadInput>): Promise<Result<GrowthSummary[]>>;
  /** 当前 epoch/冻结复核 ID 创建15分钟入分差异预览，后台重建分数；无网络、无写分。
   * 来源过期/不完整拒绝，重新预览使旧令牌失效；已发布返回原回执。 */
  prepareScorePublication(
    input: z.input<typeof scorePublicationReadInput>,
  ): Promise<Result<ScorePublicationPreview>>;
  /** 明确确认预览令牌/成绩父版/替换和原因，同事务新增成绩及发布凭据；只以复核ID幂等。
   * 旧epoch/过期/冲突/未确认拒绝，无网络、取消或自动重试；回执不明先查询发布事实。 */
  confirmScorePublication(
    input: z.input<typeof scorePublicationConfirmInput>,
  ): Promise<Result<ScorePublicationReceipt>>;
  /** 只读查询复核的持久发布事实，返回原成绩版本或null；旧epoch/不存在拒绝，可重试，无网络。 */
  readScorePublication(
    input: z.input<typeof scorePublicationReadInput>,
  ): Promise<Result<ScorePublicationReceipt | null>>;
  /** 当前 epoch/id/pageId 读取后台实际遮盖裁剪旋转后的单页 JPEG，可指定确切 revision 只读历史依据。
   * 不付费、不改草案；cancelGrading 可取消，忙/无页面/处理失败拒绝，无自动重试。 */
  previewGradingPage(
    input: z.input<typeof import('./grading-records').gradingPagePreviewInput>,
  ): Promise<Result<import('./grading-records').GradingPagePreview>>;
  /** 校验当前考试/科目满分与完整细则，保存不可变版本并返回编号；同 requestId/内容可重放。
   * 旧 epoch、过期来源、冲突或超限拒绝；无网络、取消或自动重试，回执不明先列出版本核对。 */
  createRubric(
    input: z.input<typeof rubricCreateInput>,
  ): Promise<Result<import('./grading-records').RubricReceipt>>;
  /** 按当前 epoch/id 读取完整细则；只读可重试，无网络或取消。旧 epoch/不存在拒绝。 */
  readRubric(input: z.input<typeof rubricReadInput>): Promise<Result<RubricView>>;
  /** 按考试/科目分页读取细则版本（每页最多 50）；只读可重试，无网络或取消，旧 epoch 拒绝。 */
  listRubrics(
    input: z.input<typeof rubricListInput>,
  ): Promise<Result<import('./grading-records').RubricRecord[]>>;
  /** 明确合成答卷归属、角色、页序、细则和完整性后保存草案；旧复核可新建修订草案。
   * 同 requestId/内容幂等；来源失效、结构冲突、超限拒绝。不入分，无网络/取消/自动重试。 */
  createGrading(input: z.input<typeof gradingCreateInput>): Promise<Result<GradingReceipt>>;
  /** 读取草案及来源过期提示；当前 epoch/id，只读可重试，无网络/取消，不存在拒绝。 */
  readGrading(input: z.input<typeof gradingReadInput>): Promise<Result<GradingDraftView>>;
  /** 读取不可变冻结复核和当前来源状态；只读可重试，无网络/取消，旧 epoch/不存在拒绝。 */
  readGradingReview(input: z.input<typeof gradingReadInput>): Promise<Result<GradingReviewView>>;
  /** 按考试分页读取草案目录，可包含冻结版；每页最多 50，只读可重试，旧 epoch 拒绝。 */
  listGradings(
    input: z.input<typeof gradingListInput>,
  ): Promise<Result<import('./grading-records').GradingSummary[]>>;
  /** 用 expectedRevision 保存具名人工作答、分数和非空证据，须明确逐题复核；精确失回包可重放。
   * 冻结/生成中/来源过期/版本冲突拒绝；不入分，无网络/取消/自动重试，回执不明先重读。 */
  editGrading(input: z.input<typeof gradingEditInput>): Promise<Result<GradingReceipt>>;
  /** 同一考试学生科目显式重绑当前来源；来源指纹变化清除整份审核和建议，旧冻结版保持。
   * 版本/归属/当前来源冲突拒绝，精确重放幂等；无网络/取消/自动重试，失回包先重读。 */
  rebindGrading(input: z.input<typeof gradingRebindInput>): Promise<Result<GradingReceipt>>;
  /** 当前来源、页数和所有题目完整合法且教师明确确认才冻结；不写正式成绩。
   * 同 requestId/内容幂等，版本/来源/未决/未复核拒绝；无网络/取消/自动重试，失回包先查历史。 */
  freezeGrading(input: z.input<typeof gradingFreezeInput>): Promise<Result<GradingFreezeReceipt>>;
  /** 当前 epoch/id 读取至多 20 条尝试、输出和用量；只读可重试，不发请求，旧 epoch/不存在拒绝。 */
  gradingAttempts(input: z.input<typeof gradingReadInput>): Promise<Result<GradingAttemptView[]>>;
  /** 当前 epoch/id 分页读取不可变修订快照（每页最多 50），可限定确切 revision；只读可重试，无网络/取消，不存在拒绝。 */
  gradingHistory(
    input: z.input<typeof gradingHistoryInput>,
  ): Promise<Result<GradingRevisionView[]>>;
  /** 当前 revision 及明确选题/选页，替换已审核题须确认；返回实际遮盖/裁剪/旋转 JPEG 和请求指纹。
   * 不付费、不写尝试；准备可取消，忙/超限/来源失效拒绝。重准备撤销旧令牌，15 分钟或来源/
   * revision/epoch/凭据变化后失效；无自动重试，须重新核对返回的实际外发范围。 */
  prepareGrading(
    input: z.input<typeof gradingPrepareInput>,
  ): Promise<Result<GradingPreparationView>>;
  /** 只能确认 Main 持有令牌、完整 wireHash 和实际外发预览；一次认领后消耗令牌并可能计费。
   * 单次调用无自动重试；重复/忙/来源变化拒绝，输出严格校验后仅保存所选题目建议，不自动复核。
   * 失败/取消保留草案并记录尝试；提交已获准后取消不能撤回。回执不明先重读草案及尝试，不盲重试。 */
  generateGrading(input: z.input<typeof gradingGenerateInput>): Promise<Result<GradingReceipt>>;
  /** 仅当前 epoch 取消准备/令牌/生成；中止网络并拒绝未获准提交的迟到结果，可能仍有费用。
   * 同 epoch 可重复，不删进度、不撤销已提交建议、不启动请求；旧 epoch 拒绝，返回后可查尝试核对。 */
  cancelGrading(input: z.input<typeof epochInput>): Promise<Result<void>>;
  /** 明确确认班级和冻结版范围后创建暂停课堂。相同 requestId/内容可安全重试；不同内容返回 CONFLICT。恢复后的旧 epoch 返回 STALE_WORKSPACE。 */
  createClassroom(
    input: z.input<typeof classroomCreateInput>,
  ): Promise<Result<ClassroomTeacherView>>;
  /** 读取固定版本进度及实时环节计时；不改库，可重试。不存在返回 NOT_FOUND，旧 epoch 返回 STALE_WORKSPACE。 */
  readClassroom(input: z.input<typeof classroomReadInput>): Promise<Result<ClassroomTeacherView>>;
  /** 分批读取课堂目录（最多 100 条）；不改库，可重试。旧 epoch 返回 STALE_WORKSPACE。 */
  listClassrooms(input: z.input<typeof classroomListInput>): Promise<Result<ClassroomCatalog>>;
  /** 以 expectedRevision 校验并保存控制动作；换页隐藏问题/答案，跨环节暂停并重置计时。过期/已结束返回 CONFLICT，另课计时返回 BUSY；无取消或自动重试，回执不明时先重读。 */
  controlClassroom(
    input: z.input<typeof classroomControlInput>,
  ): Promise<Result<ClassroomTeacherView>>;
  /** 读取单调计时、保存失败状态和目标时区日历倒计时；只读可重试，旧 epoch 返回 STALE_WORKSPACE。 */
  readClassroomClock(input: z.input<typeof classroomReadInput>): Promise<Result<ClassroomClock>>;
  /** 读取倒计时，未设置返回 null；只读可重试，旧 epoch 返回 STALE_WORKSPACE。 */
  readCountdown(input: z.input<typeof epochInput>): Promise<Result<CountdownView | null>>;
  /** 校验日期及时区并按 expectedRevision 保存；过期返回 CONFLICT，旧 epoch 返回 STALE_WORKSPACE。无取消/自动重试，回执不明时先重读。 */
  setCountdown(input: z.input<typeof countdownInput>): Promise<Result<CountdownView>>;
  /** 绑定已确认课堂并替换当前展示窗；先持久隐藏此前问题/答案，可能推进 revision。失败后需重读进度再控制，无取消/自动重试；旧 epoch 返回 STALE_WORKSPACE。 */
  openClassroomDisplay(input: z.input<typeof classroomReadInput>): Promise<Result<void>>;
  /** 关闭当前展示窗，保留课堂与计时状态；同 epoch 可重复调用，无取消。旧 epoch 返回 STALE_WORKSPACE。 */
  closeClassroomDisplay(input: z.input<typeof epochInput>): Promise<Result<void>>;
  exportLessonOffice(
    input: z.input<typeof officeExportInput>,
  ): Promise<Result<OfficeExportReceipt | null>>;
  cancelLessonOffice(input: z.input<typeof epochInput>): Promise<Result<void>>;
  openLessonOffice(input: z.input<typeof officeOpenInput>): Promise<Result<void>>;
  previewMaterial(
    input: z.input<typeof materialPreviewInput>,
  ): Promise<Result<MaterialPreview | null>>;
  scanMaterialFolder(
    input: z.input<typeof folderScanInput>,
  ): Promise<Result<FolderInventory | null>>;
  readMaterialFolder(input: z.input<typeof folderReadInput>): Promise<Result<FolderReadReceipt>>;
  cancelMaterialFolder(input: z.input<typeof materialPreviewInput>): Promise<Result<void>>;
  openResourceLink(input: z.input<typeof resourceLinkInput>): Promise<Result<void>>;
  confirmMaterial(
    input: z.input<typeof materialConfirmInput>,
  ): Promise<Result<{ id: string; replayed: boolean }>>;
  cancelMaterial(input: z.input<typeof materialPreviewInput>): Promise<Result<void>>;
  readMaterialPreviewImage(
    input: z.input<typeof materialPreviewImageInput>,
  ): Promise<Result<string>>;
  readMaterial(input: z.input<typeof materialReadInput>): Promise<Result<StoredMaterial>>;
  listMaterials(input: z.input<typeof materialListInput>): Promise<Result<MaterialSummary[]>>;
  readMaterialImage(input: z.input<typeof materialImageReadInput>): Promise<Result<string>>;
  saveMaterialOriginal(input: z.input<typeof materialReadInput>): Promise<Result<Receipt | null>>;
  prepareLesson(input: z.input<typeof lessonPrepareInput>): Promise<Result<LessonPreparationView>>;
  createLessonDraft(input: z.input<typeof lessonCreateInput>): Promise<Result<LessonReceipt>>;
  generateLesson(input: z.input<typeof lessonTokenInput>): Promise<Result<LessonReceipt>>;
  cancelLesson(input: z.input<typeof epochInput>): Promise<Result<void>>;
  readLessonDraft(input: z.input<typeof lessonDraftReadInput>): Promise<Result<LessonDraftView>>;
  listLessonDrafts(input: z.input<typeof lessonListInput>): Promise<Result<LessonDraftSummary[]>>;
  editLessonDraft(input: z.input<typeof lessonEditInput>): Promise<Result<LessonReceipt>>;
  discardLessonDraft(input: z.input<typeof lessonDiscardInput>): Promise<Result<LessonReceipt>>;
  freezeLessonDraft(input: z.input<typeof lessonFreezeInput>): Promise<Result<LessonFreezeReceipt>>;
  readLessonVersion(
    input: z.input<typeof lessonVersionReadInput>,
  ): Promise<Result<LessonVersionView>>;
  lessonHistory(
    input: z.input<typeof lessonDraftReadInput>,
  ): Promise<Result<LessonVersionRecord[]>>;
  reviseLessonVersion(input: z.input<typeof lessonReviseInput>): Promise<Result<LessonReceipt>>;
  prepareDuty(input: z.input<typeof dutyPrepareInput>): Promise<Result<DutyPreparation>>;
  readDutyDraft(input: z.input<typeof dutyTokenInput>): Promise<Result<DutyPreparation>>;
  adjustDuty(input: z.input<typeof dutyAdjustInput>): Promise<Result<DutyPreparation>>;
  cancelDuty(input: z.input<typeof dutyTokenInput>): Promise<Result<void>>;
  confirmDuty(input: z.input<typeof dutyConfirmInput>): Promise<Result<DutyConfirmation>>;
  dutyHistory(input: z.input<typeof dutyHistoryInput>): Promise<Result<DutyVersion[]>>;
  readDutyVersion(input: z.input<typeof dutyReadInput>): Promise<Result<DutyVersionView>>;
  listDutyPlans(input: z.input<typeof dutyListInput>): Promise<Result<DutyPlanSummary[]>>;
  previewDutyPrint(
    input: Parameters<DesktopApi['readDutyVersion']>[0],
  ): Promise<Result<import('./printing').PrintReceipt>>;
  previewSeatingPrint(
    input: z.input<typeof seatingReadInput>,
  ): Promise<Result<SeatingPrintReceipt>>;
  prepareSeating(input: z.input<typeof seatingPrepareInput>): Promise<Result<SeatingPreparation>>;
  readSeatingDraft(input: z.input<typeof seatingTokenInput>): Promise<Result<SeatingPreparation>>;
  adjustSeating(input: z.input<typeof seatingAdjustInput>): Promise<Result<SeatingPreparation>>;
  cancelSeating(input: z.input<typeof seatingTokenInput>): Promise<Result<void>>;
  confirmSeating(input: z.input<typeof seatingConfirmInput>): Promise<Result<SeatingConfirmation>>;
  seatingHistory(input: z.input<typeof seatingHistoryInput>): Promise<Result<SeatingVersion[]>>;
  readSeatingVersion(input: z.input<typeof seatingReadInput>): Promise<Result<SeatingVersionView>>;
  prepareExplanation(
    input: z.input<typeof explanationPrepareInput>,
  ): Promise<Result<ExplanationPreparation>>;
  generateExplanation(
    input: z.input<typeof explanationTokenInput>,
  ): Promise<Result<ExplanationDraftReceipt>>;
  cancelExplanation(input: z.input<typeof epochInput>): Promise<Result<void>>;
  readExplanation(
    input: z.input<typeof explanationReadInput>,
  ): Promise<Result<ExplanationDraftView>>;
  listExplanations(
    input: z.input<typeof explanationListInput>,
  ): Promise<Result<ExplanationDraftSummary[]>>;
  editExplanation(
    input: z.input<typeof explanationEditInput>,
  ): Promise<Result<ExplanationDraftReceipt>>;
  discardExplanation(
    input: z.input<typeof explanationDiscardInput>,
  ): Promise<Result<ExplanationDraftReceipt>>;
  snapshot(): Promise<Result<Snapshot>>;
  selectClassData(input: {
    epoch: string;
    classId: string;
  }): Promise<Result<import('./class-data-import').ClassDataPreview | null>>;
  configureClassData(
    input: import('./class-data-import').ClassDataConfiguration,
  ): Promise<Result<import('./class-data-import').ClassDataPreview>>;
  confirmClassData(input: {
    epoch: string;
    token: string;
  }): Promise<Result<import('./class-data-import').ClassDataReceipt>>;
  cancelClassData(input: { epoch: string; classId: string }): Promise<Result<void>>;
  createClass(input: z.infer<typeof createClassInput>): Promise<Result<Snapshot>>;
  renameClass(input: z.infer<typeof renameClassInput>): Promise<Result<Snapshot>>;
  saveStudent(input: StudentInput): Promise<Result<Snapshot>>;
  previewRosterImport(input: {
    epoch: string;
    classId: string;
  }): Promise<Result<import('./roster-import').RosterImportPreview | null>>;
  confirmRosterImport(input: {
    epoch: string;
    token: string;
  }): Promise<Result<{ snapshot: Snapshot; added: number; skipped: number; replayed: boolean }>>;
  exportRosterTemplate(input: {
    epoch: string;
    format: 'xlsx' | 'csv';
  }): Promise<Result<Receipt | null>>;
  setStudentActive(input: z.infer<typeof activationInput>): Promise<Result<Snapshot>>;
  seedDemo(input: z.infer<typeof epochInput>): Promise<Result<Snapshot>>;
  addSyntheticAsset(input: z.infer<typeof epochInput>): Promise<Result<Snapshot>>;
  saveBackup(input: z.infer<typeof epochInput>): Promise<Result<Receipt | null>>;
  previewRestore(): Promise<Result<RestorePreview | null>>;
  previewRecovery(): Promise<Result<RestorePreview>>;
  commitRestore(input: z.infer<typeof restoreInput>): Promise<Result<Snapshot>>;
  exportDiagnostics(): Promise<Result<Receipt | null>>;
  getDeepSeekStatus(): Promise<Result<DeepSeekCredentialStatus>>;
  saveDeepSeekKey(
    input: z.infer<typeof saveDeepSeekKeyInput>,
  ): Promise<Result<DeepSeekCredentialStatus>>;
  deleteDeepSeekKey(): Promise<Result<boolean>>;
  checkDeepSeek(input: z.infer<typeof checkDeepSeekInput>): Promise<Result<DeepSeekCheckResult>>;
  cancelDeepSeekCheck(): Promise<Result<boolean>>;
  getDeepSeekLedger(): Promise<Result<DeepSeekLedgerSummary>>;
  previewScores(
    input: z.input<typeof scoreFileInput>,
  ): Promise<Result<SelectedScorePreview | null>>;
  confirmScores(input: z.input<typeof scoreConfirmInput>): Promise<Result<ScoreConfirmation>>;
  cancelScorePreview(input: z.input<typeof scoreCancelInput>): Promise<Result<void>>;
  listExams(input: z.input<typeof scoreListInput>): Promise<Result<ExamSummary[]>>;
  readScoreVersion(input: z.input<typeof scoreReadInput>): Promise<Result<ScoreVersionView>>;
  scoreHistory(input: z.input<typeof scoreHistoryInput>): Promise<Result<StoredScoreVersion[]>>;
  studentScoreHistory(
    input: z.input<typeof studentScoreHistoryInput>,
  ): Promise<Result<StudentScoreHistory>>;
  exportScoreTemplate(input: z.input<typeof scoreTemplateInput>): Promise<Result<Receipt | null>>;
}

// The preload exposes only these named operations, never an arbitrary IPC caller.
export const CHANNELS = [
  'previewResourcePrint',
  'readResourceDocument',
  'saveResourceDocument',
  'listResourceAttachments',
  'selectResourceFiles',
  'scanResourceFolder',
  'readResourceFolder',
  'addResourceLink',
  'removeResourceAttachment',
  'openResourceAttachment',
  'exportResourceDocument',
  'exportTeachingSeatingImage',
  'listTeachingRecords',
  'saveTeachingRecord',
  'deleteTeachingRecord',
  'readTeachingSettings',
  'saveTeachingSettings',
  'exportTeachingReport',
  'selectTeachingPhotos',
  'readTeachingPhoto',
  'saveTeachingExam',
  'listBridgeProposals',
  'resolveBridgeProposal',
  'workBuddyConnection',
  'startWorkBuddyConnection',
  'openWorkBuddy',
  'selectClassData',
  'configureClassData',
  'confirmClassData',
  'cancelClassData',
  'previewRosterImport',
  'confirmRosterImport',
  'exportRosterTemplate',
  'readStudentProfile',
  'saveStudentProfile',
  'studentProfileHistory',
  'readAttendanceRoster',
  'listAttendance',
  'readAttendance',
  'attendanceHistory',
  'saveAttendance',
  'listConversationHistory',
  'createConversationHistory',
  'readConversationHistory',
  'saveConversationHistory',
  'renameConversationHistory',
  'deleteConversationHistory',
  'prepareConversation',
  'selectConversationFiles',
  'removeConversationFiles',
  'generateConversation',
  'executeConversation',
  'readConversation',
  'cancelConversation',
  'clearConversationSession',
  'readModelSettings',
  'configureModelProvider',
  'selectModelProvider',
  'saveModelProviderKey',
  'deleteModelProviderKey',
  'prepareModelCheck',
  'checkModelProvider',
  'cancelModelCheck',
  'readModelLedger',
  'readDeviceStatus',
  'measureNoise',
  'requestStudentCall',
  'readStudentCall',
  'cancelDeviceTask',
  'saveGrowthEvent',
  'growthEventHistory',
  'growthTimeline',
  'createGrowthSummary',
  'prepareGrowthSummary',
  'generateGrowthSummary',
  'cancelGrowthSummary',
  'readGrowthSummary',
  'editGrowthSummary',
  'discardGrowthSummary',
  'confirmGrowthSummary',
  'growthSummaryHistory',
  'prepareScorePublication',
  'confirmScorePublication',
  'readScorePublication',
  'previewGradingPage',
  'createRubric',
  'readRubric',
  'listRubrics',
  'createGrading',
  'readGrading',
  'readGradingReview',
  'listGradings',
  'editGrading',
  'rebindGrading',
  'freezeGrading',
  'gradingAttempts',
  'gradingHistory',
  'prepareGrading',
  'generateGrading',
  'cancelGrading',
  'createClassroom',
  'readClassroom',
  'listClassrooms',
  'controlClassroom',
  'readClassroomClock',
  'readCountdown',
  'setCountdown',
  'openClassroomDisplay',
  'closeClassroomDisplay',
  'exportLessonOffice',
  'cancelLessonOffice',
  'openLessonOffice',
  'previewMaterial',
  'scanMaterialFolder',
  'readMaterialFolder',
  'cancelMaterialFolder',
  'openResourceLink',
  'confirmMaterial',
  'cancelMaterial',
  'readMaterialPreviewImage',
  'readMaterial',
  'listMaterials',
  'readMaterialImage',
  'saveMaterialOriginal',
  'createLessonDraft',
  'readSeatingDraft',
  'readDutyDraft',
  'prepareLesson',
  'generateLesson',
  'cancelLesson',
  'readLessonDraft',
  'listLessonDrafts',
  'editLessonDraft',
  'discardLessonDraft',
  'freezeLessonDraft',
  'readLessonVersion',
  'lessonHistory',
  'reviseLessonVersion',
  'prepareDuty',
  'adjustDuty',
  'cancelDuty',
  'confirmDuty',
  'dutyHistory',
  'readDutyVersion',
  'listDutyPlans',
  'previewSeatingPrint',
  'previewDutyPrint',
  'prepareSeating',
  'adjustSeating',
  'cancelSeating',
  'confirmSeating',
  'seatingHistory',
  'readSeatingVersion',
  'prepareExplanation',
  'generateExplanation',
  'cancelExplanation',
  'readExplanation',
  'listExplanations',
  'editExplanation',
  'discardExplanation',
  'snapshot',
  'createClass',
  'renameClass',
  'saveStudent',
  'setStudentActive',
  'seedDemo',
  'addSyntheticAsset',
  'saveBackup',
  'previewRestore',
  'commitRestore',
  'exportDiagnostics',
  'previewRecovery',
  'getDeepSeekStatus',
  'saveDeepSeekKey',
  'deleteDeepSeekKey',
  'checkDeepSeek',
  'cancelDeepSeekCheck',
  'getDeepSeekLedger',
  'previewScores',
  'confirmScores',
  'cancelScorePreview',
  'listExams',
  'readScoreVersion',
  'scoreHistory',
  'studentScoreHistory',
  'exportScoreTemplate',
] as const;
export type Channel = (typeof CHANNELS)[number];
