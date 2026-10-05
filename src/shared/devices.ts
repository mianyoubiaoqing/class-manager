import { z } from 'zod';

const id = z.uuid();
const text = z.string().trim().min(1).max(300);
const context = z.object({ epoch: id }).strict();
export const deviceStatusInput = context;
export const deviceStatusSchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_connected'), message: text }).strict(),
  z.object({ state: z.literal('fault'), code: text, message: text }).strict(),
  z
    .object({ state: z.literal('ready'), label: text, mode: z.enum(['live', 'synthetic']) })
    .strict(),
]);
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
export interface DeviceStatuses {
  noise: DeviceStatus;
  calling: DeviceStatus;
}
export const noiseMeasureInput = context.extend({
  operationId: id,
  purpose: z.enum(['reading', 'ambient']),
  durationMs: z.number().int().min(100).max(5000),
});
export type NoiseRequest = z.infer<typeof noiseMeasureInput>;
const sampleBase = z.object({
  observedAt: z.iso.datetime(),
  durationMs: z.number().int().min(100).max(5000),
  mode: z.enum(['live', 'synthetic']),
});
export const noiseSampleSchema = z.discriminatedUnion('unit', [
  sampleBase
    .extend({ unit: z.literal('relative_amplitude'), value: z.number().min(0).max(1) })
    .strict(),
  sampleBase
    .extend({ unit: z.literal('db_spl'), value: z.number().min(0).max(200), calibration: text })
    .strict(),
]);
export type NoiseSample = z.infer<typeof noiseSampleSchema>;
export type NoiseResult =
  | { operationId: string; status: 'measured'; sample: NoiseSample }
  | { operationId: string; status: 'unavailable'; code: string; message: string };
export const studentCallInput = context.extend({
  operationId: id,
  studentId: id,
  expectedStudentRevision: z.number().int().positive(),
  reason: z.string().trim().min(1).max(200),
  acknowledgeTeacherReviewed: z.literal(true),
  acknowledgeSyntheticOnly: z.literal(true),
});
export type StudentCallRequest = z.infer<typeof studentCallInput>;
export const studentCallReadInput = context.extend({ operationId: id });
const receipt = z.object({ receiptId: text, observedAt: z.iso.datetime() });
export const callOutcomeSchema = z.discriminatedUnion('stage', [
  z.object({ stage: z.literal('unavailable'), message: text }).strict(),
  receipt.extend({ stage: z.literal('accepted') }).strict(),
  receipt.extend({ stage: z.literal('delivered') }).strict(),
  receipt.extend({ stage: z.literal('cancelled') }).strict(),
  z.object({ stage: z.literal('failed'), code: text, message: text }).strict(),
  z.object({ stage: z.literal('unknown'), code: text, message: text }).strict(),
]);
export type CallOutcome = z.infer<typeof callOutcomeSchema>;
export const storedCallSchema = z
  .object({
    request: studentCallInput,
    outcome: callOutcomeSchema,
    mode: z.enum(['live', 'synthetic']),
  })
  .strict();
export type StoredCall = z.infer<typeof storedCallSchema>;
export interface StudentCallView {
  operationId: string;
  studentId: string;
  studentRevision: number;
  synthetic: boolean;
  outcome: CallOutcome;
}
export const deviceCancelInput = studentCallReadInput.extend({ kind: z.enum(['noise', 'call']) });
export interface DeviceCancelReceipt {
  operationId: string;
  requested: boolean;
  message: string;
}
