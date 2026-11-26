// Adapter for the portal-form-postback surface: a basic form of the toolkit's invented baseline fixture
// (examples/project/baseline, laid over the demo portal examples/project/portal that the fixture site extends), the
// recorded column texts, the uploaded files and the form button -> a Mirage simulator signed in as the fixture's tester
// serves the page, the files go through the attach-file upload API, and the served form is posted back with the
// recorded texts in place of its column inputs -> what the response says.
// Only `input` drives Mirage. The page is read and posted over HTTP (no browser), as the native form posts back: every
// named input of the served form, the recorded texts for the recorded columns, the uploaded annotation ids, and the
// recorded button as the postback target, multipart (with empty file inputs) when the form declares it. Which of a
// scenario's offered files the control accepted is the recorded input, not replayed. A fixture record is named by its
// key in examples/project/baseline/data.mjs (`ids`), never by a live id.
// Projection (projectPostback and projectAttachments, shared with capture-portal-form-postback.mjs): the HTTP status, a
// redirect's target (site path or external origin and path, query values with record ids replaced), the form's message
// panel (kind and text), the validation summary entries and, with files, the attachments the created record lists.
import os from 'node:os';
import path from 'node:path';
import { parse } from 'parse5';
import { createSimulator } from '../../../server.mjs';
import { signInHeaders } from '../../../testing/session.mjs';
import { makeTemporaryDirectory, removeFixtureDirectory } from '../../../testing/owned-fixture.mjs';
import { ids, ITEM, TESTER_CONTACT } from '../../../../examples/project/baseline/data.mjs';
import { baselineFixtureOptions, writeBaselineFixtureSite } from '../baseline-fixture-site.mjs';

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const attribute = (node, name) => node.attrs?.find((item) => item.name === name)?.value ?? null;
function* elements(node) {
  for (const child of node.childNodes ?? []) {
    if (child.tagName) yield child;
    yield* elements(child.tagName === 'template' ? child.content : child);
  }
}
const textOf = (node) =>
  node.nodeName === '#text'
    ? node.value
    : (node.childNodes ?? [])
        .filter((child) => child.tagName !== 'script' && child.tagName !== 'style')
        .map(textOf)
        .join('');
const clean = (text) => text.replace(/\s+/g, ' ').trim();

/** The projected outcome of one form postback response. */
export function projectPostback({ status, location = null, html = '' }) {
  let redirect = null;
  if (location) {
    const url = new URL(location, 'https://site.invalid');
    const query = {};
    for (const [key, value] of url.searchParams) query[key] = GUID.test(value) ? '<record id>' : value;
    redirect = {
      site: url.origin === 'https://site.invalid',
      ...(url.origin === 'https://site.invalid' ? {} : { origin: url.origin }),
      path: url.pathname,
      query,
    };
  }
  let message = null;
  const validation = [];
  if (html) {
    const document = parse(html);
    for (const node of elements(document)) {
      const id = attribute(node, 'id') ?? '';
      if (id === 'MessagePanel' && !message) {
        const classes = (attribute(node, 'class') ?? '').split(/\s+/);
        let kind = 'info';
        if (classes.includes('alert-danger')) kind = 'danger';
        else if (classes.includes('alert-success')) kind = 'success';
        message = { kind, text: clean(textOf(node)) };
      } else if (id.startsWith('ValidationSummary'))
        for (const item of elements(node)) if (item.tagName === 'li') validation.push(clean(textOf(item)));
    }
  }
  return { status, redirect, message, validation };
}

