import { isEntryPoint } from '../lense/entry-point.mjs';
import fs from 'node:fs';

// Conventional Commits permits types beyond feat/fix. Keep the type open to contributors.
export function validateCommitMessage(message) {
  const lines = message.replaceAll('\r\n', '\n').split('\n');
  if (!/^[a-z][a-z0-9-]*(?:\([^()\r\n]+\))?!?: \S.*$/.test(lines[0] ?? ''))
    throw new Error('Use <type>[optional scope][!]: <description>, e.g. fix(lense): preserve source identity');
  if (lines.length > 1 && lines[1].trim())
    throw new Error('Separate the subject from the body/footer with a blank line.');
}

if (isEntryPoint(import.meta.url)) {
  const flag = process.argv[2];
  if (flag === '--help' || flag === '-h') {
    console.log(`Usage: node scripts/conventional-commit.mjs --file <commit-message-file> | --title
  --file <path>   check the commit message in <path> (the commit-msg hook)
  --title         check the pull request title in the PR_TITLE environment variable
  --help          print this help`);
    process.exit(0);
  }
  try {
    if (flag !== '--file' && flag !== '--title')
      throw new Error(
        (flag ? `Unknown option ${flag}; use` : 'Use') +
          ' --file <commit-message-file> or --title with PR_TITLE (see --help).',
      );
    if (flag === '--file' && !process.argv[3]) throw new Error('--file needs the path of a commit message file.');
    const extra = process.argv[flag === '--file' ? 4 : 3];
    if (extra !== undefined)
      throw new Error(
        `Unexpected argument ${extra}; ${flag} takes ${flag === '--file' ? 'one path' : 'no value'} (see --help).`,
      );
    if (flag === '--title' && !process.env.PR_TITLE)
      throw new Error('--title checks the PR_TITLE environment variable, which is not set.');
    let message = process.env.PR_TITLE;
    if (flag === '--file') {
      try {
        message = fs.readFileSync(process.argv[3], 'utf8');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        throw new Error(`--file ${process.argv[3]}: file not found.`, { cause: error });
      }
    }
    validateCommitMessage(message ?? '');
  } catch (error) {
    console.error(`Commit message rejected: ${error.message}`);
    process.exitCode = 1;
  }
}
