// Optional enhancement. The GET search and every choice also work without JS.
const root=document.querySelector('[data-persona-chooser]');
if(root){
  const form=root.querySelector('.chooser-search'),choice=root.querySelector('#idp-choose');
  const key=`paqvilo:idp-personas:${root.dataset.scope}`,read=()=>{try{const value=JSON.parse(localStorage.getItem(key)??'{}');return {pin:Array.isArray(value.pin)?value.pin.filter(v=>typeof v==='string').slice(0,100):[],recent:Array.isArray(value.recent)?value.recent.filter(v=>typeof v==='string').slice(0,5):[]};}catch{return {pin:[],recent:[]};}};
  const save=value=>{try{localStorage.setItem(key,JSON.stringify(value));}catch{/* optional preference */}};
  let preferences=read(),controller,timer;
  let dialog;
  const presentation=modal=>{
    if(modal&&!dialog){dialog=document.createElement('dialog');dialog.className='chooser-dialog-shell';root.before(dialog);dialog.append(root);dialog.addEventListener('cancel',event=>{event.preventDefault();presentation(false);});dialog.showModal();}
    if(!modal&&dialog){dialog.close();dialog.before(root);dialog.remove();dialog=null;}
    root.dataset.presentation=modal?'dialog':'page';root.setAttribute('role',modal?'dialog':'main');root.querySelector('[data-chooser-display]').textContent=modal?'Use full page':'Open as dialog';
  };
  const decorate=()=>{for(const button of root.querySelectorAll('[data-chooser-pin]')){button.hidden=false;const pinned=preferences.pin.includes(button.dataset.chooserPin);button.setAttribute('aria-pressed',String(pinned));button.textContent=pinned?'★':'☆';}};
  const refresh=async(address)=>{
    const count=[...new FormData(form)].filter(([name,value])=>['role','tag','group','subgroup','account','hasRoles'].includes(name)&&value).length;
    form.querySelector('.chooser-filter-disclosure>summary').textContent='Filters'+(count?` · ${count} active`:'');
    controller?.abort();const active=controller=new AbortController();
    const visible=new URL(address,location.href);for(const name of ['view','pin','recent'])visible.searchParams.delete(name);
    const request=new URL(visible);request.searchParams.set('view','picker');for(const name of ['pin','recent'])for(const value of preferences[name])request.searchParams.append(name,value);
    root.setAttribute('aria-busy','true');
    try{
      const response=await fetch(request,{signal:active.signal});if(!response.ok)throw new Error('The persona list could not be refreshed. Use Search to retry.');
      const parsed=new DOMParser().parseFromString(await response.text(),'text/html'),results=parsed.querySelector('.chooser-results');
      if(!results)throw new Error('The sign-in request has changed. Reload this page to continue.');
      if(controller!==active)return;root.querySelector('.chooser-results').replaceWith(document.importNode(results,true));history.replaceState(null,'',visible);decorate();root.querySelector('[data-chooser-error]').textContent='';
    }catch(error){if(error.name!=='AbortError')root.querySelector('[data-chooser-error]').textContent=error.message;}
    finally{if(controller===active)root.removeAttribute('aria-busy');}
  };
  const search=()=>{const address=new URL(form.action);address.search=new URLSearchParams(new FormData(form)).toString();void refresh(address);};
  form.addEventListener('submit',event=>{event.preventDefault();clearTimeout(timer);search();});
  form.addEventListener('input',event=>{if(event.target.name==='q'){clearTimeout(timer);timer=setTimeout(search,120);}});
  form.addEventListener('change',event=>{if(event.target.name!=='q'){clearTimeout(timer);search();}});
  root.addEventListener('click',event=>{
    const pin=event.target.closest('[data-chooser-pin]');if(pin){const value=pin.dataset.chooserPin;preferences.pin=preferences.pin.includes(value)?preferences.pin.filter(v=>v!==value):[value,...preferences.pin].slice(0,100);save(preferences);void refresh(location.href);return;}
    const link=event.target.closest('[data-chooser-more],[data-chooser-clear]');if(link){event.preventDefault();if(link.hasAttribute('data-chooser-clear')){form.reset();form.querySelector('[name=q]').value='';for(const option of form.querySelectorAll('select option'))option.selected=false;}void refresh(link.href);}
    const display=event.target.closest('[data-chooser-display]');if(display){presentation(root.dataset.presentation!=='dialog');root.querySelector('input[type=search]').focus();}
  });
  choice.addEventListener('submit',event=>{const card=event.submitter?.closest('[data-chooser-key]');if(card){preferences.recent=[card.dataset.chooserKey,...preferences.recent.filter(value=>value!==card.dataset.chooserKey)].slice(0,5);save(preferences);}});
  window.addEventListener('popstate',()=>location.reload());presentation(root.dataset.presentation==='dialog');decorate();if(preferences.pin.length||preferences.recent.length)void refresh(location.href);
}
