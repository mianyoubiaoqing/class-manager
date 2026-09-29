import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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
      return { version: 1, entries: [] };
    }
    try {
      const raw = readFileSync(this.ledgerPath, 'utf8');
      const parsed = JSON.parse(raw) as DeepSeekLedgerData;
      if (parsed.version === 1 && Array.isArray(parsed.entries)) {
        return parsed;
      }
      return { version: 1, entries: [] };
    } catch {
      return { version: 1, entries: [] };
    }
  }

  private write(data: DeepSeekLedgerData): void {
    const dir = dirname(this.ledgerPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(this.ledgerPath, JSON.stringify(data, null, 2), 'utf8');
  }

  record(entry: DeepSeekCallRecord): void {
    const data = this.read();
    data.entries.unshift(entry);
    if (data.entries.length > this.maxEntries) {
      data.entries = data.entries.slice(0, this.maxEntries);
    }
    this.write(data);
  }

  getSummary(): DeepSeekLedgerSummary {
    const data = this.read();
    let totalTokens = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let successCalls = 0;

    for (const item of data.entries) {
      if (item.status === 'success') {
        successCalls += 1;
      }
      if (item.usage) {
        totalTokens += item.usage.totalTokens || 0;
        promptTokens += item.usage.promptTokens || 0;
        completionTokens += item.usage.completionTokens || 0;
      }
    }

    return {
      totalCalls: data.entries.length,
      successCalls,
      totalTokens,
      promptTokens,
      completionTokens,
      recentEntries: data.entries.slice(0, 20),
    };
  }
}
