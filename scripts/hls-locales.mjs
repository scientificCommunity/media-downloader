import { readFile } from 'node:fs/promises';
const additions = JSON.parse(await readFile(new URL('../locales/hls-encryption.json', import.meta.url), 'utf8'));
const locales = ['en', 'ja', 'zh_CN', 'zh_TW'];
export function mergeHlsMessages(locale, base) {
  if (!locales.includes(locale)) throw new Error(`Unknown locale: ${locale}`);
  const merged = { ...base };
  for (const [key, translations] of Object.entries(additions)) {
    if (JSON.stringify(Object.keys(translations).sort()) !== JSON.stringify([...locales].sort())) throw new Error(`HLS translation key mismatch: ${key}`);
    const message = translations[locale];
    if (typeof message !== 'string' || !message.trim()) throw new Error(`Missing HLS translation: ${locale}/${key}`);
    const value = { message };
    if (message.includes('$STATUS$')) value.placeholders = { status: { content: '$1' } };
    if (key in merged && JSON.stringify(merged[key]) !== JSON.stringify(value)) throw new Error(`Duplicate locale key: ${locale}/${key}`);
    merged[key] = value;
  }
  return merged;
}
