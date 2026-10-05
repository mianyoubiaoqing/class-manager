import { openDatabase } from '../../src/core/database';

const [, , path, checkpoint] = process.argv;
if (!path || !checkpoint) throw new Error('Missing migration test arguments');
const db = openDatabase(path, 'open', {
  migrationCheckpoint: (stage) => {
    if (stage === checkpoint) process.exit(88);
  },
});
db.close();
