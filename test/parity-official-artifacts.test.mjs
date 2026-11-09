// @test-kind tooling: adversarial invented evidence checks the CDN provenance validator, not native or Microsoft behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  officialArtifactJsonSha256 as jsonHash,
  validateMicrosoftCdnArtifact,
} from '../scripts/parity-official-artifacts.mjs';
const sha = (v) => createHash('sha256').update(v).digest('hex');
const base = 'https://content.powerapps.com/resource/powerappsportal/controls/';
function fixture() {
  const body = Buffer.from(JSON.stringify({ hash: '/host/main.abcdef1234.chunk.js' }));
  const source = base + 'host/manifest-1.2.3.json';
  const script = base + 'host/main.abcdef1234.chunk.js';
  const pkg = {
    ecosystem: 'microsoft-cdn',
    id: 'powerappsportal-controls',
    manifests: [{ source, version: '1.2.3', sha256: sha(body), bodyBase64: body.toString('base64') }],
    executedSourceClosure: [{ source: script, sha256: sha('script'), size: 6 }],
  };
  const publisherReads = [
    { source, finalUrl: source, status: 200, sha256: sha(body), size: body.length },
    { source: script, finalUrl: script, status: 200, sha256: sha('script'), size: 6 },
  ];
  const executedScripts = [
    { kind: 'controls', source: script, sha256: sha('script'), size: 6 },
    { kind: 'other', source: 'inline:0', sha256: sha('inline'), size: 6 },
  ];
  const input = { contextSha256: sha('context'), executedScripts };
  const policy = {
    contextOffline: true,
    proxyDeny: true,
    allRequestsRouted: true,
    serviceWorkersBlocked: true,
    webSocketsDenied: true,
    unexpectedNetwork: 0,
  };
  const runs = ['first', 'second'].map((id) => ({
    id,
    producerSha256: sha('producer'),
    input: structuredClone(input),
    result: {
      executedScripts: structuredClone(executedScripts),
      networkPolicy: structuredClone(policy),
      sourceCaptureSha256: sha(id),
      answer: 3,
    },
  }));
  const data = { pkg, publisherReads, runs };
  seal(data);
  return data;
}
function seal(data) {
  for (const r of data.runs) {
    r.inputSha256 = jsonHash(r.input);
    r.resultSha256 = jsonHash(r.result);
    r.receiptSha256 = jsonHash({
      id: r.id,
      producerSha256: r.producerSha256,
      inputSha256: r.inputSha256,
      resultSha256: r.resultSha256,
    });
  }
}
const valid = (x) => validateMicrosoftCdnArtifact(x.pkg, x.publisherReads, x.runs);
test('accepts complete bound invented CDN receipts', () => assert.equal(valid(fixture()), true));
test('compares script inventories independently of ordering without changing source spelling', () => {
  const data = fixture();
  for (const run of data.runs) {
    run.input.executedScripts.push({ kind: 'other', source: 'inline:Ω', sha256: sha('unicode'), size: 7 });
    run.result.executedScripts.push({ kind: 'other', source: 'inline:Ω', sha256: sha('unicode'), size: 7 });
    run.result.executedScripts.reverse();
  }
  seal(data);
  assert.equal(valid(data), true);
  data.runs[0].result.executedScripts[0].source = 'inline:ω';
  seal(data);
  assert.equal(valid(data), false);
});
test('accepts a correctly bound federated manifest entry', () => {
  const x = fixture();
  const body = Buffer.from(
    JSON.stringify({ Shared: { library: 'host', remoteEntry: '/host/main.abcdef1234.chunk.js', control: './Shared' } }),
  );
  x.pkg.manifests[0].bodyBase64 = body.toString('base64');
  x.pkg.manifests[0].sha256 = sha(body);
  x.publisherReads[0].sha256 = sha(body);
  x.publisherReads[0].size = body.length;
  assert.equal(valid(x), true);
});
for (const [name, mutate] of [
  [
    'non-Microsoft host',
    (x) => {
      x.pkg.manifests[0].source = x.pkg.manifests[0].source.replace('content.powerapps.com', 'evil.example');
    },
  ],
  [
    'user info authority',
    (x) => {
      x.pkg.manifests[0].source = x.pkg.manifests[0].source.replace('https://', 'https://content.powerapps.com@');
    },
  ],
  [
    'encoded path traversal',
    (x) => {
      x.pkg.executedSourceClosure[0].source = base + 'host/%2e%2e/evil.abcdef1234.js';
    },
  ],
  [
    'query string',
    (x) => {
      x.pkg.executedSourceClosure[0].source += '?v=1';
    },
  ],
  [
    'manifest version mismatch',
    (x) => {
      x.pkg.manifests[0].version = '1.2.4';
    },
  ],
  [
    'manifest bytes changed',
    (x) => {
      x.pkg.manifests[0].bodyBase64 = Buffer.from('{}').toString('base64');
    },
  ],
  [
    'unlinked manifest entry',
    (x) => {
      const b = Buffer.from('{"hash":"/host/main.0000000000.chunk.js"}');
      x.pkg.manifests[0].bodyBase64 = b.toString('base64');
      x.pkg.manifests[0].sha256 = sha(b);
      x.publisherReads[0].sha256 = sha(b);
      x.publisherReads[0].size = b.length;
    },
  ],
  [
    'redirect response',
    (x) => {
      x.publisherReads[1].finalUrl += '?redirected';
    },
  ],
  [
    'publisher bytes mismatch',
    (x) => {
      x.publisherReads[1].sha256 = sha('different');
    },
  ],
  [
    'missing publisher read',
    (x) => {
      x.publisherReads.pop();
    },
  ],
  [
    'same run id',
    (x) => {
      x.runs[1].id = x.runs[0].id;
      seal(x);
    },
  ],
  [
    'changed producer',
    (x) => {
      x.runs[1].producerSha256 = sha('different');
      seal(x);
    },
  ],
  [
    'same captured result',
    (x) => {
      x.runs[1].result.sourceCaptureSha256 = x.runs[0].result.sourceCaptureSha256;
      seal(x);
    },
  ],
  [
    'network fallback',
    (x) => {
      x.runs[1].result.networkPolicy.unexpectedNetwork = 1;
      seal(x);
    },
  ],
  [
    'missing executed dependency',
    (x) => {
      x.runs[1].input.executedScripts.shift();
      x.runs[1].result.executedScripts.shift();
      seal(x);
    },
  ],
  [
    'result not bound',
    (x) => {
      x.runs[1].result.answer = 4;
    },
  ],
  [
    'omitted non-CDN dependency',
    (x) => {
      for (const r of x.runs) {
        r.input.executedScripts.pop();
        r.result.executedScripts.pop();
      }
      seal(x);
    },
  ],
  [
    'omitted package asset',
    (x) => {
      x.pkg.executedSourceClosure = [];
    },
  ],
])
  test(`rejects ${name}`, () => {
    const x = fixture();
    mutate(x);
    assert.equal(valid(x), false);
  });
