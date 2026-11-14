// @test-kind contract: invented DOM and registry observations exercise Paqvilo's provenance decision policy
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { sharedBrowser, appsOrigin } from './shared-browser.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { ownedFixture } from '../testing/owned-fixture.mjs';
import { importModelDrivenProject, createModelDrivenOverlay } from '../../lense/model-driven.mjs';
import { createModelDrivenMetadataIndex } from '../../lense/model-driven-metadata.mjs';
import { startModelDrivenInspector } from '../../lense/model-driven-inspector.mjs';
import { modelDrivenObservationRuntime } from '../../lense/model-driven-observation.mjs';
import { resolveInspectionEvidence } from '../../lense/inspection-evidence.mjs';
import scenarios from './fixtures/model-driven-provenance-corpus.mjs';

const chrome = sharedBrowser();
const guid = (number) => `10000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const main = guid(1),
  quick = guid(4);
const controls = [
  [31, 'fixture_title', 'body'],
  [32, 'fixture_title1', 'body'],
  [33, 'header_fixture_title', 'header'],
  [34, 'footer_fixture_title', 'footer'],
  [36, 'fixture_grid', 'body'],
  [37, 'fixture_quick', 'body'],
  [38, 'fixture_scalar', 'body'],
  [39, 'fixture_dataset', 'body'],
];
const keyOf = (key) => {
  const found = controls.find(([number]) => key === 'control:' + guid(number));
  if (found) return `control:${main}:${guid(found[0])}:${found[2]}`;
  if (key === 'control:quick-view-child') return `control:${quick}:quick-view-child:body`;
  if (key === 'control:' + guid(3105)) return `control:${guid(1205)}:${guid(3105)}:body`;
  if (key.startsWith('command:') && !key.includes('platform.')) return 'command:fixture_case:fixture.submit';
  return key.toLowerCase();
};

/** These are invented observation fixtures, never an assertion of native live parity.
 * Actual Mirage render/mount/controller coverage lives in model-driven-provenance.test.mjs.
 * This corpus executes the private registry on real nodes and documented native APIs
 * on actual DOM, then checks the shared decision policy independently. */
test('all 60 invented provenance scenarios execute current DOM/provider observations', async (t) => {
  const { sim, origin: portalOrigin, root, solutionDir } = await modelDrivenFixture(t);
  // App pages, their assets and the native corpus page run on the apps origin, the origin the observations read.
  const origin = appsOrigin(sim, portalOrigin);
  const write = async (relative, content) => {
    const file = path.join(solutionDir, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
    return file;
  };
  await write(
    'Entities/fixture_case/Entity.xml',
    '<Entity><Name>fixture_case</Name><EntityInfo><entity Name="fixture_case"><attributes><attribute PhysicalName="fixture_title"><LogicalName>fixture_title</LogicalName><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  );
  const controlXml = (rows) =>
    rows
      .map(
        ([number, name]) =>
          `<row><cell><control id="${name}" uniqueid="{${guid(number)}}" datafieldname="fixture_title"/></cell></row>`,
      )
      .join('');
  const formXml = `<form><header><rows>${controlXml(controls.filter((item) => item[2] === 'header'))}</rows></header><tabs><tab name="fixture_general"><columns><column><sections><section name="fixture_details"><rows>${controlXml(controls.filter((item) => item[2] === 'body'))}</rows></section></sections></column></columns></tab></tabs><footer><rows>${controlXml(controls.filter((item) => item[2] === 'footer'))}</rows></footer></form>`;
  const formFile = await write(
    'Entities/fixture_case/FormXml/main/fixture.xml',
    `<systemform><formid>{${main}}</formid><type>2</type>${formXml}</systemform>`,
  );
  await write(
    'Entities/fixture_case/FormXml/quick/fixture.xml',
    `<systemform><formid>{${quick}}</formid><type>6</type><form><tabs><tab><columns><column><sections><section><rows><row><cell><control id="quick-view-child" datafieldname="fixture_title"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>`,
  );
  await write(
    'Entities/fixture_case/FormXml/quickCreate/fixture.xml',
    `<systemform><formid>{${guid(3)}}</formid><type>7</type>${formXml}</systemform>`,
  );
  for (const number of [11, 12])
    await write(
      `Entities/fixture_case/SavedQueries/${number}.xml`,
      `<savedquery><savedqueryid>{${guid(number)}}</savedqueryid><querytype>0</querytype><fetchxml><fetch><entity name="fixture_case"><attribute name="fixture_title"/></entity></fetch></fetchxml><layoutxml><grid><row><cell name="fixture_title" width="180"/></row></grid></layoutxml></savedquery>`,
    );
  await write(
    'Entities/fixture_case/RibbonDiff.xml',
    '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="Fixture.Submit" Command="Fixture.Action" LabelText="Fixture command"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="Fixture.Action"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>',
  );
  await write(
    'AppActions/fixture_submit/AppAction.xml',
    '<appaction uniquename="fixture_action"><name>Fixture.Submit</name><buttonlabeltext default="Fixture command"/><context>1</context><contextvalue>fixture_case</contextvalue><location>0</location><sequence>0</sequence><onclickeventjavascriptfunctionname>Fixture.submit</onclickeventjavascriptfunctionname><onclickeventjavascriptwebresourceid><webresourceid>10000000-0000-4000-8000-000000000050</webresourceid></onclickeventjavascriptwebresourceid><onclickeventtype>2</onclickeventtype><type>0</type></appaction>',
  );
  for (const name of ['Scalar', 'Dataset']) {
    await write(
      `Controls/Fixture.${name}/ControlManifest.xml`,
      `<manifest><control namespace="Fixture" constructor="${name}" control-type="standard"><resources><code path="bundle.js"/></resources></control></manifest>`,
    );
    await write(
      `Controls/Fixture.${name}/ControlManifest.xml.data.xml`,
      `<CustomControl><Name>Fixture.${name}</Name></CustomControl>`,
    );
    await write(
      `Controls/Fixture.${name}/bundle.js`,
      `/* Invented ${name} source definition; this corpus does not claim a mounted implementation. */`,
    );
  }
  await write('WebResources/fixture_script.js', 'window.fixtureSourceMarker = true;');
  await write(
    'WebResources/fixture_script.js.data.xml',
    '<WebResource><WebResourceId>10000000-0000-4000-8000-000000000050</WebResourceId><Name>fixture_script.js</Name><WebResourceType>3</WebResourceType><FileName>WebResources/fixture_script.js</FileName></WebResource>',
  );
  const imported = await importModelDrivenProject({ solutionRoots: [solutionDir], solutionOrder: 'explicit' });
  const largeXml = `<systemform><formid>{${guid(1205)}}</formid><form><tabs><tab name="fixture_general"><columns><column><sections><section name="fixture_details"><rows>${Array.from({ length: 1105 }, (_, number) => `<row><cell><control id="fixture_long_${number}" uniqueid="{${guid(number + 2001)}}" datafieldname="fixture_title"/></cell></row>`).join('')}</rows></section></sections></column></columns></tab></tabs></form></systemform>`;
  const largeFile = await write('Entities/fixture_case/FormXml/main/large.xml', largeXml);
  imported.metadata.forms.push(
    ...Array.from({ length: 205 }, (_, number) => ({
      id: guid(number + 1001),
      entity: 'fixture_case',
      file: largeFile,
      xml: largeXml,
      systemFormType: 2,
    })),
  );
  imported.metadata.sourceRevisions[largeFile] = digest(largeXml);
  const largeView = await write(
    'Entities/fixture_case/SavedQueries/large.xml',
    `<savedquery><savedqueryid>{${guid(4205)}}</savedqueryid><fetchxml><fetch><entity name="fixture_case"/></fetch></fetchxml></savedquery>`,
  );
  const largeViewBytes = await fs.readFile(largeView);
  imported.metadata.sourceRevisions[largeView] = digest(largeViewBytes);
  imported.metadata.views.push(
    ...Array.from({ length: 205 }, (_, number) => ({
      id: guid(number + 4001),
      entity: 'fixture_case',
      file: largeView,
      fields: [{ name: 'fixture_title' }],
    })),
  );
  const index = createModelDrivenMetadataIndex(imported);
  const alternateFile = await write(
    'Entities/fixture_case/FormXml/main/alternate-origin.xml',
    (await fs.readFile(formFile, 'utf8')).replace('fixture_details', 'changed_fixture_section'),
  );
  const alternate = structuredClone(imported.metadata);
  alternate.forms = alternate.forms.map((form) => (form.id === main ? { ...form, file: alternateFile } : form));
  alternate.sourceRevisions[alternateFile] = digest(await fs.readFile(alternateFile));
  const alternateIndex = createModelDrivenMetadataIndex({ ...imported, metadata: alternate });
  const page = await chrome.page(t);
  // The fixture document is served on the apps origin, so the apps module it imports is same-origin.
  const corpusPage = appsOrigin(sim, origin) + '/provenance-corpus';
  await page.route(corpusPage, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' }),
  );
  await page.goto(corpusPage);
  await page.evaluate(
    async (assetUrl) => {
      const { createModelDrivenProvenanceRegistry } = await import(assetUrl);
      window.fixtureWriter = createModelDrivenProvenanceRegistry(document);
      window.fixtureWriter.install();
      const surface = document.createElement('div');
      surface.id = 'fixture-surface';
      document.body.append(surface);
    },
    appsOrigin(sim, origin) + '/_apps/assets/provenance-registry.mjs',
  );
  const controller = await startModelDrivenInspector({
    context: page.context(),
    page,
    imported,
    overlay: createModelDrivenOverlay({ origin: appsOrigin(sim, origin), imported, localSimulation: true }),
    cfg: {
      origin: appsOrigin(sim, origin),
      sourceDir: solutionDir,
      projectRoot: root,
      stateDir: path.join(root, '.paqvilo'),
      siteName: 'fixture',
      envName: 'test',
      agent: { enabled: false },
    },
    stop() {},
  });
  ownedFixture(t).add(() => controller.close());
  await page.waitForFunction(() => document.getElementById('paqvilo-xray')?.__px);
  const nativePage = await chrome.page(t);
  const nativeUrl = origin + '/native-corpus';
  await nativePage.route(nativeUrl, (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><main></main>' }),
  );
  await nativePage.goto(nativeUrl);
  await nativePage.evaluate(() => {
    const surface = document.createElement('div');
    surface.id = 'fixture-native-surface';
    document.body.append(surface);
  });
  const nativeController = await startModelDrivenInspector({
    context: nativePage.context(),
    page: nativePage,
    imported,
    overlay: createModelDrivenOverlay({ origin, imported }),
    cfg: {
      origin,
      sourceDir: solutionDir,
      projectRoot: root,
      stateDir: path.join(root, '.paqvilo'),
      siteName: 'fixture',
      envName: 'test',
      agent: { enabled: false },
    },
    stop() {},
  });
  ownedFixture(t).add(() => nativeController.close());
  await nativePage.waitForFunction(() => document.getElementById('paqvilo-xray')?.__px);
  // The corpus once turned a declared mountedComponent into a registry write.
  // Use the actual shell/mount lifecycle for these risks instead. The shell
  // admits desktop bindings; phone/tablet declarations alone do not select a
  // different implementation. No native-device behaviour is inferred here.
  let realPcf;
  const observePcf = () =>
    (realPcf ??= (async () => {
      const fixture = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
      const writeControl = async (name, dataset = false) => {
        const dir = path.join(fixture.solutionDir, 'Controls', name);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(
          path.join(dir, 'ControlManifest.xml'),
          `<manifest><control namespace="Fixture" constructor="${name}" control-type="standard">${dataset ? '<data-set name="records"/>' : '<property name="value" of-type="SingleLine.Text" usage="bound"/>'}<resources><code path="bundle.js" order="1"/></resources></control></manifest>`,
        );
        await fs.writeFile(
          path.join(dir, 'ControlManifest.xml.data.xml'),
          `<CustomControl><Name>Fixture.${name}</Name></CustomControl>`,
        );
        const bundle = path.join(dir, 'bundle.js');
        await fs.writeFile(
          bundle,
          `ComponentFramework.registerControl('Fixture.${name}',class{init(context,notify,state,container){this.node=document.createElement('span');this.node.dataset.testid='pcf-${name}';container.append(this.node)}updateView(context){${dataset ? 'this.node.dataset.view=context.parameters.records.getViewId()' : ''}}destroy(){this.node.remove()}});`,
        );
        return bundle;
      };
      const scalarBundle = await writeControl('Scalar');
      await writeControl('PhoneScalar');
      const datasetBundle = await writeControl('Dataset', true);
      await writeControl('TabletDataset', true);
      const defaultView = guid(801),
        currentView = guid(802);
      for (const [relative, oldId, newId] of [
        ['Entities/x_item/SavedQueries/items.xml', 'items-view', defaultView],
        ['Entities/x_child/SavedQueries/children.xml', 'children-view', currentView],
      ]) {
        const file = path.join(fixture.solutionDir, relative);
        await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replaceAll(oldId, newId));
      }
      const form = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
      const original = (await fs.readFile(form, 'utf8')).replaceAll('children-view', currentView);
      await fs.writeFile(
        form,
        original
          .replace(
            '<control datafieldname="x_name"/>',
            '<control id="fixture_scalar" uniqueid="{10000000-0000-4000-8000-000000000038}" datafieldname="x_name"/>',
          )
          .replace(
            '</form>',
            `<controlDescriptions><controlDescription forControl="{10000000-0000-4000-8000-000000000038}"><customControl name="Fixture.Scalar" formFactor="0"><parameters><value type="bound">x_name</value></parameters></customControl><customControl name="Fixture.PhoneScalar" formFactor="2"><parameters><value type="bound">x_name</value></parameters></customControl></controlDescription><controlDescription forControl="children"><customControl name="Fixture.Dataset" formFactor="0"><parameters><data-set name="records"><ViewId>{${defaultView}}</ViewId><TargetEntityType>x_child</TargetEntityType></data-set></parameters></customControl><customControl name="Fixture.TabletDataset" formFactor="1"><parameters><data-set name="records"><ViewId>{${defaultView}}</ViewId><TargetEntityType>x_child</TargetEntityType></data-set></parameters></customControl></controlDescription></controlDescriptions></form>`,
          ),
      );
      const sim = await fixture.start();
      const importedPcf = await importModelDrivenProject({
        solutionRoots: [fixture.solutionDir],
        solutionOrder: 'explicit',
        modelDriven: { trustedExtensions: true },
      });
      const pcfIndex = createModelDrivenMetadataIndex(importedPcf);
      const details = pcfIndex.query({
        active: { formId: 'item-form' },
        componentKeys: ['pcf:fixture.scalar', 'pcf:fixture.dataset'],
      });
      const pcfPage = await chrome.page(t);
      const pcfScope = { documentId: 'pcf-document', frameId: 'pcf-frame', uiEpoch: 1, sourceRevision: '1' };
      const install = () =>
        pcfPage.evaluate(
          `(${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: 'pcf-corpus', origin: appsOrigin(sim, sim.url), localSimulation: true, ...details, validatedScope: pcfScope, validatedAnchorGeneration: 1 })})`,
        );
      const inspect = async (locator) => {
        const packet = await locator.evaluate(
          (node, suppliedScope) =>
            window.__paqviloModelDrivenProvider.query(node, { scope: suppliedScope, anchorGeneration: 1 }),
          pcfScope,
        );
        return {
          packet,
          evidence: resolveInspectionEvidence({ ...packet, scope: pcfScope, node: { connected: true } }),
        };
      };
      await pcfPage.goto(
        appsOrigin(sim, sim.url) +
          '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      await pcfPage.getByTestId('pcf-Scalar').waitFor({ state: 'attached' });
      await pcfPage.waitForFunction(
        () =>
          document.querySelector('[data-testid="pcf-Scalar"]')?.closest('.model-driven-pcf')?.dataset.pcfState ===
          'ready',
      );
      await install();
      const scalar = await inspect(pcfPage.getByTestId('pcf-Scalar'));
      await pcfPage.getByRole('tab', { name: 'Related items', exact: true }).click();
      await pcfPage.getByTestId('pcf-Dataset').waitFor({ state: 'attached' });
      await pcfPage.waitForFunction(
        () =>
          document.querySelector('[data-testid="pcf-Dataset"]')?.closest('.model-driven-pcf')?.dataset.pcfState ===
          'ready',
      );
      const dataset = await inspect(pcfPage.getByTestId('pcf-Dataset'));
      for (const result of [scalar, dataset]) {
        assert.equal(result.evidence.owner.status, 'exact');
        assert.equal(result.evidence.source.status, 'exact');
        assert.ok(result.evidence.facts.some((fact) => fact.label === 'pcf-form-factor-0'));
        for (const ref of result.evidence.source.refs.filter((ref) => ref.status === 'exact'))
          assert.equal(digest(await fs.readFile(ref.ref)), ref.contentRevision);
      }
      assert.equal(scalar.evidence.owner.component.key, 'pcf:fixture.scalar');
      assert.equal(dataset.evidence.owner.component.key, 'pcf:fixture.dataset');
      assert.ok(
        dataset.packet.contextFacts.some(
          (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:' + currentView,
        ),
      );
      assert.ok(
        !dataset.packet.contextFacts.some(
          (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:' + defaultView,
        ),
      );
      assert.equal(await pcfPage.getByTestId('pcf-PhoneScalar').count(), 0);
      assert.equal(await pcfPage.getByTestId('pcf-TabletDataset').count(), 0);
      for (const [file, name] of [
        [scalarBundle, 'Scalar'],
        [datasetBundle, 'Dataset'],
      ])
        await fs.writeFile(
          file,
          `ComponentFramework.registerControl('Fixture.${name}',class{init(){throw Error('Invented mount failure')}updateView(){}destroy(){}});`,
        );
      await sim.reload();
      await pcfPage.reload();
      await pcfPage.locator('.model-driven-pcf[data-pcf-state="unsupported"]').first().waitFor();
      await install();
      const scalarFailure = await inspect(pcfPage.locator('.model-driven-pcf[data-pcf-state="unsupported"]').first());
      await pcfPage.getByRole('tab', { name: 'Related items', exact: true }).click();
      const failedDatasetNode = pcfPage.locator('.model-driven-pcf[data-pcf-state="unsupported"]').first();
      await failedDatasetNode.waitFor();
      const datasetFailure = await inspect(failedDatasetNode);
      const failedGrid = await inspect(
        failedDatasetNode.locator(
          'xpath=ancestor::*[contains(concat(" ", normalize-space(@class), " "), " related-grid ")][1]',
        ),
      );
      for (const result of [scalarFailure, datasetFailure]) {
        assert.equal(result.evidence.owner.component.kind, 'platform-control');
        assert.equal(result.evidence.source.status, 'unavailable');
        assert.ok(result.packet.availability.some((item) => item.reason === 'failed'));
      }
      return { scalar, dataset, scalarFailure, datasetFailure, failedGrid, currentView, defaultView };
    })());
  let realGrid;
  const observeGrid = () =>
    (realGrid ??= (async () => {
      const fixture = await modelDrivenFixture(t, { defer: true });
      const oldView = guid(811),
        newView = guid(812);
      const viewFile = path.join(fixture.solutionDir, 'Entities/x_child/SavedQueries/children.xml');
      const view = await fs.readFile(viewFile, 'utf8');
      await fs.writeFile(viewFile, view.replaceAll('children-view', oldView));
      await fs.writeFile(
        path.join(path.dirname(viewFile), 'alternate.xml'),
        view
          .replaceAll('children-view', newView)
          .replace('<isdefault>1</isdefault>', '<isdefault>0</isdefault>')
          .replace('description="Children"', 'description="Alternate children"'),
      );
      const formFile = path.join(fixture.solutionDir, 'Entities/x_item/FormXml/main/item.xml');
      await fs.writeFile(
        formFile,
        (await fs.readFile(formFile, 'utf8'))
          .replaceAll('children-view', oldView)
          .replace(
            '<RecordsPerPage>10</RecordsPerPage>',
            `<RecordsPerPage>10</RecordsPerPage><EnableViewPicker>true</EnableViewPicker><ViewIds>{${oldView}},{${newView}}</ViewIds>`,
          ),
      );
      const sim = await fixture.start();
      const importedGrid = await importModelDrivenProject({
        solutionRoots: [fixture.solutionDir],
        solutionOrder: 'explicit',
      });
      const gridIndex = createModelDrivenMetadataIndex(importedGrid);
      const details = gridIndex.query({
        active: { formId: 'item-form' },
        componentKeys: ['view:' + oldView, 'view:' + newView],
      });
      const gridPage = await chrome.page(t);
      const gridScope = { documentId: 'grid-document', frameId: 'grid-frame', uiEpoch: 1, sourceRevision: '1' };
      await gridPage.goto(
        appsOrigin(sim, sim.url) +
          '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      await gridPage.getByRole('tab', { name: 'Related items', exact: true }).click();
      const grid = gridPage.locator('.related-grid');
      await grid.getByRole('button', { name: 'Copper child', exact: true }).waitFor();
      await gridPage.evaluate(
        `(${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: 'grid-corpus', origin: appsOrigin(sim, sim.url), localSimulation: true, ...details, validatedScope: gridScope, validatedAnchorGeneration: 1 })})`,
      );
      const inspect = async () => {
        const packet = await grid.evaluate(
          (node, suppliedScope) =>
            window.__paqviloModelDrivenProvider.query(node, { scope: suppliedScope, anchorGeneration: 1 }),
          gridScope,
        );
        return {
          packet,
          evidence: resolveInspectionEvidence({ ...packet, scope: gridScope, node: { connected: true } }),
        };
      };
      const initial = await inspect();
      const held = Promise.withResolvers(),
        release = Promise.withResolvers();
      t.after(() => release.resolve());
      await gridPage.route(
        '**/_apps/api/tables/x_child?query=*',
        async (route) => {
          held.resolve();
          await release.promise;
          await route.continue();
        },
        { times: 1 },
      );
      await grid.getByRole('button', { name: 'View for Related children', exact: true }).click();
      await gridPage.getByRole('menuitemradio', { name: 'Alternate children', exact: true }).click();
      await held.promise;
      const pending = await inspect();
      release.resolve();
      await gridPage.waitForFunction(
        () => document.querySelector('.related-results')?.getAttribute('aria-busy') === 'false',
      );
      const final = await inspect();
      const viewRefs = gridIndex.sourceRefsFor(['view:' + newView]);
      assert.ok(viewRefs.length);
      for (const ref of viewRefs) assert.equal(digest(await fs.readFile(ref.ref)), ref.contentRevision);
      return { initial, pending, final, oldView, newView, viewRefs };
    })());
  let realResource;
  const observeResource = () =>
    (realResource ??= (async () => {
      const fixture = await modelDrivenFixture(t, { defer: true, modelDriven: { trustedExtensions: true } });
      const resourceFile = path.join(fixture.solutionDir, 'WebResources/fixture_page.html');
      await fs.mkdir(path.dirname(resourceFile), { recursive: true });
      const content = '<h1>Invented resource body</h1>';
      await fs.writeFile(resourceFile, content);
      await fs.writeFile(
        resourceFile + '.data.xml',
        '<WebResource><WebResourceId>40000000-0000-4000-8000-000000000001</WebResourceId><Name>fixture_page.html</Name><WebResourceType>1</WebResourceType><FileName>WebResources/fixture_page.html</FileName></WebResource>',
      );
      const sitemap = path.join(fixture.solutionDir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
      await fs.writeFile(
        sitemap,
        (await fs.readFile(sitemap, 'utf8')).replace(
          '<SubArea Id="external"',
          '<SubArea Id="fixture_page" Url="$webresource:fixture_page.html"><Titles><Title LCID="1033" Title="Fixture page"/></Titles></SubArea><SubArea Id="external"',
        ),
      );
      await fs.writeFile(
        path.join(fixture.solutionDir, 'Entities/x_item/RibbonDiff.xml'),
        '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Inspect" Command="x.Inspect" LabelText="Fixture exported command"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Inspect"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>',
      );
      const sim = await fixture.start();
      const importedResource = await importModelDrivenProject({
        solutionRoots: [fixture.solutionDir],
        solutionOrder: 'explicit',
      });
      const resourceIndex = createModelDrivenMetadataIndex(importedResource);
      const details = resourceIndex.query({
        componentKeys: ['resource:fixture_page.html', 'command:x_item:x.form.inspect'],
        active: { formId: 'item-form' },
      });
      const resourcePage = await chrome.page(t, { viewport: { width: 1920, height: 1080 } });
      const resourceScope = {
        documentId: 'resource-document',
        frameId: 'resource-frame',
        uiEpoch: 1,
        sourceRevision: '1',
      };
      await resourcePage.goto(
        appsOrigin(sim, sim.url) +
          '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      );
      const commandNode = resourcePage.getByRole('button', { name: 'Fixture exported command', exact: true });
      await commandNode.waitFor({ state: 'attached' });
      await resourcePage.evaluate(
        `(${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: 'resource-corpus', origin: appsOrigin(sim, sim.url), localSimulation: true, ...details, validatedScope: resourceScope, validatedAnchorGeneration: 1 })})`,
      );
      const inspect = async (locator) => {
        const packet = await locator.evaluate(
          (node, suppliedScope) =>
            window.__paqviloModelDrivenProvider.query(node, { scope: suppliedScope, anchorGeneration: 1 }),
          resourceScope,
        );
        return {
          packet,
          evidence: resolveInspectionEvidence({ ...packet, scope: resourceScope, node: { connected: true } }),
        };
      };
      const command = await inspect(commandNode);
      const platformCommand = await inspect(resourcePage.getByRole('button', { name: 'New', exact: true }));
      await resourcePage.getByRole('button', { name: 'Fixture page', exact: true }).click();
      const frame = resourcePage.locator('iframe.webresource-page');
      await frame.waitFor();
      await resourcePage
        .frameLocator('iframe.webresource-page')
        .getByRole('heading', { name: 'Invented resource body', exact: true })
        .waitFor();
      await resourcePage.evaluate(
        `(${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: 'resource-corpus', origin: appsOrigin(sim, sim.url), localSimulation: true, ...details, validatedScope: resourceScope, validatedAnchorGeneration: 1 })})`,
      );
      const packet = await frame.evaluate(
        (node, suppliedScope) =>
          window.__paqviloModelDrivenProvider.query(node, { scope: suppliedScope, anchorGeneration: 1 }),
        resourceScope,
      );
      const evidence = resolveInspectionEvidence({ ...packet, scope: resourceScope, node: { connected: true } });
      const url = await frame.getAttribute('src');
      const response = await fetch(new URL(url, appsOrigin(sim, sim.url)));
      assert.equal(response.status, 200);
      assert.equal(await response.text(), content);
      return {
        packet,
        evidence,
        url,
        resourceFile,
        content,
        origin: appsOrigin(sim, sim.url),
        command,
        platformCommand,
      };
    })());
  const results = [];
  for (const scenario of scenarios)
    await t.test(
      scenario.id === 'dataset-tablet-mounted'
        ? 'dataset-tablet-mounted — desktop dataset host does not select a tablet-only dataset declaration'
        : scenario.id === 'scalar-phone-current-binding'
          ? 'scalar-phone-current-binding — desktop scalar host does not select a phone-only scalar declaration'
          : scenario.id === 'dataset-mount-failure-keeps-grid-owner-and-native-view'
            ? 'failed dataset mount retains exact grid owner and refuses current-view attribution'
            : scenario.id,
      async () => {
        if (
          ['exported-command-exact-host-binding', 'oob-command-exact-owner-export-source-unavailable'].includes(
            scenario.id,
          )
        ) {
          const resource = await observeResource();
          const command =
            scenario.id === 'exported-command-exact-host-binding' ? resource.command : resource.platformCommand;
          assert.equal(command.evidence.owner.status, 'exact');
          if (scenario.id === 'exported-command-exact-host-binding') {
            assert.equal(command.evidence.owner.component.key, 'command:x_item:x.form.inspect');
            assert.equal(command.evidence.source.status, 'exact');
            const source = command.evidence.source.refs.find(
              (ref) => ref.componentKey === 'command:x_item:x.form.inspect',
            );
            assert.ok(source);
            assert.equal(digest(await fs.readFile(source.ref)), source.contentRevision);
          } else {
            assert.equal(command.evidence.source.status, 'unavailable');
            assert.notEqual(command.evidence.owner.component.key, 'command:x_item:x.form.inspect');
          }
          results.push({
            id: scenario.id,
            mode: 'real-command-host',
            owner: command.evidence.owner.status,
            source: command.evidence.source.status,
            previousExpected: scenario.previousExpected,
          });
          return;
        }
        if (
          [
            'loaded-resource-declared-content-and-source-exact',
            'hashed-resource-requires-exact-declared-asset-join',
          ].includes(scenario.id)
        ) {
          const resource = await observeResource();
          assert.equal(resource.evidence.owner.status, 'exact');
          assert.equal(resource.evidence.owner.component.key, 'resource:fixture_page.html');
          assert.equal(resource.evidence.source.status, 'exact');
          const ref = resource.evidence.source.refs.find((item) => item.componentKey === 'resource:fixture_page.html');
          assert.ok(ref);
          assert.equal(digest(await fs.readFile(resource.resourceFile)), ref.contentRevision);
          assert.match(resource.url, /^\/_apps\/resources\//);
          if (scenario.id === 'hashed-resource-requires-exact-declared-asset-join') {
            const wrong = new URL(resource.url, resource.origin);
            wrong.pathname += '-unrelated';
            assert.equal((await fetch(wrong)).status, 404, 'a different asset token cannot resolve the declared bytes');
          }
          results.push({
            id: scenario.id,
            mode: 'real-resource-host',
            owner: resource.evidence.owner.status,
            source: resource.evidence.source.status,
            previousExpected: scenario.previousExpected,
          });
          return;
        }
        if (
          [
            'async-grid-load-preserves-grid-owner-not-old-view',
            'subgrid-owner-and-runtime-view-have-separate-sources',
          ].includes(scenario.id)
        ) {
          const grid = await observeGrid();
          const hasView = (result, id) =>
            result.packet.contextFacts.some(
              (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:' + id,
            );
          assert.equal(grid.initial.evidence.owner.status, 'exact');
          assert.equal(grid.initial.evidence.source.status, 'exact');
          assert.ok(hasView(grid.initial, grid.oldView));
          assert.equal(grid.pending.evidence.owner.component.key, grid.initial.evidence.owner.component.key);
          assert.equal(grid.pending.evidence.owner.status, 'exact');
          assert.ok(
            grid.pending.packet.availability.some(
              (item) => item.capability === 'subgrid-current-view' && item.reason === 'pending',
            ),
          );
          assert.equal(hasView(grid.pending, grid.oldView), false);
          assert.equal(hasView(grid.pending, grid.newView), false);
          assert.ok(hasView(grid.final, grid.newView));
          assert.equal(hasView(grid.final, grid.oldView), false);
          if (scenario.id === 'subgrid-owner-and-runtime-view-have-separate-sources') {
            assert.equal(grid.final.evidence.source.status, 'exact');
            assert.ok(grid.viewRefs.every((ref) => ref.componentKey === 'view:' + grid.newView));
            assert.ok(grid.final.evidence.source.refs.every((ref) => ref.componentKey !== 'view:' + grid.newView));
          }
          results.push({
            id: scenario.id,
            mode: 'real-subgrid-host',
            owner: grid.final.evidence.owner.status,
            source: grid.final.evidence.source.status,
            previousExpected: scenario.previousExpected,
          });
          return;
        }
        if (scenario.category === 'pcf') {
          const observed = await observePcf();
          const failure = scenario.id.includes('failure');
          const dataset = scenario.id.startsWith('dataset-');
          const result = failure
            ? dataset
              ? observed.datasetFailure
              : observed.scalarFailure
            : dataset
              ? observed.dataset
              : observed.scalar;
          // FormFactor 1/2 entries are unsupported selection inputs in this
          // shell. The desktop mount and absence of those implementations are
          // asserted by observePcf rather than claiming a phone/tablet mount.
          if (failure) {
            assert.equal(result.evidence.owner.component.kind, 'platform-control');
            assert.equal(result.evidence.source.status, 'unavailable');
            assert.ok(result.packet.availability.some((item) => item.reason === 'failed'));
          } else {
            assert.equal(result.evidence.owner.status, 'exact');
            assert.equal(result.evidence.owner.component.key, dataset ? 'pcf:fixture.dataset' : 'pcf:fixture.scalar');
            assert.equal(result.evidence.source.status, 'exact');
            assert.ok(result.evidence.facts.some((fact) => fact.label === 'pcf-form-factor-0'));
          }
          if (scenario.id === 'dataset-current-view-independent-from-binding-default') {
            assert.notEqual(observed.currentView, observed.defaultView);
            assert.ok(
              result.packet.contextFacts.some(
                (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:' + observed.currentView,
              ),
            );
            assert.ok(
              !result.packet.contextFacts.some(
                (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:' + observed.defaultView,
              ),
            );
          }
          if (scenario.id === 'dataset-mount-failure-keeps-grid-owner-and-native-view') {
            assert.equal(result.evidence.owner.status, 'exact');
            assert.equal(result.evidence.owner.component.key, 'platform-control:pcf-failed');
            assert.ok(
              result.packet.availability.some(
                (item) => item.capability === 'component-mount' && item.reason === 'failed',
              ),
            );
            assert.ok(
              result.packet.contextFacts.some((fact) => fact.binding.key === 'control:item-form:children:body'),
            );
            assert.ok(
              result.packet.contextFacts.some(
                (fact) => fact.binding.key === 'pcf:fixture.dataset' && fact.predicate === 'configured-implementation',
              ),
            );
            assert.equal(observed.failedGrid.evidence.owner.status, 'exact');
            assert.equal(observed.failedGrid.evidence.owner.component.key, 'control:item-form:children:body');
            assert.ok(
              observed.failedGrid.packet.availability.some(
                (item) => item.capability === 'subgrid-current-view' && item.reason === 'failed',
              ),
            );
            for (const packet of [result.packet, observed.failedGrid.packet])
              assert.ok(
                !packet.contextFacts.some(
                  (fact) =>
                    fact.predicate === 'current-view' &&
                    ['view:' + observed.currentView, 'view:' + observed.defaultView].includes(fact.binding.key),
                ),
              );
          }
          if (scenario.id === 'scalar-phone-current-binding' || scenario.id === 'phone-binding-not-desktop-default')
            assert.notEqual(
              result.evidence.owner.component.key,
              'pcf:fixture.phonescalar',
              'phone-only declaration is not selected by this desktop host',
            );
          if (scenario.id === 'dataset-tablet-mounted')
            assert.notEqual(
              result.evidence.owner.component.key,
              'pcf:fixture.tabletdataset',
              'tablet-only declaration is not selected by this desktop host',
            );
          results.push({
            id: scenario.id,
            mode: 'real-desktop-pcf-host',
            owner: result.evidence.owner.status,
            source: result.evidence.source.status,
            previousExpected: scenario.previousExpected,
          });
          return;
        }
        const values = scenario.facts,
          native = scenario.host === 'native';
        const sourceDefinitions = values.filter((fact) => fact.predicate === 'exportSource');
        const ownerValues = values
          .filter(
            (fact) =>
              fact.predicate === 'selectedOwner' ||
              (fact.predicate === 'currentView' &&
                fact.via === 'mirage.host.binding' &&
                !values.some((item) => item.predicate === 'selectedOwner')),
          )
          .map((fact) => fact.object);
        const missing =
          values.some((fact) => fact.predicate === 'sourceRead' && fact.object.state !== 'available') ||
          scenario.id === 'bounded-response-defers-source-retains-exact-owner';
        let sources = sourceDefinitions.flatMap((fact) => index.sourceRefsFor([keyOf(fact.object.componentRef)]));
        if (scenario.id === 'bounded-response-defers-source-retains-exact-owner') {
          const bounded = index.query({
            active: { formId: guid(1205), controlNames: ['fixture_long_1104'] },
            budget: { items: 1, bytes: 256 },
          });
          assert.equal(bounded.limits.truncated, true);
          sources = bounded.sourceRefs;
          assert.equal(sources.length, 0, 'the real bounded metadata response deferred source references');
        }
        if (scenario.id === 'source-reference-known-file-unavailable') {
          const absentFile = path.join(solutionDir, 'Entities/fixture_case/FormXml/main/missing.xml');
          await assert.rejects(fs.stat(absentFile), { code: 'ENOENT' });
          const unavailable = structuredClone(imported.metadata);
          unavailable.forms = unavailable.forms.map((form) =>
            form.id === main ? { ...form, file: absentFile } : form,
          );
          const missingIndex = createModelDrivenMetadataIndex({ ...imported, metadata: unavailable });
          assert.ok(
            index.sourceRefsFor([keyOf(ownerValues[0])]).length,
            'the present source is independently resolvable',
          );
          sources = missingIndex.sourceRefsFor([keyOf(ownerValues[0])]);
          assert.deepEqual(sources, [], 'reading the absent source cannot manufacture a reference');
        }
        if (scenario.id === 'same-component-layer-source-conflict')
          sources = [
            ...index.sourceRefsFor([keyOf(ownerValues[0])]),
            ...alternateIndex.sourceRefsFor([keyOf(ownerValues[0])]),
          ];
        if (values.some((fact) => fact.predicate === 'metadataAvailability' && fact.object === 'not-requested')) {
          assert.equal(sourceDefinitions.length, 0);
          assert.ok(index.sourceRefsFor([keyOf(ownerValues[0])]).length, 'the definition exists when it is requested');
          assert.deepEqual(sources, [], 'this packet did not request that definition');
        }
        if (values.some((fact) => fact.predicate === 'sourceKind' && ['generated', 'platform'].includes(fact.object)))
          assert.deepEqual(
            index.sourceRefsFor([keyOf(ownerValues[0])]),
            [],
            'the bound generated/platform component has no exported definition',
          );
        if (scenario.id === 'trusted-layer-order-resolves-source') {
          const base = path.join(root, 'ordered-base'),
            layer = path.join(root, 'ordered-layer');
          const baseForm = path.join(base, 'Entities/fixture_case/FormXml/main/fixture.xml');
          const layerForm = path.join(layer, 'Entities/fixture_case/FormXml/main/fixture.xml');
          for (const [directory, file, name] of [
            [base, baseForm, 'InventedOrderedBase'],
            [layer, layerForm, 'InventedOrderedLayer'],
          ]) {
            await fs.mkdir(path.dirname(file), { recursive: true });
            await fs.mkdir(path.join(directory, 'Other'), { recursive: true });
            await fs.writeFile(
              path.join(directory, 'Other/Solution.xml'),
              `<ImportExportXml><SolutionManifest><UniqueName>${name}</UniqueName></SolutionManifest></ImportExportXml>`,
            );
          }
          await fs.copyFile(formFile, baseForm);
          await fs.copyFile(alternateFile, layerForm);
          const ordered = createModelDrivenMetadataIndex(
            await importModelDrivenProject({ solutionRoots: [base, layer], solutionOrder: 'explicit' }),
          );
          const reversed = createModelDrivenMetadataIndex(
            await importModelDrivenProject({ solutionRoots: [layer, base], solutionOrder: 'explicit' }),
          );
          sources = ordered.sourceRefsFor([keyOf(ownerValues[0])]);
          const reversedSources = reversed.sourceRefsFor([keyOf(ownerValues[0])]);
          assert.ok(
            sources.some((ref) => path.resolve(ref.ref) === path.resolve(layerForm)),
            'the later explicitly ordered layer supplies the source',
          );
          assert.ok(
            reversedSources.some((ref) => path.resolve(ref.ref) === path.resolve(baseForm)),
            'reversing the order restores the base source',
          );
        }
        if (scenario.category === 'active-metadata' && !missing) {
          const active = scenario.id.includes('view')
            ? { viewId: guid(4205) }
            : scenario.id.includes('old-global')
              ? { formId: guid(1205), controlNames: ['fixture_long_1104'] }
              : { formId: main, controlNames: ['header_fixture_title'] };
          const details = index.query({ active, budget: { items: 12, bytes: 16384 } });
          assert.ok(Buffer.byteLength(JSON.stringify(details)) <= details.limits.maxBytes);
          if (active.viewId) assert.equal(details.catalogue.views[0].id, active.viewId);
          else {
            assert.equal(details.catalogue.forms[0].id, active.formId);
            assert.equal(details.catalogue.forms[0].controls[0].id, active.controlNames[0]);
            assert.deepEqual(details.catalogue.forms[0].regions, ['header', 'body', 'footer']);
            if (scenario.id === 'active-header-footer-tab-structure-must-not-be-dropped') {
              const complete = index.query({ active, budget: { items: 200, bytes: 256 * 1024 } });
              const form = complete.catalogue.forms[0];
              assert.ok(form.controls.some((control) => control.id === 'header_fixture_title'));
              assert.ok(form.controls.some((control) => control.id === 'footer_fixture_title'));
              assert.ok(form.controls.some((control) => control.id === 'fixture_title'));
              assert.ok(form.structure.length, 'the actual form structure is retained');
            }
          }
          sources = details.sourceRefs;
        }
        let packet, scope;
        if (native) {
          const current = values.find(
            (fact) => ['currentForm', 'enclosingForm'].includes(fact.predicate) && !fact.via.startsWith('parent.'),
          )?.object;
          const requestedForm = values
            .find((fact) => fact.predicate === 'requestedForm')
            ?.object?.split(':')
            .at(-1);
          const requestedView = values
            .find((fact) => fact.predicate === 'requestedView')
            ?.object?.split(':')
            .at(-1);
          const domName = values.find((fact) =>
            ['domControlName', 'attributeName', 'domCommandToken', 'domBindingToken'].includes(fact.predicate),
          )?.object;
          const forgedBinding = values.find((fact) => fact.predicate === 'domBindingToken')?.object;
          const commandToken = values.find((fact) => fact.predicate === 'domCommandToken')?.object;
          const selectorState = values.find((fact) => fact.predicate === 'currentFormSelector')?.object?.state;
          const operationFormType = values.find((fact) => fact.predicate === 'operationFormType')?.object ?? 1;
          const declaredStructure = values.find((fact) => fact.predicate === 'currentControlStructure')?.object;
          const mainGrid = scenario.id === 'runtime-current-view-differs-from-configured-default';
          await nativePage.evaluate(
            ({
              current,
              requestedForm,
              requestedView,
              domName,
              forgedBinding,
              commandToken,
              controls,
              selectorState,
              operationFormType,
              mainGrid,
              declaredStructure,
            }) => {
              const surface = document.getElementById('fixture-native-surface');
              surface.replaceChildren();
              window.fixtureForbiddenReads = 0;
              window.fixtureApiReads = { selector: 0, formType: 0 };
              const node = document.createElement(commandToken ? 'button' : domName ? 'input' : 'form');
              if (domName && !commandToken) node.setAttribute('name', domName);
              if (commandToken) node.setAttribute('data-id', `fixture_case|NoRelationship|Form|${commandToken}`);
              if (forgedBinding) node.setAttribute('data-id', forgedBinding);
              surface.append(node);
              const forbidden = () => {
                window.fixtureForbiddenReads++;
                throw Error('Record/user reads are forbidden');
              };
              const names = declaredStructure
                ? [...declaredStructure.controls, ...(declaredStructure.complete ? [] : ['fixture_unobserved'])]
                : controls.map(([, name]) => name);
              const rows = names.map((name) => ({
                getName: () => name,
                getControlType: () => 'standard',
                getAttribute: () => ({ getName: () => 'fixture_title', getValue: forbidden }),
              }));
              const collection = (items) => ({ getLength: () => items.length, get: (position) => items[position] });
              window.Xrm = {
                Utility: {
                  getPageContext: () => ({
                    input: {
                      pageType: mainGrid ? 'entitylist' : 'entityrecord',
                      entityName: 'fixture_case',
                      formId: requestedForm,
                      viewId: requestedView,
                    },
                  }),
                  getGlobalContext: forbidden,
                },
                Page: {
                  data: { entity: { getEntityName: () => 'fixture_case', getId: forbidden } },
                  ui: {
                    formSelector:
                      selectorState === 'unsupported'
                        ? {}
                        : {
                            getCurrentItem: () => {
                              window.fixtureApiReads.selector++;
                              return current ? { getId: () => current.split(':').at(-1) } : null;
                            },
                          },
                    getFormType: () => {
                      window.fixtureApiReads.formType++;
                      return operationFormType;
                    },
                    controls: collection(rows),
                    tabs: collection([]),
                    quickForms: collection([]),
                  },
                  getControl: (name) => rows.find((row) => row.getName() === name),
                },
              };
            },
            {
              current,
              requestedForm,
              requestedView,
              domName,
              forgedBinding,
              commandToken,
              controls,
              selectorState,
              operationFormType,
              mainGrid,
              declaredStructure,
            },
          );
          if (scenario.id === 'similar-resource-basename-is-not-declared-resource') {
            await nativePage.route('**/resource-fixture/**/fixture_script.js', (route) =>
              route.fulfill({
                contentType: 'text/javascript',
                body: 'window.fixtureResourceLoads=(window.fixtureResourceLoads||0)+1;',
              }),
            );
            try {
              const loaded = await nativePage.evaluate(async () => {
                for (const part of ['first', 'second']) {
                  const script = document.createElement('script');
                  script.src = '/resource-fixture/' + part + '/fixture_script.js';
                  await new Promise((resolve, reject) => {
                    script.onload = resolve;
                    script.onerror = reject;
                    document.body.append(script);
                  });
                }
                return {
                  count: window.fixtureResourceLoads,
                  urls: performance
                    .getEntriesByType('resource')
                    .map((entry) => new URL(entry.name).pathname)
                    .filter((name) => name.includes('/resource-fixture/')),
                };
              });
              assert.equal(loaded.count, 2);
              assert.deepEqual(loaded.urls.sort(), [
                '/resource-fixture/first/fixture_script.js',
                '/resource-fixture/second/fixture_script.js',
              ]);
            } finally {
              await nativePage.unroute('**/resource-fixture/**/fixture_script.js');
            }
          }
          const selection = await nativePage.evaluate(() => {
            const tools = document.getElementById('paqvilo-xray').__px;
            const node = document.getElementById('fixture-native-surface').firstElementChild;
            tools.select(node);
            return {
              scope: tools.getSelectionScope(node),
              anchorGeneration: tools.selectionState().anchorGeneration,
              token: tools.token,
            };
          });
          scope = selection.scope;
          const details = index.query({
            active: { formId: current?.split(':').at(-1) },
            ...(commandToken ? { componentKeys: ['command:fixture_case:fixture_action'] } : {}),
            budget: { items: 128, bytes: 256 * 1024 },
          });
          // Install and query in one task: the live inspector's own refresh reinstalls this token's
          // provider with unvalidated details, and must not land between the two.
          const observed = await nativePage.evaluate(`(() => {
            (${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: selection.token, origin, localSimulation: false, ...details, validatedScope: scope, validatedAnchorGeneration: selection.anchorGeneration })});
            window.fixtureForbiddenReads = 0;
            const packet = window.__paqviloModelDrivenProvider.query(
              document.getElementById('fixture-native-surface').firstElementChild,
              ${JSON.stringify({ scope: selection.scope, anchorGeneration: selection.anchorGeneration })},
            );
            return { packet, forbidden: window.fixtureForbiddenReads, reads: window.fixtureApiReads };
          })()`);
          packet = observed.packet;
          assert.equal(observed.forbidden, 0);
          assert.ok(observed.reads.formType > 0, 'the operation form type was read');
          assert.equal(packet.context.formType, operationFormType);
          if (selectorState === 'unsupported') {
            assert.equal(observed.reads.selector, 0);
            assert.equal(packet.context.availability.formSelector, 'unsupported');
          } else {
            assert.ok(observed.reads.selector > 0, 'the current form selector was read');
            if (selectorState === 'null') assert.equal(packet.context.availability.formSelector, 'null');
          }
          if (current) assert.equal(packet.context.formId, current.split(':').at(-1));
          if (requestedForm)
            assert.ok(
              packet.contextFacts.some(
                (fact) => fact.predicate === 'requested-form' && fact.binding.id === requestedForm,
              ),
            );
          if (requestedView)
            assert.ok(
              packet.contextFacts.some(
                (fact) => fact.predicate === 'requested-view' && fact.binding.id === requestedView,
              ),
            );
          if (scenario.id === 'duplicate-field-name-only-cannot-choose-control') {
            const ids = details.catalogue.forms.flatMap((form) => form.controls.map((control) => control.id));
            assert.ok(
              ids.includes('fixture_title') && ids.includes('fixture_title1'),
              'the form really has distinct controls for the same attribute',
            );
          }
          assert.ok(packet.facts.every((fact) => fact.proof !== 'mirage-registry'));
          if (mainGrid)
            assert.ok(
              packet.availability.some(
                (item) =>
                  item.capability === 'main-grid-current-view' &&
                  item.reason === 'documented-grid-context-not-supplied',
              ),
            );
          if (declaredStructure) {
            const structure = await nativePage.evaluate(
              `(${modelDrivenObservationRuntime.toString()})().observe(${JSON.stringify({ origin, scope, anchorGeneration: selection.anchorGeneration, budget: { items: declaredStructure.complete ? 128 : 1 } })})`,
            );
            assert.deepEqual(
              structure.controls.rows.map((row) => row.name),
              declaredStructure.controls,
            );
            assert.equal(structure.controls.complete, declaredStructure.complete);
            assert.equal(structure.context.formId, undefined, 'structure alone is not the current form selector');
            if (!declaredStructure.complete) assert.equal(structure.limits.truncated, true);
            const alternatives = values.find((fact) => fact.predicate === 'formControlStructures')?.object;
            if (alternatives) {
              const layer = path.join(root, 'structural-forms');
              await fs.mkdir(path.join(layer, 'Other'), { recursive: true });
              await fs.writeFile(
                path.join(layer, 'Other/Solution.xml'),
                '<ImportExportXml><SolutionManifest><UniqueName>InventedStructuralForms</UniqueName></SolutionManifest></ImportExportXml>',
              );
              for (const candidate of alternatives) {
                const id = candidate.form.split(':').at(-1);
                const file = path.join(layer, 'Entities/fixture_case/FormXml/main', id + '.xml');
                await fs.mkdir(path.dirname(file), { recursive: true });
                await fs.writeFile(
                  file,
                  `<systemform><formid>{${id}}</formid><form><tabs><tab><columns><column><sections><section><rows>${candidate.controls.map((name) => `<row><cell><control id="${name}" datafieldname="fixture_title"/></cell></row>`).join('')}</rows></section></sections></column></columns></tab></tabs></form></systemform>`,
                );
              }
              const structuralIndex = createModelDrivenMetadataIndex(
                await importModelDrivenProject({ solutionRoots: [layer], solutionOrder: 'explicit' }),
              );
              const observedNames = structure.controls.rows.map((row) => row.name).sort();
              const matches = [];
              for (const candidate of alternatives) {
                const id = candidate.form.split(':').at(-1);
                const details = structuralIndex.query({
                  active: { formId: id },
                  budget: { items: 128, bytes: 256 * 1024 },
                });
                const names = details.catalogue.forms
                  .find((form) => form.id === id)
                  ?.controls.map((control) => control.id)
                  .sort();
                if (JSON.stringify(names) === JSON.stringify(observedNames)) matches.push(id);
              }
              assert.deepEqual(
                matches,
                [alternatives[0].form.split(':').at(-1)],
                'the observed structure uniquely matches one exported form',
              );
            }
          }
          if (forgedBinding) {
            assert.equal(
              await nativePage.locator('#fixture-native-surface > input').getAttribute('data-id'),
              forgedBinding,
            );
            assert.ok(!packet.facts.some((fact) => fact.proof === 'mirage-registry'));
          }
          if (commandToken) {
            assert.ok(
              packet.facts.some(
                (fact) => fact.binding.key === 'command:fixture_case:fixture_action' && fact.proof === 'native-dom',
              ),
            );
            assert.ok(packet.sourceRefs.some((ref) => ref.componentKey === 'command:fixture_case:fixture_action'));
          }
          if (
            [
              'runtime-current-view-differs-from-configured-default',
              'hidden-selector-throws-default-remains-candidate',
              'personal-view-current-owner-without-solution-source',
            ].includes(scenario.id)
          ) {
            // queryNative supports a subgrid control, while a main-grid page input is
            // deliberately not a current-view API. Exercise the former separately;
            // the scenario's original packet above still tests the latter boundary.
            const viewFact = values.find((fact) => fact.predicate === 'currentView');
            const viewId = viewFact?.object.split(':').at(-1) ?? guid(12);
            const throws = scenario.id === 'hidden-selector-throws-default-remains-candidate';
            const grid = await nativePage.evaluate(
              `(() => {
                const node = document.createElement('div');
                node.setAttribute('data-id', 'dataSetRoot_fixture_grid');
                document.getElementById('fixture-native-surface').append(node);
                const original = Xrm.Page.getControl;
                const calls = { control: 0, selector: 0, current: 0 };
                Xrm.Page.getControl = name => {
                  if (name !== 'fixture_grid') return original(name);
                  calls.control++;
                  return { getViewSelector() { calls.selector++; return { getCurrentView() {
                    calls.current++;
                    if (${JSON.stringify(throws)}) throw Error('Invented hidden selector');
                    return { id: ${JSON.stringify(viewId)} };
                  } }; } };
                };
                try {
                  const packet = (${modelDrivenObservationRuntime.toString()})().queryNative(node, ${JSON.stringify({ scope, anchorGeneration: selection.anchorGeneration, data: { origin, catalogue: details.catalogue } })});
                  return { packet, calls };
                } finally { Xrm.Page.getControl = original; node.remove(); }
              })()`,
            );
            assert.ok(grid.calls.control > 0);
            assert.equal(grid.calls.selector, 1);
            assert.equal(grid.calls.current, 1);
            if (throws) {
              assert.ok(
                grid.packet.availability.some(
                  (item) => item.capability === 'subgrid-current-view' && item.reason === 'throws',
                ),
              );
              assert.ok(!grid.packet.contextFacts.some((fact) => fact.predicate === 'current-view'));
            } else {
              assert.ok(
                grid.packet.contextFacts.some(
                  (fact) => fact.predicate === 'current-view' && fact.binding.id === viewId,
                ),
              );
              const configured = values
                .find((fact) => fact.predicate === 'configuredDefaultView')
                ?.object?.split(':')
                .at(-1);
              if (configured) {
                assert.notEqual(viewId, configured);
                assert.ok(
                  !grid.packet.contextFacts.some(
                    (fact) => fact.predicate === 'current-view' && fact.binding.id === configured,
                  ),
                );
              }
            }
          }
          if (
            ['nested-cross-origin-frame-boundary', 'parent-frame-xrm-not-child-current-context'].includes(scenario.id)
          ) {
            const opaque = scenario.id === 'nested-cross-origin-frame-boundary';
            await nativePage.evaluate(async (opaque) => {
              let container = document.getElementById('fixture-native-surface');
              if (opaque) {
                const outer = document.createElement('iframe');
                outer.id = 'fixture-child-outer';
                const loaded = new Promise((resolve) => outer.addEventListener('load', resolve, { once: true }));
                outer.srcdoc = '<!doctype html><body></body>';
                container.append(outer);
                await loaded;
                container = outer.contentDocument.body;
              }
              const frame = document.createElement('iframe');
              frame.id = 'fixture-child-boundary';
              if (opaque) frame.setAttribute('sandbox', '');
              frame.srcdoc = '<form></form>';
              container.append(frame);
            }, opaque);
            const frame = await (
              opaque
                ? nativePage.frameLocator('#fixture-child-outer').locator('#fixture-child-boundary')
                : nativePage.locator('#fixture-child-boundary')
            ).elementHandle();
            const child = await frame.contentFrame();
            await child.waitForLoadState();
            const childPacket = await child.evaluate(
              `(${modelDrivenObservationRuntime.toString()})().queryNative(document.querySelector('form'),${JSON.stringify({ scope, anchorGeneration: selection.anchorGeneration, data: { origin, catalogue: details.catalogue } })})`,
            );
            assert.equal(childPacket.facts.length, 0);
            assert.ok(
              !childPacket.contextFacts.some((fact) => fact.binding.kind === 'form'),
              'parent current form is never inherited as child identity',
            );
            if (opaque)
              assert.ok(childPacket.availability.some((item) => item.reason === 'node-document-origin-boundary'));
            packet = childPacket;
          }
        } else {
          const bindings = ownerValues.map((key) => ({ key: keyOf(key), kind: key.split(':')[0] }));
          const context = values
            .filter((fact) =>
              ['enclosingForm', 'enclosingTable', 'currentDatasetView', 'currentView'].includes(fact.predicate),
            )
            .filter((fact) => !ownerValues.includes(fact.object))
            .map((fact) => ({
              key: keyOf(fact.object),
              kind: fact.object.split(':')[0],
              relationship: fact.predicate,
            }));
          packet = await page.evaluate(
            async ({ bindings, sources, context, assetUrl, domAttribute }) => {
              const surface = document.getElementById('fixture-surface');
              surface.replaceChildren();
              const node = document.createElement('input');
              node.setAttribute('data-id', 'forged-page-token');
              if (domAttribute) node.setAttribute('name', domAttribute);
              surface.append(node);
              const tools = document.getElementById('paqvilo-xray').__px;
              const scope = tools.getSelectionScope(node);
              window.fixtureWriter.beginUI();
              const { createModelDrivenProvenanceRegistry } = await import(assetUrl);
              const writers = bindings.map((binding, index) =>
                index ? createModelDrivenProvenanceRegistry(document) : window.fixtureWriter,
              );
              for (const [index, binding] of bindings.entries())
                writers[index].bind(node, {
                  owner: binding,
                  context,
                  sourceKeys: [binding.key],
                  sourceRefs: sources.filter((ref) => ref.componentKey === binding.key),
                });
              if (!bindings.length) window.fixtureWriter.bind(node, { context });
              const packets = (writers.length ? writers : [window.fixtureWriter]).map((writer) =>
                writer.reader.query(node, { scope, anchorGeneration: 1 }),
              );
              return {
                ...packets[0],
                facts: packets.flatMap((value) => value.facts),
                contextFacts: packets.flatMap((value) => value.contextFacts),
                sourceRefs: packets.flatMap((value) => value.sourceRefs),
              };
            },
            {
              bindings,
              sources,
              context,
              assetUrl: origin + '/_apps/assets/provenance-registry.mjs',
              domAttribute: values.find((fact) => fact.predicate === 'attributeName')?.object,
            },
          );
          for (const binding of bindings)
            assert.ok(
              packet.facts.some((fact) => fact.binding.key === binding.key && fact.proof === 'mirage-registry'),
              binding.key,
            );
          for (const item of context)
            assert.ok(
              packet.contextFacts.some((fact) => fact.binding.key === item.key && fact.predicate === item.relationship),
              item.key,
            );
          if (scenario.id === 'host-binding-wins-over-dom-name-heuristic') {
            const heuristic = await page.evaluate(`(() => {
              const node = document.getElementById('fixture-surface').firstElementChild;
              const previous = window.Xrm;
              window.Xrm = { Utility: { getPageContext: () => ({ input: { pageType: 'entityrecord', entityName: 'fixture_case' } }) }, Page: { data: { entity: { getEntityName: () => 'fixture_case' } }, ui: {} } };
              try { return (${modelDrivenObservationRuntime.toString()})().queryNative(node, ${JSON.stringify({ scope: packet.scope, anchorGeneration: 1, data: { origin } })}); }
              finally { if (previous === undefined) delete window.Xrm; else window.Xrm = previous; }
            })()`);
            assert.ok(
              heuristic.facts.some(
                (fact) => fact.binding.controlName === 'fixture_title' && fact.proof === 'native-dom',
              ),
            );
            assert.notEqual(heuristic.facts[0].binding.key, bindings[0].key);
          }
          scope = packet.scope;
          packet = await page.evaluate(
            `(${modelDrivenObservationRuntime.toString()})().enrich(${JSON.stringify(packet)},${JSON.stringify({ sourceRefs: sources, validatedScope: scope, validatedAnchorGeneration: 1 })})`,
          );
          if (
            [
              'same-origin-child-frame-direct-binding',
              'navigation-while-source-response-in-flight',
              'frame-replaced-same-frame-name',
            ].includes(scenario.id)
          ) {
            const child = await page.evaluate(
              async ({ sources, key }) => {
                const surface = document.getElementById('fixture-surface');
                surface.replaceChildren();
                const frame = document.createElement('iframe');
                frame.name = 'same-fixture-frame';
                frame.srcdoc = '<input id="fixture-child">';
                surface.append(frame);
                await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
                const node = frame.contentDocument.getElementById('fixture-child'),
                  tools = document.getElementById('paqvilo-xray').__px;
                const scope = tools.getSelectionScope(node);
                const { createModelDrivenProvenanceRegistry } = await frame.contentWindow.eval(
                  'import(' + JSON.stringify(location.origin + '/_apps/assets/provenance-registry.mjs') + ')',
                );
                const writer = createModelDrivenProvenanceRegistry(frame.contentDocument);
                writer.bind(
                  node,
                  frame.contentWindow.JSON.parse(
                    JSON.stringify({ owner: { kind: 'control', key }, sourceKeys: [key], sourceRefs: sources }),
                  ),
                );
                return writer.reader.query(node, { scope, anchorGeneration: 1 });
              },
              { sources, key: bindings[0].key },
            );
            packet = await page.evaluate(
              `(${modelDrivenObservationRuntime.toString()})().enrich(${JSON.stringify(child)},${JSON.stringify({ sourceRefs: sources, validatedScope: child.scope, validatedAnchorGeneration: 1 })})`,
            );
            assert.notEqual(child.scope.frameId, scope.frameId, 'the child frame has its own scope');
            assert.notEqual(child.scope.documentId, scope.documentId, 'the child frame has its own document');
            scope = child.scope;
            if (scenario.id !== 'same-origin-child-frame-direct-binding') {
              const selection = await page.evaluate(() => {
                const tools = document.getElementById('paqvilo-xray').__px;
                tools.select(
                  document.querySelector('#fixture-surface iframe').contentDocument.getElementById('fixture-child'),
                );
                return { ...tools.selectionState(), token: tools.token };
              });
              const request = {
                token: selection.token,
                name: 'provenance',
                body: {
                  version: 1,
                  active: {},
                  scope: selection.scope,
                  anchorGeneration: selection.anchorGeneration,
                },
              };
              assert.equal((await page.evaluate((input) => window.__paqviloModelPanelApi(input), request)).ok, true);
              const originalEvaluate = page.evaluate.bind(page),
                admitted = Promise.withResolvers(),
                release = Promise.withResolvers();
              let held = false,
                pending;
              page.evaluate = async (fn, arg) => {
                const result = await originalEvaluate(fn, arg);
                if (
                  !held &&
                  typeof fn === 'function' &&
                  fn.toString().includes('sourceKey !== undefined') &&
                  arg?.anchorGeneration === selection.anchorGeneration
                ) {
                  held = true;
                  admitted.resolve();
                  await release.promise;
                }
                return result;
              };
              try {
                pending = originalEvaluate((input) => window.__paqviloModelPanelApi(input), request);
                await admitted.promise;
                scope = await page.evaluate(async (navigate) => {
                  const frame = document.querySelector('#fixture-surface iframe');
                  const loaded = new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
                  // The in-flight navigation leaves through the frame's own location; the replacement swaps its srcdoc.
                  if (navigate) frame.contentWindow.location.href = 'about:blank';
                  else frame.srcdoc = '<input id="replacement-child">';
                  await loaded;
                  if (navigate) frame.contentDocument.body.innerHTML = '<input id="replacement-child">';
                  return document
                    .getElementById('paqvilo-xray')
                    .__px.getSelectionScope(frame.contentDocument.getElementById('replacement-child'));
                }, scenario.id === 'navigation-while-source-response-in-flight');
                release.resolve();
                const refused = await pending;
                assert.equal(refused.ok, false);
                assert.equal(refused.reason, 'selection-obsolete');
                assert.equal(refused.catalogue, undefined);
              } finally {
                release.resolve();
                page.evaluate = originalEvaluate;
              }
            }
          }
          if (scenario.id === 'same-document-rerender-invalidates-old-node-binding') {
            packet = await page.evaluate(() => {
              const writer = window.fixtureWriter,
                node = document.getElementById('fixture-surface').firstElementChild,
                tools = document.getElementById('paqvilo-xray').__px;
              writer.beginUI();
              return writer.reader.query(node, { scope: tools.getSelectionScope(node), anchorGeneration: 1 });
            });
            packet = await page.evaluate(
              `(${modelDrivenObservationRuntime.toString()})().enrich(${JSON.stringify(packet)},${JSON.stringify({ sourceRefs: sources, validatedScope: scope, validatedAnchorGeneration: 1 })})`,
            );
          }
          if (scenario.id === 'metadata-reloaded-during-selection') {
            controller.refresh(imported);
            await page.waitForFunction(
              (previous) =>
                document.getElementById('paqvilo-xray').__px.getSelectionScope().sourceRevision !== previous,
              scope.sourceRevision,
            );
            scope = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.getSelectionScope());
          }
          if (scenario.id === 'older-selection-response-after-new-selection') {
            const previous = await page.evaluate(() => {
              const tools = document.getElementById('paqvilo-xray').__px,
                node = document.getElementById('fixture-surface').firstElementChild;
              tools.select(node);
              return { ...tools.selectionState(), token: tools.token };
            });
            const request = {
              token: previous.token,
              name: 'provenance',
              body: { version: 1, active: {}, scope: previous.scope, anchorGeneration: previous.anchorGeneration },
            };
            const positive = await page.evaluate((input) => window.__paqviloModelPanelApi(input), request);
            assert.equal(positive.ok, true, 'the current selection admits the same request');
            const originalEvaluate = page.evaluate.bind(page);
            const admitted = Promise.withResolvers(),
              release = Promise.withResolvers();
            let held = false;
            page.evaluate = async (fn, arg) => {
              const result = await originalEvaluate(fn, arg);
              if (
                !held &&
                typeof fn === 'function' &&
                fn.toString().includes('sourceKey !== undefined') &&
                arg?.anchorGeneration === previous.anchorGeneration
              ) {
                held = true;
                admitted.resolve();
                await release.promise;
              }
              return result;
            };
            let refused;
            try {
              const pending = originalEvaluate((input) => window.__paqviloModelPanelApi(input), request);
              await admitted.promise;
              await originalEvaluate(() => {
                const tools = document.getElementById('paqvilo-xray').__px;
                const replacement = document.createElement('button');
                document.getElementById('fixture-surface').append(replacement);
                tools.select(replacement);
              });
              release.resolve();
              refused = await pending;
            } finally {
              release.resolve();
              page.evaluate = originalEvaluate;
            }
            assert.equal(refused.ok, false);
            assert.equal(refused.reason, 'selection-obsolete');
            assert.equal(refused.catalogue, undefined, 'an obsolete response exposes no source catalogue');
            results.push({
              id: scenario.id,
              mode: 'controlled-inspector-dispatch',
              owner: 'refused',
              source: 'refused',
              previousExpected: scenario.previousExpected,
            });
            return;
          }
          if (scenario.id === 'out-of-origin-provider-response-refused') {
            const server = http.createServer((_request, response) =>
              response.writeHead(200, { 'content-type': 'text/html' }).end('<!doctype html><form></form>'),
            );
            await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
            ownedFixture(t).add(() => {
              server.closeAllConnections();
              return new Promise((resolve) => server.close(resolve));
            });
            const foreignOrigin = `http://127.0.0.1:${server.address().port}`;
            assert.notEqual(foreignOrigin, origin);
            // The same-origin provider frame is served by the page's origin, the apps origin the page runs on.
            await page.route(origin + '/same-provider', (route) =>
              route.fulfill({ contentType: 'text/html', body: '<!doctype html><form><p>Same provider</p></form>' }),
            );
            await page.route(foreignOrigin + '/foreign-provider', (route) =>
              route.fulfill({ contentType: 'text/html', body: '<!doctype html><form></form>' }),
            );
            await page.evaluate(
              ({ origin, foreignOrigin }) => {
                for (const [id, url] of [
                  ['same-provider', origin + '/same-provider'],
                  ['foreign-provider', foreignOrigin + '/foreign-provider'],
                ]) {
                  const frame = document.createElement('iframe');
                  frame.id = id;
                  frame.src = url;
                  document.body.append(frame);
                }
              },
              { origin, foreignOrigin },
            );
            const same = page.frameLocator('#same-provider').locator('body');
            const foreign = page.frameLocator('#foreign-provider').locator('form');
            await same.waitFor();
            await foreign.waitFor({ state: 'attached' });
            const admitted = await page.evaluate(async () => {
              const tools = document.getElementById('paqvilo-xray').__px;
              tools.select(document.getElementById('fixture-surface').firstElementChild);
              const selected = tools.selectionState();
              return window.__paqviloModelPanelApi({
                token: tools.token,
                name: 'provenance',
                body: { version: 1, active: {}, scope: selected.scope, anchorGeneration: selected.anchorGeneration },
              });
            });
            assert.equal(admitted.ok, true);
            assert.equal(
              await same.evaluate(() => typeof window.__paqviloModelDrivenProvider),
              'object',
              'a same-origin frame receives the provider',
            );
            const child = page.frames().find((frame) => frame.url().startsWith(foreignOrigin));
            assert.ok(child);
            assert.equal(await child.evaluate(() => typeof window.__paqviloModelDrivenProvider), 'undefined');
            assert.equal(await child.evaluate(() => typeof window.__paqviloModelPanelApi), 'undefined');
            packet = await child.evaluate(
              `(${modelDrivenObservationRuntime.toString()})().queryNative(document.querySelector('form'),${JSON.stringify({ scope, anchorGeneration: 1, data: { origin } })})`,
            );
            assert.ok(packet.availability.some((item) => item.reason === 'node-document-origin-boundary'));
            await page.evaluate(() => {
              document.getElementById('same-provider').remove();
              document.getElementById('foreign-provider').remove();
            });
          }
        }
        const result = resolveInspectionEvidence({ ...packet, scope, node: { connected: true } });
        assert.equal(result.owner.status, scenario.truth.owner, scenario.truth.rationale);
        // A real matching AppAction gives a candidate source, but a DOM token
        // still cannot establish execution or a deployed source revision.
        assert.equal(
          result.source.status,
          scenario.id === 'native-command-dom-token-only-heuristic' ? 'candidate' : scenario.truth.source,
          scenario.truth.rationale,
        );
        if (result.owner.status === 'exact')
          assert.ok(
            packet.mode === 'local' && packet.facts.some((fact) => fact.proof === 'mirage-registry'),
            'exact selected ownership requires an observed binding',
          );
        for (const ref of result.source.refs.filter((ref) => ref.status === 'exact'))
          assert.equal(
            digest(await fs.readFile(ref.ref)),
            ref.contentRevision,
            'an exact source must be the imported bytes actually read from its real file',
          );
        assert.doesNotMatch(
          JSON.stringify(packet),
          /getValue|userId|entityId|Copper|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/,
        );
        if (native)
          assert.notEqual(
            result.owner.status,
            'exact',
            'native current-context APIs alone cannot bind the selected form DOM',
          );
        if (missing) assert.equal(result.source.status, 'unavailable');
        if (ownerValues.length > 1) assert.equal(result.owner.status, 'conflicting');
        results.push({
          id: scenario.id,
          mode: native ? 'documented-native-api-dom-fixture' : 'private-registry-dom-fixture',
          owner: result.owner.status,
          source: result.source.status,
          previousExpected: scenario.previousExpected,
        });
      },
    );
  assert.equal(results.length, 60);
  t.diagnostic(
    JSON.stringify({
      scenarios: results.length,
      modes: Object.fromEntries(
        [...new Set(results.map((item) => item.mode))].map((mode) => [
          mode,
          results.filter((item) => item.mode === mode).length,
        ]),
      ),
      legacyTruthDeltas: results
        .filter((item) => item.owner !== item.previousExpected.owner || item.source !== item.previousExpected.source)
        .map((item) => ({ id: item.id, owner: item.owner, source: item.source })),
    }),
  );
});
