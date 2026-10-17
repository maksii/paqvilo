import { parseFragment } from 'parse5';

const cssId = value => '#' + [...value].map((char, index) => /[a-zA-Z_]/.test(char) || char === '-' && (index > 0 || value.length > 1) || /[0-9]/.test(char) && index > 0 && !(index === 1 && value[0] === '-') ? char : `\\${char.codePointAt(0).toString(16)} `).join('');

// Preserve original offsets/lines. Raw emits its body, while comments/manifests do not.
// An attribute intersecting any Liquid range is rejected below, rather than joining tokens.
function markupForInspection(text) {
  const tags=/{%-?\s*(raw|endraw|comment|endcomment|manifest|endmanifest)\b[^%]*%-?}/gi;
  const ranges=[];let kind=null,start=0,depth=0;
  for(const match of text.matchAll(tags)){
    const tag=match[1].toLowerCase(),end=match.index+match[0].length;
    if(kind==='raw') { if(tag==='endraw'){ranges.push([match.index,end]);kind=null;} continue; }
    if(kind){if(tag===kind&&kind==='comment')depth++;else if(tag==='end'+kind&&!--depth){ranges.push([start,end]);kind=null;}continue;}
    if(tag==='raw'){ranges.push([match.index,end]);kind='raw';}
    else if(tag==='comment'||tag==='manifest'){kind=tag;start=match.index;depth=1;}
  }
  if(kind&&kind!=='raw')ranges.push([start,text.length]);
  let from=0,masked='';
  for(const [begin,end] of ranges){masked+=text.slice(from,begin)+text.slice(begin,end).replace(/[^\r\n]/g,' ');from=end;}
  return {text:masked+text.slice(from),ranges};
}

/** Static selectors provide candidates, never proof of which Liquid branch rendered a node. */
export function elementSourceHints(body, source, { limit = Infinity } = {}) {
  if (!body || String(body).length > 1024 * 1024) return [];
  const original=String(body),prepared=markupForInspection(original);
  const tree = parseFragment(prepared.text, { sourceCodeLocationInfo: true });
  const nodes = [], ids = new Map(), selectors = new Map();
  const pending = [tree];
  const staticValue=value=>value&&value.length<=160&&!/[{}%]/.test(value);
  while (pending.length) {
    const node = pending.pop();
    if (['script', 'style', 'template'].includes(node.tagName)) continue;
    const attrs=Object.fromEntries((node.attrs??[]).filter(attr=>{const location=node.sourceCodeLocation?.attrs?.[attr.name];return !location||!prepared.ranges.some(([start,end])=>start<location.endOffset&&end>location.startOffset);}).map(attr=>[attr.name,attr.value]));
    const id=attrs.id;
    if(staticValue(id)&&!/[\s]/.test(id))ids.set(id,(ids.get(id)??0)+1);
    nodes.push({node,attrs,id});
    const children=node.childNodes??[];
    for(let index=children.length-1;index>=0;index--)pending.push(children[index]);
  }
  for(const {node,attrs,id} of nodes){
    if(!node.tagName||!/^[a-z][a-z0-9:_-]*$/.test(node.tagName))continue;
    const opening=node.sourceCodeLocation?.startTag;
    if(opening&&prepared.ranges.some(([start,end])=>start<opening.endOffset&&end>opening.startOffset))continue;
    let selector,matchKind;
    if(staticValue(id)&&!/[\s]/.test(id)){
      selector=cssId(id);matchKind='id';
    }else{
      // Intrinsic class/metadata selectors survive moved nodes. Positional/nth-child paths
      // would wrongly identify neighbours after scripts restructure a page.
      const classes=(attrs.class??'').replace(/\{\{[\s\S]*?\}\}|\{%[\s\S]*?%\}/g,'{dynamic}').split(/\s+/).filter(staticValue).slice(0,4);
      const explicit=['for','data-entityname','data-formid','data-viewid','data-listid','data-fieldname','data-field','data-attribute'].find(name=>staticValue(attrs[name]));
      if(explicit&&/^[a-zA-Z0-9_{}-]+$/.test(attrs[explicit])){selector=`${node.tagName}[${explicit}="${attrs[explicit]}"]`;matchKind='attribute';}
      else if(classes.length){selector=node.tagName+classes.map(value=>'.'+cssId(value).slice(1)).join('');matchKind='class';}
      else continue;
    }
    const contexts=[];
    for(let ancestor=node.parentNode;ancestor;ancestor=ancestor.parentNode){const aid=ancestor.attrs?.find(attr=>attr.name==='id')?.value;if(staticValue(aid)&&ids.get(aid)===1)contexts.push(cssId(aid));}
    const location={line:/\.html?$/i.test(source.sourceFile??'')?node.sourceCodeLocation?.startLine:undefined,contexts,tag:node.tagName};
    const existing=selectors.get(selector);
    if(existing){existing.occurrences++;existing.locations.push(location);existing.lines=existing.locations.map(item=>item.line).filter(Boolean);continue;}
    selectors.set(selector,{
      ...source,selector,matchKind,tag:node.tagName,attributes:Object.fromEntries(['for','data-entityname','data-formid','data-viewid','data-listid','data-fieldname','data-field','data-attribute'].filter(name=>staticValue(attrs[name])).map(name=>[name,attrs[name]])),classes:(attrs.class??'').split(/\s+/).filter(staticValue),occurrences:1,locations:[location],lines:location.line?[location.line]:[],
      // Enhanced-model HTML is nested in XML/JSON; its line is not a file line.
      line: /\.html?$/i.test(source.sourceFile??'')?node.sourceCodeLocation?.startLine:undefined,
      evidence:'source-selector',certainty:'candidate',
    });
  }
  return [...selectors.values()].sort((a,b)=>(a.matchKind==='id'?0:1)-(b.matchKind==='id'?0:1)).slice(0,limit);
}

