// @test-kind tooling: exercises every configured import rule with patched glob dependencies.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { ESLint } from 'eslint';
import { createNodeResolver } from 'eslint-plugin-import-x/node-resolver';
import configurations from '../eslint.config.mjs';

test('configured import rules preserve resolution, named-export and default-export diagnostics', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-import-rules-'));
  try {
    await fs.writeFile(path.join(directory, 'fixture.mjs'), 'export const present = 1;\n');
    const configured = configurations.find((configuration) => configuration.plugins?.['import-x']);
    const rules = Object.fromEntries(Object.entries(configured.rules).filter(([name]) => name.startsWith('import-x/')));
    const eslint = new ESLint({
      cwd: directory,
      overrideConfigFile: true,
      overrideConfig: [
        {
          files: ['**/*.mjs'],
          plugins: { 'import-x': configured.plugins['import-x'] },
          settings: { 'import-x/resolver-next': [createNodeResolver()] },
          rules,
        },
      ],
    });
    for (const [source, expected] of [
      ["import './missing.mjs';", ['import-x/no-unresolved']],
      ["import { absent } from './fixture.mjs';", ['import-x/named']],
      ["import missingDefault from './fixture.mjs';", ['import-x/default']],
      ["import { present } from './fixture.mjs';", []],
    ]) {
      const [result] = await eslint.lintText(source, { filePath: path.join(directory, 'consumer.mjs') });
      assert.deepEqual(
        result.messages.map((message) => message.ruleId),
        expected,
        source,
      );
    }
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});
