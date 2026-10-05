import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '../errors';
import { atomicWrite } from '../files';
import type { DeepSeekCallRecord, DeepSeekLedgerData, DeepSeekTokenUsage } from './types';
import { growthSourceSchema } from '../../shared/growth';
import { modelProviderId } from '../../shared/model-providers';

export interface DeepSeekLedgerSummary {
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  recentEntries: DeepSeekCallRecord[];
}

function isValidTotals(totals: unknown): totals is DeepSeekLedgerData['totals'] {
  if (!totals || typeof totals !== 'object' || Array.isArray(totals)) return false;
  const t = totals as Record<string, unknown>;
  const isNonNegativeInt = (v: unknown): boolean =>
    typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v;
  return (
    isNonNegativeInt(t.totalCalls) &&
    isNonNegativeInt(t.successCalls) &&
    isNonNegativeInt(t.totalTokens) &&
    isNonNegativeInt(t.promptTokens) &&
    isNonNegativeInt(t.completionTokens)
  );
}

function isValidUsage(usage: unknown): usage is DeepSeekTokenUsage {
  if (usage === undefined || usage === null) return true;
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return false;
  const u = usage as Record<string, unknown>;
  const isTokenVal = (v: unknown): boolean =>
    v === null ||
    v === undefined ||
    (typeof v === 'number' && Number.isFinite(v) && v >= 0 && Math.floor(v) === v);
  return isTokenVal(u.promptTokens) && isTokenVal(u.completionTokens) && isTokenVal(u.totalTokens);
}

function isValidEntry(entry: unknown): entry is DeepSeekCallRecord {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  if (e.provider !== undefined && !modelProviderId.safeParse(e.provider).success) return false;
  if (
    e.configurationRevision !== undefined &&
    (typeof e.configurationRevision !== 'string' ||
      !/^[a-f0-9-]{36}$/i.test(e.configurationRevision))
  )
    return false;
  if (typeof e.id !== 'string' || !e.id.trim()) return false;
  if (typeof e.timestamp !== 'string' || !e.timestamp.trim()) return false;
  if (
    e.type !== 'text_check' &&
    e.type !== 'vision_check' &&
    e.type !== 'score_explanation' &&
    e.type !== 'lesson_drafting' &&
    e.type !== 'grading' &&
    e.type !== 'growth_summary' &&
    e.type !== 'conversation_intent' &&
    e.type !== 'conversation_compaction'
  )
    return false;
  if (typeof e.requestModel !== 'string' || !e.requestModel.trim()) return false;
  if (e.responseId !== undefined && typeof e.responseId !== 'string') return false;
  if (e.responseModel !== undefined && typeof e.responseModel !== 'string') return false;
  if (
    e.status !== 'success' &&
    e.status !== 'failed' &&
    e.status !== 'interrupted' &&
    e.status !== 'in_progress'
  ) {
    return false;
  }
  if (e.errorCode !== undefined && typeof e.errorCode !== 'string') return false;
  if (typeof e.durationMs !== 'number' || !Number.isFinite(e.durationMs) || e.durationMs < 0) {
    return false;
  }
  if (typeof e.promptVersion !== 'string' || !e.promptVersion.trim()) return false;
  if (e.growthInput !== undefined) {
    if (e.type !== 'growth_summary' || !e.growthInput || typeof e.growthInput !== 'object')
      return false;
    const input = e.growthInput as Record<string, unknown>;
    if (Object.keys(input).some((key) => key !== 'source' && key !== 'inputHash')) return false;
    if (typeof input.inputHash !== 'string' || !/^[a-f0-9]{64}$/.test(input.inputHash))
      return false;
    if (!growthSourceSchema.safeParse(input.source).success) return false;
  }
  if ('usage' in e && e.usage !== undefined) {
    if (!isValidUsage(e.usage)) return false;
  }
  return true;
}

export class DeepSeekLedger {
  private readonly ledgerPath: string;
  private readonly maxEntries = 200;

