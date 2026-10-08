import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { rmSync } from 'node:fs';
import { z } from 'zod';
import { atomicWrite } from '../core/files';
import { DomainError, publicError } from '../core/errors';
import type { Channel, Snapshot } from '../shared/contracts';
import {
  teachingContentSchemas,
  teachingDeleteInput,
  teachingSaveInput,
  type BridgeProposal,
} from '../shared/teaching-workbench';

type Tool = {
  name: string;
  description: string;
  channel: Channel;
  mutation: boolean;
  schema: z.ZodType;
};
const uuid = z.uuid();
const classQuery = z.object({ classId: uuid.optional() }).strict();
const tools: Tool[] = [
  {
    name: 'workspace',
    description: '读取班级、学生和工作区版本。后续操作使用返回的真实 ID；不包含模型凭据。',
    channel: 'snapshot',
    mutation: false,
    schema: z.object({}).strict(),
  },
  {
    name: 'teaching_records',
    description: '读取当前班级的作业、请假、谈话、活动、通知草稿和待办记录。',
    channel: 'listTeachingRecords',
    mutation: false,
    schema: classQuery.extend({
      kind: z
        .enum(
          Object.keys(teachingContentSchemas) as [
            keyof typeof teachingContentSchemas,
            ...Array<keyof typeof teachingContentSchemas>,
          ],
        )
        .optional(),
    }),
  },
  {
    name: 'exams',
    description: '读取已确认的考试列表。',
    channel: 'listExams',
    mutation: false,
    schema: classQuery,
  },
  {
    name: 'exam_scores',
    description: '读取一个考试版本的真实成绩和统计。',
    channel: 'readScoreVersion',
    mutation: false,
    schema: z.object({ versionId: uuid }).strict(),
  },
  {
    name: 'student_profile',
    description: '读取学生档案及家长联系方式。',
    channel: 'readStudentProfile',
    mutation: false,
    schema: z.object({ studentId: uuid }).strict(),
  },
  {
    name: 'attendance',
    description: '读取班级点名记录。',
    channel: 'listAttendance',
    mutation: false,
    schema: z.object({ classId: uuid }).strict(),
  },
  {
    name: 'seating_history',
    description: '读取班级已确认的座位表版本。',
    channel: 'seatingHistory',
    mutation: false,
    schema: z.object({ classId: uuid }).strict(),
  },
  {
    name: 'duty_plans',
    description: '读取已确认的值日计划。',
    channel: 'listDutyPlans',
    mutation: false,
    schema: classQuery,
  },
  {
    name: 'propose_teaching_record',
    description:
      '提出新增或修改班务记录。只生成待确认方案，教师必须在本地工作台确认才会写入。群通知仅保存草稿，不会实际发送。新建 expectedRevision=0；编辑提供 id 和原 revision。',
    channel: 'saveTeachingRecord',
    mutation: true,
    schema: z
      .object({
        classId: teachingSaveInput.shape.classId,
        kind: teachingSaveInput.shape.kind,
        id: teachingSaveInput.shape.id,
        expectedRevision: teachingSaveInput.shape.expectedRevision,
        content: teachingSaveInput.shape.content,
      })
      .strict()
      .superRefine((v, ctx) => {
        const result = teachingContentSchemas[v.kind].safeParse(v.content);
        if (!result.success || Boolean(v.id) !== v.expectedRevision > 0)
          ctx.addIssue({ code: 'custom', message: '记录内容或版本不符合要求' });
      }),
  },
  {
    name: 'propose_delete_record',
    description: '提出删除或恢复班务记录，必须本地教师确认。删除保留历史。',
    channel: 'deleteTeachingRecord',
    mutation: true,
    schema: teachingDeleteInput.omit({ epoch: true, requestId: true }),
  },
  {
    name: 'propose_student',
    description:
      '提出新增或编辑学生。新增只填写 classId/studentNumber/displayName；编辑还须 id/expectedRevision。必须本地教师确认。',
    channel: 'saveStudent',
    mutation: true,
    schema: z
      .object({
        classId: uuid,
        studentNumber: z.string().regex(/^[A-Z0-9_-]{1,32}$/),
        displayName: z.string().trim().min(1).max(60),
        id: uuid.optional(),
        expectedRevision: z.number().int().positive().optional(),
      })
      .strict()
      .refine((v) => Boolean(v.id) === Boolean(v.expectedRevision)),
  },
  {
    name: 'propose_student_status',
    description: '提出学生停用或恢复在籍状态，必须本地教师确认。',
    channel: 'setStudentActive',
    mutation: true,
    schema: z
      .object({ id: uuid, expectedRevision: z.number().int().positive(), active: z.boolean() })
      .strict(),
  },
];
const payloadSchema = z
  .object({
    jsonrpc: z.literal('2.0'),
    id: z.union([z.string(), z.number()]).optional(),
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();
const toolCall = z
  .object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) })
  .strict();
