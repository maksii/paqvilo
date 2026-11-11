/** Invented-schema aliases for the exact typed input guarantees in the paired native evidence. */
export function webApiInputContractCases() {
  return [
    { id: 'double.infinity.patch', field: 'double', value: 'Infinity' },
    { id: 'double.boolean.patch', field: 'double', value: true },
    { id: 'double.object.patch', field: 'double', value: {} },
    { id: 'choices.invalid-string.patch', field: 'choices', value: 'bad' },
    { id: 'choices.number.patch', field: 'choices', value: 198710000 },
    { id: 'choices.boolean.patch', field: 'choices', value: true },
  ];
}

/** Transport remains caller-owned: native credentials never enter returned facets. */
export async function captureWebApiInputContract({ request, collection, recordId, fields, binding }) {
  const results = [];
  for (const entry of webApiInputContractCases()) {
    const response = await request(collection + '(' + recordId + ')', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', Prefer: 'return=representation,odata.include-annotations="*"' },
      body: JSON.stringify({ [fields[entry.field]]: entry.value }),
    });
    const { error } = await response.json();
    results.push({ id: entry.id, status: response.status, code: error?.code });
  }
  if (binding) {
    const response = await request(binding.collection + '(' + binding.recordId + ')', {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ [binding.navigation + '@odata.bind']: '/' + binding.targetCollection + '(not-a-guid)' }),
    });
    const { error } = await response.json();
    results.push({
      id: 'relationships.bind-invalid',
      status: response.status,
      code: error?.code,
      message: error?.message,
    });
  }
  return results;
}

/** Raw JSON scalar-reader inputs shared by native collection and loopback tests. */
export function webApiScalarReaderCases() {
  const cause = (literal, target, source) =>
    `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> Microsoft.OData.ODataException: Cannot convert a value of type '${source}' to the expected target type '${target}'.`;
  const format = (literal, target, detail) =>
    `Cannot convert the literal '${literal}' to the expected type '${target}'. ---> System.FormatException: ${detail}`;
  return [
    ['name', '1', cause('1', 'Edm.String', 'Edm.Int32')],
    ['name', '1.0', cause('1.0', 'Edm.String', 'Edm.Decimal')],
    ['name', '9007199254740993', cause('9007199254740993', 'Edm.String', 'Edm.Decimal')],
    ['name', 'false', cause('False', 'Edm.String', 'Edm.Boolean')],
    ['quantity', 'true', cause('True', 'Edm.Int32', 'Edm.Boolean')],
    ['quantity', '1.25', cause('1.25', 'Edm.Int32', 'Edm.Decimal')],
    ['quantity', '"not-a-number"', format('not-a-number', 'Edm.Int32', 'Input string was not in a correct format.')],
    ['enabled', '1', cause('1', 'Edm.Boolean', 'Edm.Int32')],
    ['enabled', '2', cause('2', 'Edm.Boolean', 'Edm.Int32')],
    ['enabled', '""', format('', 'Edm.Boolean', 'String was not recognized as a valid Boolean.')],
    ['price', 'true', cause('True', 'Edm.Decimal', 'Edm.Boolean')],
    ['ratio', 'false', cause('False', 'Edm.Double', 'Edm.Boolean')],
    [
      'stamp',
      '"2020-02-31T12:00:00Z"',
      format(
        '2020-02-31T12:00:00Z',
        'Edm.DateTimeOffset',
        "The string '2020-02-31T12:00:00Z' is not a valid AllXsd value.",
      ),
    ],
    ['stamp', '0', cause('0', 'Edm.DateTimeOffset', 'Edm.Int32')],
    ['day', '"bad-date"', format('bad-date', 'Edm.Date', "String 'bad-date' was not recognized as a valid Edm.Date.")],
    ['choice', 'false', cause('False', 'Edm.Int32', 'Edm.Boolean')],
    ['tags', '2', cause('2', 'Edm.String', 'Edm.Int32')],
  ];
}
