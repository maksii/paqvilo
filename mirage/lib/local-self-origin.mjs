/** Native portals omit default ports; local exported scripts may do the same. */
export function clientLocalSelfOriginRuntime() {
  return `
    const localSelfUrl=value=>{
      if(typeof value!=='string'||typeof location==='undefined'||!location.port||!['127.0.0.1','localhost','[::1]'].includes(location.hostname))return value;
      const authority=/^(?:https?:)?\\/\\/([^/?#]+)/i.exec(value)?.[1];
      // Exact authority equality excludes credentials and explicitly named ports.
      if(!authority||authority.toLowerCase()!==location.hostname.toLowerCase())return value;
      try{const url=new URL(value,location.href);if(url.protocol!==location.protocol||url.hostname!==location.hostname||url.port)return value;url.port=location.port;return url.href;}catch{return value;}
    };
    if(typeof location!=='undefined'&&location.port&&['127.0.0.1','localhost','[::1]'].includes(location.hostname)){
    const rewriteInput=input=>{
      if(typeof input==='string')return localSelfUrl(input);
      if(typeof Request!=='undefined'&&input instanceof Request){const url=localSelfUrl(input.url);return url===input.url?input:new Request(url,input);}
      if(typeof URL!=='undefined'&&input instanceof URL)return localSelfUrl(input.href);
      return input;
    };
    if(typeof window.fetch==='function'){const fetch=window.fetch;window.fetch=function(input,options){return fetch.call(this,rewriteInput(input),options);};}
    const localXhr=window.XMLHttpRequest?.prototype;if(localXhr){const open=localXhr.open;localXhr.open=function(method,url,...args){return open.call(this,method,localSelfUrl(url),...args);};}
    if(typeof window.open==='function'){const open=window.open;window.open=function(url,...args){return open.call(this,localSelfUrl(url),...args);};}
    for(const [type,property]of [['HTMLIFrameElement','src'],['HTMLScriptElement','src'],['HTMLImageElement','src'],['HTMLLinkElement','href'],['HTMLAnchorElement','href'],['HTMLFormElement','action']]){
      const prototype=window[type]?.prototype,descriptor=prototype&&Object.getOwnPropertyDescriptor(prototype,property);
      if(descriptor?.set&&descriptor.configurable)Object.defineProperty(prototype,property,{...descriptor,set(value){descriptor.set.call(this,localSelfUrl(value));}});
    }
    const elementPrototype=window.Element?.prototype;
    if(elementPrototype){const set=elementPrototype.setAttribute;elementPrototype.setAttribute=function(name,value){const attribute=String(name).toLowerCase(),tag=this.tagName;const selfAttribute=attribute==='src'&&['IFRAME','SCRIPT','IMG'].includes(tag)||attribute==='href'&&['A','LINK'].includes(tag)||attribute==='action'&&tag==='FORM';return set.call(this,name,selfAttribute?localSelfUrl(value):value);};}
    document.addEventListener('click',event=>{const anchor=event.target.closest?.('a[href]');if(anchor){const href=anchor.getAttribute('href'),normalized=localSelfUrl(href);if(normalized!==href)anchor.setAttribute('href',normalized);}},true);
    }
  `;
}
