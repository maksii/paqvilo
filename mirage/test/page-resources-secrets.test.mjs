import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPage } from '../lib/page-resources.mjs';
import { applyPortalOverrides, bindPortalEnvironment } from '../lib/portal-overrides.mjs';

const VALUE = 'INVENTED-SECRET-VALUE';
const source = () => ({
  sourceDir: '/portal',
  pages: [
    {
      id: 'p1',
      name: 'Home',
      title: 'Home',
      url: '/',
      html: "{{ settings['Fx/ApiKey'] }} {{ settings['Fx/Plain'] }}",
      js: '',
      css: '',
      metadata: { id: 'p1' },
    },
  ],
  pageTemplates: [],
  templates: {},
  forms: [],
  advancedForms: [],
  lists: [],
  records: [
    { kind: 'sitesetting', id: 's1', name: 'Fx/ApiKey', _file: '/portal/site-settings.yml' },
    { kind: 'sitesetting', id: 's2', name: 'Fx/Plain', _file: '/portal/site-settings.yml' },
  ],
  settings: { 'Fx/ApiKey': '', 'Fx/Plain': 'visible' },
  snippets: {},
  settingEnvironmentVariables: { 'Fx/ApiKey': 'fx_ApiKey' },
});
const state = {
  tables: {
    environmentvariabledefinition: [
      {
        environmentvariabledefinitionid: '77777777-7777-4777-8777-777777777777',
        schemaname: 'fx_ApiKey',
        type: 100000005,
        defaultvalue: 'https://fxvault.vault.example.test/secrets/fx-api-key',
      },
    ],
    environmentvariablevalue: [],
  },
};
const resolver = { resolve: async () => ({ status: 'resolved', value: VALUE }) };

test('applyPortalOverrides carries secretSettingNames as an explicit property', async () => {
  const bound = await bindPortalEnvironment(source(), state, { resolver });
  assert.deepEqual(bound.secretSettingNames, ['Fx/ApiKey']);
  const portal = applyPortalOverrides(bound, { settings: { 'Fx/Plain': 'override' } });
  assert.deepEqual(portal.secretSettingNames, ['Fx/ApiKey']);
  assert.ok(Object.keys(portal).includes('secretSettingNames'));
  assert.equal(portal.settings['Fx/ApiKey'], VALUE, 'rendering still receives the resolved value');
});

test('page inspection renders [secret] for a secret-classified setting and never the bound value', async () => {
  const unbound = source();
  const bound = await bindPortalEnvironment(unbound, state, { resolver });
  for (const overrides of [{}, { settings: { 'Fx/ApiKey': 'local override' } }]) {
    const report = inspectPage(applyPortalOverrides(bound, overrides), '/', { sourcePortal: unbound, overrides });
    const secret = report.siteSettings.find((setting) => setting.name === 'Fx/ApiKey');
    assert.equal(secret.value, '[secret]');
    assert.equal(secret.sourceValue, '[secret]');
    assert.equal(secret.secret, true);
    assert.equal(report.siteSettings.find((setting) => setting.name === 'Fx/Plain').value, 'visible');
    assert.ok(!JSON.stringify(report).includes(VALUE));
    assert.ok(!JSON.stringify(report).includes('local override'));
  }
});
