import { BrowserWindow, ipcMain } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { classroomReadInput, type ClassroomTeacherView } from '../shared/classroom';
import { DomainError, publicError } from '../core/errors';
import { isTrustedSender } from './security';
import type { WorkerClient } from './worker-client';

/** Binds one display to one approved session. No administrative bridge is loaded here. */
export class ClassroomDisplay {
  private binding?: { window: BrowserWindow; epoch: string; id: string };
  private readonly url = pathToFileURL(join(__dirname, '../renderer/classroom.html')).href;
  constructor(private readonly worker: Pick<WorkerClient, 'call'>) {
    for (const operation of ['projection', 'clock', 'fullscreen'] as const) {
      ipcMain.handle(`cm-display:${operation}`, async (event, input: unknown) => {
        try {
          const binding = this.binding;
          if (
            !binding ||
            event.sender !== binding.window.webContents ||
            !isTrustedSender(
              event.senderFrame?.url ?? '',
              this.url,
              event.senderFrame === binding.window.webContents.mainFrame,
            )
          )
            throw new DomainError('FORBIDDEN', '已拒绝未授权的展示窗口调用。');
          if (operation === 'fullscreen') {
            const request = z.object({ fullscreen: z.boolean() }).strict().parse(input);
            binding.window.setFullScreen(request.fullscreen);
            return { ok: true, value: undefined };
          }
          const request = { epoch: binding.epoch, id: binding.id };
          if (operation === 'clock') {
            if (input !== undefined)
              throw new DomainError('VALIDATION', '展示计时不接受额外参数。');
            return this.worker.call('readClassroomClock', request);
          }
          const options = z
            .object({ knownRevision: z.number().int().positive().optional() })
            .strict()
            .parse(input);
          return this.worker.call('readClassroomProjection', { ...request, ...options });
        } catch (error) {
          return { ok: false, error: publicError(error) };
        }
      });
    }
  }
  async open(raw: unknown) {
    const input = classroomReadInput.parse(raw);
    const result = await this.worker.call<ClassroomTeacherView>('readClassroom', input);
    if (!result.ok) throw new DomainError(result.error.code, result.error.message);
    let view = result.value;
    // Reopening never silently reprojects answers left visible in an earlier display.
    for (const action of ['answers', 'questions'] as const) {
      if (!view.record.payload[action === 'answers' ? 'answersVisible' : 'questionsVisible'])
        continue;
      const hidden = await this.worker.call<ClassroomTeacherView>('controlClassroom', {
        ...input,
        expectedRevision: view.record.revision,
        action,
        visible: false,
      });
      if (!hidden.ok) throw new DomainError(hidden.error.code, hidden.error.message);
      view = hidden.value;
    }
    this.close();
    const window = new BrowserWindow({
      width: 1280,
      height: 800,
      minWidth: 360,
      minHeight: 540,
      show: false,
      fullscreen: true,
      title: '课堂展示',
      backgroundColor: '#ffffff',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(__dirname, 'classroom-preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webviewTag: false,
      },
    });
    const binding = { window, epoch: input.epoch, id: input.id };
    this.binding = binding;
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event) => event.preventDefault());
    window.webContents.on('will-attach-webview', (event) => event.preventDefault());
    window.on('closed', () => {
      if (this.binding === binding) this.binding = undefined;
    });
    try {
      await window.loadURL(this.url);
      window.show();
    } catch (error) {
      if (this.binding === binding) this.close();
      throw error;
    }
  }
  close() {
    const binding = this.binding;
    this.binding = undefined;
    if (binding && !binding.window.isDestroyed()) binding.window.close();
  }
}
