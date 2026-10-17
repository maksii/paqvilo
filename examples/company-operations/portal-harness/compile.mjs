import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const hash = text => createHash('sha256').update(text).digest('hex');
export const xmlEscape = value => String(value).replace(/[<>&"']/g, c => ({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[c]));
const primaryName = table => ({account:'name',contact:'fullname',transactioncurrency:'currencyname'}[table] || 'pqvd_name');

export function compilePlans(catalogue, schema, resolvedIds = {}) {
  const ids = Object.fromEntries(catalogue.records.map(r => [r.key, resolvedIds[r.key] || r.id]));
  const types = Object.fromEntries(schema.tables.map(t => [t.name, Object.fromEntries((t.columns || []).map(c => [c.name || c.schemaName?.toLowerCase(), c]))]));
  const cases = catalogue.queries.filter(q => /^R\d\d/.test(q.id)).map(q => {
    const table = catalogue.tables.find(t => t.name === q.table);
    // Root null arm is essential: SQL-style NE alone excludes records with null names.
    let fetchXml = q.fetchXml.replace(/<condition attribute="[^"]+" operator="ne" value="\{\{(?:markerUtc|operationId)\}\}"\s*\/>/g, '');
    fetchXml = fetchXml.replace(/\{\{ref:([^}]+)\}\}/g, (_, key) => {if (!ids[key]) throw new Error(`Missing fixture ${key}`);return ids[key];});
    if(/^R(?:0\d|1\d|2[01])$/.test(q.id)) fetchXml=fetchXml.replace(new RegExp(`<condition attribute="${table.primaryId}" operator="in">[\\s\\S]*?</condition>`),`<condition attribute="${table.primaryId}" operator="in">${catalogue.records.filter(r=>r.table===q.table).map(r=>`<value>${ids[r.key]}</value>`).join('')}</condition>`);
    for(const order of [...fetchXml.matchAll(/<order entityname="([^"]+)" attribute="([^"]+)"\s*\/>/g)]) {fetchXml=fetchXml.replace(order[0],'');const linked=new RegExp('(\x3clink-entity[^>]*alias="'+order[1]+'"[^>]*>)([\\s\\S]*?)(\x3c/link-entity>)');fetchXml=fetchXml.replace(linked,(_,open,body,close)=>open+body+'<order attribute="'+order[2]+'"/>'+close);}
    fetchXml = fetchXml.replace(/<fetch\b([^>]*)>/, '<fetch$1 count="{{pageSize}}" page="{{page}}" returntotalrecordcount="true">');
    const guard = `<filter type="or"><condition attribute="${primaryName(q.table)}" operator="null"></condition><filter type="and"><condition attribute="${primaryName(q.table)}" operator="ne" value="{{markerUtc}}"></condition><condition attribute="${primaryName(q.table)}" operator="ne" value="{{markerOperation}}"></condition></filter></filter>`;
    fetchXml = fetchXml.replace('</entity>', `${guard}</entity>`).replace(/<([^<>]+)\/>/g, (_, tag) => `<${tag}></${tag.split(/\s/)[0]}>`);
    const fields = q.columns.map(name => {
      const selected = [...fetchXml.matchAll(/<attribute\s+([^>]+)>/g)].find(a => new RegExp(`(?:alias|name)="${name}"`).test(a[1]));
      const actualName = selected?.[1].match(/name="([^"]+)"/)?.[1] || name;
      const col = Object.values(types).map(t => t[actualName]).find(Boolean);
      const aggregate = selected?.[1].match(/aggregate="([^"]+)"/)?.[1];
      let type = aggregate ? 'integer' : name.endsWith('id') ? 'guid' : col?.type || (name.includes('count') || name === 'kind' ? 'integer' : 'string');
      if (col?.behavior === 'DateOnly' || actualName === 'pqvd_startdate') type = 'dateonly';
      if (col?.type === 'choice') type = 'integer';
      if (name === 'organisation') type = 'guid';
      return {name, source:actualName, type, precision:col?.precision ?? (type === 'money' ? 2 : 4), nullable:name!==table.primaryId, aggregate:aggregate||null};
    });
    return {id:q.id, name:q.id + ' ' + q.table, table:q.table, entitySet:table.entitySet, primaryId:table.primaryId, primaryName:primaryName(q.table), pageSize:q.pageSize || 50, fields, fetchXml, logicalQueryHash:hash(fetchXml), variant:q.id.includes('-') ? q.id.split('-')[1] : 'fetchxml'};
  });
  const odataVariants=cases.filter(c=>['R01','R03','R05','R09','R12','R23','R24','R33'].includes(c.id)).map(c=>({...c,id:c.id+'-odata',queryType:'odata',variant:'odata',baseCaseId:c.id,fixtureIds:[...c.fetchXml.matchAll(/<value>([a-f0-9-]{36})<\/value>/g)].map(m=>m[1])}));
  // Disjoint primary-key partitions retain all predicates and join multiplicity.
  // Aggregates and DISTINCT require a different merge contract and stay intact.
  for(const plan of cases) if(encodeURIComponent(plan.fetchXml).length>3500 && !plan.fields.some(f=>f.aggregate) && !/distinct="true"/.test(plan.fetchXml)) {
    const filter=new RegExp(`<condition attribute="${plan.primaryId}" operator="in">([\\s\\S]*?)</condition>`),match=plan.fetchXml.match(filter);
    if(!match)continue;const values=[...match[1].matchAll(/<value>[^<]+<\/value>/g)].map(m=>m[0]);
    plan.fragments=[];for(let i=0;i<values.length;i+=16)plan.fragments.push({...plan,fragments:undefined,variant:`${plan.variant}-part${1+i/16}`,templateSuffix:`-part${1+i/16}`,fetchXml:plan.fetchXml.replace(filter,`<condition attribute="${plan.primaryId}" operator="in">${values.slice(i,i+16).join('')}</condition>`)});
    if(plan.fragments.some(f=>encodeURIComponent(f.fetchXml).length>3500))throw new Error(`Unbounded request ${plan.id}; root partition insufficient.`);
  }
  return {schemaVersion:1,suiteVersion:'co-portal-v1',datasetVersion:catalogue.version,cases,odataVariants,scenarios:catalogue.scenarios,crudFixtures:catalogue.crudFixtures.map(f=>({...f,targets:f.targets ? Object.fromEntries(Object.entries(f.targets).map(([k,v])=>[k,ids[v]])):null})),fixtures:ids,choices:Object.fromEntries(schema.choices.map(c=>[c.name,Object.fromEntries(c.options.map(o=>[o.label,o.value]))])),readiness:{operationGuard:false,businessMutation:false,durableCollector:false}, oracleMode:'Sparse scenario assertions; backend administrator expected rows are intentionally excluded.'};
}

