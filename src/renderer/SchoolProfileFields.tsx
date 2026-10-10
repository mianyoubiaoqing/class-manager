import { profileFieldLabels, type StudentProfile } from '../shared/pupils';

const fields = [
  'birthMonth',
  'idCard',
  'studentRegistration',
  'examRegistration',
  'applicationNumber',
  'studentPhone',
  'fatherName',
  'fatherIdCard',
  'fatherPhone',
  'motherName',
  'motherIdCard',
  'motherPhone',
  'povertyStatus',
] as const;
export function SchoolProfileFields({
  content,
  disabled,
  onChange,
}: {
  content: StudentProfile['content'];
  disabled: boolean;
  onChange: (key: keyof StudentProfile['content'], value: string) => void;
}) {
  return (
    <>
      {fields.map((key) => (
        <label key={key}>
          {profileFieldLabels[key]}
          <input
            aria-label={profileFieldLabels[key]}
            value={content[key]}
            disabled={disabled}
            type={key === 'birthMonth' ? 'month' : /Phone$/.test(key) ? 'tel' : 'text'}
            maxLength={
              /IdCard$|^idCard$/.test(key)
                ? 18
                : /Name$/.test(key)
                  ? 80
                  : key === 'povertyStatus'
                    ? 300
                    : 40
            }
            pattern={/IdCard$|^idCard$/.test(key) ? '[0-9]{17}[0-9Xx]' : undefined}
            onChange={(e) => onChange(key, e.target.value)}
          />
        </label>
      ))}
      <label>
        是否住校
        <select
          aria-label="是否住校"
          value={content.boarding}
          disabled={disabled}
          onChange={(e) => onChange('boarding', e.target.value)}
        >
          <option value="unspecified">未填写</option>
          <option value="yes">是</option>
          <option value="no">否</option>
        </select>
      </label>
    </>
  );
}
