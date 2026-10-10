import type { ReactNode } from 'react';
import type { StudentProfile } from '../shared/pupils';
import {
  schoolRosterHeaders,
  schoolRosterUniqueHeaders,
  schoolRosterValues,
} from '../shared/roster-fields';

export function SchoolRosterHeaders() {
  return schoolRosterHeaders.map((header, index) => (
    <th key={index} scope="col" aria-label={schoolRosterUniqueHeaders[index]}>
      {header}
    </th>
  ));
}

export function SchoolRosterCells({
  studentNumber,
  displayName,
  profile,
  name,
}: {
  studentNumber: string;
  displayName: string;
  profile?: Partial<StudentProfile['content']>;
  name?: ReactNode;
}) {
  return schoolRosterValues(studentNumber, displayName, profile).map((value, index) => (
    <td key={index}>{index === 1 && name ? name : value || '—'}</td>
  ));
}
