import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs/promises';import os from 'node:os';import path from 'node:path';import{createHash}from 'node:crypto';
import {createSimulator} from '../server.mjs';
import {collectWebApiErrorTemplates,validateWebApiErrorTemplates,webApiReaderTemplateKey} from '../lib/webapi-error-templates.mjs';
import {validatePack} from '../lib/preset-registry.mjs';import {observedConfig} from '../lib/project-config.mjs';
import {attachODataReaderDetails,odataConversionDetails} from '../lib/webapi-error-details.mjs';
import {DataError} from '../lib/data.mjs';import {webApiErrorResponse} from '../lib/webapi-handler.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";
const sha=value=>createHash('sha256').update(value).digest('hex'),id='00000000-0000-4000-8000-000000000001';
const suffix='\r\n   at Invented.Reader.Convert()\r\n   at Invented.Reader.Read()',descriptor={kind:'primitive-format',expectedType:'Edm.Int32'};
const capability=()=>({version:1,evidence:'Invented response and fresh variation fixture',templates:['POST','PATCH'].map(method=>({method,descriptor,suffix,suffixSha256:sha(suffix),capturedSourceSha256:'a'.repeat(64),qualifiedVariationSha256:'b'.repeat(64)}))});
const pack=()=>({id:'reader-format',name:'Reader format',description:'Invented reader response fixture',matches:()=>true,presets:()=>({}),webApiErrorTemplates:capability()});

test('template keys omit user/property values and reject unknown descriptor branches',()=>{
 assert.equal(webApiReaderTemplateKey(descriptor),'{"kind":"primitive-format","expectedType":"Edm.Int32"}');
 for(const d of [{...descriptor,literal:'secret'}, {...descriptor,property:'title'},{kind:'constructor'},{kind:'primitive-format',expectedType:'Edm.Int64'},{kind:'root-node',actualNode:'Array',expectedNode:'StartObject'}])assert.throws(()=>webApiReaderTemplateKey(d));
});
test('pack admission requires actual suffix hash, bounded CRLF and both evidence hashes',()=>{
 assert.equal(validatePack(pack()).id,'reader-format');
 for(const fault of ['suffix-hash','variation','source','line-endings','bounds','duplicates']){const c=capability(),t=c.templates[0];if(fault==='suffix-hash')t.suffixSha256='c'.repeat(64);if(fault==='variation')delete t.qualifiedVariationSha256;if(fault==='source')delete t.capturedSourceSha256;if(fault==='line-endings'){t.suffix=t.suffix.replaceAll('\r\n','\n');t.suffixSha256=sha(t.suffix);}if(fault==='bounds'){t.suffix+='x'.repeat(131072);t.suffixSha256=sha(t.suffix);}if(fault==='duplicates')c.templates.push(t);assert.throws(()=>validateWebApiErrorTemplates(c));}
});
test('matching pack duplicate descriptors fail and getters are never evaluated',()=>{
 assert.throws(()=>collectWebApiErrorTemplates([pack(),{...pack(),id:'other'}]),/duplicate/);
 let called=false;const p=pack();Object.defineProperty(p,'webApiErrorTemplates',{get(){called=true;return capability();}});assert.throws(()=>validatePack(p));assert.throws(()=>collectWebApiErrorTemplates([p]));assert.equal(called,false);
});
test('default, SDK errors, disabled innererror, unsupported descriptors and reader mode stay untouched',()=>{
 const templates=collectWebApiErrorTemplates([pack()]),error=attachODataReaderDetails(new DataError('Original',400,'InvalidValue'),odataConversionDetails('bad','Edm.Int32','quantity'));
 const base={innerError:true,errorDetails:'odata-wrapper',errorTemplates:templates,errorMethod:'PATCH'};
 assert.equal(webApiErrorResponse(error,base).body.error.innererror.message.includes(suffix),false);
 assert.equal(webApiErrorResponse(error,{...base,errorStacks:'response-template'}).body.error.innererror.message.endsWith(suffix),true);
 assert.equal(webApiErrorResponse(error,{...base,errorStacks:'response-template',errorDetails:'diagnostic'}).body.error.innererror.message,'Original');
 assert.equal(webApiErrorResponse(error,{...base,errorStacks:'response-template',innerError:false}).body.error.innererror,undefined);
 const sdk=new DataError('SDK detail',400,'InvalidValue');assert.equal(webApiErrorResponse(sdk,{...base,errorStacks:'response-template'}).body.error.innererror.message,'SDK detail');assert.equal(JSON.stringify(error).includes('Invented.Reader'),false);
 const unknown=attachODataReaderDetails(new DataError('Guid detail',400,'InvalidValue'),odataConversionDetails('bad','Edm.Guid','foreignid'));assert.equal(webApiErrorResponse(unknown,{...base,errorStacks:'response-template'}).body.error.innererror.message.includes(suffix),false);
 for(const method of [undefined,'PUT','GET'])assert.equal(webApiErrorResponse(error,{...base,errorStacks:'response-template',errorMethod:method}).body.error.innererror.message.includes(suffix),false);
});
test('explicit site mode retains evidence requirement',()=>{
 assert.throws(()=>observedConfig({webApiErrorStacks:'response-template'}),/evidence/);
 assert.equal(observedConfig({webApiErrorStacks:'response-template',evidence:'Invented capture'}).webApiErrorStacks,'response-template');
});
test('POST and PATCH use independently evidenced suffixes without cross-method fallback',()=>{
 const p=pack(),post='\r\n   at Invented.CreateReader.Read()';p.webApiErrorTemplates.templates[0]={...p.webApiErrorTemplates.templates[0],suffix:post,suffixSha256:sha(post)};
 const templates=collectWebApiErrorTemplates([p]),error=attachODataReaderDetails(new DataError('Original',400,'InvalidValue'),odataConversionDetails('bad','Edm.Int32','quantity'));
 const options={innerError:true,errorDetails:'odata-wrapper',errorStacks:'response-template',errorTemplates:templates};
 assert.equal(webApiErrorResponse(error,{...options,errorMethod:'POST'}).body.error.innererror.message.endsWith(post),true);
 assert.equal(webApiErrorResponse(error,{...options,errorMethod:'PATCH'}).body.error.innererror.message.endsWith(suffix),true);
 p.webApiErrorTemplates.templates.pop();const postOnly=collectWebApiErrorTemplates([p]);assert.equal(webApiErrorResponse(error,{...options,errorMethod:'PATCH',errorTemplates:postOnly}).body.error.innererror.message.includes(post),false);
});

