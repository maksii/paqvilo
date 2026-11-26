// @test-kind contract: lense audit checks the portal export's codecomponent tags against the Solution catalogue offline (invented portal and controls); missing, refused and unimportable controls are Paqvilo's findings
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { auditCodeComponents } from '../lense/pcf-audit.mjs';
import { pcfSettings } from '../mirage/lib/pcf-sources.mjs';
import { tempDirSync } from './fixture.mjs';

function write(root, files) {
  for (const [relative, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
    fs.writeFileSync(path.join(root, relative), text);
  }
}
const control = (name, resources = '<code path="bundle.js" order="1"/>') => ({
  [`Controls/${name}/ControlManifest.xml`]: `<manifest><control namespace="${name.split('_')[1].split('.')[0]}" constructor="${name.split('.')[1]}" control-type="standard"><resources>${resources}</resources></control></manifest>`,
  [`Controls/${name}/ControlManifest.xml.data.xml`]: `<CustomControl><Name>${name}</Name></CustomControl>`,
  [`Controls/${name}/bundle.js`]: '/* */',
});

// @test-kind observation: quoted and unquoted codecomponent names follow one live capture (paqvilo-developer pcf-parity summary-D, r1)
test('lense audit reports missing, refused and unimportable code components the export references', async (t) => {
  const work = fs.realpathSync.native(tempDirSync('paqvilo-pcf-audit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const solution = path.join(work, 'solution');
  write(solution, {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName></SolutionManifest></ImportExportXml>',
    ...control('inv_Good.Control'),
    ...control(
      'inv_Library.Control',
      '<code path="bundle.js" order="1"/><platform-library name="React" version="16.14.0"/>',
    ),
    ...control('inv_Broken.Control', '<code path="missing.js" order="1"/>'),
  });
  const portal = path.join(work, 'portal');
  write(portal, {
    'web-templates/main/Main.webtemplate.source.html': [
      "{% codecomponent name:'inv_Good.Control' %}",
      '{% codecomponent name:inv_Library.Control %}',
      '{% codecomponent name:inv_Broken.Control %}',
      '{% codecomponent name:inv_Absent.Control %}',
      '{% codecomponent name:page.component %}',
    ].join('\n'),
  });
  const result = await auditCodeComponents({ sourceDir: portal, mirageConfig: { solutionRoots: [solution] } });
  assert.equal(result.references, 5);
  // An unquoted name is the literal control name on Power Pages (r1, paqvilo-developer pcf-parity summary-D): none is dynamic.
  assert.equal(result.dynamic, 0);
  assert.equal(result.controls, 2);
  assert.deepEqual(
    result.findings.map((finding) => [finding.code, finding.name, finding.relativePath]),
    [
      ['PCF_AUDIT_NAME_QUOTED', 'inv_Good.Control', 'web-templates/main/Main.webtemplate.source.html'],
      ['PCF_AUDIT_CONTROL_REFUSED', 'inv_Library.Control', 'web-templates/main/Main.webtemplate.source.html'],
      ['PCF_IMPORT_FAILED', 'inv_Broken.Control', 'web-templates/main/Main.webtemplate.source.html'],
      ['PCF_AUDIT_CONTROL_MISSING', 'inv_Broken.Control', 'web-templates/main/Main.webtemplate.source.html'],
      ['PCF_AUDIT_CONTROL_MISSING', 'inv_Absent.Control', 'web-templates/main/Main.webtemplate.source.html'],
      ['PCF_AUDIT_CONTROL_MISSING', 'page.component', 'web-templates/main/Main.webtemplate.source.html'],
    ],
  );
  assert.deepEqual(result.findings[1].reasons, ['PCF_PLATFORM_LIBRARY_UNSUPPORTED']);
  assert.match(result.findings[2].reason, /missing\.js/);
  // An export without code component tags reads no catalogue.
  const plain = path.join(work, 'plain');
  write(plain, { 'web-templates/main/Main.webtemplate.source.html': '<p>no components</p>' });
  assert.deepEqual(await auditCodeComponents({ sourceDir: plain, mirageConfig: { solutionRoots: [solution] } }), {
    references: 0,
    dynamic: 0,
    controls: 0,
    findings: [],
  });
});

test('lense audit skips tags in literal blocks and reports an unreadable export folder instead of failing', async (t) => {
  const work = fs.realpathSync.native(tempDirSync('paqvilo-pcf-audit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const portal = path.join(work, 'portal');
  write(portal, {
    'web-templates/main/Main.webtemplate.source.html':
      "{% comment %}{% codecomponent name:'inv_Commented.Out' %}{% endcomment %}{% raw %}{% codecomponent name:'inv_Raw.Text' %}{% endraw %}",
    'locked/Other.webtemplate.source.html': "{% codecomponent name:'inv_Hidden.Control' %}",
  });
  const { default: fsp } = await import('node:fs/promises');
  const readdir = fsp.readdir;
  t.mock.method(fsp, 'readdir', function (directory, ...rest) {
    if (path.basename(String(directory)) === 'locked')
      return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    return readdir.call(this, directory, ...rest);
  });
  const result = await auditCodeComponents({ sourceDir: portal, mirageConfig: { solutionRoots: [] } });
  t.mock.restoreAll();
  assert.equal(result.references, 0, 'tags in comment and raw blocks render nothing');
  assert.deepEqual(
    result.findings.map((finding) => [finding.code, finding.relativePath]),
    [['PCF_AUDIT_EXPORT_UNREADABLE', 'locked']],
  );
});

// Regression: the size limit was checked on the path before a separate read (a file replaced in between was read
// whole). The limit and the read now use one open handle: an oversized file is skipped, an unopenable one is a finding.
test('lense audit skips an export file over the read limit and reports one it cannot open', async (t) => {
  const work = fs.realpathSync.native(tempDirSync('paqvilo-pcf-audit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const portal = path.join(work, 'portal');
  const tag = '{% codecomponent name:inv_Large.Control %}';
  write(portal, {
    'web-templates/large/Large.webtemplate.source.html': tag + ' '.repeat(4 * 1024 * 1024),
    'web-templates/locked/Locked.webtemplate.source.html': '{% codecomponent name:inv_Locked.Control %}',
  });
  const { default: fsp } = await import('node:fs/promises');
  const open = fsp.open;
  t.mock.method(fsp, 'open', function (file, ...rest) {
    if (path.basename(String(file)) === 'Locked.webtemplate.source.html')
      return Promise.reject(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    return open.call(this, file, ...rest);
  });
  const result = await auditCodeComponents({ sourceDir: portal, mirageConfig: { solutionRoots: [] } });
  t.mock.restoreAll();
  assert.equal(result.references, 0, 'an oversized file and an unopenable file contribute no tags');
  assert.deepEqual(
    result.findings.map((finding) => [finding.code, finding.relativePath]),
    [['PCF_AUDIT_EXPORT_UNREADABLE', 'web-templates/locked/Locked.webtemplate.source.html']],
  );
});

// Regression: the audit admitted controls without the project's pcf.platformLibraries, so a React or virtual control was
// refused even when the libraries were configured. It now admits them with the libraries Mirage serves.
test('lense audit admits React and virtual controls with the configured pcf.platformLibraries', async (t) => {
  const work = fs.realpathSync.native(tempDirSync('paqvilo-pcf-audit-'));
  t.after(() => fs.rmSync(work, { recursive: true, force: true }));
  const solution = path.join(work, 'solution');
  write(solution, {
    'Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>Invented</UniqueName></SolutionManifest></ImportExportXml>',
    ...control(
      'inv_Library.Control',
      '<code path="bundle.js" order="1"/><platform-library name="React" version="16.14.0"/>',
    ),
    'Controls/inv_Virtual.Control/ControlManifest.xml':
      '<manifest><control namespace="Virtual" constructor="Control" control-type="virtual"><resources><code path="bundle.js" order="1"/><platform-library name="React" version="16.14.0"/></resources></control></manifest>',
    'Controls/inv_Virtual.Control/ControlManifest.xml.data.xml':
      '<CustomControl><Name>inv_Virtual.Control</Name></CustomControl>',
    'Controls/inv_Virtual.Control/bundle.js': '/* */',
  });
  const portal = path.join(work, 'portal');
  write(portal, {
    'web-templates/main/Main.webtemplate.source.html':
      '{% codecomponent name:inv_Library.Control %}\n{% codecomponent name:inv_Virtual.Control %}',
  });
  const project = path.join(work, 'project');
  write(project, { 'React@16.14.0.js': '/* invented React */', 'ReactDOM@16.14.0.js': '/* invented ReactDOM */' });

  const unconfigured = await auditCodeComponents({ sourceDir: portal, mirageConfig: { solutionRoots: [solution] } });
  assert.deepEqual(
    unconfigured.findings.map((finding) => [finding.code, finding.name, finding.reasons]),
    [
      ['PCF_AUDIT_CONTROL_REFUSED', 'inv_Library.Control', ['PCF_PLATFORM_LIBRARY_UNSUPPORTED']],
      ['PCF_AUDIT_CONTROL_REFUSED', 'inv_Virtual.Control', ['PCF_VIRTUAL_UNSUPPORTED']],
    ],
  );
  for (const finding of unconfigured.findings) assert.match(finding.reason, /pcf\.platformLibraries/);

  const pcf = pcfSettings({ platformLibraries: ['React@16.14.0.js', 'ReactDOM@16.14.0.js'] }, 'pcf', project);
  const configured = await auditCodeComponents({
    sourceDir: portal,
    mirageConfig: { solutionRoots: [solution], pcf },
  });
  assert.equal(configured.controls, 2);
  assert.deepEqual(configured.findings, []);
});
