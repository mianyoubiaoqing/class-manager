/** Rules for outbound facts, not local editing. Keep teaching measurements and ordinary
 * learning difficulties; mask explicit family, financial and clinical descriptions.
 * This is a bounded lexical safeguard, not a guarantee of semantic anonymity. */
export function redactSensitiveFacts(text: string): string {
  return text
    .replace(
      /(?:父母|家长|父亲|母亲|爸爸|妈妈)\s*(?:离异|离婚|分居|去世|失业|服刑|坐牢)|单亲(?:家庭)?|留守(?:儿童|学生)/gu,
      '[家庭状况已隐藏]',
    )
    .replace(
      /(?:家庭|家境|经济)\s*(?:贫困|困难|拮据)|低保(?:户)?|贫困(?:家庭|户)?|助学(?:补助|贷款)|家庭(?:负债|债务)/gu,
      '[经济状况已隐藏]',
    )
    .replace(
      /抑郁(?:症)?|焦虑症|心理(?:问题|障碍|疾病|辅导|咨询)|自残|自杀|精神(?:疾病|障碍)|残疾|智力障碍|艾滋(?:病)?|HIV(?:阳性)?/giu,
      '[健康状况已隐藏]',
    )
    .replace(
      /\b(?:parents?\s+(?:divorced|separated|unemployed)|single[- ]parent\s+family|low[- ]income\s+family|clinical\s+depression|self[- ]harm|suicidal(?:\s+ideation)?)\b/giu,
      '[敏感状况已隐藏]',
    );
}
