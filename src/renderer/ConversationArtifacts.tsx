import { useState } from 'react';
import type { ConversationDocument } from '../shared/conversation';
import type { LessonBlock, LessonContent } from '../shared/lessons';

/** Text-only Markdown: React escapes HTML; model text cannot execute scripts or load remote media. */
export function ConversationMarkdown({ text }: { text: string }) {
  const lines = text.split('\n');
  const blocks = [];
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.startsWith('```')) {
      const code: string[] = [];
      while (++index < lines.length && !lines[index]!.startsWith('```')) code.push(lines[index]!);
      blocks.push(
        <pre key={index}>
          <code>{code.join('\n')}</code>
        </pre>,
      );
    } else if (/^#{1,4}\s/.test(line)) {
      blocks.push(<h4 key={index}>{line.replace(/^#{1,4}\s+/, '')}</h4>);
    } else if (/^\s*(?:[-*]|\d+[.)、])\s+/.test(line)) {
      blocks.push(
        <p className="artifact-list-line" key={index}>
          {line.replace(/^\s*[-*]\s+/, '• ')}
        </p>,
      );
    } else if (line.trim()) blocks.push(<p key={index}>{line}</p>);
  }
  return <div className="conversation-markdown">{blocks}</div>;
}

export function DocumentCard({
  document,
  disabled,
  onContinue,
}: {
  document: ConversationDocument;
  disabled: boolean;
  onContinue: (prompt: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  return (
    <article className="conversation-artifact" aria-label="教学计划预览">
      <header>
        <div>
          <small>{document.kind === 'courseware' ? '课件方案' : '教学计划'} · 尚未保存</small>
          <h3>{document.title}</h3>
        </div>
        <button type="button" onClick={() => setExpanded(!expanded)}>
          {expanded ? '收起计划' : '展开计划'}
        </button>
      </header>
      {expanded && <ConversationMarkdown text={document.body} />}
      {document.nextPrompt && (
        <footer>
          <p>下一步：{document.nextPrompt}</p>
          <button
            className="primary"
            type="button"
            disabled={disabled}
            onClick={() => onContinue(document.nextPrompt!)}
          >
            确认计划并继续
          </button>
        </footer>
      )}
    </article>
  );
}

function Blocks({ value }: { value: LessonBlock[] }) {
  return (
    <div className="artifact-blocks">
      {value.map((block, index) => {
        if (block.kind === 'paragraph') return <p key={index}>{block.text}</p>;
        if (block.kind === 'list')
          return (
            <ul key={index}>
              {block.items.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          );
        if (block.kind === 'table')
          return (
            <div className="artifact-table" key={index}>
              <table>
                <thead>
                  <tr>
                    {block.columns.map((column, i) => (
                      <th key={i}>{column}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {block.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j}>{cell}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          );
        return <p key={index}>图片：{block.caption}（原始图片可在备课页面查看）</p>;
      })}
    </div>
  );
}

export function LessonCard({ content }: { content: LessonContent }) {
  const [tab, setTab] = useState<'plan' | 'slides'>('plan');
  const [slideIndex, setSlideIndex] = useState(0);
  const [answers, setAnswers] = useState(false);
  const slide = content.slides[Math.min(slideIndex, content.slides.length - 1)]!;
  return (
    <article className="conversation-artifact" aria-label="教案与课件预览">
      <header>
        <div>
          <small>
            教案与课件 · {content.sections.length} 个环节 · {content.slides.length} 页
          </small>
          <h3>{content.title}</h3>
        </div>
      </header>
      <div className="artifact-tabs" role="tablist" aria-label="教学内容类型">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'plan'}
          onClick={() => setTab('plan')}
        >
          教学计划
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'slides'}
          onClick={() => setTab('slides')}
        >
          课件预览
        </button>
      </div>
      {tab === 'plan' ? (
        <div role="tabpanel">
          <h4>教学目标</h4>
          <Blocks value={content.objectives} />
          <h4>重点</h4>
          <Blocks value={content.keyPoints} />
          <h4>难点</h4>
          <Blocks value={content.difficulties} />
          {content.sections.map((section) => (
            <details key={section.id} open>
              <summary>
                {section.title} · {section.durationMinutes} 分钟
              </summary>
              <Blocks value={section.content} />
              {!!section.questions.length && (
                <>
                  <h4>提问</h4>
                  <Blocks value={section.questions} />
                </>
              )}
              {!!section.answers.length && (
                <details>
                  <summary>参考答案</summary>
                  <Blocks value={section.answers} />
                </details>
              )}
              {section.teacherNotes && (
                <details>
                  <summary>教师备注</summary>
                  <p>{section.teacherNotes}</p>
                </details>
              )}
            </details>
          ))}
        </div>
      ) : (
        <div role="tabpanel">
          <div className="artifact-slide">
            <small>
              第 {Math.min(slideIndex + 1, content.slides.length)} / {content.slides.length} 页
            </small>
            <h3>{slide.title}</h3>
            <Blocks value={slide.content} />
            {answers && (
              <>
                <h4>参考答案</h4>
                <Blocks value={slide.answers} />
              </>
            )}
          </div>
          <div className="artifact-slide-controls">
            <button
              type="button"
              disabled={slideIndex === 0}
              onClick={() => {
                setSlideIndex(Math.max(0, slideIndex - 1));
                setAnswers(false);
              }}
            >
              上一页
            </button>
            <button
              type="button"
              disabled={slideIndex >= content.slides.length - 1}
              onClick={() => {
                setSlideIndex(slideIndex + 1);
                setAnswers(false);
              }}
            >
              下一页
            </button>
            <button type="button" onClick={() => setAnswers(!answers)}>
              {answers ? '隐藏答案' : '查看答案'}
            </button>
          </div>
        </div>
      )}
    </article>
  );
}
