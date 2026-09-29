import { z } from 'zod';

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
  type: 'text_check' | 'vision_check';
  requestModel: string;
  responseModel?: string;
  status: 'success' | 'failed';
  errorCode?: string;
  durationMs: number;
  usage?: DeepSeekTokenUsage;
  promptVersion: string;
}

export interface DeepSeekLedgerSummary {
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  recentEntries: DeepSeekCallRecord[];
}

export interface DesktopApi {
  snapshot(): Promise<Result<Snapshot>>;
  createClass(input: z.infer<typeof createClassInput>): Promise<Result<Snapshot>>;
  renameClass(input: z.infer<typeof renameClassInput>): Promise<Result<Snapshot>>;
  saveStudent(input: StudentInput): Promise<Result<Snapshot>>;
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
}

// The preload exposes only these named operations, never an arbitrary IPC caller.
export const CHANNELS = [
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
] as const;
export type Channel = (typeof CHANNELS)[number];
