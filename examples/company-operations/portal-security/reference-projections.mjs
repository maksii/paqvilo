export const referenceRelationships=[
  {name:'pqvd_access_currencies',kind:'manyToMany',parent:'pqvd_accesspermission',child:'transactioncurrency',solution:'PaqviloCompanyOperationsCore',intersectName:'pqvd_access_currencies',intersectColumns:['pqvd_accesspermissionid','transactioncurrencyid']},
  {name:'pqvd_access_referenceaccounts',kind:'manyToMany',parent:'pqvd_accesspermission',child:'account',solution:'PaqviloCompanyOperationsCore',intersectName:'pqvd_access_referenceaccounts',intersectColumns:['pqvd_accesspermissionid','accountid']}
];
export const referenceRoles=['COMPANYMANAGER','BRANCHMANAGER','HR','PROCUREMENT','AUDITOR','CTO'];
export function extendReferenceSchema(manifest) {
  for(const relation of referenceRelationships)if(!manifest.relationships.some(r=>r.name===relation.name))manifest.relationships.push(structuredClone(relation));
  return manifest;
}
export function extendReferenceCatalogue(catalogue,schema) {
  const rows=new Map(catalogue.records.map(r=>[r.key,r])),active=schema.choices.find(c=>c.name==='pqvd_accessstate').options.find(o=>o.label==='Active').value;
  const association=(relationship,key)=>catalogue.associations.find(a=>a.relationship===relationship&&a.from===key)?.to??[];
  // Vendor/currency projections are separate leaves; they never join the
  // operational account projection, and clearing a principal revokes them.
  for(const grant of catalogue.records.filter(r=>r.table==='pqvd_accesspermission')){
    const role=rows.get(grant.refs.pqvd_roleid)?.fields.pqvd_code,principal=grant.refs['pqvd_'+role?.toLowerCase()+'principalid'];
    const references={pqvd_access_currencies:new Set(),pqvd_access_referenceaccounts:new Set()};
    if(referenceRoles.includes(role)&&grant.fields.pqvd_accessstate===active&&principal===grant.refs.pqvd_granteecontactid){
      const accounts=new Set(association('pqvd_access_accounts',grant.key));
      for(const detail of catalogue.records.filter(r=>(role==='HR'?r.table==='pqvd_employmentterms':r.table==='pqvd_equipmentfinance'))){
        const parent=rows.get(detail.refs[role==='HR'?'pqvd_employmentid':'pqvd_equipmentid']),membership=role==='HR'?rows.get(parent?.refs.pqvd_orgcontactid):null,account=role==='HR'?membership?.refs.pqvd_accountid:parent?.refs.pqvd_accountid;
        if(!accounts.has(account))continue;
        if(detail.refs.transactioncurrencyid)references.pqvd_access_currencies.add(detail.refs.transactioncurrencyid);
        const vendor=detail.refs.pqvd_supplieraccountid??parent?.refs.pqvd_supplieraccountid;if(vendor)references.pqvd_access_referenceaccounts.add(vendor);
      }
    }
    for(const [relationship,set]of Object.entries(references)){const record={relationship,from:grant.key,to:[...set].sort()},existing=catalogue.associations.find(a=>a.relationship===relationship&&a.from===grant.key);if(existing)existing.to=record.to;else catalogue.associations.push(record);}
  }
  return catalogue;
}
