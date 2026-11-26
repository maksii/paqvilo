// Adapter for the pcf-form-save surface: one recorded edit basic form (its columns' exported `<attribute>` elements,
// FormXml cells and control descriptions, the bound controls' manifests, the basic form and its metadata rows), the
// seeded row and the site language -> a Mirage simulator serving that form for the row -> the number boxes it serves,
// or the values the row holds after a native postback of the recorded field texts.
// Only `input` drives Mirage. The page is read and posted over HTTP (no browser), as the native form posts back: every
// named input of the served form with the recorded texts in place of the columns' own inputs (a code component
// column's hidden input carries its JSON value) and the form's Update button.
// Projection: a served box is its `value` and `data-numberdecimalseparator` attributes; a stored value is the row's
// value read back through Mirage's portal Web API (the recorder read the Dataverse Web API, the same JSON value form).
// With `observe: 'submitControls'` the served page's submit controls are read with the recorder's selector instead.
// The platform libraries (React, ReactDOM, Fluent UI) are provided by the Power Pages host; Mirage needs them as project
// files (pcf.platformLibraries), written as empty stand-ins of the live set (pcf-form-admission.mjs platformLibraryFiles).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';
import { platformLibraryFiles } from './pcf-form-admission.mjs';

// Invented identities: the recorded input names the row by its values only.
const ROW = '70000000-0000-4000-8000-0000000000f5';
const CONTACT = '70000000-0000-4000-8000-0000000000f6';
const FORM = '70000000-0000-4000-8000-0000000000f7';

const yaml = (fields) =>
  Object.entries(fields)
    .map(
      ([key, value]) =>
        `${key}: ${typeof value === 'string' && /[:#'"\n]|^\s|\s$/.test(value) ? JSON.stringify(value) : value}`,
    )
    .join('\n');
const list = (rows) => rows.map((row) => `- ${yaml(row).replace(/\n/g, '\n  ')}`).join('\n');

