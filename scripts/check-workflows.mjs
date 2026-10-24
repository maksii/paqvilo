import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadVerifiedArchive } from './verified-download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = {
  'win32-x64': {
    actionlint: [
      '1.7.12',
      'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_windows_amd64.zip',
      '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9',
      'actionlint.exe',
    ],
    shellcheck: [
      '0.11.0',
      'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.zip',
      '8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e',
      'shellcheck.exe',
    ],
  },
  'linux-x64': {
    actionlint: [
      '1.7.12',
      'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_amd64.tar.gz',
      '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      'actionlint',
    ],
    shellcheck: [
      '0.11.0',
      'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.x86_64.tar.gz',
      'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6',
      'shellcheck-v0.11.0/shellcheck',
    ],
  },
};
function execute(command, args, env = process.env) {
  const result = spawnSync(command, args, { cwd: root, env, stdio: 'inherit', windowsHide: true });
  if (result.status !== 0)
    throw new Error(`${command} failed (${result.status ?? result.error?.message}).`, { cause: result.error });
}
const digest = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function provision(name, specification) {
  const [version, url, expected, executable] = specification;
  const cache = path.resolve(process.env.PAQVILO_TOOL_CACHE ?? path.join(root, '.paqvilo/tools'));
  const directory = path.join(cache, `${name}-${version}-${process.platform}-${process.arch}`);
  const archive = path.join(directory, path.basename(url));
  const target = path.join(directory, 'unpacked', executable);
  const receipt = path.join(directory, 'verified.json');
  fs.mkdirSync(directory, { recursive: true });
  if (!fs.existsSync(archive)) {
    console.log(`Preparing ${name} ${version} from its upstream release.`);
    await downloadVerifiedArchive(url, archive, expected);
  }
  if (digest(archive) !== expected) throw new Error(`${name} archive digest mismatch.`);
  let recorded;
  try {
    recorded = JSON.parse(fs.readFileSync(receipt, 'utf8'));
  } catch {
    /* An absent receipt requires extraction. */
  }
  if (recorded?.archive !== expected || !fs.existsSync(target) || recorded.binary !== digest(target)) {
    const unpacked = path.join(directory, 'unpacked');
    fs.mkdirSync(unpacked, { recursive: true });
    if (process.platform === 'win32') {
      execute(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:PAQVILO_TOOL_ARCHIVE -DestinationPath $env:PAQVILO_TOOL_DESTINATION -Force',
        ],
        { ...process.env, PAQVILO_TOOL_ARCHIVE: archive, PAQVILO_TOOL_DESTINATION: unpacked },
      );
    } else execute('tar', ['-xzf', archive, '-C', unpacked]);
    if (!fs.existsSync(target)) throw new Error(`${name} executable missing after extraction.`);
    fs.writeFileSync(receipt, JSON.stringify({ archive: expected, binary: digest(target) }) + '\n');
  }
  return target;
}
async function main() {
  const supported = assets[`${process.platform}-${process.arch}`];
  if (!supported)
    throw new Error(
      `Pinned workflow tools are not configured for ${process.platform}-${process.arch}; use the Linux x64 validation container.`,
    );
  const actionlint = await provision('actionlint', supported.actionlint);
  const shellcheck = await provision('shellcheck', supported.shellcheck);
  execute(actionlint, ['-color', '-shellcheck', shellcheck, '-pyflakes=', '-oneline']);
  execute(shellcheck, ['--shell=sh', '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push']);
  console.log('Workflow and hook checks passed (actionlint 1.7.12, ShellCheck 0.11.0).');
}
try {
  await main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
