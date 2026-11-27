// @test-kind contract: Mirage render provenance design for the documents the runtime composes outside the page layout (modal form, quick view, sign-in page) and the local head additions: every element names the configuration that produced it, and the response bytes differ only by the provenance stamps
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'parse5';
import YAML from 'yaml';
import { createSimulator } from '../api.mjs';
import { signInHeaders } from '../testing.mjs';
import { importPortal } from '../lib/importer.mjs';
import { importSolutionMetadata } from '../lib/solution-metadata.mjs';
import { scanSolutionSources, buildSolutionSchema } from '../lib/solution-schema.mjs';
import { isToolkitElement } from '../lib/render-provenance.mjs';
import { injectLocalHead } from '../lib/local-overrides.mjs';
import { createSolutionMetadataOverlay } from '../lib/dataverse-solution-metadata.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../examples/project');
const ROOTS = ['code-solution', 'metadata', 'solution'].map((root) => path.join(project, root));
const ACCOUNT = 'a4300000-0000-4000-8000-000000001001';
const CONTACT = 'a4300000-0000-4000-8000-000000002001';
const ACCOUNT_EDIT = 'b4700000-0000-4000-8000-9abf530078c2';
const CONTACT_READ = 'b4700000-0000-4000-8000-a60d601cabaa';
const WEBSITE = 'b4700000-0000-4000-8000-d31ddbcbde91';
const STAMPS = / data-paqvilo-source="[^"]*"/g;

let shared;
const closers = [];
after(async () => {
  for (const close of closers.reverse()) await close();
});
/** The example project served on loopback, with two local head assets (mirage.head) in a temporary project root. */
function exampleSimulator() {
  shared ??= (async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'paqvilo-document-provenance-'));
    closers.push(() => fsp.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
    await fsp.mkdir(path.join(root, 'local'), { recursive: true });
    await fsp.writeFile(path.join(root, 'local', 'invented.css'), '.invented-local { color: teal; }\n');
    await fsp.writeFile(path.join(root, 'local', 'invented.js'), 'window.inventedLocal = true;\n');
    const config = YAML.parse(fs.readFileSync(path.join(project, 'paqvilo.config.yml'), 'utf8')).sites.example.mirage;
    const sim = await createSimulator({
      sourceDir: path.join(project, 'portal'),
      solutionRoots: ROOTS,
      solutionOrder: 'explicit',
      dataPacks: [{ id: 'example', module: path.join(project, 'pack/pack.mjs') }],
      preset: config.preset,
      presetMode: config.presetMode,
      observed: config.observed,
      stateFile: path.join(root, 'state.json'),
      projectRoot: root,
      head: { stylesheets: ['local/invented.css'], scripts: ['local/invented.js'] },
      port: 0,
      watch: false,
    });
    closers.push(() => sim.close());
    return sim;
  })();
  return shared;
}

/** A document requested as a browser navigation (sec-fetch-dest), with its published render proof. */
async function provedDocument(sim, target, { dest = 'document', headers = {} } = {}) {
  const response = await fetch(sim.url + target, {
    headers: { accept: 'text/html', 'sec-fetch-dest': dest, ...headers },
  });
  const html = await response.text();
  assert.equal(response.status, 200, html.slice(0, 400));
  const proofId = response.headers.get('x-paqvilo-provenance');
  assert.ok(proofId, `${target} publishes a render proof`);
  const proof = await fetch(`${sim.url}/_sim/api/page-provenance?proof=${encodeURIComponent(proofId)}`, {
    headers: {
      'x-sim-csrf': sim.csrf,
      'x-paqvilo-provenance-access': response.headers.get('x-paqvilo-provenance-access'),
    },
  });
  assert.equal(proof.status, 200);
  return { html, provenance: await proof.json() };
}

