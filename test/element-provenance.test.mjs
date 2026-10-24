import test from 'node:test';
import assert from 'node:assert/strict';
import { elementSourceHints, scriptSourceHints, elementSourceHintCacheStats } from '../lense/element-provenance.mjs';

test('markup hints keep source lines and escaped selectors without parsing script, comments or dynamic IDs', () => {
  const hints = elementSourceHints('<div id="hero:card">\n<input id="fx_title" value="secret">\n<!-- <b id="comment"> -->\n<script>const html = `<b id="script">`</script><b id="{{ dynamic }}"></b>', { sourceFile: '/source.html', name: 'Partial' });
  assert.deepEqual(hints.map(row => [row.selector, row.line, row.certainty]), [['#hero\\3a card', 1, 'candidate'], ['#fx_title', 2, 'candidate']]);
  assert.doesNotMatch(JSON.stringify(hints), /secret|comment|script|dynamic/);
});
test('script selectors retain candidate evidence and actual source lines, with dynamic references excluded', () => {
  const hints = scriptSourceHints('document.getElementById("fx_title");\nroot.querySelector("#hero button");\nroot.querySelector("{{ dynamic }}");\nroot.querySelector(variable);', { sourceFile: '/feature.js' });
  assert.deepEqual(hints.map(row => [row.selector, row.line, row.evidence]), [['#fx_title', 1, 'script-selector'], ['#hero button', 2, 'script-selector']]);
  assert.equal(hints.every(row => row.certainty === 'candidate'), true);
});
test('duplicate IDs, large bodies and extraction caps remain explicit and bounded', () => {
  assert.equal(elementSourceHints('<b id="same"></b><b id="same"></b>', {})[0].occurrences, 2);
  assert.equal(elementSourceHints('x'.repeat(1024 * 1024 + 1), {}).length, 0);
  assert.equal(elementSourceHints('<b id="one"></b><b id="two"></b>', {}, { limit: 1 }).length, 1);
  assert.equal(elementSourceHints('<b id="one"></b>', { sourceFile: '/component.xml' })[0].line, undefined);
});
test('markup without IDs retains intrinsic source selectors and marks repeated source locations', () => {
  const hints=elementSourceHints('<aside class="summary-card"><h2 class="heading">Summary</h2><p class="note">One</p><p class="note">Two</p></aside>', {sourceFile:'/partial.html'});
  assert.equal(hints.find(row=>row.selector==='aside.summary-card').matchKind,'class');
  assert.equal(hints.find(row=>row.selector==='p.note').occurrences,2);
  assert.equal(hints.some(row=>/nth-child|>/.test(row.selector)),false,'positional selectors must not change ownership when a region is moved');
});

test('container class evidence excludes Liquid expressions and cached ancestry stays independent',()=>{
  const body='<div class="alert {{ chosen_class }}"><p class="message">Notice</p></div>',source={sourceFile:'/invented/dynamic-container.html'};
  const first=elementSourceHints(body,source).find(row=>row.selector==='p.message');
  assert.deepEqual(first.locations[0].ancestors,[{tag:'div',classes:['alert']}]);first.locations[0].ancestors[0].classes.push('changed');
  assert.deepEqual(elementSourceHints(body,source).find(row=>row.selector==='p.message').locations[0].ancestors,[{tag:'div',classes:['alert']}]);
});

const partial={sourceFile:'/invented/Partial.html',name:'Partial'};

