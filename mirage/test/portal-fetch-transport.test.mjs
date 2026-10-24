import test from 'node:test';
import assert from 'node:assert/strict';
import { portalFetchTransportSizes, assertPortalFetchXmlTransport } from '../lib/portal-fetch-transport.mjs';
import { observedConfig } from '../lib/project-config.mjs';
import { DataStore } from '../lib/data.mjs';
import { handleWebApi } from '../lib/webapi-handler.mjs';

const profile = (header, url, construction) => ({
  encoding: 'double-rfc3986',
  maxHeaderXmlBytes: header,
  maxUrlXmlBytes: url,
  maxConstructedXmlBytes: construction,
});
test('observed transport uses RFC3986 punctuation escaping and separate ordered admission boundaries', () => {
  assert.deepEqual(portalFetchTransportSizes("!'()* "), { escapedXmlBytes: 18, doubleEscapedXmlBytes: 30 });
  assert.doesNotThrow(() => assertPortalFetchXmlTransport("!'()* ", profile(30, 30, 30)));
  assert.throws(
    () => assertPortalFetchXmlTransport("!'()* ", profile(29, 30, 30)),
    (e) => e.status === 400 && e.details.phase === 'native-api-transport',
  );
  assert.throws(
    () => assertPortalFetchXmlTransport("!'()* ", profile(29, 29, 30)),
    (e) => e.status === 414 && e.details.innerCode === '9004010D',
  );
  assert.throws(
    () => assertPortalFetchXmlTransport("!'()* ", profile(29, 29, 29)),
    (e) => e.status === 500 && e.details.reason === 'uri-construction',
  );
  assert.throws(() => observedConfig({ webApiFetchXmlTransport: profile(1, 2, 3) }), /evidence/);
  for (const value of [profile(3, 2, 4), { ...profile(1, 2, 3), encoding: 'arbitrary' }, profile('1', 2, 3)])
    assert.throws(
      () => observedConfig({ webApiFetchXmlTransport: value, evidence: 'Invented boundary controls' }),
      /ordered bounded integer/,
    );
});

test('actual Web API transport failures precede observers, preserve permission joins and retain native CDS envelopes', async () => {
  const source = '<fetch><entity name="widget"><attribute name="widgetid"/></entity></fetch>',
    identity = { contactId: 'person', roles: ['member'] };
  for (const expected of [200, 400, 414, 500]) {
    const store = new DataStore({
      state: {
        mappings: {
          widget: { entitySet: 'widgets', idColumn: 'widgetid' },
          holder: { entitySet: 'holders', idColumn: 'holderid' },
        },
        tables: { widget: [{ widgetid: 'one', holderid: 'h1' }], holder: [{ holderid: 'h1', personid: 'person' }] },
        permissions: [
          {
            id: 'anchor',
            entity: 'holder',
            scope: 'contact',
            field: 'personid',
            roles: ['member'],
            operations: ['read'],
          },
          {
            id: 'child',
            entity: 'widget',
            scope: 'parent',
            parentPermissionId: 'anchor',
            relationship: { entity: 'holder', from: 'holderid', to: 'holderid' },
            roles: ['member'],
            operations: ['read'],
          },
        ],
        settings: { permissionMode: 'enforce' },
      },
    });
    store.setObserved({ tablePermissionQueryPipeline: 'native-classic' });
    const compiled = store.fetchXml(source, identity, { portalRequest: true, profile: 'webapi' });
    assert.equal(compiled.permissionQuery.permissionLinkCount, 1);
    const bytes = portalFetchTransportSizes(compiled.xml).doubleEscapedXmlBytes;
    const limits =
      expected === 200
        ? profile(bytes, bytes, bytes)
        : expected === 400
          ? profile(bytes - 1, bytes, bytes)
          : expected === 414
            ? profile(bytes - 1, bytes - 1, bytes)
            : profile(bytes - 1, bytes - 1, bytes - 1);
    store.setObserved(
      observedConfig({
        tablePermissionQueryPipeline: 'native-classic',
        webApiFetchXmlTransport: limits,
        webApiCdsErrorCode: 'cdscode',
        evidence: 'Invented encoded GET transport admission fixture',
      }),
    );
    const stages = [];
    store.setPluginPipeline(
      (event) => stages.push(event.stage),
      () => true,
    );
    let status, body;
    const response = {
      headersSent: false,
      writeHead(code) {
        status = code;
        this.headersSent = true;
      },
      end(value) {
        body = JSON.parse(value);
      },
    };
    const url = new URL('http://127.0.0.1/_api/widgets?fetchXml=' + encodeURIComponent(source));
    await handleWebApi({ method: 'GET', headers: {} }, response, url, {
      store,
      identity,
      portal: {
        observed: store.observed,
        settings: {
          'Webapi/widget/enabled': 'true',
          'Webapi/widget/fields': 'widgetid',
          'Webapi/error/innererror': 'true',
        },
      },
      origin: url.origin,
      origins: [url.origin],
      csrf: 'owned-transport-cursor',
      json(res, code, value) {
        res.writeHead(code);
        res.end(JSON.stringify(value));
      },
    });
    assert.equal(status, expected);
    assert.deepEqual(stages, expected === 200 ? [10, 20, 40] : []);
    if (expected === 200) assert.equal(body.value[0].widgetid, 'one');
    else if (expected === 500) assert.equal(body.error.code, '9004010A');
    else {
      assert.equal(body.error.code, '9004010D');
      assert.equal(body.error.cdscode, '9004010D');
      assert.equal(body.error.innererror.type, 'CDSError');
      assert.match(body.error.innererror.message, expected === 414 ? /Request URL Too Long/ : /headers is too long/);
    }
    assert.deepEqual(store.fetchXml(source, { admin: true }, { profile: 'webapi' }).entities, [{ widgetid: 'one' }]);
  }
});
