// Invented loopback-only exports. Run serially to assess budgets, not with the full test suite.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import {once} from 'node:events';
import {performance} from 'node:perf_hooks';
import {parseArgs} from 'node:util';
import {chromium} from 'playwright-core';
import {browserLaunchOptions} from '../mirage/lib/browser-launch.mjs';
import {OverlaySession} from '../lense/session.mjs';
import {attachSession} from '../lense/browser.mjs';
import {enablePanel} from '../lense/panel.mjs';
import {importPortal} from '../mirage/lib/importer.mjs';
import {inspectionFixture} from '../test/source-inspection-fixture.mjs';
import {SITE} from '../test/fixture.mjs';

const {values}=parseArgs({options:{samples:{type:'string',default:'3'},strict:{type:'boolean'},json:{type:'boolean'}}});
if(!/^[1-5]$/.test(values.samples))throw new Error('--samples must be from 1 to 5');
const browser=await chromium.launch(browserLaunchOptions({headless:true,args:['--disable-background-networking']}));
const samples=[];
async function run(large,index){
  const fx=inspectionFixture();let context,panel,detach,server;
  try{
    const used=Array.from({length:3},(_,i)=>({adx_webtemplateid:'used-'+i,adx_name:'Used '+i,adx_source:`<section id="used-${i}">${'<b class="used-detail">Invented</b>'.repeat(20)}</section>`}));
    const unused=Array.from({length:large?395:0},(_,i)=>({adx_webtemplateid:'unused-'+i,adx_name:'Unused '+i,adx_source:Array.from({length:20},(_,j)=>`<i class="unused-${index}-${i}-${j}"></i>`).join('')}));
    fs.writeFileSync(path.join(fx.portal,'webtemplate.yml'),JSON.stringify([...used,...unused]));
    const dynamic='<aside id="dynamic-banner"><span class="dynamic-message">Invented</span></aside>';
    fs.writeFileSync(path.join(fx.portal,'contentsnippet.yml'),JSON.stringify([{adx_contentsnippetid:'dynamic',adx_name:'Dynamic notice',adx_value:dynamic},...Array.from({length:large?598:0},(_,i)=>({adx_contentsnippetid:'unused-'+i,adx_name:'Unused snippet '+i,adx_value:Array.from({length:20},(_,j)=>`<i class="unused-snippet-${index}-${i}-${j}"></i>`).join('')}))]));
    fs.appendFileSync(path.join(fx.portal,'web-pages/home/Home.webpage.copy.html'),used.map(row=>`{% include '${row.adx_name}' %}`).join(''));
    const html=`<!doctype html><style>body{padding:100px}section{margin:10px}b{display:inline-block;padding:4px}</style>${used.map(row=>row.adx_source).join('')}<main></main><script>document.querySelector('main').innerHTML=${JSON.stringify(dynamic)}</script>`;
    server=http.createServer((req,res)=>res.writeHead(200,{'content-type':'text/html'}).end(html));server.listen(0,'127.0.0.1');await once(server,'listening');
    const origin=`http://127.0.0.1:${server.address().port}`;
    context=await browser.newContext({viewport:{width:1400,height:1000},serviceWorkers:'block'});context.setDefaultTimeout(15_000);
    await context.route('**/*',route=>new URL(route.request().url()).origin===origin?route.fallback():route.abort());
    await context.addInitScript(()=>{window.addEventListener('keydown',e=>{if(e.altKey&&e.shiftKey&&e.code==='KeyX')window.toggleStarted=performance.now();},{capture:true});});
    const session=new OverlaySession({sourceDir:fx.portal,origin,site:structuredClone(SITE),sourceMaps:false,siteName:'Synthetic X-ray benchmark',envName:'loopback',stateDir:fx.work,browser:{}});
    detach=await attachSession(context,session);panel=enablePanel(context,session,{open:async()=>null});
    const page=await context.newPage();const navigation=performance.now();await page.goto(origin);await page.locator('#paqvilo-panel').waitFor();const navigationToPanelMs=performance.now()-navigation;
    const toggle=async()=>{
      await page.keyboard.press('Alt+Shift+X');
      await page.waitForFunction(()=>{const host=document.getElementById('paqvilo-xray');return host?.__px.enabled&&host.shadowRoot.querySelector('.ui').getAttribute('aria-busy')==='false'&&host.__px.identify(document.getElementById('dynamic-banner')).title==='Dynamic notice';});
      return page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve(performance.now()-window.toggleStarted)))));
    };
    const coldToggleMs=await toggle();
    const identification=await page.evaluate(()=>{const api=document.getElementById('paqvilo-xray').__px,node=document.querySelector('.dynamic-message');let identity;const start=performance.now();for(let n=0;n<100;n++)identity=api.identify(node);return {ms:(performance.now()-start)/100,title:identity.title};});
    await page.keyboard.press('Alt+Shift+X');const revisitMs=await toggle();
    await page.evaluate(()=>{const ui=document.getElementById('paqvilo-xray').shadowRoot.querySelector('.ui');let busy=false;window.refreshMs=null;const start=performance.now(),observer=new MutationObserver(()=>{if(ui.getAttribute('aria-busy')==='true')busy=true;else if(busy){window.refreshMs=performance.now()-start;observer.disconnect();}});observer.observe(ui,{attributes:true,attributeFilter:['aria-busy']});document.getElementById('paqvilo-xray').shadowRoot.querySelector('[data-action=refresh]').click();});
    await page.waitForFunction(()=>window.refreshMs!==null);
    const refreshMs=await page.evaluate(()=>window.refreshMs);
    const imported=await importPortal(fx.portal);const counts={templates:new Set(Object.values(imported.templates)).size,snippets:Object.keys(imported.snippets).length};
    if(counts.templates!==(large?400:5)||counts.snippets!==(large?600:2))throw new Error('Benchmark source count mismatch');
    return {large,counts,navigationToPanelMs,coldToggleMs,revisitMs,refreshMs,identification};
  }finally{await panel?.dispose();await detach?.();await context?.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}fx.cleanup();}
}
try{
  for(let index=0;index<Number(values.samples);index++){samples.push({small:await run(false,index),large:await run(true,index)});}
  const findings=samples.flatMap((pair,index)=>Object.entries(pair).flatMap(([size,row])=>[
    ...(row.coldToggleMs>1000?[`${index+1} ${size}: cold toggle ${row.coldToggleMs.toFixed(1)} ms exceeds 1000 ms`]:[]),
    ...(row.revisitMs>=200?[`${index+1} ${size}: revisit ${row.revisitMs.toFixed(1)} ms reaches 200 ms`]:[]),
    ...(row.identification.ms>=5?[`${index+1} ${size}: identification reaches 5 ms`]:[]),
  ]));
  const report={scope:'Invented loopback sources only; no live data or origins',samples,findings,note:'Cold means first toggle in a new browser context and inspector. Navigation already starts the source report. Times start at trusted keydown and end after source identity plus two animation frames. Browser launch, synthetic fixture generation and automation dispatch precede this interval; navigation-to-panel is measured separately. OS caches and concurrent work affect results; this is not an arbitrary-export latency guarantee.'};
  console.log(JSON.stringify(report,null,2));
  if(values.strict&&findings.length)process.exitCode=1;
}finally{await browser.close();}
