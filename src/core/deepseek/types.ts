import { z } from 'zod';
import type { GrowthSource } from '../../shared/growth';

export const TEXT_PROMPT_VERSION = 'ping-v1';
export const VISION_PROMPT_VERSION = 'synthetic-1x1-v1';

export const deepSeekModelSchema = z.enum(['deepseek-flash']);
export type DeepSeekModel = z.infer<typeof deepSeekModelSchema>;

export interface DeepSeekTokenUsage {
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
}

export interface DeepSeekCallRecord {
  provider?: import('../../shared/model-providers').ModelProviderId;
  configurationRevision?: string;
  id: string;
  responseId?: string;
  timestamp: string;
  type:
    | 'text_check'
    | 'vision_check'
    | 'score_explanation'
    | 'lesson_drafting'
    | 'grading'
    | 'growth_summary'
    | 'conversation_intent'
    | 'conversation_compaction';
  requestModel: string;
  responseModel?: string;
  status: 'success' | 'failed' | 'interrupted' | 'in_progress';
  errorCode?: string;
  responseDiagnostic?: import('./conversation-diagnostics').ConversationDiagnostic;
  conversationAttempt?: import('./conversation-diagnostics').ConversationAttempt;
  durationMs: number;
  usage?: DeepSeekTokenUsage;
  promptVersion: string;
  /** 仅本地最小来源版本与输入哈希，不保存事实文本、谈话或模型原稿。 */
  growthInput?: { source: GrowthSource; inputHash: string };
}

export interface DeepSeekLedgerData {
  version: 1;
  totals: {
    totalCalls: number;
    successCalls: number;
    totalTokens: number;
    promptTokens: number;
    completionTokens: number;
  };
  entries: DeepSeekCallRecord[];
}

export interface DeepSeekCredentialStatus {
  configured: boolean;
  maskedKey: string | null;
  updatedAt: string | null;
}

export interface DeepSeekCheckOptions {
  model?: string;
  provider?: import('../../shared/model-providers').ModelProviderId;
  configurationRevision?: string;
  baseUrl?: string;
  signal?: AbortSignal;
}

export interface DeepSeekGenerationResult {
  content: string;
  responseId: string;
  model: string;
  durationMs: number;
  usage: DeepSeekTokenUsage | null;
}

export interface DeepSeekTextMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  tool_calls?: ConversationToolCall[];
  reasoning_content?: string;
}

export interface ConversationToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}
export interface ConversationModelResponse extends DeepSeekGenerationResult {
  diagnostic?: import('./conversation-diagnostics').ConversationDiagnostic;
  toolCalls: ConversationToolCall[];
  reasoningContent?: string;
  truncated: boolean;
}
export interface ConversationStreamUpdate {
  content: string;
  reasoningCharacters: number;
  toolNames: string[];
}

export type DeepSeekLessonPart =
  { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } };
export type DeepSeekLessonMessage =
  { role: 'system'; content: string } | { role: 'user'; content: DeepSeekLessonPart[] };

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
