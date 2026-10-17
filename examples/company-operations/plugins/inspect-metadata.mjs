import{connectionPath}from'./registration.mjs';
import{loadConnection,connectedClient}from'../../../lense/dataverse/index.mjs';
const connection=await loadConnection(connectionPath());const c=connectedClient(connection);await c.verify(connection.organisationId);
const r=await c.get("EntityDefinitions(LogicalName='solutioncomponent')/Attributes(LogicalName='componenttype')/Microsoft.Dynamics.CRM.PicklistAttributeMetadata?$expand=OptionSet");console.log(JSON.stringify(r.OptionSet.Options.filter(o=>o.Value>=370).map(o=>({value:o.Value,label:o.Label.UserLocalizedLabel?.Label})),null,2));
const privileges=await c.get("EntityDefinitions(LogicalName='pqvd_chainnode')?$select=Privileges");console.log(JSON.stringify(privileges));
