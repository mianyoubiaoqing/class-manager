import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  conversationHistorySchema,
  historyEpochInput,
  historyReadInput,
  historySaveInput,
  historyRenameInput,
  historyWriteInput,
  type ConversationHistory,
  type ConversationHistorySummary,
  type ConversationHistoryCatalog,
} from '../shared/conversation-history';
import type { CryptoProvider } from './deepseek/credentials';
import { DomainError } from './errors';
import { atomicWrite, requireDirectory, requireRegularFile } from './files';

/** Local teacher-visible transcripts only. No model reasoning, tool arguments, tokens or pending actions. */
export class ConversationHistoryStore {
  private readonly directory: string;
  constructor(
    root: string,
    private readonly crypto: CryptoProvider,
    private readonly now = () => new Date().toISOString(),
  ) {
    this.directory = join(root, 'conversation-history');
    mkdirSync(this.directory, { recursive: true });
    requireDirectory(this.directory);
  }
  private path(id: string) {
    return join(this.directory, `${id}.chat`);
  }
  private readFile(id: string): ConversationHistory {
    const file = this.path(id);
    if (!existsSync(file)) throw new DomainError('CONFLICT', '这段会话已删除，请重新选择。');
    requireRegularFile(file, 4 * 1024 * 1024);
    if (!this.crypto.isAvailable())
      throw new DomainError('ENCRYPTION_UNAVAILABLE', '本机暂时无法读取加密会话，请稍后重试。');
    try {
      const record = conversationHistorySchema.parse(
        JSON.parse(this.crypto.decrypt(readFileSync(file))),
      );
      if (record.id !== id) throw Error('History identity mismatch');
      return record;
    } catch {
      throw new DomainError('DATA_CORRUPTED', '会话记录暂时无法读取，原文件已保留。');
    }
  }
  private write(record: ConversationHistory): ConversationHistory {
    const parsed = conversationHistorySchema.parse(record);
    const plain = JSON.stringify(parsed);
    if (Buffer.byteLength(plain) > 2 * 1024 * 1024)
      throw new DomainError('HISTORY_LIMIT', '这段会话内容过多，请开启新会话；原记录已保留。');
    if (!this.crypto.isAvailable())
      throw new DomainError('ENCRYPTION_UNAVAILABLE', '本机加密服务暂不可用，会话尚未保存。');
    atomicWrite(this.path(parsed.id), this.crypto.encrypt(plain));
    return parsed;
  }
  list(raw: unknown): ConversationHistorySummary[] {
    const { epoch } = historyEpochInput.parse(raw);
    return readdirSync(this.directory)
      .filter((file) => /^[0-9a-f-]{36}\.chat$/iu.test(file))
      .map((file) => {
        const { state, ...record } = this.readFile(file.slice(0, -5));
        return {
          ...record,
          messageCount: state.messages.length,
          preview: state.messages.at(-1)?.text.slice(0, 100) ?? state.draft.slice(0, 100),
          archived: record.epoch !== epoch,
        };
      })
      .sort(
        (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
      );
  }
  create(raw: unknown): ConversationHistory {
    const { epoch } = historyEpochInput.parse(raw);
    if (
      readdirSync(this.directory).filter((file) => /^[0-9a-f-]{36}\.chat$/iu.test(file)).length >=
      100
    )
      throw new DomainError('HISTORY_LIMIT', '会话数量已达100段，请先删除不需要的记录。');
    const at = this.now();
    return this.write({
      id: randomUUID(),
      epoch,
      title: '新会话',
      revision: 1,
      createdAt: at,
      updatedAt: at,
      state: { messages: [], draft: '', classId: null, studentId: null },
    });
  }
  /** Isolate unreadable records without overwriting them or hiding healthy sessions. */
  catalog(raw: unknown): ConversationHistoryCatalog {
    const { epoch } = historyEpochInput.parse(raw);
    const items: ConversationHistorySummary[] = [];
    let unreadableCount = 0;
    for (const file of readdirSync(this.directory).filter((file) =>
      /^[0-9a-f-]{36}\.chat$/iu.test(file),
    )) {
      try {
        const { state, ...record } = this.readFile(file.slice(0, -5));
        items.push({
          ...record,
          messageCount: state.messages.length,
          preview: state.messages.at(-1)?.text.slice(0, 100) ?? state.draft.slice(0, 100),
          archived: record.epoch !== epoch,
        });
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== 'DATA_CORRUPTED') throw error;
        unreadableCount++;
      }
    }
    items.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.createdAt.localeCompare(a.createdAt),
    );
    return { items, unreadableCount };
  }
  read(raw: unknown): ConversationHistory {
    return this.readFile(historyReadInput.parse(raw).id);
  }
  resume(raw: unknown) {
    const input = historyReadInput.parse(raw);
    if (!existsSync(this.path(input.id))) return [];
    const record = this.readFile(input.id);
    if (record.epoch !== input.epoch)
      throw new DomainError('STALE_WORKSPACE', '恢复前的会话仅供查看，请开启新会话。');
    return record.state.messages;
  }
  private current(id: string, revision: number): ConversationHistory {
    const record = this.readFile(id);
    if (record.revision !== revision)
      throw new DomainError('CONFLICT', '会话记录已更新，请重新打开后再操作。');
    return record;
  }
  save(raw: unknown): ConversationHistory {
    const input = historySaveInput.parse(raw),
      record = this.current(input.id, input.expectedRevision);
    if (record.epoch !== input.epoch)
      throw new DomainError('STALE_WORKSPACE', '恢复前的会话仅供查看，请开启新会话继续。');
    const first = input.state.messages.find((message) => message.speaker === 'user');
    return this.write({
      ...record,
      revision: record.revision + 1,
      updatedAt: this.now(),
      state: input.state,
      title:
        record.title === '新会话' && first
          ? first.text.trim().slice(0, 36) || '新会话'
          : record.title,
    });
  }
  rename(raw: unknown): ConversationHistory {
    const input = historyRenameInput.parse(raw),
      record = this.current(input.id, input.expectedRevision);
    return this.write({
      ...record,
      title: input.title,
      revision: record.revision + 1,
      updatedAt: this.now(),
    });
  }
  delete(raw: unknown): void {
    const input = historyWriteInput.parse(raw);
    this.current(input.id, input.expectedRevision);
    unlinkSync(this.path(input.id));
  }
}
