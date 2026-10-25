import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sharedBrowser } from './shared-browser.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { createModelDrivenMetadataIndex } from '../../lense/model-driven-metadata.mjs';
import { modelDrivenObservationRuntime } from '../../lense/model-driven-observation.mjs';
import { resolveInspectionEvidence } from '../../lense/inspection-evidence.mjs';
import { importModelDrivenProject, createModelDrivenOverlay } from '../../lense/model-driven.mjs';
import { startModelDrivenInspector } from '../../lense/model-driven-inspector.mjs';
import { createInspectionProvenanceTransport } from '../../lense/inspection-provenance-transport.mjs';
import { interceptOrigin } from '../../lense/intercept.mjs';

const chrome = sharedBrowser();
const scope = { documentId: 'fixture-document', frameId: 'fixture-frame', uiEpoch: 1, sourceRevision: '1' };
async function install(page, data) {
  await page.evaluate(
    `(${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: 'fixture-provider', validatedScope: scope, validatedAnchorGeneration: 1, ...data })})`,
  );
}
async function inspect(locator, currentScope = scope) {
  const packet = await locator.evaluate(
    (node, suppliedScope) => ({
      ...window.__paqviloModelDrivenProvider.query(node, { scope: suppliedScope, anchorGeneration: 1 }),
      connected: node.isConnected,
    }),
    currentScope,
  );
  return {
    packet,
    evidence: resolveInspectionEvidence({
      ...packet,
      facts: [...packet.facts, ...packet.contextFacts],
      node: { connected: packet.connected },
      scope: currentScope,
    }),
  };
}

test(
  'native model-driven overlaid JavaScript attributes actual created DOM through acknowledged response bytes and opens only current callsites',
  { timeout: 30000 },
  async (t) => {
    const { origin, root, solutionDir } = await modelDrivenFixture(t);
    const file = path.join(root, 'native-dom.js');
    const raw =
      '\ufeff// Invented native model-driven customization 🌿\r\n(() => { const element = document.createElement("section");\n window.fixtureDOMCount=(window.fixtureDOMCount||0)+1; element.id="fixture-script-created-"+window.fixtureDOMCount; element.textContent="Invented script node"; document.body.append(element); })();\n';
    await fs.writeFile(file, raw);
    const imported = await importModelDrivenProject({ solutionRoots: [solutionDir], solutionOrder: 'explicit' });
    imported.assets.set('/WebResources/fixture_script.js', {
      name: 'fixture_script.js',
      file,
      data: Buffer.from(raw),
      mime: 'text/javascript',
    });
    imported.resources.push({ name: 'fixture_script.js', type: 'script', url: '/_apps/resources/fixture_script' });
    const overlay = createModelDrivenOverlay({
      origin,
      imported,
      mappings: [{ resource: 'fixture_script.js', path: '/assets/fixture.a1b2c3.js' }],
    });
    const page = await chrome.page(t);
    await page.goto(origin + '/native-before');
    const cfg = {
      origin,
      sourceDir: solutionDir,
      projectRoot: root,
      stateDir: path.join(root, '.paqvilo'),
      siteName: 'fixture',
      envName: 'test',
      agent: { enabled: false },
    };
    const transport = createInspectionProvenanceTransport(page.context(), [cfg]);
    Object.assign(cfg, { provenanceSlot: transport.slot, domProvenanceSlot: transport.domSlot });
    const stopInterception = await interceptOrigin(
      page.context(),
      origin,
      async (route) => {
        if (
          new URL(route.request().url()).pathname === '/native-script-fixture' &&
          route.request().isNavigationRequest()
        )
          await route.fulfill({
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: Buffer.from(
              '<!doctype html><html><body><script src="/assets/fixture.a1b2c3.js"></script><script src="/WebResources/fixture_script.js"></script></body></html>',
            ),
          });
        else await overlay.handle(route);
      },
      { ownsPage: (candidate) => candidate === page, onAttach: transport.onAttach },
    );
    t.after(stopInterception);
    const controller = await startModelDrivenInspector({
      context: page.context(),
      page,
      overlay,
      cfg,
      imported,
      stop() {},
    });
    t.after(() => controller.close());
    await page.goto(origin + '/native-script-fixture');
    await page.locator('#fixture-script-created-2').waitFor();
    await page.waitForFunction(() => document.getElementById('paqvilo-xray')?.__px);
    await page.evaluate(() =>
      document.getElementById('paqvilo-xray').__px.select(document.getElementById('fixture-script-created-2')),
    );
    await page.waitForFunction(
      () =>
        document.getElementById('paqvilo-xray').__px.selectionState().identity?.evidence?.source?.status === 'exact',
    );
    const selected = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
    await page.evaluate(() =>
      document.getElementById('paqvilo-xray').__px.select(document.getElementById('fixture-script-created-1')),
    );
    await page.waitForFunction(
      () =>
        document.getElementById('paqvilo-xray').__px.selectionState().identity?.evidence?.source?.status === 'exact',
    );
    await page.evaluate(() =>
      document.getElementById('paqvilo-xray').__px.select(document.getElementById('fixture-script-created-2')),
    );
    await page.waitForFunction(
      () =>
        document.getElementById('paqvilo-xray').__px.selectionState().identity?.evidence?.source?.status === 'exact',
    );
    const currentSelected = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
    const ref = selected.identity.evidence.source.refs.find((ref) => ref.componentKey === 'resource:fixture_script.js');
    assert.ok(ref?.region?.start >= 0, JSON.stringify(selected.identity.evidence));
    assert.equal(ref.contentRevision, createHash('sha256').update(raw).digest('hex'));
    const index = createModelDrivenMetadataIndex(imported, { sourceRevision: ref.sourceRevision });
    const opened = index.resolveOpen(
      { sourceKey: ref.sourceKey ?? ref.key, sourceRevision: ref.sourceRevision, contentRevision: ref.contentRevision },
      { observedRegion: ref.region },
    );
    assert.equal(opened.ok, true);
    assert.ok(opened.line >= 2, 'the mapped customization callsite is opened rather than a guessed first line');
    await fs.writeFile(file, raw + '// local edit');
    const refused = await page.evaluate(
      ({ selected, ref }) =>
        window.__paqviloModelPanelApi({
          token: document.getElementById('paqvilo-xray').__px.token,
          name: 'open',
          body: {
            sourceKey: ref.sourceKey ?? ref.key,
            sourceRevision: ref.sourceRevision,
            contentRevision: ref.contentRevision,
            region: ref.region,
            scope: selected.scope,
            anchorGeneration: selected.anchorGeneration,
          },
        }),
      { selected: currentSelected, ref },
    );
    assert.equal(refused.ok, false);
    assert.match(refused.reason, /source-content-changed|source-evidence-stale|selection-obsolete/);
    await page.evaluate(() => {
      const tools = document.getElementById('paqvilo-xray').__px;
      tools.clearSelection();
      tools.select(document.getElementById('fixture-script-created-2'));
    });
    await page.waitForFunction(
      () =>
        document.getElementById('paqvilo-xray').__px.selectionState().identity?.evidence?.source?.status === 'stale',
    );
  },
);

