// A Dataverse Function defined in a Solution: fxexpressions/<name>/fxexpression.xml holds the Power Fx expression and the
// customapi.xml names it (customapi.FxExpressionId), so the Function
// evaluates through the core engine instead of answering default outputs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { createOrganizationRuntime } from '../lib/dataverse-organization.mjs';
import { sourceOrganizationExtensions } from '../lib/source-organization-extensions.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { createPowerFxEvaluator } from '../lib/canvas-power-fx.mjs';
import { importSolutionData } from '../lib/solution-data.mjs';
import { parseCustomApiFiles, parseFxExpressionFiles } from '../lib/dataverse-customapi.mjs';
import { ownedFixture, makeTemporaryDirectory } from '../testing/owned-fixture.mjs';

const APP = '77777777-7777-4777-8777-777777777777';
const FX = '77777777-7777-4777-8777-777777777741';
const api = (name, reference) => ({
  [`customapis/${name}/customapi.xml`]: `<customapi uniquename="${name}"><bindingtype>0</bindingtype><isfunction>1</isfunction><name>${name}</name>${reference}</customapi>`,
  ...Object.fromEntries(
    ['Budget', 'Spent'].map((p) => [
      `customapis/${name}/customapirequestparameters/${p}/customapirequestparameter.xml`,
      `<customapirequestparameter uniquename="${p}"><name>${name}.${p}</name><type>6</type><isoptional>0</isoptional></customapirequestparameter>`,
    ]),
  ),
  [`customapis/${name}/customapiresponseproperties/Ratio/customapiresponseproperty.xml`]: `<customapiresponseproperty uniquename="Ratio"><name>${name}.Ratio</name><type>6</type></customapiresponseproperty>`,
});
const files = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedFx</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'fxexpressions/x_Health/fxexpression.xml': `<fxexpression uniquename="x_Health"><fxexpressionid>{${FX}}</fxexpressionid><name>x_Health</name><expression>{ Ratio: If(Budget = 0, 0, (Budget - Spent) / Budget) }</expression><statecode>0</statecode></fxexpression>`,
  'fxexpressions/x_Half/fxexpression.xml':
    '<fxexpression uniquename="x_Half"><name>x_Half</name><expression>{ Ratio: Budget / 2 }</expression></fxexpression>',
  ...api('x_Health', `<fxexpressionid><fxexpressionid>{${FX}}</fxexpressionid></fxexpressionid>`),
  ...api('x_Half', '<fxexpressionid><uniquename>x_Half</uniquename></fxexpressionid>'),
  ...api('x_Plain', ''),
};

async function organization(t) {
  const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'customapi-fxexpression-'));
  ownedFixture(t).remove(() => fs.rm(root, { recursive: true, force: true }));
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await fs.writeFile(path.join(root, name), text);
  }
  const variable = `PAQVILO_FXSOL_${process.pid}_${Math.random().toString(36).slice(2).toUpperCase()}`;
  process.env[variable] = 'invented';
  ownedFixture(t).add(() => {
    delete process.env[variable];
  });
  const store = await new DataStore({ state: emptyState() }).init();
  const runtime = await createOrganizationRuntime({
    store,
    providers: { powerFx: createPowerFxEvaluator({}) },
    extensions: await sourceOrganizationExtensions({ layers: (await importSolutionData([root])).layers }),
    settings: dataverseSettings({
      enabled: true,
      applications: [
        { appId: APP, displayName: 'Invented', secretEnvironmentVariable: variable, roles: ['System Administrator'] },
      ],
    }),
  });
  const transport = await startDataverseApi({ organization: runtime });
  ownedFixture(t).add(async () => {
    await transport.close();
    await runtime.close();
  });
  const token = (
    await (
      await fetch(transport.authority + '/oauth2/v2.0/token', {
        method: 'POST',
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: APP,
          client_secret: 'invented',
          scope: transport.origin + '/.default',
        }),
      })
    ).json()
  ).access_token;
  return async (route) => {
    const response = await fetch(transport.origin + '/api/data/v9.2/' + route, {
      headers: { authorization: `Bearer ${token}` },
    });
    return { status: response.status, body: await response.json() };
  };
}

test('a Solution Function linked to its fxexpression (by id or by unique name) evaluates; an unlinked one keeps defaults', async (t) => {
  const get = await organization(t);
  const health = await get('x_Health(Budget=100,Spent=40)');
  assert.equal(health.status, 200, JSON.stringify(health.body));
  assert.equal(health.body.Ratio, 0.6);
  const half = await get('x_Half(Budget=10,Spent=0)');
  assert.equal(half.status, 200, JSON.stringify(half.body));
  assert.equal(half.body.Ratio, 5);
  const plain = await get('x_Plain(Budget=10,Spent=0)');
  assert.equal(plain.status, 200, JSON.stringify(plain.body));
  assert.equal(plain.body.Ratio, null, 'an unauthored scalar output defaults to null at the HTTP boundary');
});

test('the parsers link customapi.fxexpressionid to the fxexpression row of the same Solution', () => {
  const entries = Object.entries(files).map(([name, text]) => ({ name, text }));
  const under = (folder) =>
    entries
      .filter((e) => e.name.startsWith(folder + '/'))
      .map((e) => ({ path: e.name.slice(folder.length + 1), text: e.text }));
  const { fxexpression } = parseFxExpressionFiles(under('fxexpressions'));
  assert.deepEqual(fxexpression.map((r) => r.uniquename).sort(), ['x_Half', 'x_Health']);
  assert.equal(fxexpression.find((r) => r.uniquename === 'x_Health').fxexpressionid, FX);
  const { customapi } = parseCustomApiFiles(under('customapis'), { fxexpressions: fxexpression });
  const ref = (name) => customapi.find((r) => r.uniquename === name).fxexpressionid;
  assert.deepEqual(ref('x_Health'), { id: FX, logical_name: 'fxexpression' });
  assert.equal(ref('x_Half').id, fxexpression.find((r) => r.uniquename === 'x_Half').fxexpressionid);
  assert.equal(ref('x_Plain'), undefined);
});