/** Every named control of the served form, as the browser would submit it (no submit buttons). */
function servedFields(html) {
  const document = parse(html);
  const form = [...elements(document)].find((node) => node.tagName === 'form' && attribute(node, 'method') === 'post');
  if (!form) throw new Error('The served page has no postback form.');
  const fields = [];
  const files = [];
  const buttons = [];
  for (const node of elements(form)) {
    const name = attribute(node, 'name');
    if (!name || attribute(node, 'disabled') !== null) continue;
    if (node.tagName === 'button') buttons.push(name);
    else if (node.tagName === 'input') {
      const type = (attribute(node, 'type') ?? 'text').toLowerCase();
      if (['submit', 'button', 'image'].includes(type)) buttons.push(name);
      if (type === 'file') files.push(name);
      if (['submit', 'button', 'image', 'reset', 'file'].includes(type)) continue;
      if (['checkbox', 'radio'].includes(type) && attribute(node, 'checked') === null) continue;
      fields.push([name, attribute(node, 'value') ?? (type === 'checkbox' || type === 'radio' ? 'on' : '')]);
    } else if (node.tagName === 'select') {
      const options = [...elements(node)].filter((option) => option.tagName === 'option');
      const chosen = options.find((option) => attribute(option, 'selected') !== null) ?? options[0];
      if (chosen) fields.push([name, attribute(chosen, 'value') ?? clean(textOf(chosen))]);
    } else if (node.tagName === 'textarea') fields.push([name, textOf(node).replace(/^\n/, '')]);
  }
  return {
    action: attribute(form, 'action'),
    multipart: /^multipart\/form-data/i.test(attribute(form, 'enctype') ?? ''),
    fields,
    files,
    buttons,
  };
}

const fixtureValue = (value) => (value && typeof value === 'object' ? ids[value.fixture] : value);

