import { makeTemporaryDirectorySync } from '../mirage/testing/owned-fixture.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { PortalModel } from '../lense/portal-model.mjs';
import { auditResources } from '../lense/resource-audit.mjs';
import { createFixture, SITE, HOME_ID } from './fixture.mjs';

// No Git baseline: the audit is offline, never reads Git and skips .git.
function fixture(t) {
  const fx = createFixture();
  t.after(fx.cleanup);
  return fx;
}
const audit = (fx, site = SITE) => auditResources(new PortalModel(fx.dir), site);

test('independent inventory catches new file/field kinds that are absent from the mapper', (t) => {
  const fx = fixture(t);
  fx.write('new-components/widget.html', '<p>Never silently omit me</p>');
  fx.write('new-components/widget.yml', 'future_customjavascript: alert("audit");\n');
  fx.write('new-components/styles.CSS', 'body { color: red }');
  const report = audit(fx);
  assert.deepEqual(
    report.resources.filter((item) => item.status === 'gap').map((item) => item.id),
    ['new-components/styles.CSS', 'new-components/widget.html', 'new-components/widget.yml#future_customjavascript'],
  );
  assert.equal(report.coverage.complete, false);
  assert.equal(report.coverage.runtimeVerified, false);
  assert.ok(report.coverage.accountedPercent < 100);
  assert.ok(report.resources.every((item) => !Object.hasOwn(item, 'body') && !Object.hasOwn(item, 'content')));
  assert.deepEqual(report.writesFiles, []);
});

test('blocked, inactive and disabled are explicit instead of disappearing from the denominator', (t) => {
  const fx = fixture(t);
  fx.write('web-files/unregistered.js', 'console.log("orphan");');
  fx.write('web-pages/inactive/Old.webpage.yml', 'statecode: 1\nadx_webpageid: inactive\nadx_partialurl: inactive\n');
  fx.write('web-pages/inactive/Old.webpage.custom_css.css', '.old {}');
  const site = structuredClone(SITE);
  site.inline.enabled = false;
  site.webFiles.exclude = ['/scripts/**'];
  const report = audit(fx, site);
  assert.equal(report.resources.find((item) => item.id === 'web-files/unregistered.js').status, 'blocked');
  assert.equal(report.resources.find((item) => item.id.endsWith('Old.webpage.custom_css.css')).status, 'inactive');
  const app = report.resources.find((item) => item.id === 'web-files/app.js');
  assert.equal(app.status, 'mapped');
  assert.equal(app.enabled, false);
  assert.deepEqual(report.totals, {
    resources: 12,
    mapped: 9,
    blocked: 2,
    inactive: 1,
    deployment: 0,
    gaps: 0,
    disabled: 5,
  });
});

test('configured file and directory routes account for otherwise unregistered sources', (t) => {
  const fx = fixture(t);
  fx.write('custom/widget.js', 'console.log("widget");');
  fx.write('assets/nested/a b.css', 'body {}');
  const site = structuredClone(SITE);
  site.routes = [
    { url: '/widget.js', file: 'custom/widget.js' },
    { url: '/assets/**/*.css', dir: 'assets' },
  ];
  const report = audit(fx, site);
  assert.equal(report.resources.find((item) => item.id === 'custom/widget.js').status, 'mapped');
  assert.equal(report.resources.find((item) => item.id === 'assets/nested/a b.css').url, '/assets/nested/a%20b.css');
  site.routes.unshift({ url: '/assets/**', passthrough: true });
  assert.equal(audit(fx, site).resources.find((item) => item.id === 'assets/nested/a b.css').status, 'gap');
});

test('a valid URL for a shared payload cannot hide another ambiguous mapping of that payload', (t) => {
  const fx = fixture(t);
  fx.write(
    'web-files/shared.webfile.yml',
    `filename: app.js\nadx_partialurl: duplicate.js\nadx_parentpageid: ${HOME_ID}\n`,
  );
  fx.write('web-files/conflict.js', 'console.log("different");');
  fx.write(
    'web-files/conflict.js.webfile.yml',
    `filename: conflict.js\nadx_partialurl: duplicate.js\nadx_parentpageid: ${HOME_ID}\n`,
  );
  const report = audit(fx);
  const app = report.resources.find((item) => item.id === 'web-files/app.js');
  assert.equal(app.status, 'blocked');
  assert.equal(app.mappings.length, 2);
  assert.ok(app.mappings.some((mapping) => mapping.supported));
  assert.ok(app.mappings.some((mapping) => !mapping.supported));
});

