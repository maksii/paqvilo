import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {pathToFileURL} from 'node:url';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../lib/browser-launch.mjs';
import {createSimulator} from '../server.mjs';
import {importPortal} from '../lib/importer.mjs';
import {inspectPage} from '../lib/page-resources.mjs';
import {enrichInspection} from '../../lense/source-inspection.mjs';
import { ownedFixture } from "../testing/owned-fixture.mjs";

let browser;
before(async () => { browser = await chromium.launch(browserLaunchOptions({ headless: true })); });
after(() => browser?.close());

async function fixture(t,body,extraFiles={},options={}){
  const root=await fs.mkdtemp(path.join(tmpdir(),'mirage-platform-scripts-'));ownedFixture(t).remove(()=>fs.rm(root,{recursive:true,force:true}));
  const files={'website.yml':'adx_websiteid: site\nadx_name: Invented platform',
    'Home.webpage.yml':'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_pagetemplateid: main',
    'Scripts.webpage.yml':'adx_webpageid: scripts\nadx_name: Scripts\nadx_partialurl: scripts\nadx_parentpageid: home',
    'Main.pagetemplate.yml':'adx_pagetemplateid: main\nadx_webtemplateid: main\nadx_usewebsiteheaderandfooter: false',
    'Main.webtemplate.yml':'adx_webtemplateid: main\nadx_name: Main',
    'Main.webtemplate.source.html':body,
    'Home.webpage.copy.html':'<script>window.pageCopyMarker = 1;</script>',
    'web-files/a.js':'window.assetMarker = 1;\nwindow.assetMarker++;',
    'web-files/a.js.webfile.yml':'adx_webfileid: script\nadx_name: a.js\nadx_partialurl: a.js\nadx_parentpageid: scripts\nfilename: a.js',
    'web-files/a.css':'body { color: rgb(1, 2, 3); }',
    'web-files/a.css.webfile.yml':'adx_webfileid: style\nadx_name: a.css\nadx_partialurl: a.css\nadx_parentpageid: scripts\nfilename: a.css',...extraFiles};
  for(const [file,text]of Object.entries(files)){await fs.mkdir(path.dirname(path.join(root,file)),{recursive:true});await fs.writeFile(path.join(root,file),text);}
  const app=await createSimulator({sourceDir:root,watch:false,...options});ownedFixture(t).add(()=>app.close());
  const context=await browser.newContext();ownedFixture(t).add(()=>context.close());const page=await context.newPage();
  return {app,page,root};
}

test('preform guards jQuery class fast paths across form iframe documents and the Bootstrap 5 fallback supplies timeago',async t=>{
  const {app,page}=await fixture(t,'<html><head><script src="/resource/powerappsportal/dist/preform.BootstrapV5.moment_2_29_4.bundle-abcdef.js"></script><script src="/resource/powerappsportal/dist/postpreform.BootstrapV5.bundle-abcdef.js"></script></head><body><abbr class="timeago" title="2020-01-01T00:00:00Z">Date</abbr><div class="form-control"></div><script>jQuery.timeago.settings.strings.suffixAgo="earlier";</script></body></html>');
  const errors=[];page.on('pageerror',error=>errors.push(error.message));await page.goto(app.url);
  const result=await page.evaluate(async()=>{
    const iframe=document.createElement('iframe');iframe.srcdoc='<div class="actions"></div><div class="view-toolbar grid-actions"><input class="query"></div><div class="toolbar-actions"></div><div class="a b actions"></div>';document.body.append(iframe);await new Promise(resolve=>(iframe.onload=resolve));
    const doc=iframe.contentDocument;doc.getElementsByClassName=function(name){const pattern=new RegExp('\\b'+name+'\\b');return [...this.querySelectorAll('*')].filter(element=>pattern.test(element.className));};
    const selected=window.jQuery(iframe).contents().find('.actions');selected.hide();
    return {count:selected.length,toolbar:doc.querySelector('.view-toolbar').style.display,fillable:getComputedStyle(doc.querySelector('input')).display!=='none',elementCount:window.jQuery(doc.body).find('.actions').length,compound:window.jQuery(doc).find('div.actions').length,multiple:window.jQuery(doc).find('.a.b').length,expr:window.jQuery.expr.find.CLASS('actions',doc).length,timeago:typeof window.jQuery.timeago,relative:document.querySelector('abbr').textContent,strings:window.jQuery.timeago.settings.strings.suffixAgo};
  });
  assert.deepEqual({...result,relative:null},{count:2,toolbar:'',fillable:true,elementCount:2,compound:2,multiple:1,expr:2,timeago:'function',relative:null,strings:'earlier'});assert.match(result.relative,/earlier/);assert.deepEqual(errors,[]);
  await page.addScriptTag({url:app.url+'/xrm-adx/js/crmentityformview.js'});
  const direct=await page.evaluate(()=>({array:Array.isArray(document.getElementsByClassName('control')),found:document.getElementsByClassName('control').some(element=>element.classList.contains('form-control')),iframeCount:window.jQuery(document.querySelector('iframe')).contents().find('.actions').length}));
  assert.deepEqual(direct,{array:true,found:true,iframeCount:2});
  assert.deepEqual(await page.evaluate(()=>{
    const element=document.createElement('div');element.className='123';document.body.append(element);
    return {numeric:window.jQuery(document).find('.123').length,invalidContext:window.jQuery.find('.actions',window).length};
  }),{numeric:1,invalidContext:0});
});

