import { createHash } from 'node:crypto';
export const componentId = (key) => {
  const b = createHash('sha256')
    .update('CO Forms v1:' + key)
    .digest()
    .subarray(0, 16);
  b[6] = (b[6] & 15) | 80;
  b[8] = (b[8] & 63) | 128;
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
const xml = (s) =>
  String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[c]);
const core = 'PaqviloCompanyOperationsForms',
  support = 'PaqviloPermissionTestSupport',
  evidence = 'PaqviloPluginEvidence';
const names = {
  account: 'Organisation',
  contact: 'Person',
  pqvd_accessrole: 'Access Role',
  pqvd_accesspermission: 'Access Permission',
  pqvd_orgcontact: 'Organisation Contact',
  pqvd_department: 'Department',
  pqvd_employment: 'Employment',
  pqvd_employmentterms: 'Private Employment Terms',
  pqvd_site: 'Site',
  pqvd_building: 'Building',
  pqvd_room: 'Room',
  pqvd_equipment: 'Equipment',
  pqvd_equipmentfinance: 'Equipment Finance',
  pqvd_assignment: 'Assignment',
  pqvd_servicerequest: 'Service Request',
  pqvd_workorder: 'Work Order',
  pqvd_worktask: 'Work Task',
  pqvd_checklistitem: 'Checklist Item',
  pqvd_inspection: 'Inspection',
  pqvd_finding: 'Finding',
  pqvd_testrun: 'Test Run',
  pqvd_testresult: 'Test Result',
  pqvd_crudprobe: 'CRUD Probe',
  pqvd_testoperation: 'Test Operation',
  pqvd_pluginevent: 'Plugin Event',
  pqvd_chainnode: 'Chain Node',
};
// Explicit field sets keep portable forms and views free of private/security ancestry.
const safe = {
  account: 'name accountnumber pqvd_orgkind',
  contact: 'pqvd_personcode fullname',
  pqvd_accessrole: 'pqvd_code pqvd_name',
  pqvd_accesspermission:
    'pqvd_number pqvd_roleid pqvd_scopeaccountid pqvd_scopekind pqvd_accessstate pqvd_validfrom pqvd_validuntil',
  pqvd_orgcontact: 'pqvd_code pqvd_displayname pqvd_workemail pqvd_workphone pqvd_membershipstate',
  pqvd_department: 'pqvd_code pqvd_name pqvd_description',
  pqvd_employment:
    'pqvd_number pqvd_jobtitle pqvd_engagementkind pqvd_ftefraction pqvd_startdate pqvd_enddate pqvd_employmentstate',
  pqvd_employmentterms:
    'pqvd_name pqvd_employmentid pqvd_contractreference pqvd_annualsalary pqvd_dayrate transactioncurrencyid',
  pqvd_site: 'pqvd_code pqvd_name pqvd_sitekind pqvd_address',
  pqvd_building: 'pqvd_code pqvd_name pqvd_floors',
  pqvd_room: 'pqvd_code pqvd_name pqvd_floor pqvd_capacity pqvd_roomkind',
  pqvd_equipment:
    'pqvd_assettag pqvd_name pqvd_equipmentkind pqvd_manufacturer pqvd_model pqvd_condition pqvd_equipmentstate pqvd_warrantyend',
  pqvd_equipmentfinance:
    'pqvd_name pqvd_equipmentid pqvd_purchasecost pqvd_replacementvalue transactioncurrencyid pqvd_invoicereference pqvd_costcentre',
  pqvd_assignment:
    'pqvd_number pqvd_issuedat pqvd_returnedat pqvd_issuecondition pqvd_returncondition pqvd_assignmentstate',
  pqvd_servicerequest: 'pqvd_number pqvd_name pqvd_requestkind pqvd_priority pqvd_reportedat pqvd_workstate',
  pqvd_workorder: 'pqvd_number pqvd_name pqvd_duedate pqvd_workstate',
  pqvd_worktask: 'pqvd_sequence pqvd_name pqvd_estimatedminutes pqvd_actualminutes pqvd_workstate',
  pqvd_checklistitem: 'pqvd_sequence pqvd_name pqvd_instruction pqvd_checkresult',
  pqvd_inspection: 'pqvd_attempt pqvd_inspectedat pqvd_checkresult pqvd_measuredvalue pqvd_measurementunit',
  pqvd_finding: 'pqvd_sequence pqvd_severity pqvd_description pqvd_workstate',
  pqvd_testrun: 'pqvd_name pqvd_runkey pqvd_runnercontactid pqvd_startedat pqvd_runstate',
  pqvd_testresult: 'pqvd_name pqvd_caseid pqvd_engine pqvd_phase pqvd_pagenumber pqvd_partnumber pqvd_verdict',
  pqvd_crudprobe: 'pqvd_name pqvd_token pqvd_counter',
  pqvd_testoperation: 'pqvd_name pqvd_caseid pqvd_lane pqvd_phase pqvd_capturestate',
  pqvd_pluginevent: 'pqvd_name pqvd_artifacttype pqvd_message pqvd_stage pqvd_depth pqvd_partnumber',
  pqvd_chainnode: 'pqvd_name pqvd_nodecode pqvd_hop pqvd_scenario pqvd_configstatus',
};
const viewNames = {
  account: ['Active Organisations', 'Organisation Profiles', 'Organisation Lookup Candidates', 'Vendors'],
  contact: ['Person Lookup Candidates', 'People Administration'],
  pqvd_accessrole: ['Active Access Roles'],
  pqvd_accesspermission: ['Active Access Permissions', 'Suspended Access Permissions', 'Access Permission Diagnostics'],
  pqvd_orgcontact: ['Active Organisation Contacts', 'Directory Contacts'],
  pqvd_department: ['Active Departments', 'Department Summaries'],
  pqvd_employment: ['Active Engagements', 'Ended Engagements', 'Engagement Summaries'],
  pqvd_employmentterms: ['Private Employment Terms All'],
  pqvd_site: ['Active Sites', 'Site Summaries'],
  pqvd_building: ['Active Buildings'],
  pqvd_room: ['Active Rooms'],
  pqvd_equipment: ['Available Equipment', 'Assigned Equipment', 'Retired Equipment', 'Equipment Summaries'],
  pqvd_equipmentfinance: ['Equipment Finance All'],
  pqvd_assignment: ['Open Assignments', 'Assignment History', 'Assignment Summaries'],
  pqvd_servicerequest: ['Open Service Requests', 'Service Request Summaries'],
  pqvd_workorder: ['Open Work Orders'],
  pqvd_worktask: ['Open Work Tasks'],
  pqvd_checklistitem: ['Checklist Items'],
  pqvd_inspection: ['Inspection Results'],
  pqvd_finding: ['Open Findings', 'Finding History'],
  pqvd_testrun: ['Test Runs Recent', 'Test Runs Incomplete'],
  pqvd_testresult: ['Results By Case', 'Failed Test Results'],
  pqvd_crudprobe: ['Outstanding CRUD Probes'],
  pqvd_testoperation: ['My Run Operations', 'Pending Captures', 'Quarantined Captures', 'Failed Capture Operations'],
  pqvd_pluginevent: ['Plugin Events by Operation'],
  pqvd_chainnode: ['Chain Nodes by Operation'],
};
const portable = {
  account: ['Profile', 'name accountnumber pqvd_orgkind'],
  pqvd_orgcontact: ['Profile', 'pqvd_displayname pqvd_workemail pqvd_workphone pqvd_membershipstate'],
  pqvd_department: ['Profile', 'pqvd_name pqvd_code pqvd_description'],
  pqvd_employment: ['Summary', safe.pqvd_employment],
  pqvd_site: ['Summary', safe.pqvd_site],
  pqvd_equipment: ['Summary', safe.pqvd_equipment],
  pqvd_assignment: ['Summary', safe.pqvd_assignment],
  pqvd_servicerequest: ['Summary', safe.pqvd_servicerequest + ' pqvd_description'],
};
const childGrids = {
  account: ['pqvd_orgcontact', 'pqvd_department', 'pqvd_equipment', 'pqvd_site'],
  contact: ['pqvd_orgcontact'],
  pqvd_orgcontact: ['pqvd_employment'],
  pqvd_department: ['pqvd_employment'],
  pqvd_employment: ['pqvd_assignment'],
  pqvd_site: ['pqvd_building'],
  pqvd_building: ['pqvd_room'],
  pqvd_room: ['pqvd_equipment'],
  pqvd_equipment: ['pqvd_assignment', 'pqvd_servicerequest'],
  pqvd_assignment: ['pqvd_servicerequest'],
  pqvd_servicerequest: ['pqvd_workorder'],
  pqvd_workorder: ['pqvd_worktask'],
  pqvd_worktask: ['pqvd_checklistitem'],
  pqvd_checklistitem: ['pqvd_inspection'],
  pqvd_inspection: ['pqvd_finding'],
  pqvd_testrun: ['pqvd_testresult'],
  pqvd_testoperation: ['pqvd_pluginevent', 'pqvd_chainnode'],
};
const classes = {
  string: '4273EDBD-AC1D-40d3-9FB2-095C621B552D',
  memo: 'E0DECE4B-6FC8-4A8F-A065-082708572369',
  integer: 'C6D124CA-7EDA-4A60-AEA9-7FB8D318B68F',
  decimal: 'C3EFE0C3-0EC6-42BE-8349-CBD9079DFD8E',
  double: '0D2C745A-E5A8-4C8B-BA63-C6D3BB604660',
  money: '533B9E00-756B-4312-95A0-DC888637AC78',
  boolean: '67FAC785-CD58-4F9F-ABB3-4B7DDC6ED5ED',
  datetime: '5B773807-9FB2-42DB-97C3-7A91EFF8ADFF',
  choice: '3EF39988-22BB-4F0B-BBBE-64B5A3748AEE',
  lookup: '270BD3DB-D9AF-4782-9025-509E298DEC0A',
  multichoice: '4AA60AB7-E075-4C4D-8BF9-738DFB89A97E',
};
names.pqvd_currencyreference = 'Currency Reference';
safe.pqvd_currencyreference = 'pqvd_name pqvd_code pqvd_symbol pqvd_precision pqvd_systemcurrencyid';
viewNames.pqvd_currencyreference = ['Currency References', 'Currency Reference Lookup Candidates'];
portable.pqvd_currencyreference = ['Summary', 'pqvd_name pqvd_code pqvd_symbol pqvd_precision'];

