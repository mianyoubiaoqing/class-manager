import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';
import { mock } from 'node:test';

const [, , root, inputPath, commandPath, checkpoint, instant] = process.argv;
if (!root || !inputPath || !commandPath || !checkpoint || !instant)
  throw new Error('Missing duty crash arguments');
mock.timers.enable({ apis: ['Date'], now: new Date(instant) });
const workspace = new Workspace(root, undefined, undefined, undefined, undefined, (stage) => {
  if (stage === checkpoint) process.exit(88);
});
try {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const draft = workspace.duties.prepare(input);
  const command = {
    epoch: input.epoch,
    token: draft.token,
    expectedRevision: input.expectedRevision,
    requestId: randomUUID(),
    reason: 'Synthetic process interruption',
  };
  writeFileSync(commandPath, JSON.stringify(command));
  workspace.duties.confirm(command);
} finally {
  workspace.close();
}