/** The files of the recorded form: portal YAML (site languages, the form page), Solution entity, form and controls. */
function fixtureFiles({ entity, language, basicForm, columns }) {
  const languages = [{ code: 'en-US', lcid: 1033 }, ...(language.code === 'en-US' ? [] : [language])];
  const id = (code) => `language-${code.toLowerCase()}`;
  const files = {
    'portal/website.yml': yaml({
      adx_websiteid: 'site',
      adx_name: 'Invented PCF save site',
      adx_defaultlanguage: id('en-US'),
      adx_website_language: 1033,
    }),
    'portal/websitelanguage.yml': list(
      languages.map(({ code, lcid }) => ({ adx_websitelanguageid: id(code), adx_languagecode: code, adx_lcid: lcid })),
    ),
    // The recorded site read the row back through Dataverse; the replay reads it through the portal Web API, which the
    // recorded site also enabled for the table (Webapi/<table>/enabled and fields).
    'portal/sitesetting.yml': list([
      ...(language.codeInUrl
        ? [
            {
              adx_sitesettingid: 'language-in-url',
              adx_name: 'MultiLanguage/DisplayLanguageCodeInURL',
              adx_value: 'true',
            },
          ]
        : []),
      { adx_sitesettingid: 'webapi-enabled', adx_name: `Webapi/${entity}/enabled`, adx_value: 'true' },
      {
        adx_sitesettingid: 'webapi-fields',
        adx_name: `Webapi/${entity}/fields`,
        adx_value: columns.map((item) => item.column).join(','),
      },
    ]),
    'portal/Home.webpage.yml': yaml({
      adx_webpageid: 'home',
      adx_name: 'Home',
      adx_partialurl: '/',
      adx_isroot: true,
      adx_pagetemplateid: 'home',
    }),
    'portal/Edit.webpage.yml': yaml({
      adx_webpageid: 'edit',
      adx_name: 'Edit',
      adx_partialurl: 'edit',
      adx_parentpageid: 'home',
      adx_isroot: true,
      adx_pagetemplateid: 'main',
    }),
    ...Object.fromEntries(
      languages.flatMap(({ code }) => [
        [
          `portal/Home-${code}.webpage.yml`,
          yaml({
            adx_webpageid: `home-${code}`,
            adx_name: 'Home',
            adx_partialurl: '/',
            adx_rootwebpageid: 'home',
            adx_webpagelanguageid: id(code),
            adx_isroot: false,
            adx_pagetemplateid: 'home',
          }),
        ],
        [
          `portal/Edit-${code}.webpage.yml`,
          yaml({
            adx_webpageid: `edit-${code}`,
            adx_name: 'Edit',
            adx_partialurl: 'edit',
            adx_parentpageid: `home-${code}`,
            adx_rootwebpageid: 'edit',
            adx_webpagelanguageid: id(code),
            adx_isroot: false,
            adx_pagetemplateid: 'main',
          }),
        ],
      ]),
    ),
    'portal/Main.pagetemplate.yml':
      'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: true',
    'portal/Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
    'portal/Main.webtemplate.source.html': `{% entityform name:${JSON.stringify(basicForm.adx_name)} %}`,
    'portal/Blank.pagetemplate.yml':
      'adx_pagetemplateid: home\nadx_webtemplateid: blank\nadx_usewebsiteheaderandfooter: true',
    'portal/Blank.webtemplate.yml': 'adx_webtemplateid: blank\nadx_name: Blank',
    'portal/Blank.webtemplate.source.html': '<p>Home</p>',
    'portal/Form.basicform.yml': yaml({ adx_entityformid: FORM, ...basicForm }),
    'solution/Other/Solution.xml':
      '<ImportExportXml><SolutionManifest><UniqueName>InventedSave</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
    [`solution/Entities/${entity}/Entity.xml`]: `<Entity><Name>${entity}</Name><EntityInfo><entity Name="${entity}"><attributes>${columns.map((item) => item.attribute).join('')}</attributes></entity></EntityInfo></Entity>`,
    [`solution/Entities/${entity}/FormXml/main/form.xml`]: `<forms><systemform><formid>{a0000000-0000-4000-8000-000000000002}</formid><FormActivationState>1</FormActivationState><form><tabs><tab name="general"><columns><column><sections><section name="main"><rows>${columns.map((item) => `<row>${item.cell}</row>`).join('')}</rows></section></sections></column></columns></tab></tabs><controlDescriptions>${columns.map((item) => item.controlDescription ?? '').join('')}</controlDescriptions></form><LocalizedNames><LocalizedName description="${basicForm.adx_formname}" languagecode="1033"/></LocalizedNames></systemform></forms>`,
  };
  const metadata = columns.filter((item) => item.metadata);
  if (metadata.length)
    files['portal/Form.basicform.basicformmetadata.yml'] = list(
      metadata.map((item, index) => ({
        adx_entityformmetadataid: `metadata-${index}`,
        adx_entityform: FORM,
        ...item.metadata,
      })),
    );
  for (const { control } of columns) {
    if (!control) continue;
    const dir = `solution/Controls/${control.name}`;
    files[`${dir}/ControlManifest.xml`] = control.manifest;
    files[`${dir}/ControlManifest.xml.data.xml`] = `<CustomControl><Name>${control.name}</Name></CustomControl>`;
    for (const [relative, text] of Object.entries(control.files ?? {})) files[`${dir}/${relative}`] = text;
  }
  return files;
}

const attribute = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;
const unescape = (text) =>
  text
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

/** The input element of a column in the served page. */
function columnInput(html, column) {
  const tag = new RegExp(`<input\\b[^>]*\\bid="${column}"[^>]*>`).exec(html)?.[0];
  assert.ok(tag, `the served form has an input for ${column}`);
  return tag;
}

/** The fields a browser posts for the served form: every named input, the recorded texts and the Update button. */
function postbackFields(html, posted) {
  const form = html.slice(html.indexOf('<form'), html.lastIndexOf('</form>'));
  const fields = new URLSearchParams();
  const names = Object.fromEntries(
    Object.keys(posted).map((column) => [column, attribute(columnInput(html, column), 'name')]),
  );
  const button =
    /<input\b[^>]*\btype="submit"[^>]*\bid="UpdateButton"[^>]*>|<input\b[^>]*\bid="UpdateButton"[^>]*>/.exec(form)?.[0];
  assert.ok(button, 'the served form has an Update button');
  for (const [tag] of form.matchAll(/<input\b[^>]*>/g)) {
    const name = attribute(tag, 'name');
    const type = (attribute(tag, 'type') ?? 'text').toLowerCase();
    if (!name || ['submit', 'button', 'image', 'file', 'reset'].includes(type)) continue;
    if (['checkbox', 'radio'].includes(type) && !/\schecked\b/.test(tag)) continue;
    if (Object.values(names).includes(name)) continue;
    fields.append(name, unescape(attribute(tag, 'value') ?? ''));
  }
  for (const [column, text] of Object.entries(posted)) fields.append(names[column], text);
  fields.append(attribute(button, 'name'), unescape(attribute(button, 'value') ?? ''));
  return fields;
}