test(
  'actual Mirage nodes retain exact owners, honest OOB context and render-time source versions after an edit',
  { timeout: 30000 },
  async (t) => {
    const { origin, solutionDir, sim } = await modelDrivenFixture(t);
    const formPath = path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml');
    await fs.writeFile(
      formPath,
      (await fs.readFile(formPath, 'utf8')).replace(
        '<form>',
        '<form><header><rows><row><cell><control id="header_x_name" uniqueid="fixture-header-control" datafieldname="x_name"/></cell></row></rows></header><footer><rows><row><cell><control id="footer_x_name" uniqueid="fixture-footer-control" datafieldname="x_name"/></cell></row></rows></footer>',
      ),
    );
    await sim.reload();
    const page = await chrome.page(t);
    await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
    await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
    const metadata = await importSolutionMetadata([solutionDir]);
    const index = createModelDrivenMetadataIndex({ metadata }, { sourceRevision: '1' });
    const details = index.query({
      active: { entity: 'x_item', formId: 'item-form' },
      budget: { items: 128, bytes: 256 * 1024 },
    });
    await install(page, {
      origin,
      localSimulation: true,
      ...details,
      sourceRefs: [...details.sourceRefs, ...index.sourceRefsFor(['column:x_item:x_name'])],
    });
    const cell = page.locator('td[data-id="x_name"]').first();
    const grid = await inspect(cell);
    assert.equal(grid.evidence.owner.status, 'exact');
    assert.equal(grid.evidence.owner.component.key, 'column:x_item:x_name');
    assert.equal(grid.evidence.source.status, 'exact');
    assert.doesNotMatch(JSON.stringify(grid.packet), /Copper|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const field = page.getByLabel('Name', { exact: true });
    await field.waitFor();
    const form = await inspect(field);
    assert.equal(
      await page.locator('[data-id="header_x_name"],[data-id="footer_x_name"]').count(),
      0,
      'configured unsupported regions do not acquire fabricated rendered nodes',
    );
    assert.equal(
      index
        .sourceRefsForForm('form:item-form', {
          controlNames: ['header_x_name', 'footer_x_name'],
          includeStructure: false,
        })
        .filter((ref) => ref.kind === 'control').length,
      2,
      'both unrendered region placements retain their real exported sources',
    );
    assert.equal(form.evidence.owner.status, 'exact');
    assert.match(form.evidence.owner.component.key, /^control:item-form:/);
    assert.equal(form.evidence.source.status, 'exact');
    assert.ok(form.evidence.source.refs.some((ref) => ref.region?.line));
    await field.evaluate((node) => node.setAttribute('data-id', 'x_quantity.forged'));
    assert.equal(
      (await inspect(field)).evidence.owner.component.key,
      form.evidence.owner.component.key,
      'page-writable attributes cannot replace private ownership',
    );
    const save = await inspect(page.getByRole('button', { name: 'Save', exact: true }));
    assert.equal(save.evidence.owner.status, 'exact');
    assert.equal(save.evidence.owner.component.kind, 'platform-command');
    assert.equal(save.evidence.source.status, 'unavailable');
    assert.ok(save.evidence.facts.some((item) => item.component?.kind === 'form'));
    const file = path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml');
    await fs.writeFile(
      file,
      (await fs.readFile(file, 'utf8')).replace('description="Name"', 'description="Edited name"'),
    );
    const changed = await importSolutionMetadata([solutionDir]);
    const updated = createModelDrivenMetadataIndex({ metadata: changed }, { sourceRevision: '2' }).query({
      active: { entity: 'x_item', formId: 'item-form' },
    });
    await install(page, {
      origin,
      localSimulation: true,
      ...updated,
      validatedScope: { ...scope, sourceRevision: '2' },
    });
    const staleSource = await inspect(field, { ...scope, sourceRevision: '2' });
    assert.equal(staleSource.evidence.owner.status, 'exact');
    assert.equal(
      staleSource.evidence.source.status,
      'stale',
      'new metadata cannot relabel the old rendered form source',
    );
    const previous = await field.elementHandle();
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
    assert.notEqual((await inspect(previous)).evidence.owner.status, 'exact');
  },
);

test(
  'native documented getObject associates only the outer iframe; requested IDs, hidden views and unloaded quick forms stay honest',
  { timeout: 30000 },
  async (t) => {
    const { origin, root } = await modelDrivenFixture(t);
    const page = await chrome.page(t);
    await page.goto(origin + '/native-fixture');
    await page.setContent(
      '<iframe name="fixture_frame" src="/native-child"></iframe><div data-id="dataSetRoot_fixture_grid"></div><input name="fixture_title">',
    );
    const formId = '10000000-0000-4000-8000-000000000001',
      uniqueId = '10000000-0000-4000-8000-000000000002';
    const file = path.join(root, 'native-form.xml');
    const xml = `<systemform><formid>{${formId}}</formid><form><tabs><tab name="fixture_tab"><columns><column><sections><section name="fixture_section"><rows><row><cell><control id="fixture_frame" uniqueid="{${uniqueId}}" classid="{9fdf5f91-88b1-47f4-ad53-c11efc01a01d}"/></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform>`;
    await fs.writeFile(file, xml);
    const index = createModelDrivenMetadataIndex({
      metadata: {
        entities: {},
        sourceRevisions: { [file]: createHash('sha256').update(xml).digest('hex') },
        forms: [{ id: formId, entity: 'fixture_item', file, xml }],
      },
    });
    const details = index.query({ active: { formId } });
    await page.evaluate(
      ({ formId }) => {
        window.forbiddenReads = 0;
        window.quickLoaded = false;
        window.selectorNull = false;
        const forbidden = () => {
          window.forbiddenReads++;
          throw Error('Forbidden record/user/value read');
        };
        const frame = document.querySelector('iframe');
        const text = (name) => ({
          getName: () => name,
          getControlType: () => 'standard',
          getAttribute: () => ({ getName: () => name, getValue: forbidden }),
          getParent: () => ({ getName: () => 'fixture_section', getParent: () => ({ getName: () => 'fixture_tab' }) }),
        });
        const iframe = { ...text('fixture_frame'), getControlType: () => 'iframe', getObject: () => frame };
        const grid = {
          ...text('fixture_grid'),
          getControlType: () => 'subgrid',
          getViewSelector: () => ({
            getCurrentView() {
              throw Error('Hidden');
            },
          }),
        };
        const rows = Array.from({ length: 1105 }, (_, index) => text('fixture_field_' + index));
        rows[1104] = iframe;
        const collection = (items) => ({ getLength: () => items.length, get: (index) => items[index] });
        const quick = {
          ...text('fixture_quick'),
          isLoaded: () => window.quickLoaded,
          getControl(index) {
            if (!window.quickLoaded) return forbidden();
            return index ? undefined : text('fixture_nested');
          },
        };
        const input = {
          pageType: 'entityrecord',
          entityName: 'fixture_item',
          formId: '10000000-0000-4000-8000-000000000099',
          viewId: '10000000-0000-4000-8000-000000000098',
        };
        Object.defineProperty(input, 'entityId', { get: forbidden });
        window.Xrm = {
          Utility: { getPageContext: () => ({ input }), getGlobalContext: forbidden },
          Page: {
            data: { entity: { getEntityName: () => 'fixture_item', getId: forbidden, getEntityReference: forbidden } },
            ui: {
              getFormType: () => 1,
              formSelector: { getCurrentItem: () => (window.selectorNull ? null : { getId: () => formId }) },
              controls: collection(rows),
              tabs: collection([
                {
                  getName: () => 'fixture_tab',
                  sections: collection(
                    Array.from({ length: 220 }, (_, index) => ({ getName: () => 'fixture_section_' + index })),
                  ),
                },
              ]),
              quickForms: collection([quick]),
            },
            getControl: (name) =>
              name === 'fixture_frame'
                ? iframe
                : name === 'fixture_grid'
                  ? grid
                  : rows.find((row) => row.getName() === name),
          },
        };
      },
      { formId },
    );
    await install(page, { origin, localSimulation: false, ...details });
    const outer = await inspect(page.locator('iframe'));
    assert.equal(outer.evidence.owner.status, 'exact');
    assert.equal(outer.evidence.source.status, 'exact', JSON.stringify(outer.packet));
    assert.equal(outer.evidence.owner.evidence[0].kind, 'native-api');
    assert.equal(outer.packet.context.formId, formId);
    assert.equal(outer.packet.context.requested.formId, '10000000-0000-4000-8000-000000000099');
    const hidden = await inspect(page.locator('[data-id="dataSetRoot_fixture_grid"]'));
    assert.ok(
      hidden.packet.availability.some((item) => item.capability === 'subgrid-current-view' && item.reason === 'throws'),
    );
    assert.equal(hidden.packet.context.viewId, undefined);
    await page.evaluate(() => {
      window.selectorNull = true;
    });
    assert.equal((await inspect(page.locator('input'))).packet.context.formId, undefined);
    const snapshot = await page.evaluate(
      (scope) =>
        window.__paqviloModelDrivenProvider.observe({
          scope,
          anchorGeneration: 1,
          cursor: { controls: 1105, tabs: 1 },
          budget: { items: 8, bytes: 8192 },
        }),
      scope,
    );
    assert.equal(snapshot.quickForms.rows[0].loaded, false);
    const firstStructure = await page.evaluate(
      (scope) =>
        window.__paqviloModelDrivenProvider.observe({
          scope,
          anchorGeneration: 1,
          cursor: { controls: 1105, quickForms: 1 },
          budget: { items: 8, bytes: 8192 },
        }),
      scope,
    );
    assert.equal(firstStructure.tabs.rows[0].sections.rows.length, 7);
    assert.equal(firstStructure.nextCursor.tabs, 0, 'an incomplete tab remains eligible for its next section page');
    const secondStructure = await page.evaluate(
      ({ scope, cursor }) =>
        window.__paqviloModelDrivenProvider.observe({
          scope,
          anchorGeneration: 1,
          cursor,
          budget: { items: 8, bytes: 8192 },
        }),
      { scope, cursor: firstStructure.nextCursor },
    );
    assert.equal(secondStructure.tabs.rows[0].sections.rows[0].name, 'fixture_section_7');
    await page.evaluate(() => {
      window.quickLoaded = true;
    });
    const changedQuickForm = await page.evaluate(
      ({ scope, cursor }) =>
        window.__paqviloModelDrivenProvider.observe({
          scope,
          anchorGeneration: 1,
          cursor,
          budget: { items: 8, bytes: 8192 },
        }),
      { scope, cursor: snapshot.nextCursor },
    );
    assert.equal(
      changedQuickForm.obsolete,
      true,
      'a ready-state change invalidates the structural snapshot generation',
    );
    const loadedQuickForm = await page.evaluate(
      (scope) =>
        window.__paqviloModelDrivenProvider.observe({
          scope,
          anchorGeneration: 1,
          cursor: { controls: 1105, tabs: 1 },
          budget: { items: 8, bytes: 8192 },
        }),
      scope,
    );
    assert.equal(loadedQuickForm.quickForms.rows[0].controls.rows[0].name, 'fixture_nested');
    assert.equal(loadedQuickForm.quickForms.descendantsComplete, true);
    await page.evaluate(() => {
      window.quickLoaded = false;
    });
    assert.notEqual(
      await page.evaluate(() => window.__paqviloModelDrivenProvider.generation()),
      loadedQuickForm.nativeGeneration,
      'post-observation admission checks quick-view readiness even before a DOM mutation',
    );
    assert.equal(await page.evaluate(() => window.forbiddenReads), 0);
    const frame = page.frames().find((candidate) => candidate !== page.mainFrame());
    await frame.waitForLoadState();
    await frame.setContent('<input name="fixture_nested">');
    await install(frame, { origin, localSimulation: false, ...details });
    const child = await inspect(frame.locator('input'), {
      ...scope,
      documentId: 'child-document',
      frameId: 'child-frame',
    });
    assert.notEqual(child.evidence.owner.status, 'exact');
    assert.ok(
      !child.packet.contextFacts.some((fact) => fact.binding.key === 'form:' + formId),
      'parent form context never becomes child ownership',
    );
    assert.doesNotMatch(JSON.stringify(snapshot), /entityId|userId|recordId|getValue/);
  },
);

test(
  'actual Xray selection hydrates a cold native control beyond the form and control caps through the controller',
  { timeout: 30000 },
  async (t) => {
    const { origin, root, solutionDir } = await modelDrivenFixture(t);
    const page = await chrome.page(t);
    await page.goto(origin + '/native-fixture');
    await page.setContent(
      '<iframe name="fixture_frame" src="/native-child"></iframe><button id="other">Other</button>',
    );
    const guid = (number) => `20000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
    const formId = guid(205),
      uniqueId = guid(2205),
      file = path.join(root, 'cold-native-form.xml');
    const controls = Array.from(
      { length: 1105 },
      (_, number) =>
        `<row><cell><control id="${number === 1104 ? 'fixture_frame' : 'fixture_field_' + number}" uniqueid="{${number === 1104 ? uniqueId : guid(3000 + number)}}"${number === 1104 ? ' classid="{9fdf5f91-88b1-47f4-ad53-c11efc01a01d}"' : ' datafieldname="x_name"'}/></cell></row>`,
    ).join('');
    const xml = `<systemform><formid>{${formId}}</formid><form><tabs><tab name="fixture_tab"><columns><column><sections><section name="fixture_section"><rows>${controls}</rows></section></sections></column></columns></tab></tabs></form></systemform>`;
    await fs.writeFile(file, xml);
    const imported = await importModelDrivenProject({ solutionRoots: [solutionDir], solutionOrder: 'explicit' });
    imported.metadata.forms = Array.from({ length: 205 }, (_, number) => ({
      id: guid(number + 1),
      entity: 'x_item',
      file,
      xml,
      systemFormType: 2,
    }));
    imported.metadata.sourceRevisions[file] = createHash('sha256').update(xml).digest('hex');
    await page.evaluate(
      ({ formId }) => {
        const frame = document.querySelector('iframe');
        const rows = Array.from({ length: 1105 }, (_, index) => ({
          getName: () => (index === 1104 ? 'fixture_frame' : 'fixture_field_' + index),
          getControlType: () => (index === 1104 ? 'iframe' : 'standard'),
          ...(index === 1104 ? { getObject: () => frame } : {}),
        }));
        const collection = (items) => ({ getLength: () => items.length, get: (index) => items[index] });
        window.Xrm = {
          Utility: { getPageContext: () => ({ input: { pageType: 'entityrecord', entityName: 'x_item' } }) },
          Page: {
            data: { entity: { getEntityName: () => 'x_item' } },
            ui: {
              getFormType: () => 1,
              formSelector: { getCurrentItem: () => ({ getId: () => formId }) },
              controls: collection(rows),
              tabs: collection([]),
              quickForms: collection([]),
            },
            getControl: (name) => rows.find((row) => row.getName() === name),
          },
        };
      },
      { formId },
    );
    const overlay = createModelDrivenOverlay({ origin, imported });
    const controller = await startModelDrivenInspector({
      context: page.context(),
      page,
      overlay,
      imported,
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
    t.after(() => controller.close());
    await page.waitForFunction(
      () =>
        window.__paqviloModelDrivenProvider &&
        document.getElementById('paqvilo-xray')?.__px &&
        document.getElementById('paqvilo-panel')?.__paqModelInspector,
    );
    await page.waitForFunction(
      (formId) =>
        document
          .getElementById('paqvilo-xray')
          .__px.identify(document.querySelector('iframe'))
          ?.evidence?.facts?.some((fact) => fact.component?.key === 'form:' + formId),
      formId,
    );
    const before = await page.evaluate(() => {
      const tools = document.getElementById('paqvilo-xray').__px,
        node = document.querySelector('iframe');
      const packet = window.__paqviloModelDrivenProvider.query(node, {
        scope: tools.getSelectionScope(node),
        anchorGeneration: 0,
      });
      tools.select(node);
      return { packet, state: tools.selectionState() };
    });
    assert.equal(
      before.packet.sourceKeys[0].startsWith('native-control:'),
      true,
      'the control was absent from the initial bounded details',
    );
    assert.equal(before.state.identity.evidence.owner.status, 'exact');
    assert.equal(before.state.identity.evidence.source.status, 'unavailable');
    await page.waitForFunction(
      () =>
        document.getElementById('paqvilo-xray').__px.selectionState().identity?.evidence?.source?.status === 'exact',
    );
    const hydrated = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.selectionState());
    assert.equal(
      hydrated.anchorGeneration,
      before.state.anchorGeneration,
      'source hydration preserves the selected DOM anchor',
    );
    assert.deepEqual(hydrated.scope, before.state.scope);
    assert.equal(hydrated.identity.evidence.owner.component.key, `control:${formId}:${uniqueId}:body`);
    assert.ok(
      hydrated.identity.evidence.source.refs.some(
        (ref) => ref.componentKey === `control:${formId}:${uniqueId}:body` && ref.region?.line,
      ),
    );
    const source = hydrated.identity.evidence.source.refs[0];
    const changedSource = await page.evaluate(
      ({ source, state }) =>
        window.__paqviloModelPanelApi({
          token: document.getElementById('paqvilo-xray').__px.token,
          name: 'open',
          body: {
            sourceKey: source.id,
            sourceRevision: source.sourceRevision,
            contentRevision: 'changed-content',
            scope: state.scope,
            anchorGeneration: state.anchorGeneration,
          },
        }),
      { source, state: hydrated },
    );
    assert.equal(changedSource.ok, false);
    assert.equal(
      changedSource.reason,
      'selection-obsolete',
      'controller refuses source evidence absent from the current exact selection before editor launch',
    );
    await page.evaluate(() => document.getElementById('paqvilo-xray').__px.select(document.getElementById('other')));
    const obsolete = await page.evaluate(
      ({ scope, anchorGeneration }) =>
        window.__paqviloModelPanelApi({
          token: document.getElementById('paqvilo-xray').__px.token,
          name: 'provenance',
          body: { version: 1, scope, anchorGeneration, active: {} },
        }),
      hydrated,
    );
    assert.equal(obsolete.ok, false);
    assert.equal(obsolete.reason, 'selection-obsolete');
  },
);

test(
  'exported commands and navigation resolve their actual definition and generated forms/views stay source unavailable',
  { timeout: 30000 },
  async (t) => {
    const { origin, solutionDir, sim } = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
    const siteMapFile = path.join(solutionDir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
    await fs.writeFile(
      siteMapFile,
      (await fs.readFile(siteMapFile, 'utf8')).replace(
        '<SubArea Id="external" Url="https://example.invalid/"/>',
        '<SubArea Id="external" Url="https://example.invalid/"><Titles><Title LCID="1033" Title="External"/></Titles></SubArea>',
      ),
    );
    await fs.mkdir(path.join(solutionDir, 'WebResources'), { recursive: true });
    await fs.writeFile(path.join(solutionDir, 'WebResources/fixture_page.html'), '<h1>Invented resource body</h1>');
    await fs.writeFile(
      path.join(solutionDir, 'WebResources/fixture_page.html.data.xml'),
      '<WebResource><WebResourceId>40000000-0000-4000-8000-000000000001</WebResourceId><Name>fixture_page.html</Name><WebResourceType>1</WebResourceType><FileName>WebResources/fixture_page.html</FileName></WebResource>',
    );
    await fs.writeFile(
      siteMapFile,
      (await fs.readFile(siteMapFile, 'utf8')).replace(
        '<SubArea Id="external"',
        '<SubArea Id="fixture_page" Url="$webresource:fixture_page.html"><Titles><Title LCID="1033" Title="Fixture page"/></Titles></SubArea><SubArea Id="external"',
      ),
    );
    await fs.writeFile(
      path.join(solutionDir, 'Entities/x_item/RibbonDiff.xml'),
      '<RibbonDiffXml><CustomActions><CustomAction><CommandUIDefinition><Button Id="x.Form.Inspect" Command="x.Inspect" LabelText="Fixture exported command"/></CommandUIDefinition></CustomAction></CustomActions><CommandDefinitions><CommandDefinition Id="x.Inspect"><Actions><Url Address="https://example.invalid"/></Actions></CommandDefinition></CommandDefinitions></RibbonDiffXml>',
    );
    await sim.reload();
    const imported = await importModelDrivenProject({ solutionRoots: [solutionDir], solutionOrder: 'explicit' });
    const index = createModelDrivenMetadataIndex(imported);
    const commandKey = 'command:x_item:x.form.inspect';
    const navigationKey = `navigation:${imported.apps[0].id}:items`;
    const details = index.query({
      componentKeys: [commandKey, navigationKey, 'resource:fixture_page.html'],
      active: { formId: 'item-form' },
    });
    assert.ok(
      details.sourceRefs.some((ref) => ref.componentKey === navigationKey),
      JSON.stringify(index.component(navigationKey)),
    );
    const page = await chrome.page(t, { viewport: { width: 1920, height: 1080 } });
    await page.goto(
      origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    const command = page.getByRole('button', { name: 'Fixture exported command', exact: true });
    await command.waitFor({ state: 'attached', timeout: 5000 });
    const runtimeCatalogue = await page.evaluate(() => fetch('/_apps/api/index').then((response) => response.json()));
    assert.ok(
      runtimeCatalogue.provenanceRefs.some((ref) => ref.componentKey === navigationKey),
      JSON.stringify({
        refs: runtimeCatalogue.provenanceRefs,
        app: runtimeCatalogue.apps.find((app) => app.uniqueName === 'x_example'),
        original: imported.apps[0].navigation,
      }),
    );
    await install(page, { origin, localSimulation: true, ...details });
    const exported = await inspect(command);
    assert.equal(exported.evidence.owner.component.key, commandKey);
    assert.equal(exported.evidence.source.status, 'exact', JSON.stringify(exported.packet));
    assert.ok(exported.evidence.source.refs.some((ref) => ref.ref.endsWith('RibbonDiff.xml') && ref.region?.line));
    const navigation = await inspect(page.getByRole('button', { name: 'Items', exact: true }));
    assert.equal(navigation.evidence.owner.component.key, navigationKey);
    assert.equal(navigation.evidence.source.status, 'exact', JSON.stringify(navigation.packet));
    assert.ok(navigation.evidence.source.refs.some((ref) => ref.ref.endsWith('AppModuleSiteMap.xml')));
    await page.getByRole('button', { name: 'Fixture page', exact: true }).click();
    const frame = page.locator('iframe.webresource-page');
    await frame.waitFor();
    const resource = await inspect(frame);
    assert.equal(resource.evidence.owner.component.key, 'resource:fixture_page.html');
    assert.equal(resource.evidence.source.status, 'exact');
    assert.ok(resource.evidence.source.refs.some((ref) => ref.ref.endsWith('fixture_page.html')));
    const row = sim.store.state.tables.sitemap.find((row) => row.appmoduleuniquename === 'x_example');
    const originalMap = row.sitemapxml;
    await sim.store.transact(() => {
      row.sitemapxml = originalMap.replace('Title="Items"', 'Title="Changed fixture navigation"');
    });
    await page.reload();
    const changedNavigation = page.getByRole('button', { name: 'Changed fixture navigation', exact: true });
    await changedNavigation.waitFor();
    await install(page, { origin, localSimulation: true, ...details });
    const changed = await inspect(changedNavigation);
    assert.equal(changed.evidence.owner.status, 'exact');
    assert.equal(changed.evidence.owner.component.key, navigationKey);
    assert.equal(
      changed.evidence.source.status,
      'unavailable',
      'a simulated metadata row edit cannot reuse the imported navigation origin',
    );
    await sim.store.transact(() => {
      row.sitemapxml = originalMap;
    });
    await fs.rm(path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml'));
    await fs.rm(path.join(solutionDir, 'Entities/x_item/SavedQueries/items.xml'));
    await sim.reload();
    await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
    await page.getByRole('button', { name: 'Copper', exact: true }).waitFor({ timeout: 5000 });
    await install(page, { origin, localSimulation: true, ...details });
    const grid = await inspect(page.locator('#content'));
    assert.equal(grid.evidence.owner.status, 'exact');
    assert.match(grid.evidence.owner.component.key, /^view:x_item:/);
    assert.equal(grid.evidence.source.status, 'unavailable');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const field = page.getByLabel('Name', { exact: true });
    await field.waitFor({ timeout: 5000 });
    const generated = await inspect(field);
    assert.equal(generated.evidence.owner.status, 'exact');
    assert.match(generated.evidence.owner.component.key, /^control:x_item:generated:/);
    assert.equal(generated.evidence.source.status, 'unavailable');
    assert.equal(generated.packet.sourceRefs.length, 0);
  },
);

test(
  'a mounted dataset PCF reports the runtime dataset view and implementation without copying row data',
  { timeout: 30000 },
  async (t) => {
    const { origin, solutionDir, sim } = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
    const directory = path.join(solutionDir, 'Controls/FixtureDataset');
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(
      path.join(directory, 'ControlManifest.xml'),
      '<manifest><control namespace="Fixture" constructor="Dataset" control-type="standard"><data-set name="records"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    );
    await fs.writeFile(
      path.join(directory, 'ControlManifest.xml.data.xml'),
      '<CustomControl><Name>Fixture.Dataset</Name></CustomControl>',
    );
    await fs.writeFile(
      path.join(directory, 'bundle.js'),
      `ComponentFramework.registerControl('Fixture.Dataset',class{init(context,notify,state,container){this.node=document.createElement('span');this.node.dataset.testid='fixture-dataset';container.append(this.node)}updateView(context){this.node.dataset.view=context.parameters.records.getViewId()}destroy(){this.node.remove()}});`,
    );
    const formFile = path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml');
    await fs.writeFile(
      formFile,
      (await fs.readFile(formFile, 'utf8')).replace(
        '</form>',
        '<controlDescriptions><controlDescription forControl="children"><customControl formFactor="0" name="Fixture.Dataset"><parameters><data-set name="records"><ViewId>{items-view}</ViewId><TargetEntityType>x_child</TargetEntityType></data-set></parameters></customControl></controlDescription></controlDescriptions></form>',
      ),
    );
    await sim.reload();
    const imported = await importModelDrivenProject({
      solutionRoots: [solutionDir],
      solutionOrder: 'explicit',
      modelDriven: { trustedExtensions: true },
    });
    const index = createModelDrivenMetadataIndex(imported);
    const details = index.query({ active: { formId: 'item-form' }, componentKeys: ['pcf:fixture.dataset'] });
    const page = await chrome.page(t);
    await page.goto(
      origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await page.getByRole('tab', { name: 'Related items', exact: true }).click();
    const mounted = page.getByTestId('fixture-dataset');
    await mounted.waitFor({ state: 'attached' });
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="fixture-dataset"]')?.closest('.model-driven-pcf')?.dataset.pcfState ===
        'ready',
    );
    await install(page, { origin, localSimulation: true, ...details });
    const result = await inspect(mounted);
    assert.equal(result.evidence.owner.component.key, 'pcf:fixture.dataset');
    assert.equal(result.evidence.owner.component.constructorName, 'Fixture.Dataset');
    assert.equal(result.evidence.owner.component.namespace, 'Fixture');
    assert.equal(result.evidence.owner.status, 'exact');
    assert.equal(result.evidence.source.status, 'exact');
    assert.ok(result.evidence.source.refs.some((ref) => ref.relationship.startsWith('implementation:')));
    assert.ok(
      result.packet.contextFacts.some(
        (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:children-view',
      ),
    );
    assert.ok(
      !result.packet.contextFacts.some(
        (fact) => fact.predicate === 'current-view' && fact.binding.key === 'view:items-view',
      ),
    );
    assert.doesNotMatch(
      JSON.stringify(result.packet),
      /Copper|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa|sortedRecordIds|records|selectedRecordIds/,
    );
  },
);

test(
  'dashboard grids bind their actual placement after leaving a record and never inherit the retired form',
  { timeout: 30000 },
  async (t) => {
    const { origin, solutionDir, sim } = await modelDrivenFixture(t);
    const dashboardId = '30000000-0000-4000-8000-000000000001';
    const xml = `<ImportExportXml><Dashboards><Dashboard><FormId>{${dashboardId}}</FormId><LocalizedNames><LocalizedName description="Fixture board" languagecode="1033"/></LocalizedNames><FormXml><forms type="dashboard"><systemform><formid>{${dashboardId}}</formid><form><tabs><tab><columns><column><sections><section><rows><row><cell><control id="fixture_grid" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"><parameters><TargetEntityType>x_item</TargetEntityType><ViewId>{items-view}</ViewId></parameters></control></cell></row></rows></section></sections></column></columns></tab></tabs></form></systemform></forms></FormXml></Dashboard></Dashboards></ImportExportXml>`;
    await fs.writeFile(path.join(solutionDir, 'Other/Customizations.xml'), xml);
    const mapFile = path.join(solutionDir, 'AppModuleSiteMaps/x_example/AppModuleSiteMap.xml');
    await fs.writeFile(
      mapFile,
      (await fs.readFile(mapFile, 'utf8')).replace(
        '<SubArea Id="items"',
        `<SubArea Id="board" DefaultDashboard="{${dashboardId}}"><Titles><Title LCID="1033" Title="Fixture board"/></Titles></SubArea><SubArea Id="items"`,
      ),
    );
    await sim.reload();
    const imported = await importModelDrivenProject({ solutionRoots: [solutionDir], solutionOrder: 'explicit' });
    const index = createModelDrivenMetadataIndex(imported);
    const key = `dashboard-control:${dashboardId}:fixture_grid:body`;
    const details = index.query({ componentKeys: [key] });
    const page = await chrome.page(t);
    await page.goto(
      origin + '/main.aspx?appname=x_example&pagetype=entityrecord&etn=x_item&id=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    );
    await page.getByRole('heading', { name: 'Copper', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Fixture board', exact: true }).click();
    await page.getByRole('heading', { name: 'Fixture board', exact: true }).waitFor();
    const panel = page.locator('.related-grid');
    await panel.getByRole('table').waitFor();
    await install(page, { origin, localSimulation: true, ...details });
    const placement = await inspect(panel);
    assert.equal(placement.evidence.owner.status, 'exact');
    assert.equal(placement.evidence.owner.component.key, key);
    assert.equal(placement.evidence.source.status, 'exact', JSON.stringify(placement.packet));
    assert.ok(placement.packet.contextFacts.some((fact) => fact.binding.key === 'dashboard:' + dashboardId));
    const cell = await inspect(panel.locator('td[data-id="x_name"]').first());
    assert.equal(cell.evidence.owner.component.key, 'column:x_item:x_name');
    assert.ok(
      ![...placement.packet.contextFacts, ...cell.packet.contextFacts].some((fact) => fact.binding.kind === 'form'),
      'old global form state cannot become dashboard context',
    );
  },
);

test(
  'real PCF mounts and failures report the actual implementation; late completion cannot rebind a retired form',
  { timeout: 30000 },
  async (t) => {
    const { origin, solutionDir, sim } = await modelDrivenFixture(t, { modelDriven: { trustedExtensions: true } });
    const controlDir = path.join(solutionDir, 'Controls/FixtureInput');
    await fs.mkdir(controlDir, { recursive: true });
    await fs.writeFile(
      path.join(controlDir, 'ControlManifest.xml'),
      '<manifest><control namespace="Fixture" constructor="Input" version="1.0.0" control-type="standard"><property name="value" of-type="SingleLine.Text" usage="bound" required="true"/><resources><code path="bundle.js" order="1"/></resources></control></manifest>',
    );
    await fs.writeFile(
      path.join(controlDir, 'ControlManifest.xml.data.xml'),
      '<CustomControl><Name>Fixture.Input</Name></CustomControl>',
    );
    const bundleFile = path.join(controlDir, 'bundle.js');
    const bundle = `window.fixtureBundleLoaded=(window.fixtureBundleLoaded||0)+1;ComponentFramework.registerControl('Fixture.Input',class{init(context,notify,state,container){window.fixtureMounts=(window.fixtureMounts||0)+1;this.input=document.createElement('input');this.input.setAttribute('aria-label','Fixture PCF');container.append(this.input)}updateView(){}getOutputs(){return{}}destroy(){this.input.remove()}});`;
    await fs.writeFile(bundleFile, bundle);
    const formFile = path.join(solutionDir, 'Entities/x_item/FormXml/main/item.xml');
    const uniqueId = '10000000-0000-4000-8000-000000000003';
    await fs.writeFile(
      formFile,
      (await fs.readFile(formFile, 'utf8'))
        .replace(
          '<control datafieldname="x_name"/>',
          `<control id="fixture_scalar" uniqueid="{${uniqueId}}" datafieldname="x_name"/>`,
        )
        .replace(
          '</form>',
          `<controlDescriptions><controlDescription forControl="{${uniqueId}}"><customControl name="Fixture.Input" formFactor="0"><parameters><value type="bound">x_name</value></parameters></customControl><customControl name="Fixture.PhoneInput" formFactor="2"><parameters><value type="bound">x_name</value></parameters></customControl></controlDescription></controlDescriptions></form>`,
        ),
    );
    await sim.reload();
    const imported = await importModelDrivenProject({
      solutionRoots: [solutionDir],
      solutionOrder: 'explicit',
      modelDriven: { trustedExtensions: true },
    });
    const index = createModelDrivenMetadataIndex(imported, { sourceRevision: '1' });
    const details = index.query({ active: { formId: 'item-form' }, componentKeys: ['pcf:fixture.input'] });
    const page = await chrome.page(t);
    let release, requested;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const loading = new Promise((resolve) => {
      requested = resolve;
    });
    t.after(() => release());
    await page.route('**/_apps/controls/**/bundle.js', async (route) => {
      requested();
      await gate;
      await route.continue();
    });
    await page.goto(origin + '/main.aspx?appname=x_example&pagetype=entitylist&etn=x_item');
    await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
    await page.getByRole('button', { name: 'New', exact: true }).click();
    await loading;
    const pending = page.locator('.model-driven-pcf');
    await pending.waitFor({ state: 'attached' });
    await install(page, { origin, localSimulation: true, ...details });
    const before = await inspect(pending);
    assert.equal(before.evidence.owner.component.kind, 'platform-control');
    assert.equal(before.evidence.source.status, 'unavailable');
    assert.ok(
      before.packet.availability.some((item) => item.reason === 'pending'),
      JSON.stringify(before.packet),
    );
    const oldNode = await pending.elementHandle();
    await page.goBack();
    await page.getByRole('button', { name: 'Copper', exact: true }).waitFor();
    release();
    await page.waitForFunction(() => window.fixtureBundleLoaded === 1);
    assert.equal(await page.evaluate(() => window.fixtureMounts ?? 0), 0);
    assert.notEqual((await inspect(oldNode)).evidence.owner.status, 'exact');
    await page.unroute('**/_apps/controls/**/bundle.js');
    await page.getByRole('button', { name: 'New', exact: true }).click();
    const mounted = page.getByLabel('Fixture PCF', { exact: true });
    await mounted.waitFor();
    const actual = await inspect(mounted);
    assert.equal(actual.evidence.owner.status, 'exact');
    assert.equal(actual.evidence.owner.component.key, 'pcf:fixture.input');
    assert.equal(actual.evidence.owner.component.constructorName, 'Fixture.Input');
    assert.equal(actual.evidence.owner.component.namespace, 'Fixture');
    assert.equal(actual.evidence.source.status, 'exact');
    assert.ok(actual.evidence.source.refs.some((ref) => ref.relationship === 'definition'));
    assert.ok(actual.evidence.source.refs.some((ref) => ref.relationship.startsWith('implementation:')));
    assert.ok(actual.evidence.facts.some((fact) => fact.label === 'pcf-form-factor-0'));
    assert.doesNotMatch(JSON.stringify(actual.packet), /Copper|aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/);
    await fs.writeFile(
      bundleFile,
      "ComponentFramework.registerControl('Fixture.Input',class{init(){throw Error('Invented mount failure')}updateView(){}destroy(){}});",
    );
    await sim.reload();
    await page.reload();
    await page.locator('.model-driven-pcf[data-pcf-state="unsupported"]').waitFor();
    await install(page, { origin, localSimulation: true, ...details });
    const failed = await inspect(page.locator('.model-driven-pcf'));
    assert.equal(failed.evidence.owner.component.kind, 'platform-control');
    assert.equal(failed.evidence.source.status, 'unavailable');
    assert.ok(failed.packet.availability.some((item) => item.reason === 'failed'));
    assert.ok(
      failed.evidence.facts.some(
        (fact) => fact.relationship === 'configured-implementation' && fact.component.key === 'pcf:fixture.input',
      ),
    );
  },
);
