import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { Workspace } from '../core/workspace';
import { publicError } from '../core/errors';

const port = parentPort;
if (!port) throw new Error('Workspace worker requires a parent port');
const requestSchema = z
  .object({
    id: z.number().int(),
    operation: z.enum([
      'snapshot',
      'createClass',
      'renameClass',
      'saveStudent',
      'setStudentActive',
      'seedDemo',
      'addSyntheticAsset',
      'exportBackup',
      'previewRestoreBytes',
      'commitRestore',
      'previewRecovery',
    ]),
    input: z.unknown().optional(),
  })
  .strict();

try {
  const { root } = z.object({ root: z.string() }).strict().parse(workerData);
  const workspace = new Workspace(root);
  port.postMessage({ id: 0, result: { ok: true, value: null } });
  port.on('message', (raw: unknown) => {
    const request = requestSchema.safeParse(raw);
    if (!request.success) return;
    const { id, operation, input } = request.data;
    try {
      let value: unknown;
      switch (operation) {
        case 'snapshot':
          value = workspace.snapshot();
          break;
        case 'createClass':
          value = workspace.createClass(input);
          break;
        case 'renameClass':
          value = workspace.renameClass(input);
          break;
        case 'saveStudent':
          value = workspace.saveStudent(input);
          break;
        case 'setStudentActive':
          value = workspace.setStudentActive(input);
          break;
        case 'seedDemo':
          value = workspace.seedDemo(input);
          break;
        case 'addSyntheticAsset':
          value = workspace.addSyntheticAsset(input);
          break;
        case 'exportBackup':
          value = workspace.exportBackup(input);
          break;
        case 'previewRestoreBytes':
          value = workspace.previewRestore(z.instanceof(Uint8Array).parse(input));
          break;
        case 'previewRecovery':
          value = workspace.previewRecovery();
          break;
        case 'commitRestore':
          value = workspace.commitRestore(input);
          break;
      }
      port.postMessage({ id, result: { ok: true, value } });
    } catch (error) {
      port.postMessage({ id, result: { ok: false, error: publicError(error) } });
    }
  });
} catch (error) {
  port.postMessage({ id: 0, result: { ok: false, error: publicError(error) } });
}
