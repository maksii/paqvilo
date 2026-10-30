// The end-to-end tracing scenario on the real Power Pages host (docs/design/tracing.md), shared by
// test/trace-end-to-end.test.mjs and test-browser/activity-e2e.test.mjs. A signed-in member's Web API create runs table
// permissions, three synchronous plug-in steps (PreValidation, PreOperation, PostOperation) and a plug-in to plug-in chain
// (the PostOperation step's SDK create of x_audit runs the x_audit step), a synchronous web hook whose loopback receiver
// writes the receipt back through the portal Web API with the forwarded trace headers, an asynchronous plug-in step job and
// a row-triggered cloud flow (Key Vault secret through RetrieveEnvironmentVariableSecretValue, a fixture connector and a
// Dataverse update). The member's page GET joins the trace and renders the created order; a stranger's read is refused.
// The PostOperation step registers a two-column post-image, PreOperation sets a shared variable, and an order named with
// REJECTED is refused by the PreValidation step.
// Invented schema and loopback fixtures only; async work is driven by sim.settle() and trace-end events, never by time.
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createSimulator } from '../../api.mjs';
import { localOrganizationService } from '../../lib/local-organization-service.mjs';
import { drainFixture, makeTemporaryDirectory } from '../../testing/owned-fixture.mjs';

