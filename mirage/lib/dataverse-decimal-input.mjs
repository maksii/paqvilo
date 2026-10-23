import {decimalText,exactNumeric} from './exact-numeric.mjs';
// Dataverse's JSON string primitive conversion uses invariant Decimal.Parse
// (NumberStyles.Number); parse with integer arithmetic before column rounding.
// https://learn.microsoft.com/dotnet/api/system.decimal.parse
const MAX=79228162514264337593543950335n;
function roundedDigits(digits,drop){
 if(drop<=0)return BigInt(digits||'0');
 if(drop>digits.length)return 0n;
 const cut=digits.length-drop,kept=BigInt(digits.slice(0,cut)||'0'),tail=digits.slice(cut);
 const first=tail.charCodeAt(0)-48,round=first>5||first===5&&(/[1-9]/.test(tail.slice(1))||kept%2n===1n);
 return kept+(round?1n:0n);
}
export function parseDataverseDecimalString(value){
 if(typeof value!=='string')return null;
 let start=0,end=value.length,sign=1n,signed=false;
 const white=at=>value.charCodeAt(at)===32||value.charCodeAt(at)>=9&&value.charCodeAt(at)<=13;
 while(end>start&&value.charCodeAt(end-1)===0)end--;
 while(start<end&&white(start))start++;
 while(end>start&&white(end-1))end--;
 if(value[start]==='+'||value[start]==='-'){signed=true;if(value[start]==='-')sign=-1n;start++;}
 if(value[end-1]==='+'||value[end-1]==='-'){if(signed)return null;if(value[end-1]==='-')sign=-1n;end--;while(end>start&&white(end-1))end--;}
 const text=value.slice(start,end);if(!/^(?:\d[\d,]*(?:\.\d*)?|\.\d+)$/.test(text))return null;
 const parts=text.replaceAll(',','').split('.'),fraction=parts[1]??'',scale=fraction.length;
 const digits=(parts[0]+fraction).replace(/^0+/,'')||'0';
 let drop=Math.max(0,scale-28,digits.length-29);if(drop>scale)return null;
 let coefficient=roundedDigits(digits,drop);
 while(coefficient>MAX&&drop<scale)coefficient=roundedDigits(digits,++drop);
 if(coefficient>MAX)return null;
 return exactNumeric(decimalText({coefficient:sign*coefficient,scale:scale-drop}),'Literal',{collapse:false});
}
