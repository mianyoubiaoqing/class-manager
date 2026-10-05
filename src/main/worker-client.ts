import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import type { Result } from '../shared/contracts';

export type WorkerOperation =
  | 'readStudentProfile'
  | 'saveStudentProfile'
  | 'studentProfileHistory'
  | 'readAttendanceRoster'
  | 'listAttendance'
  | 'readAttendance'
  | 'attendanceHistory'
  | 'saveAttendance'
  | 'saveGrowthEvent'
  | 'growthEventHistory'
  | 'growthTimeline'
  | 'createGrowthSummary'
  | 'prepareGrowthSummary'
  | 'cancelGrowthSummary'
  | 'readGrowthSummary'
  | 'editGrowthSummary'
  | 'discardGrowthSummary'
  | 'confirmGrowthSummary'
  | 'growthSummaryHistory'
  | 'claimGrowthSummary'
  | 'completeGrowthSummary'
  | 'prepareScorePublication'
  | 'confirmScorePublication'
  | 'readScorePublication'
  | 'createRubric'
  | 'readRubric'
  | 'listRubrics'
  | 'createGrading'
  | 'readGrading'
  | 'readGradingReview'
  | 'listGradings'
  | 'editGrading'
  | 'rebindGrading'
  | 'freezeGrading'
  | 'gradingAttempts'
  | 'gradingHistory'
  | 'prepareGrading'
  | 'claimGrading'
  | 'completeGrading'
  | 'endGrading'
  | 'cancelGrading'
  | 'createClassroom'
  | 'readClassroom'
  | 'listClassrooms'
  | 'controlClassroom'
  | 'readCountdown'
  | 'setCountdown'
  | 'readClassroomProjection'
  | 'readClassroomClock'
  | 'checkpointClassroom'
  | 'pauseClassrooms'
  | 'readOfficeSnapshot'
  | 'storeMaterial'
  | 'readMaterial'
  | 'listMaterials'
  | 'readMaterialAsset'
  | 'readMaterialImage'
  | 'readMaterialOriginal'
  | 'prepareLesson'
  | 'createLessonDraft'
  | 'readSeatingDraft'
  | 'readDutyDraft'
  | 'claimLesson'
  | 'completeLesson'
  | 'cancelLesson'
  | 'readLessonDraft'
  | 'listLessonDrafts'
  | 'editLessonDraft'
  | 'discardLessonDraft'
  | 'freezeLessonDraft'
  | 'readLessonVersion'
  | 'lessonHistory'
  | 'reviseLessonVersion'
  | 'readDutyPrintBatch'
  | 'prepareDuty'
  | 'adjustDuty'
  | 'cancelDuty'
  | 'confirmDuty'
  | 'dutyHistory'
  | 'readDutyVersion'
  | 'listDutyPlans'
  | 'prepareSeating'
  | 'adjustSeating'
  | 'cancelSeating'
  | 'confirmSeating'
  | 'seatingHistory'
  | 'readSeatingVersion'
  | 'prepareExplanation'
  | 'claimExplanation'
  | 'completeExplanation'
  | 'cancelExplanation'
  | 'readExplanation'
  | 'listExplanations'
  | 'editExplanation'
  | 'discardExplanation'
  | 'snapshot'
  | 'createClass'
  | 'renameClass'
  | 'saveStudent'
  | 'setStudentActive'
  | 'seedDemo'
  | 'addSyntheticAsset'
  | 'exportBackup'
  | 'previewRestoreBytes'
  | 'commitRestore'
  | 'previewRecovery'
  | 'previewScoreBytes'
  | 'confirmScores'
  | 'cancelScorePreview'
  | 'listExams'
  | 'readScoreVersion'
  | 'scoreHistory'
  | 'studentScoreHistory'
  | 'exportScoreTemplate';
type Reply = { id: number; result: Result<unknown> };
const unavailable = (): Result<never> => ({
  ok: false,
  error: {
    code: 'WORKER_UNAVAILABLE',
    message: '本地数据服务不可用。请退出重开并核对是否已保存，不要重复提交；可导出诊断。',
    operationId: randomUUID(),
  },
});

export class WorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, (result: Result<unknown>) => void>();
  private readonly timers = new Map<number, ReturnType<typeof setTimeout>>();
  private sequence = 0;
  private stopped = false;
  private readonly ready: Promise<Result<unknown>>;
  private readonly fail: () => void;

  constructor(
    path: string,
    root: string,
    private readonly timeoutMs = 30000,
  ) {
    this.ready = new Promise((resolve) => this.pending.set(0, resolve));
    this.worker = new Worker(path, { workerData: { root } });
    this.worker.on('message', ({ id, result }: Reply) => {
      clearTimeout(this.timers.get(id));
      this.timers.delete(id);
      this.pending.get(id)?.(result);
      this.pending.delete(id);
    });
    this.fail = () => {
      this.stopped = true;
      for (const resolve of this.pending.values()) resolve(unavailable());
      this.pending.clear();
      for (const timer of this.timers.values()) clearTimeout(timer);
      this.timers.clear();
    };
    this.worker.on('error', this.fail);
    this.worker.on('exit', this.fail);
    this.armTimeout(0);
  }

  private armTimeout(id: number): void {
    this.timers.set(
      id,
      setTimeout(() => {
        // 超时的写入可能已经提交；停止后续操作，重开核对，不能自动重复提交。
        this.fail();
        void this.worker.terminate();
      }, this.timeoutMs),
    );
  }

  async close(): Promise<void> {
    this.fail();
    await this.worker.terminate();
  }

  async call<T>(operation: WorkerOperation, input?: unknown): Promise<Result<T>> {
    const ready = await this.ready;
    if (!ready.ok) return ready;
    if (this.stopped) return unavailable();
    const id = ++this.sequence;
    // The worker is bundled application code; public/untrusted input is validated again inside it.
    return new Promise<Result<T>>((resolve) => {
      this.pending.set(id, (result) => resolve(result as Result<T>));
      this.armTimeout(id);
      this.worker.postMessage({ id, operation, input });
    });
  }
}
