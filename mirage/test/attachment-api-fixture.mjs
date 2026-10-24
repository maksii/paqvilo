// A loopback Dataverse API over an fx_widget table, signed in as one System Administrator application user,
// for the note and attachment block tests.
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { uuidV5 } from '../lib/dataverse-security.mjs';

export const APP_ID = '77777777-7777-4777-8777-777777777771';
export const WIDGET = '77777777-7777-4777-8777-777777777772';
const SECRET_VAR = 'PAQVILO_ATTACHMENT_FIXTURE_SECRET';
export const b64 = (text) => Buffer.from(text).toString('base64');
export const widget = { '@odata.type': 'Microsoft.Dynamics.CRM.fx_widget', fx_widgetid: WIDGET };

export async function attachmentApi(t, { before = () => {} } = {}) {
  process.env[SECRET_VAR] = 'attachment-fixture-secret';
  const state = emptyState();
  state.mappings.fx_widget = {
    logicalName: 'fx_widget',
    entitySet: 'fx_widgets',
    idColumn: 'fx_widgetid',
    nameColumn: 'fx_name',
    userConfigured: true,
    fields: { fx_name: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.tables.fx_widget = [{ fx_widgetid: WIDGET, fx_name: 'Invented widget' }];
  const store = await new DataStore({ state }).init();
  await before(store);
  const settings = dataverseSettings({
    enabled: true,
    applications: [
      {
        appId: APP_ID,
        displayName: 'Invented attachment app',
        secretEnvironmentVariable: SECRET_VAR,
        roles: ['System Administrator'],
      },
    ],
  });
  const server = await startDataverseApi({ store, settings, log: () => {} });
  t.after(() => server.close());
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: process.env[SECRET_VAR],
      scope: `${server.origin}/.default`,
    }),
  });
  const authorization = `Bearer ${(await token.json()).access_token}`;
  const send = async (path, body) => {
    const response = await fetch(`${server.origin}/api/data/v9.2/${path}`, {
      method: 'POST',
      headers: { authorization, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : null, headers: response.headers };
  };
  // Initialize, one UploadBlock per chunk, then commit; returns the commit (or the first refused step).
  const blocks = async (kind, chunks, commit = {}) => {
    const init = await send(`Initialize${kind}BlocksUpload`, { Target: widget });
    if (init.status !== 200) return init;
    const token = init.json.FileContinuationToken,
      ids = chunks.map((_, i) => b64(`block-${i}`));
    for (const [i, chunk] of chunks.entries()) {
      const block = await send('UploadBlock', { BlockId: ids[i], BlockData: b64(chunk), FileContinuationToken: token });
      if (block.status !== 204) return block;
    }
    return send(`Commit${kind}BlocksUpload`, {
      Target: widget,
      BlockList: ids,
      FileContinuationToken: token,
      ...commit,
    });
  };
  const appUserId = uuidV5(server.organizationId, `systemuser:app:${APP_ID}`);
  return { server, store, send, blocks, appUserId };
}
