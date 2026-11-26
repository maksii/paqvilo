// Adapter for the pcf-form-admission surface: one recorded basic-form column binding -> a Mirage simulator holding that
// column, its form cell and control description, the bound control's exported manifest and the basic form metadata
// row -> whether the served form hosts a code component for the column, renders the native control, or renders
// nothing for it.
// Only `input` drives Mirage. The recorded input is exported source: the column's `<attribute>` element (Entity.xml),
// the FormXml cell and `<controlDescription>`, the control's ControlManifest.xml and text resources, the basic form
// fields and its metadata row. The served page is read over HTTP (no browser): admission is decided on the server.
// One simulator per case file: every case replaces the portal and Solution sources and reloads them.
// Classification is the recorder's own rule, applied to Mirage's page unchanged: a host span
// `id="PcfControlConfig_<column>"` is a component, the column's own element or label id is native, neither is absent.
// The platform libraries (React, ReactDOM, Fluent UI) are provided by the Power Pages host; Mirage needs them as project
// files (pcf.platformLibraries), so the adapter writes empty stand-ins of the live set.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';

const yaml = (fields) =>
  Object.entries(fields)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' && /[:#'"\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value}`,
    )
    .join('\n');

/** The files of a one-column fixture: portal YAML, Solution entity, form and control. */
function fixtureFiles(input) {
  const { entity, column, attribute, cell, controlDescription, control, basicForm, metadata } = input;
  const formName = basicForm.adx_formname;
  const files = {
    'portal/website.yml': 'adx_websiteid: site\nadx_name: Invented PCF admission site',
    'portal/Home.webpage.yml':
      'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': `{% entityform name:${JSON.stringify(basicForm.adx_name)} %}`,
    'portal/Form.basicform.yml': yaml({ adx_entityformid: 'form', ...basicForm }),
    // A column without a metadata row keeps the form's default rendering.
    ...(metadata
      ? {
          'portal/Form.basicform.basicformmetadata.yml': `- ${yaml({ adx_entityformmetadataid: 'metadata', adx_entityform: 'form', ...Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== null)) }).replace(/\n/g, '\n  ')}`,
        }
      : {}),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedAdmission</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    [`solution/Entities/${entity}/Entity.xml`]: `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><attributes>${attribute}</attributes></entity></EntityInfo></Entity>`,
    [`solution/Entities/${entity}/FormXml/main/form.xml`]: `<forms><systemform><formid>{a0000000-0000-4000-8000-000000000001}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows><row>${cell}</row></rows></section></sections></column></columns></tab></tabs><controlDescriptions>${controlDescription ?? ''}</controlDescriptions></form><LocalizedNames><LocalizedName description="${formName}" languagecode="1033"/></LocalizedNames></systemform></forms>`,
  };
  if (control) {
    const dir = `solution/Controls/${control.name}`;
    files[`${dir}/ControlManifest.xml`] = control.manifest;
    files[`${dir}/ControlManifest.xml.data.xml`] = `<CustomControl><Name>${control.name}</Name></CustomControl>`;
    for (const [relative, text] of Object.entries(control.files ?? {})) files[`${dir}/${relative}`] = text;
  }
  return { files, column };
}

// The libraries Power Pages provides on every page with a code component (Mirage's own record of the live set,
// lib/pcf-sources.mjs LIVE_PLATFORM_LIBRARIES); Mirage serves them only from project files.
const LIVE_PLATFORM_LIBRARIES = [
  ['React', '16.14.0'],
  ['ReactDOM', '16.14.0'],
  ['FluentUIReact', '8.122.8'],
];

/**
 * Empty stand-ins for the platform libraries the Power Pages host provides (the bundles never run in a replay).
 * @param {string} root temporary fixture folder
 * @returns {Promise<string[]>} the `<Library>@<version>.js` files for pcf.platformLibraries
 */
export async function platformLibraryFiles(root) {
  const files = [];
  for (const [name, version] of LIVE_PLATFORM_LIBRARIES) {
    const file = path.join(root, 'libraries', `${name}@${version}.js`);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '');
    files.push(file);
  }
  return files;
}

async function writeFixture(root, input) {
  // Every case replaces the whole fixture: nothing of an earlier column stays for the reload.
  for (const folder of ['portal', 'solution']) await fs.rm(path.join(root, folder), { recursive: true, force: true });
  const { files } = fixtureFiles(input);
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/**
 * Opens one session for a case file: one simulator, whose sources are replaced and reloaded for every case.
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ run: Function, close: Function }>} session whose run serves one recorded column binding and
 *   returns { rendering: 'component' | 'native' | 'absent' }, what the served form shows for the column
 */
export async function open(_context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-form-admission-'));
  let app = null;
  let entity = null;
  return {
    async run(input, _caseContext) {
      await writeFixture(root, input);
      if (app === null) {
        entity = input.entity;
        app = await createSimulator({
          sourceDir: path.join(root, 'portal'),
          solutionRoots: [path.join(root, 'solution')],
          pcf: { platformLibraries: await platformLibraryFiles(root) },
          port: 0,
          watch: false,
          initial: {
            version: 1,
            mappings: { [entity]: { entitySet: `${entity}s`, idColumn: `${entity}id` } },
            tables: { [entity]: [] },
            permissions: [],
            settings: { permissionMode: 'permissive' },
            simulator: {
              mode: 'local',
              pageMode: 'local',
              identity: { id: 'editor', roles: ['Editor'] },
              endpoints: [],
              live: { origin: null },
              componentSchemas: {},
            },
          },
        });
      } else {
        assert.equal(input.entity, entity, 'every case of the file must bind a column of the same table');
        await app.reload();
      }
      const { column } = input;
      const html = await (
        await fetch(app.url, { headers: signInHeaders(app, 'editor', { roles: ['Editor'] }) })
      ).text();
      if (html.includes(`id="PcfControlConfig_${column}"`)) return { rendering: 'component' };
      if (html.includes(`id="${column}"`) || html.includes(`id="${column}_label"`)) return { rendering: 'native' };
      return { rendering: 'absent' };
    },
    async close() {
      await app?.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}
