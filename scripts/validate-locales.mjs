import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(process.cwd(), 'public', '_locales');
const requiredLocales = ['en', 'ja', 'zh_CN', 'zh_TW'];

function keySet(messages) {
  return new Set(Object.keys(messages));
}

function difference(left, right) {
  return [...left].filter((key) => !right.has(key));
}

const existingLocales = new Set(await readdir(root));
for (const locale of requiredLocales) {
  if (!existingLocales.has(locale)) {
    throw new Error(`Missing locale directory: ${locale}`);
  }
}

const parsed = new Map();
for (const locale of requiredLocales) {
  const file = resolve(root, locale, 'messages.json');
  const messages = JSON.parse(await readFile(file, 'utf8'));

  for (const [key, entry] of Object.entries(messages)) {
    if (!entry || typeof entry !== 'object' || typeof entry.message !== 'string' || entry.message.trim() === '') {
      throw new Error(`Locale ${locale} has an invalid message for key: ${key}`);
    }
  }

  parsed.set(locale, messages);
}

const baseline = keySet(parsed.get('en'));
for (const locale of requiredLocales.filter((locale) => locale !== 'en')) {
  const current = keySet(parsed.get(locale));
  const missing = difference(baseline, current);
  const extra = difference(current, baseline);

  if (missing.length || extra.length) {
    throw new Error([
      `Locale key mismatch for ${locale}.`,
      missing.length ? `Missing: ${missing.join(', ')}` : '',
      extra.length ? `Extra: ${extra.join(', ')}` : ''
    ].filter(Boolean).join(' '));
  }
}

console.log(`Validated ${requiredLocales.length} locales with ${baseline.size} messages each.`);
