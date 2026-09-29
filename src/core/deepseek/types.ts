import { z } from 'zod';

export const TEXT_PROMPT_VERSION = 'ping-v1';
export const VISION_PROMPT_VERSION = 'synthetic-1x1-v1';

export const deepSeekModelSchema = z.enum(['deepseek-flash']);
export type DeepSeekModel = z.infer<typeof deepSeekModelSchema>;

export interface DeepSeekTokenUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
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
  responseId?: string;
  model: string;
  durationMs: number;
  usage: DeepSeekTokenUsage | null;
  message: string;
  timestamp: string;
  promptVersion: string;
}
