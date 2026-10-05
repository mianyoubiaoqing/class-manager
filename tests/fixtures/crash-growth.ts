import { readFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';
import { growthConfirmInput } from '../../src/shared/growth';
const [root, input, stage] = process.argv.slice(2);
if (!root || !input || !stage)
  throw Error('Crash fixture requires its owned workspace, command and stage');
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
  undefined,
  (point) => {
    if (point === stage) process.exit(83);
  },
);
try {
  workspace.growth.confirmSummary(
    growthConfirmInput.parse(JSON.parse(readFileSync(input, 'utf8'))),
  );
} finally {
  workspace.close();
}
