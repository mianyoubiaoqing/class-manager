import { useRef, useState, type PointerEvent } from 'react';
import type { GradingRectangle } from '../shared/grading';
import { gradingDragRectangle } from './grading-editor';

/** 本地图像上的归一化区域选择，支持反向拖选及键盘百分比输入；不读取文件或发送请求。 */
export function GradingRegion({
  image,
  label,
  rectangles,
  onSelect,
  disabled = false,
}: {
  image?: string;
  label: string;
  rectangles: GradingRectangle[];
  onSelect?: (rectangle: GradingRectangle) => void;
  disabled?: boolean;
}) {
  const start = useRef<{ x: number; y: number } | undefined>(undefined);
  const [drag, setDrag] = useState<GradingRectangle | null>(null);
  const [manual, setManual] = useState({ x: '0', y: '0', width: '100', height: '100' });
  const [error, setError] = useState('');
  const point = (event: PointerEvent<SVGSVGElement>) => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: (event.clientX - box.left) / box.width, y: (event.clientY - box.top) / box.height };
  };
  return (
    <div className="grading-region">
      {image ? (
        <div className="grading-image">
          <img src={image} alt={label} draggable={false} />
          <svg
            viewBox="0 0 1 1"
            preserveAspectRatio="none"
            aria-label={`${label}区域`}
            role="img"
            onPointerDown={(event) => {
              if (!onSelect || disabled || event.button !== 0) return;
              start.current = point(event);
              event.currentTarget.setPointerCapture(event.pointerId);
              setDrag(null);
            }}
            onPointerMove={(event) => {
              if (start.current) setDrag(gradingDragRectangle(start.current, point(event)));
            }}
            onPointerUp={(event) => {
              if (!start.current) return;
              const rectangle = gradingDragRectangle(start.current, point(event));
              start.current = undefined;
              setDrag(null);
              if (rectangle && onSelect && !disabled) onSelect(rectangle);
            }}
            onPointerCancel={() => {
              start.current = undefined;
              setDrag(null);
            }}
          >
            {rectangles.map((r, i) => (
              <rect
                key={i}
                x={r.x}
                y={r.y}
                width={r.width}
                height={r.height}
                className="selected-region"
              />
            ))}
            {drag && <rect {...drag} className="selected-region dragging" />}
          </svg>
        </div>
      ) : (
        <p className="muted">请选择图像并读取预览。</p>
      )}
      {onSelect && (
        <>
          <p className="muted">在图像上拖选区域，或填写百分比。区域须避开遮盖部分。</p>
          <div className="grading-percent">
            {(['x', 'y', 'width', 'height'] as const).map((name) => (
              <label key={name}>
                {{ x: '左侧 %', y: '顶部 %', width: '宽度 %', height: '高度 %' }[name]}
                <input
                  aria-label={`${label}${name}`}
                  type="number"
                  min="0"
                  max="100"
                  step="0.1"
                  disabled={disabled || !image}
                  value={manual[name]}
                  onChange={(event) => setManual({ ...manual, [name]: event.target.value })}
                />
              </label>
            ))}
          </div>
          <button
            disabled={disabled || !image}
            onClick={() => {
              const r = {
                x: Number(manual.x) / 100,
                y: Number(manual.y) / 100,
                width: Number(manual.width) / 100,
                height: Number(manual.height) / 100,
              };
              if (
                Object.values(manual).some((v) => !v.trim()) ||
                !Object.values(r).every(Number.isFinite) ||
                r.x < 0 ||
                r.y < 0 ||
                r.width <= 0 ||
                r.height <= 0 ||
                r.x + r.width > 1 ||
                r.y + r.height > 1
              ) {
                setError('区域须在图像内，宽度和高度必须大于零。');
                return;
              }
              setError('');
              onSelect(r);
            }}
          >
            使用此区域
          </button>
          {error && <p role="alert">{error}</p>}
        </>
      )}
    </div>
  );
}
