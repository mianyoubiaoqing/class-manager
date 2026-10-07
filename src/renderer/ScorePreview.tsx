import { useState } from 'react';
import { Trash2 } from 'lucide-react';
import type { SelectedScorePreview } from '../shared/score-commands';
import {
  configurationDifference,
  scoreText,
  type ExamDraft,
  type ScoreConfiguration,
} from './score-editor';

export function ScorePreview({
  preview,
  draft,
  change,
}: {
  preview: SelectedScorePreview;
  draft: ExamDraft;
  change: (configuration: ScoreConfiguration) => void;
}) {
  const [page, setPage] = useState(0);
  const [onlyIssues, setOnlyIssues] = useState(false);
  const [row, setRow] = useState('');
  const [reason, setReason] = useState('');
  const [header, setHeader] = useState('');
  const [subjectId, setSubjectId] = useState(draft.configuration.subjects[0]?.id ?? '');
  const [differencePage, setDifferencePage] = useState(0);
  const [configurationPage, setConfigurationPage] = useState(0);
  const diffPage = Math.min(
    differencePage,
    Math.max(0, Math.ceil((preview.differences?.scores.length ?? 0) / 20) - 1),
  );
  const configPage = Math.min(
    configurationPage,
    Math.max(0, Math.ceil((preview.differences?.configuration.length ?? 0) / 20) - 1),
  );
  const config = draft.configuration;
  const rows = preview.rows.filter((item) => !onlyIssues || item.issues.length > 0);
  const currentPage = Math.min(page, Math.max(0, Math.ceil(rows.length / 20) - 1));
  const names = new Map(
    draft.roster.map((student) => [
      student.studentId,
      `${student.studentNumber} ${student.displayName}`,
    ]),
  );
  const subjectName = (id: string) =>
    config.subjects.find((subject) => subject.id === id)?.name ??
    draft.baseline?.analysis.subjects.find((subject) => subject.id === id)?.name ??
    '未知科目';
  return (
    <section className="score-section" aria-label="导入预览">
      <h2>{preview.fileName} · 导入预览</h2>
      <p>
        {preview.rows.length} 行 · 未提供成绩 {preview.missingStudentIds.length} 人 ·{' '}
        {preview.canConfirm ? '可确认' : preview.unchanged ? '与当前版本相同' : '尚不可确认'}
      </p>
      {preview.issues.length > 0 && (
        <div role="alert" className="score-warning">
          {preview.issues.map((issue, index) => (
            <p key={index}>
              第 {issue.row} 行{issue.column !== null ? `，第 ${issue.column} 列` : ''}：
              {issue.message}
            </p>
          ))}
        </div>
      )}
      <label className="score-check">
        <input
          type="checkbox"
          checked={onlyIssues}
          onChange={(event) => {
            setOnlyIssues(event.target.checked);
            setPage(0);
          }}
        />
        仅显示问题行
      </label>
      <div className="score-table-scroll">
        <table>
          <thead>
            <tr>
              <th>行号</th>
              <th>编号 / 姓名</th>
              {config.subjects.map((subject) => (
                <th key={subject.id}>{subject.name}</th>
              ))}
              <th>校验 / 排除</th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(currentPage * 20, currentPage * 20 + 20).map((item) => (
              <tr key={item.row}>
                <td>{item.row}</td>
                <td>
                  {item.studentNumber} {item.displayName}
                </td>
                {config.subjects.map((subject) => (
                  <td key={subject.id}>
                    {item.scores.some((score) => score.subjectId === subject.id)
                      ? scoreText(
                          item.scores.find((score) => score.subjectId === subject.id)!.score,
                        )
                      : item.excluded
                        ? '已排除'
                        : '未解析'}
                  </td>
                ))}
                <td>
                  {item.excluded
                    ? `已排除：${item.exclusionReason}`
                    : item.issues
                        .map(
                          (issue) =>
                            `${issue.column === null ? '' : `列 ${issue.column}：`}${issue.message}`,
                        )
                        .join('；') || '通过'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="score-actions">
        <button type="button" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>
          上一页
        </button>
        <span>
          {currentPage + 1} / {Math.max(1, Math.ceil(rows.length / 20))}
        </span>
        <button
          type="button"
          disabled={(currentPage + 1) * 20 >= rows.length}
          onClick={() => setPage(currentPage + 1)}
        >
          下一页
        </button>
      </div>
      <details>
        <summary>缺少成绩的应考学生（{preview.missingStudentIds.length}）</summary>
        <div className="score-bounded-list">
          {preview.missingStudentIds.map((id) => (
            <p key={id}>{names.get(id)}</p>
          ))}
        </div>
      </details>
      <details className="score-advanced" open={!preview.canConfirm}>
        <summary>高级修正：对应科目列与排除文件行</summary>
        <p>文件全部通过校验时，无需调整。修改后请点击“重新预览”。</p>
        <h3>显式列映射</h3>
        <div className="score-actions">
          <select
            aria-label="原始成绩列"
            value={header}
            onChange={(event) => setHeader(event.target.value)}
          >
            <option value="">选择原表列名</option>
            {preview.headers.map((value, index) => (
              <option key={index} value={value}>
                {value}
              </option>
            ))}
          </select>
          <select
            aria-label="映射目标科目"
            value={subjectId}
            onChange={(event) => setSubjectId(event.target.value)}
          >
            {config.subjects.map((subject) => (
              <option key={subject.id} value={subject.id}>
                {subject.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!header || !subjectId}
            onClick={() =>
              change({
                ...config,
                columnMappings: [
                  ...(config.columnMappings ?? []).filter((mapping) => mapping.header !== header),
                  { header, subjectId },
                ],
              })
            }
          >
            应用列映射
          </button>
        </div>
        {(config.columnMappings ?? []).map((mapping) => (
          <div className="score-actions" key={mapping.header}>
            <span>
              {mapping.header} → {subjectName(mapping.subjectId)}
            </span>
            <button
              type="button"
              className="icon-button"
              title={`删除映射 ${mapping.header}`}
              aria-label={`删除映射 ${mapping.header}`}
              onClick={() =>
                change({
                  ...config,
                  columnMappings: config.columnMappings?.filter(
                    (item) => item.header !== mapping.header,
                  ),
                })
              }
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
        <h3>排除文件行</h3>
        <div className="score-actions">
          <input
            aria-label="排除行号"
            type="number"
            min="2"
            max="10001"
            value={row}
            onChange={(event) => setRow(event.target.value)}
          />
          <input
            aria-label="排除原因"
            placeholder="排除原因"
            maxLength={300}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <button
            type="button"
            disabled={!reason.trim() || !preview.rows.some((item) => item.row === Number(row))}
            onClick={() =>
              change({
                ...config,
                exclusions: [
                  ...(config.exclusions ?? []).filter((item) => item.row !== Number(row)),
                  { row: Number(row), reason: reason.trim() },
                ],
              })
            }
          >
            排除此行
          </button>
        </div>
        {(config.exclusions ?? []).map((item) => (
          <div className="score-actions" key={item.row}>
            <span>
              第 {item.row} 行：{item.reason}
            </span>
            <button
              type="button"
              className="icon-button"
              title={`取消排除第 ${item.row} 行`}
              aria-label={`取消排除第 ${item.row} 行`}
              onClick={() =>
                change({
                  ...config,
                  exclusions: config.exclusions?.filter((value) => value.row !== item.row),
                })
              }
            >
              <Trash2 size={16} />
            </button>
          </div>
        ))}
      </details>
      {preview.differences && (
        <section className="score-section" aria-label="版本差异">
          <h3>版本差异 · {preview.differences.scores.length} 项分数变化</h3>
          {preview.differences.configuration
            .slice(configPage * 20, configPage * 20 + 20)
            .map((difference) => {
              const display = configurationDifference(difference, draft);
              return (
                <p key={difference.key}>
                  {display.label}：{display.before} → {display.after}
                </p>
              );
            })}
          <div className="score-actions">
            <button
              type="button"
              disabled={configPage === 0}
              onClick={() => setConfigurationPage(configPage - 1)}
            >
              上一页配置变化
            </button>
            <span>
              {configPage + 1} /{' '}
              {Math.max(1, Math.ceil(preview.differences.configuration.length / 20))}
            </span>
            <button
              type="button"
              disabled={(configPage + 1) * 20 >= preview.differences.configuration.length}
              onClick={() => setConfigurationPage(configPage + 1)}
            >
              下一页配置变化
            </button>
          </div>
          <div className="score-table-scroll">
            <table>
              <thead>
                <tr>
                  <th>学生</th>
                  <th>科目</th>
                  <th>原值</th>
                  <th>新值</th>
                </tr>
              </thead>
              <tbody>
                {preview.differences.scores
                  .slice(diffPage * 20, diffPage * 20 + 20)
                  .map((difference) => (
                    <tr key={`${difference.studentId}:${difference.subjectId}`}>
                      <td>{names.get(difference.studentId)}</td>
                      <td>{subjectName(difference.subjectId)}</td>
                      <td>{scoreText(difference.before)}</td>
                      <td>{scoreText(difference.after)}</td>
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
          <div className="score-actions">
            <button
              type="button"
              disabled={diffPage === 0}
              onClick={() => setDifferencePage(diffPage - 1)}
            >
              上一页差异
            </button>
            <span>
              {diffPage + 1} / {Math.max(1, Math.ceil(preview.differences.scores.length / 20))}
            </span>
            <button
              type="button"
              disabled={(diffPage + 1) * 20 >= preview.differences.scores.length}
              onClick={() => setDifferencePage(diffPage + 1)}
            >
              下一页差异
            </button>
          </div>
        </section>
      )}
    </section>
  );
}
