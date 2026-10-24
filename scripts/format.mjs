// Keep Prettier's discovery/configuration while avoiding truncate writes to mapped Windows files.
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';

const cli = fileURLToPath(import.meta.resolve('prettier/bin/prettier.cjs'));
export async function formatProject(directory) {
  const root = fs.realpathSync(directory);
  const result = spawnSync(process.execPath, [cli, '.', '--list-different'], {
    cwd: root,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  if (![0, 1].includes(result.status))
    throw new Error(result.stderr.trim() || 'Prettier could not inspect the source tree.');
  const pending = result.stdout.split(/\r?\n/).filter(Boolean);
  const temporary = path.join(root, '.paqvilo', 'format');
  fs.mkdirSync(temporary, { recursive: true });
  for (const name of pending) {
    const target = path.resolve(root, name);
    const relative = path.relative(root, fs.realpathSync(target));
    if (
      relative === '..' ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative) ||
      fs.lstatSync(target).isSymbolicLink()
    ) {
      throw new Error(`Refusing to format a source link outside this checkout: ${name}`);
    }
    const config = await prettier.resolveConfig(target, { editorconfig: true });
    const formatted = await prettier.format(fs.readFileSync(target, 'utf8'), { ...config, filepath: target });
    const staging = path.join(temporary, `${randomUUID()}.tmp`);
    try {
      fs.writeFileSync(staging, formatted, { mode: fs.statSync(target).mode });
      // Creation permissions are masked by umask; replacement keeps the source mode exactly.
      fs.chmodSync(staging, fs.statSync(target).mode);
      fs.renameSync(staging, target);
    } finally {
      fs.rmSync(staging, { force: true });
    }
  }
  return pending.length;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const count = await formatProject(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
  console.log(`Prettier formatted ${count} file${count === 1 ? '' : 's'}.`);
}
