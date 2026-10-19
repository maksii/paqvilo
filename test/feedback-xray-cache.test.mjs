import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {createSourceInspector} from '../lense/source-inspection.mjs';
import {elementSourceHintCacheStats} from '../lense/element-provenance.mjs';
import {inspectionFixture} from './source-inspection-fixture.mjs';

test('X-ray report size follows page candidates, revisits reuse reports, and refresh parses only changed markup',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);
  const config={sourceDir:fx.portal};
  const small=await createSourceInspector(config).inspect('/');
  const body=index=>Array.from({length:20},(_,part)=>`<div class="unused-${index}-${part}"></div>`).join('');
  fs.writeFileSync(path.join(fx.portal,'webtemplate.yml'),JSON.stringify(Array.from({length:400},(_,index)=>({adx_webtemplateid:'unused-template-'+index,adx_name:'Unused template '+index,adx_source:body(index)}))));
  fs.writeFileSync(path.join(fx.portal,'contentsnippet.yml'),JSON.stringify(Array.from({length:600},(_,index)=>({adx_contentsnippetid:'unused-snippet-'+index,adx_name:'Unused snippet '+index,adx_value:body(index+400)}))));
  const inspector=createSourceInspector(config),start=performance.now(),first=await inspector.inspect('/');
  const firstMs=performance.now()-start;
  assert.ok(JSON.stringify(first.report).length<JSON.stringify(small.report).length*2,'unused markup and its class-frequency dictionary stay out of the page response');
  assert.equal(first.report.elementSources.some(row=>row.name.startsWith('Unused')),false);
  const afterFirst=elementSourceHintCacheStats(),firstWork=inspector.stats();
  await inspector.inspect('/other');
  const beforeRevisit=elementSourceHintCacheStats(),revisitStart=performance.now();
  const revisit=await inspector.inspect('/');
  const revisitMs=performance.now()-revisitStart;
  assert.deepEqual(revisit,first);
  assert.equal(elementSourceHintCacheStats().parses,beforeRevisit.parses);
  assert.equal(inspector.stats().enrichments,firstWork.enrichments+1,'only the intervening route is enriched');
  const beforeRefresh=inspector.stats();
  for(let count=0;count<2;count++){inspector.invalidate();assert.deepEqual(await inspector.inspect('/'),first);}
  assert.equal(inspector.stats().reloads,beforeRefresh.reloads);
  assert.equal(inspector.stats().sourceFiles.misses,beforeRefresh.sourceFiles.misses);
  assert.equal(elementSourceHintCacheStats().parses,afterFirst.parses,'unchanged refresh does not reparse any markup');
  const changed=path.join(fx.portal,'web-templates/Partial.webtemplate.source.html');
  fs.appendFileSync(changed,'<aside id="changed-markup"></aside>');
  inspector.invalidate();
  const updated=await inspector.inspect('/');
  assert.ok(updated.report.elementSources.some(row=>row.selector==='#changed-markup'));
  assert.equal(elementSourceHintCacheStats().parses,afterFirst.parses+1,'exactly the changed source is reparsed');
  assert.equal(inspector.stats().reloads,beforeRefresh.reloads+1);
  t.diagnostic(JSON.stringify({firstMs,revisitMs,payloadBytes:Buffer.byteLength(JSON.stringify(first.report)),unusedTemplates:400,unusedSnippets:600}));
  assert.ok(revisitMs<200,'synthetic cached revisit stays below the 200 ms target');
});

test('Mirage enrichment reuses unchanged route evidence while separating access verdicts and new rendered bindings',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);
  const inspector=createSourceInspector({sourceDir:fx.portal});
  const base={path:'/',page:{id:'home',access:{allowed:false}},forms:[],columns:[],components:[],tables:[],unresolved:[]};
  await inspector.enrich(structuredClone(base));
  const first=inspector.stats();
  await inspector.enrich({...structuredClone(base),path:'/other',page:{id:'other'}});
  const cached=await inspector.enrich(structuredClone(base));
  assert.equal(inspector.stats().reportHits,first.reportHits+1);
  assert.equal(inspector.stats().enrichments,first.enrichments+1);
  assert.equal(cached.page.access.allowed,false);
  cached.page.access.allowed=true;
  assert.equal((await inspector.enrich(structuredClone(base))).page.access.allowed,false,'caller mutation cannot poison cached session evidence');
  const allowed=await inspector.enrich({...structuredClone(base),page:{id:'home',access:{allowed:true}}});
  assert.equal(allowed.page.access.allowed,true,'a changed local access verdict has a separate cache key');
  await inspector.enrich(structuredClone(base),{controls:[{entity:'fx_widget',formId:'widget-edit'}]});
  assert.equal(inspector.stats().enrichments,first.enrichments+3,'new rendered bindings are enriched again');
});

test('rendered shape selects unreferenced snippet candidates and declares the extra-candidate budget',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.portal,'contentsnippet.yml'),JSON.stringify(Array.from({length:1250},(_,index)=>({adx_contentsnippetid:'dynamic-'+index,adx_name:'Dynamic '+index,adx_value:'<aside class="dynamic-banner"></aside>'}))));
  const inspector=createSourceInspector({sourceDir:fx.portal});
  const {report}=await inspector.inspect('/',{markupTokens:['class:aside:dynamic-banner']});
  assert.equal(report.elementSources.filter(row=>row.selector==='aside.dynamic-banner').length,1200);
  assert.equal(report.elementSourceFrequencies['aside.dynamic-banner'],1250,'rarity retains the complete export evidence');
  assert.equal(report.elementSourceLimits.candidateTruncated,true);
  assert.equal(report.elementSourceLimits.truncated,true);
});

test('truncated script notes use the same root-relative display path as their source row',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);
  fs.writeFileSync(path.join(fx.portal,'web-files/widget.js'),Array.from({length:200},(_,index)=>`document.querySelector('#id${index}');`).join('\n'));
  const {report}=await createSourceInspector({sourceDir:fx.portal}).inspect('/');
  const row=report.elementSources.find(item=>item.kind==='script'&&item.sourceFile.endsWith('widget.js'));
  assert.ok(row);
  assert.deepEqual(report.elementSourceLimits.scriptTruncatedSources,[path.relative(fx.portal,row.sourceFile).replaceAll('\\','/')]);
  assert.equal(report.elementSourceLimits.scriptTruncatedSources.some(value=>/[\\:]|^\//.test(value)),false);
});

test('an edit during import is observed by the next refresh instead of becoming an accepted stale snapshot',async t=>{
  const fx=inspectionFixture();t.after(fx.cleanup);
  const target=path.join(fx.portal,'web-templates/Partial.webtemplate.source.html');
  const original=fs.promises.readFile;let edited=false;
  t.mock.method(fs.promises,'readFile',async function(file,...options){
    const value=await original.call(this,file,...options);
    if(!edited&&path.resolve(String(file))===target){edited=true;await fs.promises.appendFile(target,'<b id="edited-during-import"></b>');}
    return value;
  });
  const inspector=createSourceInspector({sourceDir:fx.portal});
  const first=await inspector.inspect('/');
  assert.equal(edited,true);assert.equal(first.report.elementSources.some(row=>row.selector==='#edited-during-import'),false);
  inspector.invalidate();
  assert.ok((await inspector.inspect('/')).report.elementSources.some(row=>row.selector==='#edited-during-import'));
});
