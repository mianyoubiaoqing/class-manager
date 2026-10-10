import { profileFieldLabels, type StudentProfile } from '../shared/pupils';

export function ImportedProfileDetails({
  profile,
}: {
  profile?: Partial<StudentProfile['content']>;
}) {
  const entries = Object.entries(profile ?? {}).filter(([, value]) => value !== '');
  if (!entries.length) return <span>—</span>;
  const readable: Record<string, string> = {
    male: '男',
    female: '女',
    other: '其他',
    unspecified: '未填写',
    yes: '是',
    no: '否',
  };
  return (
    <details>
      <summary>核对 {entries.length} 项资料</summary>
      <dl>
        {entries.map(([key, value]) => (
          <div key={key}>
            <dt>{profileFieldLabels[key as keyof StudentProfile['content']]}</dt>
            <dd>{readable[value] ?? value}</dd>
          </div>
        ))}
      </dl>
    </details>
  );
}
