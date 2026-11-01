// The TDS endpoint without a shared certificate generates its in-memory certificate at the first TLS handshake
// (dataverse-tds.mjs): every connection still completes TLS, and later connections present the same certificate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import tls from 'node:tls';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';

async function peerCertificate(port, ALPNProtocols) {
  // The generated certificate is self-signed for loopback: trust is out of scope here, the handshake is not.
  const socket = tls.connect({ host: '127.0.0.1', port, ALPNProtocols, rejectUnauthorized: false });
  try {
    await once(socket, 'secureConnect');
    return socket.getPeerCertificate();
  } finally {
    socket.destroy();
  }
}

test('an endpoint without a shared certificate completes TLS with one generated certificate', async (t) => {
  const store = await new DataStore({ state: emptyState() }).init();
  const api = await startDataverseApi({ store, settings: dataverseSettings({ enabled: true }), log: () => {} });
  t.after(() => api.close());
  const first = await peerCertificate(api.tdsPort, ['tds/8.0']);
  const second = await peerCertificate(api.tdsPort, ['tds/8.0']);
  assert.match(first.fingerprint256, /^(?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/);
  assert.equal(second.fingerprint256, first.fingerprint256);
  assert.ok(first.subjectaltname.includes('IP Address:127.0.0.1'), first.subjectaltname);
});
