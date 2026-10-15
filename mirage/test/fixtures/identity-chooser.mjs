export function identityChooserFixture(count=500){
  const users=Array.from({length:count},(_,i)=>({contactId:`contact-${i}`,subject:`subject-${i}`,name:i===49?'Ørsted Unique':`Contact ${i}`,roles:[i%2?'Reviewer':'Writer']}));
  const report={enabled:true,scope:'synthetic',groups:Array.from({length:20},(_,i)=>({id:`group-${i}`,label:`Group ${i}`,subgroups:[{id:'team',label:'Team'}]})),personas:users.map((u,i)=>({...u,key:`person-${i}`,label:i===49?'Ørsted Unique':`Persona ${i}`,group:`group-${i%20}`,subgroup:'team',tags:[i%3?'regular':'special'],description:`Synthetic identity ${i}\nLonger details`,default:i===0})),other:[],contexts:[]};
  const provider={slug:'synthetic',key:'Synthetic',clientId:'local-client',redirectUri:'http://127.0.0.1:9/callback'};
  const params={client_id:provider.clientId,redirect_uri:provider.redirectUri,response_type:'code',response_mode:'query',scope:'openid profile',state:'synthetic-state',nonce:'synthetic-nonce'};
  return {users,report,provider,params};
}
