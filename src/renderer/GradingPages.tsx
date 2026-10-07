import type { GradingPage, GradingRectangle } from '../shared/grading';
import { GRADING_LIMITS } from '../shared/grading';
import { GradingRegion } from './GradingRegion';

export function GradingPages({
  pages,
  onChange,
  selected,
  onSelected,
  current,
  onCurrent,
  original,
  readOriginal,
  disabled,
  names,
}: {
  pages: GradingPage[];
  onChange: (pages: GradingPage[]) => void;
  selected: string[];
  onSelected: (selected: string[]) => void;
  current: string;
  onCurrent: (id: string) => void;
  original?: string;
  readOriginal: () => void;
  disabled: boolean;
  names: Map<string, string>;
}) {
  const page = pages.find((page) => page.id === current);
  const change = (patch: Partial<GradingPage>) =>
    onChange(pages.map((p) => (p.id === current ? { ...p, ...patch } : p)));
  const move = (id: string, offset: number) => {
    const index = pages.findIndex((p) => p.id === id),
      target = index + offset;
    if (target < 0 || target >= pages.length) return;
    const next = [...pages];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  return (
    <div className="grading-pages">
      <ol className="grading-page-list">
        {pages.map((p, index) => (
          <li key={p.id}>
            <label>
              <input
                type="checkbox"
                disabled={
                  disabled ||
                  (!selected.includes(p.id) && selected.length >= GRADING_LIMITS.selectedPages)
                }
                checked={selected.includes(p.id)}
                onChange={(e) =>
                  onSelected(
                    e.target.checked ? [...selected, p.id] : selected.filter((id) => id !== p.id),
                  )
                }
              />
              本批
            </label>
            <button
              disabled={disabled}
              aria-pressed={current === p.id}
              onClick={() => onCurrent(p.id)}
            >
              第 {index + 1} 页 · {names.get(p.sourceVersionId) ?? '保存的材料'} · 图 {p.fragmentId}
            </button>
            <select
              aria-label={`第${index + 1}页角色`}
              value={p.role}
              disabled={disabled}
              onChange={(e) => {
                const role = e.target.value;
                if (
                  role === 'student_answer' ||
                  role === 'question_material' ||
                  role === 'rubric_material'
                )
                  onChange(pages.map((item) => (item.id === p.id ? { ...item, role } : item)));
              }}
            >
              <option value="student_answer">学生答卷</option>
              <option value="question_material">题目材料</option>
              <option value="rubric_material">标准答案 / 细则材料</option>
            </select>
            <button disabled={disabled || index === 0} onClick={() => move(p.id, -1)}>
              上移
            </button>
            <button disabled={disabled || index === pages.length - 1} onClick={() => move(p.id, 1)}>
              下移
            </button>
            <button
              disabled={disabled}
              onClick={() => {
                onChange(pages.filter((item) => item.id !== p.id));
                onSelected(selected.filter((id) => id !== p.id));
              }}
            >
              移除
            </button>
          </li>
        ))}
      </ol>
      {page && (
        <div className="grading-page-transform">
          <h3>第 {pages.indexOf(page) + 1} 页原图</h3>
          <button disabled={disabled} onClick={readOriginal}>
            读取原图
          </button>
          {original && (
            <figure className="grading-original-preview">
              <img src={original} alt="当前答卷原图预览" />
              <figcaption>已读取原图；需要裁剪或遮盖时，展开下方对应选项。</figcaption>
            </figure>
          )}
          <label>
            顺时针旋转
            <select
              disabled={disabled}
              value={page.rotation}
              onChange={(e) => {
                const rotation = Number(e.target.value);
                if (rotation === 0 || rotation === 90 || rotation === 180 || rotation === 270)
                  change({ rotation });
              }}
            >
              <option value="0">0°</option>
              <option value="90">90°</option>
              <option value="180">180°</option>
              <option value="270">270°</option>
            </select>
          </label>
          <details>
            <summary>裁剪范围</summary>
            <GradingRegion
              image={original}
              label="原图裁剪"
              rectangles={[page.crop]}
              disabled={disabled}
              onSelect={(crop) => change({ crop })}
            />
            <button
              disabled={disabled}
              onClick={() => change({ crop: { x: 0, y: 0, width: 1, height: 1 } })}
            >
              恢复整页
            </button>
          </details>
          <details>
            <summary>遮盖身份信息（{page.redactions.length} 个区域）</summary>
            <GradingRegion
              image={original}
              label="原图遮盖"
              rectangles={page.redactions}
              disabled={disabled || page.redactions.length >= 100}
              onSelect={(rectangle: GradingRectangle) =>
                change({ redactions: [...page.redactions, rectangle] })
              }
            />
            {page.redactions.map((r, index) => (
              <p key={index}>
                区域 {index + 1}：左 {(r.x * 100).toFixed(1)}%，上 {(r.y * 100).toFixed(1)}%{' '}
                <button
                  disabled={disabled}
                  onClick={() =>
                    change({ redactions: page.redactions.filter((_, i) => i !== index) })
                  }
                >
                  移除此遮盖
                </button>
              </p>
            ))}
          </details>
          <p className="muted">
            姓名、编号、二维码和正文身份信息须检查并遮盖；实际处理后的图像将在保存答卷后提供。
          </p>
        </div>
      )}
    </div>
  );
}
