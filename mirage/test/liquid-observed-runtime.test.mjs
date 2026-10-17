import test from 'node:test';
import assert from 'node:assert/strict';
import { createPortalRenderer } from '../lib/liquid.mjs';
import { LiquidHash } from '../lib/liquid-engine.mjs';

const renderer = (mode) => createPortalRenderer({ templates:{}, snippets:{}, settings:{}, pages:[], webFiles:[], records:[], website:{}, weblinks:{}, sitemarkers:{}, pageTemplates:[], observed:{liquidRuntimeCompatibility:mode} });

test('observed runtime uses the verified blank predicate and string-array index errors', async () => {
  const engine=renderer('observed');
  assert.equal(await engine.renderString("{% if '' == blank %}T{% endif %}|{% if ' ' == blank %}T{% endif %}|{% if nil == blank %}T{% endif %}|{% if false == blank %}T{% endif %}"),'T|||');
  assert.equal(await engine.renderString("{% assign a = 'zero,one' | split: ',' %}[{{ a[0] }}]|[{{ a[-1] }}]|[{{ a[99] }}]|[{{ a['1'] }}]|[{{ a[1.5] }}]"),'[zero]|[Liquid error: Index was outside the bounds of the array.]|[Liquid error: Index was outside the bounds of the array.]|[]|[]');
  assert.equal(await renderer('dotliquid').renderString("{% assign a = 'zero,one' | split: ',' %}[{{ a[-1] }}]|[{{ a[99] }}]|{% if nil == blank %}T{% endif %}"),'[one]|[]|T');
});

test('observed runtime preserves hosted parse and parenthesized-condition behavior', async () => {
  const source="{% for i in (3..1) %}{{ i }}{% else %}empty{% endfor %}";
  assert.equal(await renderer('observed').renderString(source),'for tag does not expect else tag');
  assert.equal(await renderer('dotliquid').renderString(source),'empty');
  assert.equal(await renderer('observed').renderString('{% if (true or false) %}marker{% endif %}'),'');
  assert.equal(await renderer('dotliquid').renderString('{% if (true or false) %}marker{% endif %}'),'marker');
  assert.equal(await renderer('observed').renderString('{% increment probe %}'),"Unknown tag 'increment'");
  assert.equal(await renderer('observed').renderString('{% decrement probe %}'),"Unknown tag 'decrement'");
  assert.equal(await renderer('observed').renderString("{% liquid\nassign probe = 'value'\n%}"), "Tag '{%' was not properly terminated with regexp: (?-mix:\\%\\})");
  assert.equal(await renderer('observed').renderString("{{ 'first\nsecond' }}"), "Variable '{{' was not properly terminated with regexp: (?-mix:\\}\\})");
});

test('observed request encoding follows direct aliases and resets after literal assignment and capture', async () => {
  const engine=renderer('observed');
  const context=engine.contextForPage({id:'00000000-0000-4000-8000-000000000001',url:'/',metadata:{}},'/?probe=a%26b%22c');
  const source="{{ params.probe }}|{{ request.params.probe }}|{% assign alias = request.params.probe %}{{ alias }}|{{ alias | escape }}|{% assign alias = 'literal & text' %}{{ alias }}|{% capture alias %}{{ params.probe }}{% endcapture %}{{ alias }}";
  assert.equal(await engine.renderString(source,context),'a&amp;b&quot;c|a&amp;b&quot;c|a&amp;b&quot;c|a&amp;b&quot;c|literal & text|a&amp;b&quot;c');
});

test('current-page editable rendering derives distinct root and content metadata while keeping defaults', async () => {
  const websiteId='10000000-0000-4000-8000-000000000001',rootId='20000000-0000-4000-8000-000000000001',contentId='30000000-0000-4000-8000-000000000001';
  const portal={templates:{},snippets:{},settings:{},pages:[],webFiles:[],records:[],website:{id:websiteId},weblinks:{},sitemarkers:{},pageTemplates:[]};
  const page={id:rootId,title:'Fixture',url:'/fixture/',metadata:{adx_webpageid:contentId}};
  const engine=createPortalRenderer(portal,{observed:{liquidEditableMetadata:'observed'}});
  const source="{% editable page 'adx_title' type:'text' %}";
  const html=await engine.renderString(source,engine.contextForPage(page,'/fixture/'));
  assert.ok(html.includes('/adx_webpage/'+contentId+'/adx_title'));
  assert.ok(html.includes('working='+Buffer.from('adx_webpage:'+rootId+':False').toString('base64')));
  assert.ok(html.endsWith('<div class="xrm-attribute-value">Fixture</div></div>'));
  const defaults=createPortalRenderer(portal);
  assert.equal(await defaults.renderString(source,defaults.contextForPage(page,'/fixture/')),'<div class="xrm-editable-text&#32;xrm-attribute"><div class="xrm-attribute-value">Fixture</div></div>');
});

