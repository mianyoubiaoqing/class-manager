import { _electron as electron } from 'playwright';
import { isolatedElectronRuntime } from './isolated-electron-runtime.mjs';
import { strict as assert } from 'node:assert';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { installDesktopCheckFixture } from '../tests/fixtures/desktop-check.ts';
import { openWorkspacePage } from './workspace-ui-navigation.mjs';
import { exerciseScoreUi } from './score-ui-smoke.mjs';
import { exerciseExplanationIpc } from './explanation-ipc-smoke.mjs';
import { exerciseExplanationUi } from './explanation-ui-smoke.mjs';
import { exerciseExplanationReadRaces } from './explanation-race-smoke.mjs';
import { exerciseSeatingUi, exerciseSeatingCapacity } from './seating-ui-smoke.mjs';
import { exerciseDutyIpc } from './duty-ipc-smoke.mjs';
import { exerciseDutyUi } from './duty-ui-smoke.mjs';

const packaged = process.argv.includes('--packaged');
const root = mkdtempSync(join(tmpdir(), 'class-manager-desktop-'));
const dataDirectory = join(root, '合成 数据');
const output = resolve(
  process.env.CLASS_MANAGER_DESKTOP_OUTPUT ??
    join('output/playwright', packaged ? 'packaged' : 'development'),
);
mkdirSync(output, { recursive: true });
const { local, executablePath } = isolatedElectronRuntime('desktop-ui-');
const runtime = packaged
  ? resolve(
      process.env.CLASS_MANAGER_PACKAGED_EXECUTABLE ?? 'release/win-unpacked/Class Manager.exe',
    )
  : executablePath;
