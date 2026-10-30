// Check first-party JavaScript without executing it, portal traffic, or extra lint dependencies.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import { execFile } from 'node:child_process';

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
// One `node --check` per file keeps Node's own format detection; run them on every core, report in file order.
const check = (file) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      ['--check', file],
      { encoding: 'utf8', windowsHide: true, timeout: 10_000 },
      (error, _, stderr) =>
        resolve(
          error
            ? `${path.relative(root, file)}: ${typeof error.code === 'string' || error.killed ? error.message : stderr}`
            : null,
        ),
    );
  });
const errors = new Array(files.length);
let next = 0;
await Promise.all(
  Array.from({ length: Math.min(os.availableParallelism(), files.length) }, async () => {
    while (next < files.length) {
      const index = next++;
      errors[index] = await check(files[index]);
    }
  }),
);
const failed = errors.some(Boolean);
for (const error of errors) if (error) console.error(error);
console.log(`Syntax checked ${files.length} JavaScript modules.`);
process.exitCode = failed ? 1 : 0;
