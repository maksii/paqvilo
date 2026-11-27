// An invented portal under a nonce Content-Security-Policy (the documented 'nonce' placeholder): one page holds an
// authored inline script (which also records CSP violations), an authored inline handler, a content snippet script, the
// page's custom JavaScript, an authored script that interpolates a value, and a record whose name is script and handler
// markup printed without | escape. Shared by mirage/test/script-nonce.test.mjs and mirage/test-browser/script-nonce.test.mjs,
// with the render fragments (nonceFragmentOf) that both decide without a server.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';

export const NONCE_CASE = '77777777-7777-4777-8777-777777777760';
export const NONCE_WEBSITE = '77777777-7777-4777-8777-777777777761';
export const NONCE_MODAL_PATH = `/_portal/modal-form-template-path/${NONCE_WEBSITE}/?id=${NONCE_CASE}&entityformid=edit-case`;
export const NONCE_QUICK_VIEW_PATH = `/_portal/quickform-template-path/${NONCE_WEBSITE}?entityid=${NONCE_CASE}&entityname=x_case&controlid=casequick`;
export const NONCE_POLICY = "script-src 'self' 'nonce' 'report-sample'; style-src 'self' 'unsafe-inline' https:;";
const ENTITY =
  '<Entity><Name>x_case</Name><EntityInfo><entity Name="x_case"><EntitySetName>x_cases</EntitySetName><PrimaryIdAttribute>x_caseid</PrimaryIdAttribute><PrimaryNameAttribute>x_name</PrimaryNameAttribute><attributes><attribute PhysicalName="x_caseid"><Name>x_caseid</Name><Type>primarykey</Type></attribute><attribute PhysicalName="x_name"><Name>x_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>';

// The record's name: script and handler markup that the page prints without | escape.
const DATA_NAME =
  '<script>window.injected = \'ran\';</script><img id="data-image" src="/missing.png" onerror="window.dataHandler = \'ran\'">';

/**
 * `files` adds or replaces portal source files (an error snippet); `name` replaces the record's name; with
 * `headerAndFooter: false` the page template renders without the website header and footer (no head element of its
 * own); `interpolated` is the Liquid output the authored interpolating script embeds in a string literal.
 */
