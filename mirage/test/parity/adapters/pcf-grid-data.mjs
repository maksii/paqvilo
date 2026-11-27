// Adapter for the pcf-grid-data surface: one recorded grid data request of a dataset code component on a list or on a
// form subgrid -> a Mirage simulator holding the recorded sources and rows -> the status and body of the same request.
// Only `input` drives Mirage: `solution` and `portal` are the exported Solution files (tables, views, relationships,
// the main form's subgrid cells, the control) and portal source files (pages, list, basic form and its metadata, web
// role, table permissions) by path; `rows` and `links` are the seeded records and N:N links; `page` is the page that
// hosts the control, `host` names the hosting list or subgrid, and `request` is the recorded request without the
// platform's encrypted configuration.
// Mirage bootstraps its state from the sources; the rows are written with Mirage's own create and associate, as the
// recorder seeded them through the Dataverse Web API. The page is read over HTTP (no browser) as a signed-in contact of
// the recorded web role, and the request is posted with Mirage's signed grid configuration of the named host.
// Projection (the one reviewed conversion): an AccessDenied body is compared whole; a body with rows as its
// MoreRecords flag and the ids of its records in order (the recording keeps the ids of the data set the response
// loaded, as its bodies are cut after the first record).
// The platform libraries (React, ReactDOM, Fluent UI) are provided by the Power Pages host; Mirage needs them as project
// files (pcf.platformLibraries), written as empty stand-ins of the live set (pcf-form-admission.mjs platformLibraryFiles).
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';
import { platformLibraryFiles } from './pcf-form-admission.mjs';

// Invented identity: the recorded input names the contact only through its rows.
const VISITOR = '70000000-0000-4000-8000-0000000000e1';

async function writeFiles(root, files) {
  for (const [name, content] of Object.entries(files)) {
    const file = path.join(root, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, content);
  }
}

/** The mount specifications of the code components on a page (Mirage's host payloads), in page order. */
function mounts(html) {
  const marker = '__paqviloPcf.mount(';
  const found = [];
  for (let at = html.indexOf(marker); at >= 0; at = html.indexOf(marker, at + 1)) {
    const from = at + marker.length;
    found.push(JSON.parse(html.slice(from, html.indexOf(', document.currentScript', from))));
  }
  return found;
}

/**
 * The data set binding of the named host: the list's, or the named subgrid's. Subgrid hosts are rendered in the order
 * of their FormXml cells, so the subgrid is found by the position of its control among the subgrid controls of the
 * one recorded form that holds it (a recorded Solution may carry the forms of several pages).
 */
function bindingOf(html, host, solution) {
  const datasets = mounts(html).flatMap((mount) => mount.datasets ?? []);
  if (!host.subgrid) {
    const lists = datasets.filter((dataset) => /entity-grid-data\.json/.test(dataset.service ?? ''));
    assert.equal(lists.length, 1, 'one list data set is bound');
    return lists[0];
  }
  const subgridsOf = (xml) =>
    [...xml.matchAll(/<control id="([^"]+)"[^>]*\bindicationOfSubgrid="true"/g)].map((m) => m[1]);
  const forms = Object.entries(solution).filter(
    ([name, xml]) => /\/FormXml\//.test(name) && subgridsOf(xml).includes(host.subgrid),
  );
  assert.equal(forms.length, 1, 'one recorded form holds the named subgrid');
  const order = subgridsOf(forms[0][1]);
  const subgrids = datasets.filter((dataset) => /entity-subgrid-data\.json/.test(dataset.service ?? ''));
  assert.equal(subgrids.length, order.length, 'every subgrid cell of the form is bound');
  return subgrids[order.indexOf(host.subgrid)];
}

/**
 * Serves the recorded page from a fresh simulator and posts the recorded grid data request for the named host.
 * @param {object} input recorded input of one case (see the header)
 * @param {{ surface: string, suite: string }} _context frozen names of the case file; this adapter needs none
 * @returns {Promise<{ status: number, body: object }>} the answer, projected as described in the header
 */
export default async function run(input, _context) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pcf-grid-data-'));
  let app;
  try {
    await writeFiles(path.join(root, 'portal'), input.portal);
    await writeFiles(path.join(root, 'solution'), input.solution);
    app = await createSimulator({
      sourceDir: path.join(root, 'portal'),
      solutionRoots: [path.join(root, 'solution')],
      pcf: { platformLibraries: await platformLibraryFiles(root) },
      port: 0,
      watch: false,
    });
    const admin = { admin: true };
    for (const { entity, id, data } of input.rows) {
      const { idColumn } = app.store.resolveMapping(entity);
      await app.store.create(entity, { [idColumn]: id, ...structuredClone(data) }, admin);
    }
    for (const { entity, id, navigation, targetId } of input.links)
      await app.store.associate(entity, id, navigation, targetId, admin);
    const role = /adx_name: (.+)/.exec(input.portal['webrole.yml'])?.[1]?.trim();
    const { cookie } = signInHeaders(app, VISITOR, { roles: [role] });
    const page = await fetch(app.url + input.page, { headers: { cookie } });
    assert.equal(page.status, 200, 'the hosting page must be served');
    const binding = bindingOf(await page.text(), input.host, input.solution);
    assert.ok(binding?.secure && binding?.service, 'the bound data set names its grid service and configuration');
    const response = await fetch(app.url + binding.service, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', __RequestVerificationToken: app.portalToken },
      body: JSON.stringify({ base64SecureConfiguration: binding.secure, ...input.request }),
    });
    const body = JSON.parse(await response.text());
    return {
      status: response.status,
      body: body.AccessDenied
        ? body
        : { MoreRecords: body.MoreRecords, recordIds: (body.Records ?? []).map((record) => record.Id) },
    };
  } finally {
    await app?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}
