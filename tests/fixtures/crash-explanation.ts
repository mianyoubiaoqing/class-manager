import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';

const [, , root, inputPath, commandPath, checkpoint] = process.argv;
if (!root || !inputPath || !commandPath || !checkpoint)
  throw new Error('Missing explanation crash arguments');
const workspace = new Workspace(root, undefined, undefined, (stage) => {
  if (stage === checkpoint) process.exit(87);
});
try {
  const { provider, ...input } = JSON.parse(readFileSync(inputPath, 'utf8'));
  const prepared = workspace.explanations.prepare(input);
  const claim = { epoch: input.epoch, token: prepared.token, requestId: randomUUID() };
  workspace.explanations.claim(claim);
  const command = {
    ...claim,
    provider,
    output: JSON.stringify({
      formatVersion: 1,
      observations: prepared.packet.wire.facts.map(({ id, value }) => ({ factId: id, value })),
      interpretations: [],
      questions: [],
      actions: [],
      limitations: ['Synthetic data only'],
    }),
  };
  writeFileSync(commandPath, JSON.stringify(command));
  workspace.explanations.complete(command);
} finally {
  workspace.close();
}
