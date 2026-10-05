import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/core/database';

const roots: string[] = [];
function fixture() {
  const source = 'tests/fixtures/frozen-v9.sqlite';
  expect(createHash('sha256').update(readFileSync(source)).digest('hex')).toBe(
    '33bc9dae19ad5d79557ea6547b3349f6e8592a1c643310f3fe08475685834a23',
  );
  const root = mkdtempSync(join(tmpdir(), 'cm-growth-v9-'));
  roots.push(root);
  const path = join(root, 'data.sqlite');
  copyFileSync(source, path);
  return { root, path };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
test('independent v9 publication database migrates without altering stored score or review provenance', () => {
  const f = fixture(),
    old = openDatabase(f.path, 'readonly');
  const scores = old.prepare('SELECT * FROM score_versions ORDER BY revision').all(),
    publications = old.prepare('SELECT * FROM grading_publications').all();
  old.close();
  const current = openDatabase(f.path, 'open');
  try {
    expect(current.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    expect(current.prepare('SELECT * FROM score_versions ORDER BY revision').all()).toEqual(scores);
    expect(current.prepare('SELECT * FROM grading_publications').all()).toEqual(publications);
    expect(current.prepare('SELECT COUNT(*) AS n FROM growth_events').get()?.n).toBe(0);
  } finally {
    current.close();
  }
  const backup = readdirSync(f.root).find((n) => n.includes(`before-v${SCHEMA_VERSION}-`))!;
  expect(backup).toBeDefined();
  const prior = openDatabase(join(f.root, backup), 'readonly');
  try {
    expect(prior.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
  } finally {
    prior.close();
  }
});
test('v9 upgrade failure preserves original schema and publication plus independent pre-upgrade copy', () => {
  const f = fixture();
  expect(() =>
    openDatabase(f.path, 'open', {
      migrationCheckpoint: (stage) => {
        if (stage === 'upgraded') throw Error('Synthetic growth migration failure');
      },
    }),
  ).toThrow('Synthetic growth migration');
  const db = openDatabase(f.path, 'readonly');
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(9);
    expect(db.prepare('SELECT COUNT(*) AS n FROM grading_publications').get()?.n).toBe(1);
    expect(
      db.prepare("SELECT name FROM sqlite_master WHERE name='growth_events'").get(),
    ).toBeUndefined();
  } finally {
    db.close();
  }
  expect(readdirSync(f.root).filter((n) => n.includes(`before-v${SCHEMA_VERSION}-`))).toHaveLength(
    1,
  );
});
