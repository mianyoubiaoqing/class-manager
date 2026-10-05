import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Workspace } from '../../src/core/workspace';

const [, , root, inputPath, commandPath, checkpoint] = process.argv;
if (!root || !inputPath || !commandPath || !checkpoint)
  throw new Error('Missing score crash arguments');
async function run() {
  const workspace = new Workspace(root!, undefined, (stage) => {
    if (stage === checkpoint) process.exit(89);
  });
  try {
    const input = JSON.parse(readFileSync(inputPath!, 'utf8'));
    const preview = await workspace.scores.preview(Buffer.from('学生编号,数学\n0001,99'), input);
    const command = {
      epoch: input.epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '合成崩溃测试',
    };
    writeFileSync(commandPath!, JSON.stringify(command));
    workspace.scores.confirm(command);
  } finally {
    workspace.close();
  }
}
void run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