export function caseTemplate(plan) {
  const authored = plan.fetchXml.replaceAll('{{runId}}','{{ operation.pqvd_runid.id | xml_escape }}').replaceAll('{{pageSize}}', String(plan.pageSize)).replaceAll('{{page}}', '{{ operation.pqvd_pagenumber }}').replaceAll('{{markerUtc}}', '{{ operation.pqvd_markerutc | xml_escape }}').replaceAll('{{markerOperation}}', '{{ operation.pqvd_markeroperation | xml_escape }}');
  const fields = plan.fields.map(f => `{% assign value = record['${f.name}'] %}<field name="${f.name}" type="${f.type}" null="{% if value == nil %}true{% else %}false{% endif %}">{% if value != nil %}${f.type === 'guid' ? '{{ value.id | default: value | xml_escape }}' : f.type === 'integer' ? '{{ value.value | default: value | xml_escape }}' : f.type === 'dateonly' ? "{{ value | date: 'yyyy-MM-dd' | xml_escape }}" : '{{ value | xml_escape }}'}{% endif %}</field>`).join('');
  return `{% capture authored_xml %}${authored}{% endcapture %}{% fetchxml visibility_query %}{{ authored_xml }}{% endfetchxml %}<co-test-response version="1" outcome="{% if visibility_query.results == nil or visibility_query.results.entities == nil %}query-error{% else %}success{% endif %}" case-id="${plan.id}" operation-id="{{ operation.id | xml_escape }}" contact-id="{{ user.id | xml_escape }}" dataset-version="{{ dataset_version | xml_escape }}"><roles>{% for role in user.roles %}<role>{{ role | xml_escape }}</role>{% endfor %}</roles><records>{% for record in visibility_query.results.entities %}<record>${fields}</record>{% endfor %}</records><paging more="{{ visibility_query.results.more_records | xml_escape }}" total="{{ visibility_query.results.total_record_count | xml_escape }}" limited="{{ visibility_query.results.total_record_count_limit_exceeded | xml_escape }}"><cookie>{{ visibility_query.results.paging_cookie | xml_escape }}</cookie></paging><diagnostics><authored-fetchxml>{{ authored_xml | xml_escape }}</authored-fetchxml><effective-fetchxml>{{ visibility_query.xml | xml_escape }}</effective-fetchxml></diagnostics></co-test-response>`;
}

