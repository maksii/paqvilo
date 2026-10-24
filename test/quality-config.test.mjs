import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';
import { format, getFileInfo, resolveConfig } from 'prettier';

const root = fileURLToPath(new URL('../', import.meta.url));
const eslint = new ESLint({ cwd: root, overrideConfigFile: path.join(root, 'eslint.config.mjs') });

test('formatting keeps the copied demo editor workspace valid strict JSON', async () => {
  const filepath = path.join(root, 'examples/project/paqvilo-demo.code-workspace');
  const source = await fs.readFile(filepath, 'utf8');
  const formatted = await format(source, { ...(await resolveConfig(filepath)), filepath });
  assert.deepEqual(JSON.parse(formatted), JSON.parse(source));
});

test('quality tooling never discovers private runtime state, dependencies or exported fixtures', async () => {
  const privateFiles = [
    '.paqvilo/quality-probe.mjs',
    'examples/company-operations/.paqvilo/quality-probe.mjs',
    'mirage/.paqvilo/quality-probe.mjs',
    '.claude/quality-probe.mjs',
    'examples/company-operations/.claude/quality-probe.mjs',
    '.codex/quality-probe.mjs',
    'mirage/.codex/quality-probe.mjs',
    'examples/project/node_modules/quality-probe/index.mjs',
    'mirage/test/fixtures/quality-probe.mjs',
    'examples/project/baseline/portal/quality-probe.js',
    'examples/project/portal/quality-probe.js',
    'examples/project/solution/quality-probe.js',
    'examples/project/components/control/generated/quality-probe.ts',
  ];
  for (const name of privateFiles) {
    assert.equal(await eslint.isPathIgnored(path.join(root, name)), true, `ESLint: ${name}`);
    assert.equal(
      (await getFileInfo(path.join(root, name), { ignorePath: path.join(root, '.prettierignore') })).ignored,
      true,
      `Prettier: ${name}`,
    );
  }
  assert.equal(await eslint.isPathIgnored(path.join(root, 'lense/config.mjs')), false);
  assert.equal(
    (await getFileInfo(path.join(root, 'lense/config.mjs'), { ignorePath: path.join(root, '.prettierignore') }))
      .ignored,
    false,
  );
});

test('browser modules reject Node-only APIs and incorrect shared-asset exports', async () => {
  const [browser] = await eslint.lintText('process.exit(0);', { filePath: 'mirage/admin/quality-probe.mjs' });
  assert.ok(browser.messages.some((message) => message.ruleId === 'no-undef'));
  const [asset] = await eslint.lintText(
    "import { missingQualityExport } from './ui-kit.mjs'; console.log(missingQualityExport);",
    { filePath: 'lense/setup/app.mjs' },
  );
  assert.ok(asset.messages.some((message) => message.ruleId === 'import-x/named'));
  assert.equal(
    asset.messages.some((message) => message.ruleId === 'import-x/no-unresolved'),
    false,
    'the shared route resolves to its real source',
  );
  const [missing] = await eslint.lintText("import './missing-quality-asset.mjs';", { filePath: 'lense/setup/app.mjs' });
  assert.ok(
    missing.messages.some((message) => message.ruleId === 'import-x/no-unresolved'),
    'unlisted browser imports remain checked',
  );
});
