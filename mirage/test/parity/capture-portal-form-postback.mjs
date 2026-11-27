/**
 * Convert one side of a recorded baseline basic-form run (scripts/baseline-matrix.mjs scenarios captured by
 * mirage/baseline-capture.mjs: <scenario>/<side>/requests.json and meta.json) to the raw input of
 * scripts/parity-cases.mjs build for the portal-form-postback surface.
 * Usage: node mirage/test/parity/capture-portal-form-postback.mjs SCENARIOS_DIR MATRIX_JSON SIDE OUT [SCENARIO ...]
 * SCENARIOS_DIR holds <component>/<variation>/<state>/<persona>; MATRIX_JSON is the scenario matrix the run used (its
 * `goto` step names the page and the fixture record keys that the recorded addresses redact). Each named scenario
 * becomes one case; the default list is every basic-form scenario this surface replays.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isEntryPoint } from '../../../lense/entry-point.mjs';
import { ids } from '../../../examples/project/baseline/data.mjs';
import { projectAttachments, projectPostback } from './adapters/portal-form-postback.mjs';

// The basic-form postbacks recorded twice (live and live-2). basic-form/item-edit-associated is left out: its record
// source resolves through the recorded contact's own relationships, which the invented fixture contact does not hold.
// The basic-form postbacks with a file attachment, recorded twice: a suite of their own.
export const ATTACHMENT_SCENARIOS = [
  'basic-form/item-create-attach/insert/editor',
  'basic-form/item-create-attach-multiple/insert/editor',
];

export const SCENARIOS = [
  'basic-form/item-create/insert/editor',
  'basic-form/item-create/plugin-error-create-postoperation/editor',
  'basic-form/item-create/plugin-error-create-preoperation/editor',
  'basic-form/item-create/plugin-error-create-prevalidation/editor',
  'basic-form/item-create/rule-error/editor',
  'basic-form/item-create-captcha/insert/editor',
  'basic-form/item-create-captcha-all/insert-captcha/editor',
  'basic-form/item-create-redirect/insert/editor',
  'basic-form/item-create-redirect-url/insert/editor',
  'basic-form/item-create-success/insert/editor',
  'basic-form/item-edit/plugin-error-update-postoperation/editor',
  'basic-form/item-edit/plugin-error-update-preoperation/editor',
  'basic-form/item-edit/plugin-error-update-prevalidation/editor',
  'basic-form/item-edit/plugin-mutation/editor',
  'basic-form/item-edit/plugin-mutation-postback/editor',
  'basic-form/item-edit/range-error/editor',
  'basic-form/item-edit/save-text/editor',
  'basic-form/item-edit-nolinks/save-text/editor',
];

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const fixtureKey = new Map(Object.entries(ids).map(([key, id]) => [id.toLowerCase(), key]));

/** The fields of a urlencoded or multipart form body, in order. */
function formFields(body, contentType = '') {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!boundary) return [...new URLSearchParams(body)];
  const fields = [];
  for (const part of body.split('--' + (boundary[1] ?? boundary[2]).trim())) {
    const split = part.indexOf('\r\n\r\n');
    if (split < 0) continue;
    const name = /name="([^"]*)"/.exec(part.slice(0, split))?.[1];
    if (name === undefined || /filename=/.test(part.slice(0, split))) continue;
    fields.push([name, part.slice(split + 4).replace(/\r\n$/, '')]);
  }
  return fields;
}

/**
 * The recorded texts of the columns the scenario filled in (its `fill` steps), as the form posted them. Every other
 * control keeps the value the replayed page serves, as it kept the value the recorded page served.
 */
