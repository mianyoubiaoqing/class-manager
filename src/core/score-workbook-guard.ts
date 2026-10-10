import { fromBufferPromise } from 'yauzl';
import { SaxesParser } from 'saxes';
import { SCORE_FILE_LIMITS } from '../shared/score-import';
import { DomainError } from './errors';

// XLSX column formatting may extend to XFD even when the data uses only A:R.
// Bound style expansion by Excel's physical limit; checkAddress independently
// enforces the much smaller import range for dimensions, cells and merges.
const XLSX_MAX_COLUMNS = 16384;

function checkAddress(address: string): number {
  const match = /^([A-Z]{1,3})([1-9]\d*)$/.exec(address);
  if (!match) throw new DomainError('SCORE_XLSX_INVALID', '工作表单元格坐标无效。');
  let column = 0;
  for (const character of match[1]!) column = column * 26 + character.charCodeAt(0) - 64;
  if (column > SCORE_FILE_LIMITS.columns || Number(match[2]) > SCORE_FILE_LIMITS.rows + 1) {
    throw new DomainError('SCORE_FILE_LIMIT', '工作表坐标超过支持的行列范围，未截断导入。');
  }
  return Number(match[2]);
}

/** Inspect actual decompressed data before handing the bounded archive to ExcelJS. */
export async function inspectScoreWorkbook(
  bytes: Buffer,
  allowRosterLayout = false,
): Promise<void> {
  const zip = await fromBufferPromise(bytes, {
    lazyEntries: true,
    validateEntrySizes: true,
    strictFileNames: true,
  }).catch(() => {
    throw new DomainError('SCORE_XLSX_INVALID', '文件不是有效的 XLSX 压缩包。');
  });
  let total = 0;
  let nodeCount = 0;
  const names = new Set<string>();
  try {
    if (zip.entryCount > SCORE_FILE_LIMITS.zipEntries) {
      throw new DomainError('SCORE_FILE_LIMIT', '工作簿内部文件数量超过限制。');
    }
    for await (const entry of zip.eachEntry()) {
      // 两个 ZIP 解析器必须看到相同路径，避免预检与实际读取对象不一致。
      const localHeader = await zip.readLocalFileHeaderPromise(entry);
      if (!localHeader.fileName.equals(entry.fileNameRaw)) {
        throw new DomainError('SCORE_XLSX_INVALID', '工作簿内部文件路径不一致。');
      }
      const name = entry.fileName.toLowerCase();
      if (names.has(name))
        throw new DomainError('SCORE_XLSX_INVALID', '工作簿存在重复的内部文件。');
      names.add(name);
      if (
        entry.isEncrypted() ||
        /(?:^|\/)(?:externalLinks|embeddings|queryTables)(?:\/|$)|vbaProject\.bin$|connections\.xml$/i.test(
          name,
        )
      ) {
        throw new DomainError(
          'SCORE_XLSX_UNSAFE',
          '不接受加密、宏、嵌入对象或外部数据连接工作簿。',
        );
      }
      if (
        entry.uncompressedSize > SCORE_FILE_LIMITS.entryBytes ||
        total + entry.uncompressedSize > SCORE_FILE_LIMITS.expandedBytes
      ) {
        throw new DomainError('SCORE_FILE_LIMIT', '工作簿解压内容超过限制。');
      }
      if (name.endsWith('/')) continue;
      const xml = name.endsWith('.xml') || name.endsWith('.rels');
      const sheet = /^xl\/worksheets\/[^/]+\.xml$/i.test(name);
      const decoder = new TextDecoder('utf-8', { fatal: true });
      const parser = xml ? new SaxesParser({ xmlns: true }) : null;
      let depth = 0;
      let activeRow: number | null = null;
      const seenRows = new Set<number>();
      const seenCells = new Set<string>();
      parser?.on('doctype', () => {
        throw new DomainError('SCORE_XLSX_UNSAFE', '不接受包含 DTD 或实体声明的工作簿。');
      });
      parser?.on('opentag', (node) => {
        if (++nodeCount > SCORE_FILE_LIMITS.xmlNodes || ++depth > 128) {
          throw new DomainError('SCORE_FILE_LIMIT', '工作簿 XML 结构过于复杂。');
        }
        const attribute = (local: string) =>
          Object.values(node.attributes).find((item) => item.local === local)?.value;
        if (
          (node.local === 'Relationship' &&
            (attribute('TargetMode')?.toLowerCase() === 'external' ||
              /^(?:[a-z][a-z0-9+.-]*:|\/\/|\\\\)/i.test(attribute('Target') ?? '')) &&
            !(
              allowRosterLayout &&
              /^xl\/worksheets\/_rels\/[^/]+\.xml\.rels$/i.test(name) &&
              attribute('Type') ===
                'http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink'
            )) ||
          attribute('ContentType')?.toLowerCase().includes('macroenabled')
        ) {
          throw new DomainError('SCORE_XLSX_UNSAFE', '工作簿包含外部链接或宏格式，已拒绝。');
        }
        if (sheet) {
          // 在 ExcelJS 展开合并范围或列区间之前限制结构，而非分配内存之后。
          if (node.local === 'mergeCell') {
            if (!allowRosterLayout)
              throw new DomainError('SCORE_XLSX_UNSAFE', '成绩表不接受合并单元格，请先取消合并。');
            const range = (attribute('ref') ?? '').split(':');
            if (range.length !== 2 || checkAddress(range[0]!) > checkAddress(range[1]!))
              throw new DomainError('SCORE_XLSX_INVALID', '合并单元格范围无效。');
          }
          if (node.local === 'col') {
            const min = attribute('min') ?? '';
            const max = attribute('max') ?? '';
            if (
              !/^[1-9]\d*$/.test(min) ||
              !/^[1-9]\d*$/.test(max) ||
              Number(min) > Number(max) ||
              Number(max) > XLSX_MAX_COLUMNS
            ) {
              throw new DomainError('SCORE_FILE_LIMIT', '工作表列格式范围无效或超出 Excel 限制。');
            }
          }
          if (node.local === 'dimension') {
            for (const address of (attribute('ref') ?? '').split(':')) checkAddress(address);
          }
          if (node.local === 'c') {
            const address = attribute('r') ?? '';
            if (checkAddress(address) !== activeRow || seenCells.has(address)) {
              throw new DomainError('SCORE_XLSX_INVALID', '工作表单元格重复或与所在行不一致。');
            }
            seenCells.add(address);
          }
          if (node.local === 'row') {
            const row = attribute('r') ?? '';
            if (!/^[1-9]\d*$/.test(row) || Number(row) > SCORE_FILE_LIMITS.rows + 1) {
              throw new DomainError('SCORE_FILE_LIMIT', '工作表行号无效或超过限制。');
            }
            if (activeRow !== null || seenRows.has(Number(row))) {
              throw new DomainError('SCORE_XLSX_INVALID', '工作表行重复或嵌套。');
            }
            activeRow = Number(row);
            seenRows.add(activeRow);
          }
        }
      });
      parser?.on('closetag', (node) => {
        if (sheet && node.local === 'row') activeRow = null;
        depth--;
      });
      const stream = await zip.openReadStreamPromise(entry);
      let entrySize = 0;
      try {
        for await (const chunk of stream) {
          entrySize += chunk.length;
          total += chunk.length;
          if (entrySize > SCORE_FILE_LIMITS.entryBytes || total > SCORE_FILE_LIMITS.expandedBytes) {
            throw new DomainError('SCORE_FILE_LIMIT', '实际解压内容超过限制。');
          }
          if (parser) parser.write(decoder.decode(chunk, { stream: true }));
        }
        if (parser) parser.write(decoder.decode()).close();
      } finally {
        stream.destroy();
      }
    }
    if (!names.has('[content_types].xml') || !names.has('xl/workbook.xml')) {
      throw new DomainError('SCORE_XLSX_INVALID', '工作簿缺少必要的结构文件。');
    }
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError('SCORE_XLSX_INVALID', '工作簿压缩或 XML 结构已损坏。');
  } finally {
    zip.close();
  }
}
