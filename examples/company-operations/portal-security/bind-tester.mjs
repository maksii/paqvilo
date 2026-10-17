import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {loadConnection,connectedClient} from '../../../lense/dataverse/index.mjs';
import {privateJson} from '../../../lense/dataverse/connection.mjs';
import {buildTesterOverlay,buildStressTesterOverlay} from './tester-overlay.mjs';
import {buildBlueprint,componentId} from './blueprint.mjs';

export async function applyTesterRecords(client,catalogue,overlay,{apply=false,allowManagedReset=false,managedRevokedState,onProgress=()=>{}}={}) {
  const actor=overlay.personas[0];await client.get(`contacts(${actor.contactId})?$select=contactid`);
  const all=new Map([...catalogue.records,...overlay.records].map(r=>[r.key,r])),ids=new Map([...all].map(([key,r])=>[key,r.id])),navs=new Map();
  for(const row of catalogue.records.filter(r=>r.external)){const filter=Object.entries(row.external.match).map(([k,v])=>`${k} eq '${String(v).replaceAll("'","''")}'`).join(' and '),matches=await client.list(`${catalogue.tables.find(t=>t.name===row.table).entitySet}?$filter=${encodeURIComponent(filter)}`);if(matches.length!==1)throw new Error('Existing external reference is unavailable or ambiguous: '+row.key);ids.set(row.key,matches[0][catalogue.tables.find(t=>t.name===row.table).primaryId]);}
  const entries=[],present=new Set(),recordPlans=[],projectionPlans=[];
  for(const row of overlay.records.filter(r=>r.table!=='contact')){
    const declared=catalogue.tables.find(t=>t.name===row.table),existing=await client.optional(`${declared.entitySet}(${row.id})`);if(existing&&existing[declared.primaryId]?.toLowerCase()!==row.id.toLowerCase())throw new Error('Private record primary identity mismatch');if(existing)present.add(row.key);if(existing&&row.table==='pqvd_accesspermission'&&existing._pqvd_granteecontactid_value!==actor.contactId)throw new Error('Private grant GUID belongs to another actor');
    if(!navs.has(row.table))navs.set(row.table,await client.list(`EntityDefinitions(LogicalName='${row.table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`));
    const body={...row.fields};for(const [field,key]of Object.entries(row.refs)){const target=key?all.get(key):null,rel=navs.get(row.table).find(r=>r.ReferencingAttribute===field&&(!target||r.ReferencedEntity===target.table));if(!rel)throw new Error('Missing verified lookup '+row.table+'.'+field);body[rel.ReferencingEntityNavigationPropertyName+'@odata.bind']=target?`/${catalogue.tables.find(t=>t.name===target.table).entitySet}(${ids.get(key)})`:null;}
    const expected={...row.fields,...Object.fromEntries(Object.entries(row.refs).map(([field,key])=>['_'+field+'_value',key?ids.get(key):null]))},equal=(a,b)=>{if(a==null&&b==null)return true;if(typeof a==='string'&&typeof b==='string'){if(/^[0-9a-f-]{36}$/i.test(a)&&/^[0-9a-f-]{36}$/i.test(b))return a.toLowerCase()===b.toLowerCase();if(/^\d{4}-\d\d-\d\d$/.test(b)&&a.startsWith(b+'T00:00:00'))return true;if(/^\d{4}-\d\d-\d\dT/.test(a)&&/^\d{4}-\d\d-\d\dT/.test(b))return Date.parse(a)===Date.parse(b);}return a===b;},drift=existing?Object.entries(expected).filter(([field,value])=>!equal(existing[field],value)).map(([field,value])=>({field,expected:value,actual:existing[field]??null})):[];
    const resetAllowed=allowManagedReset&&Number.isInteger(managedRevokedState)&&row.table==='pqvd_accesspermission'&&existing?.pqvd_accessstate===managedRevokedState&&Object.keys(row.refs).filter(field=>field.endsWith('principalid')).every(field=>existing['_'+field+'_value']==null)&&drift.every(d=>d.field==='pqvd_accessstate'||/^_pqvd_\w+principalid_value$/.test(d.field));
    const entry={kind:'private-record',key:row.key,id:row.id,action:existing?drift.length?(resetAllowed?'managed-reset-transition':'drift'):'exists':'create',before:existing,etag:existing?.['@odata.etag']??null,drift};entries.push(entry);await onProgress(entry);
    if(drift.length&&!resetAllowed)throw new Error('Private record identity/value drift requires review: '+row.key);
    if(existing&&drift.length&&!entry.etag)throw new Error('ETag required for private reset transition');
    recordPlans.push({row,declared,body,existing,drift,entry});
  }
  for(const association of overlay.associations){const source=all.get(association.from),table=catalogue.tables.find(t=>t.name===source.table),relations=await client.list(`RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${association.relationship}'`);if(relations.length!==1)throw new Error('Missing projection relationship');const r=relations[0],side=r.Entity1LogicalName===source.table?1:r.Entity2LogicalName===source.table?2:0;if(!side)throw new Error('Projection source table mismatch');const navigation=side===1?r.Entity1NavigationPropertyName:r.Entity2NavigationPropertyName,targetTable=side===1?r.Entity2LogicalName:r.Entity1LogicalName,target=catalogue.tables.find(t=>t.name===targetTable),current=present.has(source.key)?await client.list(`${table.entitySet}(${source.id})/${navigation}`):[],found=new Set(current.map(row=>row[target.primaryId])),expected=new Set(association.to.map(key=>ids.get(key))),extras=[...found].filter(id=>!expected.has(id));if(extras.length){await onProgress({kind:'projection-drift',relationship:association.relationship,from:source.key,extras});throw new Error('Unexpected private projection targets require review: '+association.relationship);}
    for(const key of association.to){const row=all.get(key);if(row?.table!==targetTable)throw new Error('Projection target type mismatch');if(!found.has(ids.get(key))){projectionPlans.push({source,table,navigation,target,id:ids.get(key)});const entry={kind:'projection',relationship:association.relationship,from:association.from,to:key,action:'add'};entries.push(entry);await onProgress(entry);}}
  }
  // Resolve and validate the complete plan before the first write. New sources
  // have no existing links, so their N:N checks do not require creating them.
  if(apply){
    for(const {row,declared,body,existing,drift,entry}of recordPlans){
      if(!existing)await client.request(declared.entitySet,{method:'POST',body:{...body,[declared.primaryId]:row.id}});
      else if(drift.length){const resetBody=Object.fromEntries(Object.entries(body).filter(([field])=>field==='pqvd_accessstate'||field.includes('principalid@odata.bind')));await client.request(`${declared.entitySet}(${row.id})`,{method:'PATCH',body:resetBody,ifMatch:entry.etag});}
    }
    for(const {source,table,navigation,target,id}of projectionPlans)await client.request(`${table.entitySet}(${source.id})/${navigation}/$ref`,{method:'POST',body:{'@odata.id':client.url(`${target.entitySet}(${id})`)}});
  }
  return {entries,resolvedIds:Object.fromEntries(ids)};
}

