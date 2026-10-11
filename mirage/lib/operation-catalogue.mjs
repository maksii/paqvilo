import { DataError } from './data.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { readLocalFile } from '../../lense/local-file.mjs';
import { createHash } from 'node:crypto';
import { parseSolutionXml, child, childText, descendants } from './solution-xml.mjs';
import {inspectFlowDefinition,inspectFlowTrigger} from './flow-runtime.mjs';

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
      const xmlSource = await readLocalFile(file, { root, maxBytes: 1024 * 1024, encoding: 'utf8' });
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

export function flowContract(workflow,steps={}) {
  const definition = definitionOf(workflow);
  const triggers = Object.values(definition?.triggers ?? {});
  const actions = Object.values(definition?.actions ?? {});
  const contract=inspectFlowDefinition(definition,steps),trigger=inspectFlowTrigger(definition);
  return {
    ...contract,trigger,activation:workflow?.activation??null,supported:trigger.supported&&contract.supported&&(trigger.kind!=='dataverse'||workflow?.active===true),
    inputSchema: triggers.find(trigger => trigger.type === 'Request')?.inputs?.schema ?? null,
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
    const contract = kind === 'cloud-flow' ? flowContract(workflow,overrides[key]?.steps) : null;
    const mode = overrides[key]?.mode ?? (registered ? 'handler' : contract?.supported && (record.path||contract.trigger.kind==='dataverse'&&handlers?.flowIdentities?.has(record.processId)) ? 'exported' : 'placeholder');
    items.push({
      key, kind, name: record.name, id: record.id ?? null, processId: record.processId ?? null,
      path: kind === 'server-logic' ? `/_api/serverlogics/${encodeURIComponent(record.name)}` : record.path ?? null,
      roleIds: record.roleIds ?? [], sourceFile: record.file ?? workflow?.file ?? record.metadataFile ?? null,
      definitionAvailable: Boolean(kind === 'server-logic' ? record.file : workflow?.file),
      registered, mode, configurable: Boolean(kind === 'server-logic' || record.path || workflow?.file),
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

const mockMap=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const mockName=value=>typeof value==='string'&&/^[a-z][a-z0-9_]*$/i.test(value);
const mockGuid=value=>typeof value==='string'&&/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(value);
const mockKeys=(value,keys)=>mockMap(value)&&Object.keys(value).every(key=>keys.includes(key));
function validatePluginMockBody(body,step){
  if(!mockKeys(body,['target','targets','query','collection','entityResult','error']))fail('Plugin mock body must contain supported field/query results or an error.');
  const values=(value,depth=0)=>{if(depth>64)fail('Plugin mock values exceed local nesting bounds.');if(!value||typeof value!=='object')return;if(value.$type==='Double'&&(!mockKeys(value,['$type','value'])||!['string','number'].includes(typeof value.value)||!/^[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?$/.test(String(value.value))||!Number.isFinite(Number(value.value))))fail('Plugin mock Double values must be finite invariant numbers.');Object.values(value).forEach(child=>values(child,depth+1));};values(body);
  const entity=value=>{
    if(!mockKeys(value,['$type','logicalName','id','attributes','formattedValues'])||value.$type!=='Entity'||!mockName(value.logicalName)||!mockGuid(value.id)||!mockMap(value.attributes)||Object.keys(value.attributes).some(key=>!mockName(key))||value.formattedValues!==undefined&&(!mockMap(value.formattedValues)||Object.values(value.formattedValues).some(item=>typeof item!=='string'))||step?.entity&&value.logicalName!==step.entity)fail('Plugin mock entities require typed, source-bound identities and attribute maps.');
  };
  if(body.target!==undefined&&(!mockMap(body.target)||Object.keys(body.target).some(key=>!mockName(key))))fail('Plugin mock target must be a logical field map.');
  if(body.error!==undefined&&(!mockKeys(body.error,['message'])||typeof body.error.message!=='string'))fail('Plugin mock error needs a message.');
  if(body.entityResult!==undefined)entity(body.entityResult);
  if(body.targets!==undefined){if(!Array.isArray(body.targets)||!body.targets.length||body.targets.length>1000)fail('Plugin mock targets require 1-1000 typed entities.');body.targets.forEach(entity);}
  if(body.collection!==undefined){const value=body.collection;if(!mockKeys(value,['$type','entities','moreRecords','totalRecordCount','pagingCookie','entityName','minActiveRowVersion','totalRecordCountLimitExceeded'])||value.$type!=='EntityCollection'||!Array.isArray(value.entities)||value.entities.length>1000||typeof value.moreRecords!=='boolean'||!Number.isInteger(value.totalRecordCount)||value.totalRecordCount< -1||value.pagingCookie!==null&&typeof value.pagingCookie!=='string'||value.entityName!==undefined&&value.entityName!==null&&typeof value.entityName!=='string'||value.minActiveRowVersion!==undefined&&value.minActiveRowVersion!==null&&typeof value.minActiveRowVersion!=='string'||value.totalRecordCountLimitExceeded!==undefined&&typeof value.totalRecordCountLimitExceeded!=='boolean')fail('Plugin mock collection must be a typed EntityCollection.');value.entities.forEach(entity);}
  if(body.query!==undefined){
    const value=body.query;
    if(!mockMap(value)||!['FetchExpression','QueryExpression','QueryByAttribute'].includes(value.$type))fail('Plugin mock query must retain a supported SDK query type.');
    if(value.$type==='FetchExpression'){if(!mockKeys(value,['$type','query'])||typeof value.query!=='string'||!value.query.trim())fail('Plugin mock FetchExpression requires query text.');if(step?.entity){let root;try{root=parseSolutionXml(value.query);}catch{fail('Plugin mock FetchExpression requires valid XML.');}if(root?.name!=='fetch'||child(root,'entity')?.attrs?.name!==step.entity)fail('Plugin mock FetchExpression must match its source table.');}}
    else {
      const keys=value.$type==='QueryExpression'?['$type','entityName','columnSet','criteria','linkEntities','orders','topCount','distinct','pageInfo']:['$type','entityName','columnSet','attributes','values','orders','topCount','pageInfo'];
      if(!mockKeys(value,keys)||!mockName(value.entityName)||step?.entity&&value.entityName!==step.entity||value.topCount!==undefined&&value.topCount!==null&&(!Number.isInteger(value.topCount)||value.topCount<0)||value.distinct!==undefined&&typeof value.distinct!=='boolean')fail('Plugin mock query metadata must match its source table.');
      const columns=value=>{if(!mockKeys(value,['allColumns','columns'])||typeof value.allColumns!=='boolean'||!Array.isArray(value.columns)||value.columns.some(name=>!mockName(name)))fail('Plugin mock query needs typed column selection.');};
      const orders=value=>{if(value!==undefined&&(!Array.isArray(value)||value.some(order=>!mockKeys(order,['attributeName','descending'])||!mockName(order.attributeName)||typeof order.descending!=='boolean')))fail('Plugin mock query orders are invalid.');};
      const filter=(value,depth=0)=>{if(depth>16||!mockKeys(value,['operatorName','conditions','filters'])||!['And','Or'].includes(value.operatorName)||!Array.isArray(value.conditions)||!Array.isArray(value.filters)||value.conditions.some(condition=>!mockKeys(condition,['attributeName','entityName','operatorName','values'])||!mockName(condition.attributeName)||condition.entityName!==undefined&&condition.entityName!==null&&!mockName(condition.entityName)||typeof condition.operatorName!=='string'||!Array.isArray(condition.values)))fail('Plugin mock query filters are invalid.');value.filters.forEach(child=>filter(child,depth+1));};
      const links=(values,parent,depth=0)=>{if(depth>16||!Array.isArray(values)||values.length>100)fail('Plugin mock links exceed local bounds.');for(const link of values){if(!mockKeys(link,['$type','linkFromEntityName','linkToEntityName','linkFromAttributeName','linkToAttributeName','joinOperator','entityAlias','columns','linkCriteria','orders','linkEntities'])||link.$type!=='LinkEntity'||link.linkFromEntityName!==parent||!mockName(link.linkToEntityName)||!mockName(link.linkFromAttributeName)||!mockName(link.linkToAttributeName)||typeof link.joinOperator!=='string'||link.entityAlias!==undefined&&link.entityAlias!==null&&!mockName(link.entityAlias))fail('Plugin mock link metadata is invalid.');columns(link.columns);filter(link.linkCriteria);orders(link.orders);links(link.linkEntities??[],link.linkToEntityName,depth+1);}};
      columns(value.columnSet);orders(value.orders);
      if(value.pageInfo!==undefined&&(!mockKeys(value.pageInfo,['count','pageNumber','pagingCookie'])||!Number.isInteger(value.pageInfo.count)||value.pageInfo.count<0||!Number.isInteger(value.pageInfo.pageNumber)||value.pageInfo.pageNumber<0||value.pageInfo.pagingCookie!==null&&typeof value.pageInfo.pagingCookie!=='string'))fail('Plugin mock paging metadata is invalid.');
      if(value.$type==='QueryExpression'){filter(value.criteria);links(value.linkEntities??[],value.entityName);}
      else if(!Array.isArray(value.attributes)||value.attributes.some(name=>!mockName(name))||!Array.isArray(value.values)||value.values.length!==value.attributes.length)fail('Plugin mock QueryByAttribute needs aligned attributes and values.');
    }
  }
  if(step){
    const operation=String(step.message??'').toLowerCase(),pre=[10,20].includes(step.stage);
    const allowed=['error',...(['create','update'].includes(operation)&&pre?['target']:['createmultiple','updatemultiple'].includes(operation)&&pre?['targets']:operation==='retrievemultiple'?step.stage===20?['query']:step.stage===40?['collection']:[]:operation==='retrieve'&&step.stage===40?['entityResult']:[])];
    if(Object.keys(body).some(key=>!allowed.includes(key)))fail('Plugin mock results do not match this source message/stage.');
  }
}

export function validateOperationOverrides(overrides,{pluginStep}={}) {
  if (overrides === undefined) return;
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) fail('operations must map discovered operation keys to local configurations.');
  if (Object.keys(overrides).length > 1000) fail('Too many local operation configurations.');
  for (const [key, value] of Object.entries(overrides)) {
    if (!/^(server-logic|cloud-flow|plugin-step):[^\s]{1,250}$/.test(key)) fail('Invalid operation key.');
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('An operation configuration must be an object.');
    if (!['placeholder', 'mock', 'exported', 'handler','disabled','clr'].includes(value.mode)) fail('Operation mode must be placeholder, mock, exported, handler, disabled or clr.');
    if(value.mode==='clr'&&!key.startsWith('plugin-step:'))fail('CLR mode applies only to plugin steps.');
    if (key.startsWith('plugin-step:') && value.mode === 'exported') fail('Plugin steps do not use exported mode. Select clr for an explicitly trusted original .NET assembly, handler for a trusted project model, mock, or disabled.');
    if (Object.keys(value).some(name => !['mode', 'status', 'body','steps','activation'].includes(name))) fail('Unknown operation configuration field.');
    if(value.activation!==undefined&&(!key.startsWith('cloud-flow:')||value.activation!=='local-enabled'))fail('Explicit local activation applies only to imported cloud flows.');
    if(value.steps!==undefined){if(!key.startsWith('cloud-flow:')||!value.steps||typeof value.steps!=='object'||Array.isArray(value.steps)||Object.keys(value.steps).length>250)fail('Flow steps must map exact action paths to at most 250 choices.');for(const[action,choice]of Object.entries(value.steps)){if(!action||action.length>1000||!choice||typeof choice!=='object'||Array.isArray(choice)||!['exported','mock','disabled'].includes(choice.mode)||Object.keys(choice).some(k=>!['mode','status','outputs'].includes(k))||choice.status!==undefined&&!['Succeeded','Failed','Skipped','TimedOut'].includes(choice.status))fail('Invalid flow action configuration.');}}
    if (value.status !== undefined && (!Number.isInteger(value.status) || value.status < 200 || value.status > 599)) fail('Operation response status must be an integer from 200 to 599.');
    if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) fail('Operation configuration exceeds 1 MiB.');
    if (key.startsWith('plugin-step:') && value.body !== undefined) validatePluginMockBody(value.body,value.mode==='mock'?pluginStep:undefined);
  }
}

export function operationPlaceholder(item) {
  throw new DataError(`Configure a local response or handler for ${item.name} in Mirage Operations. This source is discovered but has no active simulation.`, 501, 'LocalOperationPlaceholder');
}
