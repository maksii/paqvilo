import test from 'node:test';
import assert from 'node:assert/strict';
import {readManifest} from 'paqvilo/dataverse';
import {compileForms} from '../forms/catalogue.mjs';
import {planCurrencyReferenceForms} from '../forms/delta.mjs';
const schema=await readManifest(new URL('../dataverse/manifest.json',import.meta.url));
const metadata={};const types={string:'String',memo:'Memo',integer:'Integer',decimal:'Decimal',double:'Double',money:'Money',boolean:'Boolean',datetime:'DateTime',choice:'Picklist',multichoice:'Virtual'};
for(const[tidx,t]of schema.tables.entries()){
 const fields=new Map();const add=(name,type='String',update=true)=>fields.set(name,{LogicalName:name,AttributeType:type,DisplayName:{UserLocalizedLabel:{Label:name}},IsValidForUpdate:update});
 for(const c of [...t.columns,...(t.primaryName?[t.primaryName]:[])]){add(c.name,types[c.type??'string']);if(c.type==='multichoice')fields.get(c.name).AttributeTypeName={Value:'MultiSelectPicklistType'};}
 for(const r of schema.relationships.filter(r=>r.kind==='oneToMany'&&r.child===t.name))add(r.lookup.name,'Lookup');
 for(const name of t.name==='account'?['name','accountnumber','parentaccountid']:t.name==='contact'?['firstname','lastname','fullname','emailaddress1','telephone1']:[])add(name);
 if(['pqvd_employmentterms','pqvd_equipmentfinance'].includes(t.name))add('transactioncurrencyid','Lookup');if(t.name==='pqvd_chainnode')add('ownerid','Owner');
 add('createdon','DateTime',false);add('statecode','State');add(t.name+'id','Uniqueidentifier',false);
 metadata[t.name]={ObjectTypeCode:10000+tidx,PrimaryIdAttribute:t.name+'id',PrimaryNameAttribute:{account:'name',contact:'fullname',transactioncurrency:'currencyname'}[t.name]??'pqvd_name',Attributes:[...fields.values()]};
}
const result=compileForms(schema,metadata);
test('CurrencyReference delta is narrowly compiled against actual metadata and locks every field',async()=>{
 const calls=[];const packet=await planCurrencyReferenceForms({get:async route=>{calls.push(route);return metadata.pqvd_currencyreference;}},schema);
 assert.equal(calls.length,1);assert.equal(packet.requests.length,5);assert.equal(packet.catalogue.adjustments.length,2);
 assert.equal(packet.nativeMutation,false);assert.deepEqual(packet.publishEntityNames,['pqvd_currencyreference']);
 assert.ok(packet.requests.every(request=>(request.body.returnedtypecode??request.body.objecttypecode)==='pqvd_currencyreference'));
 assert.ok(packet.catalogue.forms.every(form=>!form.formXml.includes('disabled="false"')));
 assert.throws(()=>compileForms(schema,metadata,{tables:['pqvd_currencyreference','pqvd_currencyreference']}),/unique declared/);
});
test('named forms/views are stable, complete and subgrids resolve only declared relationships',()=>{
 assert.equal(result.forms.length,41);assert.equal(result.views.length,74);assert.equal(result.adjustments.length,50);assert.equal(new Set([...result.forms,...result.views].map(c=>c.id)).size,115);
 for(const table of schema.tables.filter(t=>!t.existing))assert.ok(result.forms.some(f=>f.table===table.name&&!f.portable));
 for(const form of result.forms)for(const rel of form.formXml.matchAll(/<RelationshipName>([^<]+)<\/RelationshipName>/g))assert.ok(schema.relationships.some(r=>r.name===rel[1]));
 assert.equal(result.forms.filter(f=>f.solution==='PaqviloBehaviorPlugins').length,5);assert.ok(result.forms.find(f=>f.name==='CO CRUD Probe Pipeline').fields.includes('pqvd_triggernonce'));const again=compileForms(schema,metadata);assert.deepEqual(result,again);
});
test('portable surfaces omit private fields, grants and hidden ancestry; private Quick Find never indexes money or payloads',()=>{
 for(const form of result.forms.filter(f=>f.portable)){assert.ok(!form.formXml.includes('indicationOfSubgrid'));assert.ok(form.fields.every(f=>!f.endsWith('id')&&!/principal|salary|dayrate|purchasecost|scope|rootaccount|currentassignment/.test(f)));assert.ok(!form.formXml.includes('disabled="false"'));}
 for(const view of result.adjustments){assert.ok(!/pqvd_annualsalary|pqvd_dayrate|pqvd_purchasecost|pqvd_payloadtext|pqvd_authoredquery|principalid/.test(view.fetchXml));if(view.queryType===4)assert.ok(view.fetchXml.includes('isquickfindfields="1"'));}
 for(const view of result.views){const attributes=[...view.fetchXml.matchAll(/<attribute name="([^"]+)"/g)].map(m=>m[1]);for(const cell of view.layoutXml.matchAll(/<cell name="([^"]+)"/g))assert.ok(attributes.includes(cell[1]));assert.ok(!view.fetchXml.includes('link-entity'));assert.ok(!view.fetchXml.includes('all-attributes'));}
});
