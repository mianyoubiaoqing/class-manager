import { nodeBundleOptions } from '../scripts/node-bundle-options';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { buildSync } from 'esbuild';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import type { Channel, Result } from '../src/shared/contracts';
import { randomUUID } from 'node:crypto';
import { CHANNELS } from '../src/shared/contracts';
import { MAX_DUTY_COMMAND_BYTES } from '../src/shared/duty-records';
import { MAX_GRADING_COMMAND_BYTES } from '../src/shared/grading-records';
import { MaterialTaskRunner } from '../src/main/material-task';
import { prepareGradingImage } from '../src/core/grading-image';
import { Workspace } from '../src/core/workspace';
import { publicError, DomainError } from '../src/core/errors';
import { gradingStorageFixture } from './fixtures/grading-storage';

type IpcEvent = { sender: unknown; senderFrame: unknown };
type Handler = (event: IpcEvent, input?: unknown) => Promise<Result<unknown>>;
const roots: string[] = [];
const applications: Array<{ close: () => Promise<void> }> = [];
const nativeRequire = createRequire(join(process.cwd(), 'package.json'));
let mainSource: string;

beforeAll(() => {
  mainSource = buildSync(
    nodeBundleOptions({
      entryPoints: ['src/main/main.ts'],
      bundle: true,
      write: false,
      platform: 'node',
      format: 'cjs',
      packages: 'external',
      external: ['electron', './worker-client', './material-task'],
    }),
  ).outputFiles[0]!.text;
});

afterEach(async () => {
  for (const application of applications.splice(0)) await application.close();
  vi.unstubAllGlobals();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Runs the real Main dispatch; only OS window/crypto and the unrelated data worker are doubles. */
async function startMain(materialTasks = { MaterialTaskRunner }) {
  const root = mkdtempSync(join(tmpdir(), 'cm-model-ipc-'));
  roots.push(root);
  const handlers = new Map<string, Handler>();
  const requests: Array<Promise<Result<unknown>>> = [];
  const workerCall = vi.fn<(...args: unknown[]) => Promise<Result<unknown>>>(async () => ({
    ok: true,
    value: { source: 'data-worker' },
  }));
  const showErrorBox = vi.fn();
  const app = Object.assign(new EventEmitter(), {
    setName: vi.fn(),
    setPath: vi.fn(),
    getPath: () => root,
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    getVersion: () => 'test',
    quit: vi.fn(),
  });
  const windows: TestWindow[] = [];
  class TestWindow extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' },
      setWindowOpenHandler: vi.fn(),
      send: vi.fn(),
    });
    close = vi.fn();
    constructor() {
      super();
      windows.push(this);
    }
    loadURL(url: string) {
      this.webContents.mainFrame.url = url;
      return Promise.resolve();
    }
  }
  const electron = {
    app,
    BrowserWindow: TestWindow,
    ipcMain: Object.assign(new EventEmitter(), {
      handle: (channel: string, handler: Handler) => handlers.set(channel, handler),
    }),
    safeStorage: {
      isEncryptionAvailable: () => true,
      encryptString: (plain: string) => Buffer.from(`TEST-ONLY:${plain}`),
      decryptString: (bytes: Buffer) => bytes.toString().slice('TEST-ONLY:'.length),
    },
    session: {
      defaultSession: Object.assign(new EventEmitter(), {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        webRequest: { onBeforeRequest: vi.fn() },
      }),
    },
    dialog: {
      showErrorBox,
      showMessageBox: vi.fn(async () => ({ response: 0 })),
      showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] as string[] })),
      showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: '' })),
    },
  };
  const worker = {
    WorkerClient: class {
      call = workerCall;
      close = async () => {};
    },
  };
  const module = { exports: {} };
  new Function('require', 'module', 'exports', '__dirname', mainSource)(
    (id: string) =>
      id === 'electron'
        ? electron
        : id === './worker-client'
          ? worker
          : id === './material-task'
            ? materialTasks
            : nativeRequire(id),
    module,
    module.exports,
    dirname(resolve('src/main/main.ts')),
  );
  await setImmediate();
  expect(showErrorBox).not.toHaveBeenCalled();
  expect(windows).toHaveLength(1);
  const window = windows[0]!;
  const trustedEvent = {
    sender: window.webContents,
    senderFrame: window.webContents.mainFrame,
  };
  const call = (channel: Channel, input?: unknown, event: IpcEvent = trustedEvent) => {
    const handler = handlers.get(`cm:${channel}`);
    if (!handler) throw new Error(`Missing Main handler: ${channel}`);
    const request = handler(event, input);
    requests.push(request);
    return request;
  };
  applications.push({
    close: async () => {
      await call('cancelDeepSeekCheck');
      await Promise.all(requests);
      app.emit('will-quit');
    },
  });
  return {
    call,
    workerCall,
    trustedEvent,
    dialog: electron.dialog,
    root,
    window,
    ipcMain: electron.ipcMain,
  };
}

function scoreConfiguration() {
  const id = '10000000-0000-4000-8000-000000000001';
  return {
    epoch: id,
    classId: id,
    expectedRevision: 0,
    definition: {
      name: '合成考试',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id, name: '数学', maxScore: '150', precision: 2 }],
    groups: [{ id, name: '数学组', subjectIds: [id] }],
    assignments: [{ studentId: id, groupId: id }],
    scoreBasis: 'raw',
  };
}

