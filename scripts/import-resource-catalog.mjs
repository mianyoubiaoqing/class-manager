// Read literal customer catalogue data without evaluating supplied JavaScript.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import ts from 'typescript';
const bytes = readFileSync(process.argv[2]);
const zip = await JSZip.loadAsync(bytes);
const source = async (suffix) => {
  const file = Object.values(zip.files).find((f) => f.name.endsWith(suffix));
  if (!file) throw Error('Missing ' + suffix);
  return ts.createSourceFile(
    suffix,
    await file.async('string'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.JS,
  );
};
const bindings = new Map();
const mkBook = ([code, title, grade, units = []]) => ({
  code,
  title,
  grade,
  units: units.map(([title, lessons]) => ({
    title,
    lessons: lessons.map(([title, sections]) => ({
      title,
      sections: sections.map((title) => ({ title, text: '', points: [] })),
    })),
  })),
});
function literal(n) {
  if (ts.isStringLiteral(n) || ts.isNumericLiteral(n))
    return ts.isStringLiteral(n) ? n.text : Number(n.text);
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(literal);
  if (ts.isObjectLiteralExpression(n))
    return Object.fromEntries(
      n.properties.map((p) => {
        if (!ts.isPropertyAssignment(p)) throw Error('Unsupported property');
        return [p.name.text, literal(p.initializer)];
      }),
    );
  if (ts.isIdentifier(n) && bindings.has(n.text)) return structuredClone(bindings.get(n.text));
  if (ts.isConditionalExpression(n) && n.condition.getText() === 'window.TB')
    return literal(n.whenTrue);
  if (ts.isPropertyAccessExpression(n) && n.getText() === 'window.TB.books')
    return structuredClone(bindings.get('books'));
  if (ts.isCallExpression(n)) {
    if (
      ts.isPropertyAccessExpression(n.expression) &&
      n.expression.name.text === 'map' &&
      n.arguments[0]?.getText() === 'mkBook'
    )
      return literal(n.expression.expression).map(mkBook);
    if (n.expression.getText() === 'reuseBooks') {
      const [books, codes, grade] = n.arguments.map(literal);
      return codes.map(([code, title], i) =>
        books[i]
          ? { ...books[i], code, title, grade: grade || books[i].grade }
          : mkBook([
              code,
              title,
              grade || '高中',
              [['本册内容（待补充）', [['示例课', ['要点一', '要点二']]]]],
            ]),
      );
    }
  }
  throw Error('Unsupported catalogue expression: ' + n.getText().slice(0, 80));
}
function collect(tree, predicate) {
  const visit = (n) => {
    if (
      ts.isVariableDeclaration(n) &&
      ts.isIdentifier(n.name) &&
      n.initializer &&
      predicate(n.name.text)
    )
      bindings.set(n.name.text, literal(n.initializer));
    ts.forEachChild(n, visit);
  };
  visit(tree);
}
collect(await source('/data.js'), (name) => name === 'books');
collect(await source('/subjects.js'), (name) => /_TB$/.test(name) || name === 'SUBJECTS');
const subjects = bindings.get('SUBJECTS');
for (const sj of subjects)
  for (const v of sj.versions) {
    v.sharedOutline = v !== sj.versions[0];
    v.books.forEach((b, i) => {
      b.id = 'b' + i;
    });
  }
mkdirSync('src/shared/resource-library', { recursive: true });
writeFileSync(
  'src/shared/resource-library/catalog.json',
  JSON.stringify(
    { sourceArchiveSha256: createHash('sha256').update(bytes).digest('hex'), subjects },
    null,
    2,
  ),
);
console.log(
  subjects.map((s) => ({
    subject: s.name,
    versions: s.versions.length,
    books: s.versions[0].books.length,
  })),
);
