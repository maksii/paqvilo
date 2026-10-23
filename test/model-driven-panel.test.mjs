import test from 'node:test';
import assert from 'node:assert/strict';
import { createModelDrivenOverlay } from '../lense/model-driven.mjs';
import { createModelDrivenPanelSources, modelDrivenPanelData, modelDrivenPanelUi } from '../lense/model-driven-panel.mjs';
import { modelDrivenComparisonAdmission } from '../lense/model-driven-inspector.mjs';
import { GitBaseline } from '../lense/git.mjs';
import { createFixture } from './fixture.mjs';
import { ownedFixture } from '../mirage/testing/owned-fixture.mjs';

const origin = 'http://127.0.0.1:1';
const imported = (count = 1) => ({ assets: new Map(Array.from({length:count}, (_, index) => {const name=`x_${index}.js`;return [name,{name,mime:'text/javascript',data:Buffer.from('raw local bytes') }];})), resources: Array.from({length:count},(_,index)=>({name:`x_${index}.js`})), diagnostics:[] });

test('canonical data keeps actual source revision and context inspection generation separate', () => {
  const state = { origin,token:'invented',revision:2,inspectionVersion:9,resources:[],catalogue:{forms:[]},diagnostics:[] };
  const data = modelDrivenPanelData(state,{cfg:{}});
  assert.equal(data.transport,'model-driven'); assert.equal(data.inspection.version,9);
  assert.equal(data.catalogVersion,2); assert.equal(data.keyCodes.hide,'KeyL');
  assert.equal(data.capabilities.actions,true);
  assert.deepEqual(modelDrivenPanelUi({tab:'actions',open:true,token:'discard',pos:{h:'left',v:'bottom',dx:-1,dy:1e9}}),{tab:'actions',open:true,pos:{h:'left',v:'bottom',dx:0,dy:100000}});
});

test('native comparisons use exact canonical encoded routes, known size and owned main frame only', () => {
  const overlay = createModelDrivenOverlay({origin,imported:imported(),mappings:[{path:'/%7b123%7d/webresources/x_0.js',resource:'x_0.js'}]});
  const frame = {}, page = {mainFrame:()=>frame};
  const response = (headers = {'content-length':'12'}, extra = {}) => ({status:()=>200,url:()=>origin+'/%7B123%7D/webresources/x_0.js?version=ignored',headers:()=>headers,request:()=>({method:()=> 'GET',frame:()=>frame}),...extra});
  const admit = value => modelDrivenComparisonAdmission(value,{origin,page,overlay});
  assert.deepEqual(admit(response()),{name:'x_0.js',length:12});
  for (const headers of [{},{'content-length':'3145729'},{'content-length':'12','content-encoding':'gzip'},{'content-length':'12','x-paqvilo-source':'local-solution'},{'content-length':'-1'}]) assert.equal(admit(response(headers)),null);
  assert.equal(admit(response(undefined,{request:()=>({method:()=> 'GET',frame:()=>({})})})),null);
  assert.equal(admit(response(undefined,{url:()=>origin+'/api/data/v9.2/x_0.js'})),null);
  assert.equal(admit(response(undefined,{url:()=> 'https://foreign.invalid/WebResources/x_0.js'})),null);
});

test('native response comparison is bounded by asset and session budgets, evicts equality and survives local revision changes honestly', async () => {
  const initial=imported(7), sources=await createModelDrivenPanelSources(initial);
  assert.equal(sources.diff('x_0.js','Online').ok,false);
  assert.equal(sources.observe('x_0.js',Buffer.from('raw local bytes')),true);
  assert.equal(sources.state.facts.get('x_0.js').differs,false);
  assert.equal(sources.state.facts.get('x_0.js').edited,undefined,'archive-only resources have no invented Git facts');
  assert.equal(sources.observe('x_0.js',Buffer.alloc(3*1024*1024+1)),false);
  for (let i=0;i<7;i++) sources.observe(`x_${i}.js`,Buffer.alloc(3*1024*1024,i));
  assert.ok(sources.observationSize().bytes<=16*1024*1024);
  assert.equal(sources.observationSize().resources,5);
  const next=imported(1); await sources.update(next);
  assert.equal(sources.observationSize().resources,0,'removed resources release native response memory');
  assert.throws(()=>sources.setScope('changed'),/readable Git HEAD/);
});


test('internal comparison markers are stripped on invalid, expired, wrong-resource and unmapped owned requests', async () => {
  const overlay = createModelDrivenOverlay({ origin, imported: imported(2) }); overlay.setOnline(true);
  const lease = overlay.nativeRead('x_0.js');
  for (const [url, token] of [['/api/data/v9.2/x_rows','invalid'],['/WebResources/x_1.js',lease.token],['/unmapped.js',lease.token],['/WebResources/x_0.js','expired']]) {
    const headers = { 'x-paqvilo-native-comparison': token }; let forwarded;
    await overlay.handle({ request: () => ({ url: () => origin + url, method: () => 'GET', headers: () => headers }),
      removeRequestHeader(name) { delete headers[name]; }, async fallback() { forwarded = { ...headers }; } });
    assert.equal(forwarded['x-paqvilo-native-comparison'], undefined);
  }
  lease.release();
});