test('history IPC rejects foreign senders and malformed inputs before reading the workspace', async () => {
  const main = await startMain();
  for (const channel of [
    'listConversationHistory',
    'createConversationHistory',
    'readConversationHistory',
    'saveConversationHistory',
    'renameConversationHistory',
    'deleteConversationHistory',
  ] as const) {
    expect(await main.call(channel, {}, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await main.call(channel, {})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  }
  expect(main.workerCall).not.toHaveBeenCalled();
});

test('native close waits for a trusted saved-history acknowledgment and blocks business writes', async () => {
  const main = await startMain(),
    epoch = randomUUID();
  main.workerCall.mockResolvedValue({ ok: true, value: { epoch } });
  const created = await main.call('createConversationHistory', { epoch });
  if (!created.ok) throw Error(created.error.message);
  const record = created.value as {
    id: string;
    revision: number;
    state: { messages: []; draft: string; classId: null; studentId: null };
  };
  main.ipcMain.emit('cm:conversationHistoryCloseListening', main.trustedEvent, true);
  const preventDefault = vi.fn();
  main.window.emit('close', { preventDefault });
  const [, request] = main.window.webContents.send.mock.calls.at(-1)!;
  expect(preventDefault).toHaveBeenCalledOnce();
  expect(main.window.close).not.toHaveBeenCalled();
  expect(await main.call('createClass', { epoch, name: '退出时不得写入的班级' })).toMatchObject({
    ok: false,
    error: { code: 'BUSY' },
  });
  const saved = await main.call('saveConversationHistory', {
    epoch,
    id: record.id,
    expectedRevision: record.revision,
    state: { ...record.state, draft: '关闭前最后一条草稿' },
  });
  expect(saved.ok).toBe(true);
  main.ipcMain.emit(
    'cm:conversationHistoryCloseReady',
    { sender: {}, senderFrame: {} },
    { request, saved: true },
  );
  await setImmediate();
  expect(main.window.close).not.toHaveBeenCalled();
  main.ipcMain.emit('cm:conversationHistoryCloseReady', main.trustedEvent, {
    request,
    saved: true,
  });
  await setImmediate();
  expect(main.workerCall.mock.calls.some(([operation]) => operation === 'createClass')).toBe(false);
  expect(main.workerCall.mock.calls.some(([operation]) => operation === 'pauseClassrooms')).toBe(
    true,
  );
  expect(main.window.close).toHaveBeenCalledOnce();
});

test('conversation Main authorizes all six methods, bounds payloads and rejects forged schemas', async () => {
  const main = await startMain();
  for (const channel of [
    'prepareConversation',
    'generateConversation',
    'executeConversation',
    'readConversation',
    'cancelConversation',
    'clearConversationSession',
  ] as const) {
    expect(await main.call(channel, {}, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await main.call(channel, { payload: '学'.repeat(6000) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await main.call(channel, {})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  }
  expect(main.workerCall).not.toHaveBeenCalled();
});

test('actual Main conversation owns the write slot, keeps source CAS and cancels on configuration switch', async () => {
  const main = await startMain(),
    workspace = new Workspace(join(main.root, 'conversation-business'));
  try {
    const snapshot = workspace.seedDemo({ epoch: workspace.snapshot().epoch }),
      classroom = snapshot.classes[0]!;
    main.workerCall.mockImplementation(async (operation, input) => {
      try {
        switch (operation) {
          case 'snapshot':
            return { ok: true, value: workspace.snapshot() };
          case 'renameClass':
            return { ok: true, value: workspace.renameClass(input) };
          default:
            return { ok: true, value: undefined };
        }
      } catch (error) {
        return { ok: false, error: publicError(error) };
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              id: 'synthetic-main',
              model: 'synthetic-response-model',
              choices: [
                {
                  finish_reason: 'stop',
                  message: {
                    content: JSON.stringify({
                      formatVersion: 1,
                      explanation: '合成提议',
                      action: { kind: 'renameClass', name: '合成对话改名' },
                    }),
                  },
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
            }),
          ),
      ),
    );
    expect(
      await main.call('saveModelProviderKey', {
        provider: 'deepseek',
        apiKey: 'sk-synthetic-main-conversation',
      }),
    ).toMatchObject({ ok: true });
    const settings = value<import('../src/shared/model-providers').ModelSettingsView>(
      await main.call('readModelSettings'),
    );
    const input = {
      epoch: snapshot.epoch,
      configurationRevision: settings.revision,
      text: '把当前班级改名为合成对话改名',
      classId: classroom.id,
      studentId: null,
    };
    const prepared = value<import('../src/shared/conversation').ConversationTask>(
      await main.call('prepareConversation', input),
    );
    const token = { epoch: snapshot.epoch, token: prepared.preparation.token };
    expect(
      await main.call('generateConversation', {
        ...token,
        wireHash: prepared.preparation.wireHash,
        acknowledgeOutboundPreview: false,
      }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    const planned = value<import('../src/shared/conversation').ConversationTask>(
      await main.call('generateConversation', {
        ...token,
        wireHash: prepared.preparation.wireHash,
        acknowledgeOutboundPreview: true,
      }),
    );
    expect(workspace.snapshot().classes[0]?.name).toBe(classroom.name);
    let release!: (result: Result<unknown>) => void;
    const original = main.workerCall.getMockImplementation()!;
    main.workerCall.mockImplementation(async (operation, input) =>
      operation === 'renameClass'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : original(operation, input),
    );
    const executing = main.call('executeConversation', {
      ...token,
      actionHash: planned.proposal!.actionHash,
      acknowledgeActionPreview: true,
    });
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(
      await main.call('selectModelProvider', {
        provider: 'kimi',
        expectedRevision: settings.revision,
      }),
    ).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(
      await main.call('createClass', { epoch: snapshot.epoch, name: '不应插队' }),
    ).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(await main.call('cancelConversation', token)).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    release({
      ok: true,
      value: workspace.renameClass({
        epoch: snapshot.epoch,
        id: classroom.id,
        expectedRevision: classroom.revision,
        name: '合成对话改名',
      }),
    });
    expect(await executing).toMatchObject({ ok: true, value: { status: 'completed' } });
    const before = main.workerCall.mock.calls.filter(([c]) => c === 'renameClass').length;
    expect(
      await main.call('executeConversation', {
        ...token,
        actionHash: planned.proposal!.actionHash,
        acknowledgeActionPreview: true,
      }),
    ).toMatchObject({ ok: true, value: { status: 'completed' } });
    expect(main.workerCall.mock.calls.filter(([c]) => c === 'renameClass')).toHaveLength(before);
    main.workerCall.mockImplementation(original);
    const p2 = value<import('../src/shared/conversation').ConversationTask>(
      await main.call('prepareConversation', input),
    );
    expect(
      await main.call('selectModelProvider', {
        provider: 'kimi',
        expectedRevision: settings.revision,
      }),
    ).toMatchObject({ ok: true });
    expect(
      await main.call('generateConversation', {
        epoch: snapshot.epoch,
        token: p2.preparation.token,
        wireHash: p2.preparation.wireHash,
        acknowledgeOutboundPreview: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
  } finally {
    workspace.close();
  }
});

test('device Main operations enforce sender, payload bounds and real schema validation', async () => {
  const main = await startMain();
  for (const channel of [
    'readDeviceStatus',
    'measureNoise',
    'requestStudentCall',
    'readStudentCall',
    'cancelDeviceTask',
  ] as const) {
    expect(await main.call(channel, {}, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await main.call(channel, { payload: 'x'.repeat(17000) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(await main.call(channel, {})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  }
  expect(main.workerCall).not.toHaveBeenCalled();
});

test.each(['measureNoise', 'requestStudentCall'] as const)(
  'device Main %s owns workspace slot, allows cancellation and releases on failure',
  async (channel) => {
    const main = await startMain();
    const epoch = randomUUID(),
      operationId = randomUUID();
    let finish!: (result: Result<unknown>) => void;
    main.workerCall.mockImplementation(async (operation) =>
      operation === 'snapshot'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { ok: true, value: [] },
    );
    const input =
      channel === 'measureNoise'
        ? { epoch, operationId, purpose: 'reading', durationMs: 1000 }
        : {
            epoch,
            operationId,
            studentId: randomUUID(),
            expectedStudentRevision: 1,
            reason: '合成呼叫',
            acknowledgeTeacherReviewed: true,
            acknowledgeSyntheticOnly: true,
          };
    const pending = main.call(channel, input);
    await vi.waitFor(() => expect(main.workerCall).toHaveBeenCalledWith('snapshot'));
    for (const blocked of [
      'saveStudent',
      'commitRestore',
      'measureNoise',
      'requestStudentCall',
    ] as const)
      expect(await main.call(blocked, {})).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    // 取消入口可通过独占槽；无效输入立即由它自己的契约拒绝。
    expect(await main.call('cancelDeviceTask', {})).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    finish({
      ok: false,
      error: { code: 'SYNTHETIC_FAILURE', message: '合成快照故障', operationId: randomUUID() },
    });
    expect(await pending).toMatchObject({ ok: false, error: { code: 'SYNTHETIC_FAILURE' } });
    expect(await main.call('createClass', {})).toMatchObject({ ok: true });
  },
);

test('device Main defaults remain unavailable with actual workspace identity and never fetch', async () => {
  const fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  const main = await startMain();
  const workspace = new Workspace(join(main.root, 'device-workspace'));
  try {
    const snapshot = workspace.seedDemo({ epoch: workspace.snapshot().epoch });
    main.workerCall.mockImplementation(async () => ({ ok: true, value: workspace.snapshot() }));
    const student = snapshot.students.find((s) => s.active && s.classId)!;
    const operationId = randomUUID();
    expect(await main.call('readDeviceStatus', { epoch: snapshot.epoch })).toMatchObject({
      ok: true,
      value: { noise: { state: 'not_connected' }, calling: { state: 'not_connected' } },
    });
    expect(
      await main.call('measureNoise', {
        epoch: snapshot.epoch,
        operationId: randomUUID(),
        purpose: 'ambient',
        durationMs: 1000,
      }),
    ).toMatchObject({ ok: true, value: { status: 'unavailable' } });
    const request = {
      epoch: snapshot.epoch,
      operationId,
      studentId: student.id,
      expectedStudentRevision: student.revision,
      reason: '合成呼叫',
      acknowledgeTeacherReviewed: true,
      acknowledgeSyntheticOnly: true,
    };
    const result = await main.call('requestStudentCall', request);
    expect(result).toMatchObject({ ok: true, value: { outcome: { stage: 'unavailable' } } });
    expect(await main.call('readStudentCall', { epoch: snapshot.epoch, operationId })).toEqual(
      result,
    );
    expect(
      await main.call('cancelDeviceTask', { epoch: snapshot.epoch, operationId, kind: 'call' }),
    ).toMatchObject({ ok: true, value: { requested: false } });
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    workspace.close();
  }
});

test('grading Main handlers enforce trusted sender and per-command bounds; internal attempt commands remain private', async () => {
  const main = await startMain();
  const channels = [
    'saveGrowthEvent',
    'growthEventHistory',
    'growthTimeline',
    'createGrowthSummary',
    'readGrowthSummary',
    'editGrowthSummary',
    'discardGrowthSummary',
    'confirmGrowthSummary',
    'growthSummaryHistory',
    'prepareScorePublication',
    'confirmScorePublication',
    'readScorePublication',
    'createRubric',
    'readRubric',
    'listRubrics',
    'createGrading',
    'readGrading',
    'readGradingReview',
    'listGradings',
    'editGrading',
    'rebindGrading',
    'freezeGrading',
    'gradingAttempts',
    'gradingHistory',
  ] as const;
  for (const channel of channels) {
    const input = { epoch: randomUUID(), id: randomUUID() };
    expect(await main.call(channel, input)).toMatchObject({ ok: true });
    expect(main.workerCall).toHaveBeenLastCalledWith(channel, input);
    main.workerCall.mockClear();
    expect(await main.call(channel, input, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    const maximum = ['saveGrowthEvent', 'createGrowthSummary', 'editGrowthSummary'].includes(
      channel,
    )
      ? 128 * 1024
      : ['createRubric', 'createGrading', 'editGrading', 'rebindGrading'].includes(channel)
        ? MAX_GRADING_COMMAND_BYTES
        : 16384;
    expect(
      await main.call(channel, { payload: '学'.repeat(Math.ceil(maximum / 3)) }),
    ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
    expect(main.workerCall).not.toHaveBeenCalled();
  }
  for (const name of [
    'claimGrading',
    'completeGrading',
    'endGrading',
    'readMaterialAsset',
    'claimGrowthSummary',
    'completeGrowthSummary',
  ]) {
    expect(CHANNELS).not.toContain(name);
    expect(readFileSync('src/main/preload.ts', 'utf8')).not.toContain(`cm:${name}`);
  }
  for (const channel of [
    'prepareGrading',
    'generateGrading',
    'cancelGrading',
    'prepareGrowthSummary',
    'generateGrowthSummary',
    'cancelGrowthSummary',
  ] as const)
    expect(await main.call(channel, {}, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
});

test('grading writes hold the Main workspace slot while reads and cancellation remain available', async () => {
  const main = await startMain();
  let finish!: (result: Result<unknown>) => void;
  main.workerCall.mockImplementation(async (operation) =>
    operation === 'editGrading'
      ? new Promise((resolve) => {
          finish = resolve;
        })
      : { ok: true, value: [] },
  );
  const pending = main.call('editGrading', {});
  try {
    for (const channel of [
      'saveGrowthEvent',
      'createGrowthSummary',
      'editGrowthSummary',
      'discardGrowthSummary',
      'confirmGrowthSummary',
      'prepareScorePublication',
      'confirmScorePublication',
      'createRubric',
      'createGrading',
      'editGrading',
      'rebindGrading',
      'freezeGrading',
      'commitRestore',
    ] as const)
      expect(await main.call(channel, {})).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(await main.call('readGrading', {})).toMatchObject({ ok: true });
    expect(await main.call('cancelGrading', { epoch: randomUUID() })).toMatchObject({ ok: true });
  } finally {
    finish({
      ok: false,
      error: { code: 'CONFLICT', message: '合成冲突', operationId: randomUUID() },
    });
    await pending;
  }
  expect(await main.call('createGrading', {})).toMatchObject({ ok: true });
});

test.each(
  (['deepseek', 'kimi', 'doubao'] as const).flatMap((provider) =>
    (['cancel', 'credentials', 'success'] as const).map((action) => ({ provider, action })),
  ),
)(
  'actual Main $provider grading $action uses the shared paid slot and immutable preview bytes',
  async ({ provider, action }) => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetcher);
    // Native decoder is exercised separately in grading-image tests; Main uses the same transform result.
    class TestMaterialTask extends MaterialTaskRunner {
      override gradingImage(bytes: Buffer, raw: unknown) {
        return prepareGradingImage(bytes, raw);
      }
    }
    const main = await startMain({ MaterialTaskRunner: TestMaterialTask });
    const workspace = new Workspace(join(main.root, 'workspace-data'));
    try {
      const f = await gradingStorageFixture(workspace);
      const before = workspace.grading.read({ epoch: f.epoch, id: f.draft.id });
      main.workerCall.mockImplementation(async (operation, raw) => {
        try {
          let result: unknown;
          switch (operation) {
            case 'snapshot':
              result = workspace.snapshot();
              break;
            case 'cancelExplanation':
              result = workspace.explanations.cancel(raw);
              break;
            case 'cancelGrowthSummary':
              result = workspace.growth.cancel(raw);
              break;
            case 'cancelLesson':
              result = workspace.lessons.cancel(raw);
              break;
            case 'prepareGrading':
              result = workspace.grading.prepare(raw);
              break;
            case 'claimGrading':
              result = workspace.grading.claim(raw);
              break;
            case 'cancelGrading':
              result = workspace.grading.cancel(raw);
              break;
            case 'endGrading':
              result = workspace.grading.end(raw);
              break;
            case 'readMaterialAsset':
              result = workspace.materials.readAsset(raw);
              break;
            case 'completeGrading': {
              const { command, cancellation } = raw as {
                command: unknown;
                cancellation: SharedArrayBuffer;
              };
              result = workspace.grading.complete(command, () => {
                if (Atomics.compareExchange(new Int32Array(cancellation), 0, 0, 2) !== 0)
                  throw new DomainError('ABORTED', '合成取消');
              });
              break;
            }
            default:
              throw new Error(`Unexpected test operation ${operation}`);
          }
          return { ok: true, value: result };
        } catch (error) {
          return { ok: false, error: publicError(error) };
        }
      });
      const model =
        provider === 'doubao'
          ? 'ep-synthetic-vision'
          : provider === 'kimi'
            ? 'kimi-k2.6'
            : 'deepseek-flash';
      let settings = value<import('../src/shared/model-providers').ModelSettingsView>(
        await main.call('readModelSettings'),
      );
      settings = value(
        await main.call('configureModelProvider', {
          provider,
          expectedRevision: settings.revision,
          textModel: model,
          visionModel: model,
        }),
      );
      settings = value(
        await main.call('selectModelProvider', { provider, expectedRevision: settings.revision }),
      );
      settings = value(
        await main.call('saveModelProviderKey', {
          provider,
          apiKey: `sk-synthetic-main-${provider}-key`,
        }),
      );
      const prepared = await main.call('prepareGrading', {
        epoch: f.epoch,
        id: f.draft.id,
        expectedRevision: 1,
        selectedPageIds: [f.page.id],
        selectedQuestionIds: ['choice'],
        acknowledgeReplaceReviewed: false,
      });
      if (!prepared.ok) throw new Error(prepared.error.message);
      const view = prepared.value as import('../src/shared/grading-records').GradingPreparationView;
      expect(fetcher).not.toHaveBeenCalled();
      const pending = main.call('generateGrading', {
        epoch: f.epoch,
        token: view.token,
        wireHash: view.wireHash,
        acknowledgeOutboundPreview: true,
      });
      await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(1));
      for (const channel of ['generateLesson', 'generateExplanation'] as const)
        expect(await main.call(channel, {})).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(await main.call('checkDeepSeek', { type: 'vision' })).toMatchObject({
        ok: false,
        error: { code: 'BUSY' },
      });
      expect(await main.call('snapshot')).toMatchObject({ ok: true });
      if (action === 'cancel')
        expect(await main.call('cancelGrading', { epoch: f.epoch })).toMatchObject({ ok: true });
      if (action === 'credentials')
        expect(await main.call('deleteModelProviderKey', { provider })).toMatchObject({ ok: true });
      if (action !== 'success') expect(fetcher.mock.calls[0]![1]!.signal!.aborted).toBe(true);
      finish(
        new Response(
          JSON.stringify({
            id: 'synthetic-grading',
            model: 'synthetic',
            choices: [{ message: { content: f.output }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 },
          }),
        ),
      );
      expect(await pending).toMatchObject(
        action === 'success'
          ? { ok: true, value: { revision: 2 } }
          : { ok: false, error: { code: 'ABORTED' } },
      );
      const packet = JSON.parse(String(fetcher.mock.calls[0]![1]!.body));
      expect(packet.model).toBe(model);
      expect(fetcher.mock.calls[0]![0]).toBe(
        settings.providers.find((p) => p.provider === provider)!.baseUrl + '/chat/completions',
      );
      expect(fetcher.mock.calls[0]![1]?.headers).toMatchObject({
        Authorization: `Bearer sk-synthetic-main-${provider}-key`,
      });
      expect(
        packet.messages[1].content.find((part: { type: string }) => part.type === 'image_url')
          .image_url.url,
      ).toBe(view.images[0]!.dataUrl);
      const attempts = workspace.grading.attempts({ epoch: f.epoch, id: f.draft.id });
      expect(attempts[0]!.record.status).toBe(action === 'success' ? 'succeeded' : 'cancelled');
      if (action !== 'success')
        expect(workspace.grading.read({ epoch: f.epoch, id: f.draft.id })).toEqual(before);
      else
        expect(attempts[0]!.payload.provider).toMatchObject({
          provider,
          requestModel: model,
          configurationRevision: settings.revision,
          responseId: 'synthetic-grading',
          usage: { totalTokens: 10 },
        });
      expect(await main.call('readModelLedger', { provider })).toMatchObject({
        ok: true,
        value: {
          provider,
          summary: {
            totalCalls: 1,
            recentEntries: [
              {
                provider,
                requestModel: model,
                configurationRevision: settings.revision,
                type: 'grading',
              },
            ],
          },
        },
      });
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      workspace.close();
    }
  },
);

function value<T>(result: Result<unknown>): T {
  if (!result.ok) throw new Error(result.error.message);
  return result.value as T;
}

test('all model Main methods reject foreign senders and oversize commands before model or worker work', async () => {
  const main = await startMain(),
    fetcher = vi.fn<typeof fetch>();
  vi.stubGlobal('fetch', fetcher);
  for (const channel of [
    'readModelSettings',
    'configureModelProvider',
    'selectModelProvider',
    'saveModelProviderKey',
    'deleteModelProviderKey',
    'prepareModelCheck',
    'checkModelProvider',
    'cancelModelCheck',
    'readModelLedger',
  ] as const) {
    expect(await main.call(channel, {}, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await main.call(channel, { payload: 'x'.repeat(17000) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
  }
  expect(main.workerCall).not.toHaveBeenCalled();
  expect(fetcher).not.toHaveBeenCalled();
});

test.each([
  'configureModelProvider',
  'selectModelProvider',
  'saveModelProviderKey',
  'deleteModelProviderKey',
] as const)(
  '%s blocks all new model work throughout asynchronous invalidation and rejects the old token',
  async (change) => {
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetcher);
    const main = await startMain(),
      epoch = randomUUID();
    main.workerCall.mockImplementation(async () => ({ ok: true, value: { epoch } }));
    const settings = value<import('../src/shared/model-providers').ModelSettingsView>(
      await main.call('readModelSettings'),
    );
    const prepared = value<import('../src/shared/model-providers').ModelCheckPreparation>(
      await main.call('prepareModelCheck', { type: 'text', expectedRevision: settings.revision }),
    );
    let finish!: (result: Result<unknown>) => void;
    main.workerCall.mockImplementation(async (operation) =>
      operation === 'cancelGrowthSummary'
        ? new Promise((resolve) => {
            finish = resolve;
          })
        : { ok: true, value: { epoch } },
    );
    const inputs = {
      configureModelProvider: {
        provider: 'kimi',
        expectedRevision: settings.revision,
        textModel: 'kimi-k2.6',
        visionModel: 'kimi-k2.6',
      },
      selectModelProvider: { provider: 'kimi', expectedRevision: settings.revision },
      saveModelProviderKey: { provider: 'kimi', apiKey: 'sk-synthetic-gate-only' },
      deleteModelProviderKey: { provider: 'kimi' },
    };
    const changing = main.call(change, inputs[change]);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    expect(main.workerCall).toHaveBeenCalledWith('cancelExplanation', { epoch });
    for (const channel of [
      'prepareConversation',
      'generateConversation',
      'executeConversation',
      'prepareExplanation',
      'generateExplanation',
      'prepareGrowthSummary',
      'generateGrowthSummary',
      'prepareLesson',
      'generateLesson',
      'prepareGrading',
      'generateGrading',
      'prepareModelCheck',
      'checkModelProvider',
      'checkDeepSeek',
    ] as const)
      expect(await main.call(channel, {})).toMatchObject({ ok: false, error: { code: 'BUSY' } });
    expect(await main.call('readModelSettings')).toMatchObject({ ok: true });
    expect(await main.call('cancelModelCheck')).toMatchObject({ ok: true });
    finish({ ok: true, value: undefined });
    expect(await changing).toMatchObject({ ok: true });
    expect(
      await main.call('checkModelProvider', {
        token: prepared.token,
        revision: prepared.revision,
        wireHash: prepared.wireHash,
        acknowledgeOutboundPreview: true,
      }),
    ).toMatchObject({ ok: false, error: { code: 'CONFLICT' } });
    const next = value<import('../src/shared/model-providers').ModelSettingsView>(
      await main.call('readModelSettings'),
    );
    expect(
      await main.call('prepareModelCheck', { type: 'text', expectedRevision: next.revision }),
    ).toMatchObject({ ok: true });
    expect(fetcher).not.toHaveBeenCalled();
  },
);

test.each([
  'prepareDuty',
  'adjustDuty',
  'cancelDuty',
  'confirmDuty',
  'dutyHistory',
  'readDutyVersion',
  'listDutyPlans',
] as const)('Main authorizes and bounds the named %s operation', async (channel) => {
  const main = await startMain();
  const input = { epoch: randomUUID(), token: randomUUID() };
  expect(await main.call(channel, input)).toMatchObject({ ok: true });
  expect(main.workerCall).toHaveBeenLastCalledWith(channel, input);
  main.workerCall.mockClear();
  expect(await main.call(channel, input, { sender: {}, senderFrame: {} })).toMatchObject({
    ok: false,
    error: { code: 'FORBIDDEN' },
  });
  const maximum =
    channel === 'prepareDuty' || channel === 'adjustDuty' ? MAX_DUTY_COMMAND_BYTES : 16384;
  expect(await main.call(channel, { payload: '学'.repeat(Math.ceil(maximum / 3)) })).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  expect(main.workerCall).not.toHaveBeenCalled();
});

test.each(['prepareDuty', 'adjustDuty', 'cancelDuty', 'confirmDuty'] as const)(
  'Main holds the write slot during %s and releases it after worker failure',
  async (channel) => {
    const main = await startMain();
    let finish!: (result: Result<unknown>) => void;
    const pending = new Promise<Result<unknown>>((resolve) => {
      finish = resolve;
    });
    main.workerCall.mockImplementation(async (operation) =>
      operation === channel ? pending : { ok: true, value: [] },
    );
    const request = main.call(channel, {});
    try {
      for (const blocked of [
        'confirmDuty',
        'prepareDuty',
        'adjustDuty',
        'cancelDuty',
        'commitRestore',
        'confirmSeating',
      ] as const)
        expect(await main.call(blocked, {})).toMatchObject({ ok: false, error: { code: 'BUSY' } });
      expect(await main.call('listDutyPlans', {})).toMatchObject({ ok: true });
      expect(await main.call('dutyHistory', {})).toMatchObject({ ok: true });
    } finally {
      finish({
        ok: false,
        error: { code: 'CONFLICT', message: '合成冲突', operationId: randomUUID() },
      });
      await request;
    }
    expect(await main.call('createClass', {})).toMatchObject({ ok: true });
  },
);

test('Main accepts duty configuration beyond the generic limit without enlarging ordinary commands', async () => {
  const main = await startMain();
  const input = { configuration: 'x'.repeat(20000) };
  expect(await main.call('prepareDuty', input)).toMatchObject({ ok: true });
  expect(await main.call('adjustDuty', input)).toMatchObject({ ok: true });
  expect(await main.call('confirmDuty', input)).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  expect(await main.call('readDutyVersion', input)).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
});

test.each([
  'prepareSeating',
  'adjustSeating',
  'cancelSeating',
  'confirmSeating',
  'seatingHistory',
  'readSeatingVersion',
] as const)(
  'Main forwards only authorized bounded %s calls to the actual worker boundary',
  async (channel) => {
    const main = await startMain();
    const input = { epoch: randomUUID(), token: randomUUID() };
    expect(await main.call(channel, input)).toMatchObject({ ok: true });
    expect(main.workerCall).toHaveBeenLastCalledWith(channel, input);
    main.workerCall.mockClear();
    expect(await main.call(channel, input, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await main.call(channel, { payload: 'x'.repeat(17000) })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(main.workerCall).not.toHaveBeenCalled();
  },
);

test('Main holds the workspace write slot during seating confirmation but permits history reads', async () => {
  const main = await startMain();
  let complete!: (result: Result<unknown>) => void;
  const pending = new Promise<Result<unknown>>((resolve) => {
    complete = resolve;
  });
  main.workerCall.mockImplementation(async (operation) =>
    operation === 'confirmSeating' ? pending : { ok: true, value: [] },
  );
  const confirming = main.call('confirmSeating', { epoch: randomUUID() });
  try {
    expect(await main.call('prepareSeating', {})).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(await main.call('commitRestore', {})).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(await main.call('previewSeatingPrint', {})).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(await main.call('seatingHistory', {})).toMatchObject({ ok: true });
  } finally {
    complete({ ok: true, value: {} });
    await confirming;
  }
  expect(await main.call('prepareSeating', {})).toMatchObject({ ok: true });
});

test.each(['previewSeatingPrint', 'previewDutyPrint'] as const)(
  '%s accepts only version identity and rejects untrusted senders or renderer HTML',
  async (channel) => {
    const main = await startMain();
    const input = { epoch: randomUUID(), versionId: randomUUID() };
    expect(await main.call(channel, input, { sender: {}, senderFrame: {} })).toMatchObject({
      ok: false,
      error: { code: 'FORBIDDEN' },
    });
    expect(await main.call(channel, { ...input, html: '<script>bad()</script>' })).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(main.workerCall).not.toHaveBeenCalled();
  },
);

test.each([
  ['previewSeatingPrint', 'readSeatingVersion'],
  ['previewDutyPrint', 'readDutyPrintBatch'],
] as const)(
  '%s rejects a missing confirmed version without falling back to a draft',
  async (channel, read) => {
    const main = await startMain();
    const input = { epoch: randomUUID(), versionId: randomUUID() };
    main.workerCall.mockResolvedValue({
      ok: false,
      error: { code: 'NOT_FOUND', message: '合成缺失版本', operationId: randomUUID() },
    });
    expect(await main.call(channel, input)).toMatchObject({
      ok: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(main.workerCall).toHaveBeenCalledExactlyOnceWith(
      read,
      channel === 'previewDutyPrint' ? { ...input, pageOffset: 0 } : input,
    );
  },
);

test.each(['saveDeepSeekKey', 'deleteDeepSeekKey', 'commitRestore'] as const)(
  'Main invalidates an in-flight explanation after %s without blocking local reads',
  async (change) => {
    let arrived!: () => void;
    const started = new Promise<void>((resolve) => {
      arrived = resolve;
    });
    let finish!: (value: Response) => void;
    const response = new Promise<Response>((resolve) => {
      finish = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        arrived();
        return response;
      }),
    );
    const main = await startMain();
    const epoch = randomUUID();
    const token = randomUUID();
    main.workerCall.mockImplementation(async (operation) => {
      if (operation === 'claimExplanation')
        return {
          ok: true,
          value: {
            wire: {
              formatVersion: 1,
              scope: 'class',
              facts: [{ id: 'F001', subject: 'S01', metric: 'fullScore', value: '150' }],
            },
            promptVersion: 'score-explanation-v1',
          },
        };
      return { ok: true, value: { epoch } };
    });
    await main.call('saveDeepSeekKey', { apiKey: 'synthetic-key-for-generation' });
    const generation = main.call('generateExplanation', { epoch, token });
    await started;
    expect(await main.call('checkDeepSeek', { type: 'text' })).toMatchObject({
      ok: false,
      error: { code: 'BUSY' },
    });
    expect(await main.call('snapshot')).toMatchObject({ ok: true, value: { epoch } });
    expect(
      await main.call(
        change,
        change === 'saveDeepSeekKey'
          ? { apiKey: 'synthetic-replacement-key' }
          : change === 'commitRestore'
            ? { epoch, token: randomUUID() }
            : undefined,
      ),
    ).toMatchObject({ ok: true });
    finish(
      new Response(
        JSON.stringify({
          id: 'synthetic-response',
          model: 'deepseek-flash',
          choices: [{ finish_reason: 'stop', message: { content: '{}' } }],
          usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      ),
    );
    expect(await generation).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
    expect(
      main.workerCall.mock.calls.some(([operation]) => operation === 'completeExplanation'),
    ).toBe(false);
    expect(await main.call('getDeepSeekLedger')).toMatchObject({
      ok: true,
      value: {
        totalCalls: 1,
        successCalls: 0,
        recentEntries: [{ type: 'score_explanation', status: 'failed' }],
      },
    });
  },
);

test('public explanation API excludes internal persistence and rejects untrusted windows or injected provider data', async () => {
  const main = await startMain();
  expect(CHANNELS).not.toContain('claimExplanation');
  expect(CHANNELS).not.toContain('completeExplanation');
  const input = { epoch: randomUUID(), token: randomUUID() };
  expect(
    await main.call('generateExplanation', input, { sender: {}, senderFrame: {} }),
  ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(
    await main.call('generateExplanation', { ...input, output: '{}', apiKey: 'injected' }),
  ).toMatchObject({ ok: false });
  expect(main.workerCall).not.toHaveBeenCalled();
});

test('a failed check ledger start releases the shared paid-task slot without calling fetch', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  const main = await startMain();
  await main.call('saveDeepSeekKey', { apiKey: 'synthetic-check-key' });
  writeFileSync(join(main.root, 'deepseek-ledger.json'), '{invalid');
  for (let attempt = 0; attempt < 2; attempt++) {
    expect(await main.call('checkDeepSeek', { type: 'text' })).toMatchObject({
      ok: false,
      error: { code: 'DATA_CORRUPTED' },
    });
  }
  expect(fetch).not.toHaveBeenCalled();
});

test('real Main permits local reads during a model request and cancellation reaches fetch', async () => {
  let reportArrival!: (signal: AbortSignal) => void;
  const arrived = new Promise<AbortSignal>((resolve) => {
    reportArrival = resolve;
  });
  const fetchDouble = vi.fn((_url: string, init: RequestInit) => {
    const signal = init.signal!;
    reportArrival(signal);
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('Stopped', 'AbortError')));
    });
  });
  vi.stubGlobal('fetch', fetchDouble);
  const main = await startMain();
  const key = 'sk-synthetic-ipc-key-1234';
  const saved = await main.call('saveDeepSeekKey', { apiKey: key });
  expect(saved).toMatchObject({ ok: true, value: { configured: true, maskedKey: 'sk-...1234' } });
  expect(JSON.stringify(saved)).not.toContain(key);

  const request = main.call('checkDeepSeek', { type: 'text' });
  const signal = await arrived;
  expect(
    await main.call('generateExplanation', { epoch: randomUUID(), token: randomUUID() }),
  ).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect(await main.call('snapshot')).toMatchObject({ ok: true, value: { source: 'data-worker' } });
  expect(main.workerCall).toHaveBeenCalledWith('snapshot', undefined);
  expect(await main.call('cancelDeepSeekCheck')).toEqual({ ok: true, value: true });
  expect(signal.aborted).toBe(true);
  expect(await request).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  expect(fetchDouble).toHaveBeenCalledTimes(1);
  expect(await main.call('getDeepSeekLedger')).toMatchObject({
    ok: true,
    value: { totalCalls: 1, successCalls: 0, recentEntries: [{ errorCode: 'ABORTED' }] },
  });
});

test('real Main rejects foreign callers and deleted credentials without starting paid work', async () => {
  const fetchDouble = vi.fn(() => {
    throw new Error('Unexpected external request');
  });
  vi.stubGlobal('fetch', fetchDouble);
  const main = await startMain();
  const key = 'sk-synthetic-ipc-key-5678';
  expect(
    await main.call('saveDeepSeekKey', { apiKey: key }, { ...main.trustedEvent, sender: {} }),
  ).toMatchObject({ ok: false, error: { code: 'FORBIDDEN' } });
  expect(await main.call('getDeepSeekStatus')).toMatchObject({
    ok: true,
    value: { configured: false },
  });
  await main.call('saveDeepSeekKey', { apiKey: key });
  expect(JSON.stringify(await main.call('getDeepSeekStatus'))).not.toContain(key);
  expect(await main.call('deleteDeepSeekKey')).toEqual({ ok: true, value: true });
  expect(await main.call('checkDeepSeek', { type: 'vision' })).toMatchObject({
    ok: false,
    error: { code: 'CREDENTIAL_MISSING' },
  });
  expect(fetchDouble).not.toHaveBeenCalled();
  expect(await main.call('getDeepSeekLedger')).toMatchObject({
    ok: true,
    value: { totalCalls: 0 },
  });
});

test('score IPC accepts only native-selected files and opaque tokens, not renderer paths', async () => {
  const main = await startMain();
  const configuration = scoreConfiguration();
  expect(
    await main.call('previewScores', { ...configuration, path: 'C:\\private.csv' }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  expect(main.dialog.showOpenDialog).not.toHaveBeenCalled();
  const path = join(main.root, 'synthetic.CSV');
  writeFileSync(path, '学生编号,数学\n0001,99');
  main.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
  main.workerCall.mockImplementation(async (operation) => ({
    ok: true,
    value:
      operation === 'previewScoreBytes'
        ? { canConfirm: true, token: 'synthetic-preview' }
        : undefined,
  }));
  const first = await main.call('previewScores', configuration);
  expect(first).toMatchObject({ ok: true, value: { fileName: 'synthetic.CSV', canConfirm: true } });
  expect(JSON.stringify(first)).not.toContain(main.root);
  if (!first.ok) throw new Error('Expected selected file');
  const selected = first.value as { fileToken: string };
  expect(selected.fileToken).toMatch(/^[a-f0-9-]{36}$/);
  const forwarded = main.workerCall.mock.calls.find((call) => call[0] === 'previewScoreBytes')?.[1];
  expect(forwarded).toMatchObject({ configuration: { format: 'csv', fileName: 'synthetic.CSV' } });
  const next = await main.call('previewScores', {
    ...configuration,
    fileToken: selected.fileToken,
  });
  expect(next.ok).toBe(true);
  expect(main.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  expect(
    await main.call('cancelScorePreview', {
      epoch: configuration.epoch,
      keepSelectedFile: true,
    }),
  ).toMatchObject({ ok: true });
  expect(main.workerCall).toHaveBeenLastCalledWith('cancelScorePreview', {
    epoch: configuration.epoch,
  });
  expect(
    (
      await main.call('previewScores', {
        ...configuration,
        fileToken: selected.fileToken,
      })
    ).ok,
  ).toBe(true);
  expect(main.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
  expect(
    await main.call('previewScores', {
      ...configuration,
      fileToken: '20000000-0000-4000-8000-000000000001',
    }),
  ).toMatchObject({ ok: false, error: { code: 'SCORE_FILE_EXPIRED' } });
  await main.call('cancelScorePreview', { epoch: configuration.epoch });
  expect(
    await main.call('previewScores', { ...configuration, fileToken: selected.fileToken }),
  ).toMatchObject({ ok: false, error: { code: 'SCORE_FILE_EXPIRED' } });
});

test('cancelled and unsupported file selections never forward bytes and invalidate the prior preview', async () => {
  const main = await startMain();
  const configuration = scoreConfiguration();
  expect(await main.call('previewScores', configuration)).toEqual({ ok: true, value: null });
  expect(main.workerCall).toHaveBeenCalledWith('cancelScorePreview', {
    epoch: configuration.epoch,
  });
  main.workerCall.mockClear();
  for (const [name, bytes] of [
    ['wrong.txt', Buffer.from('not a score table')],
    ['empty.csv', Buffer.alloc(0)],
    ['large.csv', Buffer.alloc(5 * 1024 * 1024 + 1)],
  ] as const) {
    const path = join(main.root, name);
    writeFileSync(path, bytes);
    main.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    expect((await main.call('previewScores', configuration)).ok).toBe(false);
  }
  expect(main.workerCall.mock.calls.some((call) => call[0] === 'previewScoreBytes')).toBe(false);
});

test('cancellation while a native file picker is open discards its eventual selection', async () => {
  const main = await startMain();
  const configuration = scoreConfiguration();
  let finish!: (value: { canceled: boolean; filePaths: string[] }) => void;
  main.dialog.showOpenDialog.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const request = main.call('previewScores', configuration);
  await setImmediate();
  expect(
    await main.call('createClass', { epoch: configuration.epoch, name: '不插队' }),
  ).toMatchObject({ ok: false, error: { code: 'BUSY' } });
  expect((await main.call('cancelScorePreview', { epoch: configuration.epoch })).ok).toBe(true);
  finish({ canceled: false, filePaths: ['C:\\not-read.csv'] });
  expect(await request).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  expect(main.workerCall.mock.calls.some((call) => call[0] === 'previewScoreBytes')).toBe(false);
});

test('template export preserves cancellation and prohibits overwriting application data', async () => {
  const main = await startMain();
  const input = { ...scoreConfiguration(), format: 'csv' };
  main.workerCall.mockResolvedValue({ ok: true, value: Buffer.from('synthetic-template') });
  expect(await main.call('exportScoreTemplate', input)).toEqual({ ok: true, value: null });
  main.dialog.showSaveDialog.mockResolvedValue({
    canceled: false,
    filePath: join(main.root, 'workspace-data', 'current.json'),
  });
  expect(await main.call('exportScoreTemplate', input)).toMatchObject({
    ok: false,
    error: { code: 'VALIDATION' },
  });
  const target = join(main.root, 'template.csv');
  main.dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: target });
  expect(await main.call('exportScoreTemplate', input)).toMatchObject({
    ok: true,
    value: { path: target },
  });
  expect(readFileSync(target, 'utf8')).toBe('synthetic-template');
});

test('invalid and oversized re-previews revoke the previous backend confirmation first', async () => {
  const main = await startMain();
  const configuration = scoreConfiguration();
  for (const input of [
    { ...configuration, definition: { ...configuration.definition, name: '' } },
    { ...configuration, padding: 'x'.repeat(12 * 1024 * 1024 + 1) },
  ]) {
    let pending = true;
    main.workerCall.mockImplementation(async (operation) => {
      if (operation === 'cancelScorePreview') pending = false;
      return { ok: true, value: undefined };
    });
    expect(await main.call('previewScores', input)).toMatchObject({
      ok: false,
      error: { code: 'VALIDATION' },
    });
    expect(pending).toBe(false);
  }
  expect(main.dialog.showOpenDialog).not.toHaveBeenCalled();
});

test.each([true, false])(
  'cancellation suppresses late worker response (success=%s)',
  async (success) => {
    const main = await startMain();
    const configuration = scoreConfiguration();
    const path = join(main.root, 'synthetic.csv');
    writeFileSync(path, 'synthetic');
    main.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
    let finish!: (result: Result<unknown>) => void;
    let reportArrival!: () => void;
    const arrival = new Promise<void>((resolve) => {
      reportArrival = resolve;
    });
    main.workerCall.mockImplementation(async (operation) => {
      if (operation === 'previewScoreBytes') {
        return new Promise<Result<unknown>>((resolve) => {
          finish = resolve;
          reportArrival();
        });
      }
      return { ok: true, value: undefined };
    });
    const request = main.call('previewScores', configuration);
    await arrival;
    try {
      expect((await main.call('cancelScorePreview', { epoch: configuration.epoch })).ok).toBe(true);
    } finally {
      finish(
        success
          ? { ok: true, value: { token: 'late-token', canConfirm: true } }
          : {
              ok: false,
              error: { code: 'SCORE_INVALID', message: 'synthetic', operationId: 'test' },
            },
      );
    }
    expect(await request).toMatchObject({ ok: false, error: { code: 'ABORTED' } });
  },
);

test('an old epoch cancellation does not discard the current native selection', async () => {
  const main = await startMain();
  const configuration = scoreConfiguration();
  const path = join(main.root, 'synthetic.csv');
  writeFileSync(path, 'synthetic');
  main.dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: [path] });
  main.workerCall.mockImplementation(async (_operation, input) => {
    if ((input as { epoch?: string })?.epoch === '20000000-0000-4000-8000-000000000001')
      return { ok: false, error: { code: 'STALE', message: 'synthetic', operationId: 'test' } };
    return { ok: true, value: { canConfirm: true, token: 'synthetic' } };
  });
  const first = await main.call('previewScores', configuration);
  if (!first.ok) throw new Error('Expected selected file');
  const { fileToken } = first.value as { fileToken: string };
  expect(
    await main.call('cancelScorePreview', {
      epoch: '20000000-0000-4000-8000-000000000001',
    }),
  ).toMatchObject({ ok: false, error: { code: 'STALE' } });
  expect((await main.call('previewScores', { ...configuration, fileToken })).ok).toBe(true);
  expect(main.dialog.showOpenDialog).toHaveBeenCalledTimes(1);
});

test('only score configuration channels allow bounded large configuration messages', async () => {
  const main = await startMain();
  const base = scoreConfiguration();
  const input = { ...base, assignments: Array.from({ length: 250 }, () => base.assignments[0]) };
  expect(Buffer.byteLength(JSON.stringify(input))).toBeGreaterThan(16384);
  expect((await main.call('previewScores', input)).ok).toBe(true);
  expect(
    await main.call('createClass', { epoch: base.epoch, name: 'x'.repeat(17000) }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
  expect(
    await main.call('previewScores', { padding: 'x'.repeat(12 * 1024 * 1024 + 1) }),
  ).toMatchObject({ ok: false, error: { code: 'VALIDATION' } });
});
