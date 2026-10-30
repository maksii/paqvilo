import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { encodeValue, NS } from '../lib/dataverse-soap-xml.mjs';
import { soapSdkResults } from '../lib/dataverse-soap-sdk-values.mjs';
const soapSdkValue = (value) => soapSdkResults({ value }).get('value');
import { CLR_SKIP, clrSdk, compileClr } from './fixtures/clr-sdk.mjs';

const id = '11111111-1111-4111-8111-111111111111';
const value = () => ({
  $type: 'Entity',
  logicalName: 'widget',
  id,
  rowVersion: '19',
  keyAttributes: { code: 'one' },
  formattedValues: { cash: 'Exact display' },
  attributes: {
    strings: { $type: 'PrimitiveArray', elementType: 'String', values: ['Retained', null, ''] },
    cash: { $type: 'Money', value: '9007199254740993.250001' },
    choices: { $type: 'OptionSetValueCollection', values: [{ $type: 'OptionSetValue', value: 1 }, null] },
    reference: {
      $type: 'EntityReference',
      logicalName: 'widget',
      id,
      name: 'Reference label',
      keyAttributes: { code: 'one' },
      rowVersion: '17',
    },
    alias: {
      $type: 'AliasedValue',
      entityLogicalName: 'widget',
      attributeLogicalName: 'cash',
      value: { $type: 'Money', value: '0.123456' },
    },
  },
});
test('SOAP final SDK results retain numeric widths and reject ambiguous or unqualified values', () => {
  assert.deepEqual(soapSdkValue(5000000000), { type: 'long', value: 5000000000 });
  assert.deepEqual(soapSdkValue(1), { type: 'int', value: 1 });
  assert.deepEqual(soapSdkValue(1.5), { type: 'double', value: 1.5 });
  for (const invalid of [
    Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    { $type: 'UnlistedClass' },
    { $type: 'PrimitiveArray', elementType: 'Int32', values: [1] },
  ])
    assert.throws(() => soapSdkValue(invalid), { code: 'LocalSoapResultUnsupported' });
  assert.throws(() => soapSdkResults({ BusinessEntity: value(), Entity: value() }, [['BusinessEntity', 'Entity']]), {
    code: 'LocalPluginResponseUnsupported',
  });
  assert.match(encodeValue('b:value', soapSdkValue(value())), /<x9:OptionSetValue i:nil="true"\/>/);
});
test(
  'installed SDK deserializes final SOAP Entity metadata, exact Money, aliases and nullable choice members',
  { skip: CLR_SKIP },
  async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'paq-soap-final-sdk-'));
    try {
      const sdk = clrSdk(),
        source = path.join(root, 'Reader.cs'),
        executable = path.join(root, 'Reader.exe');
      await fs.copyFile(sdk, path.join(root, 'Microsoft.Xrm.Sdk.dll'));
      await fs.writeFile(
        source,
        `using System;using System.Xml;using System.Runtime.Serialization;using Microsoft.Xrm.Sdk;
class Reader {static void Main(){var doc=new XmlDocument();doc.LoadXml(Console.In.ReadToEnd());Entity row;
using(var input=new XmlNodeReader(doc.DocumentElement.FirstChild))row=(Entity)new DataContractSerializer(typeof(Entity)).ReadObject(input,false);
if(row.Id!=new Guid("${id}")||row.RowVersion!="19"||(string)row.KeyAttributes["code"]!="one"||row.FormattedValues["cash"]!="Exact display")throw new Exception("Entity metadata lost");
if(((Money)row["cash"]).Value!=9007199254740993.250001m)throw new Exception("Money rounded through Web API scale");
var strings=(string[])row["strings"];if(strings.Length!=3||strings[0]!="Retained"||strings[1]!=null||strings[2]!="")throw new Exception("String array SDK type lost");
var choices=(OptionSetValueCollection)row["choices"];if(choices.Count!=2||choices[0].Value!=1||choices[1]!=null)throw new Exception("Null collection member lost");
var reference=(EntityReference)row["reference"];if(reference.RowVersion!="17"||reference.Name!="Reference label"||(string)reference.KeyAttributes["code"]!="one")throw new Exception("Reference metadata lost");
var alias=(AliasedValue)row["alias"];if(alias.EntityLogicalName!="widget"||alias.AttributeLogicalName!="cash"||((Money)alias.Value).Value!=0.123456m)throw new Exception("Typed alias lost");Console.Write("observed");}}`,
      );
      compileClr(source, executable, {
        target: 'exe',
        references: [sdk, 'System.Runtime.Serialization.dll', 'System.Xml.dll'],
      });
      const declarations = Object.entries(NS)
        .map(([name, uri]) => `xmlns:${name}="${uri}"`)
        .join(' ');
      const result = spawnSync(executable, [], {
        input: `<root ${declarations}>${encodeValue('b:value', soapSdkValue(value()))}</root>`,
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
      });
      assert.equal(result.status, 0, result.stdout + result.stderr);
      assert.equal(result.stdout, 'observed');
    } finally {
      await fs.rm(root, { recursive: true, force: true, maxRetries: 5 });
    }
  },
);