/** Literal selector references identify script candidates, never event-handler ownership. */
export function scriptSourceHints(body, source, { limit = 120 } = {}) {
  if (typeof body!=='string'||!body||body.length>1024*1024) return [];
  const rows=[],seen=new Set();let index=0,previous='';
  const trivia=from=>{let at=from;while(at<body.length){if(/\s/.test(body[at])){at++;continue;}if(body.startsWith('//',at)||body.startsWith('<!--',at)||body.startsWith('-->',at)){const end=body.indexOf('\n',at+2);at=end<0?body.length:end+1;continue;}if(body.startsWith('/*',at)){const end=body.indexOf('*/',at+2);at=end<0?body.length:end+2;continue;}break;}return at;};
  while(index<body.length&&rows.length<Math.max(0,Math.min(1000,limit))){
    index=trivia(index);const char=body[index];if(!char)break;
    // Templates and ambiguous division/regex syntax are deliberately a scan boundary.
    // Stopping is safer than attributing code printed inside either to an element.
    if(char==='`')break;
    if(char==='"'||char==="'"){const string=quotedString(body,index);if(!string)break;index=string.end;previous='string';continue;}
    if(char==='/'){
      if(!['','=','(',',',':',';','[','{','!','?','return','case','=>'].includes(previous))break;
      let at=index+1,inClass=false,closed=false;
      for(;at<body.length;at++){if(body[at]==='\\'){at++;continue;}if(/[\r\n]/.test(body[at]))break;if(body[at]==='[')inClass=true;if(body[at]===']')inClass=false;if(body[at]==='/'&&!inClass){closed=true;at++;while(/[a-z]/i.test(body[at]??'')&&at<body.length)at++;break;}}
      if(!closed)break;index=at;previous='regex';continue;
    }
    if(/[A-Za-z_$]/.test(char)){
      const start=index;while(/[\w$]/.test(body[index]??'')&&index<body.length)index++;
      const name=body.slice(start,index);
      if(previous==='.'&&['getElementById','querySelector','querySelectorAll'].includes(name)||previous!=='.'&&['$','jQuery'].includes(name)){
        let at=trivia(index);if(body[at]==='('){at=trivia(at+1);const string=quotedString(body,at);if(string){const end=trivia(string.end);if(body[end]===')'){
          const value=string.value;
          const selector=name==='getElementById'?(!/[\s?=&/{}%\x00-\x1f\x7f]/.test(value)&&value.length<=160&&value?cssId(value):null):safeScriptSelector(value);
          if(selector&&!seen.has(selector)){seen.add(selector);rows.push({...source,selector,line:/\.[cm]?js$/i.test(source.sourceFile??'')?body.slice(0,start).split('\n').length:undefined,evidence:'script-selector',certainty:'candidate'});}
          index=end+1;previous=')';continue;
        }}}
      }
      previous=name;continue;
    }
    previous=char;index++;
  }
  return rows;
}

function quotedString(text,start){
  const quote=text[start];if(quote!=='"'&&quote!=="'")return null;
  let value='';
  for(let at=start+1;at<text.length;at++){
    let char=text[at];
    if(char===quote){if([...value].some(item=>{const code=item.codePointAt(0);return code>=0xd800&&code<=0xdfff;}))return null;return {value,end:at+1};}
    if(/[\r\n]/.test(char))return null;
    if(char==='\\'){
      char=text[++at];if(char===undefined)return null;
      if(char==='\r'||char==='\n'){if(char==='\r'&&text[at+1]==='\n')at++;continue;}
      if(/[1-9]/.test(char)||char==='0'&&/\d/.test(text[at+1]??''))return null;
      const simple={n:'\n',r:'\r',t:'\t',b:'\b',f:'\f',v:'\v','0':'\0'};
      if(Object.hasOwn(simple,char))char=simple[char];
      else if(char==='x'||char==='u'){
        if(char==='u'&&text[at+1]==='{'){const close=text.indexOf('}',at+2),hex=text.slice(at+2,close);if(close<0||!/^[0-9a-f]{1,6}$/i.test(hex)||parseInt(hex,16)>0x10ffff)return null;char=String.fromCodePoint(parseInt(hex,16));at=close;}
        else{const count=char==='x'?2:4,hex=text.slice(at+1,at+1+count);if(!new RegExp(`^[0-9a-f]{${count}}$`,'i').test(hex))return null;char=String.fromCharCode(parseInt(hex,16));at+=count;}
      }
    }
    value+=char;if(value.length>160)return null;
  }
  return null;
}

function safeScriptSelector(value){
  if(!value||value.length>160||/[\x00-\x1f\x7f{}%]/.test(value))return null;
  // Only declared schema/component identifiers may appear as attribute values. Arbitrary
  // DOM values, hrefs and nested functional selectors must never become saved evidence.
  const rest=value.replace(/\[(data-(?:fieldname|field|attribute|entityname|formid|viewid|listid))(?:\s*=\s*(?:"[a-z0-9_-]+"|'[a-z0-9_-]+'|[a-z0-9_-]+))?\s*\]/gi,'');
  return /[#.[]/.test(value)&&/^[\w#.\s>+~,*:\\-]*$/.test(rest)?value:null;
}