const temp = join(local, 'temp');
mkdirSync(temp, { recursive: true });
const env = { ...process.env, CLASS_MANAGER_DATA_DIR: dataDirectory, TEMP: temp, TMP: temp };
delete env.ELECTRON_RUN_AS_NODE;
const options = {
  args: packaged ? [] : ['.'],
  cwd: process.cwd(),
  env,
  timeout: 45000,
  executablePath: runtime,
};
const errors = [];
let application;
const launch = async () => {
  application = await electron.launch(options);
  // Test-only guard: no check in this suite may reach the real provider.
  await application.evaluate(() => {
    globalThis.__cmUnexpectedFetches = 0;
    globalThis.fetch = async () => {
      globalThis.__cmUnexpectedFetches++;
      throw new Error('Desktop smoke forbids external model requests');
    };
  });
  const page = await application.firstWindow();
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByText('本地就绪', { exact: true }).waitFor();
  await openWorkspacePage(page, '班主任管理', '班级名册');
  return page;
};
const installCheckFixture = async () => {
  await application.evaluate(installDesktopCheckFixture);
};
const waitForCheckFixture = async () => {
  await application.evaluate(async () => {
    let timer;
    try {
      await Promise.race([
        globalThis.__cmCheckFixture.started,
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('Check fixture was not invoked')), 5000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  });
};
const releaseCheckFixture = async (success, message) => {
  await application.evaluate(
    (_electron, reply) => {
      const release = globalThis.__cmCheckFixture.release;
      if (!release) throw new Error('No pending check fixture to release');
      release(reply);
    },
    { success, message },
  );
  // A renderer IPC round trip and paint barrier drain the delivered check result.
  await application.firstWindow().then((page) =>
    page.evaluate(async () => {
      await window.classManager.getDeepSeekStatus();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }),
  );
};
const waitForSaved = async (page, text) => {
  await page.getByRole('status').filter({ hasText: text }).waitFor();
};
try {
  let page = await launch();
  const second = spawnSync(packaged ? options.executablePath : runtime, packaged ? [] : ['.'], {
    cwd: process.cwd(),
    env,
    timeout: 15000,
    encoding: 'utf8',
  });
  assert.equal(second.status, 0, second.stderr);
  assert.equal(
    await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
    1,
  );
  await page.getByRole('button', { name: '载入合成样例', exact: true }).click();
  await page.getByRole('button', { name: '确认载入', exact: true }).click();
  await waitForSaved(page, '合成样例已保存');
  assert.equal(await page.locator('tbody tr').count(), 15);
  await page.getByRole('button', { name: '添加学生', exact: true }).click();
  await page.getByLabel('姓名', { exact: true }).fill('合成独立测试');
  await page.getByLabel('学生编号', { exact: true }).fill('E2E-001');
  await page.getByRole('button', { name: '保存学生', exact: true }).click();
  await waitForSaved(page, '学生记录已保存');
  await page.getByRole('textbox', { name: '搜索学生' }).fill('E2E-001');
  assert.equal(await page.locator('tbody tr').count(), 1);
  assert.match(await page.locator('tbody').innerText(), /合成独立测试/);
  await page.getByRole('button', { name: '编辑 E2E-001', exact: true }).click();
  await page.getByLabel('姓名', { exact: true }).fill('合成独立测试修订');
  await page.getByRole('button', { name: '保存学生', exact: true }).click();
  await waitForSaved(page, '学生记录已保存');
  await page.getByRole('textbox', { name: '搜索学生' }).fill('');
  await page.screenshot({ path: join(output, 'roster-desktop.png'), fullPage: true });
  const isolation = await page.evaluate(() => ({
    require: typeof window.require,
    process: typeof window.process,
    api: Object.keys(window.classManager),
    frozen: Object.isFrozen(window.classManager),
  }));
  const expectedApis = [
    'previewRosterImport',
    'confirmRosterImport',
    'exportRosterTemplate',
    'onConversationHistoryClose',
    'listConversationHistory',
    'createConversationHistory',
    'readConversationHistory',
    'saveConversationHistory',
    'renameConversationHistory',
    'deleteConversationHistory',
    'prepareConversation',
    'selectConversationFiles',
    'removeConversationFiles',
    'generateConversation',
    'executeConversation',
    'readConversation',
    'cancelConversation',
    'clearConversationSession',
    'readModelSettings',
    'configureModelProvider',
    'selectModelProvider',
    'saveModelProviderKey',
    'deleteModelProviderKey',
    'prepareModelCheck',
    'checkModelProvider',
    'cancelModelCheck',
    'readModelLedger',
    'readDeviceStatus',
    'measureNoise',
    'requestStudentCall',
    'readStudentCall',
    'cancelDeviceTask',
    'saveGrowthEvent',
    'growthEventHistory',
    'growthTimeline',
    'createGrowthSummary',
    'prepareGrowthSummary',
    'generateGrowthSummary',
    'cancelGrowthSummary',
    'readGrowthSummary',
    'editGrowthSummary',
    'discardGrowthSummary',
    'confirmGrowthSummary',
    'growthSummaryHistory',
    'previewGradingPage',
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
    'generateGrading',
    'cancelGrading',
    'createClassroom',
    'readClassroom',
    'listClassrooms',
    'controlClassroom',
    'readClassroomClock',
    'readCountdown',
    'setCountdown',
    'openClassroomDisplay',
    'closeClassroomDisplay',
    'exportLessonOffice',
    'cancelLessonOffice',
    'openLessonOffice',
    'previewMaterial',
    'scanMaterialFolder',
    'readMaterialFolder',
    'cancelMaterialFolder',
    'openResourceLink',
    'confirmMaterial',
    'cancelMaterial',
    'readMaterialPreviewImage',
    'readMaterial',
    'listMaterials',
    'readMaterialImage',
    'saveMaterialOriginal',
    'prepareLesson',
    'createLessonDraft',
    'readSeatingDraft',
    'readDutyDraft',
    'generateLesson',
    'cancelLesson',
    'readLessonDraft',
    'listLessonDrafts',
    'editLessonDraft',
    'discardLessonDraft',
    'freezeLessonDraft',
    'readLessonVersion',
    'lessonHistory',
    'reviseLessonVersion',
    'prepareDuty',
    'adjustDuty',
    'cancelDuty',
    'confirmDuty',
    'dutyHistory',
    'readDutyVersion',
    'listDutyPlans',
    'previewSeatingPrint',
    'previewDutyPrint',
    'prepareSeating',
    'adjustSeating',
    'cancelSeating',
    'confirmSeating',
    'seatingHistory',
    'readSeatingVersion',
    'prepareExplanation',
    'generateExplanation',
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
    'cancelClassData',
    'configureClassData',
    'confirmClassData',
    'selectClassData',
    'saveAttendance',
    'setStudentActive',
    'seedDemo',
    'addSyntheticAsset',
    'saveBackup',
    'previewRestore',
    'commitRestore',
    'exportDiagnostics',
    'previewRecovery',
    'getDeepSeekStatus',
    'saveDeepSeekKey',
    'deleteDeepSeekKey',
    'checkDeepSeek',
    'cancelDeepSeekCheck',
    'getDeepSeekLedger',
    'previewScores',
    'confirmScores',
    'cancelScorePreview',
    'listExams',
    'readScoreVersion',
    'scoreHistory',
    'studentScoreHistory',
    'exportScoreTemplate',
  ];
  assert.equal(isolation.require, 'undefined');
  assert.equal(isolation.process, 'undefined');
  assert.equal(isolation.frozen, true);
  assert.deepEqual(isolation.api.sort(), expectedApis.sort());
  const preferences = await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
  );
  assert.equal(preferences.sandbox, true);
  assert.equal(preferences.contextIsolation, true);
  assert.equal(preferences.nodeIntegration, false);
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 390, height: 844 }),
  );
  await page.waitForTimeout(250);
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
    false,
  );
  await page.screenshot({ path: join(output, 'roster-narrow.png'), fullPage: true });
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1240, height: 820 }),
  );
  await openWorkspacePage(page, '系统设置', '模型设置');
  await page.getByText('兼容与维护', { exact: true }).click();
  await page.getByRole('button', { name: '打开DeepSeek兼容设置', exact: true }).click();
  await page.screenshot({ path: join(output, 'deepseek-settings.png'), fullPage: true });
  for (const width of [360, 390]) {
    await application.evaluate(
      ({ BrowserWindow }, width) =>
        BrowserWindow.getAllWindows()[0].setBounds({ width, height: 844 }),
      width,
    );
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
    );
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth),
      false,
      `Model settings must fit a ${width}px window`,
    );
    await page.screenshot({
      path: join(output, `deepseek-settings-${width}.png`),
      fullPage: true,
    });
  }
  await application.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0].setBounds({ width: 1240, height: 820 }),
  );
  assert.match(await page.locator('.settings-section').first().innerText(), /未配置密钥/);
  const keyInput = page.getByPlaceholder('输入或粘贴 DeepSeek API Key (如 sk-...)');
  await keyInput.fill('sk-synthetic-desktop-smoke-test-key-1234');
  await page.getByRole('button', { name: '保存并加密存储', exact: true }).click();
  await waitForSaved(page, 'DeepSeek API Key 已安全加密存储');
  assert.match(await page.locator('.settings-section').first().innerText(), /sk-\.\.\.1234/);

  await installCheckFixture();
  // Positive control: prove that the real renderer receives and displays fixture replies.
  await page.getByRole('button', { name: '检查文本模型连通性', exact: true }).click();
  await waitForCheckFixture();
  await releaseCheckFixture(true, '当前账号替身响应已显示');
  await waitForSaved(page, '当前账号替身响应已显示');
  for (const [success, suffix] of [
    [true, '5678'],
    [false, '9012'],
  ]) {
    await page.getByRole('button', { name: '检查文本模型连通性', exact: true }).click();
    await waitForCheckFixture();
    await keyInput.fill(`sk-synthetic-desktop-smoke-test-key-${suffix}`);
    await page.getByRole('button', { name: '保存并加密存储', exact: true }).click();
    await waitForSaved(page, 'DeepSeek API Key 已安全加密存储');
    assert.match(
      await page.locator('.settings-section').first().innerText(),
      new RegExp(`sk-\\.\\.\\.${suffix}`),
    );
    await releaseCheckFixture(success, '迟到的旧账号响应-不应显示');
    assert.doesNotMatch(await page.locator('body').innerText(), /迟到的旧账号响应-不应显示/);
    await waitForSaved(page, 'DeepSeek API Key 已安全加密存储');
  }
  assert.deepEqual(
    await application.evaluate(() => ({
      calls: globalThis.__cmCheckFixture.calls,
      cancellations: globalThis.__cmCheckFixture.cancellations,
      replies: globalThis.__cmCheckFixture.replies,
      unexpectedFetches: globalThis.__cmUnexpectedFetches,
    })),
    { calls: 3, cancellations: 2, replies: 3, unexpectedFetches: 0 },
  );

  await page.getByRole('button', { name: '清除已存凭据', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '确认清除', exact: true }).click();
  await waitForSaved(page, '已清除保存的 API Key');
  assert.match(await page.locator('.settings-section').first().innerText(), /未配置密钥/);
  await page.getByRole('button', { name: '数据与备份' }).click();
  await page.getByRole('button', { name: '添加合成验证附件', exact: true }).click();
  await waitForSaved(page, '合成验证附件已保存');
  // 成绩页面接入前，先通过真实的冻结 Preload 验证完整文件/worker/事务调用链。
  const scoreSnapshot = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(scoreSnapshot.ok, true);
  const scoreClass = scoreSnapshot.value.classes[0];
  const scoreStudents = scoreSnapshot.value.students.filter(
    (student) => student.active && student.classId === scoreClass.id,
  );
  const subjectId = '30000000-0000-4000-8000-000000000001';
  const groupId = '40000000-0000-4000-8000-000000000001';
  const scoreConfiguration = {
    epoch: scoreSnapshot.value.epoch,
    classId: scoreClass.id,
    expectedRevision: 0,
    definition: {
      name: '合成接口月考',
      date: '2026-09-30',
      academicYear: '2026-2027',
      term: '上学期',
      grade: '高一',
    },
    subjects: [{ id: subjectId, name: '数学', maxScore: '150', precision: 2 }],
    groups: [{ id: groupId, name: '数学组', subjectIds: [subjectId] }],
    assignments: scoreStudents.map((student) => ({ studentId: student.id, groupId })),
    scoreBasis: 'raw',
  };
  for (const format of ['csv', 'xlsx']) {
    const templatePath = join(root, `score-template.${format}`);
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, templatePath);
    const exported = await page.evaluate(
      (input) => window.classManager.exportScoreTemplate(input),
      { ...scoreConfiguration, format },
    );
    assert.equal(exported.ok, true, JSON.stringify(exported));
    const bytes = readFileSync(templatePath);
    if (format === 'csv')
      assert.ok(bytes.toString('utf8').includes(scoreStudents[0].studentNumber));
    else assert.equal(bytes.subarray(0, 2).toString(), 'PK');
  }
  const scorePath = join(root, 'score-import.csv');
  writeFileSync(scorePath, `学生编号,数学\n${scoreStudents[0].studentNumber},99`, 'utf8');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, scorePath);
  const scorePreview = await page.evaluate(
    (input) => window.classManager.previewScores(input),
    scoreConfiguration,
  );
  assert.equal(scorePreview.ok, true, JSON.stringify(scorePreview));
  assert.equal(scorePreview.value.canConfirm, true);
  assert.equal(scorePreview.value.statistics.subjects[0].mean, '99.00');
  assert.equal(scorePreview.value.missingStudentIds.length, scoreStudents.length - 1);
  const scoreCommand = {
    epoch: scoreConfiguration.epoch,
    token: scorePreview.value.token,
    requestId: randomUUID(),
    expectedRevision: 0,
    reason: '合成桌面确认',
  };
  const scoreReceipt = await page.evaluate(
    (input) => window.classManager.confirmScores(input),
    scoreCommand,
  );
  assert.equal(scoreReceipt.ok, true, JSON.stringify(scoreReceipt));
  const scoreReplay = await page.evaluate(
    (input) => window.classManager.confirmScores(input),
    scoreCommand,
  );
  assert.equal(scoreReplay.value.replayed, true);
  writeFileSync(scorePath, `学生编号,数学\n${scoreStudents[0].studentNumber},100`, 'utf8');
  const correction = await page.evaluate((input) => window.classManager.previewScores(input), {
    ...scoreConfiguration,
    examId: scoreReceipt.value.examId,
    expectedRevision: 1,
  });
  assert.equal(correction.ok, true, JSON.stringify(correction));
  assert.equal(correction.value.differences.scores.length, 1);
  const corrected = await page.evaluate((input) => window.classManager.confirmScores(input), {
    epoch: scoreConfiguration.epoch,
    token: correction.value.token,
    requestId: randomUUID(),
    expectedRevision: 1,
    reason: '合成复核更正',
  });
  assert.equal(corrected.ok, true, JSON.stringify(corrected));
  const oldVersion = await page.evaluate((input) => window.classManager.readScoreVersion(input), {
    epoch: scoreConfiguration.epoch,
    versionId: scoreReceipt.value.versionId,
  });
  assert.equal(oldVersion.value.stale, true);
  assert.equal(oldVersion.value.statistics.subjects[0].mean, '99.00');
  const history = await page.evaluate((input) => window.classManager.studentScoreHistory(input), {
    epoch: scoreConfiguration.epoch,
    studentId: scoreStudents[0].id,
    subjectId,
  });
  assert.equal(history.value.entries[0].ratePercent, '66.67');
  await application.evaluate(({ dialog }) => {
    dialog.showOpenDialog = async () => ({ canceled: true, filePaths: [] });
  });
  const cancelledScore = await page.evaluate((input) => window.classManager.previewScores(input), {
    ...scoreConfiguration,
    examId: scoreReceipt.value.examId,
    expectedRevision: 2,
  });
  assert.deepEqual(cancelledScore, { ok: true, value: null });
  const explanationId = await exerciseExplanationIpc(
    application,
    page,
    scoreConfiguration.epoch,
    corrected.value.versionId,
    subjectId,
  );

  const backupPath = join(root, 'roundtrip.cmbackup');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, backupPath);
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  await waitForSaved(page, '备份已保存');
  const bundle = JSON.parse(readFileSync(backupPath, 'utf8'));
  assert.equal(bundle.assets.length, 1);
  await application.evaluate(({ dialog }) => {
    dialog.showSaveDialog = async () => ({ canceled: true, filePath: '' });
  });
  await page.getByRole('button', { name: '导出备份', exact: true }).click();
  await waitForSaved(page, '已取消备份保存');
  const invalidPath = join(root, 'invalid.cmbackup');
  writeFileSync(invalidPath, '{"format":"not-a-backup"}');
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, invalidPath);
  await page.getByRole('button', { name: '选择备份恢复', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: '不是受支持的 M0 备份' }).waitFor();
  const afterInvalid = await page.evaluate(() => window.classManager.snapshot());
  assert.equal(afterInvalid.value.students.length, 101);
  await application.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, backupPath);
  await page.getByRole('button', { name: '选择备份恢复', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  assert.match(
    await page
      .getByRole('dialog')
      .getByText('考试 / 成绩版本', { exact: true })
      .locator('..')
      .innerText(),
    /1\s*\/\s*2/,
  );
  assert.equal(
    await page
      .getByRole('dialog')
      .getByText('解释草案（含已丢弃）', { exact: true })
      .locator('xpath=following-sibling::dd[1]')
      .innerText(),
    '1',
  );
  assert.equal(
    await page
      .getByRole('dialog')
      .getByText('座位版本', { exact: true })
      .locator('xpath=following-sibling::dd[1]')
      .innerText(),
    '0',
  );
  assert.match(
    await page.getByRole('dialog').innerText(),
    /恢复将替换.*名册.*成绩.*教学.*阅卷.*计划.*附件/,
  );
  assert.match(await page.getByRole('dialog').innerText(), /值日版本/);
  assert.equal(
    await page
      .getByRole('dialog')
      .getByText('值日版本', { exact: true })
      .locator('xpath=following-sibling::dd[1]')
      .innerText(),
    '0',
  );
  await page.screenshot({ path: join(output, 'restore-confirmation.png'), fullPage: true });
  await page.getByRole('button', { name: '确认替换并恢复', exact: true }).click();
  await waitForSaved(page, '备份已恢复');
  const restoredScoreSnapshot = await page.evaluate(() => window.classManager.snapshot());
  const restoredScore = await page.evaluate(
    (input) => window.classManager.readScoreVersion(input),
    {
      epoch: restoredScoreSnapshot.value.epoch,
      versionId: corrected.value.versionId,
    },
  );
  assert.equal(restoredScore.ok, true, JSON.stringify(restoredScore));
  assert.equal(restoredScore.value.statistics.subjects[0].mean, '100.00');
  const restoredExplanation = await page.evaluate(
    (input) => window.classManager.readExplanation(input),
    {
      epoch: restoredScoreSnapshot.value.epoch,
      id: explanationId,
    },
  );
  assert.equal(restoredExplanation.value.record.status, 'discarded');
  assert.equal(restoredExplanation.value.payload.content.teacherNotes, '合成教师复核');
  await page.getByRole('button', { name: '回退到恢复前', exact: true }).click();
  await page.getByRole('dialog').waitFor();
  await page.getByRole('button', { name: '确认替换并恢复', exact: true }).click();
  await waitForSaved(page, '备份已恢复');
  const diagnosticsPath = join(root, 'diagnostics.json');
  await application.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, diagnosticsPath);
  await page.getByRole('button', { name: '导出诊断', exact: true }).click();
  await waitForSaved(page, '诊断已保存');
  const diagnostics = readFileSync(diagnosticsPath, 'utf8');
  assert.doesNotMatch(diagnostics, /合成独立测试|E2E-001|DEMO-1|workspace-data|base64/);
  assert.equal(JSON.parse(diagnostics).counts.students, 101);
  await page.screenshot({ path: join(output, 'maintenance.png'), fullPage: true });
  await exerciseExplanationUi(application, page, root, output, scoreConfiguration.definition.name);
  const seatingEvidence = await exerciseSeatingUi(application, page, output);
  const dutyEvidence = await exerciseDutyIpc(page);
  const dutyUiEvidence = await exerciseDutyUi(application, page, output);
  const uiSnapshot = await exerciseScoreUi(application, page, root, output);
  await exerciseExplanationReadRaces(
    application,
    page,
    uiSnapshot,
    scoreConfiguration.definition.name,
  );
  await exerciseSeatingCapacity(application, page, uiSnapshot, output);
  await application.close();
  application = undefined;
  for (let index = 0; index < 10; index++) {
    page = await launch();
    const result = await page.evaluate(() => window.classManager.snapshot());
    assert.equal(result.ok, true);
    assert.equal(result.value.students.length, 101);
    assert.equal(result.value.assets.length, 1);
    const seating = await page.evaluate((input) => window.classManager.readSeatingVersion(input), {
      epoch: result.value.epoch,
      versionId: seatingEvidence.versionId,
    });
    assert.equal(seating.ok, true);
    assert.deepEqual(seating.value.payload, seatingEvidence.payload);
    const duty = await page.evaluate((input) => window.classManager.readDutyVersion(input), {
      epoch: result.value.epoch,
      versionId: dutyEvidence.versionId,
    });
    assert.equal(duty.ok, true, JSON.stringify(duty));
    assert.deepEqual(duty.value.payload, dutyEvidence.payload);
    const dutyUi = await page.evaluate((input) => window.classManager.readDutyVersion(input), {
      epoch: result.value.epoch,
      versionId: dutyUiEvidence.versionId,
    });
    assert.equal(dutyUi.ok, true, JSON.stringify(dutyUi));
    assert.deepEqual(dutyUi.value.payload, dutyUiEvidence.payload);
    const drafts = await page.evaluate(
      (epoch) => window.classManager.listExplanations({ epoch, includeDiscarded: true }),
      result.value.epoch,
    );
    assert.equal(drafts.ok, true, JSON.stringify(drafts));
    assert.equal(
      drafts.value.find((draft) => draft.record.id === explanationId)?.record.status,
      'discarded',
    );
    assert.equal(
      result.value.students.find((student) => student.studentNumber === 'E2E-001').displayName,
      '合成独立测试修订',
    );
    await application.close();
    application = undefined;
  }
  assert.deepEqual(errors, []);
  const report = {
    status: 'passed',
    packaged,
    executablePath: options.executablePath,
    at: new Date().toISOString(),
    reopenCycles: 10,
    cases: [
      'single-instance',
      'create-edit',
      'sandbox',
      'narrow-layout',
      'backup',
      'cancel-save',
      'invalid-backup',
      'restore',
      'score-template',
      'score-preview',
      'score-confirmation',
      'score-correction-history',
      'score-restored-history',
      'explanation-ipc-synthetic-generation-edit-discard',
      'explanation-backup-restore-reopen',
      'explanation-ui-confirm-edit-discard',
      'explanation-ui-invalid-cancel-stale-regenerate',
      'explanation-ui-narrow-layout',
      'explanation-ui-read-races',
      'explanation-ui-ambiguous-save-reconciliation',
      'explanation-ui-offline-no-retry-preserves-draft',
      'score-ui-import-correction-history',
      'score-ui-invalid-exclusion-mapping',
      'score-ui-config-invalidation',
      'score-ui-narrow-layout',
      'score-ui-refresh-race',
      'seating-ui-layout-random-lock-move-conflicts',
      'seating-ui-confirm-cancel-history',
      'seating-ui-narrow-layout-reopen',
      'seating-ui-lost-adjustment-reply-recovery',
      'seating-ui-lost-confirmation-cancel-and-idempotent-retry',
      'seating-ui-roster-growth-beyond-default-capacity',
      'duty-ipc-prepare-adjust-confirm-directory-history',
      'duty-ipc-idempotent-retry-conflict-cancel',
      'duty-ipc-ten-reopens-preserve-payload',
      'duty-ui-configuration-shortage-conflict-absence-substitute',
      'duty-ui-completed-date-freeze-participant-replacement-history',
      'duty-ui-narrow-layout-lost-replies-original-retry-ten-reopens',
      'recovery-copy',
      'redacted-diagnostics',
      'deepseek-settings',
      'deepseek-settings-narrow-layout',
      'deepseek-current-response-control',
      'deepseek-key-change-late-success',
      'deepseek-key-change-late-failure',
      'reopen',
    ],
    dataDirectory,
    output,
    errors,
  };
  writeFileSync(join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  if (application) {
    const page = await application.firstWindow().catch(() => undefined);
    if (page) {
      console.error(
        (
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 7000),
      );
      await page.screenshot({ path: join(output, 'failure.png') }).catch(() => {});
    }
  }
  throw error;
} finally {
  await application?.close();
}
