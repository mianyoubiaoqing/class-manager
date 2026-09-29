import { parentPort } from 'node:worker_threads';

parentPort?.postMessage({ id: 0, result: { ok: true, value: null } });
parentPort?.on('message', () => {
  /* Simulate a worker that never returns a result. */
});
