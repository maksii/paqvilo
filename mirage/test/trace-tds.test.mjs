// @test-kind contract+security: Paqvilo's tracing and activity design (docs/design/tracing.md); redaction keeps secrets, tokens and keys out of traces
// Tracing of the Dataverse TDS endpoint (docs/design/tracing.md): every SQL statement is a root `http` span on host `tds`,
// named by its text with literals redacted, run as the signed-in caller, with the entity reads it makes as children; at
// full the span keeps the statement text, and a failed statement or batch carries the SQL error. Hand-built TDS 8 client
// over loopback TLS; invented schema.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { createSelfSignedCertificate } from '../lib/dataverse-tls.mjs';
import { APP_ID, startListener } from './support/trace-listener.mjs';
import { tdsLogin, tdsQuery, utf16 } from './support/tds-client.mjs';

const certificate = createSelfSignedCertificate();
// TDS 8 against this suite's loopback certificate, signed in with the token; query(sql) resolves with the whole reply.
async function signIn(port, token) {
  const { client } = await tdsLogin(port, token, certificate.cert);
  return { query: (sql) => tdsQuery(client, sql), close: client.close };
}

let listener, client;
before(async () => {
  listener = await startListener({ tls: certificate, tds: true });
  for (const name of ['Alpha widget', 'Beta widget'])
    assert.equal(
      (await listener.request('POST', '/api/data/v9.2/fx_widgets', { body: { fx_name: name } })).status,
      204,
    );
  client = await signIn(listener.api.tdsPort, listener.token);
});
after(async () => {
  client?.close();
  await listener?.close();
});

// The tds roots that started after mark (a span sequence), oldest first, with their trees.
const tdsRoots = (mark) =>
  listener.traces
    .spans({ host: 'tds', order: 'asc', pageSize: 200 })
    .items.filter((span) => span.parentSpanId === null && span.sequence > mark)
    .map((span) => ({ span, tree: listener.traces.tree(span.traceId) }));
const mark = () => listener.traces.query({}).latestSequence;

test('each statement is a tds root named with its literals redacted, run as the caller, with its entity read under it', async () => {
  const from = mark();
  const reply = await client.query(
    "SELECT fx_name FROM fx_widget WHERE fx_name = 'Alpha widget'\nSELECT COUNT(*) AS total FROM fx_widget WHERE 1 = 1",
  );
  assert.ok(reply.indexOf(utf16('Alpha widget')) > 0, 'the query answered');
  const roots = tdsRoots(from);
  assert.equal(roots.length, 2, 'one root per statement');
  assert.notEqual(roots[0].span.traceId, roots[1].span.traceId);
  const [{ span: first, tree }, { span: second }] = roots;
  assert.deepEqual(
    [first.kind, first.module, first.operation, first.status, first.origin.host],
    ['http', 'dataverse', 'query', 'ok', 'tds'],
  );
  assert.equal(first.name, 'SELECT fx_name FROM fx_widget WHERE fx_name = ?');
  assert.deepEqual([first.attributes.sql, first.attributes.statementType], [first.name, 'Select']);
  assert.equal(second.name, 'SELECT COUNT(*) AS total FROM fx_widget WHERE ? = ?');
  assert.deepEqual([first.actor.kind, first.attributes.appId], ['app', APP_ID]);
  assert.equal(first.attributes.rowCount, 1);
  assert.equal(first.input.sql, "SELECT fx_name FROM fx_widget WHERE fx_name = 'Alpha widget'", 'the text at full');
  assert.deepEqual(first.output.resultSets, [{ columns: ['fx_name'], rows: 1 }]);
  const read = tree.spans.find((span) => span.parentSpanId === first.spanId);
  assert.deepEqual(
    [read.kind, read.operation, read.entity, read.actor.kind, read.origin.host],
    ['dataverse', 'retrievemultiple', 'fx_widget', 'app', 'tds'],
  );
});

test('at level summary no literal of a statement reaches the trace', async () => {
  listener.traces.configure({ level: 'summary' });
  try {
    const from = mark();
    await client.query("SELECT fx_name FROM fx_widget WHERE fx_name = N'Beta widget'");
    const [{ span, tree }] = tdsRoots(from);
    assert.equal(span.name, 'SELECT fx_name FROM fx_widget WHERE fx_name = ?');
    assert.equal(JSON.stringify(tree).includes('Beta widget'), false);
  } finally {
    listener.traces.configure({ level: 'full' });
  }
});

test('a failed statement and a batch that does not parse are roots carrying the SQL error number', async () => {
  const from = mark();
  await client.query('SELECT fx_name FROM fx_unknown');
  await client.query('SELEC fx_name FROM fx_widget');
  const [unknown, broken] = tdsRoots(from).map((root) => root.span);
  assert.deepEqual([unknown.status, unknown.error.code], ['error', '208']);
  assert.match(unknown.error.message, /fx_unknown/);
  assert.deepEqual([broken.name, broken.status, broken.error.code], ['SQL batch', 'error', '102']);
  assert.equal(broken.attributes.sql, undefined, 'an unparsed batch has no redacted text');
  assert.equal(broken.input.sql, 'SELEC fx_name FROM fx_widget');
});
