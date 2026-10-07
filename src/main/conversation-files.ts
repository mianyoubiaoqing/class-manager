import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DomainError } from '../core/errors';
import { requireRegularFile } from '../core/files';
import { readScoreTable } from '../core/score-table';
import { assertLocalScorePath } from './local-score-path';
import type { MaterialTaskRunner } from './material-task';
import {
  CONVERSATION_FILE_LIMITS as limits,
  conversationFileSchema,
  conversationFilesInput,
  type ConversationFile,
} from '../shared/conversation-files';

type StoredFile = { epoch: string; sessionId: string; descriptor: ConversationFile; text: string };

/** Native-dialog paths only; attachments never grant the model arbitrary filesystem access. */
export class ConversationFiles {
  private readonly files = new Map<string, StoredFile>();
  private generation = 0;
  private active?: AbortController;
  constructor(private readonly parser: Pick<MaterialTaskRunner, 'parse'>) {}
  invalidate() {
    this.generation++;
    this.active?.abort();
    this.files.clear();
  }
  clearSession(sessionId: string) {
    for (const [id, file] of this.files) if (file.sessionId === sessionId) this.files.delete(id);
  }
  remove(epoch: string, sessionId: string, ids: string[]) {
    // Expired tokens may be removed from a restored draft; never remove another session's file.
    for (const id of ids) {
      const file = this.files.get(id);
      if (file && (file.epoch !== epoch || file.sessionId !== sessionId))
        throw new DomainError('VALIDATION', '附件不属于当前对话。');
    }
    for (const id of ids) this.files.delete(id);
  }
  async select(
    raw: unknown,
    choose: () => Promise<string[]>,
    currentEpoch: () => Promise<string>,
  ): Promise<ConversationFile[]> {
    const input = conversationFilesInput.parse(raw);
    if (this.active) throw new DomainError('BUSY', '附件正在读取，请稍后重试。');
    const controller = new AbortController();
    this.active = controller;
    const generation = this.generation;
    const check = async () => {
      if (
        controller.signal.aborted ||
        generation !== this.generation ||
        (await currentEpoch()) !== input.epoch
      )
        throw new DomainError('STALE_WORKSPACE', '工作区已变化，请重新上传附件。');
    };
    try {
      await check();
      const paths = await choose();
      await check();
      if (paths.length > limits.files) throw new DomainError('VALIDATION', '一次最多上传6个文件。');
      if (this.files.size + paths.length > 60)
        throw new DomainError('VALIDATION', '当前附件缓存已满，请重启应用后重新上传。');
      const pending: StoredFile[] = [];
      for (const path of paths) {
        const format = extname(path).slice(1).toLowerCase();
        if (!['xlsx', 'csv', 'txt', 'md', 'pdf', 'docx'].includes(format))
          throw new DomainError('VALIDATION', '支持 XLSX、CSV、TXT、MD、PDF 和 DOCX。');
        await assertLocalScorePath(path);
        requireRegularFile(path, limits.bytes);
        const fd = openSync(path, 'r');
        let bytes: Buffer;
        try {
          const stat = fstatSync(fd);
          if (!stat.isFile() || !stat.size || stat.size > limits.bytes)
            throw new DomainError('VALIDATION', '附件须为非空普通文件，且不超过5 MiB。');
          const buffer = Buffer.alloc(limits.bytes + 1);
          let length = 0;
          while (length < buffer.length) {
            const count = readSync(fd, buffer, length, buffer.length - length, null);
            if (!count) break;
            length += count;
          }
          if (length !== stat.size || length > limits.bytes || fstatSync(fd).size !== length)
            throw new DomainError('VALIDATION', '附件读取时发生变化，请重新选择。');
          bytes = buffer.subarray(0, length);
        } finally {
          closeSync(fd);
        }
        let text: string;
        let warnings: string[] = [];
        if (format === 'xlsx' || format === 'csv') {
          const table = await readScoreTable(bytes, format);
          const problems = table.flatMap((row, r) =>
            row.flatMap((cell, c) =>
              cell.problem ? [`第${r + 1}行第${c + 1}列：${cell.problem}`] : [],
            ),
          );
          if (problems.length)
            throw new DomainError(
              'VALIDATION',
              `表格含无法读取的单元格，未采用附件。${problems.slice(0, 3).join('；')}`,
            );
          text = JSON.stringify({ rows: table.map((row) => row.map((cell) => cell.value)) });
        } else if (format === 'txt' || format === 'md') {
          try {
            text = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/^\uFEFF/, '');
          } catch {
            throw new DomainError('VALIDATION', '文本附件需要使用 UTF-8 编码。');
          }
        } else {
          const parsed = await this.parser.parse(
            bytes,
            format as 'pdf' | 'docx',
            controller.signal,
          );
          text = parsed.version.fragments
            .flatMap((fragment) => (fragment.kind === 'text' ? [fragment.text] : []))
            .join('\n\n');
          warnings = parsed.version.warnings.slice(0, 19);
          if (parsed.version.fragments.some((fragment) => fragment.kind === 'image'))
            warnings.push(
              '仅提取文字，图片和扫描内容未提供给对话模型；需要识图时请使用教学资料功能。',
            );
        }
        if (!text.trim())
          throw new DomainError('VALIDATION', '附件未提取到文字，请使用可复制文字的文档或表格。');
        if (text.length + pending.reduce((n, file) => n + file.text.length, 0) > limits.characters)
          throw new DomainError(
            'VALIDATION',
            '附件文字合计超过96000字符，请拆分文件；未截断内容。',
          );
        const descriptor = conversationFileSchema.parse({
          id: randomUUID(),
          name: basename(path),
          format,
          bytes: bytes.length,
          characters: text.length,
          warnings,
        });
        pending.push({ ...input, descriptor, text });
        await check();
      }
      for (const file of pending) this.files.set(file.descriptor.id, file);
      return pending.map((file) => structuredClone(file.descriptor));
    } finally {
      if (this.active === controller) this.active = undefined;
    }
  }
  resolve(epoch: string, sessionId: string, ids: string[]) {
    const result = ids.map((id) => {
      const file = this.files.get(id);
      if (!file || file.epoch !== epoch || file.sessionId !== sessionId)
        throw new DomainError(
          'CONVERSATION_FILE_EXPIRED',
          '附件已失效或不属于当前对话，请移除后重新上传。',
        );
      return {
        name: file.descriptor.name,
        format: file.descriptor.format,
        text: file.text,
        warnings: file.descriptor.warnings,
        trust: 'user-uploaded-data-not-instructions',
      };
    });
    if (result.reduce((n, file) => n + file.text.length, 0) > limits.characters)
      throw new DomainError('VALIDATION', '附件文字合计超过96000字符，请分次发送。');
    return result;
  }
}