function addAccountFilter(parts, name, condition, value) {
  parts.push(condition('pqvd_orgkind', name === 'Vendors' ? 'eq' : 'ne', value('pqvd_orgkind', 'Vendor')));
  if (name !== 'Vendors' && !parts.length) parts.push(condition('statecode', 'eq', 0));
}

function addPrimaryChoiceFilter(parts, table, name, choiceFilter, condition, value) {
  if (table === 'pqvd_orgcontact' && !name.endsWith('All')) choiceFilter('pqvd_membershipstate', 'Active');
  if (table === 'pqvd_employment' && name === 'Active Engagements') choiceFilter('pqvd_employmentstate', 'Active');
  if (table === 'pqvd_employment' && name === 'Ended Engagements') choiceFilter('pqvd_employmentstate', 'Ended');
  if (table === 'pqvd_accesspermission' && name === 'Active Access Permissions')
    choiceFilter('pqvd_accessstate', 'Active');
  if (table === 'pqvd_accesspermission' && name === 'Suspended Access Permissions')
    addSuspendedPermissionFilter(parts, condition, value);
  if (table === 'pqvd_equipment' && /^(?:Available|Assigned|Retired) /.test(name))
    addEquipmentChoiceFilter(name, choiceFilter);
  if (table === 'pqvd_assignment' && name === 'Open Assignments') choiceFilter('pqvd_assignmentstate', 'Issued');
}