export async function resetTesterRecords(client,catalogue,overlay,{apply=false,managedRevokedState,onProgress=()=>{}}={}) {
  if(!Number.isInteger(managedRevokedState))throw new Error('Reset requires the configured Revoked option value');
  // Preflight every managed row before any revocation. This rejects ID takeover,
  // immutable reference drift and unexpected projection targets even on reruns.
  const audit=await applyTesterRecords(client,catalogue,overlay,{apply:false,allowManagedReset:true,managedRevokedState,onProgress}),byKey=new Map(overlay.records.map(r=>[r.key,r])),plans=[];
  for(const key of overlay.provenance.newGrantKeys){
    const row=byKey.get(key);if(row?.table!=='pqvd_accesspermission')throw new Error('Reset key is not an authored private grant');
    const before=audit.entries.find(e=>e.kind==='private-record'&&e.key===key)?.before;if(!before)continue;
    const table=catalogue.tables.find(t=>t.name===row.table),navs=await client.list(`EntityDefinitions(LogicalName='${row.table}')/ManyToOneRelationships?$select=ReferencingAttribute,ReferencedEntity,ReferencingEntityNavigationPropertyName`),body={pqvd_accessstate:managedRevokedState};
    for(const field of Object.keys(row.refs).filter(f=>f.endsWith('principalid'))){const relation=navs.find(r=>r.ReferencingAttribute===field&&r.ReferencedEntity==='contact');if(!relation?.ReferencingEntityNavigationPropertyName)throw new Error('Reset principal lookup navigation unavailable');body[relation.ReferencingEntityNavigationPropertyName+'@odata.bind']=null;}
    if(!before['@odata.etag'])throw new Error('ETag required for private grant reset');
    const links=[];for(const association of overlay.associations.filter(a=>a.from===key)){
      const relations=await client.list(`RelationshipDefinitions/Microsoft.Dynamics.CRM.ManyToManyRelationshipMetadata?$filter=SchemaName eq '${association.relationship}'`);if(relations.length!==1)throw new Error('Missing reset projection relationship');
      const relation=relations[0],side=relation.Entity1LogicalName===row.table?1:relation.Entity2LogicalName===row.table?2:0;if(!side)throw new Error('Reset projection source table mismatch');
      const navigation=side===1?relation.Entity1NavigationPropertyName:relation.Entity2NavigationPropertyName,target=catalogue.tables.find(t=>t.name===(side===1?relation.Entity2LogicalName:relation.Entity1LogicalName)),current=await client.list(`${table.entitySet}(${row.id})/${navigation}`),expected=new Set(association.to.map(k=>audit.resolvedIds[k]));
      if(current.some(t=>!expected.has(t[target.primaryId])))throw new Error('Unexpected private reset projection targets require review');
      for(const targetRow of current)links.push({relationship:association.relationship,navigation,targetId:targetRow[target.primaryId],before:targetRow});
    }
    const entry={kind:'reset-grant',key,id:row.id,entitySet:table.entitySet,before,etag:before['@odata.etag'],body,links,action:'revoke-and-unlink'};plans.push(entry);await onProgress(entry);
  }
  if(apply)for(const plan of plans){
    await client.request(`${plan.entitySet}(${plan.id})`,{method:'PATCH',body:plan.body,ifMatch:plan.etag});
    for(const link of plan.links)await client.request(`${plan.entitySet}(${plan.id})/${link.navigation}(${link.targetId})/$ref`,{method:'DELETE'});
    const after=await client.get(`${plan.entitySet}(${plan.id})`),principals=Object.keys(byKey.get(plan.key).refs).filter(f=>f.endsWith('principalid'));if(after.pqvd_accessstate!==managedRevokedState||principals.some(f=>after['_'+f+'_value']!=null))throw new Error('Private grant revocation verification failed');
    for(const navigation of new Set(plan.links.map(l=>l.navigation)))if((await client.list(`${plan.entitySet}(${plan.id})/${navigation}`)).length)throw new Error('Private reset projection unlink verification failed');
    await onProgress({kind:'reset-grant-verified',key:plan.key,id:plan.id,principalsCleared:true,projectionLinksRemoved:plan.links.length});
  }
  return {plans,applied:apply};
}

