// @test-kind contract: Paqvilo's tracing and activity design (docs/design/tracing.md)
// Tracing of the SOAP Organization service (docs/design/tracing.md): the listener root is on host `soap` and names the SOAP
// operation, the message and its query kind; every message (an ExecuteMultiple item included) is a dataverse span named by
// the message with its table, record and parameters; a fault is the root's error with the Dataverse code. Invented schema.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { NS } from '../lib/dataverse-soap-xml.mjs';
import { MISSING_ID, childrenOf, spanOf, startListener } from './support/trace-listener.mjs';

const DECL = Object.entries(NS)
  .map(([prefix, uri]) => `xmlns:${prefix}="${uri}"`)
  .join(' ');
const envelope = (body) => `<s:Envelope ${DECL}><s:Body>${body}</s:Body></s:Envelope>`;
const valueEl = (type, inner) => `<b:value i:type="${type}">${inner}</b:value>`;
const pair = (key, valueXml) =>
  `<a:KeyValuePairOfstringanyType><b:key>${key}</b:key>${valueXml}</a:KeyValuePairOfstringanyType>`;
const str = (value) => valueEl('c:string', value);
const guidValue = (id) => valueEl('e:guid', id);
const entityValue = (logical, attributes) =>
  valueEl('a:Entity', `<a:Attributes>${attributes.join('')}</a:Attributes><a:LogicalName>${logical}</a:LogicalName>`);
const execute = (type, name, pairs = []) =>
  envelope(
    `<Execute xmlns="${NS.svc}"><request i:type="a:${type}"><a:Parameters>${pairs.join('')}</a:Parameters><a:RequestName>${name}</a:RequestName></request></Execute>`,
  );
const orgRequest = (type, pairs) =>
  `<a:OrganizationRequest i:type="a:${type}"><a:Parameters>${pairs.join('')}</a:Parameters></a:OrganizationRequest>`;
const createWidget = (name) =>
  execute('CreateRequest', 'Create', [pair('Target', entityValue('fx_widget', [pair('fx_name', str(name))]))]);