test('duplicate YAML keys are inventoried individually and malformed input never reports 100 percent', (t) => {
  const fx = fixture(t);
  fx.write('extra.yml', 'customjavascript: first()\ncustomjavascript: second()\n');
  const report = audit(fx);
  assert.equal(report.coverage.inventoryComplete, true);
  assert.equal(report.coverage.complete, false);
  assert.deepEqual(
    report.resources.filter((item) => item.relativePath === 'extra.yml').map((item) => item.field),
    ['customjavascript', 'customjavascript[duplicate:1]'],
  );
  assert.ok(report.diagnostics.some((item) => item.code === 'DUPLICATE_KEY'));
  fx.write('broken.yml', 'broken: [unclosed\n');
  const broken = audit(fx);
  assert.equal(broken.coverage.inventoryComplete, false);
  assert.equal(broken.coverage.accountedPercent, null);
  assert.equal(broken.coverage.mappedPercent, null);
});

test('deployment profiles and server settings retain visible, distinct classifications', (t) => {
  const fx = fixture(t);
  fx.write(
    'deployment-profiles/test.deployment.yml',
    'adx_contentsnippet:\n- adx_value: <script>environmentSpecific()</script>\n',
  );
  fx.write('lists/Test.list.yml', 'adx_settings: \'{"html":"<span>server generated</span>"}\'\n');
  const report = audit(fx);
  assert.equal(
    report.resources.find((item) => item.relativePath.startsWith('deployment-profiles/')).status,
    'deployment',
  );
  assert.equal(report.resources.find((item) => item.id === 'lists/Test.list.yml#adx_settings').status, 'deployment');
});

test('serialized code is inventoried even when its outer field has no HTML tag', (t) => {
  const fx = fixture(t);
  fx.write(
    'lists/Test.list.yml',
    'adx_settings: \'{"customjavascript":"alert(1)","customcss":"body { color: red }"}\'\n',
  );
  const report = audit(fx);
  for (const field of ['adx_settings.customjavascript', 'adx_settings.customcss']) {
    const resource = report.resources.find((item) => item.id === `lists/Test.list.yml#${field}`);
    assert.equal(resource.status, 'deployment');
    assert.match(resource.reason, /server-interpreted/);
  }
});

test('inactive metadata sequence records do not conceal unknown fields on active siblings', (t) => {
  const fx = fixture(t);
  fx.write(
    'basic-forms/contact/Contact.basicform.basicformmetadata.yml',
    '- statecode: 1\n  future_customjavascript: hidden()\n- statecode: 0\n  future_customjavascript: visible()\n',
  );
  const report = audit(fx);
  assert.equal(report.resources.find((item) => item.field === '0.future_customjavascript').status, 'inactive');
  assert.equal(report.resources.find((item) => item.field === '1.future_customjavascript').status, 'gap');
});

test('enhanced absent fields are not invented as resource occurrences; metadata-only components are valid', (t) => {
  const dir = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo-audit-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const write = (id, xml) => {
    const file = path.join(dir, 'powerpagecomponents', id, 'powerpagecomponent.xml');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, xml);
  };
  write(
    'home',
    '<powerpagecomponent powerpagecomponentid="home"><powerpagecomponenttype>2</powerpagecomponenttype><content><![CDATA[{"partialurl":"/","customjavascript":"console.log(1);"}]]></content></powerpagecomponent>',
  );
  write(
    'template',
    '<powerpagecomponent powerpagecomponentid="template"><powerpagecomponenttype>9</powerpagecomponenttype><name>Server page template</name></powerpagecomponent>',
  );
  const report = auditResources(new PortalModel(dir), SITE);
  assert.equal(report.errors.length, 0);
  assert.equal(report.totals.resources, 1);
  assert.equal(report.resources[0].field, 'customjavascript');
  assert.equal(report.resources[0].status, 'mapped');
  write(
    'duplicate',
    '<powerpagecomponent powerpagecomponentid="duplicate"><powerpagecomponenttype>8</powerpagecomponenttype><content><![CDATA[{"source":"<p>one</p>","source":"<p>two</p>"}]]></content></powerpagecomponent>',
  );
  const invalid = auditResources(new PortalModel(dir), SITE);
  assert.equal(invalid.coverage.inventoryComplete, false);
  assert.equal(invalid.coverage.accountedPercent, null);
  assert.ok(invalid.errors.some((error) => error.code === 'DUPLICATE_JSON_KEY'));
});

