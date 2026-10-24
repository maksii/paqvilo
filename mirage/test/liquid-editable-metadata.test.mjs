import test from 'node:test';
import assert from 'node:assert/strict';
import { editableMetadataAttributes } from '../lib/liquid-editable-metadata.mjs';

const source = {
  observed: { liquidEditableMetadata: 'observed' },
  websiteId: '10000000-0000-4000-8000-000000000001',
  rootId: '20000000-0000-4000-8000-000000000001',
  contentId: '30000000-0000-4000-8000-000000000001',
  key: 'adx_title',
  requestPath: '/probe/',
  workingFlag: 'False',
};

test('editable metadata needs explicit observation, source identities, and captured working flag', () => {
  assert.equal(editableMetadataAttributes({ ...source, observed: null }), '');
  assert.equal(editableMetadataAttributes({ ...source, workingFlag: null }), '');
  assert.equal(editableMetadataAttributes({ ...source, contentId: null }), '');
});

test('editable metadata distinguishes content authoring identity from root filebrowser identity', () => {
  const attrs = editableMetadataAttributes(source);
  assert.match(attrs, new RegExp('/adx_webpage/' + source.contentId + '/adx_title"'));
  const preview = /data-cmstemplate-render-url="([^"]+)"/.exec(attrs)[1];
  assert.ok(preview.includes('/adx_webpage/' + source.contentId + '/__templates/live-preview/'));
  assert.equal(Buffer.from(decodeURIComponent(preview.split('/').at(-1)), 'base64').toString(), source.requestPath);
  const working = /working=([^"]+)/.exec(attrs)[1];
  assert.equal(Buffer.from(working, 'base64').toString(), 'adx_webpage:' + source.rootId + ':False');
  assert.match(attrs, /data-encoded="false"/);
  assert.match(attrs, /data-liquid="true"/);
  assert.match(attrs, /data-label=""/);
});

test('all editable metadata values are quoted and escaped; non-ASCII paths retain UTF8', () => {
  const attrs = editableMetadataAttributes({
    ...source,
    label: '"<&>',
    key: 'x" onerror="bad',
    requestPath: '/é/',
    encoded: true,
    liquid: false,
  });
  assert.match(attrs, /data-label="&quot;&lt;&amp;&gt;"/);
  assert.match(attrs, /data-editable-title="x&quot; onerror=&quot;bad"/);
  assert.match(attrs, /data-encoded="true"/);
  assert.match(attrs, /data-liquid="false"/);
  const path = /__templates\/all\/([^"]+)/.exec(attrs)[1];
  assert.equal(Buffer.from(decodeURIComponent(path), 'base64').toString(), '/é/');
});
