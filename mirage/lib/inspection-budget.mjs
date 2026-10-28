/** Charge aggregate inspection work, including repeated/aliased collections before expansion. */
export function inspectionBudget(limit, label) {
  let remaining = limit;
  return (amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || (remaining -= amount) < 0)
      throw new RangeError(`${label} exceeds its ${limit} work-unit inspection limit.`);
  };
}

/** Account for repeated option/target collections before tableFields materializes or consumers inspect them. */
export function chargeSchemaMetadata(tableName, table, schema, charge) {
  const attributes = Object.values(table.attributes);
  charge(attributes.length);
  for (const attribute of attributes) {
    charge(schema.targets?.[`${tableName}/${attribute.name}`]?.length ?? 0);
    for (const name of ['options', 'states', 'statuses']) charge(attribute.optionSet?.[name]?.length ?? 0);
    if (attribute.optionSetName)
      charge(schema.optionSets?.[attribute.optionSetName.toLowerCase()]?.options?.length ?? 0);
  }
}
