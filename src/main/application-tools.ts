import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import * as contracts from '../shared/contracts';
import * as scores from '../shared/score-commands';
import * as explanations from '../shared/explanation-drafts';
import * as seating from '../shared/seating-records';
import * as duty from '../shared/duty-records';
import * as materials from '../shared/material-records';
import * as lessons from '../shared/lesson-records';
import * as classroom from '../shared/classroom';
import * as grading from '../shared/grading-records';
import * as growth from '../shared/growth';
import * as publication from '../shared/score-publication';
import * as devices from '../shared/devices';
import * as providers from '../shared/model-providers';
import * as office from '../shared/office-export';
import * as pupils from '../shared/pupils';
import { attendanceRosterHash } from '../core/pupil-book';
import {
  applicationReadTools,
  applicationDraftTools,
  applicationToolNames,
  type ApplicationToolName,
} from '../shared/application-tools';
import type { ConversationAction } from '../shared/conversation';
import { DomainError } from '../core/errors';
import type { ConversationPrivacy } from '../core/conversation-privacy';

const empty = z.object({}).strict();
/** 精确复用应用业务 schema；没有 Worker 内部认领/完成、任意 IPC 或数据库工具。 */
const schemas: Record<ApplicationToolName, z.ZodObject> = {
  snapshot: empty,
  readStudentProfile: pupils.profileReadInput,
  saveStudentProfile: pupils.profileSaveInput,
  studentProfileHistory: pupils.profileReadInput,
  readAttendanceRoster: pupils.attendanceClassInput,
  listAttendance: pupils.attendanceClassInput,
  readAttendance: pupils.attendanceReadInput,
  attendanceHistory: pupils.attendanceReadInput,
  saveAttendance: pupils.attendanceSaveInput,
  listExams: scores.scoreListInput,
  readScoreVersion: scores.scoreReadInput,
  scoreHistory: scores.scoreHistoryInput,
  studentScoreHistory: scores.studentScoreHistoryInput,
  listExplanations: explanations.explanationListInput,
  readExplanation: explanations.explanationReadInput,
  seatingHistory: seating.seatingHistoryInput,
  readSeatingDraft: seating.seatingTokenInput,
  readSeatingVersion: seating.seatingReadInput,
  listDutyPlans: duty.dutyListInput,
  readDutyDraft: duty.dutyTokenInput,
  dutyHistory: duty.dutyHistoryInput,
  readDutyVersion: duty.dutyReadInput,
  listMaterials: materials.materialListInput,
  readMaterial: materials.materialReadInput,
  listLessonDrafts: lessons.lessonListInput,
  readLessonDraft: lessons.lessonDraftReadInput,
  readLessonVersion: lessons.lessonVersionReadInput,
  lessonHistory: lessons.lessonDraftReadInput,
  listClassrooms: classroom.classroomListInput,
  readClassroom: classroom.classroomReadInput,
  readClassroomClock: classroom.classroomReadInput,
  readCountdown: contracts.epochInput,
  listRubrics: grading.rubricListInput,
  readRubric: grading.rubricReadInput,
  listGradings: grading.gradingListInput,
  readGrading: grading.gradingReadInput,
  readGradingReview: grading.gradingReadInput,
  gradingAttempts: grading.gradingReadInput,
  gradingHistory: grading.gradingHistoryInput,
  readScorePublication: publication.scorePublicationReadInput,
  growthTimeline: growth.growthStudentInput,
  growthEventHistory: growth.growthReadInput,
  growthSummaryHistory: growth.growthStudentInput,
  readGrowthSummary: growth.growthReadInput,
  readDeviceStatus: devices.deviceStatusInput,
  readStudentCall: devices.studentCallReadInput,
  readModelSettings: empty,
  readModelLedger: providers.modelProviderInput,
  createClass: contracts.createClassInput,
  renameClass: contracts.renameClassInput,
  saveStudent: contracts.studentInput,
  setStudentActive: contracts.activationInput,
  saveGrowthEvent: growth.growthEventSaveInput,
  createGrowthSummary: growth.growthManualInput,
  editGrowthSummary: growth.growthSummaryEditInput,
  discardGrowthSummary: growth.growthSummaryDiscardInput,
  confirmGrowthSummary: growth.growthConfirmInput,
  createRubric: grading.rubricCreateInput,
  createGrading: grading.gradingCreateInput,
  editGrading: grading.gradingEditInput,
  rebindGrading: grading.gradingRebindInput,
  freezeGrading: grading.gradingFreezeInput,
  prepareScorePublication: publication.scorePublicationReadInput,
  confirmScorePublication: publication.scorePublicationConfirmInput,
  createClassroom: classroom.classroomCreateInput,
  controlClassroom: classroom.classroomControlInput,
  setCountdown: classroom.countdownInput,
  openClassroomDisplay: classroom.classroomReadInput,
  closeClassroomDisplay: contracts.epochInput,
  editLessonDraft: lessons.lessonEditInput,
  createLessonDraft: lessons.lessonCreateInput,
  discardLessonDraft: lessons.lessonDiscardInput,
  freezeLessonDraft: lessons.lessonFreezeInput,
  reviseLessonVersion: lessons.lessonReviseInput,
  prepareDuty: duty.dutyPrepareInput,
  adjustDuty: duty.dutyAdjustInput,
  cancelDuty: duty.dutyTokenInput,
  confirmDuty: duty.dutyConfirmInput,
  prepareSeating: seating.seatingPrepareInput,
  adjustSeating: seating.seatingAdjustInput,
  cancelSeating: seating.seatingTokenInput,
  confirmSeating: seating.seatingConfirmInput,
  editExplanation: explanations.explanationEditInput,
  discardExplanation: explanations.explanationDiscardInput,
  previewSeatingPrint: seating.seatingReadInput,
  previewDutyPrint: duty.dutyReadInput,
  exportLessonOffice: office.officeExportInput,
  saveMaterialOriginal: materials.materialReadInput,
  saveBackup: contracts.epochInput,
  previewRestore: empty,
  commitRestore: contracts.restoreInput,
  exportDiagnostics: empty,
  measureNoise: devices.noiseMeasureInput,
  requestStudentCall: devices.studentCallInput,
  cancelDeviceTask: devices.deviceCancelInput,
};
const controlled = new Set([
  'epoch',
  'requestId',
  'operationId',
  'expectedRevision',
  'expectedStudentRevision',
  'expectedVersionId',
  'expectedRosterHash',
  'token',
]);
const readonly = new Set<string>(applicationReadTools);
export type ApplicationInvocation = {
  tool: ApplicationToolName;
  input: Record<string, unknown>;
  before: unknown;
};

