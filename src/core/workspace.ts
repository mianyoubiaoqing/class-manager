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
import { MAX_DATABASE_BYTES, MAX_ASSETS, MAX_ASSETS_BYTES } from './storage-limits';
import { MaterialBook, type MaterialCheckpoint } from './material-book';
import { LessonBook, type LessonCheckpoint } from './lesson-book';
import { ClassroomBook } from './classroom-book';
import { GradingBook, type GradingCheckpoint } from './grading-book';
import { ScoreBook, type ScoreCheckpoint } from './score-book';
import type { PublicationCheckpoint } from './score-publication';
import { GrowthBook, type GrowthCheckpoint } from './growth-book';
import { PupilBook } from './pupil-book';
import { TeachingBook } from './teaching-book';
import { ResourceLibrary } from './resource-library';
import { parseRosterImport } from './roster-import';
import { planImportedProfile, writeImportedProfile } from './roster-profile';
import type { StudentProfile } from '../shared/pupils';
import { ClassDataImporter } from './class-data-import';
import {
  rosterImportInput,
  rosterConfirmInput,
  type RosterImportPreview,
} from '../shared/roster-import';
import { ExplanationBook, type ExplanationCheckpoint } from './explanation-book';
import { SeatingBook, type SeatingCheckpoint } from './seating-book';
import { DutyBook, type DutyCheckpoint } from './duty-book';
import { advanceDutyDate } from './duty-records';
import {
  createBackup,
  removeStaging,
  recoverBackupStaging,
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
  private scoreBook?: ScoreBook;
  private classDataImporter?: ClassDataImporter;
  private explanationBook?: ExplanationBook;
  private seatingBook?: SeatingBook;
  private dutyBook?: DutyBook;
  private materialBook?: MaterialBook;
  private lessonBook?: LessonBook;
  private classroomBook?: ClassroomBook;
  private gradingBook?: GradingBook;
  private growthBook?: GrowthBook;
  private pupilBook?: PupilBook;
  private rosterImport?: {
    epoch: string;
    classId: string;
    fingerprint: string;
    expires: number;
    preview: RosterImportPreview;
    profiles: StudentProfile[];
  };
  private rosterReceipts = new Map<string, { epoch: string; added: number; skipped: number }>();
  readonly root: string;

  constructor(
    root: string,
    private readonly restoreCheckpoint?: (stage: 'staged' | 'published') => void,
    private readonly scoreCheckpoint?: ScoreCheckpoint,
    private readonly explanationCheckpoint?: ExplanationCheckpoint,
    private readonly seatingCheckpoint?: SeatingCheckpoint,
    private readonly dutyCheckpoint?: DutyCheckpoint,
    private readonly materialCheckpoint?: MaterialCheckpoint,
    private readonly lessonCheckpoint?: LessonCheckpoint,
    private readonly gradingCheckpoint?: GradingCheckpoint,
    private readonly publicationCheckpoint?: PublicationCheckpoint,
    private readonly growthCheckpoint?: GrowthCheckpoint,
  ) {
    this.root = resolve(root);
    mkdirSync(this.root, { recursive: true });
    requireDirectory(this.root);
    const spaces = join(this.root, 'workspaces');
    mkdirSync(spaces, { recursive: true });
    requireDirectory(spaces);
    mkdirSync(join(this.root, 'staging'), { recursive: true });
    requireDirectory(join(this.root, 'staging'));
    recoverBackupStaging(this.root);
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
    requireRegularFile(join(this.directory, 'data.sqlite'), MAX_DATABASE_BYTES);
    this.db = openDatabase(join(this.directory, 'data.sqlite'), 'open', {
      validateBeforeMigration: (db) =>
        validateAssets(this.directory, readSnapshot(db, this.epoch, this.root), db),
    });
    try {
      validateAssets(this.directory, this.snapshot(), this.db);
      advanceDutyDate(this.db);
      this.classroomBook = new ClassroomBook(this.db, () => this.epoch);
      this.gradingBook = new GradingBook(this.db, () => this.epoch, this.gradingCheckpoint);
    } catch (error) {
      this.db.close();
      throw error;
    }
  }

  close(): void {
    this.classroomBook?.pauseAll();
    this.classroomBook?.dispose();
    this.gradingBook?.dispose();
    this.growthBook?.dispose();
    this.pupilBook?.dispose();
    this.materialBook?.dispose();
    this.lessonBook?.dispose();
    this.dutyBook?.dispose();
    this.seatingBook?.dispose();
    this.explanationBook?.dispose();
    this.scoreBook?.dispose();
    this.classDataImporter?.dispose();
    this.db.close();
  }

  get materials(): MaterialBook {
    return (this.materialBook ??= new MaterialBook(
      this.db,
      () => this.epoch,
      () => this.directory,
      this.materialCheckpoint,
    ));
  }
  get lessons(): LessonBook {
    return (this.lessonBook ??= new LessonBook(this.db, () => this.epoch, this.lessonCheckpoint));
  }
  get classroom(): ClassroomBook {
    return (this.classroomBook ??= new ClassroomBook(this.db, () => this.epoch));
  }
  get grading(): GradingBook {
    return (this.gradingBook ??= new GradingBook(
      this.db,
      () => this.epoch,
      this.gradingCheckpoint,
    ));
  }

  get scores(): ScoreBook {
    return (this.scoreBook ??= new ScoreBook(
      this.db,
      () => this.snapshot(),
      this.scoreCheckpoint,
      this.publicationCheckpoint,
    ));
  }

  get classData(): ClassDataImporter {
    return (this.classDataImporter ??= new ClassDataImporter(this.db, () => this.snapshot()));
  }

  get growth(): GrowthBook {
    return (this.growthBook ??= new GrowthBook(
      this.db,
      () => this.snapshot(),
      this.growthCheckpoint,
    ));
  }
  get pupils(): PupilBook {
    return (this.pupilBook ??= new PupilBook(this.db, () => this.snapshot()));
  }
  get teaching(): TeachingBook {
    return new TeachingBook(this.db, () => this.snapshot());
  }
  get resources(): ResourceLibrary {
    return new ResourceLibrary(
      this.db,
      () => this.epoch,
      () => this.directory,
    );
  }

  get seating(): SeatingBook {
    return (this.seatingBook ??= new SeatingBook(
      this.db,
      () => this.snapshot(),
      this.seatingCheckpoint,
    ));
  }

  get duties(): DutyBook {
    return (this.dutyBook ??= new DutyBook(this.db, () => this.snapshot(), this.dutyCheckpoint));
  }

  get explanations(): ExplanationBook {
    return (this.explanationBook ??= new ExplanationBook(
      this.db,
      () => this.epoch,
      (versionId) => this.scores.read({ epoch: this.epoch, versionId }),
      this.explanationCheckpoint,
    ));
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
    // 时钟回拨时，归属结束不能早于已确认座位；按曾属班级取上界，避免解析全部历史载荷。
    const history = studentId
      ? this.snapshot().enrollments.filter((entry) => entry.studentId === studentId)
      : [];
    const seatingBoundary = studentId
      ? this.db
          .prepare(
            `SELECT MAX(created_at) AS timestamp FROM seating_versions
             WHERE class_id IN (SELECT class_id FROM enrollments WHERE student_id=?)`,
          )
          .get(studentId)?.timestamp
      : undefined;
    const dutyBoundary = studentId
      ? this.db
          .prepare(
            `SELECT MAX(created_at) AS timestamp FROM duty_versions
          WHERE class_id IN (SELECT class_id FROM enrollments WHERE student_id=?)`,
          )
          .get(studentId)?.timestamp
      : undefined;
    return new Date(
      Math.max(
        Date.now(),
        ...history.map((entry) => Date.parse(entry.validTo ?? entry.validFrom)),
        seatingBoundary ? Date.parse(String(seatingBoundary)) : 0,
        dutyBoundary ? Date.parse(String(dutyBoundary)) : 0,
      ),
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

  cancelRosterPreview(raw: unknown): void {
    const input = epochInput.parse(raw);
    this.guard(input.epoch);
    this.rosterImport = undefined;
  }

  private rosterFingerprint(): string {
    const snapshot = this.snapshot();
    return createHash('sha256')
      .update(
        JSON.stringify([
          snapshot.classes,
          snapshot.students,
          this.db.prepare('SELECT id,revision FROM student_profiles ORDER BY id').all(),
        ]),
      )
      .digest('hex');
  }

  async previewRoster(
    bytes: Uint8Array,
    format: 'csv' | 'xlsx',
    fileName: string,
    raw: unknown,
  ): Promise<RosterImportPreview> {
    const input = rosterImportInput.parse(raw);
    this.guard(input.epoch);
    this.rosterImport = undefined;
    const snapshot = this.snapshot();
    const classroom = snapshot.classes.find((c) => c.id === input.classId);
    if (!classroom) throw new DomainError('NOT_FOUND', '请先创建并选择班级。');
    const fingerprint = this.rosterFingerprint();
    const parsed = await parseRosterImport(bytes, format, snapshot, input.classId);
    const profiles: StudentProfile[] = [];
    for (const row of parsed.rows) {
      if (row.status !== 'new' && row.status !== 'update') continue;
      row.studentId ??= randomUUID();
      const profile = planImportedProfile(this.db, row.studentId, row.profile ?? {});
      if (profile) profiles.push(profile);
      else if (row.status === 'update') {
        row.status = 'skip';
        row.message = '已有学生，档案内容一致，跳过';
      }
    }
    parsed.updated = parsed.rows.filter((row) => row.status === 'update').length;
    parsed.skipped = parsed.rows.filter((row) => row.status === 'skip').length;
    parsed.canConfirm = parsed.canConfirm && (parsed.added > 0 || parsed.updated > 0);
    this.guard(input.epoch);
    if (fingerprint !== this.rosterFingerprint())
      throw new DomainError('CONFLICT', '名册已变化，请重新预览。');
    const preview = { ...parsed, token: randomUUID(), fileName, className: classroom.name };
    this.rosterImport = {
      epoch: input.epoch,
      classId: input.classId,
      fingerprint,
      expires: Date.now() + 15 * 60 * 1000,
      preview,
      profiles,
    };
    return preview;
  }

  confirmRoster(raw: unknown): {
    snapshot: Snapshot;
    added: number;
    skipped: number;
    replayed: boolean;
  } {
    const input = rosterConfirmInput.parse(raw);
    this.guard(input.epoch);
    const receipt = this.rosterReceipts.get(input.token);
    if (receipt?.epoch === input.epoch)
      return { ...receipt, snapshot: this.snapshot(), replayed: true };
    const pending = this.rosterImport;
    if (
      !pending ||
      pending.epoch !== input.epoch ||
      pending.preview.token !== input.token ||
      pending.expires <= Date.now()
    )
      throw new DomainError('CONFLICT', '导入预览已失效，请重新选择文件。');
    if (!pending.preview.canConfirm)
      throw new DomainError('VALIDATION', '请先修正导入文件中的错误。');
    if (pending.fingerprint !== this.rosterFingerprint())
      throw new DomainError('CONFLICT', '名册已变化，请重新预览后确认。');
    const now = this.membershipTimestamp();
    transaction(this.db, () => {
      for (const row of pending.preview.rows.filter((r) => r.status === 'new')) {
        const id = row.studentId!;
        this.db
          .prepare('INSERT INTO students VALUES (?, ?, ?, 1, 1, ?)')
          .run(id, row.studentNumber, row.displayName, now);
        this.db
          .prepare('INSERT INTO enrollments VALUES (?, ?, ?, ?, NULL)')
          .run(randomUUID(), id, pending.classId, now);
      }
      for (const profile of pending.profiles) writeImportedProfile(this.db, profile);
    });
    const saved = {
      epoch: input.epoch,
      added: pending.preview.added,
      skipped: pending.preview.skipped,
    };
    this.rosterReceipts.set(input.token, saved);
    if (this.rosterReceipts.size > 20)
      this.rosterReceipts.delete(this.rosterReceipts.keys().next().value!);
    this.rosterImport = undefined;
    return { ...saved, snapshot: this.snapshot(), replayed: false };
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
    if (
      Number(
        this.db
          .prepare(
            'SELECT COUNT(*) AS count FROM assets WHERE id NOT IN (SELECT asset_id FROM material_assets)',
          )
          .get()?.count,
      ) >= 32
    )
      throw new DomainError('VALIDATION', '验证附件上限为 32 份。');
    const id = randomUUID();
    const bytes = Buffer.from('Class Manager M0\n合成备份验证附件。不包含真实学生数据。\n', 'utf8');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const quota = this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM assets')
      .get()!;
    if (Number(quota.count) >= MAX_ASSETS || Number(quota.bytes) + bytes.length > MAX_ASSETS_BYTES)
      throw new DomainError('VALIDATION', '附件存储已达到上限。');
    // 先持久保存不可变附件再登记引用；中断最多留下孤立文件，不会提交悬空引用。
    durableWrite(join(this.directory, 'assets', `${id}.bin`), bytes);
    this.db
      .prepare('INSERT INTO assets VALUES (?, ?, ?, ?)')
      .run(id, '合成验证附件.txt', bytes.length, sha256);
    return this.snapshot();
  }

  storeTeachingPhoto(raw: unknown): { id: string; name: string; dataUrl: string } {
    const input = z
      .object({
        epoch: z.uuid(),
        classId: z.uuid(),
        name: z.string().min(1).max(255),
        bytes: z.instanceof(Uint8Array),
      })
      .strict()
      .parse(raw);
    this.guard(input.epoch);
    if (!this.snapshot().classes.some((c) => c.id === input.classId))
      throw new DomainError('NOT_FOUND', '班级不存在。');
    const bytes = Buffer.from(input.bytes);
    if (
      bytes.length > 5 * 1024 * 1024 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new DomainError('VALIDATION', '照片须为不超过 5 MiB 的 PNG 图片。');
    const quota = this.db
      .prepare('SELECT COUNT(*) AS count, COALESCE(SUM(bytes),0) AS bytes FROM assets')
      .get()!;
    if (Number(quota.count) >= MAX_ASSETS || Number(quota.bytes) + bytes.length > MAX_ASSETS_BYTES)
      throw new DomainError('STORAGE_LIMIT', '附件存储已达到上限。');
    const id = randomUUID();
    durableWrite(join(this.directory, 'assets', `${id}.bin`), bytes);
    this.db
      .prepare('INSERT INTO assets VALUES (?,?,?,?)')
      .run(id, input.name, bytes.length, createHash('sha256').update(bytes).digest('hex'));
    return { id, name: input.name, dataUrl: `data:image/png;base64,${bytes.toString('base64')}` };
  }

  readTeachingPhoto(raw: unknown): string {
    const input = z.object({ epoch: z.uuid(), id: z.uuid() }).strict().parse(raw);
    this.guard(input.epoch);
    const row = this.db.prepare('SELECT bytes,sha256 FROM assets WHERE id=?').get(input.id);
    if (!row || Number(row.bytes) > 5 * 1024 * 1024)
      throw new DomainError('NOT_FOUND', '照片不存在。');
    const path = join(this.directory, 'assets', `${input.id}.bin`);
    requireRegularFile(path, 5 * 1024 * 1024);
    const bytes = readFileSync(path);
    if (
      bytes.length !== Number(row.bytes) ||
      createHash('sha256').update(bytes).digest('hex') !== row.sha256 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
    )
      throw new DomainError('BACKUP_INVALID', '照片文件校验失败。');
    return `data:image/png;base64,${bytes.toString('base64')}`;
  }

  exportBackup(raw: unknown): Buffer {
    const input = epochInput.parse(raw);
    this.guard(input.epoch);
    this.classroomBook?.checkpoint();
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
      examCount: snapshot.examCount,
      scoreVersionCount: snapshot.scoreVersionCount,
      explanationDraftCount: snapshot.explanationDraftCount,
      seatingVersionCount: snapshot.seatingVersionCount,
      dutyVersionCount: snapshot.dutyVersionCount,
      materialVersionCount: snapshot.materialVersionCount,
      lessonDraftCount: snapshot.lessonDraftCount,
      lessonVersionCount: snapshot.lessonVersionCount,
      teachingSessionCount: snapshot.teachingSessionCount,
      countdownCount: snapshot.countdownCount,
      rubricVersionCount: snapshot.rubricVersionCount,
      gradingDraftCount: snapshot.gradingDraftCount,
      gradingReviewCount: snapshot.gradingReviewCount,
      gradingAttemptCount: snapshot.gradingAttemptCount,
      gradingRevisionCount: snapshot.gradingRevisionCount,
      gradingPublicationCount: snapshot.gradingPublicationCount,
      growthEventCount: snapshot.growthEventCount,
      growthSummaryCount: snapshot.growthSummaryCount,
      growthEntryCount: snapshot.growthEntryCount,
      attendanceCount: snapshot.attendanceCount,
      studentProfileCount: snapshot.studentProfileCount,
    };
  }

  previewRecovery(): RestorePreview {
    const pointer = pointerSchema.parse(
      JSON.parse(readFileSync(join(this.root, 'current.json'), 'utf8')),
    );
    if (!pointer.previousWorkspaceId) throw new DomainError('NOT_FOUND', '尚无恢复前副本。');
    const directory = join(this.root, 'workspaces', pointer.previousWorkspaceId);
    requireDirectory(directory);
    requireRegularFile(join(directory, 'data.sqlite'), MAX_DATABASE_BYTES);
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
      const candidateClassroom = new ClassroomBook(candidate, () => this.epoch);
      const candidateGrading = new GradingBook(candidate, () => this.epoch, this.gradingCheckpoint);
      advanceDutyDate(candidate, advanceDutyDate(this.db));
      this.classroomBook?.pauseAll();
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
      this.classroomBook?.dispose();
      this.classroomBook = undefined;
      this.gradingBook?.dispose();
      this.gradingBook = undefined;
      this.growthBook?.dispose();
      this.growthBook = undefined;
      this.pupilBook?.dispose();
      this.pupilBook = undefined;
      this.materialBook?.dispose();
      this.materialBook = undefined;
      this.lessonBook?.dispose();
      this.lessonBook = undefined;
      this.dutyBook?.dispose();
      this.dutyBook = undefined;
      this.seatingBook?.dispose();
      this.seatingBook = undefined;
      this.explanationBook?.dispose();
      this.explanationBook = undefined;
      this.scoreBook?.dispose();
      this.scoreBook = undefined;
      this.classDataImporter?.dispose();
      this.classDataImporter = undefined;
      this.db = candidate;
      this.classroomBook = candidateClassroom;
      this.gradingBook = candidateGrading;
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