export const id = (n) => `e2e00000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const STEP = {
  preValidation: id(11),
  preOperation: id(12),
  postOperation: id(13),
  audit: id(14),
  async: id(15),
  webhook: id(62),
};
export const FLOW = id(21);
export const FLOW_USER = id(22);
export const SDK_USER = id(23);
export const MEMBER = id(31);
export const STRANGER = id(32);
export const RECEIPT = id(41);
export const ROLE = id(51);
export const SECRET_VALUE = 'e2e-secret-value-7f3c9a';
export const ACCESS_TOKEN = 'e2e-access-token-91b2';
export const HOOK_CODE = 'e2e-hook-code-5d1e';
export const REJECTED = 'REJECTED';
const SECRET_VARIABLE = 'PAQVILO_E2E_TRACE_SECRET';
const DV = '/providers/Microsoft.PowerApps/apis/shared_commondataserviceforapps';
const assemblyId = id(1),
  typeId = id(2);

// `images`: registered step images ({ alias, type: 0 pre | 1 post, attributes: 'a,b' }), as a Solution export writes them.
const stepXml = (stepId, name, { entity = 'x_order', stage, mode = 0, images = [] }) =>
  `<SdkMessageProcessingStep SdkMessageProcessingStepId="{${stepId}}"><Name>${name}</Name><PluginTypeId>${typeId}</PluginTypeId><SdkMessageName>Create</SdkMessageName><PrimaryEntity>${entity}</PrimaryEntity><Stage>${stage}</Stage><Rank>1</Rank><Mode>${mode}</Mode><SupportedDeployment>0</SupportedDeployment><StateCode>0</StateCode><FilteringAttributes></FilteringAttributes><SdkMessageProcessingStepImages>${images
    .map(
      ({ alias, type, attributes }) =>
        `<SdkMessageProcessingStepImage><Name>${alias}</Name><EntityAlias>${alias}</EntityAlias><ImageType>${type}</ImageType><Attributes>${attributes}</Attributes></SdkMessageProcessingStepImage>`,
    )
    .join('')}</SdkMessageProcessingStepImages></SdkMessageProcessingStep>`;

const flowDefinition = {
  properties: {
    definition: {
      triggers: {
        created: {
          type: 'OpenApiConnectionWebhook',
          inputs: {
            host: { apiId: DV, operationId: 'SubscribeWebhookTrigger' },
            parameters: {
              'subscriptionRequest/message': 1,
              'subscriptionRequest/entityname': 'x_order',
              'subscriptionRequest/scope': 4,
            },
          },
        },
      },
      actions: {
        GetSecret: {
          type: 'OpenApiConnection',
          inputs: {
            host: { apiId: DV, operationId: 'PerformUnboundAction' },
            parameters: {
              actionName: 'RetrieveEnvironmentVariableSecretValue',
              'item/EnvironmentVariableName': 'x_apikey',
            },
          },
        },
        Quote: {
          type: 'OpenApiConnection',
          runAfter: { GetSecret: ['Succeeded'] },
          inputs: {
            host: { apiId: '/providers/Microsoft.PowerApps/apis/x_quotes', operationId: 'Quote' },
            parameters: { name: "@triggerOutputs()?['body/x_name']" },
          },
        },
        Mark: {
          type: 'OpenApiConnection',
          runAfter: { Quote: ['Succeeded'] },
          inputs: {
            host: { apiId: DV, operationId: 'UpdateRecord' },
            parameters: {
              entityName: 'x_orders',
              recordId: "@triggerOutputs()?['body/x_orderid']",
              'item/x_status': "@body('Quote')?['quote']",
            },
          },
        },
      },
    },
  },
};

const portalFiles = {
  'website.yml': 'adx_websiteid: e2e-site\nadx_name: Invented end-to-end portal',
  'Member.webrole.yml': `adx_webroleid: ${ROLE}\nadx_name: Member`,
  'Home.webpage.yml': 'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true',
  'Home.webpage.copy.html': '<p>Invented end-to-end portal</p>',
  'Order.webpage.yml':
    'adx_webpageid: order\nadx_name: Order\nadx_partialurl: order\nadx_parentpageid: home\nadx_pagetemplateid: order',
  'Order.pagetemplate.yml': 'adx_pagetemplateid: order\nadx_name: Order\nadx_webtemplateid: order',
  'Order.webtemplate.yml': 'adx_webtemplateid: order\nadx_name: Order',
  'Order.webtemplate.source.html': "<main>{% include 'Order detail' %}</main>",
  'OrderDetail.webtemplate.yml': 'adx_webtemplateid: order-detail\nadx_name: Order detail',
  'OrderDetail.webtemplate.source.html':
    '{% fetchxml rows %}<fetch><entity name="x_order"><attribute name="x_name"/><attribute name="x_status"/><filter><condition attribute="x_orderid" operator="eq" value="{{ request.params.id }}"/></filter></entity></fetch>{% endfetchxml %}{% for row in rows.results.entities %}<p id="order">{{ row.x_name }}|{{ row.x_status }}</p>{% endfor %}',
  'sitesetting.yml': [
    ['Webapi/x_order/enabled', 'true'],
    ['Webapi/x_order/fields', 'x_name,x_status,x_accesstoken'],
    ['Webapi/x_receipt/enabled', 'true'],
    ['Webapi/x_receipt/fields', 'x_note'],
  ]
    .map(([name, value], index) => `- adx_sitesettingid: s${index}\n  adx_name: ${name}\n  adx_value: "${value}"`)
    .join('\n'),
};
const solutionFiles = {
  'Other/Solution.xml':
    '<ImportExportXml><SolutionManifest><UniqueName>InventedEndToEnd</UniqueName><Version>1.0.0.0</Version></SolutionManifest></ImportExportXml>',
  'PluginAssemblies/Invented.Orders/Invented.Orders.xml': `<PluginAssembly PluginAssemblyId="{${assemblyId}}"><Name>Invented.Orders</Name><Version>1.0.0.0</Version><IsolationMode>2</IsolationMode><SourceType>0</SourceType><PluginTypes><PluginType PluginTypeId="{${typeId}}"><TypeName>Invented.Orders.Rules</TypeName></PluginType></PluginTypes></PluginAssembly>`,
  [`SdkMessageProcessingSteps/${STEP.preValidation}.xml`]: stepXml(STEP.preValidation, 'Order pre-validation', {
    stage: 10,
  }),
  [`SdkMessageProcessingSteps/${STEP.preOperation}.xml`]: stepXml(STEP.preOperation, 'Order pre-operation', {
    stage: 20,
  }),
  // A post-image of two columns only: the step span shows the image by its alias, limited to them.
  [`SdkMessageProcessingSteps/${STEP.postOperation}.xml`]: stepXml(STEP.postOperation, 'Order post-operation', {
    stage: 40,
    images: [{ alias: 'after', type: 1, attributes: 'x_name,x_status' }],
  }),
  [`SdkMessageProcessingSteps/${STEP.audit}.xml`]: stepXml(STEP.audit, 'Audit pre-operation', {
    entity: 'x_audit',
    stage: 20,
  }),
  [`SdkMessageProcessingSteps/${STEP.async}.xml`]: stepXml(STEP.async, 'Order async follow-up', {
    stage: 40,
    mode: 1,
  }),
  'environmentvariabledefinitions/x_apikey/environmentvariabledefinition.xml':
    '<environmentvariabledefinition schemaname="x_apikey"><displayname default="Api key"/><type>100000005</type><secretstore>0</secretstore><defaultvalue>https://inventedvault.vault.azure.net/secrets/x-api-key</defaultvalue></environmentvariabledefinition>',
  'Workflows/OrderCreated.json': JSON.stringify(flowDefinition),
  'Workflows/OrderCreated.json.data.xml': `<Workflow WorkflowId="{${FLOW}}" Name="When an order is created"><StateCode>1</StateCode></Workflow>`,
};

async function write(dir, files) {
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await fs.writeFile(path.join(dir, name), text);
  }
}

// The web hook receiver: answers 200 at once (the delivery runs inside the create's transaction), then writes the receipt
// back through the portal Web API as the member, forwarding the trace headers it received.
async function receiver(closers) {
  const deliveries = [];
  let target = null;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200);
      res.end();
      const { sim, cookie } = target;
      const writeBack = fetch(`${sim.url}/_api/x_receipts(${RECEIPT})`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          cookie,
          __requestverificationtoken: sim.csrf,
          'x-sim-parent-trace': req.headers['x-sim-parent-trace'],
          'x-trace-id': req.headers['x-trace-id'],
        },
        body: JSON.stringify({ x_note: 'Delivered' }),
      }).then(async (response) => ({
        status: response.status,
        text: await response.text(),
        spanId: response.headers.get('x-sim-span-id'),
      }));
      deliveries.push({ url: req.url, headers: req.headers, writeBack });
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  closers.push(() => {
    server.closeAllConnections();
    return new Promise((resolve) => server.close(resolve));
  });
  return {
    deliveries,
    origin: `http://127.0.0.1:${server.address().port}`,
    attach: (sim, cookie) => (target = { sim, cookie }),
  };
}

