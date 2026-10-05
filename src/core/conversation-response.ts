import { z } from 'zod';
import { DomainError } from './errors';
import {
  conversationAction,
  conversationOutput,
  conversationDocumentSchema,
} from '../shared/conversation';
import type { ConversationModelResponse } from './deepseek/types';

export const conversationTools = [
  {
    type: 'function',
    function: {
      name: 'business_action',
      description:
        '读取业务或提议正式操作。先查询capabilities获取参数。正式操作在本地等待教师点击确认。一次调用一个动作。',
      parameters: {
        type: 'object',
        properties: { action: z.toJSONSchema(conversationAction), explanation: { type: 'string' } },
        required: ['action'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'present_document',
      description:
        '在对话内展示可交互教学计划或课件草案；nextPrompt为用户点击确认计划后的下一步请求，不代表已保存。',
      parameters: z.toJSONSchema(conversationDocumentSchema),
    },
  },
];

function parseConversationResponse(response: ConversationModelResponse) {
  const content = response.content.trim();
  if (response.truncated && response.toolCalls.length)
    throw new DomainError(
      'INVALID_RESPONSE',
      '工具参数未完整生成，未执行业务操作。请缩小计划后继续。',
    );
  const call = response.toolCalls[0];
  if (call) {
    let args: unknown;
    try {
      args = JSON.parse(call.function.arguments);
    } catch {
      throw new DomainError('INVALID_RESPONSE', '工具参数不是完整JSON，尚未执行。');
    }
    if (call.function.name === 'present_document') {
      const document = conversationDocumentSchema.parse(args);
      return {
        output: {
          formatVersion: 1 as const,
          explanation: document.title,
          action: { kind: 'reply' as const, text: document.body },
        },
        document,
        call,
      };
    }
    if (call.function.name !== 'business_action')
      throw new DomainError('VALIDATION', '模型调用了未接入工具，尚未执行。');
    const parsed = z
      .object({ action: conversationAction, explanation: z.string().max(1000).optional() })
      .strict()
      .parse(args);
    return {
      output: {
        formatVersion: 1 as const,
        explanation: parsed.explanation || content.slice(0, 1000) || '执行业务步骤',
        action: parsed.action,
      },
      call,
    };
  }
  const unfenced = content.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/, '');
  // Tolerate Markdown wrappers, but never convert invalid structured actions into writes.
  if (unfenced.startsWith('{') && /"(?:formatVersion|action|kind)"\s*:/.test(unfenced)) {
    try {
      return { output: conversationOutput.parse(JSON.parse(unfenced)) };
    } catch {
      throw new DomainError(
        'INVALID_RESPONSE',
        '业务提议参数不完整，尚未执行。可以补充需求后继续。',
      );
    }
  }
  if (!content) throw new DomainError('INVALID_RESPONSE', '模型没有返回正文或可用工具调用。');
  return {
    output: {
      formatVersion: 1 as const,
      explanation: '正常对话回复',
      action: conversationAction.parse({ kind: 'reply', text: content }),
    },
  };
}

/** Validate the complete batch before touching business state, then consume in model order. */
export function parseConversationResponses(response: ConversationModelResponse) {
  if (
    response.toolCalls.length > 8 ||
    new Set(response.toolCalls.map((call) => call.id)).size !== response.toolCalls.length
  )
    throw new DomainError('INVALID_RESPONSE', '工具调用数量超限或标识重复，尚未执行。');
  return response.toolCalls.length
    ? response.toolCalls.map((call) =>
        parseConversationResponse({ ...response, toolCalls: [call] }),
      )
    : [parseConversationResponse(response)];
}
