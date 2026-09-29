import { app, BrowserWindow, dialog, ipcMain, safeStorage, session } from 'electron';
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CHANNELS,
  checkDeepSeekInput,
  saveDeepSeekKeyInput,
  type Channel,
  type PublicError,
  type Receipt,
  type Result,
  type Snapshot,
} from '../shared/contracts';
import { MAX_BACKUP_BYTES } from '../core/backup';
import { atomicWrite, requireRegularFile } from '../core/files';
import { DomainError, publicError } from '../core/errors';
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

app.setName('Class Manager');
if (process.env.CLASS_MANAGER_DATA_DIR)
  app.setPath('userData', resolve(process.env.CLASS_MANAGER_DATA_DIR));
let window: BrowserWindow | undefined;
let operationBusy = false;
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
    .then(() => {
      const root = join(app.getPath('userData'), 'workspace-data');
      const worker = new WorkerClient(join(__dirname, 'worker.cjs'), root);
      const userDataPath = app.getPath('userData');
      const cryptoProvider: CryptoProvider = {
        isAvailable: () => safeStorage.isEncryptionAvailable(),
        encrypt: (plain: string) => safeStorage.encryptString(plain),
        decrypt: (cipher: Buffer) => safeStorage.decryptString(cipher),
      };
      const credentialStore = new DeepSeekCredentialStore(userDataPath, cryptoProvider);
      const ledger = new DeepSeekLedger(userDataPath);
      const deepSeekClient = new DeepSeekClient();
      let currentCheckController: AbortController | null = null;
      app.on('will-quit', () => {
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
      window.on('close', (event) => {
        if (operationBusy) {
          event.preventDefault();
          void dialog.showMessageBox(window!, {
            type: 'info',
            message: '操作尚未结束，请稍后退出。',
            detail: '正在保存、备份或恢复数据。',
            buttons: ['确定'],
          });
        }
      });

      async function save(
        bytes: Uint8Array,
        name: string,
        extension: string,
      ): Promise<Result<Receipt | null>> {
        const selected = await dialog.showSaveDialog(window!, {
          defaultPath: join(app.getPath('documents'), name),
          filters: [
            {
              name: extension === 'cmbackup' ? '班级管理备份' : '诊断信息',
              extensions: [extension],
            },
          ],
          properties: ['showOverwriteConfirmation', 'createDirectory'],
        });
        if (selected.canceled || !selected.filePath) return { ok: true, value: null };
        assertExportDestination(selected.filePath, root);
        atomicWrite(selected.filePath, bytes);
        return {
          ok: true,
          value: { path: selected.filePath, createdAt: new Date().toISOString() },
        };
      }

      async function dispatch(channel: Channel, input: unknown): Promise<Result<unknown>> {
        switch (channel) {
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
            const report = {
              format: 'class-manager-diagnostics',
              version: app.getVersion(),
              mode: 'synthetic',
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
            const status = credentialStore.saveKey(parsed.apiKey);
            return { ok: true, value: status };
          }
          case 'deleteDeepSeekKey': {
            credentialStore.deleteKey();
            return { ok: true, value: true };
          }
          case 'cancelDeepSeekCheck': {
            if (currentCheckController) {
              currentCheckController.abort();
              currentCheckController = null;
              return { ok: true, value: true };
            }
            return { ok: true, value: false };
          }
          case 'checkDeepSeek': {
            const parsed = checkDeepSeekInput.parse(input);
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

            if (currentCheckController) {
              currentCheckController.abort();
            }
            const controller = new AbortController();
            currentCheckController = controller;
            const timeout = setTimeout(() => controller.abort(), 30000);
            const startTime = Date.now();
            try {
              const result = await target.runner();
              result.credentialUpdatedAt = credentialStatus.updatedAt;
              ledger.record({
                id: randomUUID(),
                responseId: result.responseId,
                timestamp: result.timestamp,
                type: target.type,
                requestModel: target.model,
                responseModel: result.model,
                status: 'success',
                durationMs: result.durationMs,
                usage: result.usage ?? undefined,
                promptVersion: result.promptVersion,
              });
              return { ok: true, value: result };
            } catch (error) {
              const durationMs = Date.now() - startTime;
              const errorCode = error instanceof DomainError ? error.code : 'UNKNOWN';
              ledger.record({
                id: randomUUID(),
                timestamp: new Date().toISOString(),
                type: target.type,
                requestModel: target.model,
                status: 'failed',
                errorCode,
                durationMs,
                promptVersion: target.promptVersion,
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
        'createClass',
        'renameClass',
        'saveStudent',
        'setStudentActive',
        'seedDemo',
        'addSyntheticAsset',
        'saveBackup',
        'previewRestore',
        'commitRestore',
        'previewRecovery',
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
            if (input !== undefined && Buffer.byteLength(JSON.stringify(input)) > 16384) {
              throw new DomainError('VALIDATION', '请求内容超过支持范围。');
            }

            const isExclusive = EXCLUSIVE_WORKSPACE_CHANNELS.has(channel);
            if (isExclusive) {
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
