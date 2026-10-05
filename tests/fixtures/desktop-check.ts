export interface DesktopCheckReply {
  success: boolean;
  message: string;
}

export interface DesktopCheckFixture {
  calls: number;
  cancellations: number;
  replies: number;
  started: Promise<void>;
  onStarted: () => void;
  release: ((reply: DesktopCheckReply) => void) | null;
}

interface TestIpc {
  removeHandler(channel: string): void;
  handle(
    channel: string,
    handler: (_event: unknown, input: { type: 'text' | 'vision' }) => unknown,
  ): void;
}

/** Serialized into a disposable Electron main process; no runtime closure dependencies. */
export function installDesktopCheckFixture({ ipcMain }: { ipcMain: TestIpc }): void {
  const fixture: DesktopCheckFixture = {
    calls: 0,
    cancellations: 0,
    replies: 0,
    started: Promise.resolve(),
    onStarted: () => {},
    release: null,
  };
  const arm = () => {
    fixture.started = new Promise((resolve) => {
      fixture.onStarted = resolve;
    });
  };
  arm();
  (globalThis as typeof globalThis & { __cmCheckFixture: DesktopCheckFixture }).__cmCheckFixture =
    fixture;
  ipcMain.removeHandler('cm:checkDeepSeek');
  ipcMain.removeHandler('cm:cancelDeepSeekCheck');
  ipcMain.handle('cm:checkDeepSeek', (_event, input) => {
    if (fixture.release) throw new Error('Unexpected overlapping fixture request');
    fixture.calls++;
    return new Promise((resolve) => {
      fixture.release = ({ success, message }) => {
        fixture.release = null;
        fixture.replies++;
        arm();
        resolve(
          success
            ? {
                ok: true,
                value: {
                  type: input.type,
                  success: true,
                  model: 'synthetic-desktop-fixture',
                  durationMs: 1,
                  usage: null,
                  message,
                  timestamp: new Date().toISOString(),
                  promptVersion: 'desktop-fixture-v1',
                },
              }
            : {
                ok: false,
                error: { code: 'AUTH_FAILED', message, operationId: 'desktop-fixture' },
              },
        );
      };
      fixture.onStarted();
    });
  });
  ipcMain.handle('cm:cancelDeepSeekCheck', () => {
    fixture.cancellations++;
    // Ignore cancellation deliberately: the real renderer must reject the late reply.
    return { ok: true, value: true };
  });
}
