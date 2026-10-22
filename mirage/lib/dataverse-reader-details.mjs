import {DataError} from './data-error.mjs';
import {isExactNumeric} from './exact-numeric.mjs';

// Facts attached only by the Dataverse HTTP decoder; SDK/portal faults retain their own formatting.
const READER=Symbol('DataverseHttpPrimitiveReader');
const PREFIX="Error identified in Payload provided by the user for Entity :";
const LINK=", For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : Microsoft.OData.ODataException: ";
export function attachDataverseReaderDetails(error,value,property,context){
 if(!context||value===null||typeof value!=='object'||isExactNumeric(value))return error;
 const details=Array.isArray(value)?{node:'StartArray'}:{node:'StartObject',property};
 Object.defineProperty(error,READER,{value:{...details,entitySet:context.method==='POST'?context.entitySet:''}});return error;
}
export function dataverseReaderMessage(error){
 const d=error?.[READER];if(!d)return null;
 const where=d.property?` for property named '${d.property}'`:'';
 return PREFIX+`'${d.entitySet??''}'`+LINK+`An unexpected '${d.node}' node was found${where} when reading from the JSON reader. A 'PrimitiveValue' node was expected.`;
}
export function assertDataverseRootBody(body,context){
 if(!context?.hasJsonBody||!context.recordPayload)return;
 if(body===null||Array.isArray(body)&&body.length===0)throw new DataError(PREFIX+"''"+LINK+"An unexpected 'EndOfInput' node was found when reading from the JSON reader. A 'StartObject' node was expected.",400,'InvalidRequest',{innerCode:'0x80048d19'});
}
