// Portal Web API file and image columns: PATCH/PUT the bytes with x-ms-file-name, GET .../$value, DELETE,
// behind the Webapi site settings and the visitor's table permissions; the bytes go through the organization file seam.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../server.mjs';
import { signInHeaders } from '../testing/session.mjs';

const SITE = '77777777-7777-4777-8777-777777777771';
const ITEM = '77777777-7777-4777-8777-777777777772';
const OTHER = '77777777-7777-4777-8777-777777777773';
const CONTACT = '77777777-7777-4777-8777-777777777774';

async function simulator(t, { images = false, applicationUser } = {}) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'portal-file-columns-'));
  let app;
  // One owner hook: Node stops subsequent after hooks when an earlier one throws.
  // Drain the current runtime (including a restarted instance and its blob flush)
  // before touching its state directory. Preserve that directory if close fails.
  t.after(async () => {
    await app?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  const files = {
    'website.yml': `adx_websiteid: ${SITE}\nadx_name: Example`,
    'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
    'sitesetting.yml': [
      ['Webapi/x_item/enabled', 'true'],
      ['Webapi/x_item/fields', `x_name,x_doc${images ? ',x_image' : ''}`],
      ...(images
        ? [
            ['Webapi/contact/enabled', 'true'],
            ['Webapi/contact/fields', 'fullname,x_items'],
          ]
        : []),
    ]
      .map(
        ([name, value], index) =>
          `- adx_sitesettingid: 77777777-7777-4777-8777-77777777778${index}\n  adx_name: ${name}\n  adx_value: "${value}"`,
      )
      .join('\n'),
  };
  for (const [name, body] of Object.entries(files)) await fs.writeFile(path.join(dir, name), body);
  const initial = {
    version: 1,
    mappings: {
      x_item: {
        entitySet: 'x_items',
        idColumn: 'x_itemid',
        nameColumn: 'x_name',
        fields: {
          x_name: { dataverseType: 'nvarchar' },
          x_doc: { dataverseType: 'file', MaxSizeInKB: 1 },
          x_secret: { dataverseType: 'file' },
          x_image: { dataverseType: 'image', isPrimary: true, canStoreFullImage: false },
        },
      },
      contact: {
        entitySet: 'contacts',
        idColumn: 'contactid',
        nameColumn: 'fullname',
        fields: { fullname: { dataverseType: 'nvarchar' } },
        ...(images
          ? { relationships: { x_items: { entity: 'x_item', from: 'contactid', to: 'x_owner', many: true } } }
          : {}),
      },
    },
    tables: {
      x_item: [
        { x_itemid: ITEM, x_name: 'Mine', x_owner: CONTACT },
        { x_itemid: OTHER, x_name: 'Theirs', x_owner: null },
      ],
      contact: [{ contactid: CONTACT, fullname: 'Invented Visitor' }],
      ...(applicationUser
        ? { systemuser: [{ systemuserid: applicationUser, fullname: 'Invented application user', isdisabled: false }] }
        : {}),
    },
    // Read on every item, write only on the visitor's own (contact scope).
    permissions: [
      { id: 'read', entity: 'x_item', scope: 'global', roles: ['Member'], operations: ['read'] },
      {
        id: 'own',
        entity: 'x_item',
        scope: 'contact',
        field: 'x_owner',
        roles: ['Member'],
        operations: ['read', 'update'],
      },
      ...(images
        ? [{ id: 'contacts', entity: 'contact', scope: 'global', roles: ['Member'], operations: ['read'] }]
        : []),
    ],
    settings: { permissionMode: 'enforce' },
    simulator: { mode: 'local', pageMode: 'local', live: { origin: null }, endpoints: [] },
  };
  const options = {
    sourceDir: dir,
    stateFile: path.join(dir, 'state.json'),
    initial,
    watch: false,
    ...(applicationUser
      ? {
          observed: {
            portalApplicationUserId: applicationUser,
            evidence: 'Invented loopback application principal without a field-security profile.',
          },
        }
      : {}),
  };
  app = await createSimulator(options);
  let cookie, token;
  const signIn = async () => {
    cookie = signInHeaders(app, CONTACT, { roles: ['Member'] }).cookie;
    token = /value="([^"]+)"/.exec(
      await (await fetch(`${app.url}/_layout/tokenhtml`, { headers: { cookie } })).text(),
    )[1];
  };
  await signIn();
  const call = (method, route, body, headers = {}) =>
    fetch(`${app.url}/_api/${route}`, {
      method,
      body,
      headers: {
        cookie,
        'x-requested-with': 'XMLHttpRequest',
        ...(method === 'GET' ? {} : { __RequestVerificationToken: token }),
        ...headers,
      },
    });
  const restart = async () => {
    await app.close();
    app = await createSimulator(options);
    await signIn();
    return app;
  };
  return { app, call, restart };
}

