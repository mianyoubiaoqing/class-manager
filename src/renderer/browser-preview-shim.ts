import type { Classroom, DesktopApi, Enrollment, Snapshot, Student } from '../shared/contracts';
import type { ConversationHistory } from '../shared/conversation-history';
import { AGENT_CONVERSATION_PROMPT_VERSION, type ConversationTask } from '../shared/conversation';

if (import.meta.env.DEV && typeof window !== 'undefined' && !window.classManager) {
  const now = new Date().toISOString();

  const mockClasses: Classroom[] = [
    { id: 'class-1', name: '高一(1)班', revision: 1, createdAt: now },
    { id: 'class-2', name: '高一(2)班', revision: 1, createdAt: now },
    { id: 'class-3', name: '高一(3)班', revision: 1, createdAt: now },
  ];

  const mockStudents: Student[] = [
    {
      id: 'stu-101',
      studentNumber: '20260101',
      displayName: '陈子涵',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-102',
      studentNumber: '20260102',
      displayName: '李沐阳',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-103',
      studentNumber: '20260103',
      displayName: '张雨欣',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-104',
      studentNumber: '20260104',
      displayName: '王宇轩',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-105',
      studentNumber: '20260105',
      displayName: '赵雪涵',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-106',
      studentNumber: '20260106',
      displayName: '周俊杰',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-107',
      studentNumber: '20260107',
      displayName: '吴雨桐',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-108',
      studentNumber: '20260108',
      displayName: '钱浩然',
      classId: 'class-1',
      className: '高一(1)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-109',
      studentNumber: '20260109',
      displayName: '林芷晴',
      classId: 'class-1',
      className: '高一(1)班',
      active: false,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-201',
      studentNumber: '20260201',
      displayName: '刘浩宇',
      classId: 'class-2',
      className: '高一(2)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-202',
      studentNumber: '20260202',
      displayName: '孙思齐',
      classId: 'class-2',
      className: '高一(2)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
    {
      id: 'stu-301',
      studentNumber: '20260301',
      displayName: '郭明哲',
      classId: 'class-3',
      className: '高一(3)班',
      active: true,
      revision: 1,
      createdAt: now,
    },
  ];

  const mockEnrollments: Enrollment[] = mockStudents.map((s) => ({
    id: `enr-${s.id}`,
    studentId: s.id,
    classId: s.classId,
    validFrom: now,
    validTo: null,
  }));

  const mockSnapshot: Snapshot = {
    epoch: 'preview-epoch-01',
    classes: mockClasses,
    students: mockStudents,
    enrollments: mockEnrollments,
    assets: [],
    schemaVersion: 11,
    dataDirectory: 'Browser-Virtual-Storage',
    recoveryCopies: 1,
  };

  const mockModelSettings = {
    revision: crypto.randomUUID(),
    selectedProvider: 'deepseek',
    providers: [
      {
        provider: 'deepseek',
        label: 'DeepSeek 官方',
        baseUrl: 'https://api.deepseek.com',
        textModel: 'deepseek-chat',
        visionModel: '',
        credentials: { configured: true, createdAt: now },
        capabilities: { text: 'unverified', vision: 'disabled' },
      },
      {
        provider: 'kimi',
        label: 'Kimi (Moonshot)',
        baseUrl: 'https://api.moonshot.cn/v1',
        textModel: 'moonshot-v1-8k',
        visionModel: '',
        credentials: { configured: true, createdAt: now },
        capabilities: { text: 'unverified', vision: 'disabled' },
      },
      {
        provider: 'doubao',
        label: '字节豆包',
        baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
        textModel: 'ep-synthetic-preview',
        visionModel: '',
        credentials: { configured: false },
        capabilities: { text: 'unconfigured', vision: 'disabled' },
      },
    ],
  };

  // Preview memory only; production encrypted persistence is supplied by Main.
  const histories = new Map<string, ConversationHistory>();
  const tasks = new Map<string, ConversationTask>();
  const requests = new Map<string, string>();
  const failure = () => ({
    ok: false,
    error: {
      code: 'CONFLICT',
      message: '预览记录已变化，请重新选择。',
      operationId: crypto.randomUUID(),
    },
  });
  const summary = ({ state, ...item }: ConversationHistory) => ({
    ...item,
    archived: item.epoch !== mockSnapshot.epoch,
    messageCount: state.messages.length,
    preview: state.messages.at(-1)?.text.slice(0, 100) ?? state.draft.slice(0, 100),
  });

  const handlers: Record<string, (...args: unknown[]) => Promise<unknown>> = {
    listConversationHistory: async () => ({
      ok: true,
      value: {
        items: [...histories.values()]
          .map(summary)
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
        unreadableCount: 0,
      },
    }),
    createConversationHistory: async () => {
      const at = new Date().toISOString();
      const item: ConversationHistory = {
        id: crypto.randomUUID(),
        epoch: mockSnapshot.epoch,
        title: '新会话',
        revision: 1,
        createdAt: at,
        updatedAt: at,
        state: { messages: [], draft: '', classId: null, studentId: null },
      };
      histories.set(item.id, item);
      return { ok: true, value: structuredClone(item) };
    },
    readConversationHistory: async (input) => {
      const item = histories.get((input as { id: string }).id);
      return item ? { ok: true, value: structuredClone(item) } : failure();
    },
    saveConversationHistory: async (input) => {
      const value = input as {
        id: string;
        expectedRevision: number;
        state: ConversationHistory['state'];
      };
      const item = histories.get(value.id);
      if (!item || item.revision !== value.expectedRevision) return failure();
      item.state = structuredClone(value.state);
      item.revision++;
      item.updatedAt = new Date().toISOString();
      if (item.title === '新会话')
        item.title =
          item.state.messages.find((message) => message.speaker === 'user')?.text.slice(0, 36) ||
          item.title;
      return { ok: true, value: structuredClone(item) };
    },
    renameConversationHistory: async (input) => {
      const value = input as { id: string; expectedRevision: number; title: string };
      const item = histories.get(value.id);
      if (!item || item.revision !== value.expectedRevision) return failure();
      item.title = value.title;
      item.revision++;
      item.updatedAt = new Date().toISOString();
      return { ok: true, value: structuredClone(item) };
    },
    deleteConversationHistory: async (input) => {
      const value = input as { id: string; expectedRevision: number };
      const item = histories.get(value.id);
      if (!item || item.revision !== value.expectedRevision) return failure();
      histories.delete(value.id);
      return { ok: true, value: null };
    },
    snapshot: async () => ({ ok: true, value: mockSnapshot }),
    readModelSettings: async () => ({ ok: true, value: mockModelSettings }),
    listExams: async () => ({
      ok: true,
      value: [
        {
          id: 'exam-1',
          classId: 'class-1',
          title: '高一第一学期期中数学测验',
          examDate: '2026-10-15',
          scoreCount: 8,
          averageScore: 88.5,
          createdAt: now,
        },
      ],
    }),
    readCountdown: async () => ({ ok: true, value: null }),
    readDeviceStatus: async () => ({
      ok: true,
      value: { serial: 'DEMO-USB-PREVIEW', connected: true },
    }),
    readDeepSeekStatus: async () => ({
      ok: true,
      value: { configured: true, textModel: 'deepseek-chat', visionModel: '' },
    }),
    readDeepSeekLedger: async () => ({
      ok: true,
      value: { totalTokens: 12500, promptTokens: 4500, completionTokens: 8000 },
    }),
    clearConversationSession: async () => ({ ok: true, value: true }),
    removeConversationFiles: async () => ({ ok: true, value: undefined }),
    selectConversationFiles: async () => ({
      ok: false,
      error: { code: 'UNSUPPORTED', message: '上传文件请使用桌面应用。' },
    }),
    prepareConversation: async (input: unknown) => {
      const inp = input as {
        classId?: string;
        studentId?: string;
        sessionId: string;
        text: string;
      };
      const targetClass = mockClasses.find((c) => c.id === inp.classId);
      const targetStudent = mockStudents.find((s) => s.id === inp.studentId);
      const task: ConversationTask = {
        status: 'prepared',
        preparation: {
          epoch: mockSnapshot.epoch,
          token: crypto.randomUUID(),
          endpoint: 'https://api.deepseek.com/chat/completions',
          body: JSON.stringify({ message: 'Web 浏览器环境输入' }),
          promptVersion: AGENT_CONVERSATION_PROMPT_VERSION,
          wireHash: '0'.repeat(64),
          expiresAt: new Date(Date.now() + 600000).toISOString(),
          sessionId: inp.sessionId,
          selection: { provider: 'deepseek', requestModel: 'deepseek-chat' },
          context: {
            className: targetClass?.name ?? null,
            studentNumber: targetStudent?.studentNumber ?? null,
            studentName: targetStudent?.displayName ?? null,
          },
        },
      };
      tasks.set(task.preparation.token, task);
      requests.set(task.preparation.token, inp.text);
      return { ok: true, value: structuredClone(task) };
    },
    generateConversation: async (input) => {
      const task = tasks.get((input as { token: string }).token);
      if (!task) return failure();
      task.status = 'completed';
      task.reply = `已收到你的需求：“${requests.get(task.preparation.token)}”。这是浏览器界面预览，可以体验会话管理；完整业务功能请在桌面端中使用。`;
      return { ok: true, value: structuredClone(task) };
    },
    executeConversation: async () => ({
      ok: true,
      value: {
        success: true,
        message: '浏览器预览环境：指令已在前端成功处理。',
      },
    }),
    readConversation: async (input) => {
      const task = tasks.get((input as { token: string }).token);
      return task ? { ok: true, value: structuredClone(task) } : failure();
    },
    cancelConversation: async (input) => {
      const task = tasks.get((input as { token: string }).token);
      if (!task) return failure();
      task.status = 'cancelled';
      return { ok: true, value: structuredClone(task) };
    },
    saveStudent: async (input: unknown) => {
      const student = input as {
        student: {
          displayName: string;
          studentNumber: string;
          classId: string;
          active?: boolean;
        };
      };
      const foundClass = mockClasses.find((c) => c.id === student.student.classId);
      mockStudents.push({
        id: 'stu-' + Date.now(),
        displayName: student.student.displayName,
        studentNumber: student.student.studentNumber,
        classId: student.student.classId,
        className: foundClass?.name ?? '未命名班级',
        active: student.student.active ?? true,
        revision: 1,
        createdAt: new Date().toISOString(),
      });
      return { ok: true, value: mockSnapshot };
    },
  };

  window.classManager = new Proxy(handlers as unknown as DesktopApi, {
    get(target, prop: string) {
      if (prop === 'scanMaterialFolder' || prop === 'readMaterialFolder')
        return async () => ({
          ok: false,
          error: {
            code: 'DESKTOP_REQUIRED',
            message: '请在桌面版中读取本地文件夹。',
            operationId: 'browser-preview',
          },
        });
      if (prop === 'openResourceLink')
        return async ({ url }: { url: string }) => {
          if (!url.startsWith('https://'))
            return {
              ok: false,
              error: {
                code: 'VALIDATION',
                message: '请输入 HTTPS 地址。',
                operationId: 'browser-preview',
              },
            };
          window.open(url, '_blank', 'noopener,noreferrer');
          return { ok: true, value: undefined };
        };
      if (prop === 'onConversationHistoryClose') return () => () => {};
      if (prop in target) {
        return (target as unknown as Record<string, unknown>)[prop];
      }
      return async (...args: unknown[]) => {
        console.log(`[Web Preview API Call] ${prop}`, args);
        return { ok: true, value: {} };
      };
    },
  });

  console.info(
    '%c[Class Manager Web Preview]%c 浏览器环境已成功装配虚拟桌面适配器！您可在此自由调试所有页面与动效。',
    'background:#177a62;color:#fff;padding:2px 6px;border-radius:4px;',
    'color:#177a62;font-weight:bold;',
  );
}