/** A browser's cookies for the simulator: every request sends them, every answer's Set-Cookie updates them. */
function cookieJar(initial) {
  const cookies = new Map(
    initial
      .split(/;\s*/)
      .filter(Boolean)
      .map((pair) => [pair.slice(0, pair.indexOf('=')), pair.slice(pair.indexOf('=') + 1)]),
  );
  return async (url, { headers = {}, ...init } = {}) => {
    const cookie = [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
    const response = await fetch(url, { ...init, headers: { ...headers, cookie } });
    for (const line of response.headers.getSetCookie()) {
      const pair = line.split(';')[0];
      cookies.set(pair.slice(0, pair.indexOf('=')).trim(), pair.slice(pair.indexOf('=') + 1));
    }
    return response;
  };
}

/** Each file as the attach-file control uploads it (mirage/lib/fileuploadcontrol-compat.js): its annotation ids. */
async function uploadFiles(app, send, form, files) {
  const hidden = (suffix) => form.fields.find(([name]) => name.endsWith('AttachFile' + suffix))?.[1] ?? '';
  const common = { formId: hidden('_HiddenField_FormID'), formType: hidden('_HiddenField_FormType') };
  const annotationIds = [];
  for (const file of files) {
    const bytes = Buffer.from(file.base64, 'base64');
    const headers = {
      __RequestVerificationToken: app.portalToken,
      'content-type': file.mimeType,
      'x-ms-file-name': file.name,
      'x-ms-file-type': file.mimeType,
      'x-ms-form-session-id': hidden('_HiddenField_InstanceId'),
      'x-requested-with': 'XMLHttpRequest',
    };
    const started = await send(
      new URL(
        '/_api/file/InitializeFileUpload/note?' +
          new URLSearchParams({ ...common, regardingId: hidden('_HiddenField_RegardingId') }),
        app.url,
      ),
      { method: 'POST', headers: { ...headers, 'x-ms-file-size': String(bytes.length) } },
    );
    if (started.status !== 200) throw new Error(`InitializeFileUpload answered HTTP ${started.status}.`);
    const { AnnotationId, FileContinuationToken } = await started.json();
    const query = { chunkSize: String(bytes.length), fileSize: String(bytes.length), ...common, noteId: AnnotationId };
    const block = await send(
      new URL('/_api/file/UploadFileBlock/note?' + new URLSearchParams({ ...query, offset: '0' }), app.url),
      { method: 'PUT', headers: { ...headers, 'x-ms-file-continuation-token': FileContinuationToken }, body: bytes },
    );
    if (block.status !== 204) throw new Error(`UploadFileBlock answered HTTP ${block.status}.`);
    annotationIds.push(AnnotationId);
  }
  return annotationIds;
}

/** The notes of the record a create redirected to, as the edit page lists them (native entity-notes service). */
async function recordAttachments(app, send, location) {
  // The redirect target is the created record's edit page: its notes control names the notes service address.
  const page = await send(new URL(location, app.url));
  if (page.status !== 200) throw new Error(`The redirected page answered HTTP ${page.status}.`);
  const notes = [...elements(parse(await page.text()))].find(
    (node) => (attribute(node, 'class') ?? '').split(/\s+/).includes('entity-notes') && attribute(node, 'data-url-get'),
  );
  if (!notes) throw new Error('The redirected page has no notes control.');
  const address = new URL(attribute(notes, 'data-url-get'), app.url);
  if (address.origin !== new URL(app.url).origin || !address.pathname.startsWith('/_services/entity-notes/'))
    throw new Error('The notes control names another service.');
  const response = await send(address, {
    method: 'POST',
    headers: { __RequestVerificationToken: app.portalToken, 'content-type': 'application/json' },
    body: JSON.stringify({
      regarding: { Id: new URL(location, app.url).searchParams.get('id'), LogicalName: ITEM },
      orders: [{ Attribute: 'createdon', Alias: null, Direction: 1 }],
      page: 1,
      pageSize: 6,
    }),
  });
  if (response.status !== 200) throw new Error(`entity-notes answered HTTP ${response.status}.`);
  return projectAttachments(await response.json());
}

/** A notes answer's attachments: file name, content type, image flag and the displayed size. */
export function projectAttachments(notes) {
  return (notes?.Records ?? [])
    .filter((record) => record.HasAttachment)
    .map((record) => ({
      fileName: record.AttachmentFileName,
      contentType: record.AttachmentContentType,
      isImage: record.AttachmentIsImage,
      sizeDisplay: record.AttachmentSizeDisplay,
    }));
}

export default async function run({ page, query = {}, fields, action, files = null }) {
  const sourceDir = await makeTemporaryDirectory(path.join(os.tmpdir(), 'mirage-replay-form-postback-'));
  let app;
  try {
    await writeBaselineFixtureSite(sourceDir);
    app = await createSimulator(baselineFixtureOptions(sourceDir));
    const send = cookieJar(signInHeaders(app, TESTER_CONTACT, { roles: ['Baseline Editors'] }).cookie);
    const address = new URL(page, app.url);
    for (const [key, value] of Object.entries(query)) address.searchParams.set(key, fixtureValue(value));
    const served = await send(address);
    if (served.status !== 200) throw new Error(`The form page answered HTTP ${served.status}.`);
    const form = servedFields(await served.text());
    const recorded = new Map(Object.entries(fields));
    // The attach-file control uploads each file when it is chosen; the postback carries their annotation ids.
    const annotationIds = files ? await uploadFiles(app, send, form, files) : null;
    // The recorded button is the postback target, as WebForm_DoPostBackWithOptions sets it.
    const target = form.buttons.find((name) => name.split('$').at(-1) === action);
    if (!target) throw new Error(`The served form has no ${action}.`);
    // As the browser submits the form: multipart, with each file input empty, when the form declares it.
    const body = form.multipart ? new FormData() : new URLSearchParams();
    for (const [name, value] of form.fields) {
      const column = name.split('$').at(-1);
      let posted = recorded.has(column) ? fixtureValue(recorded.get(column)) : value;
      if (name === '__EVENTTARGET') posted = target;
      else if (annotationIds && name.endsWith('AttachFile_HiddenField_AnnotationIds'))
        posted = JSON.stringify(annotationIds);
      body.append(name, posted);
    }
    if (!form.fields.some(([name]) => name === '__EVENTTARGET')) body.append('__EVENTTARGET', target);
    if (form.multipart)
      for (const name of form.files) body.append(name, new Blob([], { type: 'application/octet-stream' }), '');
    const response = await send(new URL(form.action ?? address.href, address), {
      method: 'POST',
      redirect: 'manual',
      // fetch writes the multipart boundary itself.
      headers: form.multipart ? {} : { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    const location = response.headers.get('location');
    const outcome = projectPostback({
      status: response.status,
      location,
      html: response.status === 200 ? await response.text() : '',
    });
    if (!files) return outcome;
    return { ...outcome, attachments: location ? await recordAttachments(app, send, location) : [] };
  } finally {
    await app?.close();
    await removeFixtureDirectory(sourceDir);
  }
}
