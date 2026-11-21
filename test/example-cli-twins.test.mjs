// @test-kind tooling: the two examples keep byte-identical copies of their shared cli.mjs helper.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

// Each example is a self-contained package (the demo copies examples/project alone), so the helper is duplicated.
test('examples/project/cli.mjs and examples/company-operations/cli.mjs are byte-identical', () => {
  const project = fs.readFileSync(new URL('../examples/project/cli.mjs', import.meta.url));
  const company = fs.readFileSync(new URL('../examples/company-operations/cli.mjs', import.meta.url));
  assert.ok(project.equals(company), 'edit both twins together: they must stay byte-identical');
});
