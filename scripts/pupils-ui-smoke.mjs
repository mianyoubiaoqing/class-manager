import { _electron as electron } from 'playwright';
import electronPath from 'electron';
import { strict as assert } from 'node:assert';
import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';

const localBase = join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
mkdirSync(localBase, { recursive: true });
const root = mkdtempSync(join(localBase, 'pupils-context-'));
const executable = process.env.CLASS_MANAGER_PUPIL_EXECUTABLE;
const runtime = executable ?? join(root, 'runtime', 'electron.exe');
if (!executable) cpSync(resolve(electronPath, '..'), join(root, 'runtime'), { recursive: true });
mkdirSync(join(root, 'temp'));
const env = {
  ...process.env,
  CLASS_MANAGER_DATA_DIR: join(root, 'user-data'),
  TEMP: join(root, 'temp'),
  TMP: join(root, 'temp'),
};
delete env.ELECTRON_RUN_AS_NODE;
const report = {
  status: 'running',
  root,
  packaged: !!executable,
  gates: [],
  errors: [],
  externalRequests: 0,
};
let app, page;
const call = async (name, input) => {
  const result = await page.evaluate(({ name, input }) => window.classManager[name](input), {
    name,
    input,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.value;
};
const button = (name) => page.getByRole('button', { name, exact: true });
async function send(text) {
  const field = page.getByLabel('发送消息', { exact: true });
  await field.fill(text);
  await field.press('Enter');
  await page.getByRole('heading', { name: '模型提议 · 尚未执行', exact: true }).waitFor();
}
async function agentMode(mode) {
  await app.evaluate((_electron, mode) => {
    globalThis.__pupilAudit = { mode, step: 0, external: 0, bodies: [] };
    globalThis.fetch = async (url, init) => {
      const state = globalThis.__pupilAudit;
      if (!String(url).includes('api.deepseek.com')) {
        state.external++;
        throw Error('Unexpected outbound request');
      }
      const body = JSON.parse(String(init.body));
      state.bodies.push(body);
      let action;
      if (++state.step === 1)
        action =
          mode === 'profile'
            ? { kind: 'tool', tool: 'readStudentProfile', args: { studentId: '[学生1]' } }
            : { kind: 'tool', tool: 'readAttendanceRoster', args: { classId: '[班级1]' } };
      else if (state.step === 2) {
        if (mode === 'profile')
          action = {
            kind: 'tool',
            tool: 'saveStudentProfile',
            args: {
              studentId: '[学生1]',
              content: { interests: '绘画、阅读' },
              reason: '教师补充兴趣',
            },
          };
        else {
          const data = JSON.parse(body.messages.at(-1).content).toolResult.data;
          action = {
            kind: 'tool',
            tool: 'saveAttendance',
            args: {
              classId: '[班级1]',
              date: '2026-10-04',
              title: '待核对的课堂点名',
              marks: data.students.map((s) => ({
                studentId: s.studentId,
                status: 'unmarked',
                note: '',
              })),
              reason: '教师要求保存待核对名册',
            },
          };
        }
      } else action = { kind: 'reply', text: '已保存确认的记录，可以继续工作。' };
      return new Response(
        JSON.stringify({
          id: 'pupil-mock-' + state.step,
          model: 'synthetic-server',
          choices: [
            {
              finish_reason: 'stop',
              message: {
                content: JSON.stringify({ formatVersion: 1, explanation: '核对后保存', action }),
              },
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
        }),
      );
    };
  }, mode);
}
try {
  app = await electron.launch({
    executablePath: runtime,
    args: executable ? [] : ['.'],
    cwd: process.cwd(),
    env,
    timeout: 45000,
  });
  await app.evaluate(() => {
    globalThis.fetch = async () => {
      throw Error('Pupil smoke forbids real model requests');
    };
  });
  page = await app.firstWindow();
  page.on('pageerror', (error) => report.errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  let snapshot = await call('snapshot');
  snapshot = await call('seedDemo', { epoch: snapshot.epoch });
  await page.reload();
  await page.getByText('本地就绪', { exact: true }).waitFor();
  assert.equal(snapshot.schemaVersion, 12);
  await button('学生资料').click();
  await page.getByLabel('兴趣与特长', { exact: true }).waitFor();
  assert.equal(await page.getByLabel('监护人姓名', { exact: true }).isVisible(), false);
  await page.getByLabel('兴趣与特长', { exact: true }).fill('绘画');
  await page.getByRole('tab', { name: '基本与联系信息', exact: true }).click();
  await page.getByLabel('监护人姓名', { exact: true }).fill('虚构监护人');
  await page.getByLabel('联系电话', { exact: true }).fill('13800000000');
  await page.getByRole('tab', { name: '基本与联系信息', exact: true }).press('ArrowLeft');
  assert.equal(await page.getByLabel('兴趣与特长', { exact: true }).inputValue(), '绘画');
  await button('保存学生资料').click();
  await button('确认保存学生资料').click();
  await page.getByText('学生资料已保存，原修订保留。', { exact: true }).waitFor();
  await page.screenshot({ path: join(root, 'student-profile.png') });
  const student = snapshot.students[0];
  const original = await call('readStudentProfile', {
    epoch: snapshot.epoch,
    studentId: student.id,
  });
  assert.equal(original.content.interests, '绘画');
  assert.equal(original.content.guardianPhone, '13800000000');
  report.gates.push('teacher-profile-save');
  await button('上课点名').click();
  await page.getByRole('tabpanel', { name: '逐人点名', exact: true }).waitFor();
  await button('到课并下一位').click();
  await button('迟到并下一位').click();
  await button('请假并下一位').click();
  await button('缺席并下一位').click();
  await button('保存点名记录').click();
  await button('确认保存点名').click();
  await page.getByText('点名记录已保存，后续更正会保留原版本。', { exact: true }).waitFor();
  const records = await call('listAttendance', {
    epoch: snapshot.epoch,
    classId: snapshot.classes[0].id,
  });
  assert.equal(records.length, 1);
  assert.deepEqual(
    records[0].rows.slice(0, 4).map((r) => r.status),
    ['present', 'late', 'excused', 'absent'],
  );
  assert.equal(records[0].rows.filter((r) => r.status === 'unmarked').length, 46);
  await page.screenshot({ path: join(root, 'attendance.png') });
  report.gates.push('teacher-roll-call-save');
  await page.getByRole('tab', { name: '全班名单', exact: true }).click();
  await page.getByLabel('查找点名学生', { exact: true }).fill(records[0].rows[1].studentNumber);
  await page
    .getByRole('row')
    .filter({ hasText: records[0].rows[1].displayName })
    .getByRole('combobox')
    .selectOption('present');
  await button('保存点名记录').click();
  await button('确认保存点名').click();
  await page.getByText('点名记录已保存，后续更正会保留原版本。', { exact: true }).waitFor();
  const versions = await call('attendanceHistory', { epoch: snapshot.epoch, id: records[0].id });
  assert.equal(versions.length, 2);
  assert.equal(versions[1].record.rows[1].status, 'late');
  report.gates.push('immutable-attendance-correction');
  await page.setViewportSize({ width: 360, height: 800 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(root, 'attendance-360.png'), fullPage: true });
  await page.setViewportSize({ width: 1224, height: 780 });
  report.gates.push('progressive-tabs-keep-edits-keyboard-navigation-search-and-360px-layout');
  await call('saveModelProviderKey', {
    provider: 'deepseek',
    apiKey: 'sk-synthetic-pupil-smoke-only',
  });
  await button('业务对话').click();
  await agentMode('profile');
  await send('为学生补充兴趣为绘画、阅读，请先展示确认。');
  const pendingProfile = await call('readStudentProfile', {
    epoch: snapshot.epoch,
    studentId: student.id,
  });
  assert.equal(pendingProfile.content.interests, '绘画');
  await button('确认执行操作').click();
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  const savedProfile = await call('readStudentProfile', {
    epoch: snapshot.epoch,
    studentId: student.id,
  });
  assert.equal(savedProfile.content.interests, '绘画、阅读');
  assert.equal(savedProfile.content.guardianPhone, '13800000000');
  const profileBodies = await app.evaluate(() => globalThis.__pupilAudit.bodies);
  const profileWire = JSON.stringify(profileBodies);
  assert.equal(profileWire.includes('13800000000'), false);
  assert.equal(profileWire.includes('虚构监护人'), false);
  assert.equal(profileBodies.length, 3);
  report.gates.push('agent-profile-confirm-and-continue-private-fields-preserved');
  await agentMode('attendance');
  await send('为当前班级保存一份课堂点名，未知状态保留未点名。');
  const pendingRoll = await call('listAttendance', {
    epoch: snapshot.epoch,
    classId: snapshot.classes[0].id,
  });
  assert.equal(pendingRoll.length, 1);
  await button('确认执行操作').click();
  await page.getByRole('heading', { name: '本轮完成', exact: true }).waitFor();
  const afterRoll = await call('listAttendance', {
    epoch: snapshot.epoch,
    classId: snapshot.classes[0].id,
  });
  assert.equal(afterRoll.length, 2);
  assert.equal(
    afterRoll[0].rows.every((r) => r.status === 'unmarked'),
    true,
  );
  const state = await app.evaluate(() => globalThis.__pupilAudit);
  assert.equal(state.step, 3);
  report.externalRequests = state.external;
  report.gates.push('agent-attendance-confirm-and-continue');
  assert.deepEqual(report.errors, []);
  assert.equal(report.externalRequests, 0);
  await page.screenshot({ path: join(root, 'agent-pupils.png') });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = String(error.stack ?? error);
  await page?.screenshot({ path: join(root, 'failure.png') }).catch(() => {});
  process.exitCode = 1;
} finally {
  if (app)
    await closeAuditApplication(app, () => {}).catch((error) => {
      report.closeFailure = String(error);
      process.exitCode = 1;
      report.status = 'failed';
    });
  writeAuditReport(join(root, 'pupil-smoke-report.json'), report);
  if (process.env.CLASS_MANAGER_PUPIL_REPORT)
    writeAuditReport(process.env.CLASS_MANAGER_PUPIL_REPORT, report);
  console.log(JSON.stringify(report, null, 2));
}
