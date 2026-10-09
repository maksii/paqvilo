const json = (value) => JSON.stringify(value).replace(/</g, "\\u003c");

/** Load captured managed runtime resources and let the native PCF proxy bind controls. */
export function clientManagedControlsRuntime(definitions) {
  return `(async()=>{
    const definitions=${json(definitions)},state=window.__portalSimulation ||= {};
    if(document.readyState==='loading')await new Promise(resolve=>document.addEventListener('DOMContentLoaded',resolve,{once:true}));
    await new Promise(resolve=>setTimeout(resolve,0));
    const resources=state.managedControlResources ||= {};
    const load=(path,style)=>resources[path] ||= new Promise((resolve,reject)=>{
      const selector=style?'link[rel=stylesheet]':'script[src]';const existing=[...document.querySelectorAll(selector)].find(element=>(style?element.getAttribute('href'):element.getAttribute('src'))===path);
      if(existing){resolve();return;}
      const element=document.createElement(style?'link':'script');if(style){element.rel='stylesheet';element.href=path;}else element.src=path;
      element.onload=resolve;element.onerror=()=>reject(new Error('Managed control resource unavailable: '+path));document.head.append(element);
    });
    try{
      for(const definition of Object.values(definitions)){
        if(definition.fabricConfig)window.FabricConfig={...window.FabricConfig,...definition.fabricConfig};
        for(const path of definition.stylesheets||[])await load(path,true);
        for(const path of definition.scripts||[])await load(path,false);
      }
      if(typeof window.loadAllPcfControlsOnPage!=='function')throw new Error('The managed Power Pages PCF proxy is unavailable.');
      if(typeof ClientLogWrapper!=='undefined')ClientLogWrapper.getLogger();
      const controls=[...document.querySelectorAll('[data-sim-managed-control]')];
      if(controls.some(control=>!document.getElementById(control.dataset.controlView)?.children.length)&&!state.managedPcfInitialized){state.managedPcfInitialized=true;window.loadAllPcfControlsOnPage();}
      for(const control of controls){
        if(control.dataset.mounted==='native')continue;
        const value=document.getElementById(control.dataset.field);value.addEventListener('change',()=>{value.setAttribute('value',value.value);});
        control.dataset.mounted='native';control.dispatchEvent(new CustomEvent('sim:richtext-ready',{bubbles:true,detail:{field:value.id}}));
      }
    }catch(error){for(const control of document.querySelectorAll('[data-sim-managed-control]')){control.dataset.mounted='failed';const message=document.createElement('p');message.setAttribute('role','alert');message.textContent=error.message;control.append(message);}console.error(error);}
  })();`;
}

/** Validate a static observed manifest; current record properties live elsewhere. */
export function validateManagedControlDefinition(definition, name) {
  if (
    !definition ||
    definition.manifest?.Name !== name ||
    !Array.isArray(definition.manifest.Resources) ||
    !Array.isArray(definition.manifest.Properties)
  )
    throw new Error(`Managed control ${name} requires its static manifest.`);
  for (const path of [
    ...(definition.scripts ?? []),
    ...(definition.stylesheets ?? []),
  ])
    if (
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /[\r\n]/.test(path)
    )
      throw new Error(
        `Managed control ${name} resource must be a local absolute path.`,
      );
  for (const [key, path] of Object.entries(definition.fabricConfig ?? {}))
    if (
      !["fontBaseUrl", "iconBaseUrl"].includes(key) ||
      typeof path !== "string" ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("\\") ||
      /[\r\n]/.test(path)
    )
      throw new Error(
        `Managed control ${name} Fabric setting must name a local font/icon base URL.`,
      );
  return definition;
}
