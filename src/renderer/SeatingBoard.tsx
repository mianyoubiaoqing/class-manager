import { Ban, LockKeyhole } from 'lucide-react';
import type { SeatingDraft, SeatPosition } from '../shared/seating';
import { seatKey } from '../shared/seating';

/** Display only: moves, locks and layout changes are validated by the workspace worker. */
export function SeatingBoard({
  draft,
  selectedStudentId,
  disabled,
  onSeat,
}: {
  draft: SeatingDraft;
  selectedStudentId?: string;
  disabled: boolean;
  onSeat?: (position: SeatPosition) => void;
}) {
  const members = new Map(draft.members.map((member) => [member.studentId, member]));
  const assigned = new Map(draft.assignments.map((item) => [seatKey(item), item.studentId]));
  const unavailable = new Set(draft.layout.unavailable.map(seatKey));
  const locked = new Set(draft.lockedStudentIds);
  // All cells share a height derived from immutable roster labels, not from the current occupant.
  // This keeps moves stable while allowing long names/numbers to wrap without truncation.
  const cellHeight = Math.max(
    96,
    ...draft.members.map(
      (member) =>
        60 +
        Math.ceil(member.displayName.length / 9) * 17 +
        Math.ceil(member.studentNumber.length / 18) * 14,
    ),
  );
  return (
    <div className="seating-board-scroll" tabIndex={0} aria-label="座位图">
      <div className="seating-front">讲台 · 教室前方</div>
      <div className="seating-board" style={{ width: draft.layout.columns * 156 - 8 }}>
        <div
          className="seating-grid"
          style={{
            gridTemplateColumns: `repeat(${draft.layout.columns}, 148px)`,
            gridAutoRows: cellHeight,
          }}
        >
          {Array.from({ length: draft.layout.rows * draft.layout.columns }, (_, index) => {
            const position = {
              row: Math.floor(index / draft.layout.columns) + 1,
              column: (index % draft.layout.columns) + 1,
            };
            const key = seatKey(position);
            const studentId = assigned.get(key);
            const member = studentId ? members.get(studentId) : undefined;
            const blocked = unavailable.has(key);
            const label = `${position.row}排${position.column}列`;
            return (
              <button
                key={key}
                type="button"
                className={`seating-cell ${blocked ? 'unavailable' : ''} ${studentId && studentId === selectedStudentId ? 'selected' : ''}`}
                disabled={disabled || !onSeat}
                aria-label={`${label} ${blocked ? '不可用' : member ? `${member.displayName} ${member.studentNumber}` : '空位'}${studentId && locked.has(studentId) ? ' 已锁定' : ''}`}
                aria-pressed={Boolean(studentId && studentId === selectedStudentId)}
                onClick={() => onSeat?.(position)}
                data-seat={key}
              >
                <span className="seating-position">
                  {label}
                  {studentId && locked.has(studentId) && <LockKeyhole size={14} />}
                  {blocked && <Ban size={14} />}
                </span>
                <strong>{blocked ? '不可用' : (member?.displayName ?? '空位')}</strong>
                {member && <small>{member.studentNumber}</small>}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}
