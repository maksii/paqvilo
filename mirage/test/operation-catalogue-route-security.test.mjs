// @test-kind security: exported flow URL discovery admits relative local routes and rejects absolute or external endpoints.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { importSolutionOperationSources } from '../lib/operation-catalogue.mjs';

test('solution flow discovery accepts relative routes without admitting absolute endpoints', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-flow-route-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const route = '/_api/cloudflow/v1.0/trigger/invented-flow';
  const values = [
    route,
    route + '?ignored=1',
    route + '%2Fencoded?ignored=1#fragment',
    'http://external.invalid' + route,
    'https://external.invalid' + route,
    'https://user:password@external.invalid' + route,
    '//external.invalid' + route,
    '//local.invalid' + route,
    '/\n/local.invalid' + route,
    '\\local.invalid' + route,
    'http://local.invalid' + route,
    'https://local.invalid' + route,
  ];
  for (const [i, value] of values.entries()) {
    const dir = path.join(root, 'powerpagecomponents', String(i));
    await fs.mkdir(dir, { recursive: true });
    const content = JSON.stringify({ flowapiurl: value });
    await fs.writeFile(
      path.join(dir, 'powerpagecomponent.xml'),
      `<powerpagecomponent powerpagecomponentid="invented-${i}"><content>${content}</content><name>Flow ${i}</name><powerpagecomponenttype>33</powerpagecomponenttype><powerpagesiteid><powerpagesiteid>site</powerpagesiteid></powerpagesiteid><statecode>0</statecode></powerpagecomponent>`,
    );
  }
  const result = await importSolutionOperationSources([{ dir: root }], { id: 'site' });
  const routes = new Map(result.cloudFlows.map((flow) => [flow.name, flow.path]));
  assert.equal(routes.size, values.length);
  assert.equal(routes.get('Flow 0'), route);
  assert.equal(routes.get('Flow 1'), route);
  assert.equal(routes.get('Flow 2'), route + '%2Fencoded');
  for (let i = 3; i < values.length; i++) assert.equal(routes.get('Flow ' + i), null);
});