// A synchronous web hook step on x_order Create PostOperation, registered through the organization tables (as a
// registration tool does through the Dataverse API).
async function registerWebhook(store, url) {
  const messageId = store.tableRows('sdkmessage').find((row) => row.name === 'Create').sdkmessageid;
  const filterId = store
    .tableRows('sdkmessagefilter')
    .find((row) => row.sdkmessageid === messageId && row.primaryobjecttypecode === 'x_order').sdkmessagefilterid;
  const endpointId = id(61);
  await store.create(
    'serviceendpoint',
    {
      serviceendpointid: endpointId,
      name: 'Invented receipt hook',
      url,
      authtype: 4,
      contract: 8,
      authvalue: HOOK_CODE,
    },
    { admin: true },
  );
  await store.create(
    'sdkmessageprocessingstep',
    {
      sdkmessageprocessingstepid: STEP.webhook,
      name: 'Order receipt web hook',
      sdkmessageid: messageId,
      sdkmessagefilterid: filterId,
      eventhandler: { id: endpointId, logical_name: 'serviceendpoint' },
      stage: 40,
      mode: 0,
      rank: 2,
      statecode: 0,
      supporteddeployment: 0,
    },
    { admin: true },
  );
}

/** Resolves with the tree of `traceId` once no span of it runs (its trace-end event, or at once when it ended). */
export function endedTree(trace, traceId) {
  return new Promise((resolve) => {
    let off = () => {};
    const check = () => {
      const tree = trace.tree(traceId);
      if (!tree?.trace.ended) return;
      off();
      resolve(tree);
    };
    off = trace.subscribe((event) => {
      if (event.type === 'trace-end' && event.span.traceId === traceId) check();
    });
    check();
  });
}

/** The tree as indented `kind name [status, durationMs]` lines. */
export function treeLines(tree) {
  const lines = [];
  const walk = (node, depth) => {
    lines.push(`${'  '.repeat(depth)}${node.kind} ${node.name} [${node.status}, ${node.durationMs}]`);
    for (const child of node.children) walk(child, depth + 1);
  };
  for (const node of tree.children) walk(node, 0);
  return lines;
}