test('portal image reads project saved bytes, survive restart and distinguish thumbnails from unavailable full images', async (t) => {
  const { app, call, restart } = await simulator(t, { images: true });
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=';
  const route = `x_items(${ITEM})`;
  const saved = await call('PATCH', route, JSON.stringify({ x_image: image }), {
    'content-type': 'application/json',
    prefer: 'return=representation',
  });
  assert.equal(saved.status, 200);
  assert.equal((await saved.json()).x_image, image, 'write representations must not expose internal file IDs');
  assert.notEqual(app.store.tableRows('x_item')[0].x_image, image, 'storage keeps the file ID');
  const checkReads = async () => {
    assert.equal((await (await call('GET', `${route}?$select=x_image`)).json()).x_image, image);
    assert.equal((await (await call('GET', 'x_items?$select=x_image')).json()).value[0].x_image, image);
    const xml = '<fetch><entity name="x_item"><attribute name="x_image"/></entity></fetch>';
    assert.equal(
      (await (await call('GET', `x_items?fetchXml=${encodeURIComponent(xml)}`)).json()).value[0].x_image,
      image,
    );
    assert.equal(
      (await (await call('GET', `contacts(${CONTACT})/x_items?$select=x_image`)).json()).value[0].x_image,
      image,
    );
    assert.equal(
      (await (await call('GET', `contacts(${CONTACT})?$select=fullname&$expand=x_items($select=x_image)`)).json())
        .x_items[0].x_image,
      image,
    );
    assert.equal((await (await call('GET', `${route}/x_image`)).json()).value, image);
    for (const suffix of ['', '?size=thumbnail']) {
      const response = await call('GET', `${route}/x_image/$value${suffix}`);
      assert.equal(response.status, 200);
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(image, 'base64'));
    }
    assert.equal((await call('GET', `${route}/x_image/$value?size=full`)).status, 204);
  };
  await checkReads();
  await restart();
  await checkReads();
  assert.equal(
    (
      await call('PATCH', `x_items(${OTHER})`, JSON.stringify({ x_image: image }), {
        'content-type': 'application/json',
      })
    ).status,
    403,
  );
  assert.equal((await call('GET', `x_items(${OTHER})/x_image/$value`)).status, 204);
  assert.equal((await call('DELETE', `${route}/x_image`)).status, 204);
  assert.equal((await (await call('GET', `${route}?$select=x_image`)).json()).x_image, null);
  assert.equal((await call('GET', `${route}/x_image/$value`)).status, 204);
});

test('image hydration and binary downloads preserve the portal reader field-security mask', async (t) => {
  const { app, call } = await simulator(t, { images: true, applicationUser: '77777777-7777-4777-8777-777777777775' });
  const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=';
  const route = `x_items(${ITEM})`;
  assert.equal(
    (await call('PATCH', route, JSON.stringify({ x_image: image }), { 'content-type': 'application/json' })).status,
    204,
  );
  await app.store.transact(() => {
    app.store.state.mappings.x_item.fields.x_image.columnMetadata = { isSecured: true };
  });
  assert.equal((await (await call('GET', `${route}?$select=x_image`)).json()).x_image, null);
  assert.equal((await (await call('GET', 'x_items?$select=x_image')).json()).value[0].x_image, null);
  assert.equal((await call('GET', `${route}/x_image`)).status, 204);
  assert.equal((await call('GET', `${route}/x_image/$value`)).status, 204);
  assert.ok(app.store.tableRows('x_item')[0].x_image, 'the stored image still exists behind the denied projection');
});