test('wide markup under the 1 MB cap is walked without spreading children into call arguments',()=>{
  // 200 000 siblings overflow the default stack if any walk spreads them into one call.
  assert.deepEqual(elementSourceHints('<br>'.repeat(200_000),{}),[]);
});
test('repeated selectors are collected in linear time',()=>{
  const time=count=>{const body='<p class="note"></p>'.repeat(count),started=performance.now();elementSourceHints(body,{sourceFile:`/invented/repeat-${count}-${Math.random()}.html`});return performance.now()-started;};
  time(500);
  // 8x the repeats: linear collection takes about 8x the time, quadratic about 64x; the bound sits far from both.
  const best=count=>Math.min(time(count),time(count),time(count));
  const small=best(2500),large=best(20000);
  assert.ok(large<small*24,`8x repeats took ${(large/small).toFixed(1)}x the time`);
});
test('Liquid comments and manifests cannot supply rendered markup evidence',()=>{
  const rows=elementSourceHints('{% comment %}\n<div id="ghost"></div>\n{% endcomment %}\n<div id="actual"></div>{% manifest %}<b id="manifest"></b>{% endmanifest %}',partial);
  assert.deepEqual(rows.map(row=>[row.selector,row.line]),[['#actual',4]]);
});
test('raw preserves emitted HTML and treats Liquid comment tokens literally',()=>{assert.deepEqual(elementSourceHints('{% raw %}{% comment %}<div id="actual"></div>{% endcomment %}{% endraw %}',partial).map(row=>row.selector),['#actual']);});
test('trimming comments, CRLF and unterminated comments preserve lines and exclude unreachable markup',()=>{const rows=elementSourceHints('{%- comment -%}\r\n<b id="ghost"></b>\r\n{%- endcomment -%}\r\n<b id="actual"></b>{% comment %}<b id="never"></b>',partial);assert.deepEqual(rows.map(row=>[row.selector,row.line]),[['#actual',4]]);});
test('mixed dynamic class tokens never become invented static classes',()=>{const rows=elementSourceHints('<div class="tone-{{ shade }} a{{ x }}b stable"></div>',partial);assert.deepEqual(rows.map(row=>row.selector),['div.stable']);});
test('Liquid inside an identifying attribute cannot manufacture classes',()=>{assert.deepEqual(elementSourceHints('<div class="a{% comment %}ignored{% endcomment %}b stable"></div>',partial),[]);});
test('Liquid in tag structure cannot manufacture a different static element selector',()=>{for(const text of ['<di{% comment %}ignored{% endcomment %}v class="stable"></div>','<di{% raw %}v{% endraw %} class="stable"></div>','<di{{ suffix }} class="stable"></div>'])assert.deepEqual(elementSourceHints(text,partial),[],text);});
test('quoted metadata attribute references in scripts are retained',()=>{assert.deepEqual(scriptSourceHints(`document.querySelector('[data-fieldname="audit_first"]');`,{sourceFile:'/feature.js'}).map(row=>[row.selector,row.line]),[['[data-fieldname="audit_first"]',1]]);});
test('script comments and documentation strings cannot manufacture selector evidence',()=>{const body=`// document.getElementById("ghost");\nconst documentation = 'document.querySelector("#fiction")';\n/* document.querySelector("#comment") */\ndocument.getElementById("actual");`;assert.deepEqual(scriptSourceHints(body,{sourceFile:'/feature.js'}).map(row=>[row.selector,row.line]),[['#actual',4]]);});
test('classic script HTML comment forms cannot supply selector evidence',()=>{for(const prefix of ['<!--','-->'])assert.deepEqual(scriptSourceHints(prefix+' document.querySelector("#ghost");\ndocument.querySelector("#actual");',{sourceFile:'/feature.js'}).map(row=>[row.selector,row.line]),[['#actual',2]],prefix);});
test('escaped static JavaScript strings identify the actual runtime identifier',()=>{const body=String.raw`document.getElementById("audit_first"); document.querySelector("#audit\\:first");`;assert.deepEqual(scriptSourceHints(body,{}).map(row=>row.selector),['#audit_first','#audit\\:first']);});
test('script reference budgets count accepted, deduplicated references only',()=>{
  assert.deepEqual(scriptSourceHints('document.querySelector("#{{ dynamic }}"); document.querySelector("#actual");',{},{limit:1}).map(row=>row.selector),['#actual']);
  assert.deepEqual(scriptSourceHints('document.querySelector("#one"); document.querySelector("#one"); document.querySelector("#two");',{},{limit:2}).map(row=>row.selector),['#one','#two']);
});
test('values, concatenations, optional arguments, regexes and template text never become script references',()=>{
  for(const text of [
    'document.querySelector("[data-private=SECRET_SENTINEL]"); document.querySelector("a[href*=TOKEN_SENTINEL]");',
    'document.querySelector("#prefix" + suffix); document.querySelector("#x", extra);',
    'const pattern = /document.querySelector("#ghost")/; const text = `outer ${`inner`} document.querySelector("#fiction")`;',
  ])assert.deepEqual(scriptSourceHints(text,{}),[],text);
});