/** The causal shape of a tree: `kind name` with its children in name order (independent of timing and job order). */
export function skeleton(nodes) {
  return nodes
    .map((node) => [`${node.kind} ${node.name}`, skeleton(node.children)])
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

const orderIdPattern = /[0-9a-f-]{36}/;

/**
 * Starts the host and drives the scenario once. Returns { sim, traceId, rootSpanId, orderId, member, stranger, hook,
 * handled, create(body, headers) , close() }; create posts another order as the member and resolves once its write-back
 * and its jobs ran (for a run at another trace level).
 */
export async function runTraceScenario({ level = 'full' } = {}) {
  const closers = [],
    removers = [];
  const close = async () => {
    await drainFixture(closers.reverse());
    await drainFixture(removers);
  };
  try {
    const root = await makeTemporaryDirectory(path.join(os.tmpdir(), 'trace-e2e-'));
    removers.push(() => fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
    await write(path.join(root, 'portal'), portalFiles);
    await write(path.join(root, 'solution'), solutionFiles);
    const hook = await receiver(closers);
    let sdk = null;
    const handled = [];
    const pack = {
      id: 'invented-trace-e2e',
      name: 'Invented end-to-end tracing',
      description: 'Invented plug-in handlers, flow identity and connector',
      matches: () => true,
      presets: () => ({}),
      pluginSteps: {
        // An order named with REJECTED is refused (an InvalidPluginExecutionException in the platform).
        [STEP.preValidation]: ({ target, trace, reject }) => {
          if (String(target.x_name).includes(REJECTED)) return reject(`Order name ${REJECTED} is refused`);
          trace('Pre-validation checked ' + target.x_name);
          handled.push('pre-validation');
        },
        // A shared variable set here reaches the PostOperation step of the same pipeline.
        [STEP.preOperation]: ({ trace, sharedVariables }) => {
          sharedVariables.x_stamp = 'pre-operation';
          trace('Pre-operation stamps the status');
          handled.push('pre-operation');
          return { target: { x_status: 'new' } };
        },
        [STEP.postOperation]: ({ record, trace }) => {
          trace('Post-operation writes the audit row');
          handled.push('post-operation');
          sdk.create('x_audit', { x_name: 'Audit of ' + record.x_name });
        },
        [STEP.audit]: ({ trace }) => {
          trace('Audit pre-operation ran');
          handled.push('audit');
        },
        [STEP.async]: ({ trace }) => {
          trace('Async follow-up ran');
          handled.push('async');
        },
      },
      flowIdentities: {
        [FLOW]: {
          userId: FLOW_USER,
          evidence: 'Invented flow owner',
          grants: [
            { entity: 'x_order', operations: ['read', 'update'] },
            { entity: 'environmentvariabledefinition', operations: ['read'] },
            { entity: 'environmentvariablevalue', operations: ['read'] },
            { message: 'RetrieveEnvironmentVariableSecretValue', operations: ['execute'] },
          ],
        },
      },
      connectors: {
        x_quotes: {
          operations: {
            Quote: (request) => ({ statusCode: 200, body: { quote: 'quoted ' + request.parameters?.name } }),
          },
        },
      },
    };
    // The environment-variable secret source reads process.env at resolve time.
    const previous = process.env[SECRET_VARIABLE];
    process.env[SECRET_VARIABLE] = SECRET_VALUE;
    closers.push(() => {
      if (previous === undefined) delete process.env[SECRET_VARIABLE];
      else process.env[SECRET_VARIABLE] = previous;
    });
    const sim = await createSimulator({
      sourceDir: path.join(root, 'portal'),
      solutionRoots: [path.join(root, 'solution')],
      projectRoot: root,
      stateFile: path.join(root, 'state.json'),
      port: 0,
      watch: false,
      packs: [pack],
      dataverse: { enabled: true, tls: false, tds: { enabled: false } },
      secrets: { 'inventedvault/x-api-key': { source: 'environment', variable: SECRET_VARIABLE, allow: [FLOW_USER] } },
      trace: { level },
      initial: {
        version: 1,
        mappings: {
          x_order: { entitySet: 'x_orders', idColumn: 'x_orderid', nameColumn: 'x_name' },
          x_audit: { entitySet: 'x_audits', idColumn: 'x_auditid', nameColumn: 'x_name' },
          x_receipt: { entitySet: 'x_receipts', idColumn: 'x_receiptid', nameColumn: 'x_note' },
        },
        tables: {
          x_order: [],
          x_audit: [],
          x_receipt: [{ x_receiptid: RECEIPT, x_note: 'Pending' }],
          contact: [
            { contactid: MEMBER, firstname: 'Ada', lastname: 'Member', statecode: 0 },
            { contactid: STRANGER, firstname: 'Bo', lastname: 'Stranger', statecode: 0 },
          ],
          systemuser: [
            {
              systemuserid: FLOW_USER,
              fullname: 'Invented flow owner',
              domainname: 'flow@example.test',
              isdisabled: false,
            },
            {
              systemuserid: SDK_USER,
              fullname: 'Invented plug-in user',
              domainname: 'sdk@example.test',
              isdisabled: false,
            },
          ],
        },
        permissions: [
          {
            id: 'orders',
            entity: 'x_order',
            scope: 'global',
            operations: ['create', 'read', 'update'],
            roles: ['Member'],
          },
          { id: 'receipts', entity: 'x_receipt', scope: 'global', operations: ['read', 'update'], roles: ['Member'] },
        ],
        plugins: [],
        settings: { permissionMode: 'enforce' },
        simulator: { mode: 'local', pageMode: 'local', live: { allowWrites: false }, endpoints: [] },
      },
    });
    closers.push(() => sim.close());
    // The flow owner holds System Administrator: RetrieveEnvironmentVariableSecretValue checks its Dataverse privileges.
    const administrator = sim.store.tableRows('role').find((row) => row.name === 'System Administrator').roleid;
    await sim.store.transact(() => {
      (sim.store.state.tables.systemuserroles ??= []).push({
        systemuserroleid: id(24),
        systemuserid: { id: FLOW_USER },
        roleid: { id: administrator },
      });
    });
    // The PostOperation handler's SDK service (a plug-in's IOrganizationService) as its own application user.
    sdk = localOrganizationService(sim.store, {
      userId: SDK_USER,
      evidence: 'Invented plug-in service profile',
      grants: [{ entity: 'x_audit', operations: ['create', 'read'] }],
    });
    await registerWebhook(sim.store, hook.origin + '/hooks/receipt');
    const member = sim.signIn(MEMBER, { roles: ['Member'] }).cookieHeader;
    const stranger = sim.signIn(STRANGER).cookieHeader;
    hook.attach(sim, member);

    const create = async (body) => {
      const seen = hook.deliveries.length;
      const response = await fetch(sim.url + '/_api/x_orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json', cookie: member, __requestverificationtoken: sim.csrf },
        body: JSON.stringify(body),
      });
      const text = await response.text();
      if (response.status !== 204) throw new Error(`The create answered ${response.status}: ${text}`);
      if (hook.deliveries.length !== seen + 1) throw new Error('The web hook was not delivered once.');
      const writeBack = await hook.deliveries.at(-1).writeBack;
      if (writeBack.status !== 204) throw new Error(`The write-back answered ${writeBack.status}: ${writeBack.text}`);
      await sim.settle();
      return {
        traceId: response.headers.get('x-trace-id'),
        rootSpanId: response.headers.get('x-sim-span-id'),
        orderId: orderIdPattern.exec(response.headers.get('odata-entityid') ?? '')?.[0] ?? null,
        writeBack,
      };
    };
    const first = await create({ x_name: 'Order one', x_accesstoken: ACCESS_TOKEN });
    const orderId = first.orderId ?? sim.store.tableRows('x_order')[0].x_orderid;
    const join = { 'x-sim-parent-trace': first.rootSpanId, 'x-trace-id': first.traceId };
    const page = await fetch(`${sim.url}/order/?id=${orderId}`, { headers: { cookie: member, ...join } });
    const pageHtml = await page.text();
    const denied = await fetch(`${sim.url}/_api/x_orders(${orderId})`, { headers: { cookie: stranger, ...join } });
    const deniedBody = await denied.json();
    const tree = await endedTree(sim.trace, first.traceId);
    return {
      sim,
      hook,
      handled,
      member,
      stranger,
      ...first,
      orderId,
      page: { status: page.status, html: pageHtml, spanId: page.headers.get('x-sim-span-id') },
      denied: { status: denied.status, body: deniedBody, spanId: denied.headers.get('x-sim-span-id') },
      tree,
      create,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
