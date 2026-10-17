import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../../../mirage/lib/browser-launch.mjs';
import {compilePlans} from './compile.mjs';

test('loopback browser pairs escaped typed Liquid/API rows and saves every artifact through actual runner',async()=>{
  const catalogue=JSON.parse(await fs.readFile(new URL('../data/catalogue.json',import.meta.url))),schema=JSON.parse(await fs.readFile(new URL('../dataverse/manifest.json',import.meta.url)));
  const manifest=compilePlans(catalogue,schema);for(const plan of manifest.cases) delete plan.fragments;manifest.readiness.operationGuard=true;manifest.manifestHash='test-only';
  const server=http.createServer(async(req,res)=>{try{if(req.url==='/') {res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Invented loopback permission fixture</title>');return;}const filename=req.url.slice(1);if(!['core.mjs','runtime.mjs'].includes(filename)){res.writeHead(404);res.end();return;}res.setHeader('Content-Type','text/javascript');res.end(await fs.readFile(new URL(filename,import.meta.url)));}catch{res.writeHead(500);res.end();}});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
  try {
    browser=await chromium.launch(browserLaunchOptions({headless:true}));const page=await browser.newPage();await page.goto(`http://127.0.0.1:${server.address().port}`);
    const result=await page.evaluate(async manifest=>{
      const {createRunner}=await import('/runtime.mjs'),{escapeXml,parseLiquid,decodeArtifact}=await import('/core.mjs');
      const context={contactId:manifest.scenarios[0].contactId,roles:['CO Test Runner','CO Employee']},operations=new Map(),runs=new Map(),saved=[];
      const rows=[{pqvd_employmenttermsid:'11111111-1111-4111-8111-111111111111',pqvd_annualsalary:12345.5,pqvd_dayrate:null,pqvd_contractreference:'CO "Alpha" & café — 東京',startdate:'2026-10-13',kind:183270000},{pqvd_employmenttermsid:'22222222-2222-4222-8222-222222222222',pqvd_annualsalary:null,pqvd_dayrate:415,pqvd_contractreference:'',startdate:'2026-10-14',kind:183270002}];
      const response=data=>({ok:true,status:200,data,text:JSON.stringify(data)});
      async function request({url,method='GET',body}) {
        if(method==='POST'){const id=crypto.randomUUID(),stored={...body};if(stored.pqvd_payloadtext)stored.pqvd_payloadtext=stored.pqvd_payloadtext.replaceAll('https://portal.example.test/_api/','https://dataverse.example.test/api/data/v9.1/');saved.push({url,method,body:stored});if(url==='/_api/pqvd_testruns')runs.set(id,stored);if(url==='/_api/pqvd_testoperations')operations.set(id,{...body,pqvd_testoperationid:id,pqvd_markerutc:'CO-UTC:2026-10-13T08:00:00.000Z',pqvd_markeroperation:'CO-OP:'+id});return {...response(null),entityId:id,status:204};}
        if(method==='PATCH'){saved.push({url,method,body});const id=url.match(/\(([a-f0-9-]{36})\)/)?.[1];if(operations.has(id))Object.assign(operations.get(id),body);if(runs.has(id))Object.assign(runs.get(id),body);return {...response(null),status:204};}
        if(url.startsWith('/_api/pqvd_testoperations('))return response(operations.get(url.match(/\(([a-f0-9-]{36})\)/)[1]));
        if(url.startsWith('/_api/pqvd_testruns('))return response(runs.get(url.match(/\(([a-f0-9-]{36})\)/)[1]));
        if(url.startsWith('/_api/pqvd_testresults?')){const xml=decodeURIComponent(url.split('fetchXml=')[1]),op=xml.match(/attribute="pqvd_operationid" operator="eq" value="([a-f0-9-]+)"/)[1];return response({value:saved.filter(s=>s.url==='/_api/pqvd_testresults'&&s.body['pqvd_operationid@odata.bind']===`/pqvd_testoperations(${op})`&&s.body.pqvd_artifactkind===manifest.choices.pqvd_artifactkind.Summary).map(s=>s.body)});}
        if(url.startsWith('/_api/pqvd_pluginevents'))return response({value:[]});
        if(url.startsWith('/_api/pqvd_employmenttermrecords?'))return response({'@odata.context':'https://portal.example.test/_api/$metadata#invented','value':rows,'@Microsoft.Dynamics.CRM.morerecords':false});
        if(url.startsWith('/permission-lab/liquid/')){
          const id=new URL(url,location.origin).searchParams.get('operationId'),op=operations.get(id),plan=manifest.cases.find(c=>c.id===op.pqvd_caseid);
          const text=`<co-test-response outcome="success" case-id="${plan.id}" operation-id="${id}" contact-id="${context.contactId}" dataset-version="${manifest.datasetVersion}"><roles>${context.roles.map(r=>'<role>'+escapeXml(r)+'</role>').join('')}</roles><records>${rows.map(row=>'<record>'+plan.fields.map(f=>`<field name="${f.name}" type="${f.type}" null="${row[f.name]===null}">${row[f.name]===null?'':escapeXml(row[f.name])}</field>`).join('')+'</record>').join('')}</records><paging more="false"></paging><diagnostics><authored-fetchxml>${escapeXml(op.pqvd_authoredquery)}</authored-fetchxml><effective-fetchxml>${escapeXml(op.pqvd_authoredquery.replace('</entity>','<link-entity name="invented_permission"></link-entity></entity>'))}</effective-fetchxml></diagnostics></co-test-response>`;return {ok:true,status:200,text};
        }
        throw new Error('Unexpected fixture route '+url);
      }
      const runner=createRunner({manifest,context,request});const summary=await runner.run({selectedCases:['R36']});let rejected=false;try{parseLiquid('<html>Sign in</html>',manifest.cases[0]);}catch{rejected=true;}
      const loaded=await runner.loadRecordedRun(summary.runId),raw=saved.filter(s=>s.body?.pqvd_artifactkind===manifest.choices.pqvd_artifactkind.RawResponse);const decodedRaw=await Promise.all(raw.map(s=>decodeArtifact(s.body.pqvd_payloadtext)));
      return {summary,loadedParts:loaded.verifiedParts,loadedPairs:loaded.summary.pairs.length,decodedRaw,saved: saved.map(s=>({url:s.url,method:s.method,caseId:s.body?.pqvd_caseid,kind:s.body?.pqvd_artifactkind,state:s.body?.pqvd_runstate})),rejected};
    },manifest);
    assert.equal(result.summary.pairs[0].verdict,'equal');assert.equal(result.summary.pairs[0].liquid.rows[0].pqvd_annualsalary,'12345.50');assert.equal(result.summary.pairs[0].liquid.rows[0].pqvd_contractreference,'CO "Alpha" & café — 東京');assert.ok(result.summary.pairs[0].liquid.pages[0].effectiveFetchXml.includes('invented_permission'));assert.equal(result.summary.pairs[0].webapi.pages[0].effectiveFetchXml,null);assert.equal(result.summary.coverage.durableBackend,false);assert.equal(result.summary.evidence.length,0);assert.equal(result.saved.filter(s=>s.url==='/_api/pqvd_testresults').length,10);assert.equal(result.saved.at(-1).state,183270004);assert.equal(result.rejected,true);assert.equal(result.loadedParts,1);assert.equal(result.loadedPairs,1);assert.equal(JSON.parse(result.decodedRaw[1])['@odata.context'],'https://portal.example.test/_api/$metadata#invented');assert.ok(result.decodedRaw[0].includes('東京'));
  } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