test("a file column round-trips through the portal Web API with the visitor's table permissions", async (t) => {
  const { call } = await simulator(t);
  const octet = { 'content-type': 'application/octet-stream' };
  assert.equal(
    (await call('PATCH', `x_items(${ITEM})/x_doc?x-ms-file-name=r%C3%A9sum%C3%A9.txt`, 'hello', octet)).status,
    204,
  );
  const download = await call('GET', `x_items(${ITEM})/x_doc/$value`);
  assert.equal(download.status, 200);
  // Never the stored type on the portal origin: octet-stream as an attachment, the stored type in mimetype.
  assert.equal(download.headers.get('content-type'), 'application/octet-stream');
  assert.equal(download.headers.get('mimetype'), 'text/plain');
  assert.equal(download.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(download.headers.get('x-ms-file-size'), '5');
  assert.match(download.headers.get('content-disposition'), /^attachment;.*filename\*=UTF-8''r%C3%A9sum%C3%A9\.txt/);
  assert.equal(await download.text(), 'hello');
  const named = await (await call('GET', `x_items(${ITEM})?$select=x_name`)).json();
  assert.equal(named.x_name, 'Mine');
  // PUT replaces the file; the name may come in the x-ms-file-name header.
  assert.equal(
    (await call('PUT', `x_items(${ITEM})/x_doc`, 'again', { ...octet, 'x-ms-file-name': 'b.txt' })).status,
    204,
  );
  assert.equal(await (await call('GET', `x_items(${ITEM})/x_doc/$value`)).text(), 'again');
  // Write permission on the row: the visitor may read the other item but not upload to it (403, nothing stored).
  const denied = await call('PATCH', `x_items(${OTHER})/x_doc?x-ms-file-name=a.txt`, 'nope', octet);
  assert.equal(denied.status, 403);
  assert.equal(
    (await call('GET', `x_items(${OTHER})/x_doc/$value`)).status,
    404,
    'an empty file column answers 404 (seam)',
  );
  // A column outside Webapi/<table>/fields is refused before the seam; the column size limit (MaxSizeInKB 1) applies.
  assert.equal((await call('PATCH', `x_items(${ITEM})/x_secret?x-ms-file-name=a.txt`, 'x', octet)).status, 403);
  assert.equal(
    (await call('PATCH', `x_items(${ITEM})/x_doc?x-ms-file-name=big.bin`, Buffer.alloc(2048), octet)).status,
    400,
  );
  assert.equal(
    await (await call('GET', `x_items(${ITEM})/x_doc/$value`)).text(),
    'again',
    'refused uploads leave the file',
  );
  // A nameless upload (as in the documented Power Pages sample) keeps the stored name.
  assert.equal((await call('PATCH', `x_items(${ITEM})/x_doc`, 'third', octet)).status, 204);
  const kept = await call('GET', `x_items(${ITEM})/x_doc/$value`);
  assert.deepEqual([await kept.text(), kept.headers.get('x-ms-file-name')], ['third', 'b.txt']);
  // A file name is never a path: refused before anything is stored.
  for (const name of ['..%2F..%2Fevil.txt', 'a%5Cb.txt', '..'])
    assert.equal(
      (await call('PATCH', `x_items(${ITEM})/x_doc?x-ms-file-name=${name}`, 'evil', octet)).status,
      400,
      name,
    );
  assert.equal(await (await call('GET', `x_items(${ITEM})/x_doc/$value`)).text(), 'third');
  // An uploaded page never comes back as HTML on the portal origin.
  assert.equal(
    (await call('PATCH', `x_items(${ITEM})/x_doc?x-ms-file-name=a.html`, '<script>1</script>', octet)).status,
    204,
  );
  const page = await call('GET', `x_items(${ITEM})/x_doc/$value`);
  assert.deepEqual(
    [page.headers.get('content-type'), page.headers.get('mimetype')],
    ['application/octet-stream', 'text/html'],
  );
  assert.match(page.headers.get('content-disposition'), /^attachment/);
  assert.equal((await call('PATCH', `x_items(${OTHER})/x_doc`, 'x', octet)).status, 403);
  assert.equal((await call('DELETE', `x_items(${OTHER})/x_doc`)).status, 403);
  assert.equal((await call('DELETE', `x_items(${ITEM})/x_doc`)).status, 204);
  assert.equal((await call('GET', `x_items(${ITEM})/x_doc/$value`)).status, 404);
  // A text column keeps the JSON property routes.
  assert.equal(
    (
      await call('PUT', `x_items(${ITEM})/x_name`, JSON.stringify({ value: 'Renamed' }), {
        'content-type': 'application/json',
      })
    ).status,
    204,
  );
  assert.equal(await (await call('GET', `x_items(${ITEM})/x_name/$value`)).text(), 'Renamed');
});

test('closing the runtime drains an accepted blob release before its state directory is removed', async () => {
  const hooks = [];
  const fixture = await simulator({ after: (hook) => hooks.push(hook) });
  const app = fixture.app,
    dir = path.dirname(app.store.file),
    remove = fs.rm;
  const objectPrefix = path.join(dir, 'blobs', 'objects') + path.sep;
  let releaseDelete,
    observeDelete,
    removalObserved = false,
    cleanup;
  const deleteGate = new Promise((resolve) => {
    releaseDelete = resolve;
  });
  const deleteStarted = new Promise((resolve) => {
    observeDelete = resolve;
  });
  fs.rm = async (target, options) => {
    if (String(target).startsWith(objectPrefix)) {
      observeDelete();
      await deleteGate;
    }
    if (target === dir) removalObserved = true;
    return remove(target, options);
  };
  try {
    const uploaded = await fixture.call('PATCH', `x_items(${ITEM})/x_doc?x-ms-file-name=owned.txt`, 'owned bytes', {
      'content-type': 'application/octet-stream',
    });
    assert.equal(uploaded.status, 204);
    assert.equal((await fixture.call('DELETE', `x_items(${ITEM})/x_doc`)).status, 204);
    await deleteStarted;
    cleanup = (async () => {
      for (const hook of hooks) await hook();
    })();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(removalObserved, false, 'directory removal must wait for the accepted provider delete');
    releaseDelete();
    await cleanup;
    assert.equal(removalObserved, true);
    assert.equal(app.server.listening, false);
    await assert.rejects(fs.stat(dir), { code: 'ENOENT' });
  } finally {
    releaseDelete();
    await cleanup?.catch(() => {});
    fs.rm = remove;
    await app.close();
    await remove(dir, { recursive: true, force: true });
  }
});
