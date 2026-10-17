import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {writeSite,unknownCatalogIds,unaccountedCatalogIds,contradictoryCatalogIds,derivedIds,buildSite,readIdentity} from '../baseline/site.mjs';

const snapshot=async dir=>{
 const files={};
 for(const entry of await fs.readdir(dir,{recursive:true,withFileTypes:true})) if(entry.isFile()){const file=path.join(entry.parentPath,entry.name);files[path.relative(dir,file)]=await fs.readFile(file);}
 return files;
};

test('baseline site generator is deterministic and cites existing catalog ids',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'baseline-site-'));
 try{
  const runs=[];
  for(const n of [1,2]){
   const out=path.join(tmp,`site${n}`),manifest=path.join(tmp,`manifest${n}.json`);
   await writeSite(out,manifest);
   runs.push({files:await snapshot(out),manifest:await fs.readFile(manifest)});
  }
  assert.deepEqual(Object.keys(runs[1].files).sort(),Object.keys(runs[0].files).sort());
  for(const [name,bytes] of Object.entries(runs[0].files)) assert.ok(bytes.equals(runs[1].files[name]),name);
  assert.ok(runs[0].manifest.equals(runs[1].manifest));
  const manifest=JSON.parse(runs[0].manifest);
  assert.ok(manifest.records.length>0);
  assert.deepEqual(await unknownCatalogIds(manifest),[]);
  // Pages are visibility locations; every other record cites what it exercises.
 for(const record of manifest.records) assert.ok(record.kind==='webpage'?record.path:record.catalog.length,`${record.kind} ${record.name} cites catalog ids`);
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test('every catalog item is exercised, not expressible with a reason, or documentation only',async()=>{
 const tmp=await fs.mkdtemp(path.join(os.tmpdir(),'baseline-site-'));
 try{
  await writeSite(path.join(tmp,'site'),path.join(tmp,'manifest.json'));
  const manifest=JSON.parse(await fs.readFile(path.join(tmp,'manifest.json'),'utf8'));
  assert.deepEqual(unaccountedCatalogIds(manifest),[]);
  assert.deepEqual(contradictoryCatalogIds(manifest),[]);
  for(const entry of [...manifest.notExpressed,...manifest.documentationOnly]){assert.ok(entry.reason,'reason');assert.ok(entry.sources.length,`sources for ${entry.catalog[0]}`);}
 }finally{await fs.rm(tmp,{recursive:true,force:true});}
});

test('citations derive from the columns and choice values a record sets',()=>{
 const ids=derivedIds('basicformmetadata',{adx_type:100000002,adx_tabname:'related',adx_label:'x'});
 assert.ok(ids.includes('pp.bfmeta.type.tab')&&ids.includes('pp.bfmeta.tab.label'));
 assert.ok(!ids.includes('pp.bfmeta.attribute.label')&&!ids.includes('pp.bfmeta.section.label')&&!ids.includes('pp.bfmeta.type.attribute'));
 assert.deepEqual(derivedIds('sitesetting',{adx_name:'Webapi/pqvd_x/fields'}).sort(),['pp.sitesetting.table.name','pp.webapi.table.fields']);
});

test('boolean false exercises an item only when the catalog default is true',()=>{
 assert.ok(!derivedIds('basicform',{adx_captcharequired:false}).includes('pp.basicform.captcha'));
 assert.ok(derivedIds('basicform',{adx_captcharequired:true}).includes('pp.basicform.captcha'));
 assert.ok(derivedIds('basicform',{adx_validationsummarylinksenabled:false}).includes('pp.basicform.validation-summary-links'));
 assert.ok(!derivedIds('sitesetting',{adx_name:'Webapi/pqvd_x/enabled',adx_value:'false'}).includes('pp.webapi.table.enabled'));
});

test('site identity is read from a file and leaves derived record ids unchanged',()=>{
 const demo=readIdentity();
 const other={...demo,websiteId:'00000000-0000-4000-8000-000000000001',websiteName:'Other',languageId:'00000000-0000-4000-8000-000000000002',rootParentPageId:'00000000-0000-4000-8000-000000000003'};
 const a=buildSite(demo),b=buildSite(other);
 assert.deepEqual(b.manifest.records.filter(r=>r.kind!=='website').map(r=>r.id),a.manifest.records.filter(r=>r.kind!=='website').map(r=>r.id));
 assert.equal(b.manifest.website,other.websiteId);
 assert.match(b.files.get('website.yml'),/adx_name: Other/);
 for(const content of a.files.values()) assert.ok(!String(content).includes(other.websiteId));
 assert.throws(()=>readIdentity(new URL('../baseline/site.mjs',import.meta.url)));
});

test('basic form metadata carries the server-assigned name and the manifest names the target only',()=>{
 const {files,manifest}=buildSite();
 const records=manifest.records.filter(r=>r.kind==='basicformmetadata');
 for(const r of records){
  assert.match(r.variation,/^metadata \(server-named\)/);
  const file=[...files].find(([name,content])=>name.endsWith('.basicformmetadata.yml')&&String(content).includes(r.id));
  const block=String(file[1]).split(/\n(?=- )/).find(b=>b.includes(r.id));
  const name=/adx_name: '?(.*?)'?$/m.exec(block)?.[1];
  // Notes and timeline have an empty target: "<form name> ".
  assert.equal(name,`${r.form} ${['notes','timeline'].includes(r.name)?'':r.name}`);
 }
});

test('description position is cited only where Add Description is on',()=>{
 assert.ok(!derivedIds('basicformmetadata',{adx_type:100000000,adx_adddescription:false,adx_descriptionposition:100000000}).some(id=>id.includes('description.position')));
 assert.ok(derivedIds('basicformmetadata',{adx_type:100000000,adx_adddescription:true,adx_descriptionposition:100000000}).includes('pp.bfmeta.attribute.description.position.above-field'));
});

test('map pushpin is a deterministic web file under /baseline/',()=>{
 const a=buildSite(),b=buildSite();
 const png=a.files.get('web-files/baseline-pushpin.png'),yml=a.files.get('web-files/baseline-pushpin.png.webfile.yml');
 assert.ok(Buffer.isBuffer(png)&&png.subarray(1,4).toString()==='PNG'&&png.equals(b.files.get('web-files/baseline-pushpin.png')));
 assert.equal(yml,b.files.get('web-files/baseline-pushpin.png.webfile.yml'));
 const root=a.manifest.records.find(r=>r.kind==='webpage'&&r.path==='/baseline/');
 assert.match(yml,new RegExp(`^adx_parentpageid: ${root.id}$`,'m'));
 assert.match(yml,new RegExp(`^adx_publishingstateid: ${readIdentity().publishingStateId}$`,'m'));
 assert.match(yml,/^adx_partialurl: baseline-pushpin\.png$/m);
 const file=a.manifest.records.find(r=>r.kind==='webfile');
 assert.equal(file.path,'/baseline/baseline-pushpin.png');
 assert.ok(file.catalog.includes('pp.webfile.record'));
 for(const name of ['Map','Map-Google','Map-Esri']){
  const list=a.files.get(`lists/Baseline-Item-List-${name}.list.yml`);
  assert.match(list,/^adx_map_pushpinurl: \/baseline\/baseline-pushpin\.png$/m);
  assert.doesNotMatch(list,/adx_map_(latitude|longitude):/);
 }
});

test('list filter definitions use the filter designer shape and redirect URLs are absolute',async()=>{
 const {files}=buildSite();
 const {parse}=await import('yaml');
 const designer=new Set(['textfilter','filterset','rangeset','dynamicpicklistset','lookupset','dynamiclookupset','fetchfilter']);
 for(const name of ['lists/Baseline-Item-List-Filters.list.yml','lists/Baseline-Item-List-Filters-Horizontal.list.yml']){
  const fetch=JSON.parse(parse(files.get(name)).adx_filter_definition);
  // The designer's root; without xmlns.adx the portal renders "Value cannot be null. Parameter name: key".
  assert.equal(fetch['xmlns.adx'],'http://schemas.adxstudio.com/fetch/',name);
  assert.ok(Array.isArray(fetch.entity.links),name);
  const groups=[...fetch.entity.filters,...fetch.entity.links];
  for(const group of groups) assert.ok(designer.has(group['adx.filtertype'])&&Number.isInteger(group['adx.id']),`${name} ${group['adx.uiname']}`);
  assert.deepEqual(groups.map(g=>g['adx.id']),groups.map((_,i)=>i));
 }
 for(const [name,content] of files) if(/\.(basicform|advancedformstep)\.yml$/.test(name)){
  const url=/^adx_redirecturl: (.*)$/m.exec(String(content))?.[1];
  if(url) assert.match(url,/^https:\/\//,name);
 }
});
