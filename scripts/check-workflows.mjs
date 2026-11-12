import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { downloadVerifiedArchive } from './verified-download.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const assets = {
  'win32-x64': {
    actionlint: [
      '1.7.12',
      'https://api.github.com/repos/rhysd/actionlint/releases/assets/384924919',
      '6e7241b51e6817ea6a047693d8e6fed13b31819c9a0dd6c5a726e1592d22f6e9',
      'actionlint.exe',
      'actionlint_1.7.12_windows_amd64.zip',
    ],
    shellcheck: [
      '0.11.0',
      'https://api.github.com/repos/koalaman/shellcheck/releases/assets/279056944',
      '8a4e35ab0b331c85d73567b12f2a444df187f483e5079ceffa6bda1faa2e740e',
      'shellcheck.exe',
      'shellcheck-v0.11.0.zip',
    ],
  },
  'linux-x64': {
    actionlint: [
      '1.7.12',
      'https://api.github.com/repos/rhysd/actionlint/releases/assets/384924896',
      '8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8',
      'actionlint',
      'actionlint_1.7.12_linux_amd64.tar.gz',
    ],
    shellcheck: [
      '0.11.0',
      'https://api.github.com/repos/koalaman/shellcheck/releases/assets/336391469',
      'b7af85e41cc99489dcc21d66c6d5f3685138f06d34651e6d34b42ec6d54fe6f6',
      'shellcheck-v0.11.0/shellcheck',
      'shellcheck-v0.11.0.linux.x86_64.tar.gz',
    ],
  },
  'linux-arm64': {
    actionlint: [
      '1.7.12',
      'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_linux_arm64.tar.gz',
      '325e971b6ba9bfa504672e29be93c24981eeb1c07576d730e9f7c8805afff0c6',
      'actionlint',
      'actionlint_1.7.12_linux_arm64.tar.gz',
    ],
    shellcheck: [
      '0.11.0',
      'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.linux.aarch64.tar.gz',
      '68a8133197a50beb8803f8d42f9908d1af1c5540d4bb05fdfca8c1fa47decefc',
      'shellcheck-v0.11.0/shellcheck',
      'shellcheck-v0.11.0.linux.aarch64.tar.gz',
    ],
  },
  'darwin-x64': {
    actionlint: [
      '1.7.12',
      'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_amd64.tar.gz',
      '5b44c3bc2255115c9b69e30efc0fecdf498fdb63c5d58e17084fd5f16324c644',
      'actionlint',
      'actionlint_1.7.12_darwin_amd64.tar.gz',
    ],
    shellcheck: [
      '0.11.0',
      'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.darwin.x86_64.tar.gz',
      'c2c15e08df0e8fbc374c335b230a7ee958c313fa5714817a59aa59f1aa594f51',
      'shellcheck-v0.11.0/shellcheck',
      'shellcheck-v0.11.0.darwin.x86_64.tar.gz',
    ],
  },
  'darwin-arm64': {
    actionlint: [
      '1.7.12',
      'https://github.com/rhysd/actionlint/releases/download/v1.7.12/actionlint_1.7.12_darwin_arm64.tar.gz',
      'aba9ced2dee8d27fecca3dc7feb1a7f9a52caefa1eb46f3271ea66b6e0e6953f',
      'actionlint',
      'actionlint_1.7.12_darwin_arm64.tar.gz',
    ],
    shellcheck: [
      '0.11.0',
      'https://github.com/koalaman/shellcheck/releases/download/v0.11.0/shellcheck-v0.11.0.darwin.aarch64.tar.gz',
      '339b930feb1ea764467013cc1f72d09cd6b869ebf1013296ba9055ab2ffbd26f',
      'shellcheck-v0.11.0/shellcheck',
      'shellcheck-v0.11.0.darwin.aarch64.tar.gz',
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
  const [version, url, expected, executable, archiveName] = specification;
  const cache = path.resolve(process.env.PAQVILO_TOOL_CACHE ?? path.join(root, '.paqvilo/tools'));
  const directory = path.join(cache, `${name}-${version}-${process.platform}-${process.arch}`);
  const archive = path.join(directory, archiveName);
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
export function workflowTools(platform = process.platform, arch = process.arch) {
  const tools = assets[`${platform}-${arch}`];
  if (!tools)
    throw new Error(
      `Pinned workflow tools are not configured for ${platform}-${arch}; supported platforms: ${Object.keys(assets).join(', ')}.`,
    );
  return tools;
}
async function main() {
  const supported = workflowTools();
  const actionlint = await provision('actionlint', supported.actionlint);
  const shellcheck = await provision('shellcheck', supported.shellcheck);
  execute(actionlint, ['-color', '-shellcheck', shellcheck, '-pyflakes=', '-oneline']);
  execute(shellcheck, ['--shell=sh', '.githooks/pre-commit', '.githooks/commit-msg', '.githooks/pre-push']);
  console.log('Workflow and hook checks passed (actionlint 1.7.12, ShellCheck 0.11.0).');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    await main();
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
