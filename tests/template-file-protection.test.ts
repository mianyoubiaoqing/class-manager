import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicCreate } from '../src/core/files';

describe('teacher template file protection', () => {
  it('publishes a new complete template and removes its temporary file', () => {
    const root = mkdtempSync(join(tmpdir(), 'template-protection-'));
    try {
      const target = join(root, '新模板.csv');
      atomicCreate(target, '学生编号,姓名\r\n');
      expect(readFileSync(target, 'utf8')).toBe('学生编号,姓名\r\n');
      expect(readdirSync(root)).toEqual(['新模板.csv']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it('never replaces an existing roster when downloading a blank template', () => {
    const root = mkdtempSync(join(tmpdir(), 'template-protection-'));
    try {
      const target = join(root, '已有名单.csv');
      const original = '学生编号,姓名\r\n001,合成学生\r\n';
      writeFileSync(target, original);
      expect(() => atomicCreate(target, '学生编号,姓名\r\n')).toThrow('空白模板不能覆盖已有文件');
      expect(readFileSync(target, 'utf8')).toBe(original);
      expect(readdirSync(root)).toEqual(['已有名单.csv']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
