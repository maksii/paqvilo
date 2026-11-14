// Invented parent and child tables shared by the cascade, cascade ownership, asynchronous drive, rollup and background-job
// trace suites. Each call returns fresh mapping objects, so a suite may extend them.

// systemuser with its full name, for suites that seed their own users.
export const systemUserMapping = () => ({
  logicalName: 'systemuser',
  entitySet: 'systemusers',
  idColumn: 'systemuserid',
  nameColumn: 'fullname',
  fields: { fullname: { dataverseType: 'nvarchar' } },
});

// x_parent and its x_child rows, both owned, one relationship (x_parentid) carrying the cascade configuration both ways.
export function cascadeMappings(cascade) {
  const link = { from: 'x_parentid', to: 'x_parentid', cascade };
  return {
    x_parent: {
      logicalName: 'x_parent',
      entitySet: 'x_parents',
      idColumn: 'x_parentid',
      nameColumn: 'x_name',
      relationships: { children: { entity: 'x_child', many: true, ...link } },
      fields: { x_name: { dataverseType: 'nvarchar' }, ownerid: { dataverseType: 'owner' } },
    },
    x_child: {
      logicalName: 'x_child',
      entitySet: 'x_children',
      idColumn: 'x_childid',
      nameColumn: 'x_name',
      relationships: { parent: { entity: 'x_parent', many: false, ...link } },
      fields: {
        x_name: { dataverseType: 'nvarchar' },
        x_parentid: { dataverseType: 'lookup' },
        ownerid: { dataverseType: 'owner' },
      },
    },
  };
}

// x_parent with the rollup column x_total (the sum of its children's x_amount, with its state and date columns) and
// x_child looking up its parent.
export function rollupMappings() {
  const formula =
    '<fetch aggregate="true"><entity name="x_child"><attribute name="x_amount" aggregate="sum" alias="total"/>' +
    '<filter type="and"><condition attribute="x_parentid" operator="eq" value="{id}"/></filter></entity></fetch>';
  return {
    x_parent: {
      logicalName: 'x_parent',
      entitySet: 'x_parents',
      idColumn: 'x_parentid',
      nameColumn: 'x_name',
      fields: {
        x_name: { dataverseType: 'nvarchar' },
        x_total: { dataverseType: 'decimal', columnMetadata: { sourceType: 2, formulaDefinition: formula } },
        x_total_state: { dataverseType: 'int' },
        x_total_date: { dataverseType: 'datetime' },
      },
    },
    x_child: {
      logicalName: 'x_child',
      entitySet: 'x_children',
      idColumn: 'x_childid',
      nameColumn: 'x_name',
      relationships: { x_parentid: { entity: 'x_parent', from: 'x_parentid', to: 'x_parentid', many: false } },
      fields: {
        x_name: { dataverseType: 'nvarchar' },
        x_amount: { dataverseType: 'decimal' },
        x_parentid: { dataverseType: 'lookup', targets: ['x_parent'] },
      },
    },
  };
}
