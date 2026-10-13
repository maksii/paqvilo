import fs from 'node:fs/promises';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {loadConnection,connectedClient} from '../../../lense/dataverse/index.mjs';
import {prepare} from './compile.mjs';

const here=path.dirname(fileURLToPath(import.meta.url));
const args=Object.fromEntries(process.argv.slice(2).reduce((a,v,i,all)=>v.startsWith('--')?[...a,[v.slice(2),all[i+1]]]:a,[]));
export function componentId(website,key) {const bytes=createHash('sha256').update(`CO Portal Lab v1:${website}:${key}`).digest().subarray(0,16);bytes[6]=(bytes[6]&15)|80;bytes[8]=(bytes[8]&63)|128;const h=bytes.toString('hex');return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;}
export async function shellSource(manifest) {
  const core=await fs.readFile(path.join(here,'core.mjs'),'utf8'),runtime=await fs.readFile(path.join(here,'runtime.mjs'),'utf8');
  const code=(core+'\n'+runtime.replace(/^import .*?;\s*/,'')).replace(/\bexport /g,'');
  const encoded=JSON.stringify(manifest).replaceAll('<','\\u003c');
  return `<section id="co-lab"><h1>Company Operations Permission Lab</h1><p>Paired Liquid and Web API FetchXML. Results distinguish parity, scenario assertions and missing backend evidence.</p><pre id="co-identity"></pre><label>Read case <select id="co-cases"><option value="all">All read cases and variants</option></select></label><label>Previous run <select id="co-baseline"><option value="">No baseline</option></select></label><button id="co-history">Load history</button><button id="co-view-history">View selected run</button><button id="co-read" data-run>Run reads</button><label>CRUD scope <select id="co-crud-scope"><option value="all">All prepared canaries</option><option value="equipment">Equipment only</option><option value="probe">Recorder probe only</option></select></label><button id="co-crud" data-run>Run reads and prepared CRUD</button><label>Plugin profile <select id="co-profile"><option value="">None</option></select></label><button id="co-stop">Stop</button><button id="co-export">Export current JSON</button><p id="co-status" role="status"></p><div id="co-results"></div></section><style>#co-lab{max-width:1100px;margin:24px auto;padding:16px;font-family:system-ui}#co-lab pre{white-space:pre-wrap;overflow-wrap:anywhere;background:#f5f6f7;padding:12px}#co-lab button,#co-lab select{margin:6px;padding:8px}#co-lab details{border-top:1px solid #ddd;padding:10px}</style><script id="co-context" type="application/xml"><context contact-id="{{ user.id | xml_escape }}"><roles>{% for role in user.roles %}<role>{{ role | xml_escape }}</role>{% endfor %}</roles></context></script>{% raw %}<script type="module">${code}\nconst manifest=${encoded};const contextXML=new DOMParser().parseFromString(document.getElementById('co-context').textContent,'application/xml');const context={contactId:contextXML.documentElement.getAttribute('contact-id'),roles:[...contextXML.querySelectorAll('role')].map(r=>r.textContent)};mount(manifest,context);</script>{% endraw %}`;
}
export async function deploy({connection,website,role,home,published,language,resolvedIds={},readiness={},overlayFile,personaRoleOverrides={},artifactTransportBudgetBytes=20*1024*1024}) {
  if (![website,role,home,published].every(v=>/^[a-f0-9-]{36}$/i.test(v||''))) throw new Error('Verified target website, CO Test Runner role, root page and publishing-state IDs required.');
  const connectionInfo=await loadConnection(connection),client=connectedClient(connectionInfo);await client.verify(connectionInfo.organisationId);
  const schema=JSON.parse(await fs.readFile(path.join(here,'../dataverse/manifest.json'),'utf8'));
  const navigation={};for(const table of schema.tables){const relationships=await client.list(`EntityDefinitions(LogicalName='${table.name}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`);navigation[table.entitySetName||({account:'accounts',contact:'contacts',transactioncurrency:'transactioncurrencies'}[table.name])]={};for(const r of relationships)navigation[table.entitySetName||({account:'accounts',contact:'contacts',transactioncurrency:'transactioncurrencies'}[table.name])][r.ReferencingAttribute]=r.ReferencingEntityNavigationPropertyName;}
  const overlay=overlayFile?JSON.parse(await fs.readFile(overlayFile,'utf8')):{};
  const {manifest,templates}=await prepare({resolvedIds,readiness,navigation,overlay,personaRoleOverrides,artifactTransportBudgetBytes});
  const id=key=>componentId(website,key),components=[];
  const push=(key,name,type,content,extra={})=>components.push({key,id:id(key),name,type,content,...extra});
  for(const t of templates) push('template:'+t.name,t.name,8,{source:t.source,...(t.mime?{mimetype:t.mime}:{})});
  push('template:shell','CO Permission Lab Shell',8,{source:await shellSource(manifest)});
  push('pagetemplate:shell','CO Permission Lab',6,{entityname:'adx_webpage',type:756150001,usewebsiteheaderandfooter:true,webtemplateid:id('template:shell')});
  push('pagetemplate:liquid','CO Permission Lab Liquid Data',6,{entityname:'adx_webpage',type:756150001,usewebsiteheaderandfooter:false,webtemplateid:id('template:CO Permission Lab Liquid Dispatcher')});
  push('page:shell','CO Permission Lab',2,{isroot:true,pagetemplateid:id('pagetemplate:shell'),parentpageid:home,partialurl:'permission-lab',publishingstateid:published,title:'Permission Lab',hiddenfromsitemap:true});
  push('page:liquid','CO Permission Lab Liquid Data',2,{isroot:true,pagetemplateid:id('pagetemplate:liquid'),parentpageid:id('page:shell'),partialurl:'liquid',publishingstateid:published,title:'Permission Lab Liquid Data',hiddenfromsitemap:true});
  // Localized child rows are required by multilingual enhanced-model sites.
  if(language) for(const [kind,title] of [['shell','CO Permission Lab'],['liquid','CO Permission Lab Liquid Data']]) push('contentpage:'+kind,title,2,{isroot:false,rootwebpageid:id('page:'+kind),pagetemplateid:id('pagetemplate:'+kind),partialurl:kind==='shell'?'permission-lab':'liquid',publishingstateid:published,title,hiddenfromsitemap:true},{language});
  push('access:shell','CO Permission Lab Require Runner',10,{adx_webpageaccesscontrolrule_webrole:[role],right:2,scope:1,webpageid:id('page:shell')});
  push('access:liquid','CO Liquid Data Require Runner',10,{adx_webpageaccesscontrolrule_webrole:[role],right:2,scope:1,webpageid:id('page:liquid')});
  const fields={};
  for(const plan of manifest.cases) {
    fields[plan.table] ||= new Set([plan.primaryId,plan.primaryName]);
    const entityStack=[],aliases={};for(const match of plan.fetchXml.matchAll(/<(entity|link-entity)\s+([^>]+)>|<\/(entity|link-entity)>|<(?:attribute|condition|order)\s+([^>]+)>/g)) {
      if(match[1]) {const table=match[2].match(/\bname="([^"]+)"/)?.[1],alias=match[2].match(/\balias="([^"]+)"/)?.[1];entityStack.push(table);if(alias) aliases[alias]=table;}
      else if(match[3]) entityStack.pop();else {const attrs=match[4],entityAlias=attrs.match(/\bentityname="([^"]+)"/)?.[1],table=entityAlias?aliases[entityAlias]:entityStack.at(-1),name=attrs.match(/\b(?:name|attribute)="([^"]+)"/)?.[1];if(name && schema.tables.some(t=>t.name===table)){fields[table] ||= new Set();fields[table].add(name);}}
    }
  }
  const safeReadExtras={account:['name','accountnumber','pqvd_orgkind'],contact:['firstname','lastname','fullname','pqvd_personcode'],pqvd_equipment:['pqvd_canaryrunid','pqvd_roomid','pqvd_accountid','pqvd_assettag','pqvd_equipmentkind','pqvd_condition','pqvd_equipmentstate'],pqvd_accesspermission:['pqvd_roleid','pqvd_granteecontactid','pqvd_scopeaccountid','pqvd_departmentid','pqvd_employmentid','pqvd_accessstate','pqvd_validfrom','pqvd_validuntil','pqvd_scopekey']};
  for(const [table,names] of Object.entries(safeReadExtras)) for(const name of names) (fields[table] ||=new Set()).add(name);
  for(const t of schema.tables.filter(t=>['pqvd_testrun','pqvd_testresult','pqvd_testoperation','pqvd_crudprobe','pqvd_pluginevent','pqvd_chainnode'].includes(t.name))) {
    fields[t.name]=new Set([`${t.name}id`,'pqvd_name',...(t.columns||[]).map(c=>c.name)]);
    for(const r of schema.relationships.filter(r=>r.child===t.name || r.referencingTable===t.name || r.referencingEntity===t.name)) if(r.lookup?.name) fields[t.name].add(r.lookup.name);
  }
  // Relationships in the generated registry use referencingTable/referencedTable or parent/child: read concrete Lookup schema names.
  for(const r of schema.relationships) {const child=r.child||r.referencingTable||r.referencingEntity;if(['pqvd_testrun','pqvd_testresult','pqvd_testoperation','pqvd_crudprobe','pqvd_pluginevent','pqvd_chainnode'].includes(child) && r.lookup) fields[child].add((r.lookup.name||r.lookup.schemaName)?.toLowerCase());}
  for(const [table,names] of Object.entries(fields)) {
    // Qualify allowlists against actual metadata; never deploy aliases or guessed columns as schema fields.
    const actual=await client.list(`EntityDefinitions(LogicalName='${table}')/Attributes?$select=LogicalName`);
    const legal=new Set(actual.map(c=>c.LogicalName));for(const name of names) if(name && !legal.has(name)) throw new Error(`Web API allowlist references missing ${table}.${name}`);
    push('setting:'+table+':enabled',`Webapi/${table}/enabled`,9,{value:'true'});
    push('setting:'+table+':fields',`Webapi/${table}/fields`,9,{value:[...names].filter(Boolean).sort().join(',')});
  }
  const existing=await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${website}&$select=powerpagecomponentid,name,powerpagecomponenttype,content,_powerpagesitelanguageid_value,statecode`);
  const journal={website,createdAt:new Date().toISOString(),manifestHash:manifest.manifestHash,entries:[]};
  const dir=path.join(here,'../.paqvilo/portal-harness');await fs.mkdir(dir,{recursive:true});const file=path.join(dir,`deploy-${Date.now()}.json`);
  for(const c of components) {
    const matches=existing.filter(e=>e.name===c.name&&e.powerpagecomponenttype===c.type&&e.statecode===0);
    if(c.type===9 && matches.length>1) throw new Error(`Duplicate active setting ${c.name}; reconcile ambiguous configuration first.`);
    // Site-level API settings have a unique semantic name: preserve discovered identity and journal prior content.
    if(c.type===9 && matches.length===1) c.id=matches[0].powerpagecomponentid;
    const own=existing.find(e=>e.powerpagecomponentid===c.id);
    const body={name:c.name,powerpagecomponenttype:c.type,content:JSON.stringify(c.content)};
    if(c.language) body['powerpagesitelanguageid@odata.bind']=`/powerpagesitelanguages(${c.language})`;
    const unchanged=own&&own.content===body.content&&own.statecode===0;
    if(!unchanged) {if(own) await client.request(`powerpagecomponents(${c.id})`,{method:'PATCH',body});else await client.request('powerpagecomponents',{method:'POST',body:{...body,powerpagecomponentid:c.id,'powerpagesiteid@odata.bind':`/powerpagesites(${website})`}});}
    journal.entries.push({key:c.key,id:c.id,status:unchanged?'exists':own?'updated':'created',...(own&&!unchanged?{beforeContent:own.content}: {})});await fs.writeFile(file,JSON.stringify(journal,null,2));if(journal.entries.length%10===0) console.log(JSON.stringify({completed:journal.entries.length,total:components.length}));
  }
  const post=await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${website}&$select=powerpagecomponentid,name,powerpagecomponenttype,content,_powerpagesitelanguageid_value,statecode`);
  const mismatches=components.filter(c=>!post.some(e=>e.powerpagecomponentid===c.id&&e.statecode===0&&e.powerpagecomponenttype===c.type&&e.content===JSON.stringify(c.content))).map(c=>c.key);
  journal.verification={checked:components.length,mismatches};journal.finishedAt=new Date().toISOString();await fs.writeFile(file,JSON.stringify(journal,null,2));if(mismatches.length) throw new Error(`Post-deployment verification failed for ${mismatches.join(', ')}`);
  return {journal:file,manifestHash:manifest.manifestHash,components:components.length,page:id('page:shell'),liquidPage:id('page:liquid'),fields:Object.fromEntries(Object.entries(fields).map(([table,columns])=>[table,[...columns].filter(Boolean).sort()]))};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {const config=JSON.parse(await fs.readFile(args.config,'utf8'));console.log(JSON.stringify(await deploy(config)));}