/** 每会话持有已读取对象、版本及准备令牌。模型仅传代号，不能提供原始身份或版本。 */
export class ApplicationTools {
  private readonly records = new Map<string, Record<string, unknown>>();
  private countdown: Record<string, unknown> | null = null;
  constructor(private readonly privacy: ConversationPrivacy) {}

  isRead(tool: ApplicationToolName) {
    return readonly.has(tool);
  }

  isAutomatic(tool: ApplicationToolName) {
    return this.isRead(tool) || (applicationDraftTools as readonly string[]).includes(tool);
  }

  preview(value: unknown): unknown {
    if (typeof value === 'string') {
      const ref = this.privacy.reference(value);
      if (ref) {
        const local = this.privacy.localText(ref);
        if (!/^\[记录\d+\]$/u.test(local)) return local;
      }
      const record = this.records.get(value);
      const label = [record?.title, record?.name, record?.topic, record?.prompt].find(
        (item): item is string => typeof item === 'string' && !!item.trim(),
      );
      if (label) return this.privacy.localText(label);
      return ref ? this.privacy.localText(ref) : value;
    }
    if (Array.isArray(value)) return value.map((item) => this.preview(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value)
          .filter(([key]) => !controlled.has(key) && !/hash|checksum/iu.test(key))
          .map(([key, item]) => [key, this.preview(item)]),
      );
    return value;
  }