export function dispatcher(manifest) {
  const branches = manifest.cases.flatMap(p=>p.fragments||[p]).map((p,i)=>`{% ${i?'elsif':'if'} operation.pqvd_caseid == '${p.id}' and operation.pqvd_roottable == '${p.table}' and operation.pqvd_variant == '${p.variant}' %}{% include 'CO Query ${p.id}${p.templateSuffix||''}' %}`).join('\n');
  return `{% assign dataset_version = '${manifest.datasetVersion}' %}{% assign operation = entities.pqvd_testoperation[request.params.operationId] %}{% assign owned_run = entities.pqvd_testrun[operation.pqvd_runid.id] %}{% assign expected_marker = 'CO-OP:' | append: operation.id %}{% if user and user.roles contains 'CO Test Runner' and request.params.suiteVersion == '${manifest.suiteVersion}' and operation and owned_run and owned_run.pqvd_suiteversion == '${manifest.suiteVersion}' and owned_run.pqvd_manifesthash == '${manifest.manifestHash}' and owned_run.pqvd_runnercontactid.id == user.id and operation.pqvd_runnercontactid.id == user.id and operation.pqvd_lane.value == 183270000 and operation.pqvd_markeroperation == expected_marker and operation.pqvd_markerutc contains 'CO-UTC:' and operation.pqvd_attempt == 1 and operation.pqvd_pagenumber >= 1 and operation.pqvd_pagenumber <= 20 %}\n${branches}\n{% else %}<co-test-response outcome="rejected"><error>Unknown case/table intent.</error></co-test-response>{% endif %}{% else %}<co-test-response outcome="rejected"><error>Authenticated runner with owned stamped Liquid operation required.</error></co-test-response>{% endif %}`;
}

