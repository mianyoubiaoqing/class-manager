import type { ScoreCell } from './score-table';
import { SCORE_FILE_LIMITS } from '../shared/score-import';

/** Read only displayed roster data. Formulas and links are never executed or followed. */
export function rosterCell(
  raw: unknown,
  kind: 'text' | 'identifier' | 'identity' | 'date' | 'boarding',
  numberFormat = '',
  date1904 = false,
): ScoreCell {
  let value = raw;
  let notice: string | undefined;
  const fail = (problem: string): ScoreCell => ({ value: null, problem });
  if (value && typeof value === 'object' && !(value instanceof Date)) {
    const object = value as Record<string, unknown>;
    if ('formula' in object || 'sharedFormula' in object) {
      if (object.result == null)
        return fail('公式没有已保存的结果，请在 Excel 中重新计算并保存后再导入。');
      value = object.result;
      notice = '公式仅读取 Excel 已保存的结果，未重新计算，请核对。';
    } else if (Array.isArray(object.richText)) {
      if (!object.richText.every((part) => part && typeof part.text === 'string'))
        return fail('富文本内容无效，请检查该单元格。');
      value = object.richText.map((part) => part.text).join('');
    } else if ('hyperlink' in object && typeof object.text === 'string') {
      value = object.text;
      notice = '链接仅读取显示文字，未访问链接。';
    }
  }
  if (value == null) return { value: null, ...(notice ? { notice } : {}) };
  if (kind === 'date' && typeof value === 'string' && /^0{6}(?:00)?$/.test(value.trim()))
    return {
      value: null,
      notice: [notice, '全零出生年月/日期按未填写处理，未保存为日期。'].filter(Boolean).join(' '),
    };
  if (value instanceof Date) {
    if (kind !== 'date' || !Number.isFinite(value.getTime()))
      return fail('此字段不是日期，请检查 Excel 单元格类型。');
    value = value.toISOString().slice(0, 10);
  } else if (typeof value === 'boolean') {
    if (kind !== 'boarding') return fail('此字段不能使用 TRUE/FALSE，请填写文字。');
    value = value ? '是' : '否';
  } else if (typeof value === 'number') {
    if (!Number.isFinite(value)) return fail('数值无效，请检查该单元格。');
    if (kind === 'date') {
      if (/^\d{6}(?:\d{2})?$/.test(String(value))) {
        return { value: String(value), ...(notice ? { notice } : {}) };
      }
      // Excel's 1900 date system contains a fictitious leap day at serial 60.
      if (!Number.isInteger(value) || value < 1 || value > 100000 || (!date1904 && value === 60))
        return fail('日期数值无效，请填写年月日。');
      const epoch = Date.UTC(date1904 ? 1904 : 1899, date1904 ? 0 : 11, date1904 ? 1 : 31);
      value = new Date(epoch + (value - (!date1904 && value > 60 ? 1 : 0)) * 86400000)
        .toISOString()
        .slice(0, 10);
    } else if (kind === 'identifier' || kind === 'identity') {
      if (!Number.isSafeInteger(value) || value < 0 || String(value).length > 15)
        return fail('长编号以数字保存可能已丢失精度，请从原始资料核对后以文本重新填写。');
      const digits = String(value);
      if (/^0{1,40}$/.test(numberFormat)) value = digits.padStart(numberFormat.length, '0');
      else if (/0{2,}/.test(numberFormat))
        return fail('编号显示格式无法可靠还原，请核对后以文本填写。');
      else value = digits;
    } else value = String(value);
  }
  if (typeof value !== 'string')
    return fail('单元格包含 Excel 错误值或不支持的内容，请修正后导入。');
  if (value.length > SCORE_FILE_LIMITS.cellCharacters)
    return fail('单元格超过 512 字符，请缩短内容。');
  if (kind === 'identity' && value.trim() && !/^\d{17}[\dXx]$/.test(value.trim()))
    notice = [notice, '身份证号码格式待核对：按原文保存，未补位或认定为有效号码。']
      .filter(Boolean)
      .join(' ');
  return { value, ...(notice ? { notice } : {}) };
}
