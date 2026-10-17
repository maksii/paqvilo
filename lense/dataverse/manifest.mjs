import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest('hex');
export const label = (text, language) => ({ LocalizedLabels: [{ Label: text, LanguageCode: language }] });
const TYPES = new Set(['string', 'memo', 'integer', 'decimal', 'double', 'money', 'boolean', 'datetime', 'choice', 'multichoice']);
const required = value => ({ Value: ({ none: 'None', recommended: 'Recommended', required: 'ApplicationRequired' })[value ?? 'none'], CanBeChanged: true, ManagedPropertyLogicalName: 'canmodifyrequirementlevelsettings' });
const managed = Value => ({ Value, CanBeChanged: true });
function ensure(value, message) { if (!value) throw new Error(`Manifest: ${message}`); }
function identifier(name) { ensure(typeof name === 'string' && /^[a-z][a-z0-9_]{0,99}$/i.test(name), `invalid identifier ${String(name)}`); }
function unique(items, key, kind) {
  const seen = new Set();
  for (const item of items) { const value = key(item).toLowerCase(); ensure(!seen.has(value), `duplicate ${kind} ${value}`); seen.add(value); }
}

export function validateManifest(input) {
  const manifest = structuredClone(input);
  ensure(manifest.schemaVersion === 1, 'schemaVersion must be 1');
  ensure(manifest.publisher && Array.isArray(manifest.solutions) && manifest.solutions.length, 'publisher and solutions required');
  identifier(manifest.publisher.uniqueName); identifier(manifest.publisher.prefix);
  ensure(/^[a-z][a-z0-9]{1,7}$/.test(manifest.publisher.prefix), 'publisher prefix must contain 2..8 lowercase letters/digits');
  ensure(Number.isInteger(manifest.publisher.optionValuePrefix) && manifest.publisher.optionValuePrefix >= 10000 && manifest.publisher.optionValuePrefix <= 99999, 'optionValuePrefix must be 10000..99999');
  ensure(manifest.publisher.friendlyName, 'publisher friendlyName required');
  manifest.language ??= 1033;
  ensure(Number.isInteger(manifest.language) && manifest.language > 0, 'language must be an LCID');
  for (const key of ['choices', 'tables', 'relationships', 'forms', 'views']) { manifest[key] ??= []; ensure(Array.isArray(manifest[key]), `${key} must be an array`); }
  unique(manifest.solutions, s => s.uniqueName, 'solution');
  const solutionNames = new Set(manifest.solutions.map(s => s.uniqueName));
  const earlier = new Set();
  for (const solution of manifest.solutions) {
    identifier(solution.uniqueName); ensure(solution.friendlyName && /^\d+\.\d+\.\d+\.\d+$/.test(solution.version), 'solution needs friendlyName and four-part version');
    for (const dependency of solution.dependsOn ?? []) ensure(earlier.has(dependency), 'solutions must be listed in dependency order');
    earlier.add(solution.uniqueName);
  }
  const customName = name => { identifier(name); ensure(name.toLowerCase().startsWith(manifest.publisher.prefix+'_'), `${name} must use publisher prefix`); };
  const component = item => { ensure(solutionNames.has(item.solution), `unknown solution ${item.solution}`); };
  unique(manifest.choices, c => c.name, 'choice');
  for (const choice of manifest.choices) {
    customName(choice.name); component(choice); ensure(choice.label && Array.isArray(choice.options) && choice.options.length, 'choice label/options required');
    unique(choice.options, o => String(o.value), 'choice value');
    for (const option of choice.options) ensure(Number.isInteger(option.value) && option.value >= 0 && option.value <= 2147483647 && option.label, 'invalid choice option');
  }
  unique(manifest.tables, t => t.name, 'table');
  const tables = new Map(manifest.tables.map(t => [t.name, t]));
  for (const table of manifest.tables) {
    identifier(table.name); component(table); table.columns ??= []; table.keys ??= [];
    if (!table.existing) {
      customName(table.schemaName ?? table.name); ensure((table.schemaName ?? table.name).toLowerCase() === table.name, 'table schemaName must lowercase to name');
      identifier(table.entitySetName); ensure(table.label && table.pluralLabel && ['organization', 'user'].includes(table.ownership), 'new table label/pluralLabel/ownership required');
      ensure(table.primaryName?.name && table.primaryName.label, 'primaryName required'); customName(table.primaryName.name);
      for (const flag of ['notes', 'activities']) ensure(table[flag] === undefined || typeof table[flag] === 'boolean', `table ${flag} must be boolean`);
    }
    unique(table.columns, c => c.name, `column on ${table.name}`);
    for (const column of [...table.columns, ...(table.existing ? [] : [table.primaryName])]) {
      customName(column.name); ensure(TYPES.has(column.type ?? 'string'), `unsupported column type ${column.type}; lookups are relationships`);
      if (column.schemaName) { customName(column.schemaName); ensure(column.schemaName.toLowerCase()===column.name, 'column schemaName must lowercase to name'); }
      if (column.solution) component(column);
      ensure(column.label && ['none', 'recommended', 'required'].includes(column.required ?? 'none'), 'column label/required invalid');
      if (['string', 'memo'].includes(column.type ?? 'string')) ensure(Number.isInteger(column.maxLength) && column.maxLength >= 1 && column.maxLength <= (column.type === 'memo' ? 1048576 : 4000), 'text maxLength invalid');
      if (['choice', 'multichoice'].includes(column.type)) ensure(manifest.choices.some(c => c.name === column.choice), `choice ${column.choice} missing`);
      if (['integer', 'decimal', 'double', 'money'].includes(column.type)) {
        ensure(Number.isFinite(column.min) && Number.isFinite(column.max) && column.min <= column.max, 'numeric min/max required');
        if (column.type === 'integer') ensure(Number.isInteger(column.min) && Number.isInteger(column.max) && column.min >= -2147483648 && column.max <= 2147483647, 'integer range invalid');
        if (column.type !== 'integer') ensure(Number.isInteger(column.precision) && column.precision >= 0 && column.precision <= (column.type === 'money' ? 4 : column.type === 'decimal' ? 10 : 5), 'precision invalid');
      }
      if (column.type === 'datetime') {
        ensure(['UserLocal', 'DateOnly', 'TimeZoneIndependent'].includes(column.behavior), 'datetime behavior required');
        ensure(column.format == null || ['DateOnly','DateAndTime'].includes(column.format), 'datetime format must be DateOnly or DateAndTime');
        ensure(column.behavior !== 'DateOnly' || column.format == null || column.format === 'DateOnly', 'DateOnly behavior requires DateOnly format');
      }
    }
    ensure(!table.columns.some(c => c.name === table.primaryName?.name), 'primary name must not be repeated in columns');
    unique(table.keys, k => k.name, `key on ${table.name}`);
    for (const key of table.keys) { customName(key.name); key.solution??=table.solution; component(key); ensure(Array.isArray(key.columns) && key.columns.length > 0 && key.columns.length <= 16, 'key columns required (maximum 16)'); }
  }
  unique(manifest.tables.filter(t=>!t.existing), t=>t.entitySetName, 'entity set');
  unique(manifest.relationships, r => r.name, 'relationship');
  for (const relationship of manifest.relationships) {
    customName(relationship.name); component(relationship);
    ensure(tables.has(relationship.parent) && tables.has(relationship.child), 'relationship targets must be declared, including existing tables');
    ensure(['oneToMany', 'manyToMany'].includes(relationship.kind), 'relationship kind invalid');
    if (relationship.kind === 'oneToMany') {
      customName(relationship.lookup?.name); ensure(relationship.lookup.label, 'lookup label required');
      ensure(['none', 'recommended', 'required'].includes(relationship.lookup.required ?? 'none'), 'lookup required invalid');
      ensure(!(tables.get(relationship.child).columns ?? []).some(c=>c.name===relationship.lookup.name), 'lookup duplicated as scalar column');
      const cascades = { Assign:'NoCascade', Delete:'Restrict', Merge:'NoCascade', Reparent:'NoCascade', Share:'NoCascade', Unshare:'NoCascade', ...relationship.cascade };
      const valid = { Assign:['NoCascade','Cascade','Active','UserOwned'], Delete:['Restrict','RemoveLink','Cascade'], Merge:['NoCascade','Cascade'], Reparent:['NoCascade','Cascade','Active','UserOwned'], Share:['NoCascade','Cascade','Active','UserOwned'], Unshare:['NoCascade','Cascade','Active','UserOwned'] };
      for (const [key,value] of Object.entries(cascades)) ensure(valid[key]?.includes(value), 'cascade value invalid');
      relationship.cascade = cascades;
    } else { customName(relationship.intersectName); if (relationship.intersectColumns) ensure(relationship.intersectColumns.length===2, 'intersectColumns needs two names'); }
  }
  unique(manifest.relationships.filter(r=>r.kind==='oneToMany'), r=>`${r.child}.${r.lookup.name}`, 'lookup relationship');
  for (const table of manifest.tables) for (const key of table.keys) for (const column of key.columns) {
    const declared = table.columns.some(c=>c.name===column) || column === table.primaryName?.name || manifest.relationships.some(r=>r.kind==='oneToMany'&&r.child===table.name&&r.lookup.name===column) || (table.existing && (table.existingColumns ?? []).includes(column));
    ensure(declared, `key ${key.name} references undeclared ${column}`);
    const scalar=table.columns.find(c=>c.name===column)??(table.primaryName?.name===column?table.primaryName:null);
    if (scalar) ensure(['string','integer','decimal','datetime','choice'].includes(scalar.type??'string'), `key ${key.name} uses unsupported ${scalar.type} column`);
  }
  for (const table of manifest.tables) for (const key of table.keys) {
    const estimate=key.columns.reduce((bytes,name)=>{const c=table.columns.find(c=>c.name===name)??(table.primaryName?.name===name?table.primaryName:null);return bytes+(c?.type==='string'||c&&c.type===undefined?2*c.maxLength:16);},0);
    ensure(estimate<=900, `key ${key.name} exceeds the 900-byte index budget`);
  }
  for (const [kind, components] of [['form',manifest.forms],['view',manifest.views]]) {
    unique(components, c=>c.id, kind);
    for (const item of components) {
      component(item); ensure(tables.has(item.table) && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.id) && item.name, `${kind} table/id/name invalid`);
      if(kind==='form') ensure(typeof item.formXml==='string'&&item.formXml.includes('<form'), 'formXML required');
      else ensure(typeof item.fetchXml==='string'&&item.fetchXml.includes('<fetch')&&typeof item.layoutXml==='string'&&item.layoutXml.includes('<grid'), 'view fetchXML/layoutXML required');
    }
  }
  return manifest;
}

