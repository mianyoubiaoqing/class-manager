import { randomUUID, createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import {
  activationInput,
  createClassInput,
  epochInput,
  renameClassInput,
  restoreInput,
  studentInput,
  type Snapshot,
  type Student,
  type RestorePreview,
} from '../shared/contracts';
import { openDatabase, transaction } from './database';
import { DomainError } from './errors';
import { atomicWrite, durableWrite, requireDirectory, requireRegularFile } from './files';
import { readSnapshot } from './snapshot';
import {
  createBackup,
  removeStaging,
  stageBackup,
  validateAssets,
  validateStaged,
  type StagedBackup,
} from './backup';

const pointerSchema = z
  .object({
    workspaceId: z.uuid(),
    previousWorkspaceId: z.uuid().optional(),
    switchedAt: z.iso.datetime(),
  })
  .strict();

export class Workspace {
  private db: DatabaseSync;
  private epoch: string;
  private directory: string;
  private pendingRestore?: StagedBackup;
  readonly root: string;

  constructor(
    root: string,
    private readonly restoreCheckpoint?: (stage: 'staged' | 'published') => void,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    requireDirectory(this.root);
    const spaces = join(this.root, 'workspaces');
    mkdirSync(spaces, { recursive: true });
    requireDirectory(spaces);
    mkdirSync(join(this.root, 'staging'), { recursive: true });
    requireDirectory(join(this.root, 'staging'));
    const pointerPath = join(this.root, 'current.json');
    if (!existsSync(pointerPath)) {
      if (readdirSync(spaces).length !== 0) {
        throw new DomainError(
          'STORAGE_ERROR',
          '数据入口缺失但仍有历史数据，请保留目录并联系维护者。',
        );
      }
      const workspaceId = randomUUID();
      const directory = join(spaces, workspaceId);
      mkdirSync(join(directory, 'assets'), { recursive: true });
      const initial = openDatabase(join(directory, 'data.sqlite'), 'create');
      initial.close();
      atomicWrite(
        pointerPath,
        JSON.stringify({ workspaceId, switchedAt: new Date().toISOString() }),
      );
    }
    requireRegularFile(pointerPath, 4096);
    const pointer = pointerSchema.parse(JSON.parse(readFileSync(pointerPath, 'utf8')));
    this.epoch = pointer.workspaceId;
    this.directory = join(spaces, this.epoch);
    requireDirectory(this.directory);
    requireDirectory(join(this.directory, 'assets'));
    requireRegularFile(join(this.directory, 'data.sqlite'), 8 * 1024 * 1024);
    this.db = openDatabase(join(this.directory, 'data.sqlite'), 'open');
    try {
      validateAssets(this.directory, this.snapshot());
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.db.close();
  }

  snapshot(): Snapshot {
    return readSnapshot(
      this.db,
      this.epoch,
      this.root,
      Math.max(0, readdirSync(join(this.root, 'workspaces')).length - 1),
    );
  }

  private guard(epoch: string): void {
    if (epoch !== this.epoch) {
      throw new DomainError('STALE_WORKSPACE', '数据已恢复或切换，请刷新后重新操作。');
    }
  }

  private currentStudent(id: string, revision: number): Student {
    const student = this.snapshot().students.find((item) => item.id === id);
    if (!student) throw new DomainError('NOT_FOUND', '学生不存在。');
    if (student.revision !== revision)
      throw new DomainError('CONFLICT', '记录已被修改，请刷新后重新编辑。');
    return student;
  }

  private membershipTimestamp(studentId?: string): string {
    // 系统时钟可能回拨；归属记录的结束时间不能早于已有开始时间。
    const history = studentId
      ? this.snapshot().enrollments.filter((entry) => entry.studentId === studentId)
      : [];
    return new Date(
      Math.max(Date.now(), ...history.map((entry) => Date.parse(entry.validTo ?? entry.validFrom))),
    ).toISOString();
  }

  createClass(raw: unknown): Snapshot {
    const input = createClassInput.parse(raw);
    this.guard(input.epoch);
    const snapshot = this.snapshot();
    if (snapshot.classes.length >= 100)
      throw new DomainError('VALIDATION', 'M0 最多支持 100 个测试班级。');
    if (snapshot.classes.some((item) => item.name === input.name))
      throw new DomainError('DUPLICATE', '班级名称已存在。');
    this.db
      .prepare('INSERT INTO classrooms VALUES (?, ?, 1, ?)')
      .run(randomUUID(), input.name, new Date().toISOString());
    return this.snapshot();
  }

  renameClass(raw: unknown): Snapshot {
    const input = renameClassInput.parse(raw);
    this.guard(input.epoch);
    const classrooms = this.snapshot().classes;
    const existing = classrooms.find((item) => item.id === input.id);
    if (!existing) throw new DomainError('NOT_FOUND', '班级不存在。');
    if (existing.revision !== input.expectedRevision)
      throw new DomainError('CONFLICT', '班级已修改，请刷新。');
    if (classrooms.some((item) => item.id !== input.id && item.name === input.name)) {
      throw new DomainError('DUPLICATE', '班级名称已存在。');
    }
    this.db
      .prepare('UPDATE classrooms SET name=?, revision=revision+1 WHERE id=?')
      .run(input.name, input.id);
    return this.snapshot();
  }

  saveStudent(raw: unknown): Snapshot {
    const input = studentInput.parse(raw);
    this.guard(input.epoch);
    const snapshot = this.snapshot();
    if (!snapshot.classes.some((item) => item.id === input.classId))
      throw new DomainError('NOT_FOUND', '班级不存在。');
    if (
      snapshot.students.some(
        (item) => item.id !== input.id && item.studentNumber === input.studentNumber,
      )
    ) {
      throw new DomainError('DUPLICATE', '学生编号已存在，重名学生请使用不同编号。');
    }
    const old = input.id ? this.currentStudent(input.id, input.expectedRevision!) : undefined;
    if (!old && snapshot.students.length >= 10000)
      throw new DomainError('VALIDATION', 'M0 最多支持 10000 名测试学生。');
    if (old && !old.active && input.classId !== old.classId) {
      throw new DomainError('VALIDATION', '请先恢复在籍，再调整班级。');
    }
    const now = this.membershipTimestamp(input.id);
    transaction(this.db, () => {
      const id = input.id ?? randomUUID();
      if (old) {
        this.db
          .prepare(
            'UPDATE students SET student_number=?, display_name=?, revision=revision+1 WHERE id=?',
          )
          .run(input.studentNumber, input.displayName, id);
      } else {
        this.db
          .prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)')
          .run(id, input.studentNumber, input.displayName, now);
      }
      if (!old || old.classId !== input.classId) {
        this.db
          .prepare('UPDATE enrollments SET valid_to=? WHERE student_id=? AND valid_to IS NULL')
          .run(now, id);
        this.db
          .prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)')
          .run(randomUUID(), id, input.classId, now);
      }
    });
    return this.snapshot();
  }

  setStudentActive(raw: unknown): Snapshot {
    const input = activationInput.parse(raw);
    this.guard(input.epoch);
    const student = this.currentStudent(input.id, input.expectedRevision);
    if (student.active === input.active) return this.snapshot();
    const now = this.membershipTimestamp(input.id);
    transaction(this.db, () => {
      this.db
        .prepare('UPDATE students SET active=?, revision=revision+1 WHERE id=?')
        .run(input.active ? 1 : 0, input.id);
      if (input.active) {
        this.db
          .prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)')
          .run(randomUUID(), input.id, student.classId, now);
      } else {
        this.db
          .prepare('UPDATE enrollments SET valid_to=? WHERE student_id=? AND valid_to IS NULL')
          .run(now, input.id);
      }
    });
    return this.snapshot();
  }

  seedDemo(raw: unknown): Snapshot {
    const input = epochInput.parse(raw);
    this.guard(input.epoch);
    if (this.snapshot().classes.length !== 0)
      throw new DomainError('CONFLICT', '示例只能载入空名册，不会覆盖已有数据。');
    transaction(this.db, () => {
      const now = new Date().toISOString();
      for (let group = 1; group <= 2; group++) {
        const classId = randomUUID();
        this.db
          .prepare('INSERT INTO classrooms VALUES (?, ?, 1, ?)')
          .run(classId, `合成高一 ${group} 班`, now);
        for (let index = 1; index <= 50; index++) {
          const id = randomUUID();
          const sequence = String(index).padStart(2, '0');
          this.db
            .prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)')
            .run(id, `DEMO-${group}-${sequence}`, `合成学生 ${group}-${sequence}`, now);
          this.db
            .prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)')
            .run(randomUUID(), id, classId, now);
        }
      }
    });
    return this.snapshot();
  }

  addSyntheticAsset(raw: unknown): Snapshot {
    const input = epochInput.parse(raw);
    this.guard(input.epoch);
    if (this.snapshot().assets.length >= 32)
      throw new DomainError('VALIDATION', '验证附件上限为 32 份。');
    const id = randomUUID();
    const bytes = Buffer.from('Class Manager M0\n合成备份验证附件。不包含真实学生数据。\n', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // 先持久保存不可变附件再登记引用；中断最多留下孤立文件，不会提交悬空引用。
    durableWrite(join(this.directory, 'assets', `${id}.bin`), bytes);
    this.db
      .prepare('INSERT INTO assets VALUES (?, ?, ?, ?)')
      .run(id, '合成验证附件.txt', bytes.length, sha256);
    return this.snapshot();
  }

  exportBackup(raw: unknown): Buffer {
    const input = epochInput.parse(raw);
    this.guard(input.epoch);
    return createBackup(this.db, this.directory, this.root, this.snapshot());
  }

  previewRestore(bytes: Uint8Array): RestorePreview {
    if (this.pendingRestore) {
      removeStaging(this.root, this.pendingRestore.directory);
      this.pendingRestore = undefined;
    }
    this.pendingRestore = stageBackup(this.root, bytes, this.epoch);
    const snapshot = validateStaged(this.pendingRestore);
    return {
      token: this.pendingRestore.token,
      createdAt: this.pendingRestore.manifest.createdAt,
      classCount: snapshot.classes.length,
      studentCount: snapshot.students.length,
      assetCount: snapshot.assets.length,
    };
  }

  previewRecovery(): RestorePreview {
    const pointer = pointerSchema.parse(
      JSON.parse(readFileSync(join(this.root, 'current.json'), 'utf8')),
    );
    if (!pointer.previousWorkspaceId) throw new DomainError('NOT_FOUND', '尚无恢复前副本。');
    const directory = join(this.root, 'workspaces', pointer.previousWorkspaceId);
    requireDirectory(directory);
    requireRegularFile(join(directory, 'data.sqlite'), 8 * 1024 * 1024);
    const previous = openDatabase(join(directory, 'data.sqlite'), 'readonly');
    try {
      const snapshot = readSnapshot(previous, pointer.previousWorkspaceId, directory);
      return this.previewRestore(createBackup(previous, directory, this.root, snapshot));
    } finally {
      previous.close();
    }
  }

  /** 恢复只切换数据入口；旧数据库及附件完整保留，供用户回退。 */
  commitRestore(raw: unknown): Snapshot {
    const input = restoreInput.parse(raw);
    this.guard(input.epoch);
    const staged = this.pendingRestore;
    if (!staged || staged.token !== input.token || staged.epoch !== this.epoch) {
      throw new DomainError('CONFLICT', '恢复预览已失效，请重新选择并验证备份。');
    }
    validateStaged(staged);
    const directory = join(this.root, 'workspaces', staged.token);
    renameSync(staged.directory, directory);
    this.pendingRestore = undefined;
    const candidate = openDatabase(join(directory, 'data.sqlite'), 'open');
    let published = false;
    try {
      this.restoreCheckpoint?.('staged');
      atomicWrite(
        join(this.root, 'current.json'),
        JSON.stringify({
          workspaceId: staged.token,
          previousWorkspaceId: this.epoch,
          switchedAt: new Date().toISOString(),
        }),
      );
      published = true;
      const previous = this.db;
      this.db = candidate;
      this.epoch = staged.token;
      this.directory = directory;
      previous.close();
      this.restoreCheckpoint?.('published');
      return this.snapshot();
    } finally {
      if (!published) candidate.close();
    }
  }
}