function addSuspendedPermissionFilter(parts, condition, value) {
  const values = ['Suspended', 'Expired', 'Revoked']
    .map((v) => `<value>${value('pqvd_accessstate', v)}</value>`)
    .join('');
  parts.push(`<condition attribute="pqvd_accessstate" operator="in">${values}</condition>`);
}

function addEquipmentChoiceFilter(name, choiceFilter) {
  let state = 'Retired';
  if (name.startsWith('Available')) state = 'Stock';
  else if (name.startsWith('Assigned')) state = 'Assigned';
  choiceFilter('pqvd_equipmentstate', state);
}

function addOtherViewFilters(parts, table, name, choiceFilter, condition) {
  if (
    table === 'pqvd_currencyreference' &&
    ['Currency References', 'Currency Reference Lookup Candidates'].includes(name)
  )
    parts.push(condition('statecode', 'eq', 0));
  if (name === 'Test Runs Incomplete') parts.push(condition('pqvd_finishedat', 'null'));
  if (name === 'Failed Test Results') choiceFilter('pqvd_verdict', 'Fail');
  if (name === 'Pending Captures') choiceFilter('pqvd_capturestate', 'Pending');
  if (name === 'Quarantined Captures') choiceFilter('pqvd_capturestate', 'Quarantined');
  if (name === 'Failed Capture Operations') choiceFilter('pqvd_capturestate', 'CaptureFailed');
}

