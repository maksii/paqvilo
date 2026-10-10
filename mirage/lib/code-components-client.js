(function(){
  'use strict';
  if(window.__paqviloPcf)return;
  const constructors=new Map(),loaded=new Map(),instances=new Map();
  const framework=window.ComponentFramework=window.ComponentFramework||{};
  const prior=framework.registerControl;
  framework.registerControl=function(name,constructor){constructors.set(name,constructor);if(prior)prior.call(this,name,constructor);};
  function resource(item){
    if(loaded.has(item.url))return loaded.get(item.url);
    const promise=new Promise((resolve,reject)=>{const node=document.createElement(item.kind==='css'?'link':'script');if(item.kind==='css'){node.rel='stylesheet';node.href=item.url;}else node.src=item.url;node.onload=resolve;node.onerror=()=>reject(new Error('The declared PCF resource failed to load: '+item.url));document.head.appendChild(node);});
    loaded.set(item.url,promise);return promise;
  }
  function typed(value,type){if(value==null)return null;if(type==='TwoOptions')return value===true||value==='true';if(/^(Whole|Decimal|FP|Currency)/.test(type))return Number(value);if(/^DateAndTime/.test(type))return new Date(value);return value;}
  function token(){return new Promise((resolve,reject)=>window.shell.getTokenDeferred().done(resolve).fail(reject));}
  async function mount(spec){
    const container=document.getElementById(spec.id);if(!container||instances.has(container))return;
    let control;
    try{
      for(const item of spec.resources.filter(item=>item.kind==='code'||item.kind==='css'))await resource(item);
      const Constructor=constructors.get(spec.constructor)||spec.constructor.split('.').reduce((value,key)=>value?.[key],window);
      if(typeof Constructor!=='function')throw new Error('The PCF bundle did not register '+spec.constructor);
      const parameters={};
      for(const property of spec.properties){const raw=typed(spec.args[property.name]??spec.args[property.name.toLowerCase()]??null,property['of-type']);parameters[property.name]={raw,formatted:raw==null?'':String(raw),type:property['of-type'],attributes:{DisplayName:spec.strings[property['display-name-key']]||property['display-name-key']||property.name,LogicalName:property.name,RequiredLevel:property.required==='true'?1:0,Options:[]},error:false,errorMessage:''};}
      const entitySet=name=>{const mapping=spec.mappings[name.toLowerCase()];if(!mapping)throw new Error('PCF Web API table has no imported mapping: '+name);return mapping.entitySet;};
      async function api(name,suffix,method,body){const response=await fetch('/_api/'+entitySet(name)+suffix,{method,credentials:'same-origin',headers:{Accept:'application/json','Content-Type':'application/json',__RequestVerificationToken:await token()},body:body===undefined?undefined:JSON.stringify(body)});const text=await response.text();let result;try{result=text?JSON.parse(text):{};}catch{throw new Error('PCF Web API returned a non-JSON response');}if(!response.ok)throw new Error(result.error?.message||'PCF Web API HTTP '+response.status);return{result,id:response.headers.get('entityid')};}
      const context={parameters,updatedProperties:[],mode:{allocatedWidth:container.clientWidth,allocatedHeight:container.clientHeight,isControlDisabled:spec.args.disabled===true||spec.args.disabled==='true',isVisible:true,trackContainerResize(){},setControlState(state){sessionStorage.setItem('paqvilo-pcf:'+spec.id,JSON.stringify(state));}},userSettings:{userId:spec.identity.id,languageId:1033,isRTL:false,roles:spec.identity.roles},resources:{getString:key=>spec.strings[key]??key,getResource:(name,success,failure)=>{const item=spec.resources.find(item=>decodeURIComponent(item.url).endsWith('/'+name));if(!item)return failure?.();fetch(item.url).then(response=>response.arrayBuffer()).then(bytes=>success(btoa(String.fromCharCode(...new Uint8Array(bytes))))).catch(failure);}},formatting:{formatCurrency:value=>String(value),formatDecimal:value=>String(value),formatInteger:value=>String(value),formatDateShort:value=>value instanceof Date?value.toLocaleDateString():String(value)},webAPI:{retrieveMultipleRecords:async(name,options='')=>{const{result}=await api(name,options.startsWith('?')?options:'?'+options,'GET');return{entities:result.value??[],nextLink:result['@odata.nextLink']};},retrieveRecord:async(name,id,options='')=>(await api(name,'('+id+')'+options,'GET')).result,createRecord:async(name,data)=>({id:(await api(name,'','POST',data)).id,entityType:name}),updateRecord:async(name,id,data)=>{await api(name,'('+id+')','PATCH',data);return{id,entityType:name};},deleteRecord:async(name,id)=>{await api(name,'('+id+')','DELETE');return{id,entityType:name};}},navigation:{openAlertDialog:async options=>{window.alert(options.text);},openConfirmDialog:async options=>({confirmed:window.confirm(options.text)})}};
      control=new Constructor();instances.set(container,control);
      const changed=()=>{const outputs=control.getOutputs?.()||{};container.dispatchEvent(new CustomEvent('paqvilo:pcf-output',{bubbles:true,detail:outputs}));for(const[name,raw]of Object.entries(outputs))if(parameters[name]){parameters[name].raw=raw;parameters[name].formatted=raw==null?'':String(raw);}};
      let state={};try{state=JSON.parse(sessionStorage.getItem('paqvilo-pcf:'+spec.id)||'{}');}catch{}
      control.init(context,changed,state,container);control.updateView(context);container.setAttribute('aria-busy','false');container.dataset.pcfReady='true';
      const observer=new ResizeObserver(()=>{context.mode.allocatedWidth=container.clientWidth;context.mode.allocatedHeight=container.clientHeight;context.updatedProperties=['layout'];control.updateView(context);});observer.observe(container);
      const cleanup=()=>{observer.disconnect();control.destroy?.();instances.delete(container);};window.addEventListener('pagehide',cleanup,{once:true});
    }catch(error){control?.destroy?.();instances.delete(container);container.setAttribute('aria-busy','false');container.setAttribute('role','alert');container.textContent=error.message;container.dataset.pcfError='true';}
  }
  window.__paqviloPcf={mount};
})();
