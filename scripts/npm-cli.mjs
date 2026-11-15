import fs from 'node:fs';
import path from 'node:path';

// Windows installs npm beside node.exe; POSIX installs keep it under the prefix's lib directory.
export function npmCliPath(execPath = process.execPath, env = process.env) {
  if (env.npm_execpath) return env.npm_execpath;
  const directory = path.dirname(execPath);
  const candidates = [
    path.join(directory, 'node_modules/npm/bin/npm-cli.js'),
    path.join(directory, '../lib/node_modules/npm/bin/npm-cli.js'),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0];
}
