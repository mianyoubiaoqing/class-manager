import type { LessonBlock, LessonContent } from '../shared/lessons';

const suggestion = (): LessonBlock => ({
  kind: 'paragraph',
  text: '请填写内容',
  origin: { kind: 'supplement' },
});
export function LessonBlocks({
  value,
  change,
  readOnly,
  openSource,
}: {
  value: LessonBlock[];
  change: (value: LessonBlock[]) => void;
  readOnly: boolean;
  openSource: (id: string, fragmentId: number) => void;
}) {
  const update = (index: number, block: LessonBlock) =>
    change(value.map((old, n) => (n === index ? block : old)));
  return (
    <div className="lesson-blocks">
      {value.map((block, index) => (
        <div className="lesson-block" key={index}>
          <div className="lesson-block-origin">
            {block.kind === 'image' ? (
              <button
                type="button"
                onClick={() => openSource(block.source.sourceVersionId, block.source.fragmentId)}
              >
                查看图片来源 #{block.source.fragmentId}
              </button>
            ) : (
              <>
                <span>{block.origin.kind === 'source' ? '资料依据' : '补充建议'}</span>
                {block.origin.kind === 'source' &&
                  block.origin.citations.map((ref) => (
                    <button
                      type="button"
                      key={`${ref.sourceVersionId}:${ref.fragmentId}`}
                      onClick={() => openSource(ref.sourceVersionId, ref.fragmentId)}
                    >
                      查看来源 #{ref.fragmentId}
                      {ref.quote && <small>「{ref.quote}」</small>}
                    </button>
                  ))}
                {!readOnly && block.origin.kind === 'source' && (
                  <button
                    type="button"
                    onClick={() => update(index, { ...block, origin: { kind: 'supplement' } })}
                  >
                    改为补充建议
                  </button>
                )}
              </>
            )}
            {!readOnly && (
              <button
                type="button"
                className="danger-button"
                onClick={() => change(value.filter((_, n) => n !== index))}
              >
                删除内容块
              </button>
            )}
          </div>
          {block.kind === 'paragraph' && (
            <label>
              段落
              <textarea
                aria-label={`段落 ${index + 1}`}
                value={block.text}
                readOnly={readOnly}
                maxLength={4000}
                onChange={(event) => update(index, { ...block, text: event.target.value })}
              />
            </label>
          )}
          {block.kind === 'list' && (
            <label>
              列表（每行一项）
              <textarea
                value={block.items.join('\n')}
                readOnly={readOnly}
                onChange={(event) =>
                  update(index, { ...block, items: event.target.value.split('\n') })
                }
              />
            </label>
          )}
          {block.kind === 'table' && (
            <div className="lesson-table-wrap">
              <table>
                <thead>
                  <tr>
                    {block.columns.map((column, n) => (
                      <th key={n}>
                        <input
                          aria-label={`表头 ${n + 1}`}
                          value={column}
                          readOnly={readOnly}
                          maxLength={100}
                          onChange={(event) =>
                            update(index, {
                              ...block,
                              columns: block.columns.map((old, j) =>
                                j === n ? event.target.value : old,
                              ),
                            })
                          }
                        />
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, n) => (
                    <tr key={n}>
                      {row.map((cell, j) => (
                        <td key={j}>
                          <input
                            aria-label={`表格 ${n + 1} 行 ${j + 1} 列`}
                            value={cell}
                            readOnly={readOnly}
                            maxLength={500}
                            onChange={(event) =>
                              update(index, {
                                ...block,
                                rows: block.rows.map((oldRow, k) =>
                                  k === n
                                    ? oldRow.map((old, m) => (m === j ? event.target.value : old))
                                    : oldRow,
                                ),
                              })
                            }
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              {!readOnly && (
                <div className="lesson-actions">
                  <button
                    type="button"
                    disabled={block.rows.length >= 30}
                    onClick={() =>
                      update(index, {
                        ...block,
                        rows: [...block.rows, block.columns.map(() => '内容')],
                      })
                    }
                  >
                    增加行
                  </button>
                  <button
                    type="button"
                    disabled={block.columns.length >= 8}
                    onClick={() =>
                      update(index, {
                        ...block,
                        columns: [...block.columns, '列'],
                        rows: block.rows.map((row) => [...row, '内容']),
                      })
                    }
                  >
                    增加列
                  </button>
                  <button
                    type="button"
                    disabled={block.rows.length <= 1}
                    onClick={() => update(index, { ...block, rows: block.rows.slice(0, -1) })}
                  >
                    删除末行
                  </button>
                  <button
                    type="button"
                    disabled={block.columns.length <= 1}
                    onClick={() =>
                      update(index, {
                        ...block,
                        columns: block.columns.slice(0, -1),
                        rows: block.rows.map((row) => row.slice(0, -1)),
                      })
                    }
                  >
                    删除末列
                  </button>
                </div>
              )}
            </div>
          )}
          {block.kind === 'image' && (
            <label>
              图像说明
              <input
                value={block.caption}
                readOnly={readOnly}
                maxLength={500}
                onChange={(event) => update(index, { ...block, caption: event.target.value })}
              />
            </label>
          )}
        </div>
      ))}
      {!readOnly && value.length < 30 && (
        <div className="lesson-actions">
          <button type="button" onClick={() => change([...value, suggestion()])}>
            增加段落
          </button>
          <button
            type="button"
            onClick={() =>
              change([
                ...value,
                { kind: 'list', items: ['请填写条目'], origin: { kind: 'supplement' } },
              ])
            }
          >
            增加列表
          </button>
          <button
            type="button"
            onClick={() =>
              change([
                ...value,
                {
                  kind: 'table',
                  columns: ['项目', '说明'],
                  rows: [['项目', '说明']],
                  origin: { kind: 'supplement' },
                },
              ])
            }
          >
            增加表格
          </button>
        </div>
      )}
    </div>
  );
}

/** Native structured editing for notes and slides; no raw JSON or implementation fields in the
 * teacher workflow. The backend revalidates durations, references and quotas before saving. */
export function LessonContentEditor({
  value,
  change,
  readOnly,
  openSource,
}: {
  value: LessonContent;
  change: (value: LessonContent) => void;
  readOnly: boolean;
  openSource: (id: string, fragmentId: number) => void;
}) {
  const blocks = (label: string, value: LessonBlock[], change: (next: LessonBlock[]) => void) => (
    <fieldset>
      <legend>{label}</legend>
      <LessonBlocks value={value} change={change} readOnly={readOnly} openSource={openSource} />
    </fieldset>
  );
  return (
    <div className="lesson-content-editor">
      <label>
        教案标题
        <input
          aria-label="教案标题"
          value={value.title}
          readOnly={readOnly}
          maxLength={200}
          onChange={(event) => change({ ...value, title: event.target.value })}
        />
      </label>
      {blocks('教学目标', value.objectives, (objectives) => change({ ...value, objectives }))}
      {blocks('教学重点', value.keyPoints, (keyPoints) => change({ ...value, keyPoints }))}
      {blocks('教学难点', value.difficulties, (difficulties) => change({ ...value, difficulties }))}
      <h3>教学环节</h3>
      {value.sections.map((section, index) => {
        const update = (next: typeof section) =>
          change({
            ...value,
            sections: value.sections.map((old, n) => (n === index ? next : old)),
          });
        return (
          <details className="lesson-section" key={section.id} open={index === 0}>
            <summary>
              {index + 1}. {section.title} · {section.durationMinutes} 分钟
            </summary>
            <label>
              环节名称
              <input
                value={section.title}
                readOnly={readOnly}
                maxLength={200}
                onChange={(event) => update({ ...section, title: event.target.value })}
              />
            </label>
            <label>
              环节时长（分钟）
              <input
                type="number"
                min={1}
                max={240}
                value={section.durationMinutes}
                readOnly={readOnly}
                onChange={(event) =>
                  update({ ...section, durationMinutes: Number(event.target.value) })
                }
              />
            </label>
            {blocks('环节内容', section.content, (content) => update({ ...section, content }))}
            {blocks('课堂提问', section.questions, (questions) =>
              update({ ...section, questions }),
            )}
            {blocks('参考答案（教师私有）', section.answers, (answers) =>
              update({ ...section, answers }),
            )}
            <label>
              教师私有备注
              <textarea
                value={section.teacherNotes}
                readOnly={readOnly}
                maxLength={4000}
                onChange={(event) => update({ ...section, teacherNotes: event.target.value })}
              />
            </label>
            {!readOnly && (
              <div className="lesson-actions">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    const sections = [...value.sections];
                    [sections[index - 1], sections[index]] = [
                      sections[index]!,
                      sections[index - 1]!,
                    ];
                    change({ ...value, sections });
                  }}
                >
                  上移环节
                </button>
                <button
                  type="button"
                  disabled={value.sections.length === 1}
                  onClick={() =>
                    change({
                      ...value,
                      sections: value.sections.filter((s) => s.id !== section.id),
                      slides: value.slides.filter((s) => s.sectionId !== section.id),
                    })
                  }
                >
                  删除环节及所属课件
                </button>
              </div>
            )}
          </details>
        );
      })}
      {!readOnly && value.sections.length < 30 && value.slides.length < 60 && (
        <button
          type="button"
          onClick={() => {
            const id = crypto.randomUUID();
            change({
              ...value,
              sections: [
                ...value.sections,
                {
                  id,
                  title: '新环节',
                  durationMinutes: 1,
                  content: [suggestion()],
                  questions: [],
                  answers: [],
                  teacherNotes: '',
                },
              ],
              slides: [
                ...value.slides,
                {
                  id: crypto.randomUUID(),
                  sectionId: id,
                  title: '新环节课件',
                  content: [suggestion()],
                  answers: [],
                  teacherNotes: '',
                },
              ],
            });
          }}
        >
          增加环节及课件
        </button>
      )}
      <h3>同版课件</h3>
      {value.slides.map((slide, index) => {
        const update = (next: typeof slide) =>
          change({ ...value, slides: value.slides.map((old, n) => (n === index ? next : old)) });
        return (
          <details className="lesson-section" key={slide.id} open={index === 0}>
            <summary>
              {index + 1}. {slide.title}
            </summary>
            <label>
              课件页标题
              <input
                value={slide.title}
                readOnly={readOnly}
                maxLength={200}
                onChange={(event) => update({ ...slide, title: event.target.value })}
              />
            </label>
            <label>
              所属环节
              <select
                value={slide.sectionId}
                disabled={readOnly}
                onChange={(event) => update({ ...slide, sectionId: event.target.value })}
              >
                {value.sections.map((section) => (
                  <option key={section.id} value={section.id}>
                    {section.title}
                  </option>
                ))}
              </select>
            </label>
            {blocks('学生展示正文', slide.content, (content) => update({ ...slide, content }))}
            {blocks('可选参考答案（默认不展示）', slide.answers, (answers) =>
              update({ ...slide, answers }),
            )}
            <label>
              课件教师私有备注
              <textarea
                value={slide.teacherNotes}
                readOnly={readOnly}
                maxLength={4000}
                onChange={(event) => update({ ...slide, teacherNotes: event.target.value })}
              />
            </label>
            {!readOnly && (
              <div className="lesson-actions">
                <button
                  type="button"
                  disabled={index === 0}
                  onClick={() => {
                    const slides = [...value.slides];
                    [slides[index - 1], slides[index]] = [slides[index]!, slides[index - 1]!];
                    change({ ...value, slides });
                  }}
                >
                  上移课件
                </button>
                <button
                  type="button"
                  disabled={value.slides.filter((s) => s.sectionId === slide.sectionId).length <= 1}
                  onClick={() =>
                    change({ ...value, slides: value.slides.filter((s) => s.id !== slide.id) })
                  }
                >
                  删除课件页
                </button>
              </div>
            )}
          </details>
        );
      })}
      {!readOnly && value.slides.length < 60 && (
        <button
          type="button"
          onClick={() =>
            change({
              ...value,
              slides: [
                ...value.slides,
                {
                  id: crypto.randomUUID(),
                  sectionId: value.sections[0]!.id,
                  title: '新课件页',
                  content: [suggestion()],
                  answers: [],
                  teacherNotes: '',
                },
              ],
            })
          }
        >
          增加课件页
        </button>
      )}
    </div>
  );
}
