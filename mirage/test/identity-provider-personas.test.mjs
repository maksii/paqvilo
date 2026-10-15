import test from 'node:test';
import assert from 'node:assert/strict';
import {parse} from 'parse5';
import {startIdentityProvider} from '../lib/identity-provider.mjs';
import {identityProviderSettings,newUserPolicy} from '../lib/identity-provider-settings.mjs';

import {identityChooserFixture} from './fixtures/identity-chooser.mjs';
import {personaFixture} from './fixtures/persona-catalog.mjs';
import fs from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {loadConfig} from '../../lense/config.mjs';
import {identityProviderAssets} from '../lib/identity-provider-settings.mjs';
import {chooserSearch} from '../lib/persona-chooser.mjs';
const nodes=html=>{const all=[];const visit=node=>{all.push(node);for(const child of node.childNodes??[])visit(child);};visit(parse(html));return all;};
const attr=(node,name)=>node.attrs?.find(a=>a.name===name)?.value;

test('bounded account facets retain a selected value when URL spelling differs in case',()=>{
  const {report}=identityChooserFixture(250);
  report.personas.forEach((persona,index)=>persona.account={id:`account-${index}`,name:`Account ${index}`});
  for(const account of ['ACCOUNT-249','ACCOUNT 249']){
    const html=chooserSearch(report,new URLSearchParams({account}),'/', '');
    const selected=nodes(html).find(node=>node.tagName==='option'&&attr(node,'value')==='account-249');
    assert.ok(selected);assert.equal(attr(selected,'selected'),'');assert.match(html,/first 100 values/);
  }
});

for(const count of [500,5000])test(`identity chooser bounds markup and search at ${count} personas`,async t=>{
  const {users,report,provider,params}=identityChooserFixture(count);const idp=await startIdentityProvider({providers:()=>[provider],users:()=>users,personaCatalog:()=>report,registration:()=>({registration:false})});t.after(()=>idp.close());
  const url=new URL(idp.authority(provider)+'oauth2/authorize');url.search=new URLSearchParams(params);
  const started=performance.now(),response=await fetch(url),html=await response.text();assert.equal(response.status,200);assert.ok(performance.now()-started<500,'5000-person response must stay below 500ms');assert.ok(Buffer.byteLength(html)<=150000);
  const all=nodes(html);assert.equal(all.filter(n=>n.tagName==='form').length,2);assert.equal(all.filter(n=>n.tagName==='button'&&attr(n,'name')==='subject').length,50);assert.match(html,/Group 19/);assert.match(html,/Show more/);assert.doesNotMatch(html,/id="paqvilo-mirage-idp-create"/);
  url.searchParams.set('q','orsted unique');const filtered=await fetch(url).then(r=>r.text());assert.match(filtered,/1–1 of 1 matching/);assert.match(filtered,/Ørsted Unique/);assert.doesNotMatch(filtered,/name="subject" value="subject-1"/);
  url.searchParams.delete('q');url.searchParams.append('role','Reviewer');url.searchParams.append('tag','special');const narrowed=await fetch(url).then(r=>r.text());assert.match(narrowed,new RegExp(`of ${users.filter((u,i)=>i%2&&i%3===0).length} matching`));
  const forged=await fetch(url,{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,subject:'new',given_name:'New',family_name:'User',email:'new@example.test'})});assert.equal(forged.status,403);assert.match(await forged.text(),/Registration is disabled.*Enabled/);
  const signed=await fetch(url,{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({...params,subject:'subject-49'})});assert.equal(signed.status,302);assert.ok(new URL(signed.headers.get('location')).searchParams.get('code'));
  url.searchParams.set('prompt','create');assert.match(await fetch(url).then(r=>r.text()),/Forced registration test/);
});

test('registration modes and presentation settings are explicit and validated',()=>{
  assert.equal(newUserPolicy(identityProviderSettings(),{registration:false},{key:'Local'}).allowed,false);
  assert.equal(newUserPolicy(identityProviderSettings(),{registration:true,openRegistration:false,invitation:false},{key:'Local'}).allowed,false);
  assert.equal(newUserPolicy(identityProviderSettings({newUser:'always'}),{registration:false},{key:'Local'}).forced,true);
  assert.equal(newUserPolicy(identityProviderSettings({newUser:'never'}),{},{},{prompt:'create'}).allowed,false);
  for(const value of [{newUser:'maybe'},{presentation:'iframe'},{accentColor:'red;url(x)'},{head:{scripts:['https://external.example/x.js']} ,unexpected:true}])assert.throws(()=>identityProviderSettings(value));
});

test('runtime identity provider receives the effective state/pack catalogue and site registration flags',async t=>{
  const {app,call}=await personaFixture(t,{count:500,curated:490,groupCount:20});
  const settings={'Authentication/Registration/Enabled':'False','Authentication/Registration/LocalLoginEnabled':'False','Authentication/OpenIdConnect/Local/Authority':'https://idp.example.test/tenant/','Authentication/OpenIdConnect/Local/ClientId':'synthetic-client','Authentication/OpenIdConnect/Local/ResponseType':'id_token','Authentication/OpenIdConnect/Local/Scope':'openid profile'};
  const updated=await call('/config','PATCH',{portalOverrides:{settings},identity:{...app.state().config.identity,roles:[]}});assert.equal(updated.response.status,200,JSON.stringify(updated.value));
  const session=await fetch(app.url+'/_sim/api/session').then(r=>r.json()),provider=session.identityProvider.providers[0];assert.ok(provider);
  const challenge=await fetch(app.url+'/Account/Login/ExternalLogin?returnUrl=%2F',{method:'POST',redirect:'manual',headers:{'content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({provider:provider.id,__RequestVerificationToken:app.state().csrf})});assert.equal(challenge.status,302);
  const html=await fetch(challenge.headers.get('location')).then(r=>r.text());assert.match(html,/Group 19/);assert.match(html,/Default/);assert.match(html,/500 available/);assert.match(html,/Other contacts/);assert.doesNotMatch(html,/id="paqvilo-mirage-idp-create"/);assert.match(html,/Other contacts/);
});

test('catalogue/default chooser settings and project-local head assets are validated',async t=>{
  const parent=await fs.mkdtemp(path.join(tmpdir(),'chooser-project-'));t.after(()=>fs.rm(parent,{recursive:true,force:true}));const root=path.join(parent,'project');await fs.mkdir(root);await fs.writeFile(path.join(parent,'outside.css'),'body{}');await fs.writeFile(path.join(root,'identity.css'),'body{}');
  const file=path.join(root,'paqvilo.config.yml');await fs.writeFile(file,'defaults:\n  mirage:\n    identityProvider:\n      presentation: dialog\n      newUser: never\n      head:\n        stylesheets: [./identity.css]\nsites:\n  demo:\n    source: portal\n    environments:\n      dev: https://example.test\n');
  const cfg=await loadConfig({config:file,site:'demo'},{},{checkSource:false});assert.equal(cfg.mirageConfig.identityProvider.presentation,'dialog');assert.equal(cfg.mirageConfig.identityProvider.newUser,'never');
  assert.throws(()=>identityProviderAssets(identityProviderSettings({head:{stylesheets:['../outside.css']}}),root),/inside the project/);
  await fs.symlink(parent,path.join(root,'escape'),process.platform==='win32'?'junction':'dir');assert.throws(()=>identityProviderAssets(identityProviderSettings({head:{stylesheets:['escape/outside.css']}}),root),/inside the project/);
});
