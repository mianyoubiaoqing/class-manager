import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';

const [, , root, inputPath, commandPath, checkpoint] = process.argv;
if (!root || !inputPath || !commandPath || !checkpoint)
  throw new Error('Missing seating crash arguments');
const workspace = new Workspace(root, undefined, undefined, undefined, (stage) => {
  if (stage === checkpoint) process.exit(88);
});
try {
  const input = JSON.parse(readFileSync(inputPath, 'utf8'));
  const draft = workspace.seating.prepare(input);
  const ready = workspace.seating.adjust({
    epoch: input.epoch,
    token: draft.token,
    change: { kind: 'randomize' },
  });
  const command = {
    epoch: input.epoch,
    token: ready.token,
    expectedRevision: input.expectedRevision,
    requestId: randomUUID(),
    reason: 'Synthetic crash recovery',
  };
  writeFileSync(commandPath, JSON.stringify(command));
  workspace.seating.confirm(command);
} finally {
  workspace.close();
}