function viewFilters(table, name, field, value, condition) {
  const parts = [];
  const choiceFilter = (attribute, text) => parts.push(condition(attribute, 'eq', value(attribute, text)));
  if (/^(?:Active |Available |Assigned |Open )/.test(name) || /Lookup Candidates|Directory Contacts/.test(name))
    parts.push(condition('statecode', 'eq', 0));
  if (table === 'account') addAccountFilter(parts, name, condition, value);
  addPrimaryChoiceFilter(parts, table, name, choiceFilter, condition, value);
  if (name.startsWith('Open ') && field(table, 'pqvd_workstate'))
    for (const state of ['Completed', 'Cancelled'])
      parts.push(condition('pqvd_workstate', 'ne', value('pqvd_workstate', state)));
  addOtherViewFilters(parts, table, name, choiceFilter, condition);
  return parts.length ? `<filter type="and">${parts.join('')}</filter>` : '';
}

function makeView(table, name, fields, { queryType = 0, filter = '', order } = {}, context) {
  const { valid, field, primary, pk, metadata, solution } = context;
  fields = valid(table, fields);
  const first = fields.find((f) => /code$|number$|sequence$|assettag$|attempt$|token$/.test(f)) || primary(table);
  order ??= [
    { field: first, descending: false },
    { field: pk(table), descending: false },
  ];
  const selected = [...new Set([pk(table), ...fields, ...order.map((o) => o.field)])];
  const attributes = selected.map((f) => `<attribute name="${f}"/>`).join('');
  const orders = order.map((o) => `<order attribute="${o.field}" descending="${o.descending}"/>`).join('');
  const fetchXml = `<fetch version="1.0" mapping="logical"><entity name="${table}">${attributes}${orders}${filter}</entity></fetch>`;
  const cellWidth = (f) => {
    if (f === primary(table)) return 220;
    return field(table, f)?.AttributeType === 'Memo' ? 300 : 140;
  };
  const cells = fields.map((f) => `<cell name="${f}" width="${cellWidth(f)}"/>`).join('');
  const layoutXml = `<grid name="resultset" object="${metadata[table].ObjectTypeCode}" jump="${primary(table)}" select="1" icon="1" preview="1"><row name="result" id="${pk(table)}">${cells}</row></grid>`;
  return {
    id: componentId('view:' + table + ':' + name),
    table,
    name: 'CO ' + name,
    solution: solution(table),
    queryType,
    fetchXml,
    layoutXml,
  };
}

function customViewOrder(table, name, pk) {
  let order;
  if (name === 'Test Runs Recent')
    order = [
      { field: 'createdon', descending: true },
      { field: pk(table), descending: false },
    ];
  if (table === 'pqvd_assignment')
    order = [
      { field: 'pqvd_issuedat', descending: true },
      { field: 'pqvd_number', descending: false },
      { field: pk(table), descending: false },
    ];
  if (table === 'pqvd_servicerequest')
    order = [
      { field: 'pqvd_priority', descending: true },
      { field: 'pqvd_number', descending: false },
      { field: pk(table), descending: false },
    ];
  if (table === 'pqvd_workorder')
    order = [
      { field: 'pqvd_duedate', descending: false },
      { field: 'pqvd_number', descending: false },
      { field: pk(table), descending: false },
    ];
  if (table === 'pqvd_testresult')
    order = ['pqvd_caseid', 'pqvd_engine', 'pqvd_phase', 'pqvd_pagenumber', 'pqvd_partnumber', pk(table)].map(
      (field) => ({ field, descending: false }),
    );
  return order;
}