const errorReply = (id: unknown, code: number, message: string) => ({
  jsonrpc: '2.0',
  id: id ?? null,
  error: { code, message },
});
const content = (value: unknown, isError = false) => ({
  content: [{ type: 'text', text: JSON.stringify(value) }],
  isError,
});

export class WorkBuddyBridge {
  private server?: Server;
  private readonly secret = randomBytes(32).toString('hex');
  private readonly proposals = new Map<
    string,
    BridgeProposal & { epoch: string; expires: number; channel: Channel }
  >();
  private sessions = new Map<string, { initialized: boolean; lastSeen: number }>();
  private lastConnection = 0;
  constructor(
    private readonly connectionFile: string,
    private readonly snapshot: () => Promise<Snapshot>,
    private readonly execute: (channel: Channel, input: unknown) => Promise<unknown>,
  ) {}
  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const authorized = req.headers.authorization ?? '';
      const expected = `Bearer ${this.secret}`;
      if (
        req.headers.origin ||
        !['127.0.0.1', '::ffff:127.0.0.1', '::1'].includes(req.socket.remoteAddress ?? '') ||
        Buffer.byteLength(authorized) !== Buffer.byteLength(expected) ||
        !timingSafeEqual(Buffer.from(authorized), Buffer.from(expected))
      ) {
        res.writeHead(403).end();
        return;
      }
      if (req.method !== 'POST' || req.url !== '/mcp') {
        res.writeHead(404).end();
        return;
      }
      let size = 0;
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => {
        size += part.length;
        if (size > 256 * 1024) req.destroy();
        else parts.push(part);
      });
      req.on('end', () => {
        void (async () => {
          let response: unknown;
          try {
            const body = JSON.parse(Buffer.concat(parts).toString('utf8'));
            const client =
              typeof req.headers['x-cm-client'] === 'string' ? req.headers['x-cm-client'] : '';
            if (!/^[a-f0-9-]{36}$/.test(client)) {
              res.writeHead(400).end();
              return;
            }
            response = await this.rpc(body, client);
            this.lastConnection = Date.now();
          } catch {
            response = errorReply(null, -32700, '请求格式无效');
          }
          if (response === undefined) res.writeHead(204).end();
          else
            res
              .writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
              .end(JSON.stringify(response));
        })();
      });
      req.on('error', () => {
        if (!res.writableEnded) res.end();
      });
    });
    this.server.requestTimeout = 15000;
    this.server.headersTimeout = 10000;
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', resolve);
    });
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Local bridge did not bind');
    atomicWrite(
      this.connectionFile,
      Buffer.from(
        JSON.stringify({ url: `http://127.0.0.1:${address.port}/mcp`, token: this.secret }),
      ),
    );
  }
  close(): void {
    this.server?.close();
    this.server?.closeAllConnections();
    this.sessions.clear();
    this.proposals.clear();
    rmSync(this.connectionFile, { force: true });
  }
  get active(): boolean {
    return Date.now() - this.lastConnection < 120000;
  }
  async rpc(raw: unknown, client: string): Promise<unknown> {
    const parsed = payloadSchema.safeParse(raw);
    if (!parsed.success) return errorReply(null, -32600, '无效的 JSON-RPC 请求');
    const request = parsed.data;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (now - session.lastSeen >= 5 * 60 * 1000) this.sessions.delete(id);
    }
    const session = this.sessions.get(client);
    if (session) session.lastSeen = now;
    if (request.method === 'notifications/disconnected') {
      this.sessions.delete(client);
      return undefined;
    }
    const reply = (result: unknown) =>
      request.id === undefined ? undefined : { jsonrpc: '2.0', id: request.id, result };
    if (request.method === 'initialize') {
      if (this.sessions.size >= 32 && !this.sessions.has(client))
        return errorReply(request.id, -32000, '连接数量达到上限');
      this.sessions.set(client, { initialized: false, lastSeen: now });
      return reply({
        protocolVersion: '2025-06-18',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'class-manager', version: '0.1.0' },
        instructions:
          '查询可直接运行。任何数据修改仅形成方案；教师在本地工作台批准后才生效。不能发送群通知，只有通知草稿接口。',
      });
    }
    if (request.method === 'notifications/initialized' && this.sessions.has(client)) {
      this.sessions.set(client, { initialized: true, lastSeen: now });
      return undefined;
    }
    if (request.id === undefined) return undefined;
    if (request.method === 'ping') return reply({});
    if (!this.sessions.get(client)?.initialized)
      return errorReply(request.id, -32002, '请先完成 MCP 初始化');
    if (request.method === 'tools/list')
      return reply({
        tools: tools.map((t) => ({
          name: t.name,
          description: t.description,
          inputSchema:
            t.name === 'propose_teaching_record'
              ? {
                  type: 'object',
                  oneOf: Object.entries(teachingContentSchemas).map(([kind, schema]) => ({
                    type: 'object',
                    properties: {
                      classId: { type: 'string', format: 'uuid' },
                      kind: { const: kind },
                      id: { type: 'string', format: 'uuid' },
                      expectedRevision: { type: 'integer', minimum: 0 },
                      content: z.toJSONSchema(schema, { unrepresentable: 'any' }),
                    },
                    required: ['classId', 'kind', 'expectedRevision', 'content'],
                    additionalProperties: false,
                  })),
                }
              : z.toJSONSchema(t.schema, { unrepresentable: 'any' }),
          annotations: { readOnlyHint: !t.mutation, destructiveHint: false, openWorldHint: false },
        })),
      });
    if (request.method !== 'tools/call') return errorReply(request.id, -32601, '不支持的方法');
    try {
      const call = toolCall.parse(request.params),
        tool = tools.find((t) => t.name === call.name);
      if (!tool) return errorReply(request.id, -32602, '未知工具');
      const args = tool.schema.parse(call.arguments);
      const snapshot = await this.snapshot();
      const input = { ...(args as object), epoch: snapshot.epoch };
      if (tool.mutation) {
        this.expire(snapshot.epoch);
        if (this.list().filter((p) => p.status === 'pending').length >= 100)
          throw new DomainError('BUSY', '待确认方案过多，请先在工作台处理。');
        const fields = input as { classId?: string; id?: string; content?: { studentId?: string } };
        if (fields.classId && !snapshot.classes.some((c) => c.id === fields.classId))
          throw new DomainError('NOT_FOUND', '班级不存在。');
        let before: unknown = null;
        if (fields.id && ['saveTeachingRecord', 'deleteTeachingRecord'].includes(tool.channel)) {
          const current = (await this.execute('listTeachingRecords', {
            epoch: snapshot.epoch,
            includeDeleted: true,
          })) as Array<{ id: string; classId: string; content?: { studentId?: string } }>;
          before = current.find((r) => r.id === fields.id);
          if (!before) throw new DomainError('NOT_FOUND', '记录不存在。');
        } else if (fields.id) before = snapshot.students.find((s) => s.id === fields.id) ?? null;
        const source = before as { classId?: string; content?: { studentId?: string } } | null;
        const proposal = {
          id: randomUUID(),
          tool: tool.name,
          input: {
            ...input,
            ...(['saveTeachingRecord', 'deleteTeachingRecord'].includes(tool.channel)
              ? { requestId: randomUUID() }
              : {}),
          },
          epoch: snapshot.epoch,
          channel: tool.channel,
          expires: Date.now() + 30 * 60 * 1000,
          createdAt: new Date().toISOString(),
          status: 'pending' as const,
          preview: {
            className: snapshot.classes.find((c) => c.id === (fields.classId ?? source?.classId))
              ?.name,
            studentName: snapshot.students.find(
              (s) =>
                s.id === (fields.content?.studentId ?? source?.content?.studentId ?? fields.id),
            )?.displayName,
            before,
            after: args,
          },
        };
        this.proposals.set(proposal.id, proposal);
        return reply(
          content({
            proposalId: proposal.id,
            status: 'pending',
            message: '方案已提交。尚未写入数据，请教师在本地工作台确认。',
          }),
        );
      }
      const result =
        tool.channel === 'snapshot'
          ? { epoch: snapshot.epoch, classes: snapshot.classes, students: snapshot.students }
          : await this.execute(tool.channel, input);
      return reply(content(result));
    } catch (error) {
      return reply(content(publicError(error), true));
    }
  }
  private expire(epoch?: string) {
    for (const p of this.proposals.values())
      if (p.status === 'pending' && (p.expires < Date.now() || (epoch && p.epoch !== epoch)))
        p.status = 'expired';
    const completed = [...this.proposals.values()].filter(
      (p) => !['pending', 'executing'].includes(p.status),
    );
    for (const p of completed.slice(0, Math.max(0, completed.length - 100)))
      this.proposals.delete(p.id);
  }
  list(): BridgeProposal[] {
    this.expire();
    return [...this.proposals.values()].map(
      ({ id, tool, input, createdAt, status, result, preview }) => ({
        id,
        tool,
        input,
        createdAt,
        status,
        preview,
        ...(result === undefined ? {} : { result }),
      }),
    );
  }
  async resolve(raw: unknown): Promise<BridgeProposal> {
    const input = z.object({ id: uuid, approve: z.boolean() }).strict().parse(raw);
    const snapshot = await this.snapshot();
    this.expire(snapshot.epoch);
    const proposal = this.proposals.get(input.id);
    if (!proposal || proposal.status !== 'pending')
      throw new DomainError(
        'REVISION_CONFLICT',
        '方案已处理、过期或属于恢复前的数据，请重新发起。',
      );
    if (!input.approve) proposal.status = 'rejected';
    else {
      proposal.status = 'executing';
      try {
        proposal.result = await this.execute(proposal.channel, proposal.input);
        proposal.status = 'succeeded';
      } catch (error) {
        proposal.result = publicError(error);
        proposal.status = 'failed';
      }
    }
    return this.list().find((p) => p.id === input.id)!;
  }
}
