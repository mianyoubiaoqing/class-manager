import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DomainError } from '../errors';
import { atomicWrite } from '../files';
import type { DeepSeekCallRecord, DeepSeekLedgerData } from './types';

export interface DeepSeekLedgerSummary {
  totalCalls: number;
  successCalls: number;
  totalTokens: number;
  promptTokens: number;
  completionTokens: number;
  recentEntries: DeepSeekCallRecord[];
}

export class DeepSeekLedger {
  private readonly ledgerPath: string;
  private readonly maxEntries = 200;

  constructor(dataDirectory: string) {
    this.ledgerPath = join(dataDirectory, 'deepseek-ledger.json');
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
      const parsed = JSON.parse(raw) as DeepSeekLedgerData;
      if (
        parsed &&
        parsed.version === 1 &&
        Array.isArray(parsed.entries) &&
        parsed.totals &&
        typeof parsed.totals.totalCalls === 'number'
      ) {
        return parsed;
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

  record(entry: DeepSeekCallRecord): void {
    const data = this.read();
    data.totals.totalCalls += 1;
    if (entry.status === 'success') {
      data.totals.successCalls += 1;
    }
    if (entry.usage) {
      data.totals.totalTokens += entry.usage.totalTokens || 0;
      data.totals.promptTokens += entry.usage.promptTokens || 0;
      data.totals.completionTokens += entry.usage.completionTokens || 0;
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
