import { codeApps } from 'paqvilo/mirage/code-apps/vite';
import { configure, dataClient, getContext } from 'paqvilo/mirage/lib/code-apps-client.js';

codeApps({ app: 'invented', mirageUrl: 'http://127.0.0.1:8787', mode: 'mirage', enabled: true });
configure({ app: 'invented', onEvent: (event) => { const kind: 'request' | 'request-error' = event.kind; void kind; } });
const context = await getContext();
const id: string = context.user.systemUserId;
const records = await dataClient.getAll<{ x_name: string }>('x_items', { select: ['x_name'], count: true });
const name: string = records.data[0].x_name;
void [id, name];
// @ts-expect-error -- option names are checked for consumers
codeApps({ app: 'invented', unsupported: true });
// @ts-expect-error -- event callbacks are functions
configure({ app: 'invented', onEvent: 'invalid' });