test('diagnostics and native warning/request failure types satisfy the shared Issues contract', () => {
  const state = { origin, token: 'invented', revision: 1, inspectionVersion: 1,
    resources: [{name:'x_pcf/bundle.js',unbound:true}], diagnostics:[{code:'INVENTED',message:'Requires an observed mapping.'}],
    problems: [{type:'warning',text:'Native console warning'}, {type:'requestfailed',text:'net::ERR_FAILED'}, {type:'pageerror',text:'Native exception'}] };
  const data = modelDrivenPanelData(state,{cfg:{}});
  assert.ok(data.notes.every(note=>typeof note.reason==='string'&&note.reason.length>0));
  assert.deepEqual(data.problems.map(problem=>problem.type),['warning','failed','error']);
});

test('overlapping real Git source updates retain only the latest catalogue and coalesce pending revisions', { timeout: 15000 }, async t => {
  const fixture = createFixture();
  const owner = ownedFixture(t);
  owner.remove(() => fixture.cleanup());
  const firstFile = 'web-files/source-a.js';
  const latestFile = 'web-files/source-b.js';
  fixture.write(firstFile, 'window.sourceA = 1;');
  fixture.write(latestFile, 'window.sourceB = 1;');
  fixture.commit();
  const catalogue = (name, file, body) => ({
    assets: new Map([[name, { name, file: fixture.file(file), mime: 'text/javascript', data: Buffer.from(body) }]]),
    layers: [{ dir: fixture.dir, documents: [] }],
  });
  const first = catalogue('x_a.js', firstFile, 'window.sourceA = 1;');
  const sources = await createModelDrivenPanelSources(first);
  let enter, release;
  const entered = new Promise(resolve => { enter = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const read = GitBaseline.prototype.changedFilesAsync;
  let reads = 0;
  t.mock.method(GitBaseline.prototype, 'changedFilesAsync', async function (...args) {
    reads++;
    if (reads === 1) { enter(); await gate; }
    return read.apply(this, args);
  });
  const updates = [];
  owner.add(async () => { release(); await Promise.all(updates); });
  updates.push(sources.update(first));
  await entered;
  for (let revision = 0; revision < 20; revision++) {
    const body = `window.sourceB = ${revision + 2};`;
    fixture.write(latestFile, body);
    updates.push(sources.update(catalogue('x_b.js', latestFile, body)));
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(reads, 1, 'a pending Git read cannot publish a concurrent obsolete catalogue');
  release();
  await Promise.all(updates);
  assert.equal(reads, 2, 'the running revision is followed by only the latest pending revision');
  assert.deepEqual([...sources.state.facts.keys()], ['x_b.js']);
  assert.doesNotThrow(() => sources.setScope('changed'));
  assert.deepEqual([...sources.changed()], ['x_b.js']);
  const diff = sources.diff('x_b.js', 'Online');
  assert.equal(diff.ok, true);
  assert.equal(diff.against, 'Git HEAD');
  assert.ok(diff.added > 0, 'the latest actual source edit is compared with its committed Git bytes');
});


test('only exact owned resource locations become source links and browser positions become one-based', () => {
  const state={origin,token:'invented',revision:1,inspectionVersion:1,resources:[{name:'x_0.js',paths:['/{2026}/webresources/x_0.js']}],diagnostics:[],
    problems:[{type:'error',text:'Mapped',url:origin+'/%7b2026%7d/webresources/x_0.js?redacted',line:0,col:4},
      {type:'error',text:'Native',url:origin+'/native.js?redacted',line:0,col:0},
      {type:'error',text:'Foreign',url:'https://foreign.invalid/{2026}/webresources/x_0.js',line:0,col:0}]};
  const data=modelDrivenPanelData(state,{cfg:{}});
  assert.equal(data.problems[0].rel,'x_0.js');assert.equal(data.problems[0].line,1);assert.equal(data.problems[0].col,5);
  for(const item of data.problems.slice(1)){assert.equal(item.rel,undefined);assert.ok(item.where);assert.equal(item.where.includes('?'),false);}
});


test('bound text MIME enables native Diff before Git or native bytes exist, including extensionless resources', () => {
  const data=modelDrivenPanelData({origin,token:'invented',revision:1,resources:[
    {name:'x_script',mime:'application/javascript',currentRevisionApplied:1,paths:['/WebResources/x_script']},
    {name:'x_image.js',mime:'image/png',currentRevisionApplied:1,paths:['/WebResources/x_image.js']},
    {name:'x_pcf/bundle.js',mime:'text/javascript',currentRevisionApplied:0,unbound:true}],diagnostics:[]},{cfg:{}});
  assert.equal(data.items[0].canDiff,true);assert.equal(data.items[0].group,'js');assert.equal(data.items[1].canDiff,false);assert.equal(data.unobserved[0].canDiff,false);
  const source=imported();source.assets=new Map([['x_script',{name:'x_script',mime:'application/javascript',data:Buffer.from('/* source */')}]]);source.resources=[{name:'x_script'}];
  const overlay=createModelDrivenOverlay({origin,imported:source});const lease=overlay.nativeRead('x_script');assert.equal(lease.path,'/WebResources/x_script');lease.release();
});