  constructor(dataDirectory: string, provider: 'deepseek' | 'kimi' | 'doubao' = 'deepseek') {
    this.ledgerPath = join(dataDirectory, `${provider}-ledger.json`);
    this.reconcileInterrupted();
  }

  reconcileInterrupted(): void {
    if (!existsSync(this.ledgerPath)) return;
    try {
      const data = this.read();
      let changed = false;
      for (const entry of data.entries) {
        if (entry.status === 'in_progress') {
          entry.status = 'interrupted';
          entry.errorCode = 'INTERRUPTED';
          changed = true;
        }
      }
      if (changed) {
        this.write(data);
      }
    } catch {
      // If corrupted, leave it untouched for subsequent explicit operations to report
    }
  }

  private read(): DeepSeekLedgerData {
    if (!existsSync(this.ledgerPath)) {
      return {
        version: 1,
        totals: {
          totalCalls: 0,
          successCalls: 0,
          totalTokens: 0,
          promptTokens: 0,
          completionTokens: 0,
        },
        entries: [],
      };
    }
    try {
      const raw = readFileSync(this.ledgerPath, 'utf8');
      const parsed = JSON.parse(raw) as {
        version?: unknown;
        totals?: unknown;
        entries?: unknown;
      } | null;
      if (parsed && parsed.version === 1 && Array.isArray(parsed.entries)) {
        // 先完整校验全部条目结构；若有任何一条损坏，坚决抛错且绝不写文件覆盖原件
        for (const entry of parsed.entries) {
          if (!isValidEntry(entry)) {
            throw new DomainError(
              'DATA_CORRUPTED',
              `DeepSeek 用量账本存在异常条目，已停止写入以保留原文件 (${this.ledgerPath})。`,
            );
          }
        }
        const entries = parsed.entries;

        // 如果包含 totals 属性，必须是完整合法的数值统计结构；若异常则判定为损坏，坚决抛错且绝不重置覆盖
        if ('totals' in parsed && parsed.totals !== undefined) {
          if (isValidTotals(parsed.totals)) {
            return {
              version: 1,
              totals: parsed.totals,
              entries,
            };
          }
          throw new DomainError(
            'DATA_CORRUPTED',
            `DeepSeek 用量账本 totals 结构损坏，已停止写入以保留原文件 (${this.ledgerPath})。`,
          );
        }

        // 仅当完全没有 totals 属性（合法旧版 v1 结构）且所有条目均已验证合法时，才执行平滑升级
        // 根据现有历史重构 totals；明确说明：若升级前已有超过 200 条的历史被截断，旧历史无法还原。
        let totalTokens = 0;
        let promptTokens = 0;
        let completionTokens = 0;
        let successCalls = 0;
        for (const entry of entries) {
          if (entry.status === 'success') {
            successCalls += 1;
          }
          if (entry.usage) {
            const tt = typeof entry.usage.totalTokens === 'number' ? entry.usage.totalTokens : 0;
            const pt = typeof entry.usage.promptTokens === 'number' ? entry.usage.promptTokens : 0;
            const ct =
              typeof entry.usage.completionTokens === 'number' ? entry.usage.completionTokens : 0;
            totalTokens += tt;
            promptTokens += pt;
            completionTokens += ct;
          }
        }
        const candidateTotals = {
          totalCalls: entries.length,
          successCalls,
          totalTokens,
          promptTokens,
          completionTokens,
        };
        if (!isValidTotals(candidateTotals)) {
          throw new DomainError(
            'DATA_CORRUPTED',
            `DeepSeek 用量账本统计计算异常，已停止写入以保留原文件 (${this.ledgerPath})。`,
          );
        }
        const migrated: DeepSeekLedgerData = {
          version: 1,
          totals: candidateTotals,
          entries,
        };
        this.write(migrated);
        return migrated;
      }
      throw new DomainError(
        'DATA_CORRUPTED',
        `DeepSeek 用量账本数据结构异常，已停止写入以保留原文件 (${this.ledgerPath})。`,
      );
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new DomainError(
        'DATA_CORRUPTED',
        `无法解析 DeepSeek 用量账本文件，已停止写入以保留原文件 (${this.ledgerPath})。`,
      );
    }
  }