export async function setTesterRoles(client,siteId,catalogue,schema,overlay,{selected='baseline',apply=false,onProgress=()=>{}}={}) {
  const b=buildBlueprint(schema,catalogue),actor=overlay.personas[0],current=await client.list(`contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name`),components=await client.list(`powerpagecomponents?$filter=_powerpagesiteid_value eq ${siteId}`),ids=new Set(current.map(r=>r.powerpagecomponentid));
  const site=await client.get(`powerpagesites(${siteId})`);if(site.datamodelversion!=='2.0'||site.enhancedauthorization!==0)throw new Error('Requires enhanced model with traditional authorization');
  for(const role of components.filter(c=>c.powerpagecomponenttype===11&&c.statecode===0&&(JSON.parse(c.content??'{}').authenticatedusersrole||JSON.parse(c.content??'{}').anonymoususersrole)))ids.add(role.powerpagecomponentid);
  if(components.some(c=>{if(c.powerpagecomponenttype!==18||c.statecode!==0)return false;const p=JSON.parse(c.content??'{}');return p.scope===756150000&&schema.tables.some(t=>t.name===p.entitylogicalname)&&p.adx_entitypermission_webrole?.some(id=>ids.has(id));}))throw new Error('Actual tester has an unrelated Global business grant');
  const registered=new Set(b.nodes.map(n=>n.id));if(components.some(c=>{if(c.powerpagecomponenttype!==18||c.statecode!==0||registered.has(c.powerpagecomponentid))return false;const p=JSON.parse(c.content??'{}');return schema.tables.some(t=>t.name===p.entitylogicalname)&&p.adx_entitypermission_webrole?.some(id=>ids.has(id));}))throw new Error('Unrelated active business permission makes the configured fixture oracle incomplete');
  const chosen=selected==='baseline'?['IT']:overlay.personas[0].webRoleVariants?.find(v=>v.roles.length===Number(selected))?.roles;if(!chosen||!['baseline','0','1','2','4','8','12'].includes(String(selected)))throw new Error('Unknown authored role variant');
  const wanted=new Set([...chosen,'TESTRUNNER'].map(code=>componentId('role:'+code))),own=new Set(b.roles.map(r=>r.id)),actual=new Set(current.map(r=>r.powerpagecomponentid)),entries=[];
  for(const id of actual)if(own.has(id)&&!wanted.has(id)){if(apply)await client.request(`contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact(${id})/$ref`,{method:'DELETE'});const entry={kind:'role',id,action:'remove'};entries.push(entry);await onProgress(entry);}
  for(const id of wanted)if(!actual.has(id)){if(!components.some(c=>c.powerpagecomponentid===id&&c.powerpagecomponenttype===11&&c.statecode===0))throw new Error('Required web role not deployed to this site');if(apply)await client.request(`contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact/$ref`,{method:'POST',body:{'@odata.id':client.url(`powerpagecomponents(${id})`)}});const entry={kind:'role',id,action:'add'};entries.push(entry);await onProgress(entry);}
  if(apply){const after=await client.list(`contacts(${actor.contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid`),found=new Set(after.map(r=>r.powerpagecomponentid));if([...wanted].some(id=>!found.has(id))||current.filter(r=>!own.has(r.powerpagecomponentid)).some(r=>!found.has(r.powerpagecomponentid))||[...found].some(id=>own.has(id)&&!wanted.has(id)))throw new Error('Tester role mutation verification failed');}
  return {selected,businessRoles:chosen,preservedOriginalRoleIds:current.filter(r=>!own.has(r.powerpagecomponentid)).map(r=>r.powerpagecomponentid),entries,portalQualification:'Refresh target site cache or re-sign in, then require Liquid user.roles to match this selected variant before interpreting results.'};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2),arg=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];},project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),mode=arg('--mode')??'baseline',contactId=arg('--contact')?.toLowerCase(),siteId=arg('--site')?.toLowerCase();
  if(!['baseline','stress','roles','reset'].includes(mode)||![contactId,siteId].every(v=>/^[0-9a-f-]{36}$/i.test(v??'')))throw new Error('Select --mode baseline/stress/roles/reset and provide --contact and --site GUIDs.');
  const directory=arg('--out')??path.join(project,'.paqvilo/portal-security/tester-'+contactId.slice(0,8));if(!path.resolve(directory).split(path.sep).includes('.paqvilo'))throw new Error('Actual identities and state must stay under ignored .paqvilo');await fs.mkdir(directory,{recursive:true});
  const catalogue=JSON.parse(await fs.readFile(arg('--catalogue')??path.join(project,'data/stress-catalogue.json'))),schema=JSON.parse(await fs.readFile(path.join(project,'dataverse/manifest.json'))),connection=await loadConnection(arg('--connection')??'.paqvilo/dataverse/provisioning.connection.json'),client=connectedClient(connection);await client.verify(connection.organisationId);
  const baseline=buildTesterOverlay(catalogue,contactId),overlay=arg('--overlay')?JSON.parse(await fs.readFile(arg('--overlay'))):mode==='baseline'?baseline:buildStressTesterOverlay(catalogue,baseline);if(overlay.personas?.[0]?.contactId!==contactId||!overlay.private)throw new Error('Private overlay identity mismatch');const before=await client.list(`contacts(${contactId})/powerpagecomponent_mspp_webrole_contact?$select=powerpagecomponentid,name`),journal={startedAt:new Date().toISOString(),organisationId:connection.organisationId,mode,selectedRoleVariant:mode==='roles'?String(arg('--role-count')):'baseline',contactId,siteId,apply:args.includes('--apply'),beforeRoles:before,entries:[]},file=path.join(directory,'journal-'+Date.now()+'.json'),save=()=>privateJson(file,journal);await save();
  const progress=e=>{journal.entries.push(e);return save();};
  await setTesterRoles(client,siteId,catalogue,schema,overlay,{selected:'baseline',apply:false});
  if(['baseline','stress'].includes(mode))journal.records=await applyTesterRecords(client,catalogue,overlay,{apply:journal.apply,allowManagedReset:args.includes('--allow-managed-reset'),managedRevokedState:schema.choices.find(c=>c.name==='pqvd_accessstate').options.find(o=>o.label==='Revoked').value,onProgress:progress});
  journal.roles=await setTesterRoles(client,siteId,catalogue,schema,overlay,{selected:mode==='roles'?String(arg('--role-count')):'baseline',apply:journal.apply,onProgress:progress});
  if(mode==='reset')journal.reset=await resetTesterRecords(client,catalogue,overlay,{apply:journal.apply,managedRevokedState:schema.choices.find(c=>c.name==='pqvd_accessstate').options.find(o=>o.label==='Revoked').value,onProgress:progress});
  overlay.personas[0].webRoles=journal.roles.businessRoles;overlay.provenance.originalRoles=before;overlay.provenance.journal=file;await privateJson(path.join(directory,'overlay.json'),overlay);journal.finishedAt=new Date().toISOString();await save();console.log(JSON.stringify({mode,applied:journal.apply,privateRecords:overlay.records.length,businessRoles:journal.roles.businessRoles,journal:file,overlay:path.join(directory,'overlay.json')}));
}
