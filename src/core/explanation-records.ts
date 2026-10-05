import type { DatabaseSync } from 'node:sqlite';
import {
  explanationPayloadSchema,
  explanationRecordSchema,
  type ExplanationContent,
  type ExplanationPayload,
} from '../shared/explanation-drafts';
import type { ExplanationOutput } from '../shared/score-explanation';
import { storedScoreVersionSchema } from '../shared/score-records';
import { validateScorePayload } from './score-record-validation';
import { createExplanationPreparer, validateExplanationOutput } from './score-explanation';
import { MAX_EXPLANATION_DRAFTS, MAX_EXPLANATION_PAYLOAD_BYTES } from './storage-limits';
import { DomainError } from './errors';

export const EXPLANATION_COLUMNS = `id, source_version_id AS sourceVersionId, revision, status,
  created_at AS createdAt, updated_at AS updatedAt, discarded_at AS discardedAt,
  generation_request_id AS generationRequestId, generation_hash AS generationHash`;
const SOURCE_COLUMNS = `id, exam_id AS examId, revision, request_id AS requestId,
  request_hash AS requestHash, created_at AS createdAt, reason`;

export function initialExplanationContent(output: ExplanationOutput): ExplanationContent {
  const cite = (ids: string[]) => `［${ids.join('、')}］`;
  return {
    interpretations: output.interpretations
      .map((item) => `${item.text}\n不确定性：${item.uncertainty}${cite(item.evidenceIds)}`)
      .join('\n\n'),
    questions: output.questions.map((item) => `${item.text}${cite(item.evidenceIds)}`).join('\n\n'),
    actions: output.actions.map((item) => `${item.text}${cite(item.evidenceIds)}`).join('\n\n'),
    teacherNotes: '',
  };
}

export function serializeExplanation(payload: ExplanationPayload): string {
  const serialized = JSON.stringify(explanationPayloadSchema.parse(payload));
  if (Buffer.byteLength(serialized) > MAX_EXPLANATION_PAYLOAD_BYTES)
    throw new DomainError('EXPLANATION_LIMIT', '解释草案超过 512 KiB 保存上限。');
  return serialized;
}

/** Read-only validation uses the referenced historical score version, even when now stale. */
export function validateExplanationRecords(db: DatabaseSync): void {
  try {
    if (
      Number(db.prepare('SELECT COUNT(*) AS count FROM explanation_drafts').get()?.count) >
      MAX_EXPLANATION_DRAFTS
    )
      throw new Error('Draft count limit');
    const rows = db
      .prepare(
        `SELECT ${EXPLANATION_COLUMNS},
      length(CAST(payload AS BLOB)) AS payloadBytes FROM explanation_drafts ORDER BY source_version_id`,
      )
      .all();
    // Rows are source-ordered, so retaining only the last source bounds memory usage.
    let cached:
      | { id: string; createdAt: string; prepare: ReturnType<typeof createExplanationPreparer> }
      | undefined;
    for (const { payloadBytes, ...raw } of rows) {
      const record = explanationRecordSchema.parse(raw);
      if (
        Number(payloadBytes) > MAX_EXPLANATION_PAYLOAD_BYTES ||
        Date.parse(record.updatedAt) < Date.parse(record.createdAt) ||
        (record.status === 'discarded') !== (record.discardedAt !== null) ||
        (record.discardedAt !== null && record.discardedAt !== record.updatedAt)
      )
        throw new Error('Invalid draft metadata');
      if (cached?.id !== record.sourceVersionId) {
        const sourceRaw = db
          .prepare(`SELECT ${SOURCE_COLUMNS}, payload FROM score_versions WHERE id=?`)
          .get(record.sourceVersionId);
        if (!sourceRaw) throw new Error('Missing source');
        const { payload: sourceJson, ...sourceRecord } = sourceRaw;
        const source = storedScoreVersionSchema.parse(sourceRecord);
        const sourcePayload = validateScorePayload(JSON.parse(String(sourceJson)));
        cached = {
          id: source.id,
          createdAt: source.createdAt,
          prepare: createExplanationPreparer({
            record: source,
            payload: sourcePayload,
            latestVersionId: source.id,
            stale: false,
            statistics: { subjects: [], groups: [], totals: [] },
          }),
        };
      }
      const stored = db.prepare('SELECT payload FROM explanation_drafts WHERE id=?').get(record.id);
      const payload = explanationPayloadSchema.parse(JSON.parse(String(stored?.payload)));
      const packet = cached.prepare(payload.selection);
      if (
        packet.inputHash !== payload.inputHash ||
        Date.parse(record.createdAt) < Date.parse(cached.createdAt) ||
        Date.parse(record.createdAt) < Date.parse(payload.provider.generatedAt)
      )
        throw new Error('Invalid draft provenance');
      validateExplanationOutput(JSON.stringify(payload.original), packet);
      if (
        record.revision === 1 &&
        (record.status !== 'draft' ||
          record.updatedAt !== record.createdAt ||
          JSON.stringify(payload.content) !==
            JSON.stringify(initialExplanationContent(payload.original)))
      )
        throw new Error('Invalid initial draft');
    }
  } catch {
    throw new DomainError('BACKUP_INVALID', '解释草案记录或来源无效，已拒绝打开。');
  }
}