function addQuickFindViews(table, own, base, context) {
  const { primary, condition, viewContext, adjustments } = context;
  if (own.existing) return;
  let reference = base.find((f) => /code$|number$|token$|caseid$|runkey$/.test(f));
  if (table === 'pqvd_employmentterms') reference = 'pqvd_contractreference';
  else if (table === 'pqvd_equipmentfinance') reference = 'pqvd_invoicereference';
  const search = [primary(table), reference].filter(Boolean);
  const active = condition('statecode', 'eq', 0);
  for (const queryType of [64, 4]) {
    const quick =
      queryType === 4
        ? `<filter type="or" isquickfindfields="1">${search.map((f) => condition(f, 'like', '{0}')).join('')}</filter>`
        : '';
    adjustments.push({
      ...makeView(
        table,
        queryType === 64 ? 'Lookup' : 'Quick Find',
        search,
        { queryType, filter: `<filter type="and">${active}</filter>${quick}` },
        viewContext,
      ),
      isQuickFind: queryType === 4,
    });
  }
}

function addAllRecordsView(table, own, base, context) {
  if (own.existing || ['pqvd_employmentterms', 'pqvd_equipmentfinance'].includes(table)) return;
  const { names, primary, viewContext, schema, views } = context;
  const code = base.find((f) => /code$|number$|sequence$|assettag$|attempt$|token$/.test(f));
  const state = own.columns.find((c) => c.name.endsWith('state'))?.name;
  const parent = schema.relationships.find(
    (r) => r.kind === 'oneToMany' && r.child === table && r.lookup.required === 'required',
  )?.lookup.name;
  views.push(
    makeView(table, names[table] + ' All', [primary(table), code, state, parent].filter(Boolean), {}, viewContext),
  );
}

function buildTableViews(table, context) {
  const { schema, safe, viewNames, valid, pk, field, value, condition, viewContext, views } = context;
  const own = schema.tables.find((t) => t.name === table);
  const base = valid(table, safe[table].split(' ').filter(Boolean));
  for (const name of viewNames[table]) {
    let fields = base;
    if (name === 'Access Permission Diagnostics')
      fields = [
        ...base,
        ...schema.relationships
          .filter((r) => r.child === table && r.lookup?.name.endsWith('principalid'))
          .map((r) => r.lookup.name),
      ];
    const order = customViewOrder(table, name, pk);
    views.push(
      makeView(table, name, fields, { filter: viewFilters(table, name, field, value, condition), order }, viewContext),
    );
  }
  addAllRecordsView(table, own, base, context);
  addQuickFindViews(table, own, base, context);
}

function buildSelectedViews(selected, context) {
  for (const table of selected) buildTableViews(table, context);
}

function formFieldRows(table, fields, fid, isPortable, context) {
  const rows = [];
  for (const f of fields) {
    const a = context.field(table, f);
    const type =
      a.AttributeTypeName?.Value === 'MultiSelectPicklistType'
        ? 'multichoice'
        : {
            String: 'string',
            Memo: 'memo',
            Integer: 'integer',
            Decimal: 'decimal',
            Double: 'double',
            Money: 'money',
            Boolean: 'boolean',
            DateTime: 'datetime',
            Picklist: 'choice',
            State: 'choice',
            Status: 'choice',
            Lookup: 'lookup',
            Customer: 'lookup',
            Owner: 'lookup',
          }[a.AttributeType];
    if (!classes[type]) throw new Error(`Unsupported form control ${table}.${f}:${a.AttributeType}`);
    const locked =
      table === 'pqvd_currencyreference' ||
      isPortable ||
      a.IsValidForUpdate === false ||
      f === 'pqvd_scopekey' ||
      f.endsWith('principalid') ||
      ['pqvd_testoperation', 'pqvd_pluginevent'].includes(table);
    rows.push(
      `<row><cell id="{${componentId(fid + f)}}">${context.labels(context.label(a))}<control id="${f}" classid="{${classes[type]}}" datafieldname="${f}" disabled="${locked}"/></cell></row>`,
    );
  }
  return rows;
}

