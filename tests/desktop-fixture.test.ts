import { afterEach, expect, test, vi } from 'vitest';
import { installDesktopCheckFixture, type DesktopCheckFixture } from './fixtures/desktop-check';

const scope = globalThis as typeof globalThis & { __cmCheckFixture?: DesktopCheckFixture };
afterEach(() => {
  delete scope.__cmCheckFixture;
});

test('desktop fixture intercepts IPC without mutating the frozen bridge', async () => {
  type Input = { type: 'text' | 'vision' };
  type Handler = (event: unknown, input: Input) => unknown;
  const realProvider = vi.fn(() => {
    throw new Error('Real provider must not be reached');
  });
  const handlers = new Map<string, Handler>([['cm:checkDeepSeek', realProvider]]);
  const bridge = Object.freeze({
    checkDeepSeek: (input: Input) => handlers.get('cm:checkDeepSeek')!(undefined, input),
    cancelDeepSeekCheck: () => handlers.get('cm:cancelDeepSeekCheck')!(undefined, { type: 'text' }),
  });
  const originalCheck = bridge.checkDeepSeek;

  // Playwright transports the function source into Main; test that same boundary.
  const install = new Function(
    `return (${installDesktopCheckFixture.toString()})`,
  )() as typeof installDesktopCheckFixture;
  install({
    ipcMain: {
      removeHandler: (channel) => {
        handlers.delete(channel);
      },
      handle: (channel, handler) => {
        handlers.set(channel, handler);
      },
    },
  });
  const fixture = scope.__cmCheckFixture!;
  for (const success of [true, false]) {
    let settled = false;
    const pending = Promise.resolve(bridge.checkDeepSeek({ type: 'text' })).then((value) => {
      settled = true;
      return value;
    });
    await fixture.started;
    expect(bridge.cancelDeepSeekCheck()).toEqual({ ok: true, value: true });
    await Promise.resolve();
    expect(settled).toBe(false);
    fixture.release!({ success, message: 'late fixture reply' });
    const result = await pending;
    expect(result).toMatchObject(
      success
        ? { ok: true, value: { message: 'late fixture reply' } }
        : { ok: false, error: { code: 'AUTH_FAILED', message: 'late fixture reply' } },
    );
  }
  expect(fixture).toMatchObject({ calls: 2, replies: 2, cancellations: 2, release: null });
  expect(realProvider).not.toHaveBeenCalled();
  expect(Object.isFrozen(bridge)).toBe(true);
  expect(bridge.checkDeepSeek).toBe(originalCheck);
});