const attr = (node, name) => node.attrs?.find((item) => item.name === name)?.value;
/** Every element of the document that is not a toolkit injection, with its binding. */
function elements(html, provenance) {
  const bindings = new Map(provenance.bindings.map((item) => [item.id, item]));
  const rows = [];
  const walk = (node, ancestors) => {
    for (const child of node.childNodes ?? []) {
      if (!child.tagName) continue;
      const toolkit = isToolkitElement(child.attrs.map((item) => item.name));
      if (!toolkit)
        rows.push({ node: child, ancestors, binding: bindings.get(attr(child, 'data-paqvilo-source')) ?? null });
      walk(child, [...ancestors, child]);
      if (child.content) walk(child.content, [...ancestors, child]);
    }
  };
  walk(parse(html), []);
  return rows;
}
const describe = (node) =>
  `<${node.tagName}${node.attrs.map((item) => ` ${item.name}="${item.value.slice(0, 40)}"`).join('')}>`;
const unbound = (rows) => rows.filter((row) => !row.binding).map((row) => describe(row.node));
const under = (rows, predicate) => rows.filter((row) => row.ancestors.some(predicate) || predicate(row.node));
const refKeys = (binding, refs) =>
  (binding.sourceRefIds ?? []).map((id) => refs.get(id)?.componentKey ?? refs.get(id)?.kind);

test('a modal edit form document names the basic form, its FormXml controls and columns, not the document shell', async () => {
  const sim = await exampleSimulator();
  const target = `/_portal/modal-form-template-path/${WEBSITE}?entityformid=${ACCOUNT_EDIT}&id=${ACCOUNT}`;
  const { html, provenance } = await provedDocument(sim, target, {
    dest: 'iframe',
    headers: signInHeaders(sim, CONTACT),
  });
  const rows = elements(html, provenance);
  assert.deepEqual(unbound(rows), []);
  const refs = new Map(provenance.sourceRefs.map((ref) => [ref.id, ref]));
  const form = under(rows, (node) => attr(node, 'id') === 'EntityFormControl');
  assert.ok(form.length > 50, 'the modal renders the edit form');
  for (const { node, binding } of form)
    assert.notEqual(binding.component.key, 'platform-shell:modal-form', `${describe(node)} names its form part`);
  const name = form.filter(({ binding }) => binding.component.key === 'column:account:name');
  assert.ok(
    name.some(({ node }) => node.tagName === 'input'),
    'the name input names its column',
  );
  const keys = refKeys(name[0].binding, refs);
  assert.match(keys[0], /^control:a4200000-0000-4000-8000-000000000101:name:body$/, 'the FormXml control first');
  assert.ok(keys.includes('column:account:name'));
  assert.equal(
    refs.get(name[0].binding.contexts?.[0]?.sourceRefId)?.componentKey,
    `basic-form:${ACCOUNT_EDIT}`,
    'the basic form the list action opens is the context',
  );
  assert.ok(refs.get(name[0].binding.sourceRefIds[0]).region, 'the control ref carries its FormXml region');
  // The document around the form stays the platform's.
  const content = rows.find(({ node }) => attr(node, 'id') === 'content_form');
  assert.equal(content.binding.component.key, 'platform-shell:modal-form');
});