function formRelationships(table, pipeline, schema) {
  const rels = (childGrids[table] || [])
    .map((child) => schema.relationships.find((r) => r.kind === 'oneToMany' && r.parent === table && r.child === child))
    .filter(Boolean);
  if (pipeline && table === 'pqvd_testrun')
    rels.push(
      schema.relationships.find(
        (r) => r.kind === 'oneToMany' && r.parent === table && r.child === 'pqvd_testoperation',
      ),
    );
  if (pipeline && table === 'pqvd_testoperation')
    rels.push(
      schema.relationships.find((r) => r.kind === 'oneToMany' && r.parent === table && r.child === 'pqvd_testresult'),
    );
  if (table === 'pqvd_accesspermission')
    rels.push(
      ...schema.relationships.filter(
        (r) =>
          r.kind === 'manyToMany' &&
          r.parent === table &&
          !['pqvd_access_currencies', 'pqvd_access_currencyreferences', 'pqvd_access_referenceaccounts'].includes(
            r.name,
          ),
      ),
    );
  return rels;
}

function formGridMarkup(fid, rels, context) {
  const grids = [];
  for (const r of rels) {
    const v = context.allFor(r.child),
      control = 'grid_' + r.name;
    grids.push(
      `<section name="${control}" id="{${componentId(fid + control)}}" showlabel="true" showbar="false" columns="1">${context.labels(names[r.child] || r.child)}<rows><row><cell id="{${componentId(fid + control + 'cell')}}" showlabel="false">${context.labels(names[r.child] || r.child)}<control id="${control}" indicationOfSubgrid="true" classid="{E7A81278-8635-4D9E-8D4D-59480B391C5B}"><parameters><ViewId>{${v.id}}</ViewId><IsUserView>false</IsUserView><RelationshipName>${r.name}</RelationshipName><TargetEntityType>${r.child}</TargetEntityType><RecordsPerPage>10</RecordsPerPage><EnableQuickFind>true</EnableQuickFind><EnableViewPicker>false</EnableViewPicker></parameters></control></cell></row></rows></section>`,
    );
  }
  return grids;
}

function createForm(table, name, fields, isPortable, pipeline, context) {
  context.valid(table, fields);
  const fid = componentId('form:' + table + ':' + name);
  const rows = formFieldRows(table, fields, fid, isPortable, context);
  const grids = isPortable ? [] : formGridMarkup(fid, formRelationships(table, pipeline, context.schema), context);
  const formXml = `<form><tabs><tab name="general" id="{${componentId(fid + 'tab')}}" verticallayout="true" IsUserDefined="1">${context.labels('General')}<columns><column width="100%"><sections><section name="details" id="{${componentId(fid + 'section')}}" showlabel="true" showbar="false" columns="1">${context.labels(isPortable ? 'Profile' : 'Administration')}<rows>${rows.join('')}</rows></section>${grids.join('')}</sections></column></columns></tab></tabs></form>`;
  context.forms.push({
    id: fid,
    table,
    name,
    solution: pipeline ? 'PaqviloBehaviorPlugins' : context.solution(table),
    type: 2,
    formXml,
    portable: isPortable,
    fields,
  });
}

function buildStandardForms(selected, context) {
  for (const table of selected) {
    const own = context.schema.tables.find((t) => t.name === table);
    let standard = ['pqvd_name'];
    if (table === 'account') standard = ['name', 'accountnumber', 'parentaccountid'];
    else if (table === 'contact') standard = ['firstname', 'lastname', 'emailaddress1', 'telephone1'];
    const scalar = own.columns.filter((c) => c.solution !== 'PaqviloBehaviorPlugins').map((c) => c.name);
    const lookups = context.schema.relationships
      .filter((r) => r.kind === 'oneToMany' && r.child === table && r.solution !== 'PaqviloBehaviorPlugins')
      .map((r) => r.lookup.name);
    const fields = [
      ...new Set([
        ...standard,
        ...scalar,
        ...lookups,
        ...(['pqvd_employmentterms', 'pqvd_equipmentfinance'].includes(table) ? ['transactioncurrencyid'] : []),
        ...(table === 'pqvd_chainnode' ? ['ownerid'] : []),
      ]),
    ];
    let name = 'CO ' + names[table] + ' Administration';
    if (table === 'pqvd_employmentterms') name = 'CO Private Employment Terms';
    else if (table === 'pqvd_equipmentfinance') name = 'CO Equipment Finance';
    else if (['pqvd_testoperation', 'pqvd_pluginevent', 'pqvd_chainnode'].includes(table)) name = 'CO ' + names[table];
    createForm(table, name, fields, false, false, context);
    if (portable[table])
      createForm(
        table,
        'CO ' + names[table] + ' ' + portable[table][0],
        context.split(portable[table][1]),
        true,
        false,
        context,
      );
  }
}

