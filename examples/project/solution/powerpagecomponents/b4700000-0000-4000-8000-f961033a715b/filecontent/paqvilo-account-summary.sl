function get(){
  const response=JSON.parse(Server.Connector.Dataverse.RetrieveMultipleRecords('accounts','$select=accountid,name,statecode&$orderby=name&$top=50'));
  if(!response.IsSuccessStatusCode)return JSON.stringify({success:false,message:response.ReasonPhrase||'Dataverse did not return an account summary.'});
  const rows=JSON.parse(response.Body).value||[];
  return JSON.stringify({success:true,accountsRead:rows.length,active:rows.filter(row=>row.statecode===0).length,inactive:rows.filter(row=>row.statecode===1).length,firstFive:rows.slice(0,5).map(row=>({name:row.name,status:row.statecode?'Inactive':'Active'})),limit:50,source:'Dataverse through Power Pages server logic'});
}
