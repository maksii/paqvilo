(function () {
  'use strict';
  const app = document.querySelector('[data-demo-workspace]');
  if (!app) return;
  const approach = app.dataset.demoWorkspace;
  const canWrite = app.dataset.demoCanWrite === 'true';
  function applyAccess(){if(canWrite)return;app.querySelectorAll('[data-delete-account],[data-delete-contact],[data-delete-note],[data-edit-note],[data-delete-record],[data-toggle-state],[data-edit-account],[data-create-contact],[data-save-account],a[href*="mode=create"],a[href*="mode=edit"],[data-contact][data-mode=edit],[data-note-form]').forEach(node=>node.hidden=true);}
  const base = '/approach/' + approach + '/';
  const find = selector => app.querySelector(selector);
  const status = find('[data-status]');
  const initialForm = find('[data-account-form]');
  if(initialForm){initialForm.dataset.ready='false';initialForm.setAttribute('aria-busy','true');initialForm.querySelectorAll('input,textarea,select,button').forEach(input=>input.disabled=true);}
  let account = null;
  let pendingDelete = null;
  let nextPage = null;
  let pageHistory = [];
  let currentPage = null;
  const accountFields = ['name','accountnumber','emailaddress1','telephone1','websiteurl','tickersymbol','description','numberofemployees','creditlimit','pqvd_decimal','pqvd_float','industrycode','donotemail','pqvd_dateonly','pqvd_datetime','address1_line1','address1_city','address1_postalcode'];
  const accountSelect = ['accountid',...accountFields,'statecode','statuscode','createdon','modifiedon','_parentaccountid_value','_primarycontactid_value','_transactioncurrencyid_value'].join(',');
  const contactSelect = 'contactid,firstname,lastname,fullname,emailaddress1,telephone1,jobtitle,description,_parentcustomerid_value';
  const numeric = new Set(['numberofemployees','creditlimit','pqvd_decimal','pqvd_float','industrycode']);
  const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
  const guid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
  function message(text, error = false) { const dialog=app.querySelector('dialog[open]');if(error&&dialog){let inline=dialog.querySelector('[data-dialog-status]');if(!inline){inline=document.createElement('p');inline.dataset.dialogStatus='true';inline.className='demo-status error';inline.setAttribute('role','alert');dialog.querySelector('.demo-panel').prepend(inline);}inline.textContent=text;}status.textContent = text; status.hidden = !text; status.classList.toggle('error', error); }
  async function token() {
    if (!window.shell?.getTokenDeferred) throw new Error('Your portal session is unavailable. Reload this page and sign in again.');
    return new Promise((resolve,reject) => window.shell.getTokenDeferred().done(resolve).fail(reject));
  }
  async function api(resource, options = {}) {
    if(options.method&&options.method!=='GET'&&!canWrite)throw new Error('This demo account has read-only access. Sign in as a Workspace Editor to change records.');
    const url = new URL(resource.startsWith('/') || /^https?:\/\//i.test(resource) ? resource : '/_api/' + resource, window.location.origin);
    if (url.origin !== window.location.origin || !url.pathname.startsWith('/_api/')) throw new Error('The request must stay within this portal.');
    const response = await fetch(url, {method: options.method || 'GET',cache:'no-store',credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json','__RequestVerificationToken':await token(),'Prefer':'odata.include-annotations="OData.Community.Display.V1.FormattedValue"'+(options.pageSize?',odata.maxpagesize='+options.pageSize:'')},body:options.body === undefined ? undefined : JSON.stringify(options.body)});
    let result = null;
    if (response.status !== 204) { const text = await response.text(); if(text){try{result=JSON.parse(text);}catch{result={error:{message:text.slice(0,300)}};}} }
    if (!response.ok) throw new Error(result?.error?.message || 'The portal returned HTTP ' + response.status + '.');
    const id = response.headers.get('entityid') || response.headers.get('OData-EntityId')?.match(/\(([0-9a-f-]+)\)/i)?.[1];
    return {result,id};
  }
  function field(name) { const host = find('[data-field="'+name+'"]'); return host?.querySelector('[data-lookup-value]') || host?.querySelector('input:not([type=hidden]),textarea,select') || find('[name="'+name+'"]'); }
  function setField(name,value) {
    const input = field(name); if(!input)return;
    if(input.type==='checkbox')input.checked=Boolean(value);
    else if(input.type==='date')input.value=value?String(value).slice(0,10):'';
    else if(input.type==='datetime-local')input.value=value?new Date(new Date(value).getTime()-new Date(value).getTimezoneOffset()*60000).toISOString().slice(0,16):'';
    else input.value=value ?? '';
    input.dispatchEvent(new Event('input',{bubbles:true}));input.dispatchEvent(new Event('change',{bubbles:true}));
  }
  function busy(button, action) { const old=button?.textContent; if(button){button.disabled=true;button.textContent='Working…';} return action().catch(error=>message(error.message,true)).finally(()=>{if(button){button.disabled=button.matches('[data-next]')?!nextPage:button.matches('[data-previous]')?!pageHistory.length:button.matches('[data-contact-next]')?!contactNext:button.matches('[data-contact-previous]')?!contactHistory.length:false;if(button.textContent==='Working…')button.textContent=old;}}); }
  function showDialog(dialog) { dialog.querySelector('[data-dialog-status]')?.remove();if(!dialog.open)dialog.showModal(); }
  function readValues() {
    const body={};
    for(const name of accountFields){const input=field(name);if(!input)throw new Error('The '+name+' control has not loaded.');const text=input.value.trim();
      if(input.type==='checkbox')body[name]=input.checked;
      else if(numeric.has(name))body[name]=text===''?null:Number(text);
      else if(input.type==='datetime-local')body[name]=text?new Date(text).toISOString():null;
      else if(input.type==='date')body[name]=text?text+'T00:00:00Z':null;
      else body[name]=text||null;
    }
    if(!body.name)throw new Error('Enter an account name.');
    for(const [name,set] of [['parentaccountid','accounts'],['primarycontactid','contacts'],['transactioncurrencyid','transactioncurrencies']]){
      const value=field(name)?.value;
      if(value)body[name+'@odata.bind']='/'+set+'('+value+')';
      else if(account?.['_'+name+'_value'])body[name+'@odata.bind']=null;
    }
    return body;
  }
  const lookupDefinitions = {
    parentaccountid:{set:'accounts',key:'accountid',label:'name',title:'Parent account'},
    primarycontactid:{set:'contacts',key:'contactid',label:'fullname',title:'Primary contact'},
    transactioncurrencyid:{set:'transactioncurrencies',key:'transactioncurrencyid',label:'currencyname',title:'Currency'}
  };
  function lookupField(name) {
    const input=field(name),definition=lookupDefinitions[name];if(!input||input.dataset.lookupValue)return input;
    input.dataset.lookupValue='true';input.hidden=true;
    const surface=document.createElement('div');surface.className='demo-lookup';
    const display=document.createElement('input');display.type='text';display.readOnly=true;display.className='demo-lookup-display';display.setAttribute('aria-label',definition.title+' selection');display.placeholder='No selection';
    const choose=document.createElement('button');choose.type='button';choose.className='demo-button secondary';choose.textContent='Choose';choose.setAttribute('aria-label','Choose '+definition.title.toLowerCase());
    const clear=document.createElement('button');clear.type='button';clear.className='demo-button secondary';clear.textContent='Clear';clear.setAttribute('aria-label','Clear '+definition.title.toLowerCase());
    surface.append(display,choose,clear);input.after(surface);
    const sync=()=>{display.value=input.selectedOptions[0]?.value?input.selectedOptions[0].textContent:'';clear.hidden=!input.value;display.disabled=input.disabled;choose.disabled=input.disabled;clear.disabled=input.disabled;};
    input.addEventListener('change',sync);new MutationObserver(sync).observe(input,{attributes:true,attributeFilter:['disabled']});
    clear.addEventListener('click',()=>{input.value='';input.dispatchEvent(new Event('change',{bubbles:true}));});
    choose.addEventListener('click',()=>openLookup(name));sync();return input;
  }
  let lookupDialog, lookupState;
  function ensureLookupDialog(){
    if(lookupDialog)return lookupDialog;
    lookupDialog=document.createElement('dialog');lookupDialog.className='demo-modal demo-lookup-modal';lookupDialog.setAttribute('aria-labelledby','demo-lookup-title');
    lookupDialog.innerHTML='<div class="demo-panel"><div class="demo-modal-header"><h2 id="demo-lookup-title"></h2><button class="demo-modal-close" type="button" data-close-dialog aria-label="Close lookup dialog">×</button></div><form class="demo-query" data-lookup-query><label>Search<input type="search" name="lookup-search" placeholder="Search by name"></label><button type="submit" class="demo-button secondary">Search</button></form><p class="demo-footnote" data-lookup-status role="status" aria-live="polite"></p><div class="demo-table-wrap"><table aria-label="Lookup results"><thead><tr><th>Name</th><th>Selection</th></tr></thead><tbody data-lookup-results></tbody></table></div><div class="demo-modal-footer"><button type="button" class="demo-button secondary" data-lookup-previous disabled>Previous</button><button type="button" class="demo-button secondary" data-lookup-next disabled>Next</button><button type="button" class="demo-button secondary" data-close-dialog>Cancel</button></div></div>';
    app.appendChild(lookupDialog);
    lookupDialog.querySelector('[data-lookup-query]').addEventListener('submit',event=>{event.preventDefault();lookupState.history=[];lookupPage();});
    lookupDialog.querySelector('[data-lookup-next]').addEventListener('click',()=>{lookupState.history.push(lookupState.current);lookupPage(lookupState.next);});
    lookupDialog.querySelector('[data-lookup-previous]').addEventListener('click',()=>lookupPage(lookupState.history.pop()));
    lookupDialog.querySelector('[data-lookup-results]').addEventListener('click',event=>{const button=event.target.closest('[data-lookup-select]');if(!button)return;const input=field(lookupState.name);input.replaceChildren(new Option('None',''),new Option(button.dataset.label,button.dataset.lookupSelect));input.value=button.dataset.lookupSelect;input.dispatchEvent(new Event('change',{bubbles:true}));lookupDialog.close();});
    return lookupDialog;
  }
  async function openLookup(name){
    const dialog=ensureLookupDialog();lookupState={name,history:[],next:null,current:null,generation:0};dialog.querySelector('h2').textContent='Choose '+lookupDefinitions[name].title.toLowerCase();dialog.querySelector('[name=lookup-search]').value='';showDialog(dialog);dialog.querySelector('[name=lookup-search]').focus();await lookupPage();
  }
  async function lookupPage(url){
    const state=lookupState,definition=lookupDefinitions[state.name],generation=++state.generation;
    const text=lookupDialog.querySelector('[data-lookup-status]'),rows=lookupDialog.querySelector('[data-lookup-results]'),previous=lookupDialog.querySelector('[data-lookup-previous]'),next=lookupDialog.querySelector('[data-lookup-next]');
    text.textContent='Loading results';rows.replaceChildren();previous.disabled=next.disabled=true;lookupDialog.setAttribute('aria-busy','true');
    if(!url){const search=lookupDialog.querySelector('[name=lookup-search]').value.trim(),filters=[];if(search)filters.push("contains("+definition.label+",'"+search.replace(/'/g,"''")+"')");if(state.name==='parentaccountid'&&account)filters.push('accountid ne '+account.accountid);if(state.name==='transactioncurrencyid')filters.push('statecode eq 0');url=definition.set+'?$select='+definition.key+','+definition.label+'&$orderby='+definition.label+(filters.length?'&$filter='+encodeURIComponent(filters.join(' and ')):'');}
    try{const {result}=await api(url,{pageSize:6});if(lookupState!==state||state.generation!==generation)return;state.current=url;state.next=result['@odata.nextLink']||null;rows.innerHTML=result.value.map(row=>'<tr><td>'+escape(row[definition.label]||'Unnamed record')+'</td><td><button type="button" class="demo-link-button" data-lookup-select="'+escape(row[definition.key])+'" data-label="'+escape(row[definition.label]||'Unnamed record')+'">Select</button></td></tr>').join('');text.textContent=result.value.length?result.value.length+' results on this page':'No matching records. Change the search and try again.';previous.disabled=!state.history.length;next.disabled=!state.next;}
    catch(error){if(lookupState===state&&state.generation===generation)text.textContent=error.message;}
    finally{if(lookupState===state&&state.generation===generation)lookupDialog.setAttribute('aria-busy','false');}
  }
  async function loadLookups() {
    for(const [name,definition] of Object.entries(lookupDefinitions)){
      const input=lookupField(name);if(!input)continue;input.replaceChildren(new Option('None',''));
      let selected=account?.['_'+name+'_value'];
      if(!selected&&name==='transactioncurrencyid'){const {result}=await api(definition.set+'?$select='+definition.key+','+definition.label+'&$filter='+encodeURIComponent("statecode eq 0 and isocurrencycode eq 'EUR'")+'&$top=1');const row=result.value[0];if(row){input.add(new Option(row[definition.label],row[definition.key]));selected=row[definition.key];}}
      else if(selected){const {result}=await api(definition.set+'('+selected+')?$select='+definition.key+','+definition.label);input.add(new Option(result[definition.label],selected));}
      input.value=selected||'';input.dispatchEvent(new Event('change',{bubbles:true}));
    }
  }
  let accountRequest=0;
  async function listAccounts(url) {
    const request=++accountRequest;message('Loading accounts…');
    if(!url){const view=find('[name=view]').value;const search=find('[name=search]').value.trim();const filters=[];if(view!=='all')filters.push('statecode eq '+(view==='inactive'?1:0));if(search)filters.push("contains(name,'"+search.replace(/'/g,"''")+"')");url='accounts?$select=accountid,name,accountnumber,emailaddress1,telephone1,address1_city,statecode&$orderby=name'+(filters.length?'&$filter='+encodeURIComponent(filters.join(' and ')):'');pageHistory=[];}
    const {result}=await api(url,{pageSize:8});if(request!==accountRequest)return;currentPage=url;nextPage=result['@odata.nextLink']||null;
    find('[data-account-rows]').innerHTML=result.value.map(row=>'<tr><td><a href="'+base+'account/?id='+row.accountid+'">'+escape(row.name)+'</a><br><small>'+escape(row.accountnumber||'No account number')+'</small></td><td>'+escape(row.telephone1||'')+'</td><td>'+escape(row.address1_city||'')+'</td><td><span class="demo-state '+(row.statecode?'inactive':'')+'">'+(row.statecode?'Inactive':'Active')+'</span></td><td><a href="'+base+'account/?id='+row.accountid+'&amp;mode=edit">Edit</a> <button type="button" class="demo-link-button danger" data-delete-account="'+row.accountid+'" data-name="'+escape(row.name)+'">Delete</button></td></tr>').join('');
    find('[data-account-empty]').hidden=result.value.length>0;
    find('[data-account-count]').textContent=result.value.length+' accounts on this page';find('[data-next]').disabled=!nextPage;find('[data-previous]').disabled=!pageHistory.length;message('');applyAccess();
  }
  let contactNext=null,contactHistory=[],contactCurrent=null,contactRequest=0;
  function contactToolbar(){
    const table=find('[data-contact-rows]')?.closest('.demo-table-wrap');if(!table||find('[data-contact-query]'))return;
    const toolbar=document.createElement('div');toolbar.className='demo-toolbar';toolbar.innerHTML='<form class="demo-query" data-contact-query><label>Search contacts<input type="search" name="contact-search" placeholder="Contact name"></label><button type="submit" class="demo-button secondary">Search</button></form><div class="demo-actions"><button type="button" class="demo-button secondary" data-contact-previous disabled>Previous</button><button type="button" class="demo-button secondary" data-contact-next disabled>Next</button></div>';
    table.before(toolbar);find('[data-contact-query]').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,()=>contacts());});find('[data-contact-next]').addEventListener('click',event=>{contactHistory.push(contactCurrent);busy(event.currentTarget,()=>contacts(contactNext));});find('[data-contact-previous]').addEventListener('click',event=>busy(event.currentTarget,()=>contacts(contactHistory.pop())));
  }
  async function contacts(url) {
    if(!account)return;const request=++contactRequest;contactToolbar();
    if(!url){contactHistory=[];const search=find('[name=contact-search]').value.trim(),filters=['_parentcustomerid_value eq '+account.accountid];if(search)filters.push("contains(fullname,'"+search.replace(/'/g,"''")+"')");url='contacts?$select='+contactSelect+'&$filter='+encodeURIComponent(filters.join(' and '))+'&$orderby=fullname';}
    const {result}=await api(url,{pageSize:8});if(request!==contactRequest)return;contactCurrent=url;contactNext=result['@odata.nextLink']||null;
    find('[data-contact-rows]').innerHTML=result.value.map(row=>'<tr><td>'+escape(row.fullname)+'</td><td>'+escape(row.emailaddress1||'')+'</td><td>'+escape(row.jobtitle||'')+'</td><td><button type="button" class="demo-link-button" data-contact="'+row.contactid+'" data-mode="read">View</button> <button type="button" class="demo-link-button" data-contact="'+row.contactid+'" data-mode="edit">Edit</button> <button type="button" class="demo-link-button danger" data-delete-contact="'+row.contactid+'" data-name="'+escape(row.fullname)+'">Delete</button></td></tr>').join('');
    find('[data-contact-empty]').hidden=result.value.length>0;find('[data-contact-empty]').textContent=find('[name=contact-search]').value.trim()?'No matching contacts. Change the search to see more records.':'No contacts yet. Create the first related contact.';find('[data-contact-next]').disabled=!contactNext;find('[data-contact-previous]').disabled=!contactHistory.length;applyAccess();
  }
  async function notes() {
    if(!account)return;
    const {result}=await api('annotations?$select=annotationid,subject,notetext,filename,isdocument,createdon&$filter='+encodeURIComponent('_objectid_value eq '+account.accountid)+'&$orderby=createdon desc&$top=20');
    find('[data-note-list]').innerHTML=result.value.map(note=>'<article class="demo-note"><strong>'+escape(note.subject||'Note')+'</strong><p>'+escape(String(note.notetext||'').replace(/^\*WEB\*/,''))+'</p>'+(note.isdocument?'<button type="button" class="demo-link-button" data-download-note="'+note.annotationid+'">Download '+escape(note.filename)+'</button>':'')+' <button type="button" class="demo-link-button" data-edit-note="'+note.annotationid+'">Edit</button> <button type="button" class="demo-link-button danger" data-delete-note="'+note.annotationid+'" data-name="'+escape(note.subject||'Note')+'">Delete</button></article>').join('')||'<p class="demo-footnote">No notes yet. Add a note or attach a small file below.</p>';applyAccess();
  }
  async function openAccount() {
    const params=new URLSearchParams(window.location.search);const id=params.get('id');const mode=params.get('mode')||(id?'read':'create');
    if(id&&!guid(id))throw new Error('This account link is invalid.');
    if(id)account=(await api('accounts('+id+')?$select='+accountSelect)).result;
    await loadLookups();
    if(account){for(const name of accountFields)setField(name,account[name]);for(const name of ['parentaccountid','primarycontactid','transactioncurrencyid'])setField(name,account['_'+name+'_value']);}
    find('[data-record-name]').textContent=account?.name||'New account';
    const editable=canWrite&&mode!=='read';find('[data-account-form]').querySelectorAll('input,textarea,select').forEach(input=>input.disabled=!editable);
    find('[data-save-account]').hidden=!editable;find('[data-edit-account]').hidden=!account||editable;find('[data-edit-account]').href=base+'account/?id='+id+'&mode=edit';
    find('[data-toggle-state]').hidden=!account;find('[data-toggle-state]').textContent=account?.statecode?'Activate account':'Deactivate account';
    find('[data-delete-record]').hidden=!account;find('[data-related]').hidden=!account;
    find('[data-record-meta]').textContent=account?'Created '+new Date(account.createdon).toLocaleString()+' · Updated '+new Date(account.modifiedon).toLocaleString()+' · '+(account.statecode?'Inactive':'Active'):'Complete the form to create this account. Required fields are marked.';
    if(account){await contacts();await notes();}find('[data-save-account]').disabled=!editable;initialForm.dataset.ready='true';initialForm.setAttribute('aria-busy','false');message('');applyAccess();
  }
  async function waitForControls() {
    if(approach!=='pcf')return;
    for(let attempt=0;attempt<100;attempt++){if(accountFields.every(name=>field(name)))break;await new Promise(resolve=>setTimeout(resolve,100));}
    for(const name of accountFields){const input=field(name);if(!input)throw new Error('The PCF control for '+name+' did not load.');input.name=name;input.id='pcf-'+name;const label=find('[data-field="'+name+'"]>label');if(label)label.htmlFor=input.id;}
    const industry=field('industrycode');if(industry?.tagName==='INPUT'){industry.setAttribute('aria-label','Industry');industry.setAttribute('list','demo-industries');}
  }
  find('[data-account-query]')?.addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,()=>listAccounts());});
  find('[data-next]')?.addEventListener('click',event=>{pageHistory.push(currentPage);busy(event.currentTarget,()=>listAccounts(nextPage));});
  find('[data-previous]')?.addEventListener('click',event=>busy(event.currentTarget,()=>listAccounts(pageHistory.pop())));
  function saveAccount(button){return busy(button,async()=>{const body=readValues();const saved=await api('accounts'+(account?'('+account.accountid+')':''),{method:account?'PATCH':'POST',body});const id=account?.accountid||saved.id||saved.result?.accountid;if(!guid(id))throw new Error('The account was saved, but the portal did not return its identifier.');window.location.assign(base+'account/?id='+id);});}
  find('[data-account-form]')?.addEventListener('submit',event=>{event.preventDefault();saveAccount(event.submitter||find('[data-save-account]'));});
  if(initialForm?.tagName==='DIV'){find('[data-save-account]').addEventListener('click',event=>saveAccount(event.currentTarget));initialForm.addEventListener('keydown',event=>{if(event.key==='Enter'&&event.target.tagName==='INPUT'){event.preventDefault();find('[data-save-account]').click();}});}
  find('[data-toggle-state]')?.addEventListener('click',event=>busy(event.currentTarget,async()=>{const statecode=account.statecode?0:1;await api('accounts('+account.accountid+')',{method:'PATCH',body:{statecode,statuscode:statecode?2:1}});account.statecode=statecode;find('[data-toggle-state]').textContent=statecode?'Activate account':'Deactivate account';find('[data-record-meta]').textContent=find('[data-record-meta]').textContent.replace(/ · (Active|Inactive)$/,' · '+(statecode?'Inactive':'Active'));message('Account status updated.');}));
  app.addEventListener('click',event=>{
    const button=event.target.closest('button');if(!button)return;
    if(button.matches('[data-close-dialog]'))button.closest('dialog').close();
    const accountId=button.dataset.deleteAccount||(button.matches('[data-delete-record]')?account?.accountid:null);const contactId=button.dataset.deleteContact;const noteId=button.dataset.deleteNote;
    if(accountId||contactId||noteId){pendingDelete={set:accountId?'accounts':contactId?'contacts':'annotations',id:accountId||contactId||noteId};find('[data-delete-name]').textContent=button.dataset.name||account?.name||'this record';showDialog(find('[data-delete-dialog]'));}
    if(button.dataset.contact||button.matches('[data-create-contact]'))busy(button,async()=>{const id=button.dataset.contact;const read=button.dataset.mode==='read';const form=find('[data-contact-form]');form.reset();form.dataset.id=id||'';const contact=id?(await api('contacts('+id+')?$select='+contactSelect)).result:null;for(const input of form.querySelectorAll('[name]')){input.value=contact?.[input.name]||'';input.disabled=read;}find('[data-contact-title]').textContent=id?(read?'Contact details':'Edit contact'):'New contact';find('[data-save-contact]').hidden=read;showDialog(find('[data-contact-dialog]'));});
    if(button.dataset.editNote)busy(button,async()=>{
      const {result}=await api('annotations('+button.dataset.editNote+')?$select=subject,notetext');
      let dialog=find('[data-note-edit-dialog]');if(!dialog){dialog=document.createElement('dialog');dialog.className='demo-modal';dialog.dataset.noteEditDialog='true';dialog.setAttribute('aria-labelledby','demo-note-edit-title');dialog.innerHTML='<div class="demo-panel"><div class="demo-modal-header"><h2 id="demo-note-edit-title">Edit note</h2><button type="button" class="demo-modal-close" data-close-dialog aria-label="Close note dialog">×</button></div><form data-note-edit-form><label>Subject<input name="subject" required></label><label>Note<textarea name="notetext"></textarea></label><p class="demo-footnote">The existing attachment is preserved.</p><div class="demo-modal-footer"><button type="button" class="demo-button secondary" data-close-dialog>Cancel</button><button type="submit" class="demo-button">Save note</button></div></form></div>';app.appendChild(dialog);dialog.querySelector('form').addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{const form=event.currentTarget;await api('annotations('+form.dataset.id+')',{method:'PATCH',body:{subject:form.elements.subject.value.trim(),notetext:'*WEB*'+form.elements.notetext.value.trim()}});dialog.close();await notes();message('Note saved.');});});}
      const form=dialog.querySelector('form');form.dataset.id=button.dataset.editNote;form.elements.subject.value=result.subject||'';form.elements.notetext.value=String(result.notetext||'').replace(/^\*WEB\*/,'');showDialog(dialog);
    });
    if(button.dataset.downloadNote)busy(button,async()=>{const {result}=await api('annotations('+button.dataset.downloadNote+')?$select=filename,mimetype,documentbody');const bytes=Uint8Array.from(atob(result.documentbody),char=>char.charCodeAt(0));const url=URL.createObjectURL(new Blob([bytes],{type:result.mimetype||'application/octet-stream'}));const link=document.createElement('a');link.href=url;link.download=result.filename;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);});
  });
  find('[data-confirm-delete]')?.addEventListener('click',event=>busy(event.currentTarget,async()=>{if(!pendingDelete)return;const deleted=pendingDelete;await api(deleted.set+'('+deleted.id+')',{method:'DELETE'});find('[data-delete-dialog]').close();pendingDelete=null;if(deleted.set==='accounts'){if(account)window.location.assign(base);else await listAccounts();}else if(deleted.set==='contacts')await contacts();else await notes();message('Record deleted.');}));
  find('[data-contact-form]')?.addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{const form=event.currentTarget;const body={};for(const input of form.querySelectorAll('[name]'))body[input.name]=input.value.trim()||null;body['parentcustomerid_account@odata.bind']='/accounts('+account.accountid+')';await api('contacts'+(form.dataset.id?'('+form.dataset.id+')':''),{method:form.dataset.id?'PATCH':'POST',body});find('[data-contact-dialog]').close();await contacts();message('Contact saved.');});});
  find('[data-note-form]')?.addEventListener('submit',event=>{event.preventDefault();busy(event.submitter,async()=>{const form=event.currentTarget;const body={subject:form.elements.subject.value.trim()||'Account note',notetext:"*WEB*"+form.elements.notetext.value.trim(),'objectid_account@odata.bind':'/accounts('+account.accountid+')'};const file=form.elements.attachment.files[0];if(file){if(file.size>1024*1024)throw new Error('Choose a file smaller than 1 MB for this demo.');const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(const byte of bytes)binary+=String.fromCharCode(byte);Object.assign(body,{isdocument:true,filename:file.name,mimetype:file.type||'application/octet-stream',documentbody:btoa(binary)});}await api('annotations',{method:'POST',body});form.reset();await notes();message('Note saved.');});});
  (async()=>{try{if(find('[data-account-form]')){message('Loading account and controls…');await waitForControls();await openAccount();}else await listAccounts();}catch(error){message(error.message,true);}})();
})();