export async function readManifest(file) {
  if(file instanceof URL) file=fileURLToPath(file);
  const raw = JSON.parse(await fs.readFile(file, 'utf8'));
  for (const form of raw.forms ?? []) if (form.formXmlFile) form.formXml = await fs.readFile(path.resolve(path.dirname(file), form.formXmlFile), 'utf8');
  for (const view of raw.views ?? []) for (const [source,target] of [['fetchXmlFile','fetchXml'],['layoutXmlFile','layoutXml']]) if (view[source]) view[target] = await fs.readFile(path.resolve(path.dirname(file),view[source]),'utf8');
  const manifest=validateManifest(raw);
  for (const form of manifest.forms) ensure(typeof form.formXml==='string' && form.formXml.includes('<form'), 'formXML required');
  for (const view of manifest.views) ensure(typeof view.fetchXml==='string'&&view.fetchXml.includes('<fetch')&&typeof view.layoutXml==='string'&&view.layoutXml.includes('<grid'), 'view fetchXML/layoutXML required');
  return manifest;
}

export function attributePayload(column, language) {
  const type = column.type ?? 'string';
  const metadata = ({ string:'String',memo:'Memo',integer:'Integer',decimal:'Decimal',double:'Double',money:'Money',boolean:'Boolean',datetime:'DateTime',choice:'Picklist',multichoice:'MultiSelectPicklist' })[type];
  const result = { '@odata.type': `Microsoft.Dynamics.CRM.${metadata}AttributeMetadata`, SchemaName: column.schemaName ?? column.name, DisplayName: label(column.label,language), RequiredLevel: required(column.required), IsAuditEnabled: managed(column.audit ?? true) };
  if (column.description) result.Description=label(column.description,language);
  if (['string','memo'].includes(type)) { result.MaxLength=column.maxLength; if(type==='string') result.FormatName={Value:column.format??'Text'}; else result.Format='Text'; }
  if (['integer','decimal','double','money'].includes(type)) { result.MinValue=column.min; result.MaxValue=column.max; if(type!=='integer') result.Precision=column.precision; else result.Format='None'; if(type==='money') result.PrecisionSource=column.precisionSource??0; }
  if (type==='datetime') { result.DateTimeBehavior={Value:column.behavior}; result.Format=column.format??(column.behavior==='DateOnly'?'DateOnly':'DateAndTime'); }
  if (type==='boolean') { result.DefaultValue=column.default??false; result.OptionSet={ '@odata.type':'Microsoft.Dynamics.CRM.BooleanOptionSetMetadata', TrueOption:{Value:1,Label:label(column.trueLabel??'Yes',language)}, FalseOption:{Value:0,Label:label(column.falseLabel??'No',language)} }; }
  if (['choice','multichoice'].includes(type)) { result['GlobalOptionSet@odata.bind']=`/GlobalOptionSetDefinitions(Name='${column.choice}')`; if(type==='choice'&&column.default!==undefined) result.DefaultFormValue=column.default; }
  return result;
}

