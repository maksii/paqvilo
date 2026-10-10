// Explicit local models for the exported C# registrations. Mirage does not execute .NET.
const supplied = (target, field) => Object.hasOwn(target, field);
const trimmed = value => value == null ? null : String(value).trim();
const email = value => value == null ? null : String(value).trim().toLowerCase();

function validateAccount({target,reject}) {
 if(supplied(target,'name') && (!target.name || trimmed(target.name).length<3)) reject('Account name must contain at least 3 characters.');
}
function normalizeAccount({target}) {
 const result={};
 if(supplied(target,'name')) {result.name=trimmed(target.name);result.tickersymbol=result.name==null?null:result.name.replace(/[^A-Za-z0-9]/g,'').toUpperCase().slice(0,10);}
 if(supplied(target,'emailaddress1')) result.emailaddress1=email(target.emailaddress1);
 return {target:result};
}
function validateContact({target,reject}) {
 if(supplied(target,'lastname') && (!target.lastname || trimmed(target.lastname).length<2)) reject('Contact last name must contain at least 2 characters.');
}
function normalizeContact({target}) {
 const result={};
 for(const field of ['firstname','lastname']) if(supplied(target,field)) result[field]=trimmed(target[field]);
 if(supplied(target,'emailaddress1')) result.emailaddress1=email(target.emailaddress1);
 return {target:result};
}

export const pluginSteps={
 'b4700000-0000-4000-8000-370000000100':validateAccount,
 'b4700000-0000-4000-8000-370000000101':normalizeAccount,
 'b4700000-0000-4000-8000-370000000102':validateAccount,
 'b4700000-0000-4000-8000-370000000103':normalizeAccount,
 'b4700000-0000-4000-8000-370000000104':validateContact,
 'b4700000-0000-4000-8000-370000000105':normalizeContact,
 'b4700000-0000-4000-8000-370000000106':validateContact,
 'b4700000-0000-4000-8000-370000000107':normalizeContact,
};

// PAC exports message IDs without names; this mapping is an explicit environment observation.
export const sdkMessages={
  "9ebdbb1b-ea3e-db11-86a7-000a3a5473e8": {
    "name": "Create",
    "evidence": "Dataverse sdkmessages read on 2026-10-10; matched the PAC-exported SdkMessageId."
  },
  "20bebb1b-ea3e-db11-86a7-000a3a5473e8": {
    "name": "Update",
    "evidence": "Dataverse sdkmessages read on 2026-10-10; matched the PAC-exported SdkMessageId."
  }
};
