/**
 * Adds translation keys to every locale.
 *
 * English is the source of truth; a language that has no translation for a new
 * key gets the English string, which is what I18nProvider would have fallen
 * back to anyway — but writing it down makes the gap countable.
 *
 *   node scripts/add-keys.mjs keys.json
 *
 * The file maps a locale code to a nested object, e.g.
 *   { "en": { "home": { "today": "Today" } }, "hi": { ... } }
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES = 'src/locales';
const ALL = ['en', 'hi', 'bn', 'mr', 'ta', 'te', 'kn'];

const input = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const english = input.en ?? {};

/** Deep merge that never overwrites a translation already present. */
function merge(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      target[key] ??= {};
      merge(target[key], value);
    } else if (target[key] === undefined) {
      target[key] = value;
    }
  }
  return target;
}

for (const code of ALL) {
  const file = join(LOCALES, `${code}.json`);
  const json = JSON.parse(readFileSync(file, 'utf8'));

  // Its own translations first, then English as the backstop.
  if (input[code]) merge(json, input[code]);
  merge(json, english);

  writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`, 'utf8');
  console.log(`  ${code}.json updated`);
}
