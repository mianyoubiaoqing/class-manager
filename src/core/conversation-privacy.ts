import type { Snapshot } from '../shared/contracts';
import type { GrowthTimeline } from '../shared/growth';
import { DomainError } from './errors';
import { redactSensitiveFacts } from './sensitive-facts';

/** 会话内的工具结果脱敏与对象映射。代号只属于当前会话，不保存到业务库或日志。
 * 已知姓名/学号/ID、联系方式、密钥及路径被遮蔽；自由文本的未知敏感事实无法完整识别。
 * resolve只接受已登记代号，不接受模型给出的原始ID；对象归属和版本由调用方再次核对。 */
export class ConversationPrivacy {
  private readonly aliases = new Map<string, string>();
  private readonly identities = new Map<string, { kind: 'class' | 'student'; id: string }>();
  private readonly substitutions = new Map<string, string>();
  private readonly localNames = new Map<string, string>();
  private recordCount = 0;
  private classCount = 0;
  private studentCount = 0;

  register(snapshot: Snapshot): void {
    for (const classroom of snapshot.classes) {
      const alias = this.identity('class', classroom.id);
      this.substitutions.set(classroom.name, alias);
      this.localNames.set(alias, classroom.name);
    }
    for (const student of snapshot.students) {
      const alias = this.identity('student', student.id);
      this.localNames.set(alias, `${student.displayName}（${student.studentNumber}）`);
      // 重名在自由文本中不能可靠定位，保持同一脱敏代号；操作定位需明确对象代号。
      if (!this.substitutions.has(student.displayName))
        this.substitutions.set(student.displayName, alias);
      if (!this.substitutions.has(student.studentNumber))
        this.substitutions.set(student.studentNumber, alias);
    }
  }

  private identity(kind: 'class' | 'student', id: string): string {
    const existing = this.aliases.get(id);
    if (existing) {
      this.identities.set(existing, { kind, id });
      this.substitutions.set(id, existing);
      return existing;
    }
    const alias = kind === 'class' ? `[班级${++this.classCount}]` : `[学生${++this.studentCount}]`;
    this.aliases.set(id, alias);
    this.identities.set(alias, { kind, id });
    this.substitutions.set(id, alias);
    return alias;
  }

  reference(id: string | null): string | null {
    return id ? (this.aliases.get(id) ?? null) : null;
  }

  recordReference(id: string): string {
    let alias = this.aliases.get(id);
    if (!alias) {
      alias = `[记录${++this.recordCount}]`;
      this.aliases.set(id, alias);
    }
    return alias;
  }

  /** 仅解析本会话实际读取过的对象；不接受原始ID或猜测代号。 */
  resolveReference(reference: string): string {
    for (const [id, alias] of this.aliases) if (alias === reference) return id;
    throw new DomainError('VALIDATION', '工具对象代号不存在，请先查询相应目录。');
  }

  resolve(reference: string, kind: 'class' | 'student'): string {
    const identity = this.identities.get(reference);
    if (!identity || identity.kind !== kind)
      throw new DomainError('VALIDATION', '模型引用的对象代号不存在，请明确选择对象。');
    return identity.id;
  }

  /** 仅用于本地显示和待确认写入内容，还原已知代号为人可辨认的名称；不得再次外发。 */
  localText(text: string): string {
    return text.replace(
      /\[(?:学生|班级|记录)\d+\]/gu,
      (alias) => this.localNames.get(alias) ?? alias,
    );
  }

