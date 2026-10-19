import { readFile, writeFile } from 'node:fs/promises';
import { mergeHlsMessages } from './hls-locales.mjs';
for (const locale of ['en', 'ja', 'zh_CN', 'zh_TW']) {
  const file = new URL(`../dist/_locales/${locale}/messages.json`, import.meta.url);
  const merged = mergeHlsMessages(locale, JSON.parse(await readFile(file, 'utf8')));
  await writeFile(file, JSON.stringify(merged, null, 2) + '\n');
}
console.log('Bundled HLS messages into all four native Chrome locales.');