const xmlText = (text) =>
  text.replace(/[<>"&]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '"': '&quot;', '&': '&amp;' })[c]);

let listener;
before(async () => {
  listener = await startListener();
});
after(() => listener?.close());

const soap = (xml) =>
  listener.request('POST', '/XRMServices/2011/Organization.svc/web', {
    body: xml,
    headers: { 'content-type': 'text/xml; charset=utf-8' },
  });
const rootOf = (tree) => tree.spans.find((span) => span.parentSpanId === null);

test('a SOAP Create is a soap-host root naming the message, over a Create span with the created record id', async () => {
  const answer = await soap(createWidget('Soap one'));
  assert.equal(answer.status, 200, answer.text);
  const id = /<b:key>id<\/b:key><b:value i:type="e:guid">([^<]+)</.exec(answer.text)[1];
  const tree = await listener.tree(answer.traceId);
  const root = rootOf(tree);
  assert.deepEqual(
    [root.origin.host, root.attributes.soapOperation, root.attributes.message, root.actor.kind],
    ['soap', 'Execute', 'Create', 'app'],
  );
  assert.match(root.input.body, /CreateRequest/, 'the envelope is the root input at full');
  const [message] = childrenOf(tree, root);
  assert.deepEqual(
    [message.kind, message.name, message.operation, message.entity, message.recordId, message.attributes.message],
    ['dataverse', 'Create fx_widget', 'create', 'fx_widget', id, 'Create'],
  );
  assert.equal(message.output.id.value, id);
  assert.ok(message.input.Target, 'the message parameters at full');
  assert.ok(
    childrenOf(tree, message).some((span) => span.kind === 'dataverse' && span.operation === 'create'),
    'the record pipeline runs under the message span',
  );
});

test('RetrieveMultiple names its query kind: fetchxml for a FetchExpression, queryexpression for a QueryExpression', async () => {
  const fetchXml = '<fetch><entity name="fx_widget"><attribute name="fx_name"/></entity></fetch>';
  const fetched = await soap(
    execute('RetrieveMultipleRequest', 'RetrieveMultiple', [
      pair('Query', valueEl('a:FetchExpression', `<a:Query>${xmlText(fetchXml)}</a:Query>`)),
    ]),
  );
  assert.equal(fetched.status, 200, fetched.text);
  const fetchTree = await listener.tree(fetched.traceId);
  assert.deepEqual(
    [rootOf(fetchTree).attributes.message, rootOf(fetchTree).attributes.query],
    ['RetrieveMultiple', 'fetchxml'],
  );
  const fetchSpan = spanOf(fetchTree, { name: 'RetrieveMultiple fx_widget' });
  assert.deepEqual([fetchSpan.attributes.query, fetchSpan.entity], ['fetchxml', 'fx_widget']);

  const expressed = await soap(
    execute('RetrieveMultipleRequest', 'RetrieveMultiple', [
      pair(
        'Query',
        valueEl(
          'a:QueryExpression',
          '<a:EntityName>fx_widget</a:EntityName>' +
            '<a:ColumnSet i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns/></a:ColumnSet>' +
            '<a:Criteria><a:FilterOperator>And</a:FilterOperator><a:Conditions/><a:Filters/></a:Criteria>',
        ),
      ),
    ]),
  );
  assert.equal(expressed.status, 200, expressed.text);
  const queryTree = await listener.tree(expressed.traceId);
  assert.equal(rootOf(queryTree).attributes.query, 'queryexpression');
  assert.equal(spanOf(queryTree, { name: 'RetrieveMultiple fx_widget' }).attributes.query, 'queryexpression');
});

test('a SOAP fault is the root error with the Dataverse code and message, and fails its message span', async () => {
  const answer = await soap(
    execute('UpdateRequest', 'Update', [
      pair(
        'Target',
        entityValue('fx_widget', [pair('fx_widgetid', guidValue(MISSING_ID)), pair('fx_name', str('Missing'))]),
      ),
    ]),
  );
  assert.equal(answer.status, 500);
  const tree = await listener.tree(answer.traceId);
  const root = rootOf(tree);
  assert.equal(root.status, 'error');
  assert.equal(root.error.code, '0x80040217');
  assert.match(root.error.message, /Does Not Exist/);
  assert.equal(root.error.status, 500);
  assert.equal(root.error.details.errorCode, -2147220969);
  const message = spanOf(tree, { name: 'Update fx_widget', parentSpanId: root.spanId });
  assert.deepEqual([message.status, message.recordId], ['error', MISSING_ID]);
  assert.match(message.error.message, /Does Not Exist/);
});

test('ExecuteMultiple opens one span per item with its index; a faulted item carries its own error', async () => {
  const settings = valueEl(
    'l:ExecuteMultipleSettings',
    '<a:ContinueOnError>true</a:ContinueOnError><a:ReturnResponses>true</a:ReturnResponses>',
  );
  const requests = valueEl(
    'a:OrganizationRequestCollection',
    [
      orgRequest('CreateRequest', [pair('Target', entityValue('fx_widget', [pair('fx_name', str('Kept'))]))]),
      orgRequest('UpdateRequest', [
        pair('Target', entityValue('fx_widget', [pair('fx_widgetid', guidValue(MISSING_ID))])),
      ]),
    ].join(''),
  );
  const answer = await soap(
    execute('ExecuteMultipleRequest', 'ExecuteMultiple', [pair('Requests', requests), pair('Settings', settings)]),
  );
  assert.equal(answer.status, 200, answer.text);
  const tree = await listener.tree(answer.traceId);
  assert.equal(rootOf(tree).attributes.message, 'ExecuteMultiple');
  const batch = spanOf(tree, { name: 'ExecuteMultiple' });
  const items = childrenOf(tree, batch);
  assert.deepEqual(
    items.map((item) => [item.name, item.attributes.requestIndex, item.status]),
    [
      ['Create fx_widget', 0, 'ok'],
      ['Update fx_widget', 1, 'error'],
    ],
  );
  assert.match(items[1].error.message, /Does Not Exist/);
});