function recordedColumns(fields, steps) {
  const filled = steps.map((step) => /^#([a-z][a-z0-9]*_[a-z0-9_]+)$/.exec(step.fill ?? '')?.[1]).filter(Boolean);
  const columns = {};
  for (const column of filled) {
    const posted = fields.filter(([name]) => name.split('$').at(-1) === column);
    assert.equal(posted.length, 1, `the postback carries ${column} once`);
    const value = posted[0][1];
    // A record id is named by its fixture key; an id no fixture names cannot be replayed.
    if (GUID.test(value)) {
      const key = fixtureKey.get(value.toLowerCase());
      assert.ok(key, `${column} names a record outside the fixture`);
      columns[column] = { fixture: key };
    } else columns[column] = value;
  }
  return columns;
}

/**
 * The files the attach-file control uploaded, in order: each InitializeFileUpload request names the type of the file
 * it starts, and the scenario's upload step holds the bytes (the recorded request bodies are text, not the bytes).
 */
function uploadedFiles(rows, upload, id, side) {
  const started = rows.filter(
    (row) => row.method === 'POST' && row.url.toLowerCase().startsWith('/_api/file/initializefileupload/'),
  );
  assert.ok(started.length, `${id} ${side} uploads no file`);
  return started.map((row) => {
    assert.equal(row.response?.status, 200, `${id} ${side}: the upload started`);
    const type = row.headers?.['content-type'];
    const matching = upload.files.filter((file) => file.mimeType === type);
    assert.equal(matching.length, 1, `${id} ${side}: one step file has the uploaded type ${type}`);
    const blocks = rows.filter(
      (block) => block.method === 'PUT' && block.url.toLowerCase().startsWith('/_api/file/uploadfileblock/'),
    );
    assert.ok(blocks.some((block) => block.response?.status === 204 && block.headers?.['content-type'] === type));
    const [file] = matching;
    return { name: file.name, mimeType: file.mimeType, base64: file.base64 };
  });
}

/** The attachments the redirected edit page listed for the new record (its entity-notes answer). */
function listedAttachments(rows, id, side) {
  const notes = rows.filter(
    (row) => row.method === 'POST' && row.url.toLowerCase().startsWith('/_services/entity-notes/'),
  );
  assert.equal(notes.length, 1, `${id} ${side} lists the notes once`);
  assert.equal(notes[0].response?.status, 200);
  return projectAttachments(JSON.parse(notes[0].response.body));
}

function pageOf(goto) {
  const url = new URL(
    goto.replace(/\{id:([^}]+)\}/g, (_, key) => `__fixture_${key}__`),
    'https://site.invalid',
  );
  const query = {};
  for (const [key, value] of url.searchParams) {
    const fixture = /^__fixture_(.+)__$/.exec(value)?.[1];
    query[key] = fixture ? { fixture } : value;
  }
  return { page: url.pathname, query };
}

export function preparePortalFormPostbackCapture(scenariosDir, matrixFile, side, scenarios = SCENARIOS) {
  const matrix = JSON.parse(fs.readFileSync(matrixFile, 'utf8'));
  const byId = new Map((matrix.scenarios ?? []).map((row) => [row.id, row]));
  const hash = createHash('sha256');
  const dates = [];
  const results = scenarios.map((id) => {
    const scenario = byId.get(id);
    assert.ok(scenario, `the matrix has no scenario ${id}`);
    const goto = scenario.steps.find((step) => step.goto)?.goto;
    assert.ok(goto, `${id} opens no page`);
    const folder = path.join(scenariosDir, ...id.split('/'), side);
    const raw = fs.readFileSync(path.join(folder, 'requests.json'));
    hash.update(id).update('\0').update(raw);
    const meta = JSON.parse(fs.readFileSync(path.join(folder, 'meta.json'), 'utf8'));
    assert.equal(meta.status, 'captured', `${id} ${side} was not captured`);
    dates.push(meta.capturedAt.slice(0, 10));
    const rows = JSON.parse(raw.toString('utf8'));
    const posts = rows.filter((row) => row.method === 'POST' && row.resourceType === 'document');
    assert.equal(posts.length, 1, `${id} ${side} has one form postback`);
    const [post] = posts;
    const fields = formFields(post.body ?? '', post.headers?.['content-type']);
    const target = fields.find(([name]) => name === '__EVENTTARGET')?.[1] ?? '';
    const action =
      target.split('$').at(-1) || fields.map(([name]) => name.split('$').at(-1)).find((n) => /Button$/.test(n));
    assert.ok(action, `${id} ${side}: the postback names no button`);
    const response = post.response;
    const output = projectPostback({
      status: response.status,
      location: response.headers?.location ?? null,
      html: response.status === 200 ? (response.body ?? '') : '',
    });
    const input = { ...pageOf(goto), fields: recordedColumns(fields, scenario.steps), action };
    const upload = scenario.steps.find((step) => step.upload);
    if (!upload) return { id, input, output };
    return {
      id,
      input: { ...input, files: uploadedFiles(rows, upload, id, side) },
      output: { ...output, attachments: listedAttachments(rows, id, side) },
    };
  });
  return {
    capture: { id: `baseline-${side}`, capturedAt: dates.sort().at(-1), sha256: hash.digest('hex') },
    results,
  };
}

if (isEntryPoint(import.meta.url)) {
  const [scenariosDir, matrixFile, side, out, ...scenarios] = process.argv.slice(2);
  if (!scenariosDir || !matrixFile || !side || !out)
    throw new Error(
      'Usage: node mirage/test/parity/capture-portal-form-postback.mjs SCENARIOS_DIR MATRIX_JSON SIDE OUT [SCENARIO ...]',
    );
  const capture = preparePortalFormPostbackCapture(
    scenariosDir,
    matrixFile,
    side,
    scenarios.length ? scenarios : SCENARIOS,
  );
  fs.writeFileSync(out, JSON.stringify(capture, null, 2) + '\n');
}
