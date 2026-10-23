import { personaHtml as h, renderPersonaPicker } from './persona-picker-view.mjs';
import { mountPersonaPicker, rememberPersona } from './persona-picker.mjs';
import { personaFilters, personaRowKey } from './persona-search.mjs';

export function personaSessionPanel(report, session, selectedKey) {
  const selected = [...report.personas,...report.other].find(p=>personaRowKey(p)===selectedKey) ?? report.personas.find(p=>p.contactId===session?.contactId) ?? report.personas.find(p=>p.default) ?? report.personas[0] ?? report.other[0];
  return `<section id="persona-session-panel" class="panel"><h2>This browser's session</h2><p>${h(session?.signedIn ? session.name ?? session.contactId : 'Anonymous')} · ${h((session?.roles??[]).join(', ')||'No web roles')}</p><p class="muted">Choose a test person (persona) for this browser; web roles and account come from that contact's memberships. A persona with its own setup (a context) opens in an isolated local copy of this runtime with its own data and sign-in.</p><div class="toolbar persona-launchbar"><span data-persona-launch-summary>Selected: ${h(selected?.label??selected?.name??'None')}</span><button type="button" class="button primary" data-persona-launch="${h(personaRowKey(selected??{}))}"${selected?'':' disabled'}>${selected?.context?'Open '+h(report.contexts.find(c=>c.id===selected.context)?.label??selected.context):'Sign in as '+h(selected?.label??selected?.name??'persona')}</button>${session?.signedIn?'<button class="button" data-action="session-sign-out">Sign out</button>':''}</div>${renderPersonaPicker(report,{id:'browser-persona-picker',enhanced:true,collapsed:true,selectedKey:selectedKey??personaRowKey(selected??{})})}<p data-persona-launch-result role="status"></p></section>`;
}

export function personaManagementPanel(report) {
  const owner = report.contextRuntime ? `<section class="panel section-gap"><h2>Isolated setup: ${h(report.contextRuntime.label)}</h2><p>Changes here belong to this copy. <a href="${h(report.contextRuntime.ownerOrigin)}/_sim/#identity">Return to the parent runtime to launch another setup or stop this copy.</a></p></section>` : '';
  return `${owner}<details id="persona-management-panel" class="panel section-gap" data-persona-management><summary>Persona catalogue &amp; local runtimes</summary><div data-persona-management-body></div></details><section id="persona-scenarios-panel" class="panel section-gap"><h2>Catalogue scenarios</h2><p class="muted">Each scenario signs in a persona and opens its start page in one step. A scenario that brings its own preset or setup (context) runs in an isolated copy of this runtime, so this workspace's data is not changed.</p>${report.scenarios.length ? report.groups.map(group=>{const items=report.scenarios.filter(s=>s.group===group.id);return items.length?`<details><summary>${h(group.label)} (${items.length})</summary><ul class="persona-list">${items.map(s=>`<li class="persona-card"><div><strong>${h(s.label)}</strong><p>${h(s.description??'')}</p><small>${h(s.persona)} · ${h(s.context??'Default setup')} · ${h(s.startPath??'/')}</small></div><button class="button" data-persona-scenario="${h(s.id)}">Launch scenario</button></li>`).join('')}</ul></details>`:'';}).join(''):'<p>No catalogue scenarios. Add one in catalogue management or a data pack.</p>'}</section>${report.diagnostics.length?`<section class="panel section-gap"><h2>Catalogue diagnostics</h2><ul>${report.diagnostics.map(d=>`<li><code>${h(d.code)}</code> ${h(d.key)} (${h(d.source)})</li>`).join('')}</ul></section>`:''}`;
}

