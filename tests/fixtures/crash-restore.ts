import { readFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';

const [root, backupPath, checkpoint] = process.argv.slice(2);
if (!root || !backupPath || !checkpoint) process.exit(2);
const workspace = new Workspace(root, (stage) => {
  if (stage === checkpoint) process.exit(77);
});
const epoch = workspace.snapshot().epoch;
const preview = workspace.previewRestore(readFileSync(backupPath));
workspace.commitRestore({ epoch, token: preview.token });
workspace.close();
process.exit(3);
