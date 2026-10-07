import { _electron as electron } from 'playwright';
import { strict as assert } from 'node:assert';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import JSZip from 'jszip';
import { closeAuditApplication, writeAuditReport } from './live-audit-guards.ts';

const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
async function inventory(directory, relative = '') {
  const files = [];
  for (const entry of await fs.readdir(path.join(directory, relative), { withFileTypes: true })) {
    const file = path.join(relative, entry.name);
    assert.ok(entry.isDirectory() || entry.isFile(), 'Unexpected filesystem entry: ' + file);
    if (entry.isDirectory()) files.push(...(await inventory(directory, file)));
    else files.push({ file, sha256: hash(await fs.readFile(path.join(directory, file))) });
  }
  return files.sort((a, b) => a.file.localeCompare(b.file));
}

export async function runPortableSmoke(executable, output) {
  executable = path.resolve(executable);
  output = path.resolve(output);
  await fs.mkdir(output, { recursive: true });
  const parent = path.join(process.env.USERPROFILE, 'ClassManagerSetupChecks');
  await fs.mkdir(parent, { recursive: true });
  const root = await fs.mkdtemp(path.join(parent, 'portable-'));
  const data = path.join(root, '合成 数据');
  const temp = path.join(root, '临时 文件');
  const cwd = path.join(root, '无开发工具 运行目录');
  await fs.mkdir(temp);
  await fs.mkdir(cwd);
  const alternate = path.join(root, '更换目录后的 程序');
  const directory = path.dirname(executable);
  const before = await inventory(directory);
  await fs.cp(directory, alternate, { recursive: true, errorOnExist: true, force: false });
  const alternateExe = path.join(alternate, path.basename(executable));
  const env = { ...process.env, CLASS_MANAGER_DATA_DIR: data, TEMP: temp, TMP: temp };
  for (const name of Object.keys(env))
    if (name.toLowerCase() === 'path' || name.startsWith('ELECTRON_') || name === 'NODE_OPTIONS')
      delete env[name];
  env.PATH = path.join(process.env.SystemRoot, 'System32');
  const reportFile = path.join(output, 'portable-smoke-report.json');
  const report = {
    status: 'running',
    startedAt: new Date().toISOString(),
    executable,
    root,
    data,
    packaged: true,
    pathContainsDevelopmentTools: false,
    externalRequests: 0,
    errors: [],
    gates: [],
    exports: [],
    limitations: [
      'This Windows x64 computer has development tools installed; application PATH is restricted to Windows System32.',
      'File dialogs are replaced in the owned test process; business IPC, SQLite, backup and Office generation are real.',
      'Synthetic isolated userData is used; the current installed application and customer database are not opened.',
      'No paid models, other Windows versions, exFAT media, read-only directories or external Office applications are tested.',
    ],
  };
  let application, page;
  const save = () => writeAuditReport(reportFile, report);
  const call = async (name, input) => {
    const result = await page.evaluate(({ name, input }) => window.classManager[name](input), {
      name,
      input,
    });
    assert.equal(result.ok, true, name + ': ' + JSON.stringify(result));
    return result.value;
  };
  const gate = (name) => {
    report.gates.push(name);
    save();
  };
  async function launch(file = executable) {
    application = await electron.launch({
      executablePath: file,
      args: [],
      env,
      cwd,
      timeout: 45000,
    });
    await application.evaluate(() => {
      globalThis.__portableNetworkRequests = 0;
      globalThis.fetch = async () => {
        globalThis.__portableNetworkRequests++;
        throw new Error('Portable acceptance forbids external model requests');
      };
    });
    page = await application.firstWindow();
    page.on('pageerror', (error) => report.errors.push(error.message));
    await page.getByText('本地就绪', { exact: true }).waitFor();
    await fs.writeFile(path.join(output, 'latest-ui.txt'), await page.locator('body').innerText());
    const identity = await application.evaluate(({ app, BrowserWindow }) => ({
      packaged: app.isPackaged,
      name: app.getName(),
      userData: app.getPath('userData'),
      executable: app.getPath('exe'),
      windows: BrowserWindow.getAllWindows().length,
      preferences: BrowserWindow.getAllWindows()[0].webContents.getLastWebPreferences(),
    }));
    assert.equal(identity.packaged, true);
    assert.equal(identity.name, 'Class Manager');
    assert.equal(path.resolve(identity.userData), data);
    assert.equal(path.resolve(identity.executable), path.resolve(file));
    assert.equal(identity.preferences.sandbox, true);
    assert.equal(identity.preferences.contextIsolation, true);
    assert.equal(identity.preferences.nodeIntegration, false);
    const bridge = await page.evaluate(() => ({
      api: !!window.classManager,
      node: typeof window.require,
      frozen: Object.isFrozen(window.classManager),
    }));
    assert.deepEqual(bridge, { api: true, node: 'undefined', frozen: true });
  }
  async function close() {
    report.externalRequests += await application.evaluate(
      () => globalThis.__portableNetworkRequests,
    );
    await closeAuditApplication(application, () => {});
    application = undefined;
  }
  async function saveTo(file) {
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath });
    }, file);
  }
  try {
    save();
    await launch();
    assert.equal((await call('snapshot')).classes.length, 0);
    assert.equal((await call('snapshot')).students.length, 0);
    await page.getByRole('button', { name: '打开智能对话小窗', exact: true }).click();
    assert.ok(await page.getByRole('textbox', { name: '发送消息', exact: true }).isVisible());
    await page.screenshot({ path: path.join(output, 'portable-first-launch.png'), fullPage: true });
    gate(
      'Fresh extracted ZIP starts in a Chinese/space path and opens the production floating conversation over an isolated empty workspace.',
    );

    const second = spawnSync(alternateExe, [], {
      env,
      cwd,
      timeout: 15000,
      windowsHide: true,
      encoding: 'utf8',
    });
    assert.equal(second.error, undefined, second.error?.message);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(
      await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length),
      1,
    );
    gate(
      'Another copy of this product using the same userData exits, retaining one application window.',
    );

    let snapshot = await call('snapshot');
    snapshot = await call('createClass', { epoch: snapshot.epoch, name: '免安装合成验收班' });
    const classId = snapshot.classes[0].id;
    snapshot = await call('saveStudent', {
      epoch: snapshot.epoch,
      classId,
      studentNumber: 'PORTABLE01',
      displayName: '免安装合成学生',
    });
    const student = snapshot.students[0];
    await call('addSyntheticAsset', { epoch: snapshot.epoch });
    const paragraph = (text) => ({ kind: 'paragraph', text, origin: { kind: 'supplement' } });
    const content = {
      formatVersion: 1,
      title: '免安装合成课时',
      objectives: [paragraph('学习观察现象')],
      keyPoints: [paragraph('记录事实')],
      difficulties: [paragraph('区分观察与推测')],
      sections: [
        {
          id: 's1',
          title: '观察与讨论',
          durationMinutes: 40,
          content: [paragraph('观察后记录事实。')],
          questions: [],
          answers: [],
          teacherNotes: '',
        },
      ],
      slides: [
        {
          id: 'slide1',
          sectionId: 's1',
          title: '观察与讨论',
          content: [paragraph('记录事实。')],
          answers: [],
          teacherNotes: '',
        },
      ],
    };
    const draft = await call('createLessonDraft', {
      epoch: snapshot.epoch,
      requestId: randomUUID(),
      content,
      request: {
        topic: content.title,
        subject: '科学',
        grade: '高一',
        durationMinutes: 40,
        instructions: '隔离合成数据验收',
        selection: [],
        acknowledgePartial: false,
      },
    });
    const frozen = await call('freezeLessonDraft', {
      epoch: snapshot.epoch,
      id: draft.id,
      expectedRevision: draft.revision,
      requestId: randomUUID(),
      reason: '免安装验收确认',
    });
    for (const format of ['docx', 'pptx']) {
      const file = path.join(root, `免安装教案课件.${format}`);
      await saveTo(file);
      const result = await call('exportLessonOffice', {
        epoch: snapshot.epoch,
        versionId: frozen.versionId,
        format,
        includeAnswers: false,
        includeTeacherNotes: false,
      });
      assert.ok(result);
      const bytes = await fs.readFile(file);
      assert.equal(hash(bytes), result.sha256);
      const archive = await JSZip.loadAsync(bytes, { checkCRC32: true });
      assert.ok(archive.file(format === 'docx' ? 'word/document.xml' : 'ppt/slides/slide1.xml'));
      report.exports.push({ format, sha256: result.sha256, bytes: bytes.length });
    }
    gate(
      'Real preload/Main/worker calls save SQLite records and an attachment, freeze a local lesson, and generate valid DOCX/PPTX without development tools in PATH.',
    );

    const backup = path.join(root, '免安装合成备份.cmbackup');
    await saveTo(backup);
    assert.ok(await call('saveBackup', { epoch: snapshot.epoch }));
    const savedBackup = JSON.parse(await fs.readFile(backup, 'utf8'));
    assert.equal(savedBackup.format, 'class-manager-backup');
    assert.equal(savedBackup.version, snapshot.schemaVersion);
    assert.ok(savedBackup.assets.length > 0);
    await close();
    await launch(alternateExe);
    snapshot = await call('snapshot');
    assert.ok(
      snapshot.students.some(
        (item) => item.id === student.id && item.studentNumber === 'PORTABLE01',
      ),
    );
    assert.ok(snapshot.assets.length > 0);
    assert.equal(
      (await call('readLessonVersion', { epoch: snapshot.epoch, versionId: frozen.versionId }))
        .payload.content.title,
      content.title,
    );
    gate(
      'After exit and launch from another program directory, student identities, attachments and frozen lessons persist in the same data directory.',
    );

    await call('saveStudent', {
      epoch: snapshot.epoch,
      id: student.id,
      expectedRevision: student.revision,
      classId,
      studentNumber: 'PORTABLE01',
      displayName: '恢复前的临时修改',
    });
    await application.evaluate(({ dialog }, filePath) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [filePath] });
    }, backup);
    const preview = await call('previewRestore', { epoch: snapshot.epoch });
    assert.ok(preview?.token);
    await call('commitRestore', { epoch: snapshot.epoch, token: preview.token });
    snapshot = await call('snapshot');
    assert.equal(
      snapshot.students.find((item) => item.id === student.id).displayName,
      student.displayName,
    );
    assert.equal(snapshot.assets.length, savedBackup.assets.length);
    assert.equal(
      (await call('readLessonVersion', { epoch: snapshot.epoch, versionId: frozen.versionId }))
        .payload.content.title,
      content.title,
    );
    await close();
    await launch();
    snapshot = await call('snapshot');
    assert.equal(
      snapshot.students.find((item) => item.id === student.id).displayName,
      student.displayName,
    );
    gate(
      'Backup/restore replaces a changed student record, restores attachments and lesson versions, and survives restart.',
    );
    await page.screenshot({ path: path.join(output, 'portable-reopened.png'), fullPage: true });
    await close();
    assert.deepEqual(await inventory(directory), before);
    assert.deepEqual(await inventory(alternate), before);
    assert.equal(report.externalRequests, 0);
    assert.deepEqual(report.errors, []);
    gate(
      'Both extracted application directories are unchanged by business work; no renderer errors or model fetch attempts were observed.',
    );
    report.status = 'passed';
    report.completedAt = new Date().toISOString();
    save();
    return report;
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error);
    report.completedAt = new Date().toISOString();
    if (page && !page.isClosed())
      await page.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
    throw error;
  } finally {
    if (application) {
      try {
        await close();
      } catch (error) {
        report.status = 'failed';
        report.shutdownFailure = String(error);
        throw error;
      }
    }
    save();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  assert.ok(
    process.argv[2],
    'Usage: node scripts/portable-smoke.mjs <packaged-executable> [report-directory]',
  );
  const report = await runPortableSmoke(
    process.argv[2],
    process.argv[3] ?? 'output/playwright/portable-manual',
  );
  console.log(JSON.stringify(report, null, 2));
}
