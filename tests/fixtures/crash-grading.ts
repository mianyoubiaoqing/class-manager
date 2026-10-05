import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Workspace } from '../../src/core/workspace';
import { gradingFreezeInput, gradingPrepareInput } from '../../src/shared/grading-records';
import { generationProviderSchema } from '../../src/shared/model-provenance';
import type { GradingCheckpoint } from '../../src/core/grading-book';

const inputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('freeze'), command: gradingFreezeInput }).strict(),
  z
    .object({
      kind: z.literal('complete'),
      prepare: gradingPrepareInput,
      requestId: z.uuid(),
      output: z.string(),
      provider: generationProviderSchema,
    })
    .strict(),
]);
const [root, inputPath, stage, commandPath] = process.argv.slice(2);
if (!root || !inputPath || !stage || !commandPath) throw new Error('Missing crash fixture input');
const input = inputSchema.parse(JSON.parse(readFileSync(inputPath, 'utf8')));
const checkpoint: GradingCheckpoint = (current) => {
  if (current === stage) process.exit(80);
};
const workspace = new Workspace(
  root,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  undefined,
  checkpoint,
);
if (input.kind === 'freeze') workspace.grading.freeze(input.command);
else {
  const prepared = workspace.grading.prepare(input.prepare);
  const command = {
    epoch: input.prepare.epoch,
    token: prepared.token,
    requestId: input.requestId,
    output: input.output,
    provider: input.provider,
  };
  workspace.grading.claim({
    epoch: command.epoch,
    token: command.token,
    requestId: command.requestId,
  });
  writeFileSync(commandPath, JSON.stringify(command));
  workspace.grading.complete(command);
}
workspace.close();