export async function prepare({resolvedIds={}, readiness={}, navigation={},overlay={},personaRoleOverrides={},artifactTransportBudgetBytes=20*1024*1024,odataPositiveVariants=[],
  schemaFile,catalogueFile,outputDirectory,blueprintFile}={}) {
  const catalogue=JSON.parse(await (catalogueFile?fs.readFile(catalogueFile,'utf8'):fs.readFile(path.join(here,'../data/stress-catalogue.json'),'utf8').catch(()=>fs.readFile(path.join(here,'../data/catalogue.json'),'utf8'))));
  for(const key of ['records','associations','personas','scenarios']) if(overlay[key])catalogue[key].push(...overlay[key]);
  for(const persona of catalogue.personas) if(personaRoleOverrides[persona.key])persona.webRoles=personaRoleOverrides[persona.key];
  const schema=JSON.parse(await fs.readFile(schemaFile??path.join(here,'../dataverse/manifest.json'),'utf8'));
  const manifest=compilePlans(catalogue,schema,resolvedIds);Object.assign(manifest.readiness,readiness);manifest.artifactTransportBudgetBytes=artifactTransportBudgetBytes;
  manifest.navigation=navigation;
  manifest.odataPositiveVariants=structuredClone(odataPositiveVariants);
  manifest.sourceHash=hash((await Promise.all(['compile.mjs','core.mjs','runtime.mjs','deploy.mjs'].map(f=>fs.readFile(path.join(here,f),'utf8')))).join('\n'));
  manifest.pluginProfiles=['ABC','P02','P03','P04','P05','P06','P07','P09','P10','P11','P12'].map(id=>({id,readiness:id==='P05'?'team-dependency-required':'requires-live-qualification'}));
  const equipment=manifest.cases.find(c=>c.id==='R09');manifest.stressCases=Array.from({length:17},(_,joins)=>{const fetchXml=equipment.fetchXml.replace(/(<condition attribute="pqvd_equipmentid" operator="in">)([\s\S]*?)(<\/condition>)/,(_,open,values,close)=>open+values.match(/<value>[^<]+<\/value>/)[0]+close).replace('</entity>',`${Array.from({length:joins},(_,i)=>`<link-entity name="pqvd_equipment" from="pqvd_equipmentid" to="pqvd_equipmentid" alias="budget${i+1}" link-type="outer"></link-entity>`).join('')}</entity>`);return {...equipment,fragments:undefined,id:`S01-J${String(joins).padStart(2,'0')}`,name:`Query budget ${joins} authored joins`,variant:'query-budget',authoredJoinCount:joins,fetchXml,logicalQueryHash:hash(fetchXml)};});
  manifest.crudReadCases=[];
  const equipmentRead={...equipment,fragments:undefined,id:'CRUD-equipment-created-read',variant:'own-run-created',fields:equipment.fields.filter(f=>['pqvd_equipmentid','pqvd_name','pqvd_assettag'].includes(f.name)),fetchXml:equipment.fetchXml.replace(/<condition attribute="pqvd_equipmentid" operator="in">[\s\S]*?<\/condition>/,'<condition attribute="pqvd_canaryrunid" operator="eq" value="{{runId}}"></condition>')};equipmentRead.logicalQueryHash=hash(equipmentRead.fetchXml);manifest.crudReadCases.push(equipmentRead);
  for(const fixture of manifest.crudFixtures.filter(f=>f.targets)) {
    const table=catalogue.tables.find(t=>t.name===fixture.table),scalar=fixture.table==='contact'?'firstname':primaryName(fixture.table);
    fixture.originals={};for(const side of ['A','B']) {
      const row=catalogue.records.find(r=>r.key===`CANARY-${side}-${fixture.table}`);fixture.originals[side]=row.fields[scalar];fixture.scalarField=scalar;
      const source=manifest.cases.find(c=>c.table===fixture.table);let fetchXml=source.fetchXml.replace(/<entity[^>]*>[\s\S]*?<filter type="or">/,`<entity name="${fixture.table}"><attribute name="${table.primaryId}"></attribute><attribute name="${scalar}"></attribute><order attribute="${table.primaryId}"></order><filter type="and"><condition attribute="${table.primaryId}" operator="eq" value="${fixture.targets[side]}"></condition></filter><filter type="or">`);
      const plan={...source,fragments:undefined,id:`CRUD-${fixture.table}-${side}`,name:`Canary ${fixture.table} ${side}`,variant:'canary-verification',fetchXml,fields:[{name:table.primaryId,source:table.primaryId,type:'guid'},{name:scalar,source:scalar,type:'string'}],logicalQueryHash:hash(fetchXml)};manifest.crudReadCases.push(plan);
    }
  }
  try {
    const blueprint=JSON.parse(await fs.readFile(blueprintFile??path.join(here,'../portal-security/blueprint.json'),'utf8'));
    manifest.configuredPermissionBlueprintHash=hash(JSON.stringify(blueprint));
    manifest.permissionBlueprintHashKind='Portable intended configuration; independent native readback required for deployment attestation.';
    const {evaluateConfiguredGraph}=await import('../portal-security/model-audit.mjs');
    manifest.visibilityOracle=catalogue.personas.map(persona=>{
      const effective=evaluateConfiguredGraph(blueprint,schema,catalogue,persona.key);
      return {persona:persona.key,contactId:persona.contactId,kind:'configured-graph-fixture-eligibility',runtimeAttested:false,cases:manifest.cases.filter(c=>+c.id.slice(1,3)<=21).map(plan=>({caseId:plan.id,table:plan.table,expectedIds:catalogue.records.filter(r=>r.table===plan.table&&effective.get(r.key)?.privileges.has('read')).map(r=>resolvedIds[r.key]||r.id).sort()})),canaryWrites:manifest.crudFixtures.filter(f=>f.targets).flatMap(f=>['A','B'].map(side=>({table:f.table,side,expectedAllowed:effective.get(`CANARY-${side}-${f.table}`)?.privileges.has('write')||false,provenance:effective.get(`CANARY-${side}-${f.table}`)?.provenance||[]})))};
    });
    manifest.oracleMode='Full basic fixture eligibility from independently evaluated configuration graph, plus authored scenario assertions; desired configuration is not server authorization attestation.';
  }catch(error){if(error.code!=='ENOENT') throw error;manifest.visibilityOracle=[];}
  manifest.manifestHash=hash(JSON.stringify(manifest));
  const output=outputDirectory??path.join(here,'../.paqvilo/portal-harness/generated');await fs.mkdir(output,{recursive:true});
  await fs.writeFile(path.join(output,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');
  const allPlans={...manifest,cases:[...manifest.cases,...manifest.crudReadCases,...manifest.stressCases]};
  const templates=allPlans.cases.flatMap(p=>p.fragments||[p]).map(p=>({name:`CO Query ${p.id}${p.templateSuffix||''}`,source:caseTemplate(p)}));
  templates.push({name:'CO Permission Lab Liquid Dispatcher',source:dispatcher(allPlans),mime:'application/xml'});
  await fs.writeFile(path.join(output,'templates.json'),JSON.stringify(templates,null,2)+'\n');
  return {manifest,templates};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {const result=await prepare();console.log(JSON.stringify({cases:result.manifest.cases.length,templates:result.templates.length,manifestHash:result.manifest.manifestHash}));}
