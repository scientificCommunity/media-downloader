import ts from 'typescript';
import { mkdtemp, readFile, writeFile, mkdir, readdir, rm } from 'node:fs/promises';
import { resolve, join, relative, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const temporary = await mkdtemp(join(root, '.test-build-'));
async function compile(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const source = join(directory, entry.name);
    if (entry.isDirectory()) await compile(source);
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.d.ts')) {
      const target = join(temporary, relative(root, source)).replace(/\.ts$/, '.js');
      await mkdir(dirname(target), { recursive: true });
      const result = ts.transpileModule(await readFile(source, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true }
      });
      await writeFile(target, result.outputText);
    }
  }
}
try {
  await writeFile(join(temporary, 'package.json'), '{"type":"commonjs"}');
  await compile(join(root, 'src'));
  const suffix = process.argv.includes('--media') ? '.media.cjs' : '.test.cjs';
  const tests = (await readdir(join(root, 'tests'))).filter((name) => name.endsWith(suffix)).sort();
  if (!tests.length) throw new Error('No tests found.');
  const result = spawnSync(process.execPath, ['--test', ...tests.map((name) => join(root, 'tests', name))], {
    cwd: root, env: { ...process.env, TEST_BUILD_DIR: temporary }, stdio: 'inherit'
  });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally { await rm(temporary, { recursive: true, force: true }); }