async function fixture(t,{mode='response-template',match=true,inner=true,register=true}={}){
 const source=await fs.mkdtemp(path.join(os.tmpdir(),'mirage-response-template-'));ownedFixture(t).remove(()=>fs.rm(source,{recursive:true,force:true}));
 await fs.writeFile(path.join(source,'website.yml'),'adx_websiteid: invented-reader-site\nadx_name: Reader fixture\n');
 await fs.writeFile(path.join(source,'sitesetting.yml'),'- adx_name: Webapi/probe/enabled\n  adx_value: "true"\n- adx_name: Webapi/probe/fields\n  adx_value: "probeid,title,quantity"\n- adx_name: Webapi/error/innererror\n  adx_value: "'+inner+'"\n');
 const file=path.join(source,'pack.mjs');await fs.writeFile(file,'export default {id:"reader-format",name:"Reader format",description:"Invented fixture",matches:()=>'+match+',presets:()=>({}),webApiErrorTemplates:'+JSON.stringify(capability())+'};');
 const app=await createSimulator({sourceDir:source,watch:false,dataPacks:register?[{id:'reader-format',module:file}]:[],observed:{webApiErrorDetails:'odata-wrapper',webApiErrorStacks:mode,evidence:'Invented loopback response capture and fresh variations'},initial:{mappings:{probe:{entitySet:'probes',idColumn:'probeid',schemaComplete:true,fields:{probeid:{dataverseType:'uniqueidentifier'},title:{dataverseType:'nvarchar'},quantity:{dataverseType:'int'}}}},tables:{probe:[{probeid:id,title:'Original',quantity:2}]},settings:{permissionMode:'permissive'}}});ownedFixture(t).add(()=>app.close());return app;
}
async function request(app,body,method='PATCH'){const r=await fetch(app.url+'/_api/probes'+(method==='POST'?'':'('+id+')'),{method,headers:{'content-type':'application/json',__RequestVerificationToken:app.state().csrf},body:JSON.stringify(body)});return{status:r.status,headers:Object.fromEntries(r.headers),body:r.status===204?null:await r.json()};}
test('registered matching pack formats POST/PATCH failures while writes, status and headers retain their behavior',async t=>{
 const app=await fixture(t),before=JSON.stringify(app.store.snapshot().tables);
 for(const method of ['POST','PATCH']){const r=await request(app,{quantity:'invalid'},method);assert.equal(r.status,400);assert.equal(r.body.error.code,'9004010D');assert.equal(r.body.error.innererror.message.endsWith(suffix),true);assert.match(r.headers['content-type'],/^application\/json/);assert.equal(JSON.stringify(app.store.snapshot().tables),before);}
 const unsupported=await request(app,{title:42});assert.equal(unsupported.status,400);assert.equal(unsupported.body.error.innererror.message.includes(suffix),false);
 assert.equal((await request(app,{title:'<script>synthetic</script>'})).status,204);assert.equal(app.store.snapshot().tables.probe[0].title,'<script>synthetic</script>');
 const csrf=await fetch(app.url+'/_api/probes('+id+')',{method:'PATCH',headers:{'content-type':'application/json'},body:'{"quantity":"invalid"}'});assert.equal(csrf.status,401);assert.equal(JSON.stringify(await csrf.json()).includes('Invented.Reader'),false);
});
for(const options of [{mode:'diagnostic'},{match:false},{register:false},{inner:false}])test('HTTP template requires explicit matching pack/site/innererror '+JSON.stringify(options),async t=>{const app=await fixture(t,options),r=await request(app,{quantity:'invalid'});assert.equal(r.status,400);assert.equal(JSON.stringify(r.body).includes('Invented.Reader'),false);});