function chooser(report, selectedContactId, choose) {
  const dialog=document.createElement('dialog');dialog.className='persona-dialog persona-picker-dialog';
  dialog.setAttribute('aria-label','Choose a contact persona');
  dialog.innerHTML=`<div class="persona-dialog-heading"><h2>Choose a contact persona</h2><button type="button" class="button" data-close>Close</button></div>${renderPersonaPicker(report,{id:'contact-persona-picker',enhanced:true,collapsed:true,selectedContactId})}`;
  document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  mountPersonaPicker(dialog.querySelector('[data-persona-picker]'),report,{onSelect:persona=>{choose(persona);dialog.close();}});dialog.showModal();
}

const emptyCatalog=()=>({version:1,groups:[],personas:[]});
const administrations = new WeakMap();
const fields={
  personas:[['key','Key','text',true],['contactId','Contact ID','contact',true],['label','Label'],['group','Group','group',true],['subgroup','Subgroup','subgroup'],['tags','Tags (space separated)'],['description','Description','textarea'],['order','Order','number'],['startPath','Start page'],['context','Context','context'],['extensions','Namespaced extensions (JSON)','json']],
  groups:[['id','ID','text',true],['label','Label','text',true],['order','Order','number'],['subgroups','Subgroups','subgroups']],
  contexts:[['id','ID','text',true],['label','Label','text',true],['description','Description','textarea'],['order','Order','number'],['profile','Deployment profile','profile'],['profilePages','Pages enabled','boolean'],['profileEnvironment','Environment variables enabled','boolean'],['profileConnections','Connection references enabled','boolean'],['environmentVariables','Environment variables','map'],['snippetOverrides','Content snippet overrides','map'],['settingOverrides','Site setting overrides','map'],['preset','Preset','preset'],['startPath','Start page'],['locale','Browser locale'],['timezoneId','Browser time zone'],['width','Viewport width','number'],['height','Viewport height','number'],['colorScheme','Color scheme','colorScheme'],['extensions','Namespaced extensions (JSON)','json']],
  scenarios:[['id','ID','text',true],['label','Label','text',true],['description','Description','textarea'],['order','Order','number'],['group','Group','group',true],['subgroup','Subgroup','subgroup'],['persona','Persona','persona',true],['context','Context','context'],['preset','Preset','preset'],['startPath','Start page']],
};
const rowId=(type,row)=>row[type==='personas'?'key':'id'];
function maps(value={}) {return Object.entries(value).map(([name,value])=>`<div class="persona-map-row"><input data-map-name aria-label="Name" placeholder="Name" value="${h(name)}"><textarea data-map-value aria-label="JSON value" rows="2">${h(JSON.stringify(value))}</textarea><button type="button" class="button" data-remove-row aria-label="Remove value">Remove</button></div>`).join('');}

