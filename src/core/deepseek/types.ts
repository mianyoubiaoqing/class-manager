import { z } from 'zod';

export const deepSeekModelSchema = z.enum(['deepseek-flash', 'deepseek-chat']);
export type DeepSeekModel = z.infer<typeof deepSeekModelSchema>;

export interface DeepSeekTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export interface DeepSeekCallRecord {
  id: string;
  timestamp: string;
  type: 'text_check' | 'vision_check';
  requestModel: string;
  responseModel?: string;
  status: 'success' | 'failed';
  errorCode?: string;
  durationMs: number;
  usage?: DeepSeekTokenUsage;
}

export interface DeepSeekLedgerData {
  version: 1;
  entries: DeepSeekCallRecord[];
}

export interface DeepSeekCredentialStatus {
  configured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
}

export interface DeepSeekCheckOptions {
  model?: DeepSeekModel;
  baseUrl?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface DeepSeekCheckResult {
  type: 'text' | 'vision';
  success: boolean;
  model: string;
  durationMs: number;
  usage: DeepSeekTokenUsage | null;
  message: string;
  timestamp: string;
}
