import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { Workspace } from '../../src/core/workspace';
const [, , mode, root, inputPath, commandPath, checkpoint] = process.argv;
if (!root || !inputPath || !commandPath || !checkpoint)
  throw new Error('Missing crash fixture arguments');
const input = JSON.parse(readFileSync(inputPath, 'utf8'));
const stop = (stage: string) => {
  if (stage === checkpoint) process.exit(89);
};
const workspace = new Workspace(
  root,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  mode === 'material' ? stop : undefined,
  mode === 'lesson' ? stop : undefined,
);
if (mode === 'material') {
  const command = {
    ...input,
    parsed: {
      ...input.parsed,
      assets: input.parsed.assets.map((asset: { id: string; mime: string; base64: string }) => ({
        id: asset.id,
        mime: asset.mime,
        bytes: Buffer.from(asset.base64, 'base64'),
      })),
    },
  };
  workspace.materials.store(command);
} else if (mode === 'lesson') {
  const prepared = workspace.lessons.prepare({ epoch: input.epoch, request: input.request });
  const command = {
    epoch: input.epoch,
    token: prepared.token,
    requestId: randomUUID(),
    provider: input.provider,
    output: JSON.stringify(input.content),
  };
  writeFileSync(commandPath, JSON.stringify(command));
  workspace.lessons.claim({
    epoch: command.epoch,
    token: command.token,
    requestId: command.requestId,
  });
  workspace.lessons.complete(command);
} else throw new Error('Unknown crash mode');
workspace.close();
