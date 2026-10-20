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
    .scan-wash{position:fixed;inset:0;pointer-events:none;background:linear-gradient(180deg,transparent,color-mix(in srgb,var(--primary) 7%,transparent),transparent);height:45vh;bottom:auto;animation:xray-scan 2.8s ease-in-out infinite}.scan-state{position:fixed;left:50%;bottom:55px;transform:translateX(-50%);width:max-content;max-width:calc(100vw - 24px);padding:14px 18px;display:flex;align-items:center;gap:12px;background:var(--bg);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);pointer-events:auto}.scan-state strong{display:block;font-weight:600}.scan-state p{margin:2px 0 0;color:var(--muted);font-size:12px}.scan-state button{margin-left:8px;color:var(--link);border:1px solid var(--line)}.scan-orbit{display:inline-block;width:24px;height:24px;flex:none;border:2px solid var(--line);border-top-color:var(--primary);border-radius:50%;animation:xray-orbit .9s linear infinite}.scan-state.error .scan-orbit{animation:none;border-color:var(--muted);border-radius:4px}.scan-state[hidden],.scan-wash[hidden]{display:none}.ui.loading .tip{display:none}.ui.loading .legend{opacity:.7}@keyframes xray-scan{from{transform:translateY(-100%)}to{transform:translateY(100vh)}}@keyframes xray-orbit{to{transform:rotate(360deg)}}
    @media(max-width:850px){.bar{top:8px;gap:3px;padding:5px}.bar .hint,.brand span{display:none}.brand{padding-right:3px}.bar button{font-size:11.5px;padding:4px}.bar select{max-width:118px;font-size:11px}.card{top:auto;bottom:44px;max-height:46dvh;width:380px;right:8px}.scan-state{bottom:55px}.ui:has(.card:not([hidden])) .scan-state{bottom:auto;top:55px}.legend{bottom:8px;font-size:10px}.legend .hint{display:none}}@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important}.scan-wash{transform:translateY(25vh)}}
  `);
  root.adoptedStyleSheets = [sheet];
  root.innerHTML = `<div class="ui" hidden><div class="shield"></div><div class="marks"></div><div class="bar" role="toolbar" aria-label="Lense X-ray"><div class="brand"><strong>paqvilo</strong><span>X-ray</span></div><button data-action="mode" aria-pressed="true">Inspect</button><select aria-label="Highlight layer"><option value="all">All sources</option><option value="data">Forms & data</option><option value="content">Templates & content</option><option value="none">Selection only</option></select><button data-action="details" aria-pressed="true" title="Show or hide source details">Details</button><button data-action="refresh" aria-label="Refresh source inspection" title="Refresh sources and component bindings">↻</button><span class="hint"><kbd>Ctrl</kbd> interact</span><button class="exit" data-action="exit" aria-label="Turn off X-ray">×</button></div><aside class="card" aria-label="Power Pages source details"></aside><div class="tip" hidden></div><div class="legend"><i style="background:#29805b"></i>Fields<i style="background:#3975ad"></i>Forms & views<i style="background:#947330"></i>Source markup <span class="hint"> · click to select · <kbd>Esc</kbd> back · background limits: 800 candidates / 250 outlines</span></div></div>`;

  const ui = root.querySelector('.ui'), marks = root.querySelector('.marks'), card = root.querySelector('.card'), tip = root.querySelector('.tip');
  const wash=document.createElement('div');wash.className='scan-wash';wash.hidden=true;wash.setAttribute('aria-hidden','true');ui.prepend(wash);
  const scanState=document.createElement('div');scanState.className='scan-state';scanState.hidden=true;scanState.setAttribute('role','status');scanState.setAttribute('aria-live','polite');ui.append(scanState);
  const lifetime = new AbortController(), listen = (target, type, fn, options = {}) => target.addEventListener(type, fn, { ...options, signal: lifetime.signal });
  const viewListeners=[],frameViews=new Map();
  const listenViews=(type,fn,options={})=>{listen(window,type,fn,options);viewListeners.push([type,fn,options]);};
  const watchFrame=doc=>{
    if(frameViews.has(doc))return;const controller=new AbortController();
    for(const [type,fn,options] of viewListeners)doc.defaultView.addEventListener(type,fn,{...options,signal:controller.signal});
    const release=hookAnimationView(doc.defaultView);if(release)controller.signal.addEventListener('abort',release,{once:true});
    frameViews.set(doc,controller);
  };
  const releaseFrames=()=>{for(const controller of frameViews.values())controller.abort();frameViews.clear();};
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c]);
  const norm = value => String(value ?? '').replace(/[{}]/g, '').toLowerCase();
  let geometryCache=null,styleCache=null;
  const styleFor=node=>{if(!styleCache)return getComputedStyle(node);if(!styleCache.has(node))styleCache.set(node,getComputedStyle(node));return styleCache.get(node);};
  let d = data, report = null, enabled = false, interacting = false, ctrl = false, selected = null, hover = null, layer = 'all', details = true, frame = 0, candidates = [], needsScan = true, detailsDirty=false, pointer = { x: 0, y: 0 }, drag = null, disposed = false;
  let oneShot=false,candidateLimit=false,pickGesture=false,pendingPick=null,warmup=false;
  const inspectionError=()=>{const inspection=d.inspection??d.mirage;return d.inspectionError||(inspection?.active===false?inspection.error||'Source inspection is unavailable.':'');};
  const renderProgress=()=>{
    const error=inspectionError(),pending=d.inspectionLoading??Boolean((d.inspection??d.mirage)?.loading),loading=(!report||pending)&&!error;
    ui.classList.toggle('loading',loading&&!report);ui.setAttribute('aria-busy',String(loading));wash.hidden=!loading||Boolean(report);scanState.hidden=!loading&&!error;
    const html=error?`<span class="scan-orbit" aria-hidden="true"></span><div><strong>Source inspection unavailable</strong><p>Details: ${esc(error)}</p></div><button data-action="refresh">Retry</button>`:`<span class="scan-orbit" aria-hidden="true"></span><div><strong>${report?'Updating source inspection':pending?'Reading local sources':'Preparing X-ray'}</strong><p>${esc((d.inspection??d.mirage)?.phase??(report?'Previous details remain visible while sources update.':'Matching rendered elements to their origins.'))} You can exit at any time.</p></div>`;
    if(scanState.innerHTML!==html)scanState.innerHTML=html;scanState.classList.toggle('error',Boolean(error));
    const refresh=root.querySelector('.bar [data-action="refresh"]');refresh.disabled=Boolean(pending);refresh.setAttribute('aria-busy',String(Boolean(pending)));
  };
  const own = node => node === host || node?.closest?.('#paqvilo-panel,#paqvilo-handle,#paqvilo-xray') || ['paqvilo-panel','paqvilo-handle','paqvilo-xray'].includes(node?.getRootNode?.()?.host?.id);
  const label = node => `${node.localName}${node.id ? '#' + node.id.slice(0,160) : ''}${!node.id && node.classList?.length ? '.' + [...node.classList].slice(0,2).join('.') : ''}`;
  const descent=new WeakMap();
  const child = node => descent.get(node)?.isConnected&&parent(descent.get(node))===node?descent.get(node):node?.localName==='iframe'?frameDocument(node)?.body:[...(node?.shadowRoot?.children ?? node?.children ?? [])].find(item=>!item.matches('style,script,link')&&!own(item));
  const frameOf=doc=>{try{return doc?.defaultView?.frameElement??null;}catch{return null;}};
  const frameDocument=node=>{try{const doc=node.contentDocument;return doc?.documentElement?doc:null;}catch{return null;}};
  const liveNode=node=>{if(!node?.isConnected)return false;let doc=node.ownerDocument;for(let depth=0;doc!==document&&depth<40;depth++){const frame=frameOf(doc);if(!frame?.isConnected||frameDocument(frame)!==doc)return false;doc=frame.ownerDocument;}return doc===document;};
  const parent = node => node?.assignedSlot ?? node?.parentElement ?? node?.getRootNode?.()?.host ?? frameOf(node?.ownerDocument) ?? null;
  const lineage = node => { const rows = []; for (let current = node; current; current = parent(current)) rows.push(current); return rows; };
  const labelledControl=node=>{
    const labelNode=lineage(node).find(item=>item.localName==='label');
    const labelScope=labelNode?.closest('[data-formid],[data-form-layout],[id^="EntityFormControl"],[id^="WebFormControl"],[data-entityname],[data-entity],form');
    return labelNode?.htmlFor?[...(labelScope??labelNode.parentElement??document).querySelectorAll('[id]')].find(item=>item.id===labelNode.htmlFor)??null:labelNode?.querySelector('input,select,textarea,output')??null;
  };
  const binding = node => {
    const labelled=labelledControl(node);
    const chain=lineage(labelled??node);
    // The containing frame may supply its form ID; host-page forms are a separate context.
    if(node.ownerDocument!==document){const boundary=chain.findIndex(item=>item.localName==='iframe');if(boundary>=0)chain.splice(boundary+1);}
    const documentForm=doc=>{try{const url=new URL(doc.URL);return url.origin===location.origin?url.searchParams.get('entityformid')??'':'';}catch{return '';}};
    const compact=value=>norm(value).replace(/-/g,'').replace(/[^a-z0-9_]/g,'_');
    const allForms=[...(report?.forms??[]),...(report?.componentIndex?.forms??[]).filter(form=>!(report?.forms??[]).some(known=>norm(known.id)===norm(form.id)))];
    const pageLists=(report?.components??[]).filter(item=>item.kind==='list'),allLists=[...pageLists,...(report?.componentIndex?.lists??[]).filter(list=>!pageLists.some(known=>norm(known.id??known.recordId)===norm(list.id??list.recordId)))];
    const nativeAt=current=>allForms.filter(form=>['EntityFormControl_','WebFormControl_'].some(prefix=>current.id===prefix+compact(form.id)||current.id===prefix+compact(form.id)+'_EntityFormView'));
    let entity='',formId='',viewId='',listId='',forms=[],views=[],lists=[],family='',context='',conflict=false,formCertain=false,listCertain=false;
    const scope=[];
    for(const current of chain){
      let shape={};try{const parsed=JSON.parse(current.getAttribute('data-form-layout')??current.querySelector(':scope > [data-form-layout]')?.getAttribute('data-form-layout')??'{}');if(parsed&&typeof parsed==='object'&&!Array.isArray(parsed))shape=parsed;}catch{}
      const value=name=>current.getAttribute(name)??'';
      const declared=value('data-entityname')||value('data-entity')||String(shape.EntityName??'');
      let frameForm='';if(current.localName==='iframe'){try{const url=new URL(current.getAttribute('src'),current.ownerDocument.baseURI);if(url.origin===location.origin)frameForm=(node.ownerDocument!==document&&current===frameOf(node.ownerDocument)?documentForm(node.ownerDocument):'')||url.searchParams.get('entityformid')||'';}catch{}}
      const fallbackForm=/^EntityFormControl(?:_EntityFormView)?$/.test(current.id)?current.ownerDocument===document?report?.page?.entityFormId??report?.page?.basicFormId??'':documentForm(current.ownerDocument):'';
      const fallbackList=current.ownerDocument===document&&/^EntityListControl$/.test(current.id)?report?.page?.listId??'':'';
      const fid=value('data-formid')||String(shape.Id??'')||frameForm||fallbackForm;
      let vid=value('data-viewid')||value('data-selected-view');
      if(!vid&&current.hasAttribute('data-view-layouts'))try{const layouts=JSON.parse(atob(value('data-view-layouts')));if(Array.isArray(layouts)&&layouts.length===1)vid=String(layouts[0].Id??layouts[0].id??'');}catch{}
      let lid=value('data-listid')||/^EntityList(?:Control_)?([0-9a-f]{32}|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})(?:$|_)/i.exec(current.id)?.[1]||fallbackList;
      let inferredList=Boolean(fallbackList&&!value('data-listid'));
      if(!lid&&current.matches('.entitylist,.entity-grid')&&!current.closest('.subgrid')){const candidates=(report?.components??[]).filter(item=>item.kind==='list'&&(!vid||(item.viewIds??[]).some(id=>norm(id)===norm(vid))));if(candidates.length===1){lid=candidates[0].recordId??candidates[0].id;inferredList=true;}}
      const nativeForms=nativeAt(current);
      const recordForms=allForms.filter(item=>fid&&norm(item.id)===norm(fid));
      const nextForms=recordForms.length?recordForms:nativeForms.length?nativeForms:allForms.filter(item=>fid&&norm(item.formXml?.id)===norm(fid));
      const nextViews=(report?.views??[]).filter(item=>vid&&norm(item.id)===norm(vid));
      const nextLists=allLists.filter(item=>lid&&compact(item.recordId??item.id)===compact(lid));
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
      if(nextLists.length&&!inferredList)listCertain=true;

    }
    if(!views.length&&lists.length===1&&lists[0].viewIds?.length===1)views=(report?.views??[]).filter(item=>norm(item.id)===norm(lists[0].viewIds[0]));
    const fieldAttributes=['data-attribute','data-field','data-fieldname','data-pcf-native-field','data-th','data-lookup-datafieldname'];
    const explicit=scope.find(item=>fieldAttributes.some(name=>item.hasAttribute(name)));
    const control=labelled??scope.find(item=>item.matches('input,select,textarea,output'));
    const names=explicit?fieldAttributes.map(key=>explicit.getAttribute(key)).filter(Boolean):control?[control.id,control.getAttribute('name')].filter(Boolean):[];
    if(control&&entity)for(const name of [...names])if(name.includes('$'))names.push(name.split('$').at(-1));
    const cell=control?.closest('.cell,.form-group,td,[data-fieldname]');
    if(cell){
      for(const name of [...names]){const base=name.replace(/_(?:name|entityname|datepicker_description|datepicker|timepicker_description|timepicker|i\d+|option_\d+|\d+|selected|value|container)$/i,'');if(base!==name&&([...cell.querySelectorAll('input')].some(item=>(item.id===base||item.name===base)&&(item.type==='hidden'||/_(?:date|time)picker(?:_description)?$/i.test(name)))||control.matches('input[type=radio],input[type=checkbox]')&&chain.some(item=>item.id===base&&cell.contains(item))))names.push(base);}
    }
    const fields=conflict?[]:(report?.columns??[]).filter(item=>names.includes(item.name)&&(!entity||item.entity===entity));
    // A grid's table is a binding boundary, but its enclosing form still owns the
    // FormXml control. Resolve ownership separately from the selected row's table.
    const ownerForms=chain.map(current=>{let id=current.getAttribute('data-formid');if(!id)try{id=JSON.parse(current.getAttribute('data-form-layout')??'{}')?.Id;}catch{}return id?(report?.forms??[]).filter(form=>norm(form.id)===norm(id)||norm(form.formXml?.id)===norm(id)):nativeAt(current);}).find(items=>items.length)??forms;
    const native=(report?.nativeComponents??[]).filter(item=>scope.some(ancestor=>ancestor.id===item.id||ancestor.getAttribute('data-lookup-datafieldname')===item.id)&&(!ownerForms.length||ownerForms.some(form=>norm(form.id)===norm(item.formId)))&&(!item.viewId||!viewId||norm(item.viewId)===norm(viewId)));
    const schema=scope.find(item=>item.hasAttribute('data-pcf-schema'))?.getAttribute('data-pcf-schema');
    const code=(report?.codeComponents??[]).filter(item=>schema&&norm(item.schemaName)===norm(schema)||item.binding==='native-formxml'&&item.selectedDesktop&&item.enablement==='configured'&&ownerForms.some(form=>norm(form.id)===norm(item.formId))&&scope.some(node=>node.id==='PcfControl_'+item.field||node.getAttribute('data-pcf-native-field')===item.field));
    return {entity,fields,forms,views,lists,native,code,formId,viewId,listId,context,conflict,formCertain,listCertain};
  };
  const framework=/^(?:alert(?:-.+)?|message|form-control|btn(?:-.+)?|close|title|row|container(?:-fluid)?|col-(?:xs|sm|md|lg|xl|xxl)-\d+|modal(?:-.+)?|control-label|input-group(?:-.+)?|clearfix|pull-(?:left|right)|text-(?:left|right|center|muted)|hidden|show|active)$/;
  let rankingReport,frequencies,pageOwners;
  const sourceMatches = node => {
    const ancestors=lineage(node).filter(item=>item.ownerDocument===node.ownerDocument),rows=[];
    if(rankingReport!==report||!frequencies){
      rankingReport=report;frequencies=new Map();pageOwners=new Set(['page']);
      for(const item of report?.elementSources??[])if(item.matchKind==='class'){let files=frequencies.get(item.selector);if(!files)frequencies.set(item.selector,files=new Set());files.add((item.ref??item.sourceFile)+'#'+(item.recordId??item.id??item.name??''));}
      const sources=[...(report?.webTemplates??[]).map(item=>({...item,owners:['web-template:'+norm(item.id),'web-template:'+item.name]})),...(report?.snippets??[]).map(item=>({...item,owners:['content-snippet:'+norm(item.id),'content-snippet:'+item.name]}))];
      let changed=true;
      while(changed){changed=false;for(const item of sources)if(!item.owners.every(owner=>pageOwners.has(owner))&&(item.includedBy??item.usedBy)?.some(owner=>owner.startsWith('page-template:')||pageOwners.has(owner))){for(const owner of item.owners)pageOwners.add(owner);changed=true;}}
    }
    for(const item of report?.elementSources??[]){try{
      const exactDepth=ancestors.findIndex(ancestor=>ancestor.matches(item.selector));
      const depth=exactDepth>=0?exactDepth:item.matchKind==='class'?ancestors.findIndex(ancestor=>ancestor.localName===item.tag&&(item.classes??[]).some(name=>ancestor.classList.contains(name))):-1;if(depth<0)continue;
      const target=ancestors[depth];
      const locations=item.locations??[];
      const matchingTags=locations.filter(location=>!location.tag||location.tag===target.localName);
      const contexts=(matchingTags.length?matchingTags:locations).map(location=>{
        const agreement=(location.contexts??[]).filter(selector=>ancestors.slice(depth+1).some(ancestor=>ancestor.matches(selector))).length,declared=location.classes??item.classes??[],present=declared.filter(name=>target.classList.contains(name)).length;
        let contextual=0,contradictions=0;
        for(const context of location.ancestors??[]){const container=ancestors.slice(depth+1).find(ancestor=>ancestor.localName===context.tag&&context.classes.some(name=>ancestor.classList.contains(name)));if(!container)continue;const missing=context.classes.filter(name=>!container.classList.contains(name));contradictions+=missing.length;contextual+=missing.length?0:context.classes.filter(name=>!framework.test(name)).length;}
        return {...location,agreement,contextual,contradictions,locationScore:agreement*20+present*5-(declared.length-present)*65+contextual*20-contradictions*65};
      }).sort((a,b)=>b.locationScore-a.locationScore);
      const declaredClasses=contexts[0]?.classes??item.classes??[],classes=declaredClasses.filter(name=>target.classList.contains(name)),meaningful=classes.filter(name=>!framework.test(name));
      const agreed=contexts[0]?.agreement??0,tagMatch=locations.some(location=>location.tag===target.localName)||!item.tag||item.tag===target.localName;
      const pageChain=(item.includedBy??item.usedBy)?.some(owner=>owner.startsWith('page-template:')||pageOwners.has(owner))??false;
      const missing=declaredClasses.length-classes.length,targetClasses=[...target.classList].filter(name=>!framework.test(name)),coverage=targetClasses.length?meaningful.length/targetClasses.length:1;
      const rarity=report?.elementSourceFrequencies?.[item.selector]??frequencies.get(item.selector)?.size??1;
      const contextual=contexts[0]?.contextual??0,contradictions=contexts[0]?.contradictions??0;
      // Static reachability and selector rarity cannot prove a conditional branch rendered.
      const strong=tagMatch&&!missing&&!contradictions&&(item.matchKind==='id'||item.matchKind==='attribute'||item.matchKind==='class'&&(meaningful.length>0&&(coverage>=1||rarity<=2)||contextual>0||agreed>0&&meaningful.length>0));
      const attributeCount=Object.entries(contexts[0]?.attributes??item.attributes??{}).filter(([key,value])=>target.getAttribute(key)===value).length;
      // Prefer stronger evidence across adjacent regions, but do not let a distant
      // page-container ID eclipse the distinctive template immediately around a node.
      const score=attributeCount*5+(item.matchKind==='id'?110:item.matchKind==='attribute'?85:item.matchKind==='class'?35+classes.length*5+meaningful.length*10:20)+(tagMatch?10:-85)+agreed*20+contextual*20-contradictions*65-depth*40+coverage*15-missing*65-Math.min(10,Math.log2(Math.max(1,rarity))*2);
      const best=contexts.filter(location=>location.locationScore===contexts[0]?.locationScore);
      rows.push({...item,line:best[0]?.line??item.line,lines:best.map(location=>location.line).filter(Boolean),depth,score,strong,pageChain,
        evidenceLabel:`${item.kind==='script'?'Script reference':strong?'Markup match':'Possible match'}: ${item.selector}${depth?' on an enclosing element':''}${item.occurrences>1?' · '+item.occurrences+' locations in this source':''}`});
    }catch{}}
    // A page's include graph cannot disambiguate identical snippet markup.
    // Keep equally supported snippets as possibilities instead of choosing a name.
    for(const row of rows)if(row.kind==='snippet'&&row.strong&&rows.some(other=>other!==row&&other.kind==='snippet'&&other.sourceFile!==row.sourceFile&&other.selector===row.selector&&other.depth===row.depth&&other.score===row.score))row.ambiguous=true;
    for(const row of rows)if(row.ambiguous){row.strong=false;row.evidenceLabel=row.evidenceLabel.replace('Markup match:','Possible match:');}
    const ranked=rows.sort((a,b)=>Number(b.strong)-Number(a.strong)||b.score-a.score||a.depth-b.depth||Number(b.pageChain)-Number(a.pageChain));
    const result=ranked.slice(0,60);result.omitted=Math.max(0,ranked.length-result.length);return result;
  };
  const dispatch = (action, detail = {}) => host.dispatchEvent(new CustomEvent('paqvilo-xray', { bubbles:true, detail:{action,...detail} }));
  const setStatus = message => { const output = card.querySelector('.status'); if (output) output.textContent = message; };
  const kindName=kind=>({'template':'Web template','snippet':'Content snippet','page':'Page copy','basic-form':'Basic form','advanced-form':'Multistep form','list':'List','script':'Script','field':'Column','view':'View','table':'Table','image':'Image','stylesheet':'Stylesheet','asset':'Asset'}[kind]??kind??'Source');
  const sourceRows = (rows, evidence) => rows.map(item => `<div class="source"><div class="name"><b>${esc(item.name ?? item.label ?? 'Source')}</b><span class="badge">${esc(kindName(item.kind))}</span></div><div class="mono">${esc(item.ref ?? item.url ?? 'Source unavailable')}${item.lines?.length?':'+item.lines.join(', '):item.line?':'+Number(item.line):''}</div>${item.evidenceLabel||evidence?`<div class="note">${esc(item.evidenceLabel??evidence)}</div>`:''}${item.ref ? `<div class="actions"><button data-action="open" data-ref="${esc(item.ref)}" data-line="${Number(item.line)||''}" data-find="${esc(item.fieldPath && /powerpagecomponent\.xml$/i.test(item.ref) ? '"'+item.fieldPath+'":' : item.find ?? '')}">Open source ↗</button><button data-action="copy" data-copy="${esc(item.path??item.sourceFile??item.ref)}">Copy path</button>${item.depth?`<button data-action="source-region" data-selector="${esc(item.selector)}">Select source region</button>`:''}</div>` : ''}</div>`).join('');
  const identify=node=>{
    const b=binding(node),matches=sourceMatches(node).filter(item=>item.kind!=='script');
    if(b.conflict)return {title:'Conflicting table context',kind:'Unresolved binding',sub:'The rendered table and exported component disagree.',b,matches};
    if(b.fields.length===1){const field=b.fields[0];return {title:field.label??field.name,kind:'Dataverse column'+(b.entity?'':' · candidate'),sub:field.entity+'.'+field.name,b,matches};}
    if(b.code.length===1){const item=b.code[0];return {title:item.schemaName??item.name,kind:'Code component',sub:item.entity??'',b,matches};}
    if(b.forms.length===1&&b.native.length!==1)return {title:b.forms[0].name,kind:kindName(b.forms[0].kind??'basic-form')+(b.formCertain?'':' · candidate'),sub:b.forms[0].entity??'',b,matches};
    if(b.lists.length===1)return {title:b.lists[0].name,kind:'Power Pages list'+(b.listCertain?'':' · candidate'),sub:b.lists[0].entity??'',b,matches};
    if(b.views.length===1)return {title:b.views[0].name,kind:'Dataverse view',sub:b.views[0].entity??'',b,matches};
    if(b.native.length===1){const item=b.native[0];return {title:item.formName??item.name,kind:item.kind==='quickform'?'Quick view':item.kind==='subgrid'?'Subgrid':kindName(item.kind),sub:[item.entity,item.owner].filter(Boolean).join(' · '),b,matches};}
    if(b.code.length===1){const item=b.code[0];return {title:item.schemaName??item.name,kind:'Code component',sub:item.entity??'',b,matches};}
    const match=matches.find(item=>item.strong);
    if(match)return {title:match.name,kind:kindName(match.kind)+' · source match',sub:match.ref??'',b,matches};
    return {title:b.fields.length>1?'Ambiguous column':'No reliable source',kind:'Selected element',sub:b.context||'Use page context or select an enclosing source region.',b,matches};
  };
  const selectionIdentity=node=>{if(!node)return null;const found=identify(node),b=found.b,component=b.fields.length===1||b.forms.length||b.lists.length;return {title:found.title,kind:found.kind,sub:found.sub,fields:b.fields.map(({entity,name,label,ref})=>({entity,name,label,ref})),forms:b.forms.map(({id,name,kind,ref,formXml})=>({id,name,kind,ref,formXml})),views:b.views.map(({id,name,entity,ref})=>({id,name,entity,ref})),lists:b.lists.map(({id,recordId,name,entity,ref})=>({id:id??recordId,name,entity,ref})),sources:found.matches.filter(item=>item.strong&&(!component||item.depth===0)).slice(0,12).map(({name,kind,ref,line,selector,depth})=>({name,kind,ref,line,selector,depth}))};};
  const sourcesHtml = node => {
    const b=binding(node),exact=b.fields.length===1?b.fields[0]:null,matches=sourceMatches(node),allMarkup=matches.filter(item=>item.kind!=='script'),markup=exact||b.forms.length||b.lists.length?allMarkup.filter(item=>item.depth===0&&item.strong):allMarkup,scripts=matches.filter(item=>item.kind==='script');
    let out=b.conflict?'<div class="section"><h3>Conflicting table context</h3><p class="note">The rendered table and exported form/view disagree. No column identity is asserted.</p></div>':'';
    if(exact){
      const table=(report?.tables??[]).find(item=>item.logicalName===exact.entity);
      out+=`<div class="section"><h3>Dataverse column${b.entity?'':' · candidate'}</h3><div class="binding"><strong>${esc(exact.entity)}.${esc(exact.name)}</strong>${exact.label?`<span class="note">${esc(exact.label)}</span>`:''}</div><dl class="details"><dt>Table</dt><dd>${esc(exact.entity)}</dd><dt>Column</dt><dd>${esc(exact.name)}</dd>${exact.type?`<dt>Type</dt><dd>${esc(exact.type)}</dd>`:''}${exact.required!==undefined?`<dt>Required</dt><dd>${exact.required?'Yes':'No'}</dd>`:''}<dt>Matched by</dt><dd>${b.entity?'Column identifier + table context':'Column identifier only; candidate until table context is known'}</dd></dl>${sourceRows([{...exact,name:'Column definition',kind:'field',find:exact.name}], exact.resolved===false||!exact.ref?'Column definition unavailable in selected Solution':'Field definition in selected Solution')}${table?.ref&&table.ref!==exact.ref?sourceRows([{...table,name:'Table definition',kind:'table',find:exact.entity}]):''}</div>`;
    }else if(b.fields.length>1)out+=`<div class="section"><h3>Dataverse column</h3><div class="binding"><strong>Ambiguous field identifier</strong><div class="note">The identifiers match ${b.fields.length} exported columns. No single column is asserted.</div></div>${sourceRows(b.fields.map(item=>({...item,name:item.entity+'.'+item.name,kind:'field'})),'Candidate column')}</div>`;
    const componentSources=[...b.forms.flatMap(item=>[{...item,kind:item.kind??'basic-form',evidenceLabel:item.pageReferenced===false?'Exported form; not referenced by this page’s sources':b.formCertain?'Component ID matched to the selected export':'System form ID; candidate basic form configuration'},...(item.formXml?[{...item.formXml,name:item.formXml.name??'Dataverse form',kind:'FormXml',evidenceLabel:b.formId&&norm(b.formId)===norm(item.formXml.id)?'Dataverse system form ID matched to the selected export':'FormXml referenced by the exported form configuration'}]:[])]),...b.views.map(item=>({...item,kind:'view'})),...b.lists.map(item=>({...item,evidenceLabel:item.pageReferenced===false?'Exported list outside page references':b.listCertain?'Rendered list ID matched to the selected export':'Candidate list from page references and rendered view'}))].filter((item,index,rows)=>rows.findIndex(other=>other.kind===item.kind&&other.ref===item.ref&&other.id===item.id&&other.name===item.name)===index);
    if(componentSources.length){out+=`<div class="section"><h3>Form / view</h3>${sourceRows(componentSources,b.formId&&!b.formCertain&&b.forms.length?'System form ID; candidate basic form configuration':'Component ID matched to the selected export')}</div>`;const ids=new Set(b.forms.map(item=>norm(item.id)));const logic=(report?.components??[]).filter(item=>ids.has(norm(item.recordId??item.id))&&item.ref&&!componentSources.some(source=>source.ref===item.ref));if(logic.length)out+=`<details><summary>Form scripts</summary>${sourceRows(logic,'Exported form customization')}</details>`;}
    else if(b.formId||b.viewId||b.listId)out+='<div class="section"><h3>Form / view</h3><p class="note">This component is not referenced by this page’s sources and was not found in the available export index. Refresh sources after opening dynamic forms.</p></div>';
    if(b.native.length)out+=`<div class="section"><h3>Native component</h3>${b.native.map(item=>`<dl class="details"><dt>Control</dt><dd>${esc(item.name??item.id)}</dd><dt>Form</dt><dd>${esc(item.owner??'Unresolved')}</dd>${item.relationship?`<dt>Relation</dt><dd>${esc(item.relationship)}</dd>`:''}</dl>${sourceRows([{...item,name:kindName(item.kind)+' definition'},...(item.metadataSources??[])],'Rendered control ID matched to exported FormXml')}`).join('')}</div>`;
    const codeHtml = items => items.map(item=>`<dl class="details"><dt>Schema</dt><dd>${esc(item.schemaName??item.name)}</dd><dt>Binding</dt><dd>${esc(item.binding)}</dd>${item.entity?`<dt>Table</dt><dd>${esc(item.entity)}</dd>`:''}${item.field?`<dt>Column</dt><dd>${esc(item.field)}</dd>`:''}${item.enablement?`<dt>Portal</dt><dd>${esc(item.enablement)}</dd>`:''}</dl>${sourceRows([{...item,name:item.schemaName??item.name},item.formSource,...(item.metadataSources??[])].filter(Boolean),'Exported component binding')}${(item.properties??[]).length?`<details><summary>Manifest properties (${item.properties.length})</summary>${item.properties.map(property=>`<div class="note"><b>${esc(property.name)}</b> · ${esc(property['of-type']??property['of-type-group']??'type unresolved')} · ${esc(property.usage??'input')}${property.required==='true'?' · required':''}</div>`).join('')}</details>`:''}${Object.keys(item.parameters??{}).length?`<dl class="details">${Object.entries(item.parameters).map(([name,parameter])=>`<dt>${esc(name)}</dt><dd>${esc(parameter.kind==='binding'?'Column: '+parameter.column:parameter.kind==='dataset'?'Dataset: '+(parameter.viewId??parameter.entity??'unresolved'):parameter.kind==='unresolved'?parameter.reason??'Unresolved binding':'Exported '+parameter.kind)}</dd>`).join('')}</dl>`:''}${sourceRows(item.resources??[],'Declared component resource')}${(item.datasets??[]).map(dataset=>`<div class="binding"><strong>${esc(dataset.name)}</strong><p class="note">${esc(dataset.resolved?[dataset.entity,dataset.viewName,`${dataset.fields?.length??0} columns`].filter(Boolean).join(' · '):'Table/view binding unresolved')}</p></div>${sourceRows([dataset])}`).join('')}`).join('');
    if(b.code.length)out+=`<div class="section"><h3>Code component</h3>${codeHtml(b.code)}</div>`;
    else if(report?.codeComponents?.length)out+=`<details class="pcf-context"><summary>Page code components (${report.codeComponents.length})</summary><p class="note">Exported page references; no component-to-element binding is asserted.</p>${codeHtml(report.codeComponents)}</details>`;
    const api=(report?.apiReferences??[]).filter(item=>!b.entity||item.entity===b.entity);
    if(api.length)out+=`<details class="api-context" open><summary>Web API ${b.entity?'table context':'page context'}</summary><p class="note">${b.entity?'Exported table context; request ownership is not inferred.':'Page references; no request-to-element binding is asserted.'}</p>${api.map(item=>`<div class="binding"><strong>/_api/${esc(item.name)}</strong><p class="note">${esc(item.entity??'Table unresolved')} · ${item.evidence==='observed-api-request'?'Observed request':'Literal source reference'}</p></div>${sourceRows([item,...(item.sources??[])],'Web API source')}${sourceRows((report?.permissionRules??[]).filter(rule=>item.entity&&rule.entity===item.entity).map(rule=>({...rule,kind:'permission',evidenceLabel:`${rule.scope} · ${(rule.operations??[]).join?.(', ')??''} · effective access ${rule.effective??'unknown'}`})))}`).join('')}</details>`;
    if(markup.length){
      // Retain distinct evidence within a source too: an enclosing unique ID must
      // remain inspectable beside a nearer class match from the same file.
      const files=[...new Map(markup.map(item=>[(item.ref??item.sourceFile)+'\u0000'+item.selector,item])).values()];
      const strong=files.filter(item=>item.strong),possible=files.filter(item=>!item.strong);
      if(strong.length)out+=`<div class="section"><h3>Element source candidates <small>(${strong.length})</small></h3>${sourceRows(strong)}<p class="note">Static selector candidates; rendered invocation is not verified. Multiple templates or conditional branches can share a match.</p></div>`;
      if(possible.length)out+=`<details open><summary>Possible matches (${possible.length})</summary>${sourceRows(possible)}<p class="note">Shared selectors alone do not identify an owner. Multiple templates or conditional branches can share a match.</p></details>`;
      const owners=[...new Set(files.flatMap(item=>item.includedBy??[]))].map(owner=>{const [kind,id]=owner.split(':');return kind==='web-template'?(report?.webTemplates??[]).find(item=>norm(item.id)===norm(id))?.name:report?.page?.name??report?.page?.pageName;}).filter(Boolean);
      if(owners.length)out+=`<div class="note">Statically referenced by: ${esc([...new Set(owners)].join(', '))}</div>`;
    }else if(!exact&&!componentSources.length&&!b.native.length&&!b.code.length)out+='<div class="section"><p class="note">No local markup or component binding identifies this element. Select an enclosing region or check the page sources below.</p></div>';
    if(node.matches('img[src],link[href],script[src]')){let path;try{const url=new URL(node.getAttribute('src')??node.getAttribute('href'),node.ownerDocument.baseURI);if(url.origin===location.origin)path=url.pathname;}catch{}const assets=(report?.assets??[]).filter(item=>item.url===path);if(assets.length)out+=`<div class="section"><h3>Web file</h3>${sourceRows(assets,'Rendered resource URL')}</div>`;}
    if(report?.elementSourceLimits?.truncated)out+=`<p class="note">Source hint index truncated; some matches may be unavailable.${report.elementSourceLimits.markupOmittedSourceCount?' Export-wide markup index omitted '+esc(report.elementSourceLimits.markupOmittedSourceCount)+' oversized source'+(report.elementSourceLimits.markupOmittedSourceCount===1?'':'s')+(report.elementSourceLimits.markupOmittedSources?.length?': '+report.elementSourceLimits.markupOmittedSources.map(esc).join(', '):'')+(report.elementSourceLimits.markupOmittedSourcesTruncated?' (names limited)':'')+'. Omitted sources are not attributed to this element.':''}${report.elementSourceLimits.scriptTruncatedSources?.length?' Truncated scripts: '+report.elementSourceLimits.scriptTruncatedSources.map(esc).join(', ')+'.':''}</p>`;
    if(matches.omitted)out+=`<p class="note">Showing 60 source matches; ${matches.omitted} additional candidates are omitted from these details.</p>`;
    if(scripts.length)out+=`<details><summary>Related script references (${scripts.length})</summary>${sourceRows(scripts,'Literal selector reference; event ownership is not inferred')}</details>`;
    const page=report?.page;
    out+=`<details class="page-context"><summary>Page context${page?' · '+esc(page.pageName??page.name??''):''}</summary><dl class="details"><dt>Page</dt><dd>${esc(page?.pageName??page?.name??'Not in selected export')}</dd><dt>Template</dt><dd>${esc(page?.pageTemplateName??report?.pageTemplate?.name??'Unresolved')}</dd></dl>${sourceRows(report?.pageSources??[])}${sourceRows((report?.assets??[]).map(item=>({...item,kind:item.kind??(/\.css(?:$|\?)/i.test(item.url??item.ref??'')?'Stylesheet':'script')})),'Page asset; element ownership and applied CSS rules are not established')}${sourceRows((report?.webTemplates??[]).map(item=>({...item,kind:'template'})),'Page dependency; element ownership not established')}</details>`;
    if(!report)out=`<div class="empty"><b>${esc(d.inspectionError||(d.inspection?.active===false?d.inspection.error:'')||'Reading local sources…')}</b><p class="note">Use Refresh to retry source inspection.</p></div>`;
    return out;
  };
  const renderCard = (preserve=false) => {
    if(!enabled)return;
    renderProgress();
    const scroll=card.querySelector('.content')?.scrollTop??0,open=preserve?[...card.querySelectorAll('details[open]')].map(item=>item.querySelector('summary')?.textContent):[];card.hidden=!details||!selected;
    if(!selected){card.innerHTML=`<div class="welcome"><div class="hero">Select a portal element</div><p class="note">Hover or click to identify its template, page source, form, view or Dataverse column.</p><p class="note">Hold <kbd>Ctrl</kbd> to interact with the portal. <kbd>Esc</kbd> clears selection, then exits.</p><p class="note counts">${report?`${(report.webTemplates??[]).length} templates · ${(report.forms??[]).length} forms · ${(report.views??[]).length} views · ${(report.columns??[]).length} columns`:esc(d.inspectionError||(d.inspection?.active===false?d.inspection.error:'')||'Loading source inspection…')}</p></div>`;return;}
    const identity=identify(selected);
    const selectedRect=visibleRect(selected)??selected.getBoundingClientRect();
    if(selectedRect.left+selectedRect.width>innerWidth-434&&selectedRect.left<innerWidth-12){card.style.left='12px';card.style.right='auto';}else{card.style.left='auto';card.style.right='12px';}
    card.innerHTML=`<div class="cardhead"><div class="grow"><div class="eyebrow">${esc(identity.kind)}</div><div class="title">${esc(identity.title)}</div></div><button data-action="dock" title="Move details to the other side" aria-label="Move details">⇄</button><button data-action="clear" aria-label="Clear selection">×</button></div><div class="content">${selected.localName==='iframe'?'<p class=note>Frame boundary · accessible same-origin controls can be selected directly; cross-origin and sandbox restrictions remain in force. Open an inaccessible inner document in its own tab for control details.</p><button data-action="frame-open">Open frame in new tab</button>':''}${sourcesHtml(selected)}<details class="ancestry"><summary>Element & ancestry</summary><div class="mono element-label">${esc(label(selected))}</div><p class="note">Select an enclosing element to inspect its source. [ and ] cycle overlapping elements.</p>${lineage(selected).map((node,index)=>`<button class="crumb" data-action="ancestor" data-index="${index}" style="padding-left:${7+Math.min(index,6)*8}px">${index?'↳ ':''}${esc(label(node))}</button>`).join('')}${selected.localName==='iframe'?'<p class="note">Frame boundary: inner inspection requires an accessible same-origin document; cross-origin and sandbox restrictions are preserved.</p>':''}</details></div><div class="status" role="status"></div><div class="foot"><button data-action="parent" ${!parent(selected)||own(parent(selected))?'disabled':''}>↑ Parent</button><button data-action="child" ${!child(selected)?'disabled':''}>↓ Child</button><button data-action="reveal">Reveal</button><span class="hint">Esc to release</span></div>`;
    // New content already starts at zero. Writing scrollTop=0 would force its first
    // layout during selection even though there is no scroll position to restore.
    for(const item of card.querySelectorAll('details'))if(open.includes(item.querySelector('summary')?.textContent))item.open=true;const body=card.querySelector('.content');if(body&&scroll)body.scrollTop=scroll;
  };
  // Rectangles live outside portal layout. Clip to each scroll container without changing its CSS.
  function visibleRect(node) {
    if (!liveNode(node) || own(node)) return null;
    if(geometryCache?.has(node))return geometryCache.get(node);
    const style = styleFor(node); if(style.display==='none'||style.visibility==='hidden'||style.visibility==='collapse'||style.opacity==='0')return null;
    const doc=node.ownerDocument,view=doc.defaultView;
    let rect=node.getBoundingClientRect(), left=Math.max(0,rect.left),top=Math.max(0,rect.top),right=Math.min(view.innerWidth,rect.right),bottom=Math.min(view.innerHeight,rect.bottom);
    if(!rect.width||!rect.height)return null;
    const establishesFixed=css=>css.transform!=='none'||css.perspective!=='none'||css.filter!=='none'||css.backdropFilter&&css.backdropFilter!=='none'||/layout|paint|strict|content/.test(css.contain)||/transform|perspective|filter/.test(css.willChange);
    let escape=style.position==='fixed'?'fixed':style.position==='absolute'?'absolute':'';
    for(const ancestor of lineage(parent(node)).filter(item=>item.ownerDocument===doc)) {
      const css=styleFor(ancestor);
      if(css.display==='none'||css.opacity==='0')return null;
      if(escape&&(establishesFixed(css)||escape==='absolute'&&css.position!=='static'))escape='';
      if(!escape&&ancestor!==doc.body&&ancestor!==doc.documentElement){
        const r=ancestor.getBoundingClientRect(),sx=r.width/ancestor.offsetWidth||1,sy=r.height/ancestor.offsetHeight||1;
        if(/hidden|clip|auto|scroll/.test(css.overflowX)){left=Math.max(left,r.left+ancestor.clientLeft*sx);right=Math.min(right,r.left+(ancestor.clientLeft+ancestor.clientWidth)*sx);}
        if(/hidden|clip|auto|scroll/.test(css.overflowY)){top=Math.max(top,r.top+ancestor.clientTop*sy);bottom=Math.min(bottom,r.top+(ancestor.clientTop+ancestor.clientHeight)*sy);}
      }
      // A positioned ancestor can itself escape clipping higher in the tree.
      if(css.position==='fixed')escape='fixed';else if(css.position==='absolute'&&!escape)escape='absolute';
    }
    const embedding=frameOf(doc);
    if(embedding){
      const outer=visibleRect(embedding);
      if(!outer)return null;
      // visibleRect(embedding) is in the top viewport; retain the unclipped origin.
      const origin=frameOrigin(embedding);
      left=Math.max(outer.left,origin.x+left*origin.sx);right=Math.min(outer.left+outer.width,origin.x+right*origin.sx);
      top=Math.max(outer.top,origin.y+top*origin.sy);bottom=Math.min(outer.top+outer.height,origin.y+bottom*origin.sy);
    }
    const result=right>left&&bottom>top?{left,top,width:right-left,height:bottom-top}:null;geometryCache?.set(node,result);return result;
  }
  function frameOrigin(node){
    const r=node.getBoundingClientRect(),sx=r.width/node.offsetWidth||1,sy=r.height/node.offsetHeight||1,outer=frameOf(node.ownerDocument);
    const local={x:r.left+node.clientLeft*sx,y:r.top+node.clientTop*sy,sx,sy};
    if(!outer)return local;const p=frameOrigin(outer);return {x:p.x+local.x*p.sx,y:p.y+local.y*p.sy,sx:sx*p.sx,sy:sy*p.sy};
  }
  const rectHtml=(node,kind,tone)=>{const r=visibleRect(node);return r?`<div class="mark ${kind}" style="left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--tone:${tone}"></div>`:'';};
  const backgroundClipped=node=>lineage(node).some(item=>{const css=styleFor(item);return css.clip!=='auto'&&css.clip!==''||css.clipPath!=='none'&&css.clipPath!=='';});
  const category=node=>node.matches('input,select,textarea,[data-field],[data-attribute],[data-fieldname],[data-pcf-native-field],[data-th]')?'field':node.matches('form,[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-listid],[data-pcf-schema],.entity-grid')?'component':'content';
  const isOccluded=(node,r)=>{const x=r.left+r.width/2,y=r.top+Math.min(r.height/2,30),top=hitStack(x,y)[0];return top&&!lineage(node).includes(top)&&!lineage(top).includes(node);};
  const discoveryCursors=new WeakMap(),shadowRoots=new Set();
  let releaseShadowHook=null,releaseAnimationHook=null;
  function watchShadowRoots(){
    if(releaseShadowHook)return;
    const descriptor=Object.getOwnPropertyDescriptor(Element.prototype,'attachShadow');if(!descriptor?.value||!descriptor.configurable)return;
    const wrapped=function(...args){const surface=descriptor.value.apply(this,args);if(enabled&&!disposed&&surface.mode==='open'&&!own(this)){shadowRoots.add(surface);needsScan=true;schedule();}return surface;};
    Object.defineProperty(Element.prototype,'attachShadow',{...descriptor,value:wrapped});
    releaseShadowHook=()=>{if(Object.getOwnPropertyDescriptor(Element.prototype,'attachShadow')?.value===wrapped)Object.defineProperty(Element.prototype,'attachShadow',descriptor);};
  }
  function watchAnimations(){
    if(releaseAnimationHook)return;
    releaseAnimationHook=hookAnimationView(window);
  }
  function hookAnimationView(view){
    const prototype=view.Element.prototype,descriptor=Object.getOwnPropertyDescriptor(prototype,'animate');if(!descriptor?.value||!descriptor.configurable)return null;
    const wrapped=function(...args){const result=descriptor.value.apply(this,args);if(enabled&&!disposed&&!own(this))animate();return result;};
    Object.defineProperty(prototype,'animate',{...descriptor,value:wrapped});
    return ()=>{if(Object.getOwnPropertyDescriptor(prototype,'animate')?.value===wrapped)Object.defineProperty(prototype,'animate',descriptor);};
  }
  const scan=()=>{
    // Rebuild observed roots so detached components are not retained indefinitely.
    observer.disconnect();observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});
    const selector='input:not([type=hidden]),select,textarea,form,[data-formid],[data-form-layout],[data-viewid],[data-selected-view],[data-view-layouts],[data-listid],.entitylist,.entity-grid,[data-entityname],[data-field],[data-attribute],[data-fieldname],[data-pcf-native-field],[data-pcf-schema],[data-th],[role=dialog],dialog,iframe';
    for(const [doc,controller] of frameViews)if(!frameOf(doc)?.isConnected||frameDocument(frameOf(doc))!==doc){controller.abort();frameViews.delete(doc);}
    const hintSelectors=[...new Set((report?.elementSources??[]).map(hint=>hint.selector))];
    candidates=[];const seen=new Set(),visible=[],fallback=[];let observed=0,visibleOverflow=false;
    const addCandidate=node=>{if(own(node)||seen.has(node))return;observed=Math.min(801,observed+1);const local=node.getBoundingClientRect(),view=node.ownerDocument.defaultView;const r=local.width>0&&local.height>0&&local.bottom>0&&local.right>0&&local.left<view.innerWidth&&local.top<view.innerHeight&&visibleRect(node);const inView=r&&!backgroundClipped(node);const list=inView?visible:fallback;if(list.length<800){list.push(node);seen.add(node);}else if(inView)visibleOverflow=true;};
    for(const surface of shadowRoots)if(!surface.host.isConnected)shadowRoots.delete(surface);const roots=[document,...shadowRoots];
    for(let index=0;index<roots.length&&index<40;index++){
      const surface=roots[index];
      if(surface!==document)observer.observe(surface.documentElement??surface,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});
      for(const embedding of surface.querySelectorAll('iframe')){const inner=frameDocument(embedding);if(inner&&!roots.includes(inner)){roots.push(inner);watchFrame(inner);}}
      if(!visibleOverflow)for(const node of surface.querySelectorAll(selector)){addCandidate(node);if(visibleOverflow)break;}
      const nodes=surface.querySelectorAll('*'),start=discoveryCursors.get(surface)??0,budget=Math.min(nodes.length,surface===document?4000:Math.max(100,Math.floor(4000/Math.max(1,roots.length-1))));
      for(let offset=0;offset<budget;offset++){const node=nodes[(start+offset)%nodes.length];if(node.shadowRoot&&!own(node)){if(!roots.includes(node.shadowRoot))roots.push(node.shadowRoot);shadowRoots.add(node.shadowRoot);observer.observe(node.shadowRoot,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});}}
      discoveryCursors.set(surface,nodes.length?(start+budget)%nodes.length:0);
      for(const hintSelector of hintSelectors){if(visibleOverflow)break;try{for(const node of surface.querySelectorAll(hintSelector)){addCandidate(node);if(visibleOverflow)break;}}catch{}}
    }
    candidates=[...visible,...fallback].slice(0,800);candidateLimit=observed>800;
    root.querySelector('.legend .hint').textContent=' · click to select · Esc back'+(candidateLimit?' · Candidate limit reached (800)':'');
    needsScan=false;
    // Frame animations may already be running when their documents are discovered.
    animate();
  };
  const paint=()=>{
    frame=0;if(!enabled||disposed||document.hidden)return;if(warmup){warmup=false;schedule();return;}geometryCache=new WeakMap();styleCache=new WeakMap();
    if(selected&&!liveNode(selected)){const removed=label(selected);selected=null;renderCard();card.hidden=false;const welcome=card.querySelector('.hero');if(welcome)welcome.textContent='Element removed';const note=card.querySelector('.note');if(note)note.textContent=removed+' was replaced or removed. Click a rendered element to select it again.';}if(hover&&!liveNode(hover))hover=null;
    if(detailsDirty&&selected){detailsDirty=false;renderCard(true);notifySelection(true);}
    if(needsScan&&report)scan();
    let html='',count=0;
    if(layer!=='none')for(const node of candidates){const type=category(node);if(layer==='data'&&type==='content'||layer==='content'&&type!=='content')continue;const r=visibleRect(node);if(!r||r.width<4||r.height<4||backgroundClipped(node)||isOccluded(node,r))continue;html+=rectHtml(node,'',type==='field'?'#29805b':type==='component'?'#3975ad':'#947330');if(++count>=250)break;}
    if(selected)html+=rectHtml(selected,'selected','#76f1df');if(hover&&hover!==selected&&!interacting&&!ctrl)html+=rectHtml(hover,'hover','#c0b0ff');
    marks.innerHTML=html;
    const target=hover??selected,r=target&&visibleRect(target);tip.hidden=!report||!r||interacting||ctrl;
    if(!tip.hidden){const identity=identify(target),b=identity.b;tip.innerHTML=`<span class="note">${esc(identity.kind)}</span><b>${esc(identity.title)}</b><div class="mono">${esc(identity.sub)}</div>${b.fields.length===1&&b.forms.length?`<div class="note">${b.formCertain?'Form':'Form candidate'+(b.forms.length>1?'s':'')}: ${esc(b.forms.length===1?b.forms[0].name:b.forms.length+' configurations')}</div>`:''}`;const tr=tip.getBoundingClientRect();tip.style.left=Math.max(8,Math.min(innerWidth-tr.width-8,r.left))+'px';tip.style.top=Math.max(58,Math.min(innerHeight-tr.height-8,r.top-tr.height-8))+'px';}

    geometryCache=null;styleCache=null;

  };
  const schedule=()=>{if(!host.isConnected){host.__px?.dispose();return;}if(enabled&&!document.hidden&&!frame)frame=requestAnimationFrame(paint);};
  const hitStack=(x,y)=>{
    const stack=[],seen=new Set();
    const add=(node,depth=0,px=x,py=y)=>{if(own(node)||seen.has(node))return;seen.add(node);if(node.shadowRoot)observer.observe(node.shadowRoot,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});if(node.shadowRoot&&depth<40)for(const inner of node.shadowRoot.elementsFromPoint(px,py))if(inner.getRootNode()===node.shadowRoot)add(inner,depth+1,px,py);
      if(node.localName==='iframe'&&depth<40){const doc=frameDocument(node),r=node.getBoundingClientRect(),sx=r.width/node.offsetWidth||1,sy=r.height/node.offsetHeight||1,ix=(px-r.left)/sx-node.clientLeft,iy=(py-r.top)/sy-node.clientTop;if(doc&&ix>=0&&iy>=0&&ix<node.clientWidth&&iy<node.clientHeight)for(const inner of doc.elementsFromPoint(ix,iy))add(inner,depth+1,ix,iy);}
      stack.push(node);};
    for(const node of document.elementsFromPoint(x,y))add(node);
    return stack;
  };
  const underPointer=(x,y)=>hitStack(x,y)[0];
  let modalOrder=[];
  const topLayer=(force=false)=>{modalOrder=modalOrder.filter(node=>node.isConnected&&node.matches(':modal'));const modal=modalOrder.at(-1)??document.activeElement?.closest('dialog:modal')??[...document.querySelectorAll('dialog:modal')].at(-1);const container=modal??document.body;const moved=host.parentElement!==container;if(moved)container.append(host);if(enabled){try{const open=host.matches(':popover-open');if(open&&(force||moved))host.hidePopover();if(!open||force||moved)host.showPopover();}catch{}}};
  const mode=()=>{ui.classList.toggle('interact',interacting||ctrl);const button=root.querySelector('[data-action=mode]');button.setAttribute('aria-pressed',String(!interacting&&!ctrl));button.textContent=interacting||ctrl?'Interact':'Inspect';};
  const notifySelection=updated=>dispatch('selected',{element:{tag:selected.localName,id:selected.id.slice(0,160),name:(selected.getAttribute('name')??'').slice(0,160),classes:[...selected.classList].slice(0,5).join('.')},identity:selectionIdentity(selected),oneShot,updated});
  const select=node=>{if(!node||own(node))return;resizeObserver.disconnect();resizeObserver.observe(document.documentElement);resizeObserver.observe(node);selected=node;details=true;hover=node;renderCard();schedule();const once=oneShot;notifySelection(false);if(once)toggle(false);};
  const toggle=value=>{const next=value??!enabled;if(next===enabled)return;enabled=next;warmup=enabled;ui.hidden=!enabled;mode();if(enabled){watchShadowRoots();watchAnimations();resizeObserver.observe(document.documentElement);needsScan=true;topLayer();renderCard();schedule();animate();}else{oneShot=false;releaseShadowHook?.();releaseShadowHook=null;releaseAnimationHook?.();releaseAnimationHook=null;resizeObserver.disconnect();observer.disconnect();releaseFrames();selected=null;hover=null;ctrl=false;interacting=false;marks.innerHTML='';tip.hidden=true;try{host.hidePopover();}catch{}if(frame)cancelAnimationFrame(frame);frame=0;}dispatch('toggled',{enabled});};
  const identityAttributes=['class','style','hidden','open','id','for','role','type','src','data-th','data-form-layout','data-formid','data-viewid','data-selected-view','data-view-layouts','data-entityname','data-entity','name','data-field','data-fieldname','data-attribute','data-lookup-datafieldname','data-pcf-schema','data-pcf-native-field','data-listid','data-controlid','slot'];
  const observer=new MutationObserver(records=>{if(!host.isConnected){const existing=document.getElementById('paqvilo-xray');if(host.parentElement?.matches('dialog')&&document.body?.isConnected&&(!existing||existing===host)){topLayer(true);}else{host.__px?.dispose();return;}}if(!enabled)return;const external=records.filter(record=>!own(record.target)&&!(record.type==='childList'&&[...record.addedNodes,...record.removedNodes].every(node=>node===host)));if(!external.length)return;if(selected){const associated=labelledControl(selected);const related=[...lineage(selected),...lineage(associated)];if(external.some(record=>record.attributeName!=='style'&&(record.type==='childList'||related.includes(record.target)||lineage(record.target).includes(selected)||record.attributeName==='id'||record.target.localName==='slot')))detailsDirty=true;}needsScan=true;if(external.some(record=>record.type==='childList'||record.attributeName==='open'))topLayer();schedule();});
  listen(document,'toggle',event=>{if(event.target===host||!event.target.matches?.('dialog,[popover]'))return;if(event.target.matches('dialog:modal')){modalOrder=modalOrder.filter(node=>node!==event.target);modalOrder.push(event.target);}if(enabled){topLayer(event.newState==='open');schedule();}},{capture:true});
  observer.observe(document.documentElement,{subtree:true,childList:true,attributes:true,attributeFilter:identityAttributes});
  listenViews('pointermove',event=>{if(!enabled)return;pointer={x:event.clientX,y:event.clientY};if(drag){card.style.left=Math.max(8,Math.min(innerWidth-card.offsetWidth-8,event.clientX-drag.x))+'px';card.style.top=Math.max(74,Math.min(innerHeight-card.offsetHeight-8,event.clientY-drag.y))+'px';card.style.right='auto';card.style.bottom='auto';return;}const node=event.composedPath().find(item=>item?.nodeType===1);if(own(node)&&!node?.classList?.contains('shield'))return;hover=node?.classList?.contains('shield')?underPointer(event.clientX,event.clientY):node;if(own(hover))hover=null;schedule();},{capture:true});
  for(const type of ['pointerdown','pointerup','pointercancel','mousedown','mouseup','click','dblclick','contextmenu','auxclick','touchstart','touchend','touchcancel','focus','focusin','focusout','blur'])listenViews(type,event=>{
    if(!pickGesture&&(!enabled||interacting||ctrl||event.ctrlKey))return;
    const node=event.composedPath().find(item=>item?.nodeType===1);
    if(!pickGesture&&(!node||(own(node)&&!node.classList?.contains('shield'))))return;
    event.preventDefault();event.stopImmediatePropagation();
    if(type==='pointerdown'||type==='touchstart'){
      const point=event.changedTouches?.[0]??event;
      const picked=node.classList?.contains('shield')?underPointer(point.clientX,point.clientY):node;
      if(oneShot){pickGesture=true;pendingPick=picked;}else select(picked);
    }
    if(['click','auxclick','contextmenu','touchend'].includes(type)&&pickGesture){const picked=pendingPick;if(oneShot)select(picked);pickGesture=false;pendingPick=null;}
    if(type==='pointercancel'||type==='touchcancel'){pickGesture=false;pendingPick=null;}
  },{capture:true,passive:false});
  listenViews('scroll',()=>{needsScan=true;schedule();},{capture:true,passive:true});listenViews('load',()=>{needsScan=true;schedule();},{capture:true});listenViews('resize',()=>{card.style.left='';card.style.top='';card.style.right='';card.style.bottom='';needsScan=true;schedule();},{passive:true});
  listenViews('keydown',event=>{
    if(event.altKey&&event.shiftKey&&event.code==='KeyX'){event.preventDefault();event.stopImmediatePropagation();toggle();return;}
    if(!enabled)return;if(event.key==='Control'){ctrl=true;mode();schedule();return;}
    const node=event.composedPath().find(item=>item?.nodeType===1);if(event.key==='Tab'&&!interacting&&!ctrl){event.preventDefault();event.stopImmediatePropagation();const controls=[...root.querySelectorAll('button:not(:disabled),select')].filter(item=>item.getClientRects().length);const index=controls.indexOf(root.activeElement),direction=event.shiftKey?-1:1;controls[(index+direction+controls.length)%controls.length]?.focus({preventScroll:true});return;}
    if(own(node)&&node?.matches('input,select,textarea'))return;
    if((interacting||ctrl)&&!own(node))return;
    if(event.key==='Escape'){event.preventDefault();event.stopImmediatePropagation();if(selected){selected=null;renderCard();schedule();}else toggle(false);return;}
    if(interacting||ctrl)return;
    // Do not let keyboard activation submit a focused portal form while inspecting.
    if(['ArrowUp','ArrowDown','[',']'].includes(event.key)||!own(node)&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();if(event.key==='ArrowUp'&&selected){const ancestor=parent(selected);if(ancestor)descent.set(ancestor,selected);select(ancestor);}if(event.key==='ArrowDown'&&selected)select(child(selected));if(event.key==='['||event.key===']'){const stack=hitStack(pointer.x,pointer.y),index=stack.indexOf(selected??hover),next=index<0?0:(index+(event.key===']'?1:-1)+stack.length)%stack.length;select(stack[next]);}}
  },{capture:true});
  listenViews('keyup',event=>{if(event.key==='Control'){ctrl=false;mode();schedule();}if(enabled&&!interacting&&!own(event.composedPath().find(item=>item?.nodeType===1))&&['Enter',' '].includes(event.key)){event.preventDefault();event.stopImmediatePropagation();}},{capture:true});
  listen(document,'visibilitychange',()=>{ctrl=false;mode();schedule();});
  listen(root,'wheel',event=>{
    if(!event.target.classList?.contains('shield')||interacting||ctrl||event.ctrlKey)return;
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
        const rootScroller=current===current.ownerDocument.scrollingElement;
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
  listenViews('blur',()=>{ctrl=false;drag=null;mode();schedule();});
  listen(root,'pointerdown',event=>{const header=event.target.closest('.cardhead');if(!header||event.target.closest('button'))return;const r=card.getBoundingClientRect();drag={x:event.clientX-r.left,y:event.clientY-r.top};header.setPointerCapture(event.pointerId);event.preventDefault();});
  listenViews('pointerup',()=>{drag=null;},{capture:true});
  listen(root,'change',event=>{if(event.target.matches('select')){layer=event.target.value;schedule();}});
  listen(root,'click',async event=>{const button=event.target.closest('[data-action]');if(!button)return;const action=button.dataset.action;
    if(action==='refresh'&&!button.disabled){setStatus('Refreshing local source inspection…');dispatch('refresh');}if(action==='exit')toggle(false);if(action==='mode'){interacting=!interacting;mode();schedule();}if(action==='details'){details=!details;button.setAttribute('aria-pressed',String(details));renderCard();}
    if(action==='source-region'){let region;try{region=lineage(selected).find(node=>node.matches(button.dataset.selector));}catch{}if(region)select(region);else setStatus('This source region is no longer present. Select a rendered element again.');}if(action==='clear'){selected=null;renderCard();schedule();}if(action==='parent'){const ancestor=parent(selected);if(ancestor)descent.set(ancestor,selected);select(ancestor);}if(action==='child')select(child(selected));if(action==='ancestor')select(lineage(selected)[Number(button.dataset.index)]);
    if(action==='frame-open'&&selected?.localName==='iframe'){try{const url=new URL(selected.getAttribute('src')??'',selected.ownerDocument.baseURI);if(!selected.getAttribute('src')||!['http:','https:'].includes(url.protocol))throw new Error();window.open(url.href,'_blank','noopener');}catch{setStatus('This embedded document has no standalone HTTP address.');}}
    if(action==='reveal'){selected?.scrollIntoView({block:'center',inline:'nearest'});schedule();}if(action==='dock'){const r=card.getBoundingClientRect();card.style.left=r.left>innerWidth/2?'20px':'auto';card.style.right=r.left>innerWidth/2?'auto':'20px';}
    if(action==='copy'){try{await navigator.clipboard.writeText(button.dataset.copy);setStatus('Source path copied.');}catch{setStatus('The browser could not copy the source path.');}}
    if(action==='open')dispatch('open',{ref:button.dataset.ref,line:Number(button.dataset.line)||undefined,find:button.dataset.find||undefined});
  });
  // Follow active animations; idle documents never poll geometry.
  let animationFrame=0;
  const resizeObserver=new ResizeObserver(schedule);
  const animate=()=>{cancelAnimationFrame(animationFrame);if(!enabled||disposed||document.hidden)return;if([document,...frameViews.keys()].some(doc=>doc.getAnimations().some(animation=>animation.playState==='running'&&!own(animation.effect?.target)))){schedule();animationFrame=requestAnimationFrame(animate);}};
  listenViews('animationstart',animate,{capture:true});listenViews('transitionrun',animate,{capture:true});
  listen(document,'visibilitychange',()=>{if(document.hidden){cancelAnimationFrame(frame);frame=0;cancelAnimationFrame(animationFrame);}else{schedule();animate();}});
  host.__px={toggle,select,identify,pickOnce(){oneShot=true;toggle(true);},selection(){return selectionIdentity(selected);},get token(){return d.token;},get enabled(){return enabled;},update(next,nextReport){const previousError=d.inspectionError;d=next;const theme=document.getElementById('paqvilo-panel')?.shadowRoot?.querySelector('.wrap');if(theme){const style=getComputedStyle(theme);for(const key of ['--bg','--fg','--muted','--primary','--link','--on-primary','--radius','--line','--head-bg','--panel-line','--shadow','--font']){const value=style.getPropertyValue(key);if(value)ui.style.setProperty(key,value);}}const currentReport=next.inspectionError||(next.inspection??next.mirage)?.active===false?null:nextReport;if(currentReport!==undefined&&currentReport!==report){report=currentReport;needsScan=true;if(!report)candidates=[];renderCard();if(selected)notifySelection(true);schedule();}else if(previousError!==d.inspectionError)renderCard();if(enabled)renderProgress();if(next.ui?.hidden&&enabled)toggle(false);},status:setStatus,dispose(){disposed=true;releaseShadowHook?.();releaseAnimationHook?.();resizeObserver.disconnect();cancelAnimationFrame(animationFrame);cancelAnimationFrame(frame);observer.disconnect();releaseFrames();lifetime.abort();host.remove();}};
}