test('exported scripts and styles carry file maps and CDP binds a breakpoint to a nested web-file export URL',async t=>{
  const source='<html><body>\n<script>window.templateMarker = 1;</script>\n<script src="/scripts/a.js"></script>{% include "Page Copy" %}</body></html>';
  const {app,page,root}=await fixture(t,source),jsFile=path.join(root,'web-files/a.js'),templateFile=path.join(root,'Main.webtemplate.source.html');
  const response=await fetch(app.url+'/scripts/a.js'),javascript=await response.text();
  assert.ok(javascript.startsWith(await fs.readFile(jsFile,'utf8')));assert.equal(Number(response.headers.get('content-length')),Buffer.byteLength(javascript));
  const decode=text=>JSON.parse(Buffer.from(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([A-Za-z0-9+/=]+)/.exec(text)[1],'base64'));
  assert.deepEqual(decode(javascript).sources,[pathToFileURL(jsFile).href]);
  const css=await (await fetch(app.url+'/scripts/a.css')).text();assert.deepEqual(decode(css).sources,[pathToFileURL(path.join(root,'web-files/a.css')).href]);assert.ok(css.endsWith(' */\n'));
  const cdp=await page.context().newCDPSession(page),parsed=[];await cdp.send('Debugger.enable');cdp.on('Debugger.scriptParsed',event=>parsed.push(event));
  const breakpoint=await cdp.send('Debugger.setBreakpointByUrl',{url:pathToFileURL(jsFile).href,lineNumber:0});
  let hit=false;cdp.on('Debugger.paused',event=>{if(event.hitBreakpoints.includes(breakpoint.breakpointId))hit=true;void cdp.send('Debugger.resume');});
  await page.goto(app.url);assert.equal(hit,true);assert.equal(await page.evaluate(()=>window.assetMarker),2);
  const template=parsed.find(event=>event.url===pathToFileURL(templateFile).href+'?inline=1');assert.ok(template?.hasSourceURL);assert.ok(template.sourceMapURL.startsWith('data:application/json'));
  assert.deepEqual(JSON.parse(Buffer.from(template.sourceMapURL.split(',')[1],'base64')).sources,[pathToFileURL(templateFile).href]);
  const copy=parsed.find(event=>event.url===pathToFileURL(path.join(root,'Home.webpage.copy.html')).href+'?inline=1');
  assert.ok(copy?.hasSourceURL);assert.equal(await page.evaluate(()=>window.pageCopyMarker),1);
});

test('inline template blocks have stable distinct debugger URLs and a breakpoint hits only its selected block',async t=>{
  const {app,page,root}=await fixture(t,'<script>window.inlineOne=1;</script>\n<script>window.inlineTwo=2;</script>');
  const file=pathToFileURL(path.join(root,'Main.webtemplate.source.html')).href,cdp=await page.context().newCDPSession(page),parsed=[],paused=[];
  await cdp.send('Debugger.enable');cdp.on('Debugger.scriptParsed',event=>{if(event.url.startsWith(file))parsed.push(event);});
  const breakpoint=await cdp.send('Debugger.setBreakpointByUrl',{url:file+'?inline=2',lineNumber:0});
  cdp.on('Debugger.paused',event=>{paused.push(event);void cdp.send('Debugger.resume');});
  await page.goto(app.url);
  assert.deepEqual(parsed.map(event=>event.url),[file+'?inline=1',file+'?inline=2']);
  assert.equal(paused.length,1);assert.ok(paused[0].hitBreakpoints.includes(breakpoint.breakpointId));
  assert.equal(parsed.find(event=>event.scriptId===paused[0].callFrames[0].location.scriptId).url,file+'?inline=2');
  for(const event of parsed)assert.deepEqual(JSON.parse(Buffer.from(event.sourceMapURL.split(',')[1],'base64')).sources,[file]);
});

