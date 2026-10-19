import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { mergeHlsMessages } from './hls-locales.mjs';
const root = resolve(process.cwd(), 'public', '_locales');
const requiredLocales = ['en', 'ja', 'zh_CN', 'zh_TW'];
const existingLocales = new Set(await readdir(root));
const parsed = new Map();
for (const locale of requiredLocales) {
  if (!existingLocales.has(locale)) throw new Error(`Missing locale directory: ${locale}`);
  const messages = mergeHlsMessages(locale, JSON.parse(await readFile(resolve(root, locale, 'messages.json'), 'utf8')));
  for (const [key, entry] of Object.entries(messages)) {
    if (!entry || typeof entry !== 'object' || typeof entry.message !== 'string' || entry.message.trim() === '') throw new Error(`Invalid message: ${locale}/${key}`);
  }
  parsed.set(locale, messages);
}
const baseline = Object.keys(parsed.get('en')).sort();
for (const locale of requiredLocales.slice(1)) {
  const current = parsed.get(locale);
  if (JSON.stringify(Object.keys(current).sort()) !== JSON.stringify(baseline)) throw new Error(`Locale key mismatch for ${locale}`);
  for (const key of baseline) {
    const placeholders = (entry) => JSON.stringify(Object.entries(entry.placeholders ?? {}).map(([name, value]) => [name, value.content]).sort());
    if (placeholders(current[key]) !== placeholders(parsed.get('en')[key])) throw new Error(`Locale placeholder mismatch: ${locale}/${key}`);
  }
}
console.log(`Validated ${requiredLocales.length} locales with ${baseline.length} messages each.`);