  text(value: string): string {
    let result = value;
    // 一次替换原始文本，避免新生成的代号再次被短学号匹配而损坏。
    const entries = [...this.substitutions]
      .filter(([raw]) => raw.length > 0)
      .sort(([a], [b]) => b.length - a.length);
    if (entries.length) {
      const escaped = entries.map(([raw]) => raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
      const replacements = new Map(entries);
      result = result.replace(
        new RegExp(`\\[(?:学生|班级|记录)\\d+\\]|${escaped.join('|')}`, 'gu'),
        (raw, offset: number) => {
          if (/^\[(?:学生|班级|记录)\d+\]$/u.test(raw)) return raw;
          if (/^\d{1,4}$/u.test(raw)) {
            const before = value.slice(Math.max(0, offset - 80), offset),
              after = value.slice(offset + raw.length, offset + raw.length + 80);
            if (/\d$/u.test(before) || /^\d/u.test(after)) return raw;
            const labelled = /(?:学号|学生号|编号|学生)\s*[:：#]?\s*$/u.test(before);
            // 日期、带单位的数值保留；明确身份标签优先。裸短数字按身份保守遮蔽。
            if (
              !labelled &&
              (/[\d][./-]$/u.test(before) ||
                /^[./-]\d/u.test(after) ||
                /^\s*(?:分|年|月|日|人|次|个|%|％|秒|分钟|小时)/u.test(after))
            )
              return raw;
          }
          return replacements.get(raw)!;
        },
      );
    }
    return result
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+\S+)\b/giu, '[密钥已隐藏]')
      .replace(/[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,253}\.[A-Z]{2,63}/giu, '[邮箱已隐藏]')
      .replace(/(?<!\d)(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)/gu, '[电话已隐藏]')
      .replace(/(?<!\d)\d{17}[\dXx](?!\d)/gu, '[证件号已隐藏]')
      .replace(/(?:[A-Za-z]:[\\/]|\\\\)[^\s"<>]+/gu, '[本地路径已隐藏]')
      .replace(/\/(?:Users|home|tmp|var)\/[^\s"<>]+/gu, '[本地路径已隐藏]')
      .replace(
        /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/giu,
        '[业务标识已隐藏]',
      );
  }

  /** 成长工具仅外发可供总结的事实摘要和已确认条目；完整谈话、行动、结果及草稿只留本地。 */
  growthResult(timeline: GrowthTimeline): unknown {
    return this.toolResult({
      events: timeline.events.map(({ id, studentId, content }) => ({
        id,
        studentId,
        date: content.date,
        kind: content.kind,
        followUp: content.followUp,
        summaryFact: content.summaryFact,
      })),
      summaries: timeline.summaries.map(({ record, stale }) => ({
        id: record.id,
        status: record.status,
        reviewed: record.reviewed,
        stale,
      })),
      entries: timeline.entries.map(({ record, stale, supersededBy }) => ({
        id: record.id,
        studentId: record.studentId,
        content: record.content,
        stale,
        superseded: supersededBy !== null,
      })),
    });
  }

  /** 已校验模型动作入历史时只清洗字符串值，保留JSON协议的数字、布尔和键名。 */
  modelOutput(value: unknown, field = ''): unknown {
    if (typeof value === 'string')
      return /^(?:kind|query|tool|view|timeZone|followUp)$/u.test(field) ? value : this.text(value);
    if (Array.isArray(value)) return value.map((item) => this.modelOutput(item));
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, this.modelOutput(item, key)]),
      );
    return value;
  }

  /** 所有自动工具结果在回传模型前穿过此接口；返回全新结构，不改本地业务原文。
   * 递归处理结构与文字，移除凭据、路径、联系方式和二进制；保留脱敏的业务事实、草稿与版本。 */
  toolResult(value: unknown): unknown {
    // 先登记历史快照中的身份文字，再清洗正文；学生改名/转班后仍遮蔽旧身份。
    const collect = (item: unknown, depth = 0): void => {
      if (depth > 20 || !item || typeof item !== 'object' || item instanceof Uint8Array) return;
      if (Array.isArray(item)) {
        for (const entry of item) collect(entry, depth + 1);
        return;
      }
      const row = item as Record<string, unknown>;
      const studentId =
        typeof row.studentId === 'string'
          ? row.studentId
          : typeof row.studentNumber === 'string' && typeof row.id === 'string'
            ? row.id
            : undefined;
      const studentAlias = studentId ? this.identity('student', studentId) : '[身份已隐藏]';
      for (const key of ['studentName', 'studentNumber', 'displayName']) {
        if (typeof row[key] === 'string' && row[key])
          this.substitutions.set(row[key], studentAlias);
      }
      if (typeof row.className === 'string' && row.className)
        this.substitutions.set(
          row.className,
          typeof row.classId === 'string'
            ? this.identity('class', row.classId)
            : '[班级身份已隐藏]',
        );
      for (const entry of Object.values(row)) collect(entry, depth + 1);
    };
    collect(value);
    const visit = (item: unknown, field = '', depth = 0): unknown => {
      if (depth > 20) return '[内容层级过深]';
      if (typeof item === 'string') {
        if (/^(?:id|.*Id)$/u.test(field)) {
          return this.recordReference(item);
        }
        if (/^(?:displayName|studentName|studentNumber)$/u.test(field))
          return this.substitutions.get(item) ?? '[身份已隐藏]';
        if (/^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(item)) return this.recordReference(item);
        return redactSensitiveFacts(this.text(item));
      }
      if (Array.isArray(item)) return item.map((entry) => visit(entry, '', depth + 1));
      if (item && typeof item === 'object') {
        const result: Record<string, unknown> = {};
        const record = item as Record<string, unknown>;
        const rowId = typeof record.studentId === 'string' ? record.studentId : record.id;
        const rowAlias = typeof rowId === 'string' ? this.aliases.get(rowId) : undefined;
        for (const [key, entry] of Object.entries(item)) {
          if (
            /(?:^key$|apiKey|maskedKey|accessKey|secretKey|privateKey)|secret|(?:^token$|accessToken|refreshToken|authToken|fileToken)|password|authorization|credential|path|private|rawBytes|image|base64|dataUrl|bytes|epoch|checksum|hash|phone|mobile|email|address|guardian|parent|contact|idNumber|teacherName|birthDate/iu.test(
              key,
            )
          )
            continue;
          const safeKey = /^[0-9a-f]{8}-[0-9a-f-]{27}$/iu.test(key)
            ? this.recordReference(key)
            : (this.aliases.get(key) ?? this.text(key));
          result[safeKey] =
            rowAlias && /^(?:displayName|studentName|studentNumber)$/u.test(key)
              ? rowAlias
              : visit(entry, key, depth + 1);
        }
        return result;
      }
      return item;
    };
    return visit(value);
  }
}
