import { GrowthRunner } from './growth-runner';
import * as fs from 'node:fs/promises';
import { createResourcePrintDocument } from '../core/resource-print';
import { openPrintPreview } from './print-preview';
import {
  classDataSelectInput,
  classDataConfigureInput,
  classDataConfirmInput,
} from '../shared/class-data-import';
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
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  safeStorage,
  session,
  shell,
  Notification,
} from 'electron';
import { z } from 'zod';
import sharp from 'sharp';
import { WorkBuddyBridge } from './workbuddy-bridge';
import { findWorkBuddy, registerWorkBuddy, type WorkBuddyServer } from './workbuddy-registration';
import { discoverWorkBuddyWindows } from './workbuddy-discovery';
import { teachingReport } from './teaching-reports';
import type { TeachingRecord, TeachingSettings } from '../shared/teaching-workbench';
import { randomUUID } from 'node:crypto';
import { readFileSync, mkdirSync, rmSync } from 'node:fs';
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
import {
  resourceReadInput,
  resourceFolderReadInput,
  resourceAttachmentInput,
  resourceExportInput,
  resourceSection,
  resourceTypes,
  resourceFileExtensions,
  type ResourceReadInput,
  type ResourceAttachment,
} from '../shared/resource-library';
import { MAX_ASSET_BYTES } from '../core/storage-limits';
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
      if (process.platform === 'win32' && app.isPackaged) {
        const isolated = Boolean(process.env.CLASS_MANAGER_DATA_DIR);
        const notificationId = isolated
          ? `local.classmanager.test.${randomUUID()}`
          : 'local.classmanager.desktop';
        app.setAppUserModelId(notificationId);
        const shortcutDirectory = join(
          app.getPath('appData'),
          'Microsoft',
          'Windows',
          'Start Menu',
          'Programs',
        );
        const shortcut = join(
          shortcutDirectory,
          isolated ? `${notificationId}.lnk` : 'Class Manager 教师提醒.lnk',
        );
        mkdirSync(shortcutDirectory, { recursive: true });
        shell.writeShortcutLink(shortcut, {
          target: process.execPath,
          description: '班级助手 教师工作台',
          appUserModelId: notificationId,
          toastActivatorClsid: app.toastActivatorCLSID,
        });
        if (isolated) app.on('will-quit', () => rmSync(shortcut, { force: true }));
      }
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
      let resourceFolderTarget: ResourceReadInput | undefined;
      const importResourceFile = async (path: string, target: ResourceReadInput) => {
        await assertLocalScorePath(path);
        requireRegularFile(path, MAX_ASSET_BYTES);
        const before = await fs.stat(path);
        const bytes = await fs.readFile(path);
        const after = await fs.stat(path);
        if (
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          bytes.length !== before.size
        )
          throw new DomainError('CONFLICT', '文件在读取时发生变化，请重新选择。');
        const result = await worker.call<ResourceAttachment>('storeResourceFile', {
          ...target,
          name: basename(path),
          bytes,
        });
        if (!result.ok) throw new DomainError(result.error.code, result.error.message);
        return result.value;
      };
      const resourceFolders = new MaterialFolders(
        materials,
        async () => {
          const current = await worker.call<Snapshot>('snapshot');
          if (!current.ok) throw new DomainError(current.error.code, current.error.message);
          return current.value.epoch;
        },
        {
          extensions: resourceFileExtensions.map((e) => '.' + e),
          maxBytes: MAX_ASSET_BYTES,
          importFile: async (path) => {
            if (!resourceFolderTarget) throw new DomainError('CONFLICT', '请重新选择教材章节。');
            return (await importResourceFile(path, resourceFolderTarget)).id;
          },
        },
      );
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
        resourceFolders.invalidate();
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

      function workBuddyServer(): WorkBuddyServer {
        return {
          command: process.execPath,
          args: [
            app.isPackaged
              ? join(process.resourcesPath, 'mcp-stdio.cjs')
              : join(__dirname, 'mcp-stdio.cjs'),
            '--connection',
            join(userDataPath, 'workbuddy-connection.json'),
          ],
          env: { ELECTRON_RUN_AS_NODE: '1' },
        };
      }
      async function locateWorkBuddy() {
        const home = app.getPath('home');
        let remembered: string[] = [];
        try {
          const parsed: unknown = JSON.parse(
            await fs.readFile(join(userDataPath, 'workbuddy-desktop.json'), 'utf8'),
          );
          if (typeof parsed === 'string') remembered = [parsed];
        } catch {
          /* First use or a removed installation; rediscover below. */
        }
        const known = findWorkBuddy(home, process.env, remembered);
        return known ?? findWorkBuddy(home, process.env, await discoverWorkBuddyWindows());
      }
      async function dispatch(channel: Channel, input: unknown): Promise<Result<unknown>> {
        switch (channel) {
          case 'previewResourcePrint': {
            const request = resourceExportInput.parse(input);
            const current = await worker.call('readResourceDocument', {
              epoch: request.epoch,
              key: request.key,
              type: request.type,
            });
            if (!current.ok) return current;
            return {
              ok: true,
              value: await openPrintPreview(
                window!,
                createResourcePrintDocument(request),
                { temp: printCacheRoot, documents: app.getPath('documents'), dataRoot: root },
                'resource',
              ),
            };
          }
          case 'readResourceDocument':
          case 'saveResourceDocument':
          case 'listResourceAttachments':
          case 'addResourceLink':
          case 'removeResourceAttachment':
            return worker.call(channel, input);
          case 'selectResourceFiles': {
            const target = resourceReadInput.parse(input);
            resourceSection(target.key);
            const selected = await dialog.showOpenDialog(window!, {
              title: '添加本地教学资料',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: '教学资料', extensions: resourceFileExtensions }],
            });
            if (selected.canceled) return { ok: true, value: { cancelled: true, files: [] } };
            if (selected.filePaths.length > 25)
              throw new DomainError('VALIDATION', '每次最多添加 25 份文件。');
            const files = [];
            for (const path of selected.filePaths) {
              try {
                const stored = await importResourceFile(path, target);
                files.push({ name: basename(path), id: stored.id });
              } catch (error) {
                files.push({
                  name: basename(path),
                  error:
                    error instanceof DomainError
                      ? error.message
                      : '文件无法读取，请检查格式或权限。',
                });
              }
            }
            return { ok: true, value: { cancelled: false, files } };
          }
          case 'scanResourceFolder':
            return {
              ok: true,
              value: await resourceFolders.scan(input, async () => {
                const selected = await dialog.showOpenDialog(window!, {
                  title: '选择教学资源文件夹',
                  properties: ['openDirectory'],
                });
                return selected.canceled ? null : (selected.filePaths[0] ?? null);
              }),
            };
          case 'readResourceFolder': {
            const request = resourceFolderReadInput.parse(input);
            resourceSection(request.key);
            resourceFolderTarget = { epoch: request.epoch, key: request.key, type: request.type };
            try {
              return {
                ok: true,
                value: await resourceFolders.read({
                  epoch: request.epoch,
                  token: request.token,
                  ids: request.ids,
                }),
              };
            } finally {
              resourceFolderTarget = undefined;
            }
          }
          case 'openResourceAttachment': {
            const request = resourceAttachmentInput.parse(input);
            const result = await worker.call<{
              id: string;
              name: string;
              url: string | null;
              bytes?: Uint8Array;
            }>('readResourceFile', request);
            if (!result.ok) return result;
            if (result.value.url) await shell.openExternal(result.value.url);
            else {
              const directory = join(userDataPath, 'resource-open', request.epoch, result.value.id);
              await fs.mkdir(directory, { recursive: true });
              const path = join(directory, result.value.name);
              await assertLocalScorePath(path);
              atomicWrite(path, Buffer.from(result.value.bytes!));
              const error = await shell.openPath(path);
              if (error)
                throw new DomainError(
                  'STORAGE_ERROR',
                  '文件已保存，但电脑没有可打开它的软件，请安装对应软件后重试。',
                );
            }
            return { ok: true, value: undefined };
          }
          case 'exportResourceDocument': {
            const request = resourceExportInput.parse(input);
            const current = await worker.call('readResourceDocument', {
              epoch: request.epoch,
              key: request.key,
              type: request.type,
            });
            if (!current.ok) return current;
            const section = resourceSection(request.key),
              title = section.section.title + ' · ' + resourceTypes[request.type];
            const rows: string[][] = [];
            for (const line of request.body.split('\n')) {
              if (!line) {
                rows.push(['']);
                continue;
              }
              for (let start = 0; start < line.length; start += 9000)
                rows.push([line.slice(start, start + 9000)]);
            }
            const bytes = await officeTask.generateTeachingReport({
              title,
              format: 'docx',
              layout: 'paragraphs',
              rows,
            });
            return save(bytes.bytes, title.replace(/[<>:"/\\|?*]/g, '_') + '.docx', 'docx');
          }

          case 'exportTeachingSeatingImage': {
            const result = await worker.call<SeatingVersionView>('readSeatingVersion', input);
            if (!result.ok) return result;
            const { arrangement, className } = result.value.payload;
            const escape = (text: string) =>
              text.replace(
                /[<>&"']/g,
                (char) =>
                  ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[char]!,
              );
            const width = Math.max(480, arrangement.layout.columns * 110 + 40),
              height = arrangement.layout.rows * 76 + 140;
            let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/><g font-family="Microsoft YaHei, sans-serif"><text x="20" y="32" font-size="22">${escape(className)} · 座位表</text><text x="${width / 2}" y="80" text-anchor="middle" font-size="18">讲台</text>`;
            for (let row = 1; row <= arrangement.layout.rows; row++)
              for (let column = 1; column <= arrangement.layout.columns; column++) {
                const a = arrangement.assignments.find((a) => a.row === row && a.column === column);
                const member = arrangement.members.find((m) => m.studentId === a?.studentId);
                const x = 20 + (column - 1) * 110,
                  y = 105 + (row - 1) * 76;
                svg += `<rect x="${x}" y="${y}" width="100" height="64" rx="8" fill="#eef7ef" stroke="#c1dfc7"/><text x="${x + 50}" y="${y + 28}" text-anchor="middle" font-size="16">${escape(member?.displayName ?? '空位')}</text><text x="${x + 50}" y="${y + 49}" text-anchor="middle" font-size="11">${escape(member?.studentNumber ?? `${row}排${column}列`)}</text>`;
              }
            const png = await sharp(Buffer.from(svg + '</g></svg>'))
              .png()
              .toBuffer();
            return save(png, `${className.replace(/[<>:"/\\|?*]/g, '_')}-座位表.png`, 'png');
          }
          case 'openWorkBuddy':
            {
              const installed = await locateWorkBuddy();
              if (installed) {
                const error = await shell.openPath(installed);
                if (error)
                  throw new DomainError('STORAGE_ERROR', '未能打开 WorkBuddy，请从桌面启动它。');
              } else await shell.openExternal('https://www.workbuddy.cn/');
            }
            return { ok: true, value: null };
          case 'startWorkBuddyConnection': {
            let installed = await locateWorkBuddy();
            if (!installed) {
              const selected = await dialog.showOpenDialog(window!, {
                title: '自动检测未找到 WorkBuddy，请选择已安装的 WorkBuddy.exe（未安装可取消）',
                properties: ['openFile'],
                filters: [{ name: 'WorkBuddy 桌面程序', extensions: ['exe'] }],
              });
              if (!selected.canceled && selected.filePaths[0]) {
                installed = findWorkBuddy(app.getPath('home'), {}, [selected.filePaths[0]]);
                if (!installed)
                  throw new DomainError(
                    'VALIDATION',
                    '请选择已安装的 WorkBuddy.exe 或 WorkBuddyAI.exe，不能选择安装包或其他程序。',
                  );
                atomicWrite(
                  join(userDataPath, 'workbuddy-desktop.json'),
                  JSON.stringify(installed),
                );
              }
            }
            if (!installed)
              return {
                ok: true,
                value: {
                  installed: false,
                  registered: false,
                  changed: false,
                  firstRegistration: false,
                  launched: false,
                  active: false,
                },
              };
            const registration = registerWorkBuddy(app.getPath('home'), workBuddyServer());
            const launchError = await shell.openPath(installed);
            return {
              ok: true,
              value: {
                ...registration,
                installed: true,
                launched: !launchError,
                active: bridge.active,
                ...(launchError
                  ? { launchError: '已注册，但未能打开 WorkBuddy，请从桌面启动它。' }
                  : {}),
              },
            };
          }
          case 'workBuddyConnection':
            return {
              ok: true,
              value: {
                configuration: JSON.stringify(
                  {
                    mcpServers: {
                      'class-manager': {
                        ...workBuddyServer(),
                      },
                    },
                  },
                  null,
                  2,
                ),
                active: bridge.active,
              },
            };
          case 'listBridgeProposals':
            return { ok: true, value: bridge.list() };
          case 'resolveBridgeProposal':
            return { ok: true, value: await bridge.resolve(input) };
          case 'exportTeachingReport': {
            const report = await teachingReport(worker, input, officeTask);
            return save(report.bytes, report.name, report.extension);
          }
          case 'selectTeachingPhotos': {
            const request = z.object({ epoch: z.uuid(), classId: z.uuid() }).strict().parse(input);
            const selected = await dialog.showOpenDialog(window!, {
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: '活动照片', extensions: ['png', 'jpg', 'jpeg', 'webp'] }],
            });
            if (selected.canceled) return { ok: true, value: [] };
            if (selected.filePaths.length > 30)
              throw new DomainError('VALIDATION', '每次最多选择 30 张照片。');
            const value = [];
            for (const path of selected.filePaths) {
              requireRegularFile(path, 10 * 1024 * 1024);
              const original = readFileSync(path);
              if (original.length > 10 * 1024 * 1024)
                throw new DomainError('VALIDATION', '单张照片须小于 10 MiB。');
              let bytes: Buffer;
              try {
                bytes = await materialTask.teachingPhoto(original);
              } catch {
                throw new DomainError(
                  'VALIDATION',
                  '照片无法读取，请选择完整的 PNG、JPG 或 WebP 图片（不超过 4000 万像素）。',
                );
              }
              const stored = await worker.call('storeTeachingPhoto', {
                ...request,
                name: basename(path),
                bytes,
              });
              if (!stored.ok) return stored;
              value.push(stored.value);
            }
            return { ok: true, value };
          }
          case 'saveTeachingExam': {
            const request = z
              .object({
                configuration: z.unknown(),
                csv: z.string().max(5 * 1024 * 1024),
                requestId: z.uuid(),
                reason: z.string().trim().min(1).max(300),
              })
              .strict()
              .parse(input);
            const configuration = scoreFileInput.parse(request.configuration);
            const preview = await worker.call<PendingScoreView>('previewScoreBytes', {
              configuration: { ...configuration, fileName: '工作台成绩录入.csv', format: 'csv' },
              bytes: Buffer.from(request.csv, 'utf8'),
            });
            if (!preview.ok) return preview;
            if (!preview.value.canConfirm || !preview.value.token)
              throw new DomainError(
                'VALIDATION',
                preview.value.issues
                  .map((i) => i.message)
                  .slice(0, 3)
                  .join('；') || '成绩存在无效值，请检查学生、科目满分和缺考标记。',
              );
            return worker.call('confirmScores', {
              epoch: configuration.epoch,
              token: preview.value.token,
              expectedRevision: configuration.expectedRevision,
              requestId: request.requestId,
              reason: request.reason,
            });
          }
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
          case 'selectClassData': {
            const parsed = classDataSelectInput.parse(input);
            const snapshot = await worker.call<Snapshot>('snapshot');
            if (!snapshot.ok) return snapshot;
            if (
              snapshot.value.epoch !== parsed.epoch ||
              !snapshot.value.classes.some((c) => c.id === parsed.classId)
            )
              throw new DomainError('CONFLICT', '班级或数据空间已变化，请刷新。');
            const cancelled = await worker.call('cancelClassData', parsed);
            if (!cancelled.ok) return cancelled;
            const selected = await dialog.showOpenDialog(window!, {
              title: '选择学生信息 / 成绩文件（最多两份）',
              properties: ['openFile', 'multiSelections'],
              filters: [{ name: '班级资料', extensions: ['xlsx', 'csv'] }],
            });
            if (selected.canceled || !selected.filePaths.length) return { ok: true, value: null };
            if (selected.filePaths.length > 2)
              throw new DomainError(
                'VALIDATION',
                '最多选择两份文件；可以把学生信息和成绩放在同一工作簿。',
              );
            const files = [];
            for (const path of selected.filePaths) {
              const file = await readScoreFile(path, parsed.epoch);
              files.push({ bytes: file.bytes, format: file.format, fileName: file.name });
            }
            return worker.call('selectClassDataBytes', { files, configuration: parsed });
          }
          case 'configureClassData':
            return worker.call('configureClassData', classDataConfigureInput.parse(input));
          case 'confirmClassData':
            return worker.call('confirmClassData', classDataConfirmInput.parse(input));
          case 'cancelClassData':
            return worker.call('cancelClassData', classDataSelectInput.parse(input));
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
              resourceFolders.invalidate();
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
        'previewResourcePrint',
        'saveResourceDocument',
        'selectResourceFiles',
        'scanResourceFolder',
        'readResourceFolder',
        'addResourceLink',
        'removeResourceAttachment',
        'openResourceAttachment',
        'exportResourceDocument',
        'saveTeachingRecord',
        'deleteTeachingRecord',
        'saveTeachingSettings',
        'saveTeachingExam',
        'selectTeachingPhotos',
        'exportTeachingReport',
        'resolveBridgeProposal',
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
        'selectClassData',
        'configureClassData',
        'confirmClassData',
        'cancelClassData',
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

      const bridge = new WorkBuddyBridge(
        join(userDataPath, 'workbuddy-connection.json'),
        async () => {
          const result = await worker.call<Snapshot>('snapshot');
          if (!result.ok) throw new DomainError(result.error.code, result.error.message);
          return result.value;
        },
        async (channel, input) => {
          if (closePending) throw new DomainError('BUSY', '工作台正在退出。');
          const result = await dispatch(channel, input);
          if (!result.ok) throw new DomainError(result.error.code, result.error.message);
          return result.value;
        },
      );
      await bridge.start();
      const notificationStart = Date.now();
      let notificationBusy = false;
      const teachingReminders = setInterval(() => {
        if (operationBusy || closePending || notificationBusy) return;
        notificationBusy = true;
        void (async () => {
          const snapshot = await worker.call<Snapshot>('snapshot');
          if (!snapshot.ok) return;
          const epoch = snapshot.value.epoch;
          const settings = await worker.call<TeachingSettings>('readTeachingSettings', { epoch });
          const due = await worker.call<TeachingRecord[]>('dueTeachingReminders', {
            epoch,
            now: new Date().toISOString(),
            since: new Date(notificationStart).toISOString(),
          });
          if (!settings.ok || !due.ok) return;
          for (const record of due.value) {
            if (!('dueAt' in record.content) || !('text' in record.content)) continue;
            if (
              Date.parse(record.content.dueAt) >= notificationStart &&
              settings.value.notifications &&
              Notification.isSupported()
            ) {
              const notification = new Notification({
                title: '教师工作台 · 事项提醒',
                body: record.content.text,
                silent: !settings.value.sound,
              });
              notification.on('click', () => {
                if (window?.isMinimized()) window.restore();
                window?.show();
                window?.focus();
              });
              notification.show();
            }
            await worker.call('acknowledgeTeachingReminder', {
              epoch,
              id: record.id,
              dueAt: record.content.dueAt,
            });
          }
        })()
          .catch((error) => remember(publicError(error)))
          .finally(() => {
            notificationBusy = false;
          });
      }, 5000);
      app.on('will-quit', () => {
        clearInterval(teachingReminders);
        bridge.close();
      });

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
              channel === 'saveConversationHistory' ||
              channel === 'saveResourceDocument' ||
              channel === 'exportResourceDocument' ||
              channel === 'previewResourcePrint'
                ? 2 * 1024 * 1024
                : channel === 'saveTeachingExam'
                  ? MAX_SCORE_COMMAND_BYTES
                  : channel === 'saveTeachingRecord'
                    ? 128 * 1024
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
                                      channel === 'configureClassData' ||
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
