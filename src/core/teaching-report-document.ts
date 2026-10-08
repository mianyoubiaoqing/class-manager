import {
  Document,
  Packer,
  Paragraph,
  Table,
  TableCell,
  TableRow,
  WidthType,
  HeadingLevel,
} from 'docx';
import ExcelJS from 'exceljs';
import type { TeachingReportDocument } from '../shared/teaching-report';

export async function createTeachingReportDocument(
  input: TeachingReportDocument,
): Promise<{ bytes: Buffer; pages: null }> {
  if (input.format === 'xlsx') {
    const book = new ExcelJS.Workbook();
    const sheet = book.addWorksheet('工作台资料');
    sheet.addRows(input.rows);
    sheet.getRow(1).font = { bold: true };
    sheet.columns.forEach((col) => {
      col.width = 24;
    });
    return { bytes: Buffer.from(await book.xlsx.writeBuffer()), pages: null };
  }
  const document = new Document({
    sections: [
      {
        children: [
          new Paragraph({ text: input.title, heading: HeadingLevel.TITLE }),
          new Paragraph(
            `导出日期：${new Date().toLocaleDateString('zh-CN')}  数据来源：本地工作台`,
          ),
          new Table({
            width: { size: 100, type: WidthType.PERCENTAGE },
            rows: input.rows.map(
              (row) =>
                new TableRow({
                  children: row.map(
                    (text) =>
                      new TableCell({
                        children: text.split('\n').map((line) => new Paragraph(line)),
                      }),
                  ),
                }),
            ),
          }),
        ],
      },
    ],
  });
  return { bytes: await Packer.toBuffer(document), pages: null };
}
