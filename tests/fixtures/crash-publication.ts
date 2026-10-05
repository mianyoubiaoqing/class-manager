import { readFileSync, writeFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';
import { scorePublicationReadInput } from '../../src/shared/score-publication';
import type { PublicationCheckpoint } from '../../src/core/score-publication';

const [root, inputPath, stage, commandPath] = process.argv.slice(2);
if (!root || !inputPath || !stage || !commandPath) throw Error('Missing publication crash input');
const input = scorePublicationReadInput.parse(JSON.parse(readFileSync(inputPath, 'utf8')));
const checkpoint: PublicationCheckpoint = (current) => {
  if (current === stage) process.exit(81);
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
  undefined,
  checkpoint,
);
const preview = workspace.scores.publication.prepare(input);
const command = {
  ...input,
  token: preview.token,
  expectedVersionId: preview.expectedVersionId,
  reason: '合成中断入分',
  acknowledgePublish: true,
  acknowledgeReplacement: true,
};
writeFileSync(commandPath, JSON.stringify(command));
workspace.scores.publication.confirm(command);
workspace.close();