export function tablePayload(table, language) {
  return { '@odata.type':'Microsoft.Dynamics.CRM.EntityMetadata', SchemaName:table.schemaName??table.name, EntitySetName:table.entitySetName, DisplayName:label(table.label,language), DisplayCollectionName:label(table.pluralLabel,language), Description:label(table.description??table.label,language), OwnershipType:table.ownership==='user'?'UserOwned':'OrganizationOwned', IsActivity:false, HasActivities:table.activities===true, HasNotes:table.notes===true, IsAuditEnabled:managed(table.audit??true), PrimaryNameAttribute:table.primaryName.name, Attributes:[{...attributePayload(table.primaryName,language),IsPrimaryName:true}] };
}

export function relationshipPayload(r, language) {
  const menu={Behavior:'DoNotDisplay',Group:'Details',Order:10000,Label:label(r.name,language)};
  if (r.kind==='manyToMany') return { '@odata.type':'Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata', SchemaName:r.name, Entity1LogicalName:r.parent, Entity2LogicalName:r.child, IntersectEntityName:r.intersectName, Entity1AssociatedMenuConfiguration:menu,Entity2AssociatedMenuConfiguration:menu, ...(r.intersectColumns?{Entity1IntersectAttribute:r.intersectColumns[0],Entity2IntersectAttribute:r.intersectColumns[1]}:{}) };
  return { '@odata.type':'Microsoft.Dynamics.CRM.OneToManyRelationshipMetadata', SchemaName:r.name, ReferencedEntity:r.parent, ReferencedAttribute:r.parentKey??`${r.parent}id`, ReferencingEntity:r.child, AssociatedMenuConfiguration:menu, CascadeConfiguration:r.cascade, Lookup:{ '@odata.type':'Microsoft.Dynamics.CRM.LookupAttributeMetadata', SchemaName:r.lookup.name, DisplayName:label(r.lookup.label,language), RequiredLevel:required(r.lookup.required), IsAuditEnabled:managed(true) } };
}

