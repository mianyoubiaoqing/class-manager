import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { Workspace } from '../core/workspace';
import { publicError } from '../core/errors';
import { DomainError } from '../core/errors';
import { dutyPrintBatchInput } from '../shared/duty-records';
import { createDutyPrintDocument } from '../core/duty-print';
import { materialImageReadInput, materialReadInput } from '../shared/material-records';
import { officeExportInput } from '../shared/office-export';
import { createOfficeSnapshot } from '../core/office-snapshot';
import { classroomProjectionInput } from '../shared/classroom';
import { createClassroomProjection } from '../core/classroom-projection';
import { createRosterTemplate } from '../core/roster-import';
import { rosterTemplateInput } from '../shared/roster-import';

const port = parentPort;
if (!port) throw new Error('Workspace worker requires a parent port');
const requestSchema = z
  .object({
    id: z.number().int(),
    operation: z.enum([
      'previewRosterBytes',
      'cancelRosterPreview',
      'confirmRosterImport',
      'exportRosterTemplate',
      'saveGrowthEvent',
      'growthEventHistory',
      'growthTimeline',
      'createGrowthSummary',
      'prepareGrowthSummary',
      'cancelGrowthSummary',
      'readGrowthSummary',
      'editGrowthSummary',
      'discardGrowthSummary',
      'confirmGrowthSummary',
      'growthSummaryHistory',
      'claimGrowthSummary',
      'completeGrowthSummary',
      'prepareScorePublication',
      'confirmScorePublication',
      'readScorePublication',
      'createRubric',
      'readRubric',
      'listRubrics',
      'createGrading',
      'readGrading',
      'readGradingReview',
      'listGradings',
      'editGrading',
      'rebindGrading',
      'freezeGrading',
      'gradingAttempts',
      'gradingHistory',
      'prepareGrading',
      'claimGrading',
      'completeGrading',
      'endGrading',
      'cancelGrading',
      'createClassroom',
      'readClassroom',
      'listClassrooms',
      'controlClassroom',
      'readCountdown',
      'setCountdown',
      'readClassroomProjection',
      'readClassroomClock',
      'checkpointClassroom',
      'pauseClassrooms',
      'readOfficeSnapshot',
      'storeMaterial',
      'readMaterial',
      'listMaterials',
      'readMaterialAsset',
      'readMaterialImage',
      'readMaterialOriginal',
      'prepareLesson',
      'createLessonDraft',
      'readSeatingDraft',
      'readDutyDraft',
      'claimLesson',
      'completeLesson',
      'cancelLesson',
      'readLessonDraft',
      'listLessonDrafts',
      'editLessonDraft',
      'discardLessonDraft',
      'freezeLessonDraft',
      'readLessonVersion',
      'lessonHistory',
      'reviseLessonVersion',
      'readDutyPrintBatch',
      'prepareDuty',
      'adjustDuty',
      'cancelDuty',
      'confirmDuty',
      'dutyHistory',
      'readDutyVersion',
      'listDutyPlans',
      'prepareSeating',
      'adjustSeating',
      'cancelSeating',
      'confirmSeating',
      'seatingHistory',
      'readSeatingVersion',
      'prepareExplanation',
      'claimExplanation',
      'completeExplanation',
      'cancelExplanation',
      'readExplanation',
      'listExplanations',
      'editExplanation',
      'discardExplanation',
      'snapshot',
      'createClass',
      'renameClass',
      'saveStudent',
      'readStudentProfile',
      'saveStudentProfile',
      'studentProfileHistory',
      'readAttendanceRoster',
      'listAttendance',
      'readAttendance',
      'attendanceHistory',
      'saveAttendance',
      'setStudentActive',
      'seedDemo',
      'addSyntheticAsset',
      'exportBackup',
      'previewRestoreBytes',
      'commitRestore',
      'previewRecovery',
      'previewScoreBytes',
      'confirmScores',
      'cancelScorePreview',
      'listExams',
      'readScoreVersion',
      'scoreHistory',
      'studentScoreHistory',
      'exportScoreTemplate',
    ]),
    input: z.unknown().optional(),
  })
  .strict();

