import { DataError } from './data.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { parseSolutionXml, child, childText, descendants } from './solution-xml.mjs';

const canonical = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
const fail = message => { throw new DataError(message, 400, 'InvalidOperationConfiguration'); };
const definitionOf = workflow => workflow?.definition?.properties?.definition ?? workflow?.definition?.definition;

/** Selected enhanced solution components belonging to this exact exported website only. */
export async function importSolutionOperationSources(layers, website) {
  const result = { serverLogics: [], cloudFlows: [] };
  const websiteId = canonical(website?.id ?? website?.adx_websiteid);
  if (!websiteId) return result;
  const inside = (root, file) => { const relative = path.relative(root, file); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };
  for (const layer of layers ?? []) {
    if (!layer.dir) continue;
    const layerRoot = await fs.realpath(layer.dir);
    const root = await fs.realpath(path.join(layerRoot, 'powerpagecomponents')).catch(() => null);
    if (!root || !inside(layerRoot, root)) continue;
    for (const entry of await fs.readdir(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
      const file = await fs.realpath(path.join(root, entry.name, 'powerpagecomponent.xml')).catch(() => null);
      if (!file || !inside(root, file) || (await fs.stat(file)).size > 1024 * 1024) continue;
      const xmlSource = await fs.readFile(file, 'utf8');
      const xml = parseSolutionXml(xmlSource);
      const type = Number(childText(xml, 'powerpagecomponenttype'));
      if (![33, 35].includes(type) || Number(childText(xml, 'statecode') ?? 0) !== 0) continue;
      const site = child(xml, 'powerpagesiteid');
      if (canonical(site?.text.trim() || descendants(site, 'powerpagesiteid')[0]?.text) !== websiteId) continue;
      const content = JSON.parse(childText(xml, 'content') || '{}');
      const field = name => content[Object.keys(content).find(key => key.toLowerCase() === name.toLowerCase())];
      const roleIds = value => (Array.isArray(value) ? value : []).map(canonical);
      const record = { id: canonical(xml.attrs.powerpagecomponentid), name: childText(xml, 'name') ?? '', metadataFile: file };
      if (!record.name || !record.id) continue;
      if (type === 35) {
        const filename = childText(xml, 'filecontent');
        const code = filename && path.basename(filename) === filename ? await fs.realpath(path.join(path.dirname(file), 'filecontent', filename)).catch(() => null) : null;
        const codeFile = code && inside(path.dirname(file), code) && (await fs.stat(code)).size <= 1024 * 1024 ? code : null;
        result.serverLogics.push({ ...record, file: codeFile, fingerprint: createHash('sha256').update(xmlSource).update(codeFile ? await fs.readFile(codeFile) : '').digest('hex'), roleIds: roleIds(field('adx_serverlogic_adx_webrole')) });
      } else {
        let route = null;
        try {
          const url = new URL(String(field('flowapiurl') ?? ''), 'http://local.invalid');
          if (url.origin === 'http://local.invalid' && /^\/_api\/cloudflow\/v1\.0\/trigger\/[^/]+\/?$/.test(url.pathname)) route = url.pathname;
        } catch {}
        result.cloudFlows.push({ ...record, path: route, processId: canonical(field('processid')) || null, roleIds: roleIds(field('adx_cloudflowconsumer_adx_webrole')) });
      }
    }
  }
  return result;
}

/** Source portal records win over same-id solution copies; distinct operations stay distinct. */
export function withSolutionOperations(portal, supplementary) {
  const merge = kind => [...new Map([...(supplementary?.[kind] ?? []), ...(portal[kind] ?? [])].map(record => [canonical(record.id), record])).values()];
  return { ...portal, serverLogics: merge('serverLogics'), cloudFlows: merge('cloudFlows') };
}

export function flowContract(workflow) {
  const definition = definitionOf(workflow);
  const triggers = Object.values(definition?.triggers ?? {});
  const actions = Object.values(definition?.actions ?? {});
  return {
    supported: triggers.length === 1 && triggers[0].type === 'Request' && triggers[0].kind === 'powerpages' && actions.length === 1 && actions[0].type === 'Response' && actions[0].kind === 'powerpages',
    inputSchema: triggers.find(trigger => trigger.type === 'Request')?.inputs?.schema ?? null,
    actions: Object.entries(definition?.actions ?? {}).map(([name, action]) => ({ name, type: action.type, kind: action.kind ?? null })),
  };
}

/** Source discovery is automatic; executable project JavaScript still requires an explicit choice. */
export function operationCatalogue({ portal, workflows = new Map(), handlers, overrides = {} }) {
  const items = [];
  const keys = new Set();
  const names = new Set();
  const add = (kind, record, workflow) => {
    const key = `${kind}:${canonical(record.id ?? record.processId ?? record.name)}`;
    if (keys.has(key)) throw new DataError(`Ambiguous operation identifier: ${key}`, 409, 'AmbiguousOperation');
    keys.add(key);
    const nameKey = `${kind}:${record.name.toLowerCase()}`;
    if (names.has(nameKey)) throw new DataError(`Ambiguous operation name: ${record.name}`, 409, 'AmbiguousOperation');
    names.add(nameKey);
    const registered = handlers?.[kind === 'server-logic' ? 'serverLogics' : 'cloudFlows']?.has(record.name.toLowerCase()) ?? false;
    const contract = kind === 'cloud-flow' ? flowContract(workflow) : null;
    const mode = overrides[key]?.mode ?? (registered ? 'handler' : contract?.supported && record.path ? 'exported' : 'placeholder');
    items.push({
      key, kind, name: record.name, id: record.id ?? null, processId: record.processId ?? null,
      path: kind === 'server-logic' ? `/_api/serverlogics/${encodeURIComponent(record.name)}` : record.path ?? null,
      roleIds: record.roleIds ?? [], sourceFile: record.file ?? workflow?.file ?? record.metadataFile ?? null,
      definitionAvailable: Boolean(kind === 'server-logic' ? record.file : workflow?.file),
      registered, mode, configurable: Boolean(kind === 'server-logic' || record.path),
      ...(contract ? { contract } : {}),
      configuration: overrides[key] ?? null,
    });
  };
  for (const record of portal.serverLogics ?? []) add('server-logic', record);
  const linked = new Set();
  for (const record of portal.cloudFlows ?? []) {
    linked.add(canonical(record.processId));
    add('cloud-flow', record, workflows.get(canonical(record.processId)));
  }
  for (const [processId, workflow] of workflows) {
    if (linked.has(processId)) continue;
    add('cloud-flow', { id: processId, processId, name: workflow.name ?? processId, roleIds: [], path: null }, workflow);
  }
  return items;
}

export function validateOperationOverrides(overrides) {
  if (overrides === undefined) return;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) fail('operations must map discovered operation keys to local configurations.');
  if (Object.keys(overrides).length > 1000) fail('Too many local operation configurations.');
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^(server-logic|cloud-flow|plugin-step):[^\s]{1,250}$/.test(key)) fail('Invalid operation key.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('An operation configuration must be an object.');
    if (!['placeholder', 'mock', 'exported', 'handler'].includes(value.mode)) fail('Operation mode must be placeholder, mock, exported or handler.');
    if (key.startsWith('plugin-step:') && value.mode === 'exported') fail('Compiled .NET plugin execution is not supported locally.');
    if (Object.keys(value).some(name => !['mode', 'status', 'body'].includes(name))) fail('Unknown operation configuration field.');
    if (value.status !== undefined && (!Number.isInteger(value.status) || value.status < 200 || value.status > 599)) fail('Operation response status must be an integer from 200 to 599.');
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail('Operation configuration exceeds 1 MiB.');
    if (key.startsWith('plugin-step:') && value.body !== undefined) {
      if (!value.body || typeof value.body !== 'object' || Array.isArray(value.body) || Object.keys(value.body).some(name => !['target', 'error'].includes(name))) fail('Plugin mock body must contain target field changes or an error.');
      if (value.body.target !== undefined && (!value.body.target || typeof value.body.target !== 'object' || Array.isArray(value.body.target))) fail('Plugin mock target must be a field map.');
      if (value.body.error !== undefined && (!value.body.error || typeof value.body.error !== 'object' || typeof value.body.error.message !== 'string')) fail('Plugin mock error needs a message.');
    }
  }
}

export function operationPlaceholder(item) {
  throw new DataError(`Configure a local response or handler for ${item.name} in Mirage Operations. This source is discovered but has no active simulation.`, 501, 'LocalOperationPlaceholder');
}
