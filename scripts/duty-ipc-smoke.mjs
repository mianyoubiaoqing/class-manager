import { strict as assert } from 'node:assert';
import { randomUUID } from 'node:crypto';

/** Uses only the desktop smoke suite's isolated synthetic roster; no model requests. */
export async function exerciseDutyIpc(page) {
  const call = (method, input) =>
    page.evaluate(({ method, input }) => window.classManager[method](input), { method, input });
  const value = (result) => {
    assert.equal(result.ok, true, JSON.stringify(result));
    return result.value;
  };
  const snapshot = value(await call('snapshot'));
  const classId = snapshot.classes.find(
    (item) =>
      snapshot.students.filter((student) => student.active && student.classId === item.id).length >=
      4,
  ).id;
  const epoch = snapshot.epoch;
  const participantIds = snapshot.students
    .filter((student) => student.active && student.classId === classId)
    .slice(0, 4)
    .map((student) => student.id);
  const dates = [1, 2, 3].map((offset) =>
    new Date(Date.now() + offset * 86400000 + 8 * 3600000).toISOString().slice(0, 10),
  );
  const start = {
    epoch,
    classId,
    expectedRevision: 0,
    source: {
      kind: 'new',
      title: '桌面合成值日',
      participantIds,
      dates,
      groupCount: 2,
      posts: [{ id: randomUUID(), name: '清扫', startMinute: 960, endMinute: 980, required: 1 }],
      unavailable: [],
    },
  };
  const draft = value(await call('prepareDuty', start));
  const ready = value(
    await call('adjustDuty', {
      epoch,
      token: draft.token,
      change: { kind: 'rotate' },
    }),
  );
  const command = {
    epoch,
    token: ready.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '桌面合成确认',
  };
  const receipt = value(await call('confirmDuty', command));
  assert.deepEqual(value(await call('confirmDuty', command)), { ...receipt, replayed: true });
  const read = value(await call('readDutyVersion', { epoch, versionId: receipt.versionId }));
  assert.deepEqual(read.payload.arrangement, ready.draft);
  const plans = value(await call('listDutyPlans', { epoch, classId }));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].latestVersionId, receipt.versionId);
  assert.equal(
    value(await call('dutyHistory', { epoch, classId, planId: receipt.planId })).length,
    1,
  );
  const competing = value(await call('prepareDuty', start));
  const conflict = await call('confirmDuty', {
    ...command,
    token: competing.token,
    requestId: randomUUID(),
  });
  assert.equal(conflict.ok, false);
  assert.equal(conflict.error.code, 'DUTY_CONFLICT');
  value(await call('cancelDuty', { epoch, token: competing.token }));
  const expired = await call('confirmDuty', {
    ...command,
    token: competing.token,
    requestId: randomUUID(),
  });
  assert.equal(expired.ok, false);
  assert.equal(expired.error.code, 'DUTY_DRAFT_EXPIRED');
  return { versionId: receipt.versionId, payload: read.payload };
}
