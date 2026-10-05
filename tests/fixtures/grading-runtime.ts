import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { Workspace } from '../../src/core/workspace';

/** 自制普通题型答卷及人工评分依据；仅建立独立合成工作区，不读取凭据或调用模型。 */
export async function seedGradingWorkspace(root: string, files: string) {
  const workspace = new Workspace(root);
  try {
    const epoch = workspace.snapshot().epoch;
    workspace.createClass({ epoch, name: '合成阅卷验收班' });
    const classId = workspace.snapshot().classes[0]!.id;
    workspace.saveStudent({
      epoch,
      classId,
      studentNumber: 'SYNTHETIC_GOLD',
      displayName: '合成阅卷甲',
    });
    const studentId = workspace.snapshot().students[0]!.id;
    const subjectId = randomUUID(),
      groupId = randomUUID();
    const preview = await workspace.scores.preview(
      Buffer.from('学生编号,合成普通题型\nSYNTHETIC_GOLD,未录入'),
      {
        epoch,
        classId,
        expectedRevision: 0,
        definition: {
          name: '合成普通题型验收测验',
          date: '2026-10-01',
          academicYear: '2026-2027',
          term: '上学期',
          grade: '高一',
        },
        subjects: [{ id: subjectId, name: '合成普通题型', maxScore: '10', precision: 0 }],
        groups: [{ id: groupId, name: '合成计分组', subjectIds: [subjectId] }],
        assignments: [{ studentId, groupId }],
        scoreBasis: 'raw',
        format: 'csv',
        fileName: 'synthetic-gold.csv',
      },
    );
    const score = workspace.scores.confirm({
      epoch,
      token: preview.token,
      requestId: randomUUID(),
      expectedRevision: 0,
      reason: '合成考试未录入成绩',
    });
    const lines = [
      [
        'Q1. Choose the letter B (A / B / C / D).',
        'Q2. Select A and C. No wrong option: 1 point each.',
        'Q3. The statement "2 + 2 = 4" is true.',
      ],
      [
        'Q4. Fill in: the SI unit of force is _____.',
        'Q5. Describe the three elements of a force.',
        'Q6. Complex handwritten formula: manual review.',
      ],
    ];
    const answers = [
      ['B', 'A', 'true'],
      ['Newton', 'magnitude, direction, point of application', 'x squared + y squared = 1'],
    ];
    const imageFiles: string[] = [];
    // 不用字体冒充手写选项：B/A 使用自行描出的、不规则笔画路径。
    const optionStrokes = [
      '<path d="M78 230 L74 263 M78 232 C106 225 108 244 77 247 M77 247 C111 239 112 265 75 262" stroke="#153d78" stroke-width="3" fill="none" stroke-linecap="round"/>',
      '<path d="M74 493 L89 460 L106 492 M80 481 L99 480" stroke="#153d78" stroke-width="3" fill="none" stroke-linecap="round"/>',
    ];
    for (let index = 0; index < 2; index++) {
      const content = lines[index]!.map((line, j) => {
        const answer =
          index === 0 && j < 2
            ? optionStrokes[j]
            : `<text x="70" y="${260 + j * 230}" font-size="${j === 1 && index === 1 ? 23 : 36}" font-family="Georgia" font-style="italic" fill="#153d78" transform="rotate(-1 70 ${260 + j * 230})">${answers[index]![j]}</text>`;
        return `<text x="35" y="${200 + j * 230}" font-size="21" font-family="Arial">${line.replaceAll('&', '&amp;').replaceAll('"', '&quot;')}</text><path d="M35 ${300 + j * 230} H760" stroke="#aaa"/>${answer}`;
      }).join('');
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="1000"><rect width="800" height="1000" fill="white"/><text x="35" y="45" font-size="22" font-family="Arial">PRIVATE_SYNTHETIC_IDENTITY_${index + 1}</text><text x="35" y="110" font-size="24" font-family="Arial">SYNTHETIC ANSWER PAGE ${index + 1} OF 2</text>${content}<text x="35" y="950" font-family="Arial" font-size="16">Self-created synthetic material; no real student data.</text></svg>`;
      const file = join(files, `PRIVATE_SYNTHETIC_page-${index + 1}.png`);
      writeFileSync(file, await sharp(Buffer.from(svg)).png().toBuffer());
      imageFiles.push(file);
    }
    const gold = {
      answers: answers.flat(),
      scores: [1, 1, 1, 2, 3, 1],
      total: 9,
      expectedAnswerPages: 2,
      support: ['single_choice', 'multiple_choice', 'judgement', 'blank', 'short_text', 'manual'],
      note: '自制印刷题干、描绘笔画的B/A选项及斜体短句；只证明这些样本的软件路径，不代表任意真实笔迹的识别效果。',
    };
    writeFileSync(join(files, 'human-gold.json'), JSON.stringify(gold, null, 2));
    return { epoch, score, subjectId, studentId, imageFiles, gold };
  } finally {
    workspace.close();
  }
}