test('audit CLI is offline, reports all sites and strict mode fails on blocked coverage', (t) => {
  const fx = fixture(t);
  fx.write(
    'catalogue.yml',
    'sites:\n  first:\n    source: .\n    environments:\n      local: https://portal.invalid\n  second:\n    source: .\n    environments:\n      local: https://another.invalid\n',
  );
  const cli = fileURLToPath(new URL('../lense/cli.mjs', import.meta.url));
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(?:PAQVILO_|GIT_)/.test(key)));
  const run = (...args) =>
    spawnSync(process.execPath, [cli, 'audit', '--config', fx.file('catalogue.yml'), '--json', ...args], {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30_000,
    });
  const normal = run('--all');
  assert.equal(normal.status, 0, normal.stderr);
  const report = JSON.parse(normal.stdout);
  assert.equal(report.offline, true);
  assert.equal(report.complete, false);
  assert.deepEqual(
    report.reports.map((item) => item.site),
    ['first', 'second'],
  );
  // Exit code 1 is also what a crash returns; the JSON error names the actual refusal.
  const refusal = (result) => [result.status, JSON.parse(result.stdout).errors.map((error) => error.code)];
  assert.deepEqual(refusal(run('--all', '--strict')), [1, ['strict_failed']]);
  assert.equal(fs.existsSync(fx.file('.paqvilo')), false);
  assert.deepEqual(refusal(run('--all', '--site', 'first')), [1, ['invalid_argument']]);
});

test('duplicate active page URLs warn once and inactive single-extension web files stay inactive in dotted source roots', (t) => {
  const fx = fixture(t);
  for (const id of ['a', 'b'])
    fx.write(
      `web-pages/${id}/${id}.webpage.yml`,
      `adx_webpageid: ${id}\nadx_name: Page ${id}\nadx_partialurl: same\nadx_parentpageid: ${HOME_ID}`,
    );
  let model = new PortalModel(fx.dir);
  assert.equal(model.warnings.filter((message) => message.includes('duplicate page URL')).length, 1);
  fx.write('web-pages/b/b.webpage.yml', fx.read('web-pages/b/b.webpage.yml') + '\nadx_statecode: 1');
  model = new PortalModel(fx.dir);
  assert.equal(model.warnings.filter((message) => message.includes('duplicate page URL')).length, 0);
  const root = makeTemporaryDirectorySync(path.join(os.tmpdir(), 'paqvilo.inactive.audit.'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'web-files'));
  fs.mkdirSync(path.join(root, 'web-pages'));
  fs.writeFileSync(path.join(root, 'website.yml'), 'adx_websiteid: site\nadx_name: Invented');
  fs.writeFileSync(
    path.join(root, 'web-pages/Home.webpage.yml'),
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /',
  );
  fs.writeFileSync(path.join(root, 'web-files/a.css'), 'body{}');
  fs.writeFileSync(
    path.join(root, 'web-files/a.css.webfile.yml'),
    'adx_webfileid: css\nadx_name: a.css\nadx_partialurl: a.css\nadx_parentpageid: home\nstatecode: 1',
  );
  const config = path.join(root, 'catalogue.yml');
  fs.writeFileSync(
    config,
    YAML.stringify({
      sourceRoot: root,
      sites: { sample: { source: '.', environments: { local: 'http://127.0.0.1:8787' } } },
    }),
  );
  const result = spawnSync(
      process.execPath,
      [fileURLToPath(new URL('../lense/cli.mjs', import.meta.url)), 'audit', '--strict', '--json', '--config', config],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('PAQVILO_'))),
      },
    ),
    report = JSON.parse(result.stdout);
  assert.equal(result.status, 0, JSON.stringify(report));
  assert.equal(report.reports[0].resources.find((row) => row.relativePath === 'web-files/a.css').status, 'inactive');
});
