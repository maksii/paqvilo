// Adapter for the pcf-liquid-tag surface: a recorded page copy holding one Liquid `codecomponent` case -> a Mirage
// simulator serving that copy, with the recorded control manifests imported as Solution controls -> how many code
// component hosts the served page has and whether the copy after the tag was served.
// Only `input` drives Mirage: the page copy, the marker that follows the tag in that copy, the manifests of the controls
// the site had (name, namespace, constructor, control type, properties, data sets, platform libraries) and, for a
// GUID-named tag, the observed id-to-control map. The copy is served through the platform's stock "Default studio
// template" (`{% editable page 'adx_copy' type: 'html', liquid: true %}`), the page template of the recorded pages.
// One simulator per case file imports the manifests once and reloads the page copy per case; every case of the file
// must carry the same manifests and observed settings.
// Hosts are counted with the recorder's own rule: the spans `id="PcfControlConfig_…"` carrying `data-pcf-control`.
// The platform libraries (React, ReactDOM, Fluent UI) are provided by the Power Pages host; Mirage needs them as project
// files (pcf.platformLibraries), written as empty stand-ins of the live set (pcf-form-admission.mjs platformLibraryFiles).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';
import { platformLibraryFiles } from './pcf-form-admission.mjs';

const escape = (text) =>
  String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The ControlManifest.xml of one recorded control summary. */
function manifestOf(control) {
  const groups = (control.typeGroups ?? [])
    .map(
      (group) =>
        `<type-group name="${escape(group.name)}">${group.types.map((type) => `<type>${escape(type)}</type>`).join('')}</type-group>`,
    )
    .join('');
  const properties = (control.properties ?? [])
    .map(
      (property) =>
        `<property name="${escape(property.name)}" ${property.ofTypeGroup ? `of-type-group="${escape(property.ofTypeGroup)}"` : `of-type="${escape(property.ofType)}"`} usage="${escape(property.usage)}"${property.required ? ' required="true"' : ''}${property.defaultValue === undefined ? '' : ` default-value="${escape(property.defaultValue)}"`}/>`,
    )
    .join('');
  const datasets = (control.datasets ?? []).map((dataset) => `<data-set name="${escape(dataset.name)}"/>`).join('');
  const libraries = (control.platformLibraries ?? [])
    .map((library) => `<platform-library name="${escape(library.name)}" version="${escape(library.version)}"/>`)
    .join('');
  const dependencies = (control.dependencies ?? [])
    .map(
      (dependency) =>
        `<dependency type="${escape(dependency.type)}" name="${escape(dependency.name)}"${dependency.loadType ? ` load-type="${escape(dependency.loadType)}"` : ''}/>`,
    )
    .join('');
  return `<manifest><control namespace="${escape(control.namespace)}" constructor="${escape(control.constructor)}" control-type="${escape(control.controlType ?? 'standard')}">${groups}${properties}${datasets}<resources>${dependencies}<code path="bundle.js"/>${libraries}</resources></control></manifest>`;
}

const PAGE = {
  'website.yml': 'adx_websiteid: site\nadx_name: Invented PCF Liquid site',
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: studio',
  'Case.webpage.yml':
    'adx_webpageid: case\nadx_name: Case\nadx_partialurl: case\nadx_parentpageid: home\nadx_pagetemplateid: studio',
  'Studio.pagetemplate.yml':
    'adx_pagetemplateid: studio\nadx_name: Default studio template\nadx_type: 756150001\nadx_webtemplateid: studio\nadx_usewebsiteheaderandfooter: true',
  'Studio.webtemplate.yml': 'adx_webtemplateid: studio\nadx_name: Default studio template',
  'Studio.webtemplate.source.html':
    '<div id="mainContent" class="wrapper-body" role="main"><div class="page-copy">{% editable page \'adx_copy\' type: \'html\', liquid: true %}</div></div>',
};

async function start(root, input, context) {
  const portal = path.join(root, 'portal');
  await fs.mkdir(portal, { recursive: true });
  for (const [name, content] of Object.entries(PAGE)) await fs.writeFile(path.join(portal, name), content);
  await fs.writeFile(path.join(portal, 'Case.webpage.copy.html'), input.copy);
  const solution = path.join(root, 'solution');
  await fs.mkdir(path.join(solution, 'Other'), { recursive: true });
  await fs.writeFile(
    path.join(solution, 'Other', 'Solution.xml'),
    '<ImportExportXml><SolutionManifest><UniqueName>InventedLiquid</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  );
  for (const control of input.controls) {
    const dir = path.join(solution, 'Controls', control.name);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, 'ControlManifest.xml'), manifestOf(control));
    await fs.writeFile(
      path.join(dir, 'ControlManifest.xml.data.xml'),
      `<CustomControl><Name>${escape(control.name)}</Name></CustomControl>`,
    );
    // The bundle never runs here: only the served page is compared.
    await fs.writeFile(
      path.join(dir, 'bundle.js'),
      `ComponentFramework.registerControl('${control.namespace}.${control.constructor}', class {});`,
    );
  }
  return createSimulator({
    sourceDir: portal,
    solutionRoots: [solution],
    pcf: { platformLibraries: await platformLibraryFiles(root) },
    // A recorded id-to-control map is an observation; the case file is its evidence.
    ...(input.observed
      ? {
          observed: {
            ...structuredClone(input.observed),
            evidence: `recorded case file ${context.surface}/${context.suite}`,
          },
        }
      : {}),
    port: 0,
    watch: false,
    initial: {
      version: 1,
      mappings: {},
      tables: {},
      permissions: [],
      settings: { permissionMode: 'permissive' },
      simulator: { mode: 'local', pageMode: 'local', endpoints: [], live: { origin: null }, componentSchemas: {} },
    },
  });
}

/**
 * Opens one session for a case file: a simulator holding the recorded control manifests.
 * @param {{ surface: string, suite: string }} context frozen names of the case file (named as the observed evidence)
 * @returns {Promise<{ run: Function, close: Function }>} session whose run returns { hosts, copyAfterTag }
 */
export async function open(context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-liquid-tag-'));
  let session = null;
  return {
    async run(input, _caseContext) {
      if (session === null) {
        session = {
          app: await start(root, input, context),
          controls: structuredClone(input.controls),
          observed: structuredClone(input.observed ?? {}),
        };
      } else {
        assert.deepStrictEqual(
          input.controls,
          session.controls,
          'the control manifests must be identical across the case file',
        );
        assert.deepStrictEqual(
          input.observed ?? {},
          session.observed,
          'the observed settings must be identical across the case file',
        );
        await fs.writeFile(path.join(root, 'portal', 'Case.webpage.copy.html'), input.copy);
        await session.app.reload();
      }
      const { app } = session;
      const response = await fetch(`${app.url}/case/`, { headers: signInHeaders(app, 'visitor', { roles: [] }) });
      const html = await response.text();
      assert.ok(html.includes('id="mainContent"'), `the case page must be served (HTTP ${response.status})`);
      return {
        hosts: (html.match(/<span id="PcfControlConfig_[^"]*" data-pcf-control="/g) ?? []).length,
        copyAfterTag: html.includes(input.afterMarker),
      };
    },
    async close() {
      await session?.app.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
