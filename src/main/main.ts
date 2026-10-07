import { GrowthRunner } from './growth-runner';
import {
  rosterImportInput,
  rosterConfirmInput,
  rosterTemplateInput,
} from '../shared/roster-import';
import { ConversationRunner } from './conversation-runner';
import { conversationPrepareInput } from '../shared/conversation';
import { ConversationHistoryStore } from '../core/conversation-history';
import {
  historyEpochInput,
  historyReadInput,
  historySaveInput,
  historyRenameInput,
  historyWriteInput,
} from '../shared/conversation-history';
import { applicationDraftTools } from '../shared/application-tools';
import { DeviceGateway } from '../core/device-gateway';
import { DisconnectedNoiseMonitor, DisconnectedStudentCall } from '../core/device-adapters';
import { ModelRuntime } from '../core/model-runtime';
import { conversationDiagnosticEntries } from '../core/deepseek/conversation-diagnostics';
import {
  modelConfigurationInput,
  modelKeyInput,
  modelProviderInput,
  selectModelProviderInput,
} from '../shared/model-providers';
import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHANNELS,
  epochInput,
  checkDeepSeekInput,
  saveDeepSeekKeyInput,
  type Channel,
  type PublicError,
  type Receipt,
  type Result,
  type Snapshot,
} from '../shared/contracts';
import { MAX_BACKUP_BYTES } from '../core/backup';
import { atomicCreate, atomicWrite, requireRegularFile } from '../core/files';
import { DomainError, publicError } from '../core/errors';
import { MaterialFolders } from './material-folders';
import { resourceLinkInput } from '../shared/material-folders';
import {
  DeepSeekClient,
  DeepSeekCredentialStore,
  DeepSeekLedger,
  DEFAULT_TEXT_MODEL,
  DEFAULT_VISION_MODEL,
  type CryptoProvider,
} from '../core/deepseek';
import { WorkerClient } from './worker-client';
import { assertExportDestination, isTrustedSender } from './security';
import { readScoreFile, type SelectedScoreFile } from './score-files';
import { ConversationFiles } from './conversation-files';
import { conversationFilesInput, conversationFileRemoveInput } from '../shared/conversation-files';
import { ExplanationRunner } from './explanation-runner';
import { LessonRunner } from './lesson-runner';
import { GradingRunner } from './grading-runner';
import { MAX_GRADING_COMMAND_BYTES } from '../shared/grading-records';
import { MaterialImporter } from './material-importer';
import { MaterialTaskRunner } from './material-task';
import { OfficeTaskRunner } from './office-task';
import { OfficeExporter } from './office-exporter';
import { ClassroomDisplay } from './classroom-display';
import { assertLocalScorePath } from './local-score-path';
import { materialImageReadInput, materialReadInput } from '../shared/material-records';
import { MAX_LESSON_COMMAND_BYTES } from '../shared/lesson-records';
import { openSeatingPrintPreview } from './seating-print';
import { openDutyPrintPreview } from './duty-print';
import { countPrintPreviewResidues, recoverPrintPreviews } from './print-preview-files';
import { seatingReadInput, type SeatingVersionView } from '../shared/seating-records';
import { MAX_DUTY_COMMAND_BYTES, dutyReadInput } from '../shared/duty-records';
import {
  MAX_SCORE_COMMAND_BYTES,
  scoreCancelInput,
  scoreFileInput,
  scoreTemplateInput,
  type PendingScoreView,
  type ScoreConfirmation,
} from '../shared/score-commands';

app.setName('Class Manager');
if (process.env.CLASS_MANAGER_DATA_DIR)
  app.setPath('userData', resolve(process.env.CLASS_MANAGER_DATA_DIR));