  private write(data: DeepSeekLedgerData): void {
    const dir = dirname(this.ledgerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    atomicWrite(this.ledgerPath, JSON.stringify(data, null, 2));
  }

  startCall(entry: DeepSeekCallRecord): void {
    if (!isValidEntry(entry)) {
      throw new DomainError('PARAM_ERROR', '无效的 DeepSeek 调用记录。');
    }
    const data = this.read();
    if (data.entries.some((existing) => existing.id === entry.id))
      throw new DomainError('CONFLICT', '模型调用ID已使用，禁止重复计入用量。');
    data.totals.totalCalls += 1;
    data.entries.unshift(entry);
    if (data.entries.length > this.maxEntries) {
      data.entries = data.entries.slice(0, this.maxEntries);
    }
    this.write(data);
  }

  completeCall(id: string, updates: Partial<DeepSeekCallRecord>): void {
    const data = this.read();
    const entry = data.entries.find((item) => item.id === id);
    if (!entry) throw new DomainError('NOT_FOUND', '调用记录不存在，未更新用量账本。');
    // A terminal result must not charge the same tokens twice after a lost acknowledgement.
    if (entry.status !== 'in_progress') return;
    const completed = { ...entry, ...updates };
    if (!isValidEntry(completed) || completed.id !== id || completed.status === 'in_progress')
      throw new DomainError('PARAM_ERROR', '无效的 DeepSeek 完成记录。');
    Object.assign(entry, completed);
    if (updates.status === 'success') {
      data.totals.successCalls += 1;
    }
    // A response can consume tokens even when local validation or saving later fails.
    if (updates.usage) {
      const tt =
        typeof updates.usage.totalTokens === 'number' && Number.isFinite(updates.usage.totalTokens)
          ? updates.usage.totalTokens
          : 0;
      const pt =
        typeof updates.usage.promptTokens === 'number' &&
        Number.isFinite(updates.usage.promptTokens)
          ? updates.usage.promptTokens
          : 0;
      const ct =
        typeof updates.usage.completionTokens === 'number' &&
        Number.isFinite(updates.usage.completionTokens)
          ? updates.usage.completionTokens
          : 0;
      data.totals.totalTokens += tt;
      data.totals.promptTokens += pt;
      data.totals.completionTokens += ct;
    }
    this.write(data);
  }

  record(entry: DeepSeekCallRecord): void {
    if (!isValidEntry(entry)) {
      throw new DomainError('PARAM_ERROR', '无效的 DeepSeek 调用记录。');
    }
    const data = this.read();
    data.totals.totalCalls += 1;
    if (entry.status === 'success') {
      data.totals.successCalls += 1;
    }
    if (entry.usage) {
      const tt =
        typeof entry.usage.totalTokens === 'number' && Number.isFinite(entry.usage.totalTokens)
          ? entry.usage.totalTokens
          : 0;
      const pt =
        typeof entry.usage.promptTokens === 'number' && Number.isFinite(entry.usage.promptTokens)
          ? entry.usage.promptTokens
          : 0;
      const ct =
        typeof entry.usage.completionTokens === 'number' &&
        Number.isFinite(entry.usage.completionTokens)
          ? entry.usage.completionTokens
          : 0;
      data.totals.totalTokens += tt;
      data.totals.promptTokens += pt;
      data.totals.completionTokens += ct;
    }

    data.entries.unshift(entry);
    if (data.entries.length > this.maxEntries) {
      data.entries = data.entries.slice(0, this.maxEntries);
    }
    this.write(data);
  }

  getSummary(): DeepSeekLedgerSummary {
    const data = this.read();
    return {
      totalCalls: data.totals.totalCalls,
      successCalls: data.totals.successCalls,
      totalTokens: data.totals.totalTokens,
      promptTokens: data.totals.promptTokens,
      completionTokens: data.totals.completionTokens,
      recentEntries: data.entries.slice(0, this.maxEntries),
    };
  }
}
