import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, 'data');

function loadJson(filename) {
  try {
    return JSON.parse(readFileSync(join(DATA_DIR, filename), 'utf8'));
  } catch {
    return [];
  }
}

export const styles = loadJson('styles.json');
export const colors = loadJson('colors.json');
export const uxRules = loadJson('ux-rules.json');

/**
 * 快速关键词相似度检索
 */
export function searchStyles(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return styles;

  return styles
    .map((item) => {
      let score = 0;
      const haystack =
        `${item.id} ${item.name} ${item.keywords.join(' ')} ${item.bestFor}`.toLowerCase();
      terms.forEach((term) => {
        if (haystack.includes(term)) score += 2;
      });
      return { item, score };
    })
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.item);
}

export function searchUx(query) {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return uxRules;

  return uxRules.filter((r) => {
    const haystack = `${r.topic} ${r.rule} ${r.do} ${r.dont}`.toLowerCase();
    return terms.some((t) => haystack.includes(t));
  });
}