  catalog(selected?: ApplicationToolName) {
    return applicationToolNames
      .filter((tool) => !selected || tool === selected)
      .map((tool) => {
        const schema = schemas[tool];
        const publicShape = Object.fromEntries(
          Object.entries(schema.shape).filter(([key]) => !controlled.has(key)),
        );
        if (tool === 'saveStudent') {
          for (const key of ['classId', 'studentNumber', 'displayName'])
            publicShape[key] = publicShape[key]!.optional();
        }
        if (tool === 'saveStudentProfile') {
          publicShape.content = pupils.profileContent
            .omit({ birthDate: true, guardianName: true, guardianPhone: true, address: true })
            .partial();
        }
        if ('token' in schema.shape) publicShape.operationRef = z.string();
        if (tool === 'readStudentCall' || tool === 'cancelDeviceTask')
          publicShape.operationRef = z.string();
        // JSON schema供模型发现参数，uuid改为会话代号；实际解析仍用原schema。
        const parameters = z.toJSONSchema(z.object(publicShape).strict(), {
          unrepresentable: 'any',
        });
        const rewrite = (value: unknown): unknown => {
          if (Array.isArray(value)) return value.map(rewrite);
          if (value && typeof value === 'object') {
            const object = value as Record<string, unknown>;
            if (object.format === 'uuid')
              return {
                type: 'string',
                description: '只用工具返回的会话代号；新建嵌套对象可用 $new',
              };
            return Object.fromEntries(
              Object.entries(object).map(([key, item]) => [key, rewrite(item)]),
            );
          }
          return value;
        };
        return {
          tool,
          mode: this.isRead(tool) ? 'read' : this.isAutomatic(tool) ? 'draft' : 'confirm',
          parameters: rewrite(parameters),
        };
      });
  }

  capabilities(selected?: ApplicationToolName) {
    if (selected) return this.catalog(selected);
    return {
      features: [
        '对话附件：上传表格或文档，读取文字后分析和准备业务操作；上传本身不写入名册或成绩，正式变更仍确认',
        '名册：班级、学生、在籍和归属历史',
        '点名：逐人到课、迟到、请假、缺席、未点名，按次保存和历史更正；未点名不能推断为缺席',
        '学生资料：基础资料、兴趣、优势、学习支持、教师备注和修订历史；生日、家庭联系人与地址仅在本机表单维护，不外发模型',
        '成绩：考试、分数、统计、历史、解释、正式入分',
        '座位：布局、随机编排、锁定、调整、确认、历史、打印',
        '值日：岗位、分组、轮换、替换、缺勤、完成、确认、打印',
        '备课：新建课时、资料文本、教案与课件草稿、冻结版本、历史、Word和PowerPoint导出',
        '课堂：固定教案版本、环节、计时、问题答案显示、投屏、倒计时',
        '阅卷：评分规则、题目、答卷建议、人工复核、冻结和成绩发布',
        '成长：全部脱敏事件与谈话、行动结果、总结草稿、审核和正式档案',
        '外设：连接状态、噪声测量、点名请求与回执',
        '维护：备份、恢复、诊断',
        '模型：DeepSeek、Kimi、豆包配置、能力、费用和调用账本',
      ],
      tools: applicationToolNames.map((tool) => ({
        tool,
        mode: this.isRead(tool) ? 'read' : this.isAutomatic(tool) ? 'draft' : 'confirm',
      })),
      parameters: 'query capabilities 并填写 tool，读取该工具参数结构。UUID参数仅填会话代号。',
      workflows: [
        {
          view: 'scores',
          operations: [
            '选择导入文件',
            '映射列和计分组',
            '预览并确认成绩',
            '选择实际AI外发范围生成解释',
          ],
        },
        {
          view: 'lessons',
          operations: ['选择资料和查看图像/原文件', '导入确认', '选择资料片段并确认AI备课外发'],
        },
        { view: 'grading', operations: ['查看答卷图像', '裁剪遮盖选页并确认AI外发'] },
        { view: 'growth', operations: ['选择事实范围并确认AI总结外发'] },
        {
          view: 'providerSettings',
          operations: ['设置或删除密钥', '切换供应商/型号', '确认模型连接检查外发'],
        },
      ],
      boundary:
        '所有文字业务详情可脱敏读取，对话附件文字在用户发送时提供。正式写入、导出、打印、恢复和设备动作在对话内确认执行；选择备份或导出位置时弹出本机文件对话框。图像识别、资料原文件入库、密钥与额外AI生成外发使用专用页面。不得声称仅导航或上传就已完成操作。',
    };
  }

