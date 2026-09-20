/**
 * Reports translation keys that components ask for but no locale defines.
 *
 * A missing key does not crash — I18nProvider falls back to English and then
 * to the last path segment — which is exactly why it needs a checker: the
 * failure mode is a screen that quietly says "addSale" instead of "Add sale".
 *
 *   node scripts/check-i18n.mjs          list missing keys
 *   node scripts/check-i18n.mjs --unused also list keys nothing references
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC = 'src';
const LOCALES = 'src/locales';

function walk(dir) {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

function flatten(object, prefix = '') {
  return Object.entries(object).flatMap(([key, value]) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? flatten(value, `${prefix}${key}.`)
      : [`${prefix}${key}`],
  );
}

const sources = walk(SRC).filter((file) => /\.tsx?$/.test(file));

// t('a.b') and t("a.b") — template literals are dynamic and cannot be checked.
const used = new Set();
for (const file of sources) {
  const text = readFileSync(file, 'utf8');
  for (const match of text.matchAll(/\bt\(\s*['"]([a-zA-Z0-9_.]+)['"]/g)) {
    used.add(match[1]);
  }
}

const english = new Set(flatten(JSON.parse(readFileSync(join(LOCALES, 'en.json'), 'utf8'))));

const missing = [...used].filter((key) => !english.has(key)).sort();
if (missing.length > 0) {
  console.error(`\n  ${missing.length} key(s) used but not defined in en.json:\n`);
  for (const key of missing) console.error(`    ${key}`);
  console.error('');
}

if (process.argv.includes('--unused')) {
  const unused = [...english].filter((key) => !used.has(key)).sort();
  console.log(`\n  ${unused.length} key(s) defined but never referenced:\n`);
  for (const key of unused) console.log(`    ${key}`);
  console.log('');
}

// Coverage of the other languages, so a half-translated locale is visible.
for (const file of readdirSync(LOCALES).filter((name) => name.endsWith('.json') && name !== 'en.json')) {
  const keys = new Set(flatten(JSON.parse(readFileSync(join(LOCALES, file), 'utf8'))));
  const absent = [...english].filter((key) => !keys.has(key)).length;
  const pct = Math.round(((english.size - absent) / english.size) * 100);
  console.log(`  ${file.replace('.json', '').padEnd(4)} ${String(pct).padStart(3)}%  (${absent} missing)`);
}

process.exit(missing.length > 0 ? 1 : 0);
