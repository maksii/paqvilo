// @test-kind security: only a signed-in contact whose web role holds the Preview Unpublished Entities website access permission (https://learn.microsoft.com/power-pages/security/website-access-permission) may set the classic adxPreviewUnpublishedEntities cookie; everyone else is refused and gets no cookie.
import test from 'node:test';
import assert from 'node:assert/strict';
import { signInHeaders } from '../testing/session.mjs';
import { PREVIEW_CONTACT as CONTACT, publishingPreviewSite } from './fixtures/publishing-preview-site.mjs';

async function previewSite(t) {
  const { app } = await publishingPreviewSite(t);
  const toggle = async (cookie, body, { csrf = app.csrf } = {}) => {
    const response = await fetch(`${app.adminOrigin}/__sim/api/session/preview`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'content-type': 'application/json',
        ...(csrf ? { 'x-sim-csrf': csrf } : {}),
        ...(cookie ? { cookie } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    return { status: response.status, json: await response.json(), setCookie: response.headers.get('set-cookie') };
  };
  const page = async (cookie) => (await fetch(`${app.url}/draft/`, { headers: { cookie }, redirect: 'manual' })).status;
  return { app, toggle, page };
}

// @test-kind contract: the local toggle route and its cookie values (true, false, cleared) follow classic PreviewPermission Enable/Disable and the default-on reading Mirage already applies.
test('a contact with the preview right turns publishing preview off, on and back to the default', async (t) => {
  const { app, toggle, page } = await previewSite(t);
  const editor = signInHeaders(app, CONTACT, { roles: ['Editor'] }).cookie;
  const before = await toggle(editor);
  assert.equal(before.status, 200);
  assert.deepEqual(before.json, {
    cookie: { name: 'adxPreviewUnpublishedEntities', value: null },
    signedIn: true,
    eligible: true,
    enabled: true,
  });
  assert.equal(await page(editor), 200, 'preview is on without the cookie');

  const off = await toggle(editor, { enabled: false });
  assert.equal(off.status, 200);
  assert.equal(off.json.enabled, false);
  assert.match(off.setCookie, /^adxPreviewUnpublishedEntities=false; Path=\/; SameSite=Lax$/);
  const offCookie = `${editor}; ${off.setCookie.split(';')[0]}`;
  assert.equal(await page(offCookie), 403);
  assert.equal((await toggle(offCookie)).json.enabled, false);

  const on = await toggle(offCookie, { enabled: true });
  assert.match(on.setCookie, /^adxPreviewUnpublishedEntities=true;/);
  assert.equal(await page(`${editor}; ${on.setCookie.split(';')[0]}`), 200);

  const cleared = await toggle(offCookie, { enabled: null });
  assert.equal(cleared.status, 200);
  assert.match(cleared.setCookie, /^adxPreviewUnpublishedEntities=; Path=\/; Max-Age=0;/);
  assert.deepEqual(cleared.json.cookie, { name: 'adxPreviewUnpublishedEntities', value: null });
  assert.equal(cleared.json.enabled, true);
});

test('anonymous visitors, contacts without the right and requests without the CSRF token are refused without a cookie', async (t) => {
  const { app, toggle, page } = await previewSite(t);
  const anonymous = await toggle(null, { enabled: true });
  assert.equal(anonymous.status, 409);
  assert.equal(anonymous.setCookie, null);

  const reader = signInHeaders(app, CONTACT, { roles: ['Reader'] }).cookie;
  assert.deepEqual((await toggle(reader)).json, {
    cookie: { name: 'adxPreviewUnpublishedEntities', value: null },
    signedIn: true,
    eligible: false,
    enabled: false,
  });
  for (const enabled of [true, false, null]) {
    const refused = await toggle(reader, { enabled });
    assert.equal(refused.status, 403, String(enabled));
    assert.equal(refused.setCookie, null);
  }
  // A cookie set by hand gives a contact without the right no preview.
  assert.equal(await page(`${reader}; adxPreviewUnpublishedEntities=true`), 403);

  const editor = signInHeaders(app, CONTACT, { roles: ['Editor'] }).cookie;
  const forged = await toggle(editor, { enabled: false }, { csrf: null });
  assert.equal(forged.status, 403);
  assert.equal(forged.setCookie, null);
  const invalid = await toggle(editor, { enabled: 'yes' });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.setCookie, null);
});