let window: BrowserWindow | undefined;
let operationBusy = false;
// 配置/恢复独占期间不得创建新准备或外发；否则异步取消的空隙可复活旧供应商任务。
const MODEL_WORK_CHANNELS = new Set<Channel>([
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
]);
const recentErrors: Array<Pick<PublicError, 'code' | 'operationId'> & { at: string }> = [];
function remember(error: PublicError): void {
  recentErrors.push({
    code: error.code,
    operationId: error.operationId,
    at: new Date().toISOString(),
  });
  if (recentErrors.length > 30) recentErrors.shift();
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (window?.isMinimized()) window.restore();
    window?.show();
    window?.focus();
  });
  app.on('window-all-closed', () => app.quit());
  void app
    .whenReady()
    .then(async () => {
      const root = join(app.getPath('userData'), 'workspace-data');
      const worker = new WorkerClient(join(__dirname, 'worker.cjs'), root);
      const userDataPath = app.getPath('userData');
      const printCacheRoot = join(userDataPath, 'print-previews');
      await recoverPrintPreviews(printCacheRoot).catch((error: unknown) =>
        remember(publicError(error)),
      );
      const cryptoProvider: CryptoProvider = {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain: string) => safeStorage.encryptString(plain),
        decrypt: (cipher: Buffer) => safeStorage.decryptString(cipher),
      };
      const credentialStore = new DeepSeekCredentialStore(userDataPath, cryptoProvider);
      const ledger = new DeepSeekLedger(userDataPath);
      const deepSeekClient = new DeepSeekClient();
      const models = new ModelRuntime(userDataPath, cryptoProvider);
      const conversationHistory = new ConversationHistoryStore(userDataPath, cryptoProvider);
      const devices = new DeviceGateway(
        async () => {
          const result = await worker.call<Snapshot>('snapshot');
          if (!result.ok) throw new DomainError(result.error.code, result.error.message);
          return result.value;
        },
        new DisconnectedNoiseMonitor(),
        new DisconnectedStudentCall(),
      );
      const materialTask = new MaterialTaskRunner(join(__dirname, 'material-process.cjs'));
      const conversationFiles = new ConversationFiles(materialTask);
      const conversation = new ConversationRunner(
        worker,
        models,
        (input) => devices.readStatus(input),
        () => Date.now(),
        async (tool, input) => {
          if (!(applicationDraftTools as readonly string[]).includes(tool))
            return dispatch(tool, input);
          if (operationBusy) throw new DomainError('BUSY', '另一项数据操作尚未结束。');
          operationBusy = true;
          try {
            return await dispatch(tool, input);
          } finally {
            operationBusy = false;
          }
        },
        (id, epoch) => conversationHistory.resume({ id, epoch }),
        (epoch, sessionId, ids) => conversationFiles.resolve(epoch, sessionId, ids),
      );
      const growth = new GrowthRunner(worker, models, models, models, (kind) =>
        models.selection(kind),
      );
      const explanations = new ExplanationRunner(worker, models, models, models, (kind) =>
        models.selection(kind),
      );
      const lessons = new LessonRunner(worker, models, models, models, materialTask, (kind) =>
        models.selection(kind),
      );
      const materials = new MaterialImporter(worker, materialTask);
      const materialFolders = new MaterialFolders(materials, async () => {
        const result = await worker.call<Snapshot>('snapshot');
        if (!result.ok) throw new DomainError(result.error.code, result.error.message);
        return result.value.epoch;
      });
      const gradings = new GradingRunner(worker, models, models, models, materialTask, (kind) =>
        models.selection(kind),
      );
      const officeTask = new OfficeTaskRunner(join(__dirname, 'office-process.cjs'));
      const office = new OfficeExporter(worker, officeTask);
      const classroomDisplay = new ClassroomDisplay(worker);
      const classroomCheckpoint = setInterval(() => {
        if (operationBusy) return;
        void worker.call('checkpointClassroom').then((result) => {
          if (!result.ok) remember(result.error);
        });
      }, 5000);
      let currentCheckController: AbortController | null = null;
      async function invalidateModelWork(): Promise<void> {
        conversation.invalidate();
        models.invalidate();
        currentCheckController?.abort();
        growth.invalidate();
        explanations.invalidate();
        lessons.invalidate();
        gradings.invalidate();
        const snapshot = await worker.call<Snapshot>('snapshot');
        if (!snapshot.ok) throw new DomainError(snapshot.error.code, snapshot.error.message);
        for (const channel of [
          'cancelExplanation',
          'cancelGrowthSummary',
          'cancelLesson',
          'cancelGrading',
        ] as const) {
          const result = await worker.call(channel, { epoch: snapshot.value.epoch });
          if (!result.ok) throw new DomainError(result.error.code, result.error.message);
        }
      }
      let selectedScoreFile: SelectedScoreFile | undefined;
      let scoreSelectionGeneration = 0;
      let activeScorePreviewEpoch: string | undefined;
      app.on('will-quit', () => {
        conversationFiles.invalidate();
        conversation.invalidate();
        models.invalidate();
        clearInterval(classroomCheckpoint);
        classroomDisplay.close();
        devices.invalidate();
        explanations.invalidate();
        growth.invalidate();
        lessons.invalidate();
        gradings.invalidate();
        materials.invalidate();
        materialFolders.invalidate();
        office.invalidate();
        void officeTask.close();
        void materialTask.close();
        void worker.close();
      });
      const indexUrl = pathToFileURL(join(__dirname, '../renderer/index.html')).href;
      session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) =>
        callback(false),
      );
      session.defaultSession.setPermissionCheckHandler(() => false);
      session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
        callback({
          cancel: !details.url.startsWith('file:') && !details.url.startsWith('devtools:'),
        });
      });
      session.defaultSession.on('will-download', (event) => event.preventDefault());
      window = new BrowserWindow({
        width: 1240,
        height: 820,
        minWidth: 360,
        minHeight: 540,
        backgroundColor: '#f5f6f8',
        title: '班级管理 · M0',
        autoHideMenuBar: true,
        webPreferences: {
          preload: join(__dirname, 'preload.cjs'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
          webviewTag: false,
        },
      });
      window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      window.webContents.on('will-navigate', (event) => event.preventDefault());
      window.webContents.on('will-attach-webview', (event) => event.preventDefault());
      let closeApproved = false;
      let closePending = false;
      let historyCloseListening = false;
      let historyCloseReply: { request: string; resolve: (saved: boolean) => void } | undefined;
      const trustedHistoryCloseSender = (event: Electron.IpcMainEvent) =>
        event.sender === window?.webContents &&
        event.senderFrame === window.webContents.mainFrame &&
        isTrustedSender(event.senderFrame.url, indexUrl, true);
      ipcMain.on('cm:conversationHistoryCloseListening', (event, enabled: unknown) => {
        if (trustedHistoryCloseSender(event) && typeof enabled === 'boolean')
          historyCloseListening = enabled;
      });
      ipcMain.on('cm:conversationHistoryCloseReady', (event, reply: unknown) => {
        if (!trustedHistoryCloseSender(event) || !reply || typeof reply !== 'object') return;
        const value = reply as { request?: unknown; saved?: unknown };
        if (value.request === historyCloseReply?.request && typeof value.saved === 'boolean')
          historyCloseReply?.resolve(value.saved);
      });
      async function flushHistoryBeforeClose() {
        if (!historyCloseListening) return true;
        return new Promise<boolean>((resolve) => {
          const request = randomUUID();
          const finish = (saved: boolean) => {
            clearTimeout(timeout);
            historyCloseReply = undefined;
            resolve(saved);
          };
          const timeout = setTimeout(() => finish(false), 8000);
          historyCloseReply = { request, resolve: finish };
          window?.webContents.send('cm:conversationHistoryClose', request);
        });
      }
      app.on('before-quit', (event) => {
        if (!closeApproved) {
          event.preventDefault();
          window?.close();
        }
      });
      window.on('close', (event) => {
        if (
          operationBusy ||
          devices.busy ||
          models.busy ||
          conversation.busy ||
          materialFolders.busy
        ) {
          event.preventDefault();
          void dialog.showMessageBox(window!, {
            type: 'info',
            message: '操作尚未结束，请稍后退出。',
            detail: '正在保存、备份或恢复数据。',
            buttons: ['确定'],
          });
          return;
        }
        if (closeApproved) return;
        event.preventDefault();
        if (closePending) return;
        closePending = true;
        void (async () => {
          if (!(await flushHistoryBeforeClose())) {
            closePending = false;
            await dialog.showMessageBox(window!, {
              type: 'warning',
              message: '会话尚未保存，窗口已保留。',
              detail: '请重试保存后再退出，以保留最新消息和草稿。',
              buttons: ['确定'],
            });
            return;
          }
          const result = await worker.call('pauseClassrooms');
          if (!result.ok) {
            remember(result.error);
            const choice = await dialog.showMessageBox(window!, {
              type: 'warning',
              message: '课堂进度无法完成最后保存',
              detail:
                '可保留窗口检查磁盘和权限；选择退出时，重开将恢复到上次保存的进度并保持暂停。',
              buttons: ['保留窗口', '退出并保留上次保存的进度'],
              defaultId: 0,
              cancelId: 0,
            });
            if (choice.response !== 1) {
              closePending = false;
              return;
            }
          }
          closeApproved = true;
          classroomDisplay.close();
          window?.close();
        })();
      });

      async function save(
        bytes: Uint8Array,
        name: string,
        extension: string,
        protectExisting = false,
      ): Promise<Result<Receipt | null>> {
        const selected = await dialog.showSaveDialog(window!, {
          defaultPath: join(app.getPath('documents'), name),
          filters: [
            {
              name:
                extension === 'cmbackup'
                  ? '班级管理备份'
                  : extension === 'json'
                    ? '诊断信息'
                    : '文件副本',
              extensions: [extension],
            },
          ],
          properties: ['showOverwriteConfirmation', 'createDirectory'],
        });
        if (selected.canceled || !selected.filePath) return { ok: true, value: null };
        assertExportDestination(selected.filePath, root);
        if (protectExisting) atomicCreate(selected.filePath, bytes);
        else atomicWrite(selected.filePath, bytes);
        return {
          ok: true,
          value: { path: selected.filePath, createdAt: new Date().toISOString() },
        };
      }

      async function dispatch(channel: Channel, input: unknown): Promise<Result<unknown>> {
        switch (channel) {
          case 'listConversationHistory':
          case 'createConversationHistory':
          case 'readConversationHistory':
          case 'saveConversationHistory':
          case 'renameConversationHistory':
          case 'deleteConversationHistory': {
            const requested = historyEpochInput.loose().parse(input);
            const current = await worker.call<Snapshot>('snapshot');
            if (!current.ok) return current;
            if (requested.epoch !== current.value.epoch)
              throw new DomainError('STALE_WORKSPACE', '工作区已变化，请重新打开会话管理。');
            if (channel === 'listConversationHistory')
              return { ok: true, value: conversationHistory.catalog(input) };
            if (channel === 'createConversationHistory')
              return { ok: true, value: conversationHistory.create(input) };
            if (channel === 'readConversationHistory')
              return { ok: true, value: conversationHistory.read(historyReadInput.parse(input)) };
            if (channel === 'saveConversationHistory')
              return { ok: true, value: conversationHistory.save(historySaveInput.parse(input)) };
            if (channel === 'renameConversationHistory')
              return {
                ok: true,
                value: conversationHistory.rename(historyRenameInput.parse(input)),
              };
            const remove = historyWriteInput.parse(input);
            const existing = conversationHistory.read({ epoch: remove.epoch, id: remove.id });
            if (existing.revision !== remove.expectedRevision)
              throw new DomainError('CONFLICT', '会话记录已更新，请重新选择。');
            await conversation.clearSession({ epoch: remove.epoch, sessionId: remove.id });
            conversationFiles.clearSession(remove.id);
            conversationHistory.delete(remove);
            return { ok: true, value: undefined };
          }
          case 'selectConversationFiles': {
            const parsed = conversationFilesInput.parse(input);
            conversationHistory.read({ epoch: parsed.epoch, id: parsed.sessionId });
            const files = await conversationFiles.select(
              parsed,
              async () => {
                const selected = await dialog.showOpenDialog(window!, {
                  title: '上传对话附件',
                  properties: ['openFile', 'multiSelections'],
                  filters: [
                    { name: '表格与文档', extensions: ['xlsx', 'csv', 'txt', 'md', 'pdf', 'docx'] },
                  ],
                });
                return selected.canceled ? [] : selected.filePaths;
              },
              async () => {
                const snapshot = await worker.call<Snapshot>('snapshot');
                if (!snapshot.ok)
                  throw new DomainError(snapshot.error.code, snapshot.error.message);
                return snapshot.value.epoch;
              },
            );
            return { ok: true, value: files };
          }
          case 'removeConversationFiles': {
            const parsed = conversationFileRemoveInput.parse(input);
            conversationFiles.remove(parsed.epoch, parsed.sessionId, parsed.ids);
            return { ok: true, value: undefined };
          }
          case 'prepareConversation': {
            const task = await conversation.prepare(input);
            const parsed = conversationPrepareInput.parse(input);
            if (parsed.sessionId && parsed.attachmentIds?.length)
              conversationFiles.remove(parsed.epoch, parsed.sessionId, parsed.attachmentIds);
            return { ok: true, value: task };
          }
          case 'generateConversation':
            if (
              currentCheckController ||
              models.busy ||
              growth.busy ||
              explanations.busy ||
              lessons.busy ||
              gradings.busy
            )
              throw new DomainError('BUSY', '另一项模型任务尚未结束。');
            return { ok: true, value: await conversation.generate(input) };
          case 'executeConversation':
            return { ok: true, value: await conversation.execute(input) };
          case 'readConversation':
            return { ok: true, value: await conversation.read(input) };
          case 'cancelConversation':
            return { ok: true, value: conversation.cancel(input) };
          case 'clearConversationSession': {
            const parsed = conversationFilesInput.parse(input);
            await conversation.clearSession(parsed);
            conversationFiles.clearSession(parsed.sessionId);
            return { ok: true, value: undefined };
          }
          case 'readModelSettings':
            return { ok: true, value: models.settings() };
          case 'configureModelProvider':
            modelConfigurationInput.parse(input);
            await invalidateModelWork();
            return { ok: true, value: models.configure(input) };
          case 'selectModelProvider':
            selectModelProviderInput.parse(input);
            await invalidateModelWork();
            return { ok: true, value: models.select(input) };
          case 'saveModelProviderKey':
            modelKeyInput.parse(input);
            await invalidateModelWork();
            return { ok: true, value: models.saveKey(input) };
          case 'deleteModelProviderKey':
            modelProviderInput.parse(input);
            await invalidateModelWork();
            return { ok: true, value: models.deleteKey(input) };
          case 'readModelLedger':
            return { ok: true, value: models.ledger(input) };
          case 'prepareModelCheck':
            return { ok: true, value: models.prepareCheck(input) };
          case 'cancelModelCheck':
            models.invalidate();
            return { ok: true, value: undefined };
          case 'checkModelProvider':
            if (
              currentCheckController ||
              conversation.busy ||
              growth.busy ||
              explanations.busy ||
              lessons.busy ||
              gradings.busy
            )
              throw new DomainError('BUSY', '另一项模型任务尚未结束，请先取消或等待。');
            return { ok: true, value: await models.check(input) };
          case 'readDeviceStatus':
            return { ok: true, value: await devices.readStatus(input) };
          case 'measureNoise':
            return { ok: true, value: await devices.measure(input) };
          case 'requestStudentCall':
            return { ok: true, value: await devices.requestCall(input) };
          case 'readStudentCall':
            return { ok: true, value: await devices.readCall(input) };
          case 'cancelDeviceTask':
            return { ok: true, value: await devices.cancel(input) };
          case 'previewGradingPage':
            return gradings.previewPage(input);
          case 'prepareGrading':
            return gradings.prepare(input);
          case 'generateGrading':
            if (
              currentCheckController ||
              conversation.busy ||
              models.busy ||
              growth.busy ||
              explanations.busy ||
              lessons.busy
            )
              throw new DomainError('BUSY', '另一项模型任务尚未结束。');
            return gradings.generate(input);
          case 'cancelGrading':
            return gradings.cancel(input);
          case 'openClassroomDisplay':
            await classroomDisplay.open(input);
            return { ok: true, value: undefined };
          case 'closeClassroomDisplay': {
            const request = epochInput.parse(input);
            const snapshot = await worker.call<Snapshot>('snapshot');
            if (!snapshot.ok) return snapshot;
            if (snapshot.value.epoch !== request.epoch)
              throw new DomainError('STALE_WORKSPACE', '课堂工作区已切换。');
            classroomDisplay.close();
            return { ok: true, value: undefined };
          }
          case 'exportLessonOffice':
            return {
              ok: true,
              value: await office.export(input, {
                choose: async (name, format) => {
                  const selected = await dialog.showSaveDialog(window!, {
                    defaultPath: join(app.getPath('documents'), name),
                    filters: [
                      {
                        name: format === 'docx' ? 'Word 教案' : 'PowerPoint 课件',
                        extensions: [format],
                      },
                    ],
                    properties: ['showOverwriteConfirmation', 'createDirectory'],
                  });
                  return selected.canceled ? null : (selected.filePath ?? null);
                },
                validateDestination: async (path) => {
                  assertExportDestination(path, userDataPath);
                  try {
                    await assertLocalScorePath(path);
                  } catch (error) {
                    if (error instanceof DomainError)
                      throw new DomainError(
                        'EXPORT_DESTINATION',
                        '请选择 Windows 本地磁盘中的普通目录，不支持目录链接、共享或网络映射盘。',
                      );
                    throw error;
                  }
                },
                confirmOverwrite: async (name) =>
                  (
                    await dialog.showMessageBox(window!, {
                      type: 'question',
                      message: `覆盖 ${name}？`,
                      detail: '此操作会替换已有文件；若要保留原文件，请取消后另选文件名。',
                      buttons: ['取消', '确认覆盖'],
                      defaultId: 0,
                      cancelId: 0,
                      noLink: true,
                    })
                  ).response === 1,
              }),
            };
          case 'cancelLessonOffice':
            office.cancel(input);
            return { ok: true, value: undefined };
          case 'openLessonOffice':
            await office.open(input, async (path) => {
              await assertLocalScorePath(path);
              return shell.openPath(path);
            });
            return { ok: true, value: undefined };
          case 'previewMaterial':
            if (materialFolders.busy) throw new DomainError('BUSY', '文件夹资料读取尚未结束。');
            return {
              ok: true,
              value: await materials.preview(input, async () => {
                const selected = await dialog.showOpenDialog(window!, {
                  properties: ['openFile'],
                  filters: [
                    {
                      name: '教学资料',
                      extensions: ['txt', 'docx', 'pdf', 'jpg', 'jpeg', 'png'],
                    },
                  ],
                });
                return selected.canceled ? null : (selected.filePaths[0] ?? null);
              }),
            };
          case 'confirmMaterial':
            if (materialFolders.busy) throw new DomainError('BUSY', '文件夹资料读取尚未结束。');
            return materials.confirm(input);
          case 'scanMaterialFolder':
            return {
              ok: true,
              value: await materialFolders.scan(input, async () => {
                const selected = await dialog.showOpenDialog(window!, {
                  title: '选择备课资料文件夹',
                  properties: ['openDirectory'],
                });
                return selected.canceled ? null : (selected.filePaths[0] ?? null);
              }),
            };
          case 'readMaterialFolder':
            return { ok: true, value: await materialFolders.read(input) };
          case 'cancelMaterialFolder':
            materialFolders.cancel(input);
            return { ok: true, value: undefined };
          case 'openResourceLink':
            await shell.openExternal(resourceLinkInput.parse(input).url);
            return { ok: true, value: undefined };
          case 'cancelMaterial':
            materials.cancel(input);
            return { ok: true, value: undefined };
          case 'readMaterialPreviewImage':
            return { ok: true, value: materials.previewImage(input) };
          case 'readMaterialImage': {
            const read = materialImageReadInput.parse(input);
            const result = await worker.call<{ mime: string; bytes: Uint8Array }>(
              'readMaterialImage',
              read,
            );
            if (!result.ok) return result;
            if (result.value.mime !== 'image/png')
              throw new DomainError('MATERIAL_INVALID', '资料图像类型无效。');
            return {
              ok: true,
              value: `data:image/png;base64,${Buffer.from(result.value.bytes).toString('base64')}`,
            };
          }
          case 'saveMaterialOriginal': {
            const read = materialReadInput.parse(input);
            const result = await worker.call<{ name: string; format: string; bytes: Uint8Array }>(
              'readMaterialOriginal',
              read,
            );
            if (!result.ok) return result;
            return save(result.value.bytes, basename(result.value.name), result.value.format);
          }
          case 'prepareLesson':
            return lessons.prepare(input);
          case 'generateLesson':
            if (
              currentCheckController ||
              conversation.busy ||
              models.busy ||
              growth.busy ||
              explanations.busy ||
              gradings.busy
            )
              throw new DomainError('BUSY', '另一项模型任务尚未结束。');
            return lessons.generate(input);
          case 'cancelLesson':
            return lessons.cancel(input);
          case 'previewDutyPrint': {
            const parsed = dutyReadInput.parse(input);
            return {
              ok: true,
              value: await openDutyPrintPreview(window!, parsed, worker, {
                temp: printCacheRoot,
                documents: app.getPath('documents'),
                dataRoot: root,
              }),
            };
          }
          case 'previewSeatingPrint': {
            const parsed = seatingReadInput.parse(input);
            const version = await worker.call<SeatingVersionView>('readSeatingVersion', parsed);
            if (!version.ok) return version;
            return {
              ok: true,
              value: await openSeatingPrintPreview(window!, version.value, {
                temp: printCacheRoot,
                documents: app.getPath('documents'),
                dataRoot: root,
              }),
            };
          }
          case 'prepareGrowthSummary':
            return growth.prepare(input);
          case 'generateGrowthSummary':
            if (
              currentCheckController ||
              conversation.busy ||
              models.busy ||
              explanations.busy ||
              lessons.busy ||
              gradings.busy
            )
              throw new DomainError('BUSY', '另一项模型任务尚未结束，请先取消或等待。');
            return growth.generate(input);
          case 'cancelGrowthSummary':
            return growth.cancel(input);
          case 'prepareExplanation':
            return explanations.prepare(input);
          case 'generateExplanation':
            if (
              currentCheckController ||
              conversation.busy ||
              models.busy ||
              growth.busy ||
              lessons.busy ||
              gradings.busy
            )
              throw new DomainError('BUSY', '模型连接检查尚未结束，请稍后生成解释。');
            return explanations.generate(input);
          case 'cancelExplanation':
            return explanations.cancel(input);
          case 'previewScores': {
            const { epoch } = epochInput.strip().parse(input);
            const generation = ++scoreSelectionGeneration;
            activeScorePreviewEpoch = epoch;
            try {
              // A failed re-preview must not leave the previous confirmation usable.
              const cancelled = await worker.call('cancelScorePreview', { epoch });
              if (!cancelled.ok) return cancelled;
              if (generation !== scoreSelectionGeneration)
                throw new DomainError('ABORTED', '已取消成绩预览。');
              if (Buffer.byteLength(JSON.stringify(input)) > MAX_SCORE_COMMAND_BYTES)
                throw new DomainError('VALIDATION', '请求内容超过支持范围。');
              const parsed = scoreFileInput.parse(input);
              const { fileToken, ...configuration } = parsed;
              if (!fileToken) {
                selectedScoreFile = undefined;
                const selected = await dialog.showOpenDialog(window!, {
                  properties: ['openFile'],
                  filters: [{ name: '成绩表', extensions: ['xlsx', 'csv'] }],
                });
                if (generation !== scoreSelectionGeneration)
                  throw new DomainError('ABORTED', '已取消成绩预览。');
                if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: null };
                const file = await readScoreFile(selected.filePaths[0], parsed.epoch);
                if (generation !== scoreSelectionGeneration)
                  throw new DomainError('ABORTED', '已取消成绩预览。');
                selectedScoreFile = file;
              } else if (
                !selectedScoreFile ||
                selectedScoreFile.token !== fileToken ||
                selectedScoreFile.epoch !== parsed.epoch
              ) {
                throw new DomainError('SCORE_FILE_EXPIRED', '成绩文件选择已失效，请重新选择文件。');
              }
              const file = selectedScoreFile!;
              const preview = await worker.call<PendingScoreView>('previewScoreBytes', {
                bytes: file.bytes,
                configuration: { ...configuration, format: file.format, fileName: file.name },
              });
              if (generation !== scoreSelectionGeneration)
                throw new DomainError('ABORTED', '已取消成绩预览。');
              return preview.ok
                ? {
                    ok: true,
                    value: { ...preview.value, fileToken: file.token, fileName: file.name },
                  }
                : preview;
            } finally {
              activeScorePreviewEpoch = undefined;
            }
          }
          case 'previewRosterImport': {
            const parsed = rosterImportInput.parse(input);
            const snapshot = await worker.call<Snapshot>('snapshot');
            if (!snapshot.ok) return snapshot;
            if (
              snapshot.value.epoch !== parsed.epoch ||
              !snapshot.value.classes.some((c) => c.id === parsed.classId)
            )
              throw new DomainError('CONFLICT', '班级或数据空间已变化，请刷新。');
            const cancelled = await worker.call('cancelRosterPreview', { epoch: parsed.epoch });
            if (!cancelled.ok) return cancelled;
            const selected = await dialog.showOpenDialog(window!, {
              properties: ['openFile'],
              filters: [{ name: '班级名册', extensions: ['xlsx', 'csv'] }],
            });
            if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: null };
            const file = await readScoreFile(selected.filePaths[0], parsed.epoch);
            return worker.call('previewRosterBytes', {
              bytes: file.bytes,
              format: file.format,
              fileName: file.name,
              configuration: parsed,
            });
          }
          case 'confirmRosterImport':
            return worker.call('confirmRosterImport', rosterConfirmInput.parse(input));
          case 'exportRosterTemplate': {
            const parsed = rosterTemplateInput.parse(input);
            const template = await worker.call<Uint8Array>('exportRosterTemplate', parsed);
            if (!template.ok) return template;
            return save(template.value, `班级名册空白模板.${parsed.format}`, parsed.format, true);
          }
          case 'cancelScorePreview': {
            const parsed = scoreCancelInput.parse(input);
            const ownedEpoch = activeScorePreviewEpoch ?? selectedScoreFile?.epoch;
            if (ownedEpoch && ownedEpoch !== parsed.epoch)
              return worker.call('cancelScorePreview', { epoch: parsed.epoch });
            scoreSelectionGeneration++;
            if (!parsed.keepSelectedFile) selectedScoreFile = undefined;
            return worker.call('cancelScorePreview', { epoch: parsed.epoch });
          }
          case 'confirmScores': {
            const result = await worker.call<ScoreConfirmation>('confirmScores', input);
            if (result.ok && !result.value.replayed) selectedScoreFile = undefined;
            return result;
          }
          case 'exportScoreTemplate': {
            const parsed = scoreTemplateInput.parse(input);
            const template = await worker.call<Uint8Array>('exportScoreTemplate', parsed);
            if (!template.ok) return template;
            return save(template.value, `score-template.${parsed.format}`, parsed.format, true);
          }
          case 'commitRestore': {
            conversation.invalidate();
            classroomDisplay.close();
            const result = await worker.call('commitRestore', input);
            if (result.ok) {
              devices.invalidate();
              conversationFiles.invalidate();
              models.invalidate();
              explanations.invalidate();
              growth.invalidate();
              lessons.invalidate();
              gradings.invalidate();
              materials.invalidate();
              materialFolders.invalidate();
              office.invalidate();
              scoreSelectionGeneration++;
              selectedScoreFile = undefined;
            }
            return result;
          }
          case 'saveBackup': {
            const backup = await worker.call<Uint8Array>('exportBackup', input);
            if (!backup.ok) return backup;
            return save(
              backup.value,
              `class-manager-${new Date().toISOString().slice(0, 10)}.cmbackup`,
              'cmbackup',
            );
          }
          case 'previewRestore': {
            const selected = await dialog.showOpenDialog(window!, {
              properties: ['openFile'],
              filters: [{ name: '班级管理备份', extensions: ['cmbackup'] }],
            });
            if (selected.canceled || !selected.filePaths[0]) return { ok: true, value: null };
            const path = selected.filePaths[0];
            requireRegularFile(path, MAX_BACKUP_BYTES);
            return worker.call('previewRestoreBytes', readFileSync(path));
          }
          case 'exportDiagnostics': {
            const snapshot = await worker.call<Snapshot>('snapshot');
            const modelResponses = (['deepseek', 'kimi', 'doubao'] as const).map((provider) => {
              try {
                return {
                  provider,
                  status: 'ready',
                  calls: conversationDiagnosticEntries(
                    models.ledger({ provider }).summary.recentEntries,
                  ),
                };
              } catch {
                // Keep database/system diagnostics available when a provider ledger is unreadable.
                return { provider, status: 'unavailable', calls: [] };
              }
            });
            const report = {
              format: 'class-manager-diagnostics',
              version: app.getVersion(),
              mode: 'local',
              createdAt: new Date().toISOString(),
              platform: process.platform,
              arch: process.arch,
              electron: process.versions.electron,
              node: process.versions.node,
              status: snapshot.ok ? 'ready' : 'unavailable',
              counts: snapshot.ok
                ? {
                    classrooms: snapshot.value.classes.length,
                    students: snapshot.value.students.length,
                    assets: snapshot.value.assets.length,
                    schema: snapshot.value.schemaVersion,
                  }
                : null,
              errors: recentErrors,
              modelResponses,
              printPreviewResidues: countPrintPreviewResidues(printCacheRoot),
            };
            return save(
              Buffer.from(JSON.stringify(report, null, 2)),
              'class-manager-diagnostics.json',
              'json',
            );
          }
          case 'getDeepSeekStatus': {
            return { ok: true, value: credentialStore.getStatus() };
          }
          case 'saveDeepSeekKey': {
            const parsed = saveDeepSeekKeyInput.parse(input);
            await invalidateModelWork();
            models.saveKey({ provider: 'deepseek', apiKey: parsed.apiKey });
            const status = credentialStore.getStatus();
            return { ok: true, value: status };
          }
          case 'deleteDeepSeekKey': {
            await invalidateModelWork();
            models.deleteKey({ provider: 'deepseek' });
            return { ok: true, value: true };
          }
          case 'cancelDeepSeekCheck': {
            if (currentCheckController) {
              currentCheckController.abort();
              return { ok: true, value: true };
            }
            return { ok: true, value: false };
          }
          case 'checkDeepSeek': {
            const parsed = checkDeepSeekInput.parse(input);
            if (
              currentCheckController ||
              conversation.busy ||
              models.busy ||
              growth.busy ||
              explanations.busy ||
              lessons.busy ||
              gradings.busy
            )
              throw new DomainError('BUSY', '另一项模型任务尚未结束，请先取消或等待。');
            const apiKey = credentialStore.loadKey();
            const credentialStatus = credentialStore.getStatus();
            const target =
              parsed.type === 'text'
                ? {
                    type: 'text_check' as const,
                    model: DEFAULT_TEXT_MODEL,
                    promptVersion: 'ping-v1',
                    runner: () =>
                      deepSeekClient.checkTextConnection(apiKey, { signal: controller.signal }),
                  }
                : {
                    type: 'vision_check' as const,
                    model: DEFAULT_VISION_MODEL,
                    promptVersion: 'synthetic-1x1-v1',
                    runner: () =>
                      deepSeekClient.checkVisionConnection(apiKey, { signal: controller.signal }),
                  };

            const controller = new AbortController();
            currentCheckController = controller;
            const timeout = setTimeout(() => controller.abort(), 30000);
            const callId = randomUUID();
            const startTime = Date.now();

            let recorded = false;
            try {
              // 先记录在途调用；写入失败也必须释放任务槽和计时器。
              ledger.startCall({
                id: callId,
                timestamp: new Date().toISOString(),
                type: target.type,
                requestModel: target.model,
                status: 'in_progress',
                durationMs: 0,
                promptVersion: target.promptVersion,
              });
              recorded = true;
              const result = await target.runner();
              result.credentialUpdatedAt = credentialStatus.updatedAt;
              ledger.completeCall(callId, {
                responseId: result.responseId,
                responseModel: result.model,
                status: 'success',
                durationMs: result.durationMs,
                usage: result.usage ?? undefined,
              });
              return { ok: true, value: result };
            } catch (error) {
              const durationMs = Date.now() - startTime;
              const errorCode = error instanceof DomainError ? error.code : 'UNKNOWN';
              if (recorded)
                ledger.completeCall(callId, {
                  status: 'failed',
                  errorCode,
                  durationMs,
                });
              throw error;
            } finally {
              clearTimeout(timeout);
              if (currentCheckController === controller) {
                currentCheckController = null;
              }
            }
          }
          case 'getDeepSeekLedger': {
            return { ok: true, value: ledger.getSummary() };
          }
          default:
            return worker.call(channel, input);
        }
      }

      const EXCLUSIVE_WORKSPACE_CHANNELS = new Set<Channel>([
        'scanMaterialFolder',
        'readMaterialFolder',
        'selectConversationFiles',
        'executeConversation',
        'configureModelProvider',
        'selectModelProvider',
        'saveModelProviderKey',
        'deleteModelProviderKey',
        'saveDeepSeekKey',
        'deleteDeepSeekKey',
        'measureNoise',
        'requestStudentCall',
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
        'createClassroom',
        'controlClassroom',
        'setCountdown',
        'openClassroomDisplay',
        'closeClassroomDisplay',
        'exportLessonOffice',
        'openLessonOffice',
        'previewMaterial',
        'confirmMaterial',
        'saveMaterialOriginal',
        'editLessonDraft',
        'createLessonDraft',
        'discardLessonDraft',
        'freezeLessonDraft',
        'reviseLessonVersion',
        'previewDutyPrint',
        'prepareDuty',
        'adjustDuty',
        'cancelDuty',
        'confirmDuty',
        'previewSeatingPrint',
        'prepareSeating',
        'adjustSeating',
        'cancelSeating',
        'confirmSeating',
        'createClass',
        'renameClass',
        'saveStudent',
        'previewRosterImport',
        'confirmRosterImport',
        'exportRosterTemplate',
        'saveStudentProfile',
        'saveAttendance',
        'setStudentActive',
        'seedDemo',
        'addSyntheticAsset',
        'saveBackup',
        'previewRestore',
        'commitRestore',
        'previewRecovery',
        'previewScores',
        'confirmScores',
        'exportScoreTemplate',
        'editExplanation',
        'discardExplanation',
      ]);

      for (const channel of CHANNELS) {
        ipcMain.handle(`cm:${channel}`, async (event, input: unknown) => {
          try {
            if (
              !window ||
              event.sender !== window.webContents ||
              !isTrustedSender(
                event.senderFrame?.url ?? '',
                indexUrl,
                event.senderFrame === window.webContents.mainFrame,
              )
            ) {
              throw new DomainError('FORBIDDEN', '已拒绝未授权的窗口调用。');
            }
            if (closePending && channel !== 'saveConversationHistory')
              throw new DomainError('BUSY', '正在保存课堂进度并退出，请稍后操作。');
            const maximum =
              channel === 'saveConversationHistory'
                ? 2 * 1024 * 1024
                : channel === 'saveAttendance'
                  ? 512 * 1024
                  : channel === 'saveStudentProfile'
                    ? 32 * 1024
                    : channel === 'saveGrowthEvent' ||
                        channel === 'createGrowthSummary' ||
                        channel === 'editGrowthSummary'
                      ? 128 * 1024
                      : channel === 'createRubric' ||
                          channel === 'createGrading' ||
                          channel === 'editGrading' ||
                          channel === 'rebindGrading'
                        ? MAX_GRADING_COMMAND_BYTES
                        : channel === 'prepareGrading'
                          ? 64 * 1024
                          : channel === 'editLessonDraft' || channel === 'createLessonDraft'
                            ? MAX_LESSON_COMMAND_BYTES
                            : channel === 'prepareLesson'
                              ? 64 * 1024
                              : channel === 'previewScores' ||
                                  channel === 'exportScoreTemplate' ||
                                  channel === 'editExplanation'
                                ? MAX_SCORE_COMMAND_BYTES
                                : channel === 'prepareDuty' || channel === 'adjustDuty'
                                  ? MAX_DUTY_COMMAND_BYTES
                                  : 16384;
            if (
              channel !== 'previewScores' &&
              input !== undefined &&
              Buffer.byteLength(JSON.stringify(input)) > maximum
            ) {
              throw new DomainError('VALIDATION', '请求内容超过支持范围。');
            }

            if (operationBusy && MODEL_WORK_CHANNELS.has(channel))
              throw new DomainError('BUSY', '配置或数据操作尚未结束，模型准备与外发暂不可用。');
            const isExclusive = EXCLUSIVE_WORKSPACE_CHANNELS.has(channel);
            if (isExclusive) {
              if (materialFolders.busy && channel !== 'readMaterialFolder')
                throw new DomainError('BUSY', '请先完成或取消文件夹读取。');
              if (operationBusy) throw new DomainError('BUSY', '另一项操作正在进行，请稍后重试。');
              operationBusy = true;
            }
            try {
              const result = await dispatch(channel, input);
              if (!result.ok) remember(result.error);
              return result;
            } finally {
              if (isExclusive) {
                operationBusy = false;
              }
            }
          } catch (error) {
            const masked = publicError(error);
            remember(masked);
            return { ok: false, error: masked };
          }
        });
      }
      void window.loadURL(indexUrl);
    })
    .catch((error: unknown) => {
      const masked = publicError(error);
      dialog.showErrorBox('启动失败', `${masked.message}\n${masked.code}\n${masked.operationId}`);
      app.quit();
    });
}