function buildPipelineForms(selected, context) {
  const tables = ['pqvd_testrun', 'pqvd_testresult', 'pqvd_crudprobe', 'pqvd_testoperation'].filter((table) =>
    selected.includes(table),
  );
  for (const table of tables) {
    const own = context.schema.tables.find((t) => t.name === table);
    const fields = [
      context.primary(table),
      ...own.columns.map((column) => column.name),
      ...context.schema.relationships
        .filter((r) => r.kind === 'oneToMany' && r.child === table)
        .map((r) => r.lookup.name),
    ];
    createForm(table, 'CO ' + names[table] + ' Pipeline', [...new Set(fields)], false, true, context);
  }
}

function buildEquipmentCanaryForm(selected, context) {
  if (selected.includes('pqvd_equipment'))
    createForm(
      'pqvd_equipment',
      'CO Equipment Canary Diagnostics',
      ['pqvd_name', 'pqvd_assettag', 'pqvd_equipmentstate', 'pqvd_currentassignmentid', 'pqvd_canaryrunid'],
      false,
      true,
      context,
    );
}

export function compileForms(schema, metadata, { tables } = {}) {
  const selected = tables ?? Object.keys(names);
  if (
    !Array.isArray(selected) ||
    !selected.length ||
    new Set(selected).size !== selected.length ||
    selected.some((t) => !names[t] || !schema.tables.some((s) => s.name === t) || !metadata[t])
  )
    throw new Error('Explicit form table selection requires unique declared tables and native metadata.');
  const forms = [],
    views = [],
    adjustments = [];
  const field = (table, name) => metadata[table].Attributes.find((a) => a.LogicalName === name);
  const label = (a) =>
    a.DisplayName?.UserLocalizedLabel?.Label ||
    a.DisplayName?.LocalizedLabels?.find((l) => l.LanguageCode === 1033)?.Label ||
    a.LogicalName;
  const solution = (table) => {
    if (table === 'pqvd_testoperation' || table === 'pqvd_pluginevent' || table === 'pqvd_chainnode') return evidence;
    return ['pqvd_testrun', 'pqvd_testresult', 'pqvd_crudprobe'].includes(table) ? support : core;
  };
  const primary = (table) => metadata[table].PrimaryNameAttribute,
    pk = (table) => metadata[table].PrimaryIdAttribute;
  const valid = (table, fields) => {
    for (const f of fields) if (!field(table, f)) throw new Error(`Unknown form/view field ${table}.${f}`);
    return [...new Set(fields)];
  };
  const split = (s) => s.split(' ').filter(Boolean);
  const value = (choice, label) => {
    const opt = schema.choices.find((c) => c.name === choice)?.options.find((o) => o.label === label);
    if (!opt) throw new Error(`Unknown filter ${choice}:${label}`);
    return opt.value;
  };
  const condition = (a, op, v) => {
    const valueXml = v === undefined ? '' : ` value="${xml(v)}"`;
    return `<condition attribute="${a}" operator="${op}"${valueXml}/>`;
  };
  const viewContext = { valid, field, primary, pk, metadata, solution };
  buildSelectedViews(selected, {
    schema,
    safe,
    viewNames,
    names,
    valid,
    field,
    primary,
    pk,
    value,
    condition,
    viewContext,
    views,
    adjustments,
  });
  const allFor = (table) =>
    views.find((v) => v.table === table && v.name.endsWith(' All')) || views.find((v) => v.table === table);
  const labels = (s) => `<labels><label description="${xml(s)}" languagecode="1033"/></labels>`;
  const formContext = {
    schema,
    names,
    split,
    primary,
    valid,
    field,
    label,
    solution,
    allFor,
    labels,
    forms,
  };
  buildStandardForms(selected, formContext);
  buildPipelineForms(selected, formContext);
  buildEquipmentCanaryForm(selected, formContext);
  return { schemaVersion: 1, forms, views, adjustments };
}