test('a quick view document names the quick view form, its fields and the host form control', async () => {
  const sim = await exampleSimulator();
  const portal = await importPortal(path.join(project, 'portal'));
  const scan = await scanSolutionSources(ROOTS, { order: 'explicit' });
  const metadata = await importSolutionMetadata(ROOTS, {
    portal,
    scan,
    schema: buildSolutionSchema(scan, { lcid: 1033 }),
  });
  const contactForm = metadata.componentSchemas[CONTACT_READ];
  const hostForm = metadata.componentSchemas[ACCOUNT_EDIT];
  // An invented quick view on the account form: the primary contact's read-only contact form.
  const quick = {
    type: 'quickform',
    id: 'primarycontactid',
    entity: 'contact',
    lookup: 'primarycontactid',
    label: 'Primary contact',
    schema: { ...contactForm, formName: 'Invented contact quick view' },
  };
  const configured = await fetch(sim.url + '/_sim/api/config', {
    method: 'PATCH',
    headers: { 'x-sim-csrf': sim.csrf, 'content-type': 'application/json' },
    body: JSON.stringify({
      componentSchemas: {
        [ACCOUNT_EDIT]: {
          ...hostForm,
          layout: [{ name: 'quick', columns: [{ sections: [{ name: 'quick', rows: [[quick]] }] }] }],
        },
      },
    }),
  });
  assert.equal(configured.status, 200, await configured.text());
  const { html, provenance } = await provedDocument(
    sim,
    `/_portal/quickform-template-path/${WEBSITE}?entityid=${CONTACT}&entityname=contact&controlid=primarycontactid`,
    { dest: 'iframe', headers: signInHeaders(sim, CONTACT) },
  );
  const rows = elements(html, provenance);
  assert.deepEqual(unbound(rows), []);
  const refs = new Map(provenance.sourceRefs.map((ref) => [ref.id, ref]));
  const panel = rows.find(({ node }) => attr(node, 'id') === 'ContentContainer_FormPanel');
  assert.equal(panel.binding.component.kind, 'quick-view');
  assert.equal(panel.binding.component.key, `form:${contactForm.formId}`, 'the quick view form');
  assert.equal(panel.binding.component.controlName, 'primarycontactid');
  assert.equal(panel.binding.component.hostFormId, hostForm.formId);
  assert.equal(
    refKeys(panel.binding, refs)[0],
    `control:${hostForm.formId}:primarycontactid:body`,
    'the host form control that hosts the quick view',
  );
  assert.equal(refs.get(panel.binding.contexts?.[0]?.sourceRefId)?.componentKey, `basic-form:${ACCOUNT_EDIT}`);
  const inside = under(rows, (node) => attr(node, 'id') === 'ContentContainer_FormPanel');
  for (const { node, binding } of inside)
    assert.notEqual(binding.component.key, 'platform-shell:quick-view', `${describe(node)} names its quick view part`);
  const field = inside.find(({ binding }) => binding.component.kind === 'field');
  assert.ok(field, 'a quick view field');
  assert.match(refKeys(field.binding, refs)[0], new RegExp(`^control:${contactForm.formId}:`), 'its FormXml control');
});

test('the sign-in page binds the local sign-in and the account tabs to the settings that configure them', async () => {
  const sim = await exampleSimulator();
  const { html, provenance } = await provedDocument(sim, '/SignIn');
  const rows = elements(html, provenance);
  assert.deepEqual(unbound(rows), []);
  const refs = new Map(provenance.sourceRefs.map((ref) => [ref.id, ref]));
  const setting = (binding) => (binding.sourceRefIds ?? []).map((id) => refs.get(id)?.name).sort();
  const local = under(rows, (node) => /paqvilo-mirage-local-accounts/.test(attr(node, 'class') ?? ''));
  assert.ok(local.length > 3);
  for (const { node, binding } of local) {
    assert.equal(binding.component.key, 'platform-shell:sign-in#local-sign-in', describe(node));
    assert.deepEqual(setting(binding), ['Authentication/Registration/LocalLoginEnabled']);
  }
  const container = rows.find(({ node }) => attr(node, 'id') === 'content-container');
  assert.equal(container.binding.component.key, 'platform-shell:sign-in');
  assert.deepEqual(container.binding.sourceRefIds, [], 'the account layout itself is not configured by a setting');
  // The local head assets are the project's files, bound as local additions.
  const head = rows.filter(({ node }) => attr(node, 'data-sim-local-only') === 'head');
  assert.deepEqual(head.map(({ binding }) => binding.component.key).sort(), [
    'local-head:local/invented.css',
    'local-head:local/invented.js',
  ]);
  for (const { binding } of head) {
    const ref = refs.get(binding.sourceRefIds[0]);
    assert.equal(ref.ref, binding.component.key.slice('local-head:'.length));
    assert.ok(ref.contentRevision && ref.sourceRevision && ref.key);
  }
});

