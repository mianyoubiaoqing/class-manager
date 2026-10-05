import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { growthEventSchema, growthSummarySchema, growthEntrySchema } from '../shared/growth';
import { growthPacket, growthOutput } from './growth-source';
import { DomainError } from './errors';
import {
  MAX_GROWTH_EVENTS,
  MAX_GROWTH_EVENT_REVISIONS,
  MAX_GROWTH_SUMMARIES,
  MAX_GROWTH_SUMMARY_REVISIONS,
} from './storage-limits';

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const requireValid = (condition: unknown) => {
  if (!condition) throw new DomainError('BACKUP_INVALID', '成长记录、修订或来源关系无效。');
};
/** 不可信恢复必须同时验证当前快照、连续历史、确切来源和正式入档关联，重新计算备份哈希不能跳过语义检查。 */
export function validateGrowthRecords(db: DatabaseSync): void {
  try {
    for (const [table, maximum] of [
      ['growth_events', MAX_GROWTH_EVENTS],
      ['growth_event_revisions', MAX_GROWTH_EVENT_REVISIONS],
      ['growth_summaries', MAX_GROWTH_SUMMARIES],
      ['growth_summary_revisions', MAX_GROWTH_SUMMARY_REVISIONS],
      ['growth_summary_entries', MAX_GROWTH_SUMMARIES],
    ] as const)
      requireValid(
        Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count) <= maximum,
      );
    for (const row of db
      .prepare('SELECT id,student_id AS studentId,revision,payload FROM growth_events')
      .all()) {
      const record = growthEventSchema.parse(JSON.parse(String(row.payload)));
      requireValid(
        record.id === row.id &&
          record.studentId === row.studentId &&
          record.revision === row.revision,
      );
      const revisions = db
        .prepare(
          'SELECT revision,created_at AS createdAt,reason,request_id AS requestId,input_hash AS inputHash,payload FROM growth_event_revisions WHERE event_id=? ORDER BY revision',
        )
        .all(record.id);
      requireValid(revisions.length === record.revision);
      let previous = record;
      for (const [index, revision] of revisions.entries()) {
        const event = growthEventSchema.parse(JSON.parse(String(revision.payload)));
        z.uuid().parse(revision.requestId);
        z.string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(revision.inputHash);
        z.string().trim().min(1).max(300).parse(revision.reason);
        requireValid(
          event.id === record.id &&
            event.studentId === record.studentId &&
            event.revision === index + 1 &&
            revision.revision === event.revision &&
            event.createdAt === record.createdAt &&
            event.updatedAt === revision.createdAt &&
            event.updatedAt >= event.createdAt &&
            (!index || event.updatedAt >= previous.updatedAt),
        );
        previous = event;
      }
      requireValid(same(previous, record));
    }
    const entries = db
      .prepare(
        'SELECT id,draft_id AS draftId,student_id AS studentId,payload FROM growth_summary_entries ORDER BY rowid',
      )
      .all()
      .map((row) => {
        const record = growthEntrySchema.parse(JSON.parse(String(row.payload)));
        requireValid(
          record.id === row.id &&
            record.draftId === row.draftId &&
            record.studentId === row.studentId,
        );
        return record;
      });
    const byId = new Map(entries.map((record) => [record.id, record]));
    const superseded = new Set<string>();
    for (const [index, entry] of entries.entries()) {
      if (entry.supersedesEntryId) {
        const parent = byId.get(entry.supersedesEntryId);
        requireValid(
          parent &&
            parent.studentId === entry.studentId &&
            entries.indexOf(parent) < index &&
            parent.createdAt <= entry.createdAt &&
            !superseded.has(parent.id),
        );
        superseded.add(entry.supersedesEntryId);
      }
    }
    for (const row of db
      .prepare('SELECT id,student_id AS studentId,revision,payload FROM growth_summaries')
      .all()) {
      const record = growthSummarySchema.parse(JSON.parse(String(row.payload)));
      requireValid(
        record.id === row.id &&
          record.studentId === row.studentId &&
          record.revision === row.revision &&
          record.studentId === record.source.selection.studentId,
      );
      const revisions = db
        .prepare(
          'SELECT revision,operation,created_at AS createdAt,payload,request_id AS requestId,input_hash AS inputHash FROM growth_summary_revisions WHERE draft_id=? ORDER BY revision',
        )
        .all(record.id);
      requireValid(revisions.length === record.revision);
      const { packet } = growthPacket(db, record.source);
      requireValid(packet.inputHash === record.inputHash);
      requireValid((record.provider === null) === (record.original === null));
      if (record.original) growthOutput(JSON.stringify(record.original), packet);
      if (record.supersedesEntryId) {
        const parent = byId.get(record.supersedesEntryId);
        requireValid(
          parent && parent.studentId === record.studentId && parent.createdAt <= record.createdAt,
        );
      }
      let previous = record;
      for (const [index, revision] of revisions.entries()) {
        const draft = growthSummarySchema.parse(JSON.parse(String(revision.payload)));
        z.uuid().parse(revision.requestId);
        z.string()
          .regex(/^[a-f0-9]{64}$/)
          .parse(revision.inputHash);
        requireValid(
          draft.id === record.id &&
            draft.studentId === record.studentId &&
            draft.revision === index + 1 &&
            draft.revision === revision.revision &&
            draft.createdAt === record.createdAt &&
            draft.updatedAt === revision.createdAt &&
            draft.updatedAt >= draft.createdAt &&
            same(draft.source, record.source) &&
            same(draft.provider, record.provider) &&
            same(draft.original, record.original) &&
            draft.inputHash === record.inputHash &&
            draft.supersedesEntryId === record.supersedesEntryId,
        );
        if (!index)
          requireValid(
            revision.operation === 'created' && draft.status === 'draft' && !draft.reviewed,
          );
        else {
          requireValid(previous.status === 'draft' && draft.updatedAt >= previous.updatedAt);
          if (revision.operation === 'edited')
            requireValid(draft.status === 'draft' && draft.reviewed);
          else if (revision.operation === 'discarded' || revision.operation === 'confirmed')
            requireValid(
              draft.status === revision.operation &&
                draft.content === previous.content &&
                draft.reviewed === previous.reviewed &&
                (draft.status !== 'confirmed' || draft.reviewed),
            );
          else requireValid(false);
        }
        previous = draft;
      }
      requireValid(same(previous, record));
      const entry = entries.find((e) => e.draftId === record.id);
      requireValid(Boolean(entry) === (record.status === 'confirmed'));
      if (entry)
        requireValid(
          entry.draftRevision === record.revision &&
            entry.studentId === record.studentId &&
            entry.content === record.content &&
            entry.createdAt === record.updatedAt &&
            entry.inputHash === record.inputHash &&
            entry.supersedesEntryId === record.supersedesEntryId &&
            same(entry.source, record.source),
        );
    }
  } catch (error) {
    if (error instanceof DomainError && error.code === 'BACKUP_INVALID') throw error;
    throw new DomainError('BACKUP_INVALID', '成长记录或确切来源校验失败，原数据保留。');
  }
}
