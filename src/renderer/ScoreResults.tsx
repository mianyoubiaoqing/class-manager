import { useState } from 'react';
import type { ScoreAnalysisInput, ScoreStatistics, ScoreSubject } from '../shared/scores';
import { scoreText, type ExamDraft } from './score-editor';

export function ScoreResults({
  statistics,
  subjects,
  groups,
  roster,
  entries,
}: {
  statistics: ScoreStatistics;
  subjects: ScoreSubject[];
  groups: Array<{ id: string; name: string }>;
  roster: ExamDraft['roster'];
  entries: ScoreAnalysisInput['entries'];
}) {
  const [page, setPage] = useState(0);
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const selected =
    statistics.subjects.find((item) => item.subjectId === subjectId) ?? statistics.subjects[0];
  const currentPage = Math.min(page, Math.max(0, Math.ceil(statistics.totals.length / 20) - 1));
  const names = new Map(
    roster.map((student) => [student.studentId, `${student.studentNumber} ${student.displayName}`]),
  );
  const values = new Map(
    entries.map((entry) => [`${entry.studentId}:${entry.subjectId}`, entry.score]),
  );
  return (
    <section className="score-section" aria-label="成绩统计">
      <h2>成绩统计</h2>
      <div className="score-table-scroll">
        <table>
          <thead>
            <tr>
              <th>科目</th>
              <th>满分</th>
              <th>应考</th>
              <th>有效</th>
              <th>缺考</th>
              <th>未录入</th>
              <th>未选考</th>
              <th>均分</th>
              <th>中位数</th>
              <th>最低 / 最高</th>
              <th>目标线 / 达标人数 / 有效人数</th>
            </tr>
          </thead>
          <tbody>
            {statistics.subjects.map((item) => (
              <tr key={item.subjectId}>
                <th>{subjects.find((subject) => subject.id === item.subjectId)?.name}</th>
                <td>{subjects.find((subject) => subject.id === item.subjectId)?.maxScore}</td>
                <td>{item.expectedCount}</td>
                <td>{item.validCount}</td>
                <td>{item.absentCount}</td>
                <td>{item.missingCount}</td>
                <td>{item.notSelectedCount}</td>
                <td>{item.mean ?? '不适用'}</td>
                <td>{item.median ?? '不适用'}</td>
                <td>
                  {item.minimum ?? '不适用'} / {item.maximum ?? '不适用'}
                </td>
                <td>
                  {item.target
                    ? `目标 ≥ ${item.target.score} 分；${item.target.metCount}/${item.target.denominator}（${item.target.ratePercent ?? '不适用'}${item.target.ratePercent === null ? '' : '%'}）`
                    : '未设置'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <label>
        分布科目
        <select
          aria-label="分布科目"
          value={selected?.subjectId ?? ''}
          onChange={(event) => {
            setSubjectId(event.target.value);
            setPage(0);
          }}
        >
          {subjects.map((subject) => (
            <option key={subject.id} value={subject.id}>
              {subject.name}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <div className="score-distribution" aria-label="有效成绩得分率分布">
          {selected.distribution.map((bucket) => (
            <div key={bucket.lowerPercent}>
              <span>
                {bucket.lowerPercent}%–{bucket.upperPercent}%
                {bucket.upperInclusive ? '（含上界）' : '（不含上界）'}
              </span>
              <meter
                min="0"
                max={Math.max(1, selected.validCount)}
                value={bucket.count}
                aria-label={`${bucket.lowerPercent}至${bucket.upperPercent}百分比人数`}
              />
              <strong>{bucket.count} 人</strong>
            </div>
          ))}
        </div>
      )}
      <div className="score-table-scroll">
        <table>
          <thead>
            <tr>
              <th>计分组</th>
              <th>满分</th>
              <th>完整 / 不完整</th>
              <th>总分均分</th>
              <th>中位数</th>
              <th>最低 / 最高</th>
            </tr>
          </thead>
          <tbody>
            {statistics.groups.map((group) => (
              <tr key={group.groupId}>
                <th>{groups.find((item) => item.id === group.groupId)?.name}</th>
                <td>{group.fullScore}</td>
                <td>
                  {group.completeCount} / {group.incompleteCount}
                </td>
                <td>{group.mean ?? '不适用'}</td>
                <td>{group.median ?? '不适用'}</td>
                <td>
                  {group.minimum ?? '不适用'} / {group.maximum ?? '不适用'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="score-table-scroll">
        <table>
          <thead>
            <tr>
              <th>学生</th>
              <th>计分组</th>
              {subjects.map((subject) => (
                <th key={subject.id}>{subject.name}</th>
              ))}
              <th>总分</th>
              <th>缺口科目</th>
              <th>组内总分排名</th>
              <th>所选科目排名</th>
            </tr>
          </thead>
          <tbody>
            {statistics.totals.slice(currentPage * 20, currentPage * 20 + 20).map((total) => (
              <tr key={total.studentId}>
                <td>{names.get(total.studentId)}</td>
                <td>{groups.find((group) => group.id === total.groupId)?.name}</td>
                {subjects.map((subject) => (
                  <td key={subject.id}>
                    {scoreText(
                      values.get(`${total.studentId}:${subject.id}`) ?? { status: 'missing' },
                    )}
                  </td>
                ))}
                <td>{total.score ?? '不完整'}</td>
                <td>
                  {total.incompleteSubjectIds
                    .map((id) => subjects.find((subject) => subject.id === id)?.name)
                    .join('、') || '无'}
                </td>
                <td>{total.rank ?? '不适用'}</td>
                <td>
                  {selected?.ranks?.find((rank) => rank.studentId === total.studentId)?.rank ??
                    '不适用'}
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
          {currentPage + 1} / {Math.max(1, Math.ceil(statistics.totals.length / 20))}
        </span>
        <button
          type="button"
          disabled={(currentPage + 1) * 20 >= statistics.totals.length}
          onClick={() => setPage(currentPage + 1)}
        >
          下一页
        </button>
      </div>
    </section>
  );
}
