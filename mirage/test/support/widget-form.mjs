export const SITE = '7b2b3c4d-1e2f-4a5b-8c6d-7e8f9a0b1c3d';
export const CONTACT = 'c2000000-0000-4000-8000-000000000011';
export const ACCOUNT = 'a2000000-0000-4000-8000-000000000011';
export const FORM = '2d000000-0000-4000-8000-000000000011';

/** Invented form fixture; every call returns fresh source/state objects. */
export const widgetFormFiles = () => ({
  'website.yml': `adx_websiteid: ${SITE}\nadx_name: Widgets`,
  'Home.webpage.yml':
    'adx_webpageid: home\nadx_name: Home\nadx_partialurl: /\nadx_isroot: true\nadx_pagetemplateid: form',
  'FormPage.pagetemplate.yml': 'adx_pagetemplateid: form\nadx_webtemplateid: formcontent',
  'FormContent.webtemplate.yml': 'adx_webtemplateid: formcontent\nadx_name: Form content',
  'FormContent.webtemplate.source.html':
    '<script src="/jquery.min.js"></script><div class="page-header"><h1>Widget</h1></div>{% entityform name: "Widget" %}',
  'Widget.basicform.yml': `adx_entityformid: ${FORM}\nadx_name: Widget\nadx_entityname: contact\nadx_mode: 100000000\nadx_onsuccess: 756150000\nadx_successmessage: Widget saved.\nadx_hideformonsuccess: false`,
  'jquery.min.js.webfile.yml':
    'adx_webfileid: jquery\nadx_name: jquery.min.js\nadx_partialurl: jquery.min.js\nadx_parentpageid: home\nfilename: jquery.min.js',
  'sitesetting.yml':
    '- adx_sitesettingid: 5e200000-0000-4000-8000-000000000011\n  adx_name: Site/BootstrapV5Enabled\n  adx_value: "true"',
});
export const widgetFormState = () => ({
  version: 1,
  mappings: {
    contact: {
      entitySet: 'contacts',
      idColumn: 'contactid',
      nameColumn: 'fullname',
      relationships: {
        parentcustomerid_account: {
          from: 'parentcustomerid',
          to: 'accountid',
          entity: 'account',
          many: false,
          schemaName: 'contact_customer_accounts',
        },
        managingpartnerid: {
          from: 'managingpartnerid',
          to: 'accountid',
          entity: 'account',
          many: false,
          schemaName: 'contact_managingpartner',
        },
      },
    },
    account: { entitySet: 'accounts', idColumn: 'accountid', nameColumn: 'name' },
  },
  tables: { contact: [{ contactid: CONTACT, fullname: 'Grace' }], account: [{ accountid: ACCOUNT, name: 'Acme' }] },
  permissions: [
    {
      id: 'contact',
      entity: 'contact',
      scope: 'global',
      roles: ['Member'],
      operations: ['read', 'create', 'append', 'appendTo'],
    },
    {
      id: 'account',
      entity: 'account',
      scope: 'global',
      roles: ['Member'],
      operations: ['read', 'append', 'appendTo'],
    },
  ],
  settings: { permissionMode: 'enforce' },
  simulator: {
    mode: 'local',
    pageMode: 'local',
    identity: { id: CONTACT, contactId: CONTACT, roles: ['Member'] },
    live: { origin: null },
    endpoints: [],
    componentSchemas: {
      Widget: {
        entity: 'contact',
        mode: 100000000,
        fields: [
          { name: 'fullname', label: 'Full name', required: true, maxLength: 100 },
          { name: 'jobtitle', label: 'Code', readOnly: true },
          {
            name: 'preferredcontactmethodcode',
            label: 'Preferred',
            dataverseType: 'picklist',
            options: [
              { value: 1, label: 'Email' },
              { value: 2, label: 'Phone' },
            ],
          },
          { name: 'parentcustomerid', label: 'Company', type: 'lookup', lookupTargets: ['account'] },
          { name: 'managingpartnerid', label: 'Partner', type: 'lookup', lookupTargets: ['account'] },
        ],
      },
    },
  },
});