export function compileManifest(input) {
  const m=validateManifest(input), actions=[];
  const add=(key,kind,solution,route,body,extra={})=>actions.push({key,kind,solution,method:'POST',route,body,...extra});
  add(`publisher:${m.publisher.uniqueName}`,'publisher',null,'publishers',{uniquename:m.publisher.uniqueName,friendlyname:m.publisher.friendlyName,customizationprefix:m.publisher.prefix,customizationoptionvalueprefix:m.publisher.optionValuePrefix});
  for(const s of m.solutions) add(`solution:${s.uniqueName}`,'solution',null,'solutions',{uniquename:s.uniqueName,friendlyname:s.friendlyName,version:s.version},{publisher:m.publisher.uniqueName});
  for(const c of m.choices) add(`choice:${c.name}`,'choice',c.solution,'GlobalOptionSetDefinitions',{'@odata.type':'Microsoft.Dynamics.CRM.OptionSetMetadata',Name:c.name,DisplayName:label(c.label,m.language),IsGlobal:true,OptionSetType:'Picklist',Options:c.options.map(o=>({Value:o.value,Label:label(o.label,m.language)}))});
  for(const t of m.tables) if(!t.existing) add(`table:${t.name}`,'table',t.solution,'EntityDefinitions',tablePayload(t,m.language),{table:t.name});
  else if(t.columns.length||t.keys.length||m.relationships.some(r=>r.kind==='oneToMany'&&r.child===t.name)) add(`table-reference:${t.name}`,'table-reference',t.solution,'EntityDefinitions',{LogicalName:t.name},{table:t.name});
  for(const t of m.tables) for(const c of t.columns) add(`column:${t.name}.${c.name}`,'column',c.solution??t.solution,`EntityDefinitions(LogicalName='${t.name}')/Attributes`,attributePayload(c,m.language),{table:t.name,column:c.name});
  for(const r of m.relationships) add(`relationship:${r.name}`,'relationship',r.solution,'RelationshipDefinitions',relationshipPayload(r,m.language),{relationship:r.name,table:r.child});
  for(const t of m.tables) for(const k of t.keys) add(`key:${t.name}.${k.name}`,'key',k.solution,`EntityDefinitions(LogicalName='${t.name}')/Keys`,{'@odata.type':'Microsoft.Dynamics.CRM.EntityKeyMetadata',SchemaName:k.name,DisplayName:label(k.label??k.name,m.language),KeyAttributes:k.columns},{table:t.name,keyName:k.name});
  for(const f of m.forms) add(`form:${f.id}`,'form',f.solution,'systemforms',{formid:f.id,name:f.name,objecttypecode:f.table,type:f.type??2,formxml:f.formXml},{id:f.id,table:f.table});
  for(const v of m.views) add(`view:${v.id}`,'view',v.solution,'savedqueries',{savedqueryid:v.id,name:v.name,returnedtypecode:v.table,querytype:v.queryType??0,fetchxml:v.fetchXml,layoutxml:v.layoutXml},{id:v.id,table:v.table});
  return {schemaVersion:1,manifestHash:digest(m),language:m.language,actions,solutions:m.solutions.map(s=>s.uniqueName),tables:m.tables.map(t=>t.name),choices:m.choices.map(c=>c.name)};
}