  remember(tool: ApplicationToolName, value: unknown): unknown {
    if (tool === 'readCountdown') this.countdown = value as Record<string, unknown> | null;
    const visit = (item: unknown, depth = 0) => {
      if (depth > 20 || !item || typeof item !== 'object' || item instanceof Uint8Array) return;
      if (Array.isArray(item)) {
        for (const entry of item) visit(entry, depth + 1);
        return;
      }
      const record = item as Record<string, unknown>;
      if (typeof record.id === 'string') this.records.set(record.id, structuredClone(record));
      if (typeof record.token === 'string') this.records.set(record.token, structuredClone(record));
      if (typeof record.operationId === 'string')
        this.records.set(record.operationId, structuredClone(record));
      for (const entry of Object.values(record)) visit(entry, depth + 1);
    };
    visit(value);
    if (tool === 'readStudentProfile' && value && typeof value === 'object') {
      const profile = value as Record<string, unknown>;
      this.records.set(`profile:${String(profile.studentId)}`, structuredClone(profile));
    }
    if (tool === 'readAttendanceRoster' && value && typeof value === 'object') {
      const roster = value as Record<string, unknown>;
      this.records.set(`attendance-roster:${String(roster.classId)}`, structuredClone(roster));
    }
    if (tool === 'seatingHistory' && Array.isArray(value)) {
      for (const entry of value as Array<Record<string, unknown>>) {
        const key = `seating:${String(entry.classId)}`;
        if (
          typeof entry.revision === 'number' &&
          entry.revision > Number(this.records.get(key)?.revision ?? 0)
        )
          this.records.set(key, structuredClone(entry));
      }
    }
    if (tool === 'listDutyPlans' && Array.isArray(value)) {
      for (const entry of value as Array<Record<string, unknown>>)
        if (typeof entry.planId === 'string')
          this.records.set(entry.planId, structuredClone(entry));
    }
    // 包含payload的详情覆盖单独record，使用户在写入确认时看到完整旧内容。
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const object = value as Record<string, unknown>;
      const record = object.record as Record<string, unknown> | undefined;
      if (typeof record?.id === 'string')
        this.records.set(record.id, { ...structuredClone(object), ...structuredClone(record) });
      const token = typeof object.token === 'string' ? object.token : object.operationId;
      if (typeof token === 'string') {
        return { ...object, operationRef: this.privacy.recordReference(token) };
      }
    }
    return value;
  }

  prepare(
    action: Extract<ConversationAction, { kind: 'tool' }>,
    snapshot: contracts.Snapshot,
  ): ApplicationInvocation {
    const schema = schemas[action.tool];
    if (Buffer.byteLength(JSON.stringify(action.args)) > 128 * 1024)
      throw new DomainError('VALIDATION', '工具参数过大，请缩小本次操作范围。');
    for (const key of Object.keys(action.args)) {
      if (controlled.has(key))
        throw new DomainError('VALIDATION', '工具的版本、身份和执行令牌由本地管理。');
      if (!(key in schema.shape) && key !== 'operationRef')
        throw new DomainError('VALIDATION', `工具不支持参数：${key}`);
    }
    const newIds = new Map<string, string>();
    const resolve = (item: unknown, depth = 0, field = ''): unknown => {
      if (depth > 20) throw new DomainError('VALIDATION', '工具参数层级过深。');
      if (typeof item === 'string') {
        const identityField = /(?:^id$|Ids?$|^operationRef$)/u.test(field);
        if (identityField && /^\[(?:学生|班级|记录)\d+\]$/u.test(item))
          return this.privacy.resolveReference(item);
        if (identityField && item === '$new' && !this.isRead(action.tool)) return randomUUID();
        if (
          identityField &&
          /^\$new:[a-zA-Z0-9_-]{1,40}$/u.test(item) &&
          !this.isRead(action.tool)
        ) {
          if (!newIds.has(item)) newIds.set(item, randomUUID());
          return newIds.get(item);
        }
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(item))
          throw new DomainError('VALIDATION', '只能使用当前会话工具返回的对象代号。');
        return this.privacy.localText(item);
      }
      if (Array.isArray(item)) return item.map((value) => resolve(value, depth + 1, field));
      if (item && typeof item === 'object')
        return Object.fromEntries(
          Object.entries(item).map(([key, value]) => [
            /^\[(?:学生|班级|记录)\d+\]$/u.test(key) ? this.privacy.resolveReference(key) : key,
            resolve(value, depth + 1, key),
          ]),
        );
      return item;
    };
    const input = resolve(action.args) as Record<string, unknown>;
    if (action.tool === 'saveStudentProfile') {
      const previous = this.records.get(`profile:${String(input.studentId)}`);
      if (!previous?.content)
        throw new DomainError('VALIDATION', '请先读取学生资料，核对当前内容。');
      const patch = pupils.profileContent
        .omit({ birthDate: true, guardianName: true, guardianPhone: true, address: true })
        .partial()
        .parse(input.content);
      input.content = { ...(previous.content as Record<string, unknown>), ...patch };
      input.expectedRevision = previous.revision;
    }
    if (action.tool === 'saveAttendance') {
      if (typeof input.id === 'string') {
        const previous = this.records.get(input.id);
        if (!previous?.rows)
          throw new DomainError('VALIDATION', '请先读取完整点名记录，核对原名册。');
        input.expectedRosterHash = previous.rosterHash;
      } else {
        const roster = this.records.get(`attendance-roster:${String(input.classId)}`);
        if (!roster || roster.rosterHash !== attendanceRosterHash(snapshot, String(input.classId)))
          throw new DomainError('VALIDATION', '请先读取当前点名名册。');
        input.expectedRosterHash = roster.rosterHash;
        input.expectedRevision = 0;
      }
    }
    if (action.tool === 'saveStudent' && typeof input.id === 'string') {
      const student = snapshot.students.find((entry) => entry.id === input.id);
      if (!student) throw new DomainError('VALIDATION', '学生对象已失效。');
      for (const key of ['classId', 'studentNumber', 'displayName'] as const) {
        if (input[key] === undefined || action.args[key] === this.privacy.reference(student.id))
          input[key] = student[key];
      }
    }
    if ('epoch' in schema.shape) input.epoch = snapshot.epoch;
    if ('requestId' in schema.shape) input.requestId = randomUUID();
    const operationRef = input.operationRef;
    delete input.operationRef;
    const prepared = typeof operationRef === 'string' ? this.records.get(operationRef) : undefined;
    if ('token' in schema.shape) {
      if (!prepared || prepared.token !== operationRef)
        throw new DomainError('VALIDATION', '请先完成此操作的准备，并引用返回的 operationRef。');
      input.token = operationRef;
    }
    if ('operationId' in schema.shape) {
      if (action.tool === 'readStudentCall' || action.tool === 'cancelDeviceTask') {
        if (!prepared || prepared.operationId !== operationRef)
          throw new DomainError('VALIDATION', '设备任务代号不存在。');
        input.operationId = operationRef;
      } else input.operationId = randomUUID();
    }
    const id = typeof input.id === 'string' ? input.id : undefined;
    const existing = id ? this.records.get(id) : undefined;
    if (
      [
        'editLessonDraft',
        'discardLessonDraft',
        'freezeLessonDraft',
        'editExplanation',
        'discardExplanation',
        'editGrading',
        'rebindGrading',
        'freezeGrading',
      ].includes(action.tool) &&
      !existing?.payload
    )
      throw new DomainError('VALIDATION', '请先读取完整草稿详情，目录条目不足以审核或修改内容。');
    if (
      ['editGrowthSummary', 'discardGrowthSummary', 'confirmGrowthSummary'].includes(action.tool) &&
      typeof existing?.content !== 'string'
    )
      throw new DomainError('VALIDATION', '请先读取完整成长总结，核对事实和草稿内容。');
    if (action.tool === 'confirmGrowthSummary' && existing?.reviewed !== true)
      throw new DomainError(
        'VALIDATION',
        '总结尚未保存人工复核稿。请先通过 editGrowthSummary 提议保存已核对内容，确认后重新读取，再确认总结。',
      );
    // 可编辑对象须先读取；使用读取时版本，而不是临执行前悄悄升级到新版本。
    let before: unknown = existing ?? prepared ?? null;
    if ('expectedRevision' in schema.shape) {
      let revision: unknown;
      if (id) {
        const rosterRecord =
          snapshot.classes.find((item) => item.id === id) ??
          snapshot.students.find((item) => item.id === id);
        revision = existing?.revision ?? rosterRecord?.revision;
        before = existing ?? rosterRecord ?? before;
        if (revision === undefined)
          throw new DomainError('VALIDATION', '请先读取要修改对象的当前详情。');
      } else if (action.tool === 'saveStudentProfile') {
        revision = input.expectedRevision;
        before = this.records.get(`profile:${String(input.studentId)}`);
      } else if (action.tool === 'saveAttendance') {
        revision = input.expectedRevision;
      } else if (action.tool === 'setCountdown') {
        revision = this.countdown?.revision ?? 0;
        before = this.countdown;
      } else if (prepared) revision = prepared.expectedRevision;
      else if (action.tool === 'prepareSeating') {
        const latest = this.records.get(`seating:${String(input.classId)}`);
        if ((input.source as { kind?: string })?.kind === 'latest' && !latest)
          throw new DomainError('VALIDATION', '请先查询 seatingHistory 以核对当前座位版本。');
        revision = latest?.revision ?? 0;
        before = latest ?? null;
      } else if (action.tool === 'prepareDuty') {
        const source = input.source as { kind?: string; planId?: string };
        const latest = source.planId ? this.records.get(source.planId) : undefined;
        if (source.kind === 'latest' && !latest)
          throw new DomainError('VALIDATION', '请先查询 listDutyPlans 以核对当前值日版本。');
        revision = latest?.revision ?? 0;
        before = latest ?? null;
      }
      if (revision !== undefined) input.expectedRevision = revision;
    }
    if ('expectedVersionId' in schema.shape) input.expectedVersionId = prepared?.expectedVersionId;
    if ('expectedStudentRevision' in schema.shape) {
      const student = snapshot.students.find((value) => value.id === input.studentId);
      if (!student) throw new DomainError('VALIDATION', '学生对象已失效。');
      input.expectedStudentRevision = student.revision;
      before = student;
    }
    return { tool: action.tool, input: schema.parse(input) as Record<string, unknown>, before };
  }
}

