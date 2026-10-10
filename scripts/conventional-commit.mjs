import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Conventional Commits permits types beyond feat/fix. Keep the type open to contributors.
export function validateCommitMessage(message) {
  const lines = message.replace(/\r\n/g, '\n').split('\n');
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S.*$/.test(lines[0] ?? ''))
    throw new Error('Use <type>[optional scope][!]: <description>, e.g. fix(lense): preserve source identity');
  if (lines.length > 1 && lines[1].trim()) throw new Error('Separate the subject from the body/footer with a blank line.');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const flag = process.argv[2];
    const message = flag === '--file' ? fs.readFileSync(process.argv[3], 'utf8') : process.env.PR_TITLE;
    if (flag !== '--file' && flag !== '--title') throw new Error('Use --file <commit-message-file> or --title with PR_TITLE.');
    validateCommitMessage(message ?? '');
  } catch (error) { console.error(`Commit message rejected: ${error.message}`); process.exitCode = 1; }
}
