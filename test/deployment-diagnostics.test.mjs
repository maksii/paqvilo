// @test-kind contract: `lense audit` and `lense verify` report one shared deployment code per deployment-only condition (the deployment codes of docs/lense.md, held here as DEPLOYMENT_DIAGNOSTICS); invented loopback-free fixtures drive both producers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PortalModel } from '../lense/portal-model.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { HtmlRewriter } from '../lense/html-rewriter.mjs';
import { auditResources, deploymentDiagnosticCode } from '../lense/resource-audit.mjs';
import { diagnosticSnapshot } from '../lense/commands/verify.mjs';
import { createFixture, SITE, tempDirSync } from './fixture.mjs';

/**
 * The deployment diagnostic kinds that `lense audit` (resources[].deploymentCode) and `lense verify`
 * (diagnostics.*.needsDeploy[].deploymentCode) share. A kind marked on both sides is reported by both for the same
 * condition; a one-sided kind says why the other side cannot observe that condition.
 */
const DEPLOYMENT_DIAGNOSTICS = Object.freeze({
  'server-logic': { offline: true, live: true, condition: 'Server logic code runs on the Power Pages server.' },
  'site-metadata': { offline: true, live: true, condition: 'Enhanced site or language configuration document.' },
  'deployment-profile': { offline: true, live: true, condition: 'Environment-specific deployment-profile override.' },
  'portal-metadata': {
    offline: true,
    live: true,
    condition: 'A portal record field the overlay does not apply: URLs, permissions, titles and server settings.',
  },
  'inactive-record': {
    offline: true,
    live: true,
    condition: 'The record, or its parent or language root, is inactive.',
  },
  'unresolved-page-url': {
    offline: true,
    live: true,
    condition: 'The page URL of a page source cannot be resolved from local metadata.',
  },
  'preview-disabled': {
    offline: true,
    live: true,
    condition: "The source kind is not enabled in the site's inline or markup settings.",
  },
  'record-lifecycle': {
    offline: false,
    live: true,
    condition: 'A portal record is created, deleted or not indexed.',
    liveOnly: 'Creation and deletion are differences from the baseline; the offline inventory reads no baseline.',
  },
  'new-source': {
    offline: false,
    live: true,
    condition: 'A source that the baseline does not hold, so the portal does not render it yet.',
    liveOnly: 'Newness is a difference from the baseline; the offline inventory reads no baseline.',
  },
  'liquid-change': {
    offline: false,
    live: true,
    condition: 'A changed line touches Liquid code that only the portal can render.',
    liveOnly: 'Determined per changed line against the baseline text.',
  },
  'unlocatable-change': {
    offline: false,
    live: true,
    condition: 'No unique literal text next to a change locates it in the served page.',
    liveOnly: 'Determined per changed line against the baseline text.',
  },
  'unreadable-field': {
    offline: false,
    live: true,
    condition: 'A mapped source field cannot be read from its record metadata.',
    liveOnly: 'Offline, an unreadable or unparsable source is an inventory error (errors[]), which fails the audit.',
  },
  'component-metadata-unparsed': {
    offline: false,
    live: true,
    condition: 'A changed component cannot be compared because its <content> is not a JSON object.',
    liveOnly: 'Offline, unparsable component content is an inventory error (errors[]), which fails the audit.',
  },
  'pcf-manifest': {
    offline: false,
    live: true,
    condition: 'A code component manifest declares other resources or parameters than the served page.',
    liveOnly: 'Offline, code components are checked by the audit codeComponents findings (lense/pcf-audit.mjs).',
  },
});

const CSS = 'web-pages/home/content-pages/Home.en-US.webpage.custom_css.css';
const HEADER = 'web-templates/header/Header.webtemplate.source.html';
const PROMO = 'content-snippets/promo/Promo.en-US.contentsnippet';
const ORPHAN_JS = 'web-pages/about/content-pages/About.en-US.webpage.custom_javascript.js';
const SAVE = 'content-snippets/save/Save.en-US.contentsnippet';

const xmlEscape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const component = (id, type, name, content, extra = '') =>
  `<powerpagecomponent powerpagecomponentid="${id}">\n  <content>${xmlEscape(JSON.stringify(content))}</content>\n  <name>${name}</name>\n  <powerpagecomponenttype>${type}</powerpagecomponenttype>\n${extra}</powerpagecomponent>\n`;
const HOME = '00000000-0000-0000-0000-0000000000a0';
const SITE_XML = 'Assets/powerpagesites.xml';
const xmlOf = (id) => `powerpagecomponents/${id}/powerpagecomponent.xml`;

function classicFixture(t) {
  const fx = createFixture();
  t.after(fx.cleanup);
  return fx;
}

