import { copyFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, expect, test } from 'vitest';
import { openDatabase, SCHEMA_VERSION } from '../src/core/database';

const roots: string[] = [];
const fixturePath = 'tests/fixtures/frozen-v8.sqlite';
const fixtureHash = 'e54c554533f33eff35e317503a6dd215f711f834c3f2575abbd6e29fad3c234d';
function copy() {
  expect(createHash('sha256').update(readFileSync(fixturePath)).digest('hex')).toBe(fixtureHash);
  const root = mkdtempSync(join(tmpdir(), 'cm-v8-publication-'));
  roots.push(root);
  const path = join(root, 'data.sqlite');
  copyFileSync(fixturePath, path);
  return { root, path };
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test('independent frozen Schema 8 migrates to current schema with grading payload retained and pre-upgrade backup', () => {
  const f = copy();
  const old = openDatabase(f.path, 'readonly');
  const payload = old.prepare('SELECT payload FROM grading_drafts').get()?.payload;
  old.close();
  const db = openDatabase(f.path, 'open');
  try {
    expect(db.prepare('PRAGMA user_version').get()?.user_version).toBe(SCHEMA_VERSION);
    expect(db.prepare('SELECT COUNT(*) AS n FROM grading_publications').get()?.n).toBe(0);
    expect(db.prepare('SELECT payload FROM grading_drafts').get()?.payload).toBe(payload);
    expect(db.prepare('SELECT status FROM grading_attempts').get()?.status).toBe('succeeded');
  } finally {
    db.close();
  }
  const backup = readdirSync(f.root).find((name) => name.includes(`.before-v${SCHEMA_VERSION}-`))!;
  expect(backup).toBeDefined();
  const prior = openDatabase(join(f.root, backup), 'readonly');
  try {
    expect(prior.prepare('PRAGMA user_version').get()?.user_version).toBe(8);
  } finally {
    prior.close();
  }
});

test('failed v8 migration rolls back schema and data and preserves independent v8 copy', () => {
  const f = copy();
  expect(() =>
    openDatabase(f.path, 'open', {
      migrationCheckpoint: (stage) => {
        if (stage === 'upgraded') throw Error('Synthetic upgrade failure');
      },
    }),
  ).toThrow('Synthetic upgrade failure');
  const old = openDatabase(f.path, 'readonly');
  try {
    expect(old.prepare('PRAGMA user_version').get()?.user_version).toBe(8);
    expect(
      old.prepare("SELECT name FROM sqlite_master WHERE name='grading_publications'").get(),
    ).toBeUndefined();
    expect(old.prepare('SELECT COUNT(*) AS n FROM grading_drafts').get()?.n).toBe(1);
  } finally {
    old.close();
  }
  expect(
    readdirSync(f.root).filter((name) => name.includes(`.before-v${SCHEMA_VERSION}-`)),
  ).toHaveLength(1);
});