test('observed request pairs keep known parameters but reject numeric entry indexing', async () => {
  const source="[{{ request.params.size }}]|{% for pair in request.params %}[{{ pair[0] | escape }}:{{ pair | size }}]{% endfor %}|{{ params.probe }}";
  const page={id:'00000000-0000-4000-8000-000000000001',url:'/',metadata:{}};
  const observed=renderer('observed'),defaults=renderer('dotliquid');
  assert.equal(await observed.renderString(source,observed.contextForPage(page,'/?probe=synthetic')),'[1]|[:0]|synthetic');
  assert.equal(await defaults.renderString(source,defaults.contextForPage(page,'/?probe=synthetic')),'[1]|[probe:0]|synthetic');
  assert.equal(await observed.renderString("{% for pair in fixture %}{{ pair[0] }}{% endfor %}",{fixture:new LiquidHash({probe:'synthetic'})}),'probe');
});

test('observed parameter loops hide the verified pair accessors while direct lookup and aliases work', async () => {
  const engine=renderer('observed');
  const page={id:'00000000-0000-4000-8000-000000000001',url:'/',metadata:{}};
  const context=engine.contextForPage(page,'/?probe=synthetic&0=numeric-key');
  const comparisons="{% if pair[0] == 'probe' %}I0;{% endif %}{% if pair[1] == 'synthetic' %}I1;{% endif %}{% if pair.Value == 'synthetic' %}UV;{% endif %}{% if pair.value == 'synthetic' %}LV;{% endif %}{% if pair == 'probe' %}BK;{% endif %}{% if pair.Key == 'probe' %}UK;{% endif %}{% if pair.key == 'probe' %}LK;{% endif %}{% if pair.Name == 'probe' %}UN;{% endif %}{% if pair.name == 'probe' %}LN;{% endif %}";
  for(const target of ['request.params','params','alias']) {
    const source=`{% assign alias = request.params %}{{ ${target}.size }}|{% for pair in ${target} %}${comparisons}{% endfor %}|{{ ${target}.probe }}|{{ ${target}['0'] }}`;
    assert.equal(await engine.renderString(source,context),'2||synthetic|numeric-key');
  }
});

test('parameter capabilities leave ordinary dictionary pairs and their formatting intact', async () => {
  const hash=new LiquidHash({probe:'synthetic'});
  const source='{% for pair in fixture %}{{ pair[0] }}|{{ pair[1] }}|{{ pair.Key }}|{{ pair.Value }}|{{ pair }}{% endfor %}';
  for(const mode of ['observed','dotliquid'])assert.equal(await renderer(mode).renderString(source,{fixture:hash}),'probe|synthetic|probe|synthetic|[probe, synthetic]');
  const engine=renderer('observed');
  assert.equal(await engine.renderString('{% for pair in params %}{{ pair.Key }}:{{ pair.Value }}{% endfor %}|{{ params.probe }}|{% for pair in fixture %}{{ pair.Key }}:{{ pair.Value }}{% endfor %}',{params:hash,request:{params:hash},fixture:hash}),':|synthetic|probe:synthetic');
  assert.equal(hash.numericPairLookup,true);
  assert.equal(hash.namedPairLookup,true);
});

test('parameter observation leaves general loop assignment and direct default parameter pairs unchanged', async () => {
  const control="{% assign flag = false %}{% for item in (1..1) %}RANGE;{% assign flag = true %}{% endfor %}|{{ flag }}|{% assign items = 'synthetic' | split: ',' %}{% for item in items %}{% if item == 'synthetic' %}BARE;{% endif %}{% endfor %}";
  for(const mode of ['observed','dotliquid'])assert.equal(await renderer(mode).renderString(control),'RANGE;|true|BARE;');
  assert.equal(await renderer('dotliquid').renderString('{% for pair in params %}{{ pair[0] }}|{{ pair.Key }}|{{ pair[1] }}|{{ pair.Value }}{% endfor %}',{params:{probe:'synthetic'}}),'probe|probe|synthetic|synthetic');
});
