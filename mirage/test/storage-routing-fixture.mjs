// A loopback Dataverse API over an invented fx_widget table (file column fx_doc, full-size image fx_photo), with the storage
// routing extension installed right after dataverse-files, with a local-disk storage router or without one. Invented schema only.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DataStore, emptyState } from "../lib/data.mjs";
import { dataverseSettings } from "../lib/dataverse-settings.mjs";
import { startDataverseApi } from "../lib/dataverse-api.mjs";
import { EXTENSIONS } from "../lib/dataverse-extensions.mjs";
import { EXTENSION as routing } from "../lib/dataverse-storage-routing.mjs";
import { createStorageRouter } from "../lib/storage-provider.mjs";
import { createLocalDiskStorage } from "../lib/storage-local-disk.mjs";

export const APP_ID = "77777777-7777-4777-8777-7777777777b1";
export const WIDGET = "77777777-7777-4777-8777-7777777777b2";
const SECRET_VAR = "PAQVILO_STORAGE_ROUTING_FIXTURE_SECRET";
export const MODES = [{ label: "with a storage router", storage: true }, { label: "without a storage router", storage: false }];
export const b64 = (value) => Buffer.from(value).toString("base64");
export const widgetRef = { "@odata.type": "Microsoft.Dynamics.CRM.fx_widget", fx_widgetid: WIDGET };

export function widgetState() {
  const state = emptyState();
  state.mappings.fx_widget = {
    logicalName: "fx_widget", entitySet: "fx_widgets", idColumn: "fx_widgetid", nameColumn: "fx_name", userConfigured: true, relationships: {},
    fields: {
      fx_name: { dataverseType: "nvarchar" },
      fx_doc: { dataverseType: "file", MaxSizeInKB: 131072 },
      fx_photo: { dataverseType: "image", canStoreFullImage: true },
    },
  };
  state.tables.fx_widget = [{ fx_widgetid: WIDGET, fx_name: "Invented widget" }];
  return state;
}

/** Extensions with the routing module right after dataverse-files, installed with `storage` (a router or null). */
export function routedExtensions(storage, diagnostics = []) {
  const list = [];
  for (const extension of EXTENSIONS) {
    if (extension.name === routing.name) continue;
    list.push(extension);
    if (extension.name === "dataverse-files") list.push({ ...routing, install: (api) => routing.install(api, { storage, diagnostic: (d) => diagnostics.push(d) }) });
  }
  return list;
}

export async function tempRoot(t, prefix = "storage-routing-") {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

/** A local-disk router. `routes` may send a route to "gone", a declared pack provider that was never created. */
export function localRouter(root, routes) {
  const provider = createLocalDiskStorage({ root: path.join(root, "blobs") });
  const config = routes ? { storage: { gone: { kind: "pack:fx-pack/missing" } }, routes } : undefined;
  return { provider, router: createStorageRouter({ config, providers: { local: provider } }) };
}

/** Starts the API. `file` persists the store; `state` seeds it (ignored when the file exists). */
export async function routingApi(t, { storage = true, routes, root, file, state, before = () => {} } = {}) {
  root ??= await tempRoot(t);
  process.env[SECRET_VAR] = "storage-routing-fixture-secret";
  const { provider, router } = storage ? localRouter(root, routes) : { provider: null, router: null };
  const diagnostics = [];
  const store = await new DataStore({ file: file ?? null, state: state ?? widgetState() }).init();
  await before(store);
  const settings = dataverseSettings({
    enabled: true, applications: [{ appId: APP_ID, displayName: "Invented storage app", secretEnvironmentVariable: SECRET_VAR, roles: ["System Administrator"] }],
  });
  const server = await startDataverseApi({ store, settings, log: () => {}, extensions: routedExtensions(router, diagnostics) });
  let closed = false;
  const close = async () => { if (!closed) { closed = true; await server.close(); await provider?.close(); } };
  t.after(close);
  const token = await fetch(`${server.origin}/${server.tenantId}/oauth2/v2.0/token`, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "client_credentials", client_id: APP_ID, client_secret: process.env[SECRET_VAR], scope: `${server.origin}/.default` }),
  });
  const authorization = `Bearer ${(await token.json()).access_token}`;
  // fetch against the Web API; JSON bodies are serialised, Buffers sent raw.
  const call = async (method, suffix, body, headers = {}) => {
    const raw = Buffer.isBuffer(body);
    const response = await fetch(`${server.origin}/api/data/v9.2/${suffix}`, {
      method, signal: AbortSignal.timeout(20000),
      headers: { authorization, ...(body !== undefined && !raw ? { "content-type": "application/json" } : {}), ...headers },
      ...(body !== undefined ? { body: raw ? body : JSON.stringify(body) } : {}),
    });
    const buffer = Buffer.from(await response.arrayBuffer());
    const type = response.headers.get("content-type") ?? "";
    return { status: response.status, headers: response.headers, buffer, json: type.includes("json") && buffer.length ? JSON.parse(buffer) : null };
  };
  const settle = async () => { await store.flushCommittedEvents?.(); await server.organization.api.storageRouting?.settle(); await store.flushCommittedEvents?.(); };
  const blobKeys = async () => (provider ? (await provider.list("", { pageSize: 5000 })).items.map((item) => item.key) : []);
  return { server, api: server.organization.api, store, root, provider, router, diagnostics, call, settle, blobKeys, close };
}
