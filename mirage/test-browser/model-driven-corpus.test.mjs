import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { sharedBrowser } from './shared-browser.mjs';
import { modelDrivenFixture } from '../test/model-driven-fixture.mjs';
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
test(
  'all 60 invented provenance scenarios execute current DOM/provider observations',
  { timeout: 90000 },
  async (t) => {
    const { origin, root, solutionDir } = await modelDrivenFixture(t);
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
    await page.goto(origin + '/provenance-corpus');
    await page.evaluate(async (assetUrl) => {
      const { createModelDrivenProvenanceRegistry } = await import(assetUrl);
      window.fixtureWriter = createModelDrivenProvenanceRegistry(document);
      window.fixtureWriter.install();
      const surface = document.createElement('div');
      surface.id = 'fixture-surface';
      document.body.append(surface);
    }, origin + '/_apps/assets/provenance-registry.mjs');
    const controller = await startModelDrivenInspector({
      context: page.context(),
      page,
      imported,
      overlay: createModelDrivenOverlay({ origin, imported, localSimulation: true }),
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
    await page.waitForFunction(() => document.getElementById('paqvilo-xray')?.__px);
    const nativePage = await chrome.page(t);
    await nativePage.goto(origin + '/native-corpus');
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
    t.after(() => nativeController.close());
    await nativePage.waitForFunction(() => document.getElementById('paqvilo-xray')?.__px);
    const results = [];
    for (const scenario of scenarios)
      await t.test(scenario.id, async () => {
        const values = scenario.facts,
          native = scenario.host === 'native';
        const sourceDefinitions = values.filter((fact) => fact.predicate === 'exportSource');
        let ownerValues = values
          .filter(
            (fact) =>
              fact.predicate === 'selectedOwner' ||
              (fact.predicate === 'currentView' &&
                fact.via === 'mirage.host.binding' &&
                !values.some((item) => item.predicate === 'selectedOwner')),
          )
          .map((fact) => fact.object);
        const mounted = values.find((fact) => fact.predicate === 'mountedComponent')?.object;
        const failed = values.some((fact) => fact.predicate === 'componentMount' && fact.object.state !== 'mounted');
        if (mounted) ownerValues = [mounted.componentRef];
        if (failed) ownerValues = ['platform-control:pcf-failed'];
        const missing =
          values.some((fact) => fact.predicate === 'sourceRead' && fact.object.state !== 'available') ||
          scenario.id === 'bounded-response-defers-source-retains-exact-owner';
        let sources = missing
          ? []
          : sourceDefinitions.flatMap((fact) => index.sourceRefsFor([keyOf(fact.object.componentRef)]));
        if (scenario.id === 'same-component-layer-source-conflict')
          sources = [
            ...index.sourceRefsFor([keyOf(ownerValues[0])]),
            ...alternateIndex.sourceRefsFor([keyOf(ownerValues[0])]),
          ];
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
          await nativePage.evaluate(
            ({ current, requestedForm, requestedView, domName, controls }) => {
              const surface = document.getElementById('fixture-native-surface');
              surface.replaceChildren();
              window.fixtureForbiddenReads = 0;
              const node = document.createElement(domName ? 'input' : 'form');
              if (domName) node.setAttribute('name', domName);
              surface.append(node);
              const forbidden = () => {
                window.fixtureForbiddenReads++;
                throw Error('Record/user reads are forbidden');
              };
              const rows = controls.map(([, name]) => ({
                getName: () => name,
                getControlType: () => 'standard',
                getAttribute: () => ({ getName: () => 'fixture_title', getValue: forbidden }),
              }));
              const collection = (items) => ({ getLength: () => items.length, get: (position) => items[position] });
              window.Xrm = {
                Utility: {
                  getPageContext: () => ({
                    input: {
                      pageType: 'entityrecord',
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
                    formSelector: {
                      getCurrentItem: () => (current ? { getId: () => current.split(':').at(-1) } : null),
                    },
                    getFormType: () => 1,
                    controls: collection(rows),
                    tabs: collection([]),
                    quickForms: collection([]),
                  },
                  getControl: (name) => rows.find((row) => row.getName() === name),
                },
              };
            },
            { current, requestedForm, requestedView, domName, main, controls },
          );
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
            budget: { items: 128, bytes: 256 * 1024 },
          });
          await nativePage.evaluate(
            `(${modelDrivenObservationRuntime.toString()})().install(${JSON.stringify({ token: selection.token, origin, localSimulation: false, ...details, validatedScope: scope, validatedAnchorGeneration: selection.anchorGeneration })})`,
          );
          const observed = await nativePage.evaluate(({ scope, anchorGeneration }) => {
            window.fixtureForbiddenReads = 0;
            const packet = window.__paqviloModelDrivenProvider.query(
              document.getElementById('fixture-native-surface').firstElementChild,
              { scope, anchorGeneration },
            );
            return { packet, forbidden: window.fixtureForbiddenReads };
          }, selection);
          packet = observed.packet;
          assert.equal(observed.forbidden, 0);
          assert.ok(packet.facts.every((fact) => fact.proof !== 'mirage-registry'));
          if (
            ['nested-cross-origin-frame-boundary', 'parent-frame-xrm-not-child-current-context'].includes(scenario.id)
          ) {
            const opaque = scenario.id === 'nested-cross-origin-frame-boundary';
            await nativePage.evaluate((opaque) => {
              const frame = document.createElement('iframe');
              frame.id = 'fixture-child-boundary';
              if (opaque) frame.setAttribute('sandbox', '');
              frame.srcdoc = '<form></form>';
              document.getElementById('fixture-native-surface').append(frame);
            }, opaque);
            const frame = await nativePage.locator('#fixture-child-boundary').elementHandle();
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
            async ({ bindings, sources, context, assetUrl }) => {
              const surface = document.getElementById('fixture-surface');
              surface.replaceChildren();
              const node = document.createElement('input');
              node.setAttribute('data-id', 'forged-page-token');
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
            { bindings, sources, context, assetUrl: origin + '/_apps/assets/provenance-registry.mjs' },
          );
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
            scope = child.scope;
            if (scenario.id !== 'same-origin-child-frame-direct-binding')
              scope = await page.evaluate(async () => {
                const frame = document.querySelector('#fixture-surface iframe');
                frame.srcdoc = '<input id="replacement-child">';
                await new Promise((resolve) => frame.addEventListener('load', resolve, { once: true }));
                return document
                  .getElementById('paqvilo-xray')
                  .__px.getSelectionScope(frame.contentDocument.getElementById('replacement-child'));
              });
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
            const refused = await page.evaluate(async () => {
              const tools = document.getElementById('paqvilo-xray').__px,
                node = document.getElementById('fixture-surface').firstElementChild;
              tools.select(node);
              const previous = tools.selectionState();
              const replacement = document.createElement('button');
              document.getElementById('fixture-surface').append(replacement);
              tools.select(replacement);
              return window.__paqviloModelPanelApi({
                token: tools.token,
                name: 'provenance',
                body: { version: 1, active: {}, scope: previous.scope, anchorGeneration: previous.anchorGeneration },
              });
            });
            assert.equal(refused.ok, false);
            assert.equal(refused.reason, 'selection-obsolete');
            packet.facts = [];
            packet.sourceRefs = [];
          }
          // This is an actual foreign frame dispatch, not a forged return packet.
          if (scenario.id === 'out-of-origin-provider-response-refused') {
            const frame = await page.evaluateHandle(() => {
              const frame = document.createElement('iframe');
              frame.srcdoc = '<div>Fixture child</div>';
              document.body.append(frame);
              return frame;
            });
            const child = await frame.asElement().contentFrame();
            await child.waitForLoadState();
            const token = await page.evaluate(() => document.getElementById('paqvilo-xray').__px.token);
            const refused = await child.evaluate(
              async (token) =>
                typeof window.__paqviloModelPanelApi === 'function'
                  ? window.__paqviloModelPanelApi({ token, name: 'provenance', body: { version: 1, active: {} } })
                  : { ok: false },
              token,
            );
            assert.equal(refused.ok, false);
            await frame.evaluate((node) => node.remove());
            packet.facts = [];
            packet.sourceRefs = [];
          }
          if (
            scenario.id === 'parent-frame-xrm-not-child-current-context' ||
            scenario.id === 'nested-cross-origin-frame-boundary'
          ) {
            assert.equal(packet.facts.length, 0);
            packet.sourceRefs = [];
          }
        }
        const result = resolveInspectionEvidence({ ...packet, scope, node: { connected: true } });
        assert.equal(result.owner.status, scenario.truth.owner, scenario.truth.rationale);
        assert.equal(result.source.status, scenario.truth.source, scenario.truth.rationale);
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
        if (failed) {
          assert.equal(result.owner.component.key, 'platform-control:pcf-failed');
          assert.equal(result.source.status, 'unavailable');
        }
        if (missing) assert.equal(result.source.status, 'unavailable');
        if (ownerValues.length > 1) assert.equal(result.owner.status, 'conflicting');
        results.push({
          id: scenario.id,
          mode: native ? 'documented-native-api-dom-fixture' : 'private-registry-dom-fixture',
          owner: result.owner.status,
          source: result.source.status,
          previousExpected: scenario.previousExpected,
        });
      });
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
  },
);