test('list scripts and extensionless assets retain debugger provenance and declared MIME kinds',async t=>{
  const body='<script src="/logic"></script><link rel="stylesheet" href="/styles"><img src="/picture">{% include "entity_list" key:"Cards" %}';
  const {app,page,root}=await fixture(t,body,{
    'Cards.list.yml':'adx_entitylistid: cards\nadx_name: Cards\nadx_entityname: item',
    'Cards.list.custom_javascript.js':'window.listMarker=1;\nwindow.listMarker++;',
    'web-files/logic':'window.extensionlessMarker=1;',
    'web-files/logic.webfile.yml':'adx_webfileid: logic\nadx_name: Logic\nadx_partialurl: logic\nfilename: logic\nadx_mimetype: application/javascript',
    'web-files/styles':'body { color: rgb(1, 2, 3); }',
    'web-files/styles.webfile.yml':'adx_webfileid: styles\nadx_name: Styles\nadx_partialurl: styles\nfilename: styles\nadx_mimetype: text/css',
    'web-files/picture':Buffer.from([137,80,78,71,13,10,26,10]),
    'web-files/picture.webfile.yml':'adx_webfileid: picture\nadx_name: Picture\nadx_partialurl: picture\nfilename: picture\nadx_mimetype: image/png',
  },{initial:{settings:{permissionMode:'permissive'},mappings:{item:{entitySet:'items',idColumn:'itemid'}},tables:{item:[]},simulator:{componentSchemas:{cards:{entity:'item',fields:[{name:'name'}]}}}}});
  const css=await fetch(app.url+'/styles'),text=await css.text();assert.match(css.headers.get('content-type'),/^text\/css/);
  const cssMap=JSON.parse(Buffer.from(/sourceMappingURL=data:application\/json;charset=utf-8;base64,([\w+/=]+)/.exec(text)[1],'base64'));assert.deepEqual(cssMap.sources,[pathToFileURL(path.join(root,'web-files/styles')).href]);
  const file=pathToFileURL(path.join(root,'Cards.list.custom_javascript.js')).href,cdp=await page.context().newCDPSession(page),parsed=[];
  assert.match(await (await fetch(app.url)).text(),/window.listMarker/);
  await cdp.send('Debugger.enable');cdp.on('Debugger.scriptParsed',event=>parsed.push(event));
  const breakpoint=await cdp.send('Debugger.setBreakpointByUrl',{url:file,lineNumber:1});let hits=0;cdp.on('Debugger.paused',event=>{if(event.hitBreakpoints.includes(breakpoint.breakpointId))hits++;void cdp.send('Debugger.resume');});
  await page.goto(app.url);assert.equal(hits,1);assert.equal(await page.evaluate(()=>window.listMarker),2);assert.equal(await page.evaluate(()=>window.extensionlessMarker),1);assert.ok(parsed.some(event=>event.url===file&&event.sourceMapURL));
  const portal=await importPortal(root),report=await enrichInspection(inspectPage(portal,'/'),portal);
  assert.equal(report.assets.find(asset=>asset.url==='/picture').kind,'image');assert.equal(report.assets.find(asset=>asset.url==='/styles').kind,'stylesheet');
});

test('timeago updates time elements, retains dates across title changes, and honours locale and future settings',async t=>{
  const {app,page}=await fixture(t,'<html><head><script src="/resource/powerappsportal/dist/preform.BootstrapV5.moment_2_29_4.bundle-abcdef.js"></script><script src="/resource/powerappsportal/dist/postpreform.BootstrapV5.bundle-abcdef.js"></script></head><body></body></html>');
  await page.goto(app.url);
  const result=await page.evaluate(()=>{
    const $=window.jQuery,ago=$.timeago;ago.settings.refreshMillis=0;
    const date=new Date(Date.now()-5*60000),time=document.createElement('time');time.dateTime=new Date(Date.now()-86400000).toISOString();time.textContent='Original date';document.body.append(time);
    $(time).timeago().timeago('update',date);const updated=time.textContent;
    time.dateTime=new Date(Date.now()-2*86400000).toISOString();$(time).timeago('updateFromDOM');const fromDOM=time.textContent;
    const abbr=document.createElement('abbr');abbr.title=date.toISOString();abbr.textContent='Original title';document.body.append(abbr);$(abbr).timeago();const first=abbr.textContent;$(abbr).timeago();const repeated=abbr.textContent;
    ago.settings.allowFuture=false;const futureDisabled=ago.inWords(-300000);ago.settings.allowFuture=true;const futureEnabled=ago.inWords(-300000);
    ago.settings.strings.minutes=()=>'%d ticks';ago.settings.strings.numbers[5]='five';const localized=ago.inWords(300000);
    return {updated,fromDOM,first,repeated,futureDisabled,futureEnabled,localized,numeric:ago(date.getTime()),element:ago(time)};
  });
  assert.deepEqual(result,{updated:'5 minutes ago',fromDOM:'2 days ago',first:'5 minutes ago',repeated:'5 minutes ago',futureDisabled:'5 minutes ago',futureEnabled:'5 minutes from now',localized:'five ticks ago',numeric:'five ticks ago',element:'2 days ago'});
});