export function noncePortalFiles({
  policy = NONCE_POLICY,
  reportOnly = null,
  files = {},
  name = DATA_NAME,
  headerAndFooter = true,
  interpolated = '{{ c.x_caseid }}',
} = {}) {
  const settings = [
    ['HTTP/Content-Security-Policy', policy],
    ...(reportOnly ? [['HTTP/Content-Security-Policy-Report-Only', reportOnly]] : []),
  ];
  return {
    solution: {
      'Other/Solution.xml':
        '<ImportExportXml><SolutionManifest><UniqueName>InventedNonce</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
      'Entities/x_case/Entity.xml': ENTITY,
    },
    portal: {
      'website.yml': 'adx_websiteid: 77777777-7777-4777-8777-777777777761\nadx_name: Invented nonce',
      'Home.webpage.yml':
        'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: main',
      'Home.webpage.custom_javascript.js': "window.pageScript = 'ran';",
      'Main.pagetemplate.yml': `adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: ${headerAndFooter}`,
      'Main.webtemplate.yml': 'adx_webtemplateid: main\nadx_name: Main',
      'Main.webtemplate.source.html': [
        "<script>window.violations = [];document.addEventListener('securitypolicyviolation', function (event) { window.violations.push({ directive: event.violatedDirective, disposition: event.disposition, sample: event.sample }); });window.authored = 'ran';</script>",
        '<button id="authored-handler" type="button" onclick="window.clicked = \'ran\'">Authored handler</button>',
        "{{ snippets['Invented/Inline'] }}",
        `{% assign c = entities.x_case['${NONCE_CASE}'] %}<div id="data">{{ c.x_name }}</div>`,
        `<script>window.interpolated = "${interpolated}";</script>`,
      ].join('\n'),
      'Invented-Inline.contentsnippet.yml':
        'adx_contentsnippetid: snip\nadx_name: Invented/Inline\nadx_type: 756150001',
      'Invented-Inline.contentsnippet.value.html': "<script>window.snippet = 'ran';</script>",
      // Head/Bottom also heads the documents the runtime builds outside the page layout (modal form, quick view).
      'Head-Bottom.contentsnippet.yml': 'adx_contentsnippetid: head-bottom\nadx_name: Head/Bottom\nadx_type: 756150001',
      'Head-Bottom.contentsnippet.value.html': "<script>window.headBottom = 'ran';</script>",
      // The modal form document (/_portal/modal-form-template-path/<website>/?id=&entityformid=edit-case).
      'Edit.basicform.yml':
        'adx_entityformid: edit-case\nadx_name: Edit case\nadx_entityname: x_case\nadx_mode: 100000001\nadx_entitypermissionsenabled: true',
      'sitesetting.yml': settings
        .map(
          ([name, value], at) =>
            `- adx_sitesettingid: s${at}\n  adx_name: ${name}\n  adx_value: ${JSON.stringify(value)}`,
        )
        .join('\n'),
      'webrole.yml': '- adx_webroleid: anonymous\n  adx_name: Anonymous Users\n  adx_anonymoususersrole: true',
      ...files,
    },
    initial: {
      version: 1,
      mappings: { x_case: { entitySet: 'x_cases', idColumn: 'x_caseid', nameColumn: 'x_name' } },
      tables: {
        x_case: [
          {
            x_caseid: NONCE_CASE,
            x_name: name,
            statecode: 0,
          },
        ],
      },
      permissions: [
        { id: 'case', entity: 'x_case', scope: 'global', roles: ['Anonymous Users'], operations: ['read'] },
      ],
      settings: { permissionMode: 'enforce' },
      simulator: {
        mode: 'local',
        pageMode: 'local',
        permissionSource: 'configured',
        live: { allowWrites: false },
        endpoints: [],
        componentSchemas: {
          'edit-case': {
            entity: 'x_case',
            fields: [{ name: 'x_name', label: 'Name' }],
            // A quick view of the same case (/_portal/quickform-template-path/<website>/?...&controlid=casequick).
            layout: [
              {
                name: 'main',
                columns: [
                  {
                    sections: [
                      {
                        name: 'main',
                        rows: [
                          [{ type: 'field', name: 'x_name', label: 'Name' }],
                          [
                            {
                              type: 'quickform',
                              id: 'casequick',
                              entity: 'x_case',
                              lookup: 'x_caseid',
                              schema: { formName: 'Case quick view', fields: [{ name: 'x_name', label: 'Name' }] },
                            },
                          ],
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
      },
    },
  };
}

/** Starts Mirage on noncePortalFiles in a new temporary directory; returns { sim, close }. */
export async function startNoncePortal(options = {}) {
  const files = noncePortalFiles(options);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paqvilo-script-nonce-'));
  for (const dir of ['solution', 'portal'])
    for (const [relative, text] of Object.entries(files[dir])) {
      await fs.mkdir(path.dirname(path.join(root, dir, relative)), { recursive: true });
      await fs.writeFile(path.join(root, dir, relative), text);
    }
  let sim;
  try {
    sim = await createSimulator({
      sourceDir: path.join(root, 'portal'),
      solutionRoots: [path.join(root, 'solution')],
      stateFile: path.join(root, 'state.json'),
      port: 0,
      watch: false,
      initial: files.initial,
      // The site's observed settings (an error presentation), with their evidence.
      ...(options.observed ? { observed: options.observed } : {}),
    });
  } catch (error) {
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    throw error;
  }
  return {
    sim,
    close: async () => {
      await sim.close();
      await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    },
  };
}

/**
 * A render fragment of `parts`: a string is exported source text (one invented source, verified literal), { data } is
 * output a Liquid expression of that source wrote (derived), { platform, kind? } is markup a platform component wrote
 * (its start tags bound to it), { raw } is text no interval accounts for. Returns { fragment, index } for
 * applyScriptNonces (lib/render-provenance.mjs).
 */
export function nonceFragmentOf(parts) {
  let text = '',
    sourceText = '';
  const intervals = [];
  for (const part of parts) {
    const start = text.length;
    if (typeof part === 'string') {
      intervals.push({
        start,
        end: start + part.length,
        mapping: 'literal',
        sourceRefId: 'src',
        sourceSpan: { start: sourceText.length, end: sourceText.length + part.length },
      });
      sourceText += part;
      text += part;
    } else if (part.data !== undefined) {
      intervals.push({
        start,
        end: start + part.data.length,
        mapping: 'derived',
        sourceRefId: 'src',
        sourceSpan: null,
      });
      sourceText += '{{ value }}';
      text += part.data;
    } else if (part.platform !== undefined) {
      for (const match of part.platform.matchAll(/<[a-z][^>]*>/gi))
        intervals.push({
          start: start + match.index,
          end: start + match.index + match[0].length,
          mapping: 'platform',
          tag: /^<([a-z0-9]+)/i.exec(match[0])[1].toLowerCase(),
          component: {
            kind: part.kind ?? 'basic-form',
            key: `${part.kind ?? 'basic-form'}:invented`,
            name: 'Invented',
          },
          sourceRefIds: [],
        });
      text += part.platform;
    } else text += part.raw;
  }
  return {
    fragment: { text, intervals },
    index: { sources: new Map([['src', { id: 'src', text: sourceText }]]), sourceRevision: 'r1' },
  };
}
