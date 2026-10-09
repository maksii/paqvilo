// Check first-party JavaScript without executing it, portal traffic, or extra lint dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [];
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['fixtures', 'node_modules', 'test', 'test-browser'].includes(entry.name)) continue;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(file);
    else if (/\.(?:mjs|js)$/.test(entry.name)) files.push(file);
  }
}
for (const dir of ['bin', 'lense', 'scripts', 'test', 'test-browser', 'mirage', 'examples']) walk(path.join(root, dir));
let failed = false;
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8', windowsHide: true, timeout: 10_000 });
  if (result.status !== 0) {
    failed = true;
    console.error(`${path.relative(root, file)}: ${result.error?.message ?? result.stderr}`);
  }
}
console.log(`Syntax checked ${files.length} JavaScript modules.`);
process.exitCode = failed ? 1 : 0;
