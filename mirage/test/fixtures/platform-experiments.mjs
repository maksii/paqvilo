import fs from 'node:fs/promises';
import path from 'node:path';
export const id='10000000-0000-4000-8000-000000000001';
export const xml=n=>`<fetch><entity name="item"><attribute name="itemid"/>${Array.from({length:n},(_,i)=>`<link-entity name="item" from="itemid" to="itemid" alias="j${i}"/>`).join('')}</entity></fetch>`;
export const initial=()=>({mappings:{item:{entitySet:'items',idColumn:'itemid'},annotation:{entitySet:'annotations',idColumn:'annotationid'},contact:{entitySet:'contacts',idColumn:'contactid'}},tables:{item:[{itemid:id,name:'Fixture'}],annotation:[],contact:[{contactid:id,fullname:'Local tester'}]},settings:{permissionMode:'permissive'},simulator:{mode:'local',pageMode:'local',identity:{roles:[]},endpoints:[]}});
export async function fixture(directory){
 const files={'website.yml':'adx_websiteid: site\nadx_name: Experiments',
 'web-pages/Home.webpage.yml':'adx_webpageid: home\nadx_partialurl: /\nadx_pagetemplateid: main',
 'page-templates/Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
 'web-templates/Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
 'web-templates/Main.webtemplate.source.html':'<html><body><h1>{{ snippets.Greeting }}</h1><p>{{ settings["Feature/Example"] }}</p></body></html>',
 'sitesetting.yml':"- adx_name: Feature/Example\n  adx_value: 'False'\n- adx_name: Webapi/item/enabled\n  adx_value: 'True'\n- adx_name: Webapi/item/fields\n  adx_value: 'itemid,name'\n- adx_name: Webapi/error/innererror\n  adx_value: 'True'",
 'content-snippets/Greeting.contentsnippet.yml':'adx_contentsnippetid: greeting\nadx_name: Greeting',
 'content-snippets/Greeting.contentsnippet.value.html':'Source greeting'};
 for(const [name,content]of Object.entries(files)){const file=path.join(directory,name);await fs.mkdir(path.dirname(file),{recursive:true});await fs.writeFile(file,content);}
}
