import type { ExplanationPacket } from '../shared/score-explanation';

export function ExplanationFacts({ packet }: { packet: ExplanationPacket }) {
  return (
    <div className="score-table-scroll explanation-facts">
      <table>
        <thead>
          <tr>
            <th>依据</th>
            <th>科目代号 / 本地科目</th>
            <th>指标</th>
            <th>本地数值</th>
          </tr>
        </thead>
        <tbody>
          {packet.facts.map((fact) => (
            <tr key={fact.id}>
              <th>{fact.id}</th>
              <td>
                {fact.subject} / {fact.subjectName}
              </td>
              <td>{fact.label}</td>
              <td>
                {fact.value === null
                  ? '不适用 / 无有效数据'
                  : `${fact.value}${fact.unit ? ` ${fact.unit}` : ''}`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