// An invented enhanced export: a root page, a template, a list, an inactive snippet, a setting and site metadata.
function enhancedFixture(t) {
  const dir = tempDirSync('paq-deploy-codes-');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }));
  const write = (rel, text) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text);
  };
  write(xmlOf(HOME), component(HOME, 2, 'Home', { isroot: true, partialurl: '/' }));
  write(xmlOf('t1'), component('t1', 8, 'Header', { source: '<header>\n  <nav>Old menu</nav>\n</header>\n' }));
  write(xmlOf('l1'), component('l1', 17, 'Invented list', { settings: '{"html":"<b>one</b>"}' }));
  write(xmlOf('s2'), component('s2', 7, 'Inactive', { value: '<b>old</b>' }, '  <statecode>1</statecode>\n'));
  write(xmlOf('x1'), component('x1', 9, 'Invented/Setting', { value: 'true' }));
  write(
    SITE_XML,
    '<powerpagesites><powerpagesite powerpagesiteid="00000000-0000-0000-0000-000000000100"><content>{"name":"Invented site"}</content><name>Invented site</name></powerpagesite></powerpagesites>',
  );
  const git = (...args) =>
    execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=', '-c', 'commit.gpgsign=false', ...args], {
      cwd: dir,
      stdio: 'ignore',
      windowsHide: true,
    });
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@localhost', 'commit', '-q', '-m', 'baseline');
  const replace = (rel, from, to) => write(rel, fs.readFileSync(path.join(dir, rel), 'utf8').replace(from, to));
  return { dir, replace };
}

/**
 * One row per condition: the setup that creates it and, per affected source, the code both commands must report.
 * Which side reports a code is read from DEPLOYMENT_DIAGNOSTICS, so a kind added on one side only fails here.
 */
const CONDITIONS = [
  {
    name: 'a Server Logic code edit',
    classic(fx) {
      fx.write('server-logic/calc/calc.js', 'function get() { return 1; }');
      fx.commit();
      fx.write('server-logic/calc/calc.js', 'function get() { return 2; }');
    },
    expect: { 'server-logic/calc/calc.js': 'server-logic' },
  },
  {
    name: 'a deployment-profile override edit',
    classic(fx) {
      fx.write('deployment-profiles/test.deployment.yml', 'adx_contentsnippet:\n- adx_value: <b>one</b>\n');
      fx.commit();
      fx.write('deployment-profiles/test.deployment.yml', 'adx_contentsnippet:\n- adx_value: <b>two</b>\n');
    },
    expect: { 'deployment-profiles/test.deployment.yml': 'deployment-profile' },
  },
  {
    name: 'a serialized server setting edit (classic)',
    classic(fx) {
      fx.write('lists/Test.list.yml', 'adx_name: Test\nadx_settings: \'{"html":"<span>one</span>"}\'\n');
      fx.commit();
      fx.write('lists/Test.list.yml', 'adx_name: Test\nadx_settings: \'{"html":"<span>two</span>"}\'\n');
    },
    expect: { 'lists/Test.list.yml': 'portal-metadata' },
  },
  {
    name: 'a serialized server setting edit (enhanced)',
    enhanced: (fx) => fx.replace(xmlOf('l1'), '&lt;b&gt;one', '&lt;b&gt;two'),
    expect: { [xmlOf('l1')]: 'portal-metadata' },
  },
  {
    name: 'an edit of an inactive record payload (classic sidecar)',
    classic(fx) {
      fx.write(`${PROMO}.yml`, `${fx.read(`${PROMO}.yml`)}statecode: 1\n`);
      fx.commit();
      fx.write(`${PROMO}.value.html`, 'Changed promo text');
    },
    expect: { [`${PROMO}.value.html`]: 'inactive-record' },
  },
  {
    name: 'an edit of an inactive component field (enhanced)',
    enhanced: (fx) => fx.replace(xmlOf('s2'), 'old', 'new'),
    expect: { [xmlOf('s2')]: 'inactive-record' },
  },
  {
    name: 'an edit of a page source whose page URL cannot be resolved',
    classic(fx) {
      fx.write(
        'web-pages/about/About.webpage.yml',
        'adx_webpageid: orphan\nadx_partialurl: about-us\nadx_parentpageid: missing\n',
      );
      fx.commit();
      fx.write(ORPHAN_JS, 'console.log("orphan edit");');
    },
    expect: { [ORPHAN_JS]: 'unresolved-page-url' },
  },
  {
    name: 'an edit of a source kind whose preview is disabled',
    classic: (fx) => fx.write(CSS, fx.read(CSS).replace('color: red', 'color: green')),
    site: { ...SITE, inline: { ...SITE.inline, enabled: false } },
    expect: { [CSS]: 'preview-disabled' },
  },
  {
    name: 'an enhanced site metadata edit',
    enhanced: (fx) => fx.replace(SITE_XML, /Invented site/g, 'Changed site'),
    expect: { [SITE_XML]: 'site-metadata' },
  },
  {
    name: 'a new record and its new source',
    classic(fx) {
      fx.write('web-templates/new/New.webtemplate.yml', 'adx_name: New\n');
      fx.write('web-templates/new/New.webtemplate.source.html', '<p>new</p>');
    },
    expect: {
      'web-templates/new/New.webtemplate.yml': 'record-lifecycle',
      'web-templates/new/New.webtemplate.source.html': 'new-source',
    },
  },
  {
    name: 'a deleted record',
    classic: (fx) => fx.git('rm', '-q', `${PROMO}.yml`),
    expect: { [`${PROMO}.yml`]: 'record-lifecycle' },
  },
  {
    name: 'a changed Liquid tag',
    classic: (fx) => fx.write(HEADER, fx.read(HEADER).replace('{% if user %}', '{% if user and user.roles %}')),
    expect: { [HEADER]: 'liquid-change' },
  },
  {
    name: 'a change without unique literal text to locate it',
    classic(fx) {
      fx.write(`${SAVE}.yml`, 'adx_name: Buttons/Save\n');
      fx.write(`${SAVE}.value.html`, 'ab');
      fx.commit();
      fx.write(`${SAVE}.value.html`, 'ab cd');
    },
    expect: { [`${SAVE}.value.html`]: 'unlocatable-change' },
  },
  {
    name: 'an unreadable mapped field',
    enhanced: (fx) => fx.replace(xmlOf('t1'), '<content>', '<content>not json'),
    expect: { [xmlOf('t1')]: 'unreadable-field' },
  },
  {
    name: 'component content that is not a JSON object',
    enhanced: (fx) => fx.replace(xmlOf('x1'), '<content>', '<content>not json'),
    expect: { [xmlOf('x1')]: 'component-metadata-unparsed' },
  },
];

