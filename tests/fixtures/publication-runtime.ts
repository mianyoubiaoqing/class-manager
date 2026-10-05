import { randomUUID } from 'node:crypto';
import { Workspace } from '../../src/core/workspace';
import { gradingStorageFixture } from './grading-storage';

/** 独立合成完整复核，用于实际桌面正式入分；不读凭据，不请求模型。 */
export async function seedPublicationWorkspace(root: string) {
  const workspace = new Workspace(root);
  try {
    const f = await gradingStorageFixture(workspace, {
      initialScore: '0',
      additionalStudentScore: '7',
    });
    const edited = workspace.grading.edit({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: 1,
      edits: f.edits,
    });
    const review = workspace.grading.freeze({
      epoch: f.epoch,
      id: f.draft.id,
      expectedRevision: edited.revision,
      requestId: randomUUID(),
      reason: '完整合成人工复核',
      acknowledgeComplete: true,
    });
    return {
      epoch: f.epoch,
      reviewId: review.reviewId,
      draftId: f.draft.id,
      examId: f.score.examId,
      oldVersionId: f.score.versionId,
      studentId: f.request.studentId,
      subjectId: f.request.subjectId,
    };
  } finally {
    workspace.close();
  }
}