try {
  const { root } = z.object({ root: z.string() }).strict().parse(workerData);
  const workspace = new Workspace(root);
  port.postMessage({ id: 0, result: { ok: true, value: null } });
  const execute = async ({ id, operation, input }: z.infer<typeof requestSchema>) => {
    try {
      let value: unknown;
      switch (operation) {
        case 'createRubric':
          value = workspace.grading.createRubric(input);
          break;
        case 'readRubric':
          value = workspace.grading.readRubric(input);
          break;
        case 'listRubrics':
          value = workspace.grading.listRubrics(input);
          break;
        case 'createGrading':
          value = workspace.grading.create(input);
          break;
        case 'readGrading':
          value = workspace.grading.read(input);
          break;
        case 'readGradingReview':
          value = workspace.grading.readReview(input);
          break;
        case 'saveGrowthEvent':
          value = workspace.growth.saveEvent(input);
          break;
        case 'growthEventHistory':
          value = workspace.growth.eventHistory(input);
          break;
        case 'growthTimeline':
          value = workspace.growth.timeline(input);
          break;
        case 'createGrowthSummary':
          value = workspace.growth.createManual(input);
          break;
        case 'prepareGrowthSummary':
          value = workspace.growth.prepare(input);
          break;
        case 'cancelGrowthSummary':
          value = workspace.growth.cancel(input);
          break;
        case 'readGrowthSummary':
          value = workspace.growth.readSummary(input);
          break;
        case 'editGrowthSummary':
          value = workspace.growth.editSummary(input);
          break;
        case 'discardGrowthSummary':
          value = workspace.growth.discardSummary(input);
          break;
        case 'confirmGrowthSummary':
          value = workspace.growth.confirmSummary(input);
          break;
        case 'growthSummaryHistory':
          value = workspace.growth.summaryHistory(input);
          break;
        case 'claimGrowthSummary':
          value = workspace.growth.claim(input);
          break;
        case 'completeGrowthSummary': {
          const request = z
            .object({
              command: z.unknown(),
              cancellation: z
                .instanceof(SharedArrayBuffer)
                .refine((buffer) => buffer.byteLength === 4),
            })
            .strict()
            .parse(input);
          value = workspace.growth.complete(request.command, () => {
            // 0待处理、1已取消、2准许提交；Main 在队列忙时也能原子取消，先获准提交则保留已存草稿。
            if (Atomics.compareExchange(new Int32Array(request.cancellation), 0, 0, 2) !== 0)
              throw new DomainError('ABORTED', '成长总结生成已取消，草案未保存。');
          });
          break;
        }
        case 'prepareScorePublication':
          value = workspace.scores.publication.prepare(input);
          break;
        case 'confirmScorePublication':
          value = workspace.scores.publication.confirm(input);
          break;
        case 'readScorePublication':
          value = workspace.scores.publication.status(input);
          break;
        case 'listGradings':
          value = workspace.grading.list(input);
          break;
        case 'editGrading':
          value = workspace.grading.edit(input);
          break;
        case 'rebindGrading':
          value = workspace.grading.rebind(input);
          break;
        case 'freezeGrading':
          value = workspace.grading.freeze(input);
          break;
        case 'gradingAttempts':
          value = workspace.grading.attempts(input);
          break;
        case 'gradingHistory':
          value = workspace.grading.history(input);
          break;
        case 'prepareGrading':
          value = workspace.grading.prepare(input);
          break;
        case 'claimGrading':
          value = workspace.grading.claim(input);
          break;
        case 'endGrading':
          value = workspace.grading.end(input);
          break;
        case 'cancelGrading':
          value = workspace.grading.cancel(input);
          break;
        case 'createClassroom':
          value = workspace.classroom.create(input);
          break;
        case 'readClassroom':
          value = workspace.classroom.read(input);
          break;
        case 'listClassrooms':
          value = workspace.classroom.list(input);
          break;
        case 'controlClassroom':
          value = workspace.classroom.control(input);
          break;
        case 'readCountdown':
          value = workspace.classroom.countdown(input);
          break;
        case 'setCountdown':
          value = workspace.classroom.setCountdown(input);
          break;
        case 'checkpointClassroom':
          workspace.classroom.checkpoint();
          value = null;
          break;
        case 'pauseClassrooms':
          workspace.classroom.pauseAll();
          value = null;
          break;
        case 'readClassroomClock':
          value = workspace.classroom.clock(input);
          break;
        case 'readClassroomProjection': {
          const request = classroomProjectionInput.parse(input);
          const revision = workspace.classroom.revision({ epoch: request.epoch, id: request.id });
          if (revision === request.knownRevision) {
            value = { revision, view: null };
            break;
          }
          const view = workspace.classroom.read({ epoch: request.epoch, id: request.id });
          const version = workspace.lessons.readVersion({
            epoch: request.epoch,
            versionId: view.record.versionId,
          });
          value = {
            revision: view.record.revision,
            view: createClassroomProjection(
              view,
              version.payload.content,
              workspace.classroom.countdown({ epoch: request.epoch }),
              (id, fragmentId) => {
                const material = workspace.materials.read({ epoch: request.epoch, id });
                const fragment = material.version.fragments.find(
                  (value) => value.id === fragmentId,
                );
                if (!fragment || fragment.kind !== 'image')
                  throw new DomainError('VALIDATION', '课堂资料图像无效。');
                const asset = workspace.materials.readAsset({
                  epoch: request.epoch,
                  id,
                  assetId: fragment.assetId,
                });
                if (asset.mime !== 'image/png')
                  throw new DomainError('VALIDATION', '课堂资料图像类型无效。');
                return asset.bytes;
              },
            ),
          };
          break;
        }
        case 'readOfficeSnapshot': {
          const request = officeExportInput.parse(input);
          const version = workspace.lessons.readVersion({
            epoch: request.epoch,
            versionId: request.versionId,
          });
          value = createOfficeSnapshot(version, request, (sourceVersionId, fragmentId) => {
            const material = workspace.materials.read({
              epoch: request.epoch,
              id: sourceVersionId,
            });
            const fragment = material.version.fragments.find(
              (fragment) => fragment.id === fragmentId,
            );
            if (!fragment || fragment.kind !== 'image')
              throw new DomainError('EXPORT_INVALID', '资料图像引用无效。');
            const asset = workspace.materials.readAsset({
              epoch: request.epoch,
              id: sourceVersionId,
              assetId: fragment.assetId,
            });
            if (asset.mime !== 'image/png')
              throw new DomainError('EXPORT_INVALID', '资料图像类型无效。');
            return {
              sourceVersionId,
              fragmentId,
              sha256: fragment.sha256,
              width: fragment.width,
              height: fragment.height,
              bytes: asset.bytes,
            };
          });
          break;
        }
        case 'storeMaterial':
        case 'completeGrading':
        case 'completeLesson': {
          const request = z
            .object({
              command: z.unknown(),
              cancellation: z
                .instanceof(SharedArrayBuffer)
                .refine((buffer) => buffer.byteLength === 4),
            })
            .strict()
            .parse(input);
          const admit = () => {
            if (Atomics.compareExchange(new Int32Array(request.cancellation), 0, 0, 2) !== 0)
              throw new DomainError('ABORTED', '资料或模型任务已取消，未保存。');
          };
          value =
            operation === 'storeMaterial'
              ? workspace.materials.store(request.command, admit)
              : operation === 'completeGrading'
                ? workspace.grading.complete(request.command, admit)
                : workspace.lessons.complete(request.command, admit);
          break;
        }
        case 'readMaterial':
          value = workspace.materials.read(input);
          break;
        case 'listMaterials':
          value = workspace.materials.list(input);
          break;
        case 'readMaterialAsset':
          value = workspace.materials.readAsset(input);
          break;
        case 'readMaterialImage': {
          const request = materialImageReadInput.parse(input);
          const material = workspace.materials.read({ epoch: request.epoch, id: request.id });
          const fragment = material.version.fragments.find(
            (value) => value.id === request.fragmentId,
          );
          if (!fragment || fragment.kind !== 'image')
            throw new DomainError('NOT_FOUND', '资料图像片段不存在。');
          value = workspace.materials.readAsset({
            epoch: request.epoch,
            id: request.id,
            assetId: fragment.assetId,
          });
          break;
        }
        case 'readMaterialOriginal': {
          const request = materialReadInput.parse(input);
          const material = workspace.materials.read(request);
          value = {
            name: material.record.name,
            format: material.version.format,
            ...workspace.materials.readAsset({
              ...request,
              assetId: material.version.originalAssetId,
            }),
          };
          break;
        }
        case 'prepareLesson':
          value = workspace.lessons.prepare(input);
          break;
        case 'createLessonDraft':
          value = workspace.lessons.create(input);
          break;
        case 'readSeatingDraft':
          value = workspace.seating.readDraft(input);
          break;
        case 'readDutyDraft':
          value = workspace.duties.readDraft(input);
          break;
        case 'claimLesson':
          value = workspace.lessons.claim(input);
          break;
        case 'cancelLesson':
          value = workspace.lessons.cancel(input);
          break;
        case 'readLessonDraft':
          value = workspace.lessons.read(input);
          break;
        case 'listLessonDrafts':
          value = workspace.lessons.list(input);
          break;
        case 'editLessonDraft':
          value = workspace.lessons.edit(input);
          break;
        case 'discardLessonDraft':
          value = workspace.lessons.discard(input);
          break;
        case 'freezeLessonDraft':
          value = workspace.lessons.freeze(input);
          break;
        case 'readLessonVersion':
          value = workspace.lessons.readVersion(input);
          break;
        case 'lessonHistory':
          value = workspace.lessons.history(input);
          break;
        case 'reviseLessonVersion':
          value = workspace.lessons.revise(input);
          break;
        case 'readDutyPrintBatch': {
          const { pageOffset, ...read } = dutyPrintBatchInput.parse(input);
          value = createDutyPrintDocument(workspace.duties.read(read), pageOffset);
          break;
        }
        case 'prepareDuty':
          value = workspace.duties.prepare(input);
          break;
        case 'adjustDuty':
          value = workspace.duties.adjust(input);
          break;
        case 'cancelDuty':
          value = workspace.duties.cancel(input);
          break;
        case 'confirmDuty':
          value = workspace.duties.confirm(input);
          break;
        case 'dutyHistory':
          value = workspace.duties.history(input);
          break;
        case 'readDutyVersion':
          value = workspace.duties.read(input);
          break;
        case 'listDutyPlans':
          value = workspace.duties.list(input);
          break;
        case 'prepareSeating':
          value = workspace.seating.prepare(input);
          break;
        case 'adjustSeating':
          value = workspace.seating.adjust(input);
          break;
        case 'cancelSeating':
          value = workspace.seating.cancel(input);
          break;
        case 'confirmSeating':
          value = workspace.seating.confirm(input);
          break;
        case 'seatingHistory':
          value = workspace.seating.history(input);
          break;
        case 'readSeatingVersion':
          value = workspace.seating.read(input);
          break;
        case 'prepareExplanation':
          value = workspace.explanations.prepare(input);
          break;
        case 'claimExplanation':
          value = workspace.explanations.claim(input);
          break;
        case 'completeExplanation': {
          const request = z
            .object({
              command: z.unknown(),
              cancellation: z
                .instanceof(SharedArrayBuffer)
                .refine((buffer) => buffer.byteLength === 4),
            })
            .strict()
            .parse(input);
          value = workspace.explanations.complete(request.command, () => {
            // 0=pending, 1=cancelled, 2=commit admitted. This also works while the queue is busy.
            if (Atomics.compareExchange(new Int32Array(request.cancellation), 0, 0, 2) !== 0)
              throw new DomainError('ABORTED', '解释生成已取消，草案未保存。');
          });
          break;
        }
        case 'cancelExplanation':
          value = workspace.explanations.cancel(input);
          break;
        case 'readExplanation':
          value = workspace.explanations.read(input);
          break;
        case 'listExplanations':
          value = workspace.explanations.list(input);
          break;
        case 'editExplanation':
          value = workspace.explanations.edit(input);
          break;
        case 'discardExplanation':
          value = workspace.explanations.discard(input);
          break;
        case 'snapshot':
          value = workspace.snapshot();
          break;
        case 'previewRosterBytes': {
          const request = z
            .object({
              bytes: z.instanceof(Uint8Array),
              format: z.enum(['csv', 'xlsx']),
              fileName: z.string().max(300),
              configuration: z.unknown(),
            })
            .strict()
            .parse(input);
          value = await workspace.previewRoster(
            request.bytes,
            request.format,
            request.fileName,
            request.configuration,
          );
          break;
        }
        case 'confirmRosterImport':
          value = workspace.confirmRoster(input);
          break;
        case 'cancelRosterPreview':
          workspace.cancelRosterPreview(input);
          value = null;
          break;
        case 'exportRosterTemplate': {
          const request = rosterTemplateInput.parse(input);
          if (workspace.snapshot().epoch !== request.epoch)
            throw new DomainError('CONFLICT', '数据空间已变化，请刷新。');
          value = await createRosterTemplate(request.format);
          break;
        }
        case 'createClass':
          value = workspace.createClass(input);
          break;
        case 'renameClass':
          value = workspace.renameClass(input);
          break;
        case 'saveStudent':
          value = workspace.saveStudent(input);
          break;
        case 'readStudentProfile':
          value = workspace.pupils.readProfile(input);
          break;
        case 'saveStudentProfile':
          value = workspace.pupils.saveProfile(input);
          break;
        case 'studentProfileHistory':
          value = workspace.pupils.profileHistory(input);
          break;
        case 'readAttendanceRoster':
          value = workspace.pupils.roster(input);
          break;
        case 'listAttendance':
          value = workspace.pupils.listAttendance(input);
          break;
        case 'readAttendance':
          value = workspace.pupils.readAttendance(input);
          break;
        case 'attendanceHistory':
          value = workspace.pupils.attendanceHistory(input);
          break;
        case 'saveAttendance':
          value = workspace.pupils.saveAttendance(input);
          break;
        case 'setStudentActive':
          value = workspace.setStudentActive(input);
          break;
        case 'seedDemo':
          value = workspace.seedDemo(input);
          break;
        case 'addSyntheticAsset':
          value = workspace.addSyntheticAsset(input);
          break;
        case 'exportBackup':
          value = workspace.exportBackup(input);
          break;
        case 'previewRestoreBytes':
          value = workspace.previewRestore(z.instanceof(Uint8Array).parse(input));
          break;
        case 'previewRecovery':
          value = workspace.previewRecovery();
          break;
        case 'commitRestore':
          value = workspace.commitRestore(input);
          break;
        case 'previewScoreBytes': {
          const request = z
            .object({ bytes: z.instanceof(Uint8Array), configuration: z.unknown() })
            .strict()
            .parse(input);
          value = await workspace.scores.preview(request.bytes, request.configuration);
          break;
        }
        case 'confirmScores':
          value = workspace.scores.confirm(input);
          break;
        case 'cancelScorePreview':
          value = workspace.scores.cancel(input);
          break;
        case 'listExams':
          value = workspace.scores.list(input);
          break;
        case 'readScoreVersion':
          value = workspace.scores.read(input);
          break;
        case 'scoreHistory':
          value = workspace.scores.history(input);
          break;
        case 'studentScoreHistory':
          value = workspace.scores.studentHistory(input);
          break;
        case 'exportScoreTemplate':
          value = await workspace.scores.template(input);
          break;
      }
      port.postMessage({ id, result: { ok: true, value } });
    } catch (error) {
      port.postMessage({ id, result: { ok: false, error: publicError(error) } });
    }
  };
  // 即使解析过程中发生 await，也不能让恢复、名册修改或下一次预览插队。
  let queue = Promise.resolve();
  port.on('message', (raw: unknown) => {
    const request = requestSchema.safeParse(raw);
    if (!request.success) return;
    queue = queue.then(() => execute(request.data));
  });
} catch (error) {
  port.postMessage({ id: 0, result: { ok: false, error: publicError(error) } });
}
