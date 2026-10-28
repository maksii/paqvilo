/** Charge aggregate inspection work, including repeated/aliased collections before expansion. */
export function inspectionBudget(limit, label) {
  let remaining = limit;
  return (amount = 1) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || (remaining -= amount) < 0)
      throw new RangeError(`${label} exceeds its ${limit} work-unit inspection limit.`);
  };
}

/** Account for tableFields' option materialization before allocating its repeated metadata arrays. */
export function chargeSchemaOptions(table, schema, charge) {
  const attributes = Object.values(table.attributes);
  charge(attributes.length);
  for (const attribute of attributes) {
    for (const name of ['options', 'states', 'statuses']) charge(attribute.optionSet?.[name]?.length ?? 0);
    if (attribute.optionSetName)
      charge(schema.optionSets?.[attribute.optionSetName.toLowerCase()]?.options?.length ?? 0);
  }
}