const fileOf = (rel) => String(rel).replace(/#.*$/, '');

function codesBySource(rows, codeOf) {
  const codes = new Map();
  for (const row of rows) {
    const file = fileOf(row.rel ?? row.relativePath);
    const code = codeOf(row);
    if (code === undefined) continue;
    if (!codes.has(file)) codes.set(file, new Set());
    codes.get(file).add(code);
  }
  return codes;
}

function observe(row, t) {
  const fx = row.classic ? classicFixture(t) : enhancedFixture(t);
  (row.classic ?? row.enhanced)(fx);
  const site = row.site ?? SITE;
  const rewriter = new HtmlRewriter({
    model: new PortalModel(fx.dir),
    site,
    baseline: new GitBaseline(fx.dir, 'HEAD'),
  });
  // The live rows go through the snapshot `lense verify` writes, with the verified copy as sourceDir.
  const live = diagnosticSnapshot({ needsDeploy: rewriter.unsupported }, { sourceDir: fx.dir }).needsDeploy;
  const offline = auditResources(new PortalModel(fx.dir), site).resources;
  return { live, offline };
}

for (const row of CONDITIONS) {
  test(`deployment code parity: ${row.name}`, (t) => {
    const { live, offline } = observe(row, t);
    for (const entry of live) {
      assert.ok(entry.deploymentCode, `live row has no deployment code: ${entry.rel}: ${entry.reason}`);
      assert.equal(DEPLOYMENT_DIAGNOSTICS[entry.deploymentCode]?.live, true, `${entry.deploymentCode} is not live`);
    }
    for (const entry of offline.filter((item) => item.deploymentCode))
      assert.equal(
        DEPLOYMENT_DIAGNOSTICS[entry.deploymentCode]?.offline,
        true,
        `${entry.deploymentCode} is not offline`,
      );
    const liveCodes = codesBySource(live, (entry) => entry.deploymentCode);
    const offlineCodes = codesBySource(offline, (entry) => entry.deploymentCode);
    for (const [rel, code] of Object.entries(row.expect)) {
      const kind = DEPLOYMENT_DIAGNOSTICS[code];
      assert.ok(kind, `unknown code ${code}`);
      assert.deepEqual([...(liveCodes.get(rel) ?? [])], kind.live ? [code] : [], `verify codes of ${rel}`);
      assert.deepEqual([...(offlineCodes.get(rel) ?? [])], kind.offline ? [code] : [], `audit codes of ${rel}`);
    }
  });
}

test('every deployment code has a parity row, and one-sided codes say why', () => {
  const covered = new Set(CONDITIONS.flatMap((row) => Object.values(row.expect)));
  covered.add('pcf-manifest'); // its producer row is checked below
  assert.deepEqual([...covered].sort(), Object.keys(DEPLOYMENT_DIAGNOSTICS).sort());
  for (const [code, kind] of Object.entries(DEPLOYMENT_DIAGNOSTICS)) {
    assert.ok(kind.live || kind.offline, code);
    assert.ok(kind.condition, code);
    if (!kind.offline) assert.ok(kind.liveOnly, `${code} is live-only without a reason`);
  }
});

test('code component manifest rows are pcf-manifest and unknown reasons stay unclassified', () => {
  // lense/pcf-resources.mjs marks its needsDeploy rows with pcfDeployment; lense/session.mjs replaces them by that flag.
  const pcf = { pcfDeployment: true, rel: 'Controls/Sample/ControlManifest.xml', reason: 'any text' };
  assert.equal(deploymentDiagnosticCode(pcf), 'pcf-manifest');
  assert.equal(deploymentDiagnosticCode({ rel: 'a.html', reason: 'an invented reason' }), null);
  const snapshot = diagnosticSnapshot({ needsDeploy: [pcf, { rel: 'a.html', reason: 'an invented reason' }] });
  assert.deepEqual(
    snapshot.needsDeploy.map((entry) => entry.deploymentCode),
    ['pcf-manifest', null],
  );
});
