// Self-contained browser function, like panelUi. Never reads page text or input values.
export function xrayUi(data) {
  if (location.origin !== data.origin || window.__paqviloRetiredSessions?.includes(data.token) || !document.body) return;
  let host = document.getElementById('paqvilo-xray');
  // The panel owns the current UI state; server-persisted visibility may lag a shortcut.
  if (host?.__px) { host.__px.update({ ...data, ui: undefined }); return; }
  host = document.createElement('div'); host.id = 'paqvilo-xray'; host.setAttribute('popover', 'manual');
  host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:100%!important;height:100%!important;margin:0!important;padding:0!important;border:0!important;background:transparent!important;pointer-events:none!important;overflow:visible!important;z-index:2147483647!important;';
  document.body.append(host);
  const root = host.attachShadow({ mode: 'open' }), sheet = new CSSStyleSheet();
  sheet.replaceSync(`
    :host{color-scheme:normal}*{box-sizing:border-box}.ui{--bg:#fff;--fg:#212529;--muted:#6c757d;--primary:#0d6efd;--link:#0d6efd;--on-primary:#fff;--radius:4px;--line:#d8dfe7;--head-bg:#f3f6fa;--panel-line:rgba(0,0,0,.15);--shadow:0 6px 12px rgba(0,0,0,.18);--font:"Segoe UI",system-ui,sans-serif;font:13px/1.45 var(--font);color:var(--fg);text-align:left;letter-spacing:0}
    button,select{font:inherit;color:inherit}button{cursor:pointer;background:none;border:0;border-radius:var(--radius);padding:4px 7px;text-align:left}button:hover{background:color-mix(in srgb,var(--primary) 8%,var(--bg));color:var(--link)}button:focus-visible,select:focus-visible{outline:2px solid var(--primary);outline-offset:2px}button[aria-pressed=true]{color:var(--primary);background:color-mix(in srgb,var(--primary) 10%,var(--bg))}button:disabled{opacity:.4;cursor:default}
    .shield{position:fixed;inset:0;pointer-events:auto;cursor:crosshair}.ui.interact .shield{display:none}.bar,.card,.tip,.legend{background:var(--bg);border:1px solid var(--panel-line);border-radius:var(--radius);box-shadow:var(--shadow)}.bar,.card{pointer-events:auto}.bar{position:fixed;top:12px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:6px;padding:6px 8px;max-width:calc(100vw - 16px);white-space:nowrap}.brand{display:flex;align-items:center;gap:8px;padding-right:7px}.brand strong{color:var(--link);font-size:14px}.brand span{color:var(--muted)}.hint,.muted{color:var(--muted)}.hint{font-size:11px}.bar select{background:var(--bg);border:1px solid var(--line);border-radius:var(--radius);padding:4px;max-width:142px}.exit{font-size:18px;line-height:1}
    .card{position:fixed;right:12px;top:64px;width:410px;max-width:calc(100vw - 16px);max-height:calc(100dvh - 80px);display:flex;flex-direction:column;overflow:hidden}.card[hidden],.tip[hidden]{display:none}.cardhead{display:flex;gap:6px;align-items:center;padding:9px 10px 9px 12px;border-bottom:1px solid var(--line);background:var(--head-bg);cursor:move;touch-action:none}.grow{flex:1;min-width:0}.eyebrow{font-size:11px;color:var(--muted)}.title{font-size:14px;font-weight:600;overflow-wrap:anywhere}.cardhead button{padding:3px 7px}.content{overflow:auto;overscroll-behavior:contain;min-height:0;padding:0 12px 12px;scrollbar-width:thin}.section{margin-top:12px}.section h3{font-size:12px;font-weight:600;margin:0 0 6px}.section h3 small{font-size:11px;font-weight:400;color:var(--muted)}.binding{padding:7px 9px;background:color-mix(in srgb,var(--primary) 6%,var(--bg));border-left:3px solid var(--primary)}.binding strong{font-weight:600;display:block;overflow-wrap:anywhere}.binding .muted{font-size:11.5px;margin-top:3px}.details{display:grid;grid-template-columns:66px 1fr;gap:4px 8px;margin:7px 0;font-size:12px}.details dt{color:var(--muted)}.details dd{margin:0;overflow-wrap:anywhere}.source{padding:7px 0;border-bottom:1px solid var(--line)}.source:last-child{border-bottom:0}.source .name{display:flex;align-items:center;gap:7px}.source .name b{font-weight:500;flex:1;overflow-wrap:anywhere}.badge{font-size:10px;color:var(--muted);border:1px solid var(--line);border-radius:3px;padding:0 4px;flex:none}.mono{font:11.5px/1.5 Consolas,monospace;overflow-wrap:anywhere;color:var(--muted)}.source .mono{margin-top:3px}.source .actions{display:flex;gap:5px;margin-top:4px}.source button{padding:2px 5px;color:var(--link);font-size:11.5px}.note{font-size:11.5px;color:var(--muted);margin:4px 0 0;line-height:1.5}.foot{display:flex;align-items:center;gap:4px;padding:5px 8px;border-top:1px solid var(--line);background:var(--head-bg)}.foot button{font-size:11.5px}.foot .hint{margin-left:auto}.status{padding:0 12px 7px;font-size:11.5px;color:var(--muted)}.status:empty{display:none}
    details{margin-top:12px}summary{cursor:pointer;color:var(--muted);font-size:12px;padding:4px 0}.crumb{display:block;width:100%;text-align:left;font:11px Consolas,monospace;margin-top:3px;overflow-wrap:anywhere}.welcome{padding:12px}.welcome .hero{font-size:14px;font-weight:600;margin:0 0 6px}.welcome p{margin:5px 0}.welcome .counts{padding-top:8px;border-top:1px solid var(--line);margin-top:10px}.empty{padding:12px 0}.empty b{display:block}.marks{position:fixed;inset:0;pointer-events:none}.mark{position:fixed;border:1px solid var(--tone,var(--primary));background:transparent;pointer-events:none}.selected{border:2px solid var(--primary);background:color-mix(in srgb,var(--primary) 6%,transparent)}.hover{border:2px dashed var(--primary);background:color-mix(in srgb,var(--primary) 3%,transparent)}.tip{position:fixed;pointer-events:none;max-width:370px;padding:5px 8px;font-size:12px;overflow-wrap:anywhere}.tip b{display:block;font-weight:600}.tip .mono{font-size:11px}.legend{position:fixed;bottom:12px;left:50%;transform:translateX(-50%);pointer-events:none;font-size:11px;color:var(--muted);padding:5px 9px;max-width:calc(100vw - 16px)}.legend i{display:inline-block;width:7px;height:7px;margin:0 4px 0 10px}.legend i:first-child{margin-left:0}kbd{font:10px Consolas,monospace;border:1px solid var(--line);padding:0 3px;border-radius:2px}
    @media(max-width:850px){.bar{top:8px;gap:3px;padding:5px}.bar .hint,.brand span{display:none}.brand{padding-right:3px}.bar button{font-size:11.5px;padding:4px}.bar select{max-width:118px;font-size:11px}.card{top:auto;bottom:44px;max-height:46dvh;width:380px;right:8px}.legend{bottom:8px;font-size:10px}.legend .hint{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important}}
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `<div class="ui" hidden><div class="shield"></div><div class="marks"></div><div class="bar" role="toolbar" aria-label="Lense X-ray"><div class="brand"><strong>paqvilo</strong><span>X-ray</span></div><button data-action="mode" aria-pressed="true">Inspect</button><select aria-label="Highlight layer"><option value="all">All sources</option><option value="data">Forms & data</option><option value="content">Templates & content</option><option value="none">Selection only</option></select><button data-action="details" title="Show or hide source details">Details</button><button data-action="refresh" aria-label="Refresh source inspection" title="Refresh sources and component bindings">↻</button><span class="hint"><kbd>Alt</kbd> interact</span><button class="exit" data-action="exit" aria-label="Turn off X-ray">×</button></div><aside class="card" aria-label="Power Pages source details"></aside><div class="tip" hidden></div><div class="legend"><i style="background:#29805b"></i>Fields<i style="background:#3975ad"></i>Forms & views<i style="background:#947330"></i>Source markup <span class="hint"> · click to select · <kbd>Esc</kbd> back</span></div></div>`;

  const ui = root.querySelector('.ui'), marks = root.querySelector('.marks'), card = root.querySelector('.card'), tip = root.querySelector('.tip');
  const lifetime = new AbortController(), listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: lifetime.signal });
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const norm = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
  let geometryCache=null,styleCache=null;
  const styleFor=node=>{if(!styleCache)return getComputedStyle(node);if(!styleCache.has(node))styleCache.set(node,getComputedStyle(node));return styleCache.get(node);};
  let d = data, report = null, enabled = false, interacting = false, alt = false, selected = null, hover = null, layer = 'all', details = true, frame = 0, candidates = [], needsScan = true, detailsDirty=false, pointer = { x: 0, y: 0 }, drag = null, disposed = false;
  const own = node => node === host || node?.closest?.('#paqvilo-panel,#paqvilo-handle,#paqvilo-xray') || ['paqvilo-panel','paqvilo-handle','paqvilo-xray'].includes(node?.getRootNode?.()?.host?.id);
  const label = node => `${node.localName}${node.id ? '#' + node.id.slice(0,160) : ''}${!node.id && node.classList?.length ? '.' + [...node.classList].slice(0,2).join('.') : ''}`;
  const child = node => [...(node?.shadowRoot?.children ?? node?.children ?? [])].find(item=>!item.matches('style,script,link')&&!own(item));
  const parent = node => node?.assignedSlot ?? node?.parentElement ?? node?.getRootNode?.()?.host ?? null;
  const lineage = node => { const rows = []; for (let current = node; current; current = parent(current)) rows.push(current); return rows; };
  const binding = node => {
    const labelNode=lineage(node).find(item=>item.localName==='label');
    const labelled=labelNode?.control??null,chain=lineage(labelled??node);
    const compact=value=>norm(value).replace(/-/g,'').replace(/[^a-z0-9_]/g,'_');
    const nativeAt=current=>(report?.forms??[]).filter(form=>['EntityFormControl_','WebFormControl_'].some(prefix=>current.id===prefix+compact(form.id)||current.id===prefix+compact(form.id)+'_EntityFormView'));
    let entity='',formId='',viewId='',listId='',forms=[],views=[],lists=[],family='',context='',conflict=false,formCertain=false;
    const scope=[];
    for(const current of chain){
      let shape={};try{const parsed=JSON.parse(current.getAttribute('data-form-layout')??current.querySelector(':scope > [data-form-layout]')?.getAttribute('data-form-layout')??'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))shape=parsed;}catch{}
      const value=name=>current.getAttribute(name)??'';
      const declared=value('data-entityname')||value('data-entity')||String(shape.EntityName??'');
      const fid=value('data-formid')||String(shape.Id??''),vid=value('data-viewid')||value('data-selected-view'),lid=value('data-listid');
      const nativeForms=nativeAt(current);
      const recordForms=(report?.forms??[]).filter(item=>fid&&norm(item.id)===norm(fid));
      const nextForms=recordForms.length?recordForms:nativeForms.length?nativeForms:(report?.forms??[]).filter(item=>fid&&norm(item.formXml?.id)===norm(fid));
      const nextViews=(report?.views??[]).filter(item=>vid&&norm(item.id)===norm(vid));
      const nextLists=(report?.components??[]).filter(item=>item.kind==='list'&&lid&&norm(item.recordId??item.id)===norm(lid));
      const nextFamily=vid||lid?'collection':fid||nativeForms.length?'form':'';
      if(family&&nextFamily&&family!==nextFamily)break;
      if(forms.length&&nextForms.length&&!nextForms.some(item=>forms.some(known=>norm(known.id)===norm(item.id))))break;
      if(formId&&fid&&norm(formId)!==norm(fid)||viewId&&vid&&norm(viewId)!==norm(vid)||listId&&lid&&norm(listId)!==norm(lid))break;
      const entities=[...new Set([...nextForms,...nextViews,...nextLists].map(item=>item.entity).filter(Boolean))];
      const inferred=entities.length===1?entities[0]:'';
      // A different enclosing table/component is a boundary, not the selected control's owner.
      if(entity&&(declared&&declared!==entity||inferred&&inferred!==entity))break;
      if(entities.length>1||declared&&inferred&&declared!==inferred||value('data-entityname')&&shape.EntityName&&value('data-entityname')!==shape.EntityName)conflict=true;
      scope.push(current);entity ||= declared||inferred;
      if(!context&&(declared||nextFamily))context=label(current);
      if(nextFamily)family=nextFamily;
      if(!formId&&fid)formId=fid;if(!viewId&&vid)viewId=vid;if(!listId&&lid)listId=lid;
      if(!forms.length&&nextForms.length){forms=nextForms;formCertain=Boolean(recordForms.length||nativeForms.length);}
      if(!views.length&&nextViews.length)views=nextViews;if(!lists.length&&nextLists.length)lists=nextLists;
      if(current.matches('dialog,[role=dialog]'))break;
    }
    const fieldAttributes=['data-attribute','data-field','data-fieldname','data-pcf-native-field','data-th'];
    const explicit=scope.find(item=>fieldAttributes.some(name=>item.hasAttribute(name)));
    const control=labelled??scope.find(item=>item.matches('input,select,textarea,output'));
    const names=explicit?fieldAttributes.map(key=>explicit.getAttribute(key)).filter(Boolean):control?[control.id,control.getAttribute('name')].filter(Boolean):[];
    const fields=conflict?[]:(report?.columns??[]).filter(item=>names.includes(item.name)&&(!entity||item.entity===entity));
    const native=(report?.nativeComponents??[]).filter(item=>scope.some(ancestor=>ancestor.id===item.id)&&(!item.viewId||!viewId||norm(item.viewId)===norm(viewId)));
    const schema=scope.find(item=>item.hasAttribute('data-pcf-schema'))?.getAttribute('data-pcf-schema');
    const code=(report?.codeComponents??[]).filter(item=>schema&&norm(item.schemaName)===norm(schema));
    return {entity,fields,forms,views,lists,native,code,formId,viewId,listId,context,conflict,formCertain};
  };
  const sourceMatches = node => {
    const ancestors=lineage(node),rows=[];
    for(const item of report?.elementSources??[]){try{
      const depth=ancestors.findIndex(ancestor=>ancestor.matches(item.selector));if(depth<0)continue;
      const specificity=item.matchKind==='id'?100:item.matchKind==='attribute'?70:item.matchKind==='class'?50:30;
      rows.push({...item,depth,score:specificity-depth*6,evidenceLabel:`${item.kind==='script'?'Script reference':'Markup match'}: ${item.selector}${depth?' on an enclosing element':''}${item.occurrences>1?' · '+item.occurrences+' locations in this source':''}`});
    }catch{}}
    return rows.sort((a,b)=>a.depth-b.depth||b.score-a.score).slice(0,30);
  };
  const dispatch = (action, detail = {}) => host.dispatchEvent(new CustomEvent('paqvilo-xray', { bubbles:true, detail:{action,...detail} }));
  const setStatus = message => { const output = card.querySelector('.status'); if (output) output.textContent = message; };
  const kindName=kind=>({'template':'Web template','snippet':'Content snippet','page':'Page copy','basic-form':'Basic form','advanced-form':'Multistep form','list':'List','script':'Script','field':'Column','view':'View','table':'Table'}[kind]??kind??'Source');
  const sourceRows = (rows, evidence) => rows.map(item => `<div class="source"><div class="name"><b>${esc(item.name ?? item.label ?? 'Source')}</b><span class="badge">${esc(kindName(item.kind))}</span></div><div class="mono">${esc(item.ref ?? item.url ?? 'Source unavailable')}${item.line?':'+Number(item.line):''}</div>${item.evidenceLabel||evidence?`<div class="note">${esc(item.evidenceLabel??evidence)}</div>`:''}${item.ref ? `<div class="actions"><button data-action="open" data-ref="${esc(item.ref)}" data-line="${Number(item.line)||''}" data-find="${esc(item.fieldPath && /powerpagecomponent\.xml$/i.test(item.ref) ? '"'+item.fieldPath+'":' : item.find ?? '')}">Open source ↗</button><button data-action="copy" data-copy="${esc(item.path??item.sourceFile??item.ref)}">Copy path</button>${item.depth?`<button data-action="source-region" data-selector="${esc(item.selector)}">Select source region</button>`:''}</div>` : ''}</div>`).join('');
  const identify=node=>{
    const b=binding(node),matches=sourceMatches(node).filter(item=>item.kind!=='script');
    if(b.conflict)return {title:'Conflicting table context',kind:'Unresolved binding',sub:'The rendered table and exported component disagree.',b,matches};
    if(b.fields.length===1){const field=b.fields[0];return {title:field.label??field.name,kind:'Dataverse column'+(b.entity?'':' · candidate'),sub:field.entity+'.'+field.name,b,matches};}
    if(b.forms.length===1)return {title:b.forms[0].name,kind:kindName(b.forms[0].kind??'basic-form')+(b.formCertain?'':' · candidate'),sub:b.forms[0].entity??'',b,matches};
    if(b.views.length===1)return {title:b.views[0].name,kind:'Dataverse view',sub:b.views[0].entity??'',b,matches};
    if(b.lists.length===1)return {title:b.lists[0].name,kind:'Power Pages list',sub:b.lists[0].entity??'',b,matches};
    if(b.native.length===1){const item=b.native[0];return {title:item.formName??item.name,kind:item.kind==='quickform'?'Quick view':item.kind==='subgrid'?'Subgrid':kindName(item.kind),sub:[item.entity,item.owner].filter(Boolean).join(' · '),b,matches};}
    if(b.code.length===1){const item=b.code[0];return {title:item.schemaName??item.name,kind:'Code component',sub:item.entity??'',b,matches};}
    const match=matches[0];
    if(match)return {title:match.name,kind:kindName(match.kind)+' · source match',sub:match.ref??'',b,matches};
    return {title:b.fields.length>1?'Ambiguous column':'No source match',kind:'Selected element',sub:'Use page context or select an enclosing source region.',b,matches};
  };
  const sourcesHtml = node => {
    const b=binding(node),exact=b.fields.length===1?b.fields[0]:null,matches=sourceMatches(node),allMarkup=matches.filter(item=>item.kind!=='script'),markup=allMarkup.filter(item=>item.depth===allMarkup[0]?.depth),scripts=matches.filter(item=>item.kind==='script');
    let out=b.conflict?'<div class="section"><h3>Conflicting table context</h3><p class="note">The rendered table and exported form/view disagree. No column identity is asserted.</p></div>':'';
    if(exact){
      const table=(report?.tables??[]).find(item=>item.logicalName===exact.entity);
      out+=`<div class="section"><h3>Dataverse column${b.entity?'':' · candidate'}</h3><div class="binding"><strong>${esc(exact.entity)}.${esc(exact.name)}</strong>${exact.label?`<span class="note">${esc(exact.label)}</span>`:''}</div><dl class="details"><dt>Table</dt><dd>${esc(exact.entity)}</dd><dt>Column</dt><dd>${esc(exact.name)}</dd>${exact.type?`<dt>Type</dt><dd>${esc(exact.type)}</dd>`:''}${exact.required!==undefined?`<dt>Required</dt><dd>${exact.required?'Yes':'No'}</dd>`:''}<dt>Matched by</dt><dd>${b.entity?'Column identifier + table context':'Column identifier only; candidate until table context is known'}</dd></dl>${sourceRows([{...exact,name:'Column definition',kind:'field',find:exact.name}], exact.resolved===false||!exact.ref?'Column definition unavailable in selected Solution':'Field definition in selected Solution')}${table?.ref&&table.ref!==exact.ref?sourceRows([{...table,name:'Table definition',kind:'table',find:exact.entity}]):''}</div>`;
    }else if(b.fields.length>1)out+=`<div class="section"><h3>Dataverse column</h3><div class="binding"><strong>Ambiguous field identifier</strong><div class="note">The identifiers match ${b.fields.length} exported columns. No single column is asserted.</div></div>${sourceRows(b.fields.map(item=>({...item,name:item.entity+'.'+item.name,kind:'field'})),'Candidate column')}</div>`;
    const componentSources=[...b.forms.flatMap(item=>[{...item,kind:item.kind??'basic-form',evidenceLabel:b.formCertain?'Component ID matched to the selected export':'System form ID; candidate basic form configuration'},...(item.formXml?[{...item.formXml,name:item.formXml.name??'Dataverse form',kind:'FormXml',evidenceLabel:b.formId&&norm(b.formId)===norm(item.formXml.id)?'Dataverse system form ID matched to the selected export':'FormXml referenced by the exported form configuration'}]:[])]),...b.views.map(item=>({...item,kind:'view'})),...b.lists].filter((item,index,rows)=>rows.findIndex(other=>other.kind===item.kind&&other.ref===item.ref&&other.id===item.id&&other.name===item.name)===index);
    if(componentSources.length){out+=`<div class="section"><h3>Form / view</h3>${sourceRows(componentSources,b.formId&&!b.formCertain&&b.forms.length?'System form ID; candidate basic form configuration':'Component ID matched to the selected export')}</div>`;const ids=new Set(b.forms.map(item=>norm(item.id)));const logic=(report?.components??[]).filter(item=>ids.has(norm(item.recordId??item.id))&&item.ref&&!componentSources.some(source=>source.ref===item.ref));if(logic.length)out+=`<details><summary>Form scripts</summary>${sourceRows(logic,'Exported form customization')}</details>`;}
    else if(b.formId||b.viewId||b.listId)out+='<div class="section"><h3>Form / view</h3><p class="note">The rendered component ID is absent from the selected export. Refresh sources after opening dynamic forms.</p></div>';
    if(b.native.length)out+=`<div class="section"><h3>Native component</h3>${b.native.map(item=>`<dl class="details"><dt>Control</dt><dd>${esc(item.name??item.id)}</dd><dt>Form</dt><dd>${esc(item.owner??'Unresolved')}</dd>${item.relationship?`<dt>Relation</dt><dd>${esc(item.relationship)}</dd>`:''}</dl>${sourceRows([{...item,name:kindName(item.kind)+' definition'},...(item.metadataSources??[])],'Rendered control ID matched to exported FormXml')}`).join('')}</div>`;
    if(b.code.length)out+=`<div class="section"><h3>Code component</h3>${sourceRows(b.code,'Rendered schema name matched to exported component')}${sourceRows(b.code.flatMap(item=>item.resources??[]),'Declared component resource')}</div>`;
    if(markup.length){
      // Keep multiple possible owners visible, but collapse repeated selectors within one source file.
      const files=[...new Map(markup.map(item=>[item.ref??item.sourceFile,item])).keys()].map(key=>markup.find(item=>(item.ref??item.sourceFile)===key));
      out+=`<div class="section"><h3>Element source candidates <small>(${files.length})</small></h3>${sourceRows(files)}<p class="note">Matched against local markup. Multiple templates or conditional branches can share a match.</p></div>`;
      const owners=[...new Set(files.flatMap(item=>item.includedBy??[]))].map(owner=>{const [kind,id]=owner.split(':');return kind==='web-template'?(report?.webTemplates??[]).find(item=>norm(item.id)===norm(id))?.name:report?.page?.name??report?.page?.pageName;}).filter(Boolean);
      if(owners.length)out+=`<div class="note">Referenced by: ${esc([...new Set(owners)].join(', '))}</div>`;
    }else if(!exact&&!componentSources.length&&!b.native.length&&!b.code.length)out+='<div class="section"><p class="note">No local markup or component binding identifies this element. Select an enclosing region or check the page sources below.</p></div>';
    if(scripts.length)out+=`<details><summary>Related script references (${scripts.length})</summary>${sourceRows(scripts,'Literal selector reference; event ownership is not inferred')}</details>`;
    const page=report?.page;
    out+=`<details class="page-context"><summary>Page context${page?' · '+esc(page.pageName??page.name??''):''}</summary><dl class="details"><dt>Page</dt><dd>${esc(page?.pageName??page?.name??'Not in selected export')}</dd><dt>Template</dt><dd>${esc(page?.pageTemplateName??report?.pageTemplate?.name??'Unresolved')}</dd></dl>${sourceRows(report?.pageSources??[])}${sourceRows((report?.assets??[]).map(item=>({...item,kind:/\.css(?:$|\?)/i.test(item.url??item.ref??'')?'Stylesheet':'script'})),'Page asset; element ownership and applied CSS rules are not established')}${sourceRows((report?.webTemplates??[]).map(item=>({...item,kind:'template'})),'Page dependency; element ownership not established')}</details>`;
    if(!report)out=`<div class="empty"><b>${esc(d.inspectionError||(d.inspection?.active===false?d.inspection.error:'')||'Reading local sources…')}</b><p class="note">Use Refresh to retry source inspection.</p></div>`;
    return out;
  };
  const renderCard = (preserve=false) => {
    if(!enabled)return;
    const scroll=card.querySelector('.content')?.scrollTop??0,open=preserve?[...card.querySelectorAll('details[open]')].map(item=>item.querySelector('summary')?.textContent):[];card.hidden=!details;
    if(!selected){card.innerHTML=`<div class="welcome"><div class="hero">Select a portal element</div><p class="note">Hover or click to identify its template, page source, form, view or Dataverse column.</p><p class="note">Hold <kbd>Alt</kbd> to interact with the portal. <kbd>Esc</kbd> clears selection, then exits.</p><p class="note counts">${report?`${(report.webTemplates??[]).length} templates · ${(report.forms??[]).length} forms · ${(report.views??[]).length} views · ${(report.columns??[]).length} columns`:esc(d.inspectionError||(d.inspection?.active===false?d.inspection.error:'')||'Loading source inspection…')}</p></div>`;return;}
    const identity=identify(selected);
    card.innerHTML=`<div class="cardhead"><div class="grow"><div class="eyebrow">${esc(identity.kind)}</div><div class="title">${esc(identity.title)}</div></div><button data-action="dock" title="Move details to the other side" aria-label="Move details">⇄</button><button data-action="clear" aria-label="Clear selection">×</button></div><div class="content">${sourcesHtml(selected)}<details class="ancestry"><summary>Element & ancestry</summary><div class="mono element-label">${esc(label(selected))}</div><p class="note">Select an enclosing element to inspect its source. [ and ] cycle overlapping elements.</p>${lineage(selected).map((node,index)=>`<button class="crumb" data-action="ancestor" data-index="${index}" style="padding-left:${7+Math.min(index,6)*8}px">${index?'↳ ':''}${esc(label(node))}</button>`).join('')}${selected.localName==='iframe'?'<p class="note">This is a frame boundary. Inner document source information is unavailable.</p>':''}</details></div><div class="status" role="status"></div><div class="foot"><button data-action="parent" ${!parent(selected)||own(parent(selected))?'disabled':''}>↑ Parent</button><button data-action="child" ${!child(selected)?'disabled':''}>↓ Child</button><button data-action="reveal">Reveal</button><span class="hint">Esc to release</span></div>`;
    for(const item of card.querySelectorAll('details'))if(open.includes(item.querySelector('summary')?.textContent))item.open=true;const body=card.querySelector('.content');if(body)body.scrollTop=scroll;
  };
  // Rectangles live outside portal layout. Clip to each scroll container without changing its CSS.
  function visibleRect(node) {
    if (!node?.isConnected || own(node)) return null;
    if(geometryCache?.has(node))return geometryCache.get(node);
    const style = styleFor(node); if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return null;
    let rect=node.getBoundingClientRect(), left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(innerWidth,rect.right),bottom=Math.min(innerHeight,rect.bottom);
    if(!rect.width||!rect.height)return null;
    const establishesFixed=css=>css.transform!=='none'||css.perspective!=='none'||css.filter!=='none'||css.backdropFilter&&css.backdropFilter!=='none'||/layout|paint|strict|content/.test(css.contain)||/transform|perspective|filter/.test(css.willChange);
    let escape=style.position==='fixed'?'fixed':style.position==='absolute'?'absolute':'';
    for(const ancestor of lineage(parent(node))) {
      const css=styleFor(ancestor);
      if(css.display==='none'||css.opacity==='0')return null;
      if(escape&&(establishesFixed(css)||escape==='absolute'&&css.position!=='static'))escape='';
      if(!escape&&ancestor!==document.body&&ancestor!==document.documentElement){
        const r=ancestor.getBoundingClientRect(),sx=r.width/ancestor.offsetWidth||1,sy=r.height/ancestor.offsetHeight||1;
        if(/hidden|clip|auto|scroll/.test(css.overflowX)){left=Math.max(left,r.left+ancestor.clientLeft*sx);right=Math.min(right,r.left+(ancestor.clientLeft+ancestor.clientWidth)*sx);}
        if(/hidden|clip|auto|scroll/.test(css.overflowY)){top=Math.max(top,r.top+ancestor.clientTop*sy);bottom=Math.min(bottom,r.top+(ancestor.clientTop+ancestor.clientHeight)*sy);}
      }
      // A positioned ancestor can itself escape clipping higher in the tree.
      if(css.position==='fixed')escape='fixed';else if(css.position==='absolute'&&!escape)escape='absolute';
    }
    const result=right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;geometryCache?.set(node,result);return result;
  }
  const rectHtml=(node,kind,tone)=>{const r=visibleRect(node);return r?`<div class="mark ${kind}" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--tone:${tone}"></div>`:'';};
  const category=node=>node.matches('input,select,textarea,[data-field],[data-attribute],[data-fieldname],[data-pcf-native-field],[data-th]')?'field':node.matches('form,[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-listid],.entity-grid')?'component':'content';
  const isOccluded=(node,r)=>{const x=r.left+r.width/2,y=r.top+Math.min(r.height/2,30),top=document.elementsFromPoint(x,y).find(item=>!own(item));return top&&!lineage(node).includes(top)&&!lineage(top).includes(node);};
  const discoveryCursors=new WeakMap();
  const scan=()=>{
    // Rebuild observed roots so detached components are not retained indefinitely.
    observer.disconnect();observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});
    const selector='input:not([type=hidden]),select,textarea,form,[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-listid],[data-entityname],[data-field],[data-attribute],[data-fieldname],[data-pcf-native-field],[data-th],[role=dialog],dialog,iframe';
    candidates=[];const roots=[document];
    for(let index=0;index<roots.length&&index<40;index++){
      const surface=roots[index];
      for(const node of surface.querySelectorAll(selector)){if(!own(node)&&candidates.length<800)candidates.push(node);}
      const nodes=surface.querySelectorAll('*'),start=discoveryCursors.get(surface)??0,budget=Math.min(nodes.length,surface===document?4000:Math.max(100,Math.floor(4000/Math.max(1,roots.length-1))));
      for(let offset=0;offset<budget;offset++){const node=nodes[(start+offset)%nodes.length];if(node.shadowRoot&&!own(node)){roots.push(node.shadowRoot);observer.observe(node.shadowRoot,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});}}
      discoveryCursors.set(surface,nodes.length?(start+budget)%nodes.length:0);
      for(const hint of (report?.elementSources??[]).slice(0,300)){try{for(const node of [...surface.querySelectorAll(hint.selector)].slice(0,20))if(!own(node)&&!candidates.includes(node)&&candidates.length<800)candidates.push(node);}catch{}}
    }
    needsScan=false;
  };
  const paint=()=>{
    frame=0;if(!enabled||disposed)return;geometryCache=new WeakMap();styleCache=new WeakMap();
    if(selected&&!selected.isConnected){const removed=label(selected);selected=null;renderCard();const welcome=card.querySelector('.hero');if(welcome)welcome.textContent='Element removed';const note=card.querySelector('.note');if(note)note.textContent=removed+' was replaced or removed. Click a rendered element to select it again.';}if(hover&&!hover.isConnected)hover=null;
    if(detailsDirty&&selected){detailsDirty=false;renderCard(true);}
    if(needsScan)scan();
    let html='',count=0;
    if(layer!=='none')for(const node of candidates){const type=category(node);if(layer==='data'&&type==='content'||layer==='content'&&type!=='content')continue;const r=visibleRect(node);if(!r||isOccluded(node,r))continue;html+=rectHtml(node,'',type==='field'?'#29805b':type==='component'?'#3975ad':'#947330');if(++count>=250)break;}
    if(selected)html+=rectHtml(selected,'selected','#76f1df');if(hover&&hover!==selected&&!interacting&&!alt)html+=rectHtml(hover,'hover','#c0b0ff');
    marks.innerHTML=html;
    const target=hover??selected,r=target&&visibleRect(target);tip.hidden=!r||interacting||alt;
    if(!tip.hidden){const identity=identify(target),b=identity.b;tip.innerHTML=`<span class="note">${esc(identity.kind)}</span><b>${esc(identity.title)}</b><div class="mono">${esc(identity.sub)}</div>${b.fields.length===1&&b.forms.length?`<div class="note">${b.formCertain?'Form':'Form candidate'+(b.forms.length>1?'s':'')}: ${esc(b.forms.length===1?b.forms[0].name:b.forms.length+' configurations')}</div>`:''}`;const tr=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(innerWidth-tr.width-8,r.left))+'px';tip.style.top=Math.max(58,Math.min(innerHeight-tr.height-8,r.top-tr.height-8))+'px';}

    geometryCache=null;styleCache=null;

  };
  const schedule=()=>{if(!host.isConnected){host.__px?.dispose();return;}if(enabled&&!frame)frame=requestAnimationFrame(paint);};
  const hitStack=(x,y)=>{
    const stack=[],seen=new Set();
    const add=(node,depth=0)=>{if(own(node)||seen.has(node))return;seen.add(node);if(node.shadowRoot)observer.observe(node.shadowRoot,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});if(node.shadowRoot&&depth<40)for(const inner of node.shadowRoot.elementsFromPoint(x,y))if(inner.getRootNode()===node.shadowRoot)add(inner,depth+1);stack.push(node);};
    for(const node of document.elementsFromPoint(x,y))add(node);
    return stack;
  };
  const underPointer=(x,y)=>hitStack(x,y)[0];
  let modalOrder=[];
  const topLayer=(force=false)=>{modalOrder=modalOrder.filter(node=>node.isConnected&&node.matches(':modal'));const modal=modalOrder.at(-1)??document.activeElement?.closest('dialog:modal')??[...document.querySelectorAll('dialog:modal')].at(-1);const container=modal??document.body;const moved=host.parentElement!==container;if(moved)container.append(host);if(enabled){try{const open=host.matches(':popover-open');if(open&&(force||moved))host.hidePopover();if(!open||force||moved)host.showPopover();}catch{}}};
  const mode=()=>{ui.classList.toggle('interact',interacting||alt);const button=root.querySelector('[data-action=mode]');button.setAttribute('aria-pressed',String(!interacting&&!alt));button.textContent=interacting||alt?'Interact':'Inspect';};
  const select=node=>{if(!node||own(node))return;selected=node;details=true;hover=node;renderCard();schedule();dispatch('selected',{element:{tag:node.localName,id:node.id.slice(0,160),name:(node.getAttribute('name')??'').slice(0,160),classes:[...node.classList].slice(0,5).join('.')}});};
  const toggle=value=>{enabled=value??!enabled;ui.hidden=!enabled;mode();if(enabled){needsScan=true;topLayer();renderCard();schedule();}else{observer.disconnect();selected=null;hover=null;alt=false;interacting=false;marks.innerHTML='';tip.hidden=true;try{host.hidePopover();}catch{}if(frame)cancelAnimationFrame(frame);frame=0;}dispatch('toggled',{enabled});};
  const identityAttributes=['class','style','hidden','open','id','for','role','type','data-th','data-form-layout','data-formid','data-viewid','data-selected-view','data-entityname','data-entity','name','data-field','data-fieldname','data-attribute','data-pcf-schema','data-pcf-native-field','data-listid','data-controlid','slot'];
  const observer=new MutationObserver(records=>{if(!host.isConnected){const existing=document.getElementById('paqvilo-xray');if(host.parentElement?.matches('dialog')&&document.body?.isConnected&&(!existing||existing===host)){topLayer(true);}else{host.__px?.dispose();return;}}if(!enabled)return;const external=records.filter(record=>!own(record.target)&&!(record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(node=>node===host)));if(!external.length)return;if(selected){const associated=lineage(selected).find(item=>item.localName==='label')?.control;const related=[...lineage(selected),...lineage(associated)];if(external.some(record=>record.attributeName!=='style'&&(record.type==='childList'||related.includes(record.target)||lineage(record.target).includes(selected)||record.attributeName==='id'||record.target.localName==='slot')))detailsDirty=true;}needsScan=true;if(external.some(record=>record.type==='childList'||record.attributeName==='open'))topLayer();schedule();});
  listen(document,'toggle',event=>{if(event.target===host||!event.target.matches?.('dialog,[popover]'))return;if(event.target.matches('dialog:modal')){modalOrder=modalOrder.filter(node=>node!==event.target);modalOrder.push(event.target);}if(enabled){topLayer(event.newState==='open');schedule();}},{capture:true});
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});
  listen(window,'pointermove',event=>{if(!enabled)return;pointer={x:event.clientX,y:event.clientY};if(drag){card.style.left=Math.max(8,Math.min(innerWidth-card.offsetWidth-8,event.clientX-drag.x))+'px';card.style.top=Math.max(74,Math.min(innerHeight-card.offsetHeight-8,event.clientY-drag.y))+'px';card.style.right='auto';card.style.bottom='auto';return;}const node=event.composedPath().find(item=>item instanceof Element);if(own(node)&&!node?.classList?.contains('shield'))return;hover=node?.classList?.contains('shield')?underPointer(event.clientX,event.clientY):node;if(own(hover))hover=null;schedule();},{capture:true});
  for(const type of ['pointerdown','pointerup','mousedown','mouseup','click','dblclick','contextmenu','auxclick'])listen(window,type,event=>{if(!enabled||interacting||alt||event.altKey)return;const node=event.composedPath().find(item=>item instanceof Element);if(!node||(own(node)&&!node.classList?.contains('shield')))return;event.preventDefault();event.stopImmediatePropagation();if(type==='click')select(node.classList?.contains('shield')?underPointer(event.clientX,event.clientY):node);},{capture:true});
  listen(window,'scroll',schedule,{capture:true,passive:true});listen(window,'resize',()=>{card.style.left='';card.style.top='';card.style.right='';card.style.bottom='';schedule();},{passive:true});
  listen(window,'keydown',event=>{
    if(event.altKey&&event.shiftKey&&event.code==='KeyX'){event.preventDefault();event.stopImmediatePropagation();toggle();return;}
    if(!enabled)return;if(event.key==='Alt'){alt=true;mode();schedule();return;}
    const node=event.composedPath().find(item=>item instanceof Element);if(event.key==='Tab'&&!interacting&&!alt){event.preventDefault();event.stopImmediatePropagation();const controls=[...root.querySelectorAll('button:not(:disabled),select')].filter(item=>item.getClientRects().length);const index=controls.indexOf(root.activeElement),direction=event.shiftKey?-1:1;controls[(index+direction+controls.length)%controls.length]?.focus({preventScroll:true});return;}
    if(own(node)&&node?.matches('input,select,textarea'))return;
    if((interacting||alt)&&!own(node))return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(selected){selected=null;renderCard();schedule();}else toggle(false);return;}
    if(interacting||alt)return;
    // Do not let keyboard activation submit a focused portal form while inspecting.
    if(['ArrowUp','ArrowDown','[',']'].includes(event.key)||!own(node)&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(event.key==='ArrowUp'&&selected)select(parent(selected));if(event.key==='ArrowDown'&&selected)select(child(selected));if(event.key==='['||event.key===']'){const stack=hitStack(pointer.x,pointer.y),index=stack.indexOf(selected??hover),next=index<0?0:(index+(event.key===']'?1:-1)+stack.length)%stack.length;select(stack[next]);}}
  },{capture:true});
  listen(window,'keyup',event=>{if(event.key==='Alt'){alt=false;mode();schedule();}if(enabled&&!interacting&&!own(event.composedPath().find(item=>item instanceof Element))&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  listen(document,'visibilitychange',()=>{alt=false;mode();schedule();});
  listen(root,'wheel',event=>{
    if(!event.target.classList?.contains('shield')||interacting||alt||event.ctrlKey)return;
    event.preventDefault();const node=underPointer(event.clientX,event.clientY);if(!node)return;
    const line=parseFloat(getComputedStyle(node).lineHeight)||16,factor=event.deltaMode===1?line:1;
    let dx=event.deltaX*factor,dy=event.deltaY*factor;
    if(event.deltaMode===2){dx*=innerWidth;dy*=innerHeight;}
    if(event.shiftKey&&!dx){dx=dy;dy=0;}
    for(const [axis,amount] of [['x',dx],['y',dy]]){
      if(!amount)continue;
      for(const current of lineage(node)){
        const css=getComputedStyle(current),vertical=axis==='y',overflow=vertical?css.overflowY:css.overflowX;
        const extent=vertical?current.scrollHeight-current.clientHeight:current.scrollWidth-current.clientWidth;
        const rootScroller=current===document.scrollingElement;
        if((!/auto|scroll/.test(overflow)&&!rootScroller)||extent<=0)continue;
        const offset=vertical?current.scrollTop:current.scrollLeft;
        const rtl=!vertical&&css.direction==='rtl';
        const canScroll=rtl?(amount<0?offset>-extent+1:offset<0):(amount<0?offset>0:offset<extent-1);
        if(canScroll){current.scrollBy({left:vertical?0:amount,top:vertical?amount:0,behavior:'instant'});break;}
        if(/contain|none/.test(vertical?css.overscrollBehaviorY:css.overscrollBehaviorX))break;
      }
    }
    schedule();
  },{passive:false});
  listen(window,'blur',()=>{alt=false;drag=null;mode();schedule();});
  listen(root,'pointerdown',event=>{const header=event.target.closest('.cardhead');if(!header||event.target.closest('button'))return;const r=card.getBoundingClientRect();drag={x:event.clientX-r.left,y:event.clientY-r.top};header.setPointerCapture(event.pointerId);event.preventDefault();});
  listen(window,'pointerup',()=>{drag=null;},{capture:true});
  listen(root,'change',event=>{if(event.target.matches('select')){layer=event.target.value;schedule();}});
  listen(root,'click',async event=>{const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
    if(action==='refresh'){setStatus('Refreshing local source inspection…');dispatch('refresh');}if(action==='exit')toggle(false);if(action==='mode'){interacting=!interacting;mode();schedule();}if(action==='details'){details=!details;card.hidden=!details;}
    if(action==='source-region'){let region;try{region=lineage(selected).find(node=>node.matches(button.dataset.selector));}catch{}if(region)select(region);else setStatus('This source region is no longer present. Select a rendered element again.');}if(action==='clear'){selected=null;renderCard();schedule();}if(action==='parent')select(parent(selected));if(action==='child')select(child(selected));if(action==='ancestor')select(lineage(selected)[Number(button.dataset.index)]);
    if(action==='reveal'){selected?.scrollIntoView({block:'center',inline:'nearest'});schedule();}if(action==='dock'){const r=card.getBoundingClientRect();card.style.left=r.left>innerWidth/2?'20px':'auto';card.style.right=r.left>innerWidth/2?'auto':'20px';}
    if(action==='copy'){try{await navigator.clipboard.writeText(button.dataset.copy);setStatus('Source path copied.');}catch{setStatus('The browser could not copy the source path.');}}
    if(action==='open')dispatch('open',{ref:button.dataset.ref,line:Number(button.dataset.line)||undefined,find:button.dataset.find||undefined});
  });
  // Periodic geometry refresh covers animations, transforms and resize without continuous layout reads.
  let geometryTicks=0;const timer=setInterval(()=>{if(++geometryTicks%5===0)needsScan=true;schedule();},300);
  host.__px={toggle,get token(){return d.token;},get enabled(){return enabled;},update(next,nextReport){const previousError=d.inspectionError;d=next;const theme=document.getElementById('paqvilo-panel')?.shadowRoot?.querySelector('.wrap');if(theme){const style=getComputedStyle(theme);for(const key of ['--bg','--fg','--muted','--primary','--link','--on-primary','--radius','--line','--head-bg','--panel-line','--shadow','--font']){const value=style.getPropertyValue(key);if(value)ui.style.setProperty(key,value);}}const currentReport=next.inspectionError||next.inspection?.active===false?null:nextReport;if(currentReport!==undefined&&currentReport!==report){report=currentReport;needsScan=true;renderCard();schedule();}else if(previousError!==d.inspectionError)renderCard();if(next.ui?.hidden&&enabled)toggle(false);},status:setStatus,dispose(){disposed=true;clearInterval(timer);cancelAnimationFrame(frame);observer.disconnect();lifetime.abort();host.remove();}};
}
