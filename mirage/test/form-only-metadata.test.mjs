import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createSimulator} from '../server.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

test('runtime imports portal-referenced standalone FormXml without an Entity.xml table definition',async t=>{
 const root=await fs.mkdtemp(path.join(os.tmpdir(),'form-only-metadata-'));ownedFixture(t).remove(()=>fs.rm(root,{recursive:true,force:true}));
 const files={
  'portal/website.yml':'adx_websiteid: 77777777-7777-4777-8777-777777777791\nadx_name: Invented standalone form',
  'portal/Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: page',
  'portal/Page.pagetemplate.yml':'adx_pagetemplateid: page\nadx_webtemplateid: content',
  'portal/Content.webtemplate.yml':'adx_webtemplateid: content\nadx_name: Content',
  'portal/Content.webtemplate.source.html':"{% entityform name: 'Standalone' %}",
  'portal/Standalone.basicform.yml':'adx_entityformid: standalone\nadx_name: Standalone\nadx_entityname: exa_partial\nadx_formname: Exported standalone\nadx_mode: 100000000\nadx_entitypermissionsenabled: false',
  'portal/webrole.yml':'- adx_webroleid: anonymous\n  adx_name: Visitors\n  adx_anonymoususersrole: true',
  'portal/Create.tablepermission.yml':'adx_entitypermissionid: create\nadx_entitylogicalname: exa_partial\nadx_scope: 756150000\nadx_create: true\nadx_entitypermission_webrole:\n- anonymous',
  // The other table makes the runtime table selection nonempty; its Entity.xml must not hide the portal's form-only table.
  'solution/Entities/exa_anchor/Entity.xml':'<Entity><Name>exa_anchor</Name><EntityInfo><entity Name="exa_anchor"><attributes><attribute PhysicalName="exa_name"><Name>exa_name</Name><Type>nvarchar</Type></attribute></attributes></entity></EntityInfo></Entity>',
  'solution/Entities/exa_partial/FormXml/main/standalone.xml':'<systemform><formid>77777777-7777-4777-8777-777777777792</formid><type>2</type><form><tabs><tab name="general"><columns><column><sections><section name="authored"><rows><row><cell><labels><label languagecode="1033" description="Authored standalone field"/></labels><control id="exa_label" datafieldname="exa_label" classid="{4273EDBD-AC1D-40D3-9FB2-095C621B552D}"/></cell></row></rows></section></sections></column></columns></tab></tabs></form><LocalizedNames><LocalizedName description="Exported standalone" languagecode="1033"/></LocalizedNames></systemform>',
 };
 for(const [name,body]of Object.entries(files)){const file=path.join(root,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,body);}
 const sim=await createSimulator({sourceDir:path.join(root,'portal'),solutionRoots:[path.join(root,'solution')],stateFile:path.join(root,'state.json'),initial:{mappings:{exa_partial:{entitySet:'exa_partials',idColumn:'exa_partialid',nameColumn:'exa_label'}},tables:{exa_partial:[]},settings:{permissionMode:'permissive'}},watch:false,port:0});ownedFixture(t).add(()=>sim.close());
 const response=await fetch(sim.url),html=await response.text();assert.equal(response.status,200);
 const diagnostics=(await(await fetch(sim.url+'/_sim/api/diagnostics')).json()).diagnostics;
 assert.ok(html.includes('Authored standalone field'),'the authored standalone field label is rendered');assert.ok(html.includes('id="exa_label"'),'the authored field is rendered');
 assert.ok(!diagnostics.some(row=>['SYSTEMFORM_UNRESOLVED','COMPONENT_SCHEMA_REQUIRED'].includes(row.code)),JSON.stringify(diagnostics));
});