/**
 * Serves the recorded form for its row from a fresh simulator; reads its number boxes, or posts the recorded texts and
 * reads the row back.
 * @param {object} input recorded input of one case (see fixtureFiles)
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ served: object } | { stored: object }>} the served boxes, or the stored values
 */
export default async function run(input, _context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-form-save-'));
  let app;
  try {
    for (const [name, content] of Object.entries(fixtureFiles(input))) {
      const file = path.join(root, name);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, content);
    }
    const { entity } = input;
    app = await createSimulator({
      sourceDir: path.join(root, 'portal'),
      solutionRoots: [path.join(root, 'solution')],
      pcf: { platformLibraries: await platformLibraryFiles(root) },
      port: 0,
      watch: false,
      initial: {
        version: 1,
        mappings: {
          [entity]: { entitySet: `${entity}s`, idColumn: `${entity}id` },
          contact: { entitySet: 'contacts', idColumn: 'contactid', nameColumn: 'fullname' },
        },
        tables: {
          [entity]: [{ [`${entity}id`]: ROW, ...structuredClone(input.row) }],
          contact: [{ contactid: CONTACT, fullname: 'Invented form editor' }],
        },
        permissions: [],
        settings: { permissionMode: 'permissive' },
        simulator: { mode: 'local', pageMode: 'local', endpoints: [], live: { origin: null }, componentSchemas: {} },
      },
    });
    const { cookie } = signInHeaders(app, CONTACT, { roles: [] });
    const route = `${input.language.codeInUrl ? `/${input.language.code}` : ''}/edit/?${input.basicForm.adx_recordidquerystringparametername}=${ROW}`;
    const jar = new Map(
      cookie.split('; ').map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
    );
    const request = async (init = {}) => {
      const response = await fetch(app.url + route, {
        redirect: 'manual',
        ...init,
        headers: { ...init.headers, cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') },
      });
      for (const line of response.headers.getSetCookie()) {
        const [pair] = line.split(';');
        jar.set(pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1));
      }
      return response;
    };
    const page = await request();
    assert.equal(page.status, 200, 'the recorded form page must be served');
    const html = await page.text();
    // The recorder's selector for submit controls (input or button of type submit, #UpdateButton, #InsertButton);
    // the ids of those that have one.
    if (input.observe === 'submitControls')
      return {
        submitControls: [
          ...html.matchAll(
            /<(?:input|button)\b(?=[^>]*\btype="submit"|[^>]*\bid="(?:UpdateButton|InsertButton)")[^>]*>/gi,
          ),
        ]
          .map(([tag]) => attribute(tag, 'id'))
          .filter(Boolean),
      };
    if (input.posted === null)
      return {
        served: Object.fromEntries(
          input.columns.map(({ column }) => {
            const tag = columnInput(html, column);
            return [
              column,
              {
                value: unescape(attribute(tag, 'value') ?? ''),
                decimalSeparator: attribute(tag, 'data-numberdecimalseparator'),
              },
            ];
          }),
        ),
      };
    const fields = postbackFields(html, input.posted);
    if (!fields.has('__RequestVerificationToken')) {
      const token = /value="([^"]+)"/.exec(
        await (
          await fetch(app.url + '/_layout/tokenhtml', {
            headers: { cookie: [...jar].map(([n, v]) => `${n}=${v}`).join('; ') },
          })
        ).text(),
      )?.[1];
      fields.append('__RequestVerificationToken', token);
    }
    const posted = await request({
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: fields,
    });
    assert.ok(posted.status < 500, `the postback is answered (HTTP ${posted.status})`);
    await posted.text();
    const select = input.columns.map((column) => column.column).join(',');
    const read = await fetch(`${app.url}/_api/${entity}s(${ROW})?$select=${select}`, {
      headers: { cookie: [...jar].map(([name, value]) => `${name}=${value}`).join('; ') },
    });
    assert.equal(read.status, 200, 'the row is read back through the portal Web API');
    const row = await read.json();
    return { stored: Object.fromEntries(input.columns.map(({ column }) => [column, row[column] ?? null])) };
  } finally {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