/** 结构化分页：先脱敏，再选路径/分页；返回可续读位置，绝不把截断数据说成完整数据。 */
export function applicationResultPage(
  value: unknown,
  selection?: Extract<ConversationAction, { kind: 'tool' }>['result'],
): unknown {
  let current = value;
  const path = selection?.path ?? [];
  for (const key of path) {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, key))
      throw new DomainError('VALIDATION', '结果路径不存在，请按已返回的结构查询。');
    current = (current as Record<string, unknown>)[key];
  }
  const offset = selection?.offset ?? 0;
  const limit = selection?.limit ?? 30;
  if (Array.isArray(current))
    return {
      path,
      items: current.slice(offset, offset + limit),
      total: current.length,
      offset,
      nextOffset: offset + limit < current.length ? offset + limit : null,
    };
  const content = JSON.stringify(current);
  if (Buffer.byteLength(content ?? '') > 32 * 1024) {
    if (typeof current === 'string')
      return {
        path,
        text: current.slice(offset, offset + 16000),
        totalCharacters: current.length,
        offset,
        nextOffset: offset + 16000 < current.length ? offset + 16000 : null,
      };
    if (current && typeof current === 'object')
      return {
        ...Object.fromEntries(
          Object.entries(current).filter(
            ([, item]) =>
              item === null ||
              typeof item === 'number' ||
              typeof item === 'boolean' ||
              (typeof item === 'string' && Buffer.byteLength(item) <= 1000),
          ),
        ),
        path,
        fields: Object.entries(current).map(([key, item]) => ({
          key,
          type: Array.isArray(item) ? 'array' : typeof item,
          count: Array.isArray(item) ? item.length : undefined,
        })),
        message: '详情较大，请通过 result.path 选择字段继续读取。',
      };
  }
  return current;
}