test('local head additions of a page are bound to their project files and change no bytes but the stamps', async () => {
  const sim = await exampleSimulator();
  const { html, provenance } = await provedDocument(sim, '/');
  const rows = elements(html, provenance);
  assert.deepEqual(unbound(rows), []);
  const head = rows.filter(({ node }) => attr(node, 'data-sim-local-only') === 'head');
  assert.equal(head.length, 2);
  assert.ok(head.every(({ binding }) => binding.component.kind === 'local-head'));
  // The same injection without a proof writes the same markup without stamps.
  const overrides = {
    assets: [
      {
        kind: 'stylesheets',
        file: path.join(os.tmpdir(), 'none.css'),
        root: os.tmpdir(),
        url: '/_sim-local/head/0.css',
      },
    ],
  };
  const plain = injectLocalHead('<html><head></head><body></body></html>', overrides);
  const proof = { proofId: 'p', sourceRevision: 'r', bindings: [], sourceRefs: [] };
  const stamped = injectLocalHead('<html><head></head><body></body></html>', overrides, proof);
  assert.equal(stamped.replaceAll(STAMPS, ''), plain);
  assert.equal(proof.bindings.length, 0, 'an unreadable file is not bound');
});

test('a systemform without a declared type keeps its file origin when its row is the import default', () => {
  // The import writes a systemform row of type 2 when the FormXml declares no <type>; the effective metadata must not
  // treat that as a change (it withheld every FormXml source ref of the running site).
  const formId = 'c0de0000-0000-4000-8000-0000000000e1';
  const xml = '<form><tabs></tabs></form>';
  const base = { forms: [{ id: formId, entity: 'invented', name: 'Invented', xml }], views: [], entities: {} };
  const row = { formid: formId, name: 'Invented', formxml: xml, type: 2, formactivationstate: 1 };
  const overlay = (...args) => createSolutionMetadataOverlay()(...args);
  const state = (current) => ({
    tables: { systemform: [current] },
    dataverse: { sourceSolutionComponents: { baseline: { [`systemform/${formId}`]: {} } } },
  });
  const effective = overlay(base, state(row));
  assert.notEqual(effective.forms[0].sourceOriginVerified, false);
  const changed = overlay(base, state({ ...row, type: 6 }));
  assert.equal(changed.forms[0].sourceOriginVerified, false, 'a changed type is still a change');
  const declared = overlay({ ...base, forms: [{ ...base.forms[0], systemFormType: 6 }] }, state(row));
  assert.equal(declared.forms[0].sourceOriginVerified, false, 'a declared type differing from the row is a change');
});

test('a proved page, sign-in page and modal form document differ from the unproved response only by the stamps', async () => {
  const sim = await exampleSimulator();
  // Per-request runtime identifiers (trace and span ids of the toolkit runtime) differ between any two responses.
  const normalize = (html) =>
    html
      .replace(/ data-paqvilo-(?:source|script)="[^"]*"/g, '')
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '<uuid>')
      .replace(/[0-9a-f]{16,}/g, '<hex>');
  const target = `/_portal/modal-form-template-path/${WEBSITE}?entityformid=${ACCOUNT_EDIT}&id=${ACCOUNT}`;
  for (const url of ['/', '/SignIn', target]) {
    const get = async (dest) =>
      (
        await fetch(sim.url + url, {
          headers: { accept: 'text/html', ...(dest ? { 'sec-fetch-dest': dest } : {}), ...signInHeaders(sim, CONTACT) },
        })
      ).text();
    const proved = await get('iframe');
    assert.match(proved, /data-paqvilo-source=/);
    assert.equal(normalize(proved), normalize(await get(null)), url);
  }
});