export function mountPersonaAdministration(root, report, {request,refresh,notify,setButtonPending=(button,pending)=>{button.disabled=pending;},session,selectedKey,onSelected,onContact}={}) {
  administrations.get(root)?.abort();
  const controller = new AbortController(); administrations.set(root, controller);
  const picker=root.querySelector('#browser-persona-picker');
  if(picker) mountPersonaPicker(picker,report,{filters:personaFilters(location.hash.split('?')[1]??''),onSelect:(persona,key)=>{selectedKey=key;onSelected?.(key);root.querySelector('[data-persona-launch-summary]').textContent='Selected: '+persona.label;const button=root.querySelector('[data-persona-launch]');button.dataset.personaLaunch=key;button.textContent=persona.context?'Open '+(report.contexts.find(c=>c.id===persona.context)?.label??persona.context):'Sign in as '+persona.label;},onFilterChange:filters=>{
    const params=new URLSearchParams();if(filters.q)params.set('q',filters.q);
    for(const [field,name]of [['roles','role'],['accounts','account'],['groups','group'],['tags','tag']])for(const value of filters[field]??[])params.append(name,value);
    if(filters.hideNoRoles)params.set('rolesOnly','1');history.replaceState(null,'','#identity'+(params.size?'?'+params:''));
  }});
  const launch=async body=>{
    const result=await request('/personas/launch',{method:'POST',body:JSON.stringify(body)});
    rememberPersona(report,result.personaKey);
    // The server sets the selected runtime's cookie. Explicit navigation works
    // with popup blocking and keeps the administration tab available via Back.
    location.assign(result.url);
  };
  root.addEventListener('click',async event=>{
    const button=event.target.closest('button');if(!button)return;
    if(!button.dataset.personaLaunch&&!button.dataset.personaScenario&&!button.hasAttribute('data-persona-contact-chooser'))return;
    setButtonPending(button,true);
    try {
      if(button.dataset.personaLaunch){const key=button.dataset.personaLaunch;if(key.startsWith('@contact:')){await request('/session/sign-in',{method:'POST',body:JSON.stringify({contactId:key.slice(9)})});rememberPersona(report,key);location.assign('/');}else await launch({personaKey:key});}
      if(button.dataset.personaScenario)await launch({scenario:button.dataset.personaScenario});
      if(button.hasAttribute('data-persona-contact-chooser'))chooser(report,button.dataset.contactId,onContact);
    }catch(error){setButtonPending(button,false,true);notify(error.message,true);}finally{setButtonPending(button,false);}
  }, {signal:controller.signal});
  const panel=root.querySelector('[data-persona-management]');
  if(!panel)return;
  panel.addEventListener('toggle',()=>{if(panel.open&&!panel.dataset.loaded){panel.dataset.loaded='true';management(panel.querySelector('[data-persona-management-body]'));}});

  function management(container) {
    let type='personas',page=0,search='';
    container.innerHTML=`<p>Catalogue metadata describes contacts; it never grants roles. Pack entries stay pack-owned until customized. Save changes only to this local state.</p><div class="toolbar"><select data-kind aria-label="Catalogue section">${Object.keys(fields).map(type=>`<option value="${type}">${h(type[0].toUpperCase()+type.slice(1))}</option>`).join('')}</select><input type="search" data-management-search aria-label="Find catalogue entry" placeholder="Find an entry"><button class="button" data-add-entry>Add entry</button><button class="button" data-export>Export catalogue</button></div><div data-management-list></div><details><summary>Import / replace state catalogue</summary><p>Import version 1 JSON. Validation runs before saving; a stale edit is rejected.</p><textarea data-import rows="8" aria-label="Catalogue JSON"></textarea><button class="button" data-import-save>Validate and replace</button></details><details><summary>Reset state catalogue</summary><p>This removes local metadata overrides. Matching pack catalogues remain available. Contact records and role memberships stay unchanged.</p><button class="button danger" data-reset-catalog>Reset local catalogue</button></details><h3>Isolated local runtimes (${report.runtimes.items.length}/${report.runtimes.maxInstances})</h3><p>Each setup keeps its own data and cookies. Reusing a setup keeps its edits; stop it to discard that copy. All copies stop with this runtime.</p><ul>${report.runtimes.items.map(item=>`<li>${item.status==='stopping'?h(item.label):`<a href="${h(item.origin)}" target="_blank" rel="noopener">${h(item.label)}</a>`} · ${h(item.instanceKey)} · ${item.status==='stopping'?'Cleanup incomplete':'Running'} <button class="button" data-stop-runtime="${h(item.id)}">${item.status==='stopping'?'Retry stop and discard':'Stop and discard'}</button></li>`).join('')||'<li>No isolated runtimes running.</li>'}</ul>`;
    const save=async catalog=>{await request('/persona-catalog',{method:'PUT',body:JSON.stringify({catalog,expectedDigest:report.catalogDigest})});notify('Local catalogue saved.');await refresh();};
    const renderList=()=>{
      const rows=(report.catalog[type]??[]).filter(row=>JSON.stringify(row).toLowerCase().includes(search.toLowerCase()));
      const pages=Math.max(1,Math.ceil(rows.length/25));page=Math.min(page,pages-1);
      container.querySelector('[data-management-list]').innerHTML=`<p>${rows.length} entries · Page ${page+1} of ${pages}</p><ul class="persona-management-list">${rows.slice(page*25,page*25+25).map(row=>{const id=rowId(type,row),local=(report.stateCatalog?.[type]??[]).some(item=>rowId(type,item)===id);return `<li><span><strong>${h(row.label??id)}</strong> <code>${h(id)}</code><small>${local?'State override':'Pack metadata'}</small></span><button class="button" data-edit-entry="${h(id)}">${local?'Edit':'Customize'}</button>${local?`<button class="button" data-delete-entry="${h(id)}">Remove override</button>`:''}</li>`;}).join('')}</ul><div class="toolbar"><button class="button" data-prev${page?'':' disabled'}>Previous</button><button class="button" data-next${page+1<pages?'':' disabled'}>Next</button></div>`;
    };
    const withDependencies=(base,type,row)=>{
      const put=(kind,item)=>{base[kind]??=[];const id=rowId(kind,item),at=base[kind].findIndex(value=>rowId(kind,value)===id);if(at<0)base[kind].push(structuredClone(item));else base[kind][at]=structuredClone(item);};
      const ensure=(kind,id)=>{if(!id||(base[kind]??[]).some(item=>rowId(kind,item)===id))return;const item=(report.catalog[kind]??[]).find(item=>rowId(kind,item)===id);if(!item)return;put(kind,item);if(kind==='personas'){ensure('groups',item.group);ensure('contexts',item.context);}};
      put(type,row);if(type==='personas'||type==='scenarios'){ensure('groups',row.group);ensure('contexts',row.context);}if(type==='scenarios')ensure('personas',row.persona);return base;
    };
    container.addEventListener('change',event=>{if(event.target.hasAttribute('data-kind')){type=event.target.value;page=0;renderList();}});
    container.querySelector('[data-management-search]').oninput=event=>{search=event.target.value;page=0;renderList();};
    container.addEventListener('click',async event=>{
      const button=event.target.closest('button');if(!button)return;
      setButtonPending(button,true);
      try {
        if(button.hasAttribute('data-prev')){page--;renderList();}
        if(button.hasAttribute('data-next')){page++;renderList();}
        if(button.hasAttribute('data-add-entry'))edit(type,{},row=>save(withDependencies(structuredClone(report.stateCatalog??emptyCatalog()),type,row)));
        if(button.dataset.editEntry){const row=report.catalog[type].find(row=>rowId(type,row)===button.dataset.editEntry);edit(type,row,next=>save(withDependencies(structuredClone(report.stateCatalog??emptyCatalog()),type,next)));}
        if(button.dataset.deleteEntry){const base=structuredClone(report.stateCatalog);base[type]=base[type].filter(row=>rowId(type,row)!==button.dataset.deleteEntry);await save(base);}
        if(button.hasAttribute('data-export')){const blob=new Blob([JSON.stringify(report.catalog,null,2)+'\n'],{type:'application/json'}),url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='persona-catalog.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
        if(button.hasAttribute('data-import-save'))await save(JSON.parse(container.querySelector('[data-import]').value));
        if(button.hasAttribute('data-reset-catalog')){await request('/persona-catalog',{method:'DELETE',body:JSON.stringify({expectedDigest:report.catalogDigest})});await refresh();notify('State catalogue reset.');}
        if(button.dataset.stopRuntime){try{await request('/persona-runtimes/'+encodeURIComponent(button.dataset.stopRuntime),{method:'DELETE'});}finally{await refresh();}notify('Isolated runtime stopped and discarded.');}
      }catch(error){setButtonPending(button,false,true);notify(error.message,true);}finally{setButtonPending(button,false);}
    });renderList();
  }

  function edit(type, original, save) {
    const dialog=document.createElement('dialog');dialog.className='persona-dialog';
    dialog.setAttribute('aria-label',`Edit ${type}`);
    const values={...original,profile:original.deploymentProfile?.profile??(original.deploymentProfile?'__none':''),
      profilePages:original.deploymentProfile?.enabled?.pages,profileEnvironment:original.deploymentProfile?.enabled?.environmentVariables,profileConnections:original.deploymentProfile?.enabled?.connectionReferences,
      snippetOverrides:original.portalOverrides?.snippets,settingOverrides:original.portalOverrides?.settings,...original.browser,...original.browser?.viewport};
    const options=kind=>kind==='preset'?[['','Keep current data'],...(report.presets??[]).filter(p=>!p.unavailable).map(p=>[p.id,p.name??p.id])]:kind==='profile'?[['','Runtime default'],['__none','No profile'],...report.deploymentProfiles.map(id=>[id,id])]:kind==='boolean'?[['','Runtime default'],['true','Enabled'],['false','Disabled']]:kind==='colorScheme'?[['','Browser default'],...['light','dark','no-preference'].map(value=>[value,value])]:[['','None'],...(kind==='persona'?report.catalog.personas.map(p=>[p.key,p.label??p.key]):kind==='subgroup'?(report.catalog.groups.find(g=>g.id===values.group)?.subgroups??[]).map(s=>[s.id,s.label]):(report.catalog[kind==='group'?'groups':'contexts']??[]).map(row=>[row.id,row.label]))];
    const control=(name,label,kind='text',required=false)=>{
      const value=values[name];
      if(kind==='map')return `<fieldset data-map="${name}"><legend>${h(label)}</legend><p class="field-help">Values use JSON: quote strings, use true/false or numbers; null removes a setting or snippet.</p><div data-map-rows>${maps(value)}</div><button class="button" type="button" data-add-map>Add value</button></fieldset>`;
      if(kind==='subgroups')return `<fieldset><legend>Subgroups</legend><div data-subgroups>${(value??[]).map(s=>subgroup(s)).join('')}</div><button class="button" type="button" data-add-subgroup>Add subgroup</button></fieldset>`;
      if(['group','subgroup','context','persona','profile','colorScheme','boolean','preset'].includes(kind))return `<label>${h(label)}<select name="${name}"${required?' required':''}>${[...options(kind),...(value!==undefined&&value!==''&&!options(kind).some(([id])=>id===String(value))?[[String(value),'Unavailable: '+value]]:[])].map(([id,label])=>`<option value="${h(id)}"${String(value??'')===id?' selected':''}>${h(label)}</option>`).join('')}</select></label>`;
      if(kind==='textarea'||kind==='json')return `<label>${h(label)}<textarea name="${name}" rows="${kind==='json'?3:4}">${h(kind==='json'?value?JSON.stringify(value,null,2):'':value??'')}</textarea></label>`;
      return `<label>${h(label)}<input name="${name}" type="${kind==='number'?'number':'text'}"${kind==='contact'?' list="persona-contact-options"':''} value="${h(Array.isArray(value)?value.join(' '):value??'')}"${required?' required':''}${original[name]&&['key','id'].includes(name)?' readonly':''}></label>`;
    };
    const subgroup=s=>`<div class="persona-map-row"><input data-subgroup-id aria-label="Subgroup ID" placeholder="ID" value="${h(s.id??'')}"><input data-subgroup-label aria-label="Subgroup label" placeholder="Label" value="${h(s.label??'')}"><input type="number" data-subgroup-order aria-label="Subgroup order" placeholder="Order" value="${h(s.order??'')}"><button type="button" class="button" data-remove-row>Remove</button></div>`;
    dialog.innerHTML=`<form id="persona-metadata-editor"><div class="persona-dialog-heading"><h2>${rowId(type,original)?'Edit':'Add'} ${h(type)}</h2><button type="button" class="button" data-close>Cancel</button></div><p>Local metadata only. Identity and permissions are read from contacts. Context overrides apply to isolated local copies.</p><div class="persona-editor-fields">${fields[type].map(field=>control(...field)).join('')}</div><datalist id="persona-contact-options">${report.contacts.map(c=>`<option value="${h(c.contactId)}">${h(c.name)}</option>`).join('')}</datalist><p class="form-error" role="alert" data-editor-error></p><div class="dialog-actions"><button type="submit" class="button primary">Save local metadata</button></div></form>`;
    document.body.append(dialog);dialog.querySelector('[data-close]').onclick=()=>dialog.close();dialog.addEventListener('close',()=>dialog.remove(),{once:true});
    dialog.addEventListener('click',event=>{const button=event.target.closest('button');if(!button)return;if(button.hasAttribute('data-remove-row'))button.parentElement.remove();if(button.hasAttribute('data-add-map'))button.previousElementSibling.insertAdjacentHTML('beforeend',maps({'': ''}));if(button.hasAttribute('data-add-subgroup'))button.previousElementSibling.insertAdjacentHTML('beforeend',subgroup({}));});
    dialog.querySelector('form').addEventListener('change',event=>{
      if(event.target.name!=='group')return;
      const select=dialog.querySelector('[name="subgroup"]');if(!select)return;
      const previous=select.value,group=report.catalog.groups.find(g=>g.id===event.target.value);
      select.innerHTML='<option value="">None</option>'+(group?.subgroups??[]).map(s=>`<option value="${h(s.id)}"${s.id===previous?' selected':''}>${h(s.label)}</option>`).join('');
    });
    dialog.querySelector('form').onsubmit=async event=>{event.preventDefault();const form=event.target,data=new FormData(form),row={};
      const button=event.submitter??form.querySelector('button[type=submit]');setButtonPending(button,true);
      try{
        for(const [name,,kind]of fields[type]){const value=String(data.get(name)??'');if(kind==='map'){const map={};for(const node of form.querySelector(`[data-map="${name}"]`).querySelectorAll('.persona-map-row')){const key=node.querySelector('[data-map-name]').value.trim();if(!key)throw Error('Override names cannot be empty.');if(Object.hasOwn(map,key))throw Error('Duplicate override: '+key);Object.defineProperty(map,key,{value:JSON.parse(node.querySelector('[data-map-value]').value),enumerable:true,configurable:true,writable:true});}if(Object.keys(map).length)row[name]=map;}else if(kind==='subgroups'){row.subgroups=[...form.querySelectorAll('[data-subgroups] .persona-map-row')].map(node=>({id:node.querySelector('[data-subgroup-id]').value,label:node.querySelector('[data-subgroup-label]').value,...(node.querySelector('[data-subgroup-order]').value?{order:Number(node.querySelector('[data-subgroup-order]').value)}:{})}));}else if(value)row[name]=kind==='number'?Number(value):kind==='json'?JSON.parse(value):name==='tags'?value.trim().split(/\s+/):value;}
        if(type==='contexts'){
          if(row.profile){row.deploymentProfile={profile:row.profile==='__none'?null:row.profile};}
          const enabled={};for(const [field,key]of [['profilePages','pages'],['profileEnvironment','environmentVariables'],['profileConnections','connectionReferences']]){if(row[field])enabled[key]=row[field]==='true';delete row[field];}if(Object.keys(enabled).length){if(!row.deploymentProfile)throw Error('Choose a deployment profile before overriding its section switches.');row.deploymentProfile.enabled=enabled;}delete row.profile;
          if(row.snippetOverrides||row.settingOverrides)row.portalOverrides={...(row.snippetOverrides?{snippets:row.snippetOverrides}:{}),...(row.settingOverrides?{settings:row.settingOverrides}:{})};delete row.snippetOverrides;delete row.settingOverrides;
          const browser={};for(const name of ['locale','timezoneId','colorScheme']){if(row[name])browser[name]=row[name];delete row[name];}if(row.width||row.height)browser.viewport={width:row.width,height:row.height};delete row.width;delete row.height;if(Object.keys(browser).length)row.browser=browser;
        }
        await save(row);dialog.close();
      }catch(error){setButtonPending(button,false,true);form.querySelector('[data-editor-error]').textContent=error.message;}finally{setButtonPending(button,false);}
    };dialog.showModal();
  }
}