test('script selectors continue after balanced nested templates, division statements and long ordinary literals',()=>{
  const body='const text = `outer ${ {nested: `inner ${ $("#inside") }`, pattern: /}/} } tail`;\n'+
    'const ratio = total / divisor;\nconst long = "'+'x'.repeat(500)+'";\n'+
    '\n'.repeat(5)+'$("#after");document.querySelector(".last");';
  assert.deepEqual(scriptSourceHints(body,{sourceFile:'/invented/modern.js'}).map(row=>[row.selector,row.line]),[['#after',9],['.last',9]]);
  const regex='if (ready) /document.querySelector("#fiction")/.test(input);\ndocument.getElementById("actual");';
  assert.deepEqual(scriptSourceHints(regex,{}).map(row=>row.selector),['#actual']);
  assert.deepEqual(scriptSourceHints('const invalid=`unterminated ${ {x:"text"}; document.querySelector("#fiction");',{}),[]);
});

test('script hint limits report only an actual additional unique reference and cached descriptors stay independent',()=>{
  const source={sourceFile:'/invented/script-cap.js',name:'First'},body=Array.from({length:120},(_,index)=>`$("#x${index}");`).join('\n');
  const exact=scriptSourceHints(body,source);assert.equal(exact.length,120);assert.equal(exact.truncated,false);
  const limited=scriptSourceHints(body+'$("#extra");',source);assert.equal(limited.length,120);assert.equal(limited.truncated,true);
  limited[0].name='mutated';const cached=scriptSourceHints(body+'$("#extra");',{...source,name:'Second'});assert.equal(cached[0].name,'Second');assert.equal(cached.truncated,true);
});

test('script hint caps scan later references and prefer current-page ids',()=>{
  const body=Array.from({length:200},(_,index)=>`$('#id${index}');`).join('\n');
  const source={sourceFile:'/invented/long.js'};
  const hints=scriptSourceHints(body,source,{ids:['id190']});
  assert.equal(hints.length,120);assert.equal(hints.truncated,true);assert.equal(hints[0].selector,'#id190');assert.equal(hints[0].line,191);
  assert.equal(scriptSourceHints(body,source,{ids:['id195']})[0].selector,'#id195','cached scans rank against each page');
});

test('hint cache returns independent descriptors and invalidates only changed source bodies',()=>{
  const file='/invented/cache-specific.html',body='<section id="cached"><button class="owned">Go</button></section>',source={sourceFile:file,name:'First'};
  const first=elementSourceHints(body,source),before=elementSourceHintCacheStats();first[0].ref='mutated';first[0].locations[0].contexts.push('#unrelated');
  const second=elementSourceHints(body,{...source,name:'Second'}),after=elementSourceHintCacheStats();
  assert.equal(after.parses,before.parses);assert.equal(after.hits,before.hits+1);assert.equal(second[0].name,'Second');assert.equal(second[0].ref,undefined);assert.ok(!second[0].locations[0].contexts.includes('#unrelated'));
  const changed=elementSourceHints(body+'<b id="new"></b>',source);assert.ok(changed.some(row=>row.selector==='#new'));assert.equal(elementSourceHintCacheStats().parses,after.parses+1);
});
