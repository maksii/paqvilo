// @parity-evidence: Two independent official Microsoft.Xrm.Sdk DataContractSerializer processes establish the exact namespace URI assertions for the same EntityReference and OrganizationServiceFault inputs.
// @parity-evidence: Reproduced official SDK results and every previously protected SOAP assertion and proof remain bound by the cumulative guard.
// @test-kind compatibility: documented Organization service SOAP/DataContract wire formats (namespaces, member order, faults) from Microsoft SDK docs and samples
import {
  assertAssertionLoopValue as __paqSoapValue,
  assertAssertionLoopCompletion as __paqSoapComplete,
  assertAssertionTailXml as __paqSoapTail,
} from '../../scripts/parity-assertion-loop.mjs';
import { assertSoapParityBindings as __paqSoapBindings } from '../../scripts/qualify-parity.mjs';
const __paqSoapDescriptor = {
  version: 1,
  sourceBinding: 'VALUES',
  loopAstSha256: '2f0055d5fd76f95ddeeea7fabbce3ae5b39eabd58548cc9d0c897f4108a47fc9',
  callbackAstSha256: '644064104a1f0b52e280bd941b1b8cef62de16ffad21d3f36836fbcf68e13888',
  dependencies: [
    { name: 'VALUES', astSha256: '9bdf191e33e967d910f1b4861a32fb1df22564ec47897d5f9093ceb2ea2c6b92' },
    { name: 'text', astSha256: 'af4211b236bfe9789839d5cf4b1d67b70f9a28859c0ad40606b1cde5d4cb3753' },
    { name: 'GUID', astSha256: '45739f219c1596faeae2fb99b5ba4a26e45fcb209b158523e55ba8c4dd8440b2' },
    { name: 'renamed', astSha256: 'ec724e58a7b594adca3f97a70dd20c6711ecfec1409b51aa7075603eb9ec2cbb' },
    { name: 'decodeFrom', astSha256: '3a0416881a2b2d73fc0626c0cda6d2f88f61ccd2b37c1cc7cfa6293e3b2c258c' },
  ],
  universe: [
    [
      'object',
      [
        ['type', ['string', 'string']],
        ['value', ['string', 'a & <b> "c"']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'int']],
        ['value', ['number', '-7']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'long']],
        ['value', ['number', '9007199254740']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'decimal']],
        ['value', ['string', '1234.5600']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'double']],
        ['value', ['number', '2.5']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'double']],
        ['value', ['number', 'Infinity']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'boolean']],
        ['value', ['boolean', false]],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'dateTime']],
        ['value', ['string', '2026-10-19T08:30:00Z']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'guid']],
        ['value', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'base64']],
        ['value', ['string', 'AQID']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'duration']],
        ['value', ['string', 'PT5S']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'EntityReference']],
        ['logicalName', ['string', 'widget']],
        ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
        ['name', ['string', 'Blue']],
        [
          'keyAttributes',
          [
            'map',
            [
              [
                ['string', 'code'],
                [
                  'object',
                  [
                    ['type', ['string', 'string']],
                    ['value', ['string', 'W-1']],
                  ],
                ],
              ],
            ],
          ],
        ],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'EntityReference']],
        ['logicalName', ['string', 'widget']],
        ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
        ['name', ['null']],
        ['keyAttributes', ['map', []]],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'EntityReference']],
        ['logicalName', ['string', 'widget']],
        ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
        ['name', ['null']],
        ['keyAttributes', ['map', []]],
        ['rowVersion', ['null']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'EntityReference']],
        ['logicalName', ['string', 'widget']],
        ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
        ['name', ['null']],
        ['keyAttributes', ['map', []]],
        ['rowVersion', ['string', '17']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'OptionSetValue']],
        ['value', ['number', '2']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'Money']],
        ['value', ['string', '99.9000']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'OptionSetValueCollection']],
        [
          'values',
          [
            'array',
            [
              ['number', '1'],
              ['number', '3'],
            ],
          ],
        ],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'AliasedValue']],
        ['attribute', ['string', 'name']],
        ['entity', ['string', 'widget']],
        [
          'value',
          [
            'object',
            [
              ['type', ['string', 'string']],
              ['value', ['string', 'Blue']],
            ],
          ],
        ],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'Relationship']],
        ['schemaName', ['string', 'widget_gadgets']],
        ['primaryEntityRole', ['string', 'Referenced']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'Entity']],
        ['logicalName', ['string', 'widget']],
        ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
        [
          'attributes',
          [
            'map',
            [
              [
                ['string', 'name'],
                [
                  'object',
                  [
                    ['type', ['string', 'string']],
                    ['value', ['string', 'Blue']],
                  ],
                ],
              ],
              [
                ['string', 'price'],
                [
                  'object',
                  [
                    ['type', ['string', 'Money']],
                    ['value', ['string', '5.0000']],
                  ],
                ],
              ],
            ],
          ],
        ],
        [
          'formattedValues',
          [
            'map',
            [
              [
                ['string', 'price'],
                ['string', '$5.00'],
              ],
            ],
          ],
        ],
        [
          'keyAttributes',
          [
            'map',
            [
              [
                ['string', 'code'],
                [
                  'object',
                  [
                    ['type', ['string', 'string']],
                    ['value', ['string', 'W-1']],
                  ],
                ],
              ],
            ],
          ],
        ],
        ['relatedEntities', ['null']],
        ['rowVersion', ['string', '123']],
        ['entityState', ['null']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'long']],
        ['value', ['string', '9007199254740993']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'ColumnSet']],
        ['allColumns', ['boolean', false]],
        [
          'columns',
          [
            'array',
            [
              ['string', 'name'],
              ['string', 'createdon'],
            ],
          ],
        ],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'ColumnSet']],
        ['allColumns', ['boolean', true]],
        ['columns', ['array', []]],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'EntityReferenceCollection']],
        [
          'values',
          [
            'array',
            [
              [
                'object',
                [
                  ['type', ['string', 'EntityReference']],
                  ['logicalName', ['string', 'widget']],
                  ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
                  ['name', ['string', 'Blue']],
                  ['keyAttributes', ['map', []]],
                ],
              ],
            ],
          ],
        ],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'Entity']],
        ['logicalName', ['string', 'widget']],
        ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
        ['attributes', ['map', []]],
        ['formattedValues', ['map', []]],
        ['keyAttributes', ['map', []]],
        [
          'relatedEntities',
          [
            'array',
            [
              [
                'object',
                [
                  [
                    'relationship',
                    [
                      'object',
                      [
                        ['schemaName', ['string', 'widget_gadgets']],
                        ['primaryEntityRole', ['string', 'Referenced']],
                      ],
                    ],
                  ],
                  [
                    'entities',
                    [
                      'object',
                      [
                        ['type', ['string', 'EntityCollection']],
                        ['entityName', ['string', 'gadget']],
                        ['entities', ['array', []]],
                        ['moreRecords', ['boolean', false]],
                        ['pagingCookie', ['null']],
                        ['totalRecordCount', ['number', '1']],
                        ['totalRecordCountLimitExceeded', ['boolean', false]],
                        ['minActiveRowVersion', ['null']],
                      ],
                    ],
                  ],
                ],
              ],
            ],
          ],
        ],
        ['rowVersion', ['null']],
        ['entityState', ['null']],
      ],
    ],
    [
      'object',
      [
        ['type', ['string', 'EntityCollection']],
        ['entityName', ['string', 'widget']],
        [
          'entities',
          [
            'array',
            [
              [
                'object',
                [
                  ['type', ['string', 'Entity']],
                  ['logicalName', ['string', 'widget']],
                  ['id', ['string', '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f']],
                  [
                    'attributes',
                    [
                      'map',
                      [
                        [
                          ['string', 'name'],
                          [
                            'object',
                            [
                              ['type', ['string', 'string']],
                              ['value', ['string', 'Blue']],
                            ],
                          ],
                        ],
                      ],
                    ],
                  ],
                  ['formattedValues', ['map', []]],
                  ['keyAttributes', ['map', []]],
                  ['relatedEntities', ['null']],
                  ['rowVersion', ['null']],
                  ['entityState', ['null']],
                ],
              ],
            ],
          ],
        ],
        ['moreRecords', ['boolean', true]],
        ['pagingCookie', ['string', '<cookie page="2"/>']],
        ['totalRecordCount', ['number', '12']],
        ['totalRecordCountLimitExceeded', ['boolean', false]],
        ['minActiveRowVersion', ['null']],
      ],
    ],
  ],
  xml: [
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:string">a &amp; &lt;b&gt; &quot;c&quot;</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:int">-7</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:long">9007199254740</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:decimal">1234.5600</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:double">2.5</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:double">INF</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:boolean">false</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:dateTime">2026-10-19T08:30:00Z</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="e:guid">6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:base64Binary">AQID</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="e:duration">PT5S</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:EntityReference"><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes><o:KeyValuePairOfstringanyType><b:key>code</b:key><b:value i:type="c:string">W-1</b:value></o:KeyValuePairOfstringanyType></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name>Blue</a:Name></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:EntityReference"><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:EntityReference"><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/><a:RowVersion i:nil="true"/></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:EntityReference"><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/><a:RowVersion>17</a:RowVersion></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:OptionSetValue"><a:Value>2</a:Value></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:Money"><a:Value i:type="c:decimal">99.9000</a:Value></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="x9:OptionSetValueCollection"><x9:OptionSetValue><a:Value>1</a:Value></x9:OptionSetValue><x9:OptionSetValue><a:Value>3</a:Value></x9:OptionSetValue></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:AliasedValue"><a:AttributeLogicalName>name</a:AttributeLogicalName><a:EntityLogicalName>widget</a:EntityLogicalName><a:Value i:type="c:string">Blue</a:Value></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:Relationship"><a:PrimaryEntityRole>Referenced</a:PrimaryEntityRole><a:SchemaName>widget_gadgets</a:SchemaName></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:Entity"><a:Attributes><a:KeyValuePairOfstringanyType><b:key>name</b:key><b:value i:type="c:string">Blue</b:value></a:KeyValuePairOfstringanyType><a:KeyValuePairOfstringanyType><b:key>price</b:key><b:value i:type="a:Money"><a:Value i:type="c:decimal">5.0000</a:Value></b:value></a:KeyValuePairOfstringanyType></a:Attributes><a:FormattedValues><a:KeyValuePairOfstringstring><b:key>price</b:key><b:value>$5.00</b:value></a:KeyValuePairOfstringstring></a:FormattedValues><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes><o:KeyValuePairOfstringanyType><b:key>code</b:key><b:value i:type="c:string">W-1</b:value></o:KeyValuePairOfstringanyType></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:RowVersion>123</a:RowVersion></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:long">9007199254740993</v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns><f:string>name</f:string><f:string>createdon</f:string></a:Columns></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns></a:Columns></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:EntityReferenceCollection"><a:EntityReference><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name>Blue</a:Name></a:EntityReference></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:Entity"><a:Attributes></a:Attributes><a:FormattedValues></a:FormattedValues><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:RelatedEntities><a:KeyValuePairOfRelationshipEntityCollectionX_PsK4FkN><b:key><a:PrimaryEntityRole>Referenced</a:PrimaryEntityRole><a:SchemaName>widget_gadgets</a:SchemaName></b:key><b:value><a:Entities></a:Entities><a:EntityName>gadget</a:EntityName><a:MoreRecords>false</a:MoreRecords><a:TotalRecordCount>1</a:TotalRecordCount><a:TotalRecordCountLimitExceeded>false</a:TotalRecordCountLimitExceeded></b:value></a:KeyValuePairOfRelationshipEntityCollectionX_PsK4FkN></a:RelatedEntities></v></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="a:EntityCollection"><a:Entities><a:Entity><a:Attributes><a:KeyValuePairOfstringanyType><b:key>name</b:key><b:value i:type="c:string">Blue</b:value></a:KeyValuePairOfstringanyType></a:Attributes><a:FormattedValues></a:FormattedValues><a:Id>6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName></a:Entity></a:Entities><a:EntityName>widget</a:EntityName><a:MoreRecords>true</a:MoreRecords><a:PagingCookie>&lt;cookie page=&quot;2&quot;/&gt;</a:PagingCookie><a:TotalRecordCount>12</a:TotalRecordCount><a:TotalRecordCountLimitExceeded>false</a:TotalRecordCountLimitExceeded></v></s:Body></s:Envelope>',
  ],
  tailXml: [
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:nil="true"/></s:Body></s:Envelope>',
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:svc="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:g="http://schemas.microsoft.com/crm/2011/Contracts" xmlns:l="http://schemas.microsoft.com/xrm/2012/Contracts" xmlns:o="http://schemas.microsoft.com/xrm/7.1/Contracts" xmlns:x9="http://schemas.microsoft.com/xrm/9.0/Contracts" xmlns:x14="http://schemas.microsoft.com/xrm/2014/Contracts" xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic" xmlns:c="http://www.w3.org/2001/XMLSchema" xmlns:e="http://schemas.microsoft.com/2003/10/Serialization/" xmlns:f="http://schemas.microsoft.com/2003/10/Serialization/Arrays" xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><s:Body><v i:type="c:string">plain</v></s:Body></s:Envelope>',
  ],
  selectedIndices: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 13, 14, 15, 16, 17, 18, 19, 21, 22, 23, 25],
  heldIndices: [11, 12, 20, 24, 26],
  assertionAstSha256: [
    '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
    'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
  ],
  tailAstSha256: [
    '1c0606e6798c78454971a454feac0d38bb31f1608cc9729f6a9d641ce800ee70',
    'e42c81015a134f0b01c8a80f981def134214a3c11814b69243740b7ccf54ed7d',
  ],
  instances: [
    {
      originalValueIndex: 0,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 0,
      factIds: ['soap-fact-0'],
    },
    {
      originalValueIndex: 0,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 0,
      factIds: ['soap-fact-1'],
    },
    {
      originalValueIndex: 1,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 1,
      factIds: ['soap-fact-2'],
    },
    {
      originalValueIndex: 1,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 1,
      factIds: ['soap-fact-3'],
    },
    {
      originalValueIndex: 2,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 2,
      factIds: ['soap-fact-4'],
    },
    {
      originalValueIndex: 2,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 2,
      factIds: ['soap-fact-5'],
    },
    {
      originalValueIndex: 3,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 3,
      factIds: ['soap-fact-6'],
    },
    {
      originalValueIndex: 3,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 3,
      factIds: ['soap-fact-7'],
    },
    {
      originalValueIndex: 4,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 4,
      factIds: ['soap-fact-8'],
    },
    {
      originalValueIndex: 4,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 4,
      factIds: ['soap-fact-9'],
    },
    {
      originalValueIndex: 5,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 5,
      factIds: ['soap-fact-10'],
    },
    {
      originalValueIndex: 5,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 5,
      factIds: ['soap-fact-11'],
    },
    {
      originalValueIndex: 6,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 6,
      factIds: ['soap-fact-12'],
    },
    {
      originalValueIndex: 6,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 6,
      factIds: ['soap-fact-13'],
    },
    {
      originalValueIndex: 7,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 7,
      factIds: ['soap-fact-14'],
    },
    {
      originalValueIndex: 7,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 7,
      factIds: ['soap-fact-15'],
    },
    {
      originalValueIndex: 8,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 8,
      factIds: ['soap-fact-16'],
    },
    {
      originalValueIndex: 8,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 8,
      factIds: ['soap-fact-17'],
    },
    {
      originalValueIndex: 9,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 9,
      factIds: ['soap-fact-18'],
    },
    {
      originalValueIndex: 9,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 9,
      factIds: ['soap-fact-19'],
    },
    {
      originalValueIndex: 10,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 10,
      factIds: ['soap-fact-20'],
    },
    {
      originalValueIndex: 10,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 10,
      factIds: ['soap-fact-21'],
    },
    {
      originalValueIndex: 13,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 13,
      factIds: ['soap-fact-22'],
    },
    {
      originalValueIndex: 13,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 13,
      factIds: ['soap-fact-23'],
    },
    {
      originalValueIndex: 14,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 14,
      factIds: ['soap-fact-24'],
    },
    {
      originalValueIndex: 14,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 14,
      factIds: ['soap-fact-25'],
    },
    {
      originalValueIndex: 15,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 15,
      factIds: ['soap-fact-26'],
    },
    {
      originalValueIndex: 15,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 15,
      factIds: ['soap-fact-27'],
    },
    {
      originalValueIndex: 16,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 16,
      factIds: ['soap-fact-28'],
    },
    {
      originalValueIndex: 16,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 16,
      factIds: ['soap-fact-29'],
    },
    {
      originalValueIndex: 17,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 17,
      factIds: ['soap-fact-30'],
    },
    {
      originalValueIndex: 17,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 17,
      factIds: ['soap-fact-31'],
    },
    {
      originalValueIndex: 18,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 18,
      factIds: ['soap-fact-32'],
    },
    {
      originalValueIndex: 18,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 18,
      factIds: ['soap-fact-33'],
    },
    {
      originalValueIndex: 19,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 19,
      factIds: ['soap-fact-34'],
    },
    {
      originalValueIndex: 19,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 19,
      factIds: ['soap-fact-35'],
    },
    {
      originalValueIndex: 21,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 21,
      factIds: ['soap-fact-36'],
    },
    {
      originalValueIndex: 21,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 21,
      factIds: ['soap-fact-37'],
    },
    {
      originalValueIndex: 22,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 22,
      factIds: ['soap-fact-38'],
    },
    {
      originalValueIndex: 22,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 22,
      factIds: ['soap-fact-39'],
    },
    {
      originalValueIndex: 23,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 23,
      factIds: ['soap-fact-40'],
    },
    {
      originalValueIndex: 23,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 23,
      factIds: ['soap-fact-41'],
    },
    {
      originalValueIndex: 25,
      assertionAstSha256: '7ef0fc7a9a28a551a9c0787eca59ba24ad53ba8b3ad0d90d436dc9f31c8995fb',
      variant: 'direct',
      caseIndex: 25,
      factIds: ['soap-fact-44'],
    },
    {
      originalValueIndex: 25,
      assertionAstSha256: 'b13ec193c1930d0c9cd50d050e117d383fb4ece610c83c89736f79ec47d7a8e4',
      variant: 'renamed',
      caseIndex: 25,
      factIds: ['soap-fact-45'],
    },
    {
      originalValueIndex: null,
      assertionAstSha256: '1c0606e6798c78454971a454feac0d38bb31f1608cc9729f6a9d641ce800ee70',
      variant: 'direct',
      caseIndex: 27,
      factIds: ['soap-fact-42'],
    },
    {
      originalValueIndex: null,
      assertionAstSha256: 'e42c81015a134f0b01c8a80f981def134214a3c11814b69243740b7ccf54ed7d',
      variant: 'direct',
      caseIndex: 28,
      factIds: ['soap-fact-43'],
    },
  ],
};
__paqSoapBindings(import.meta.url, [
  {
    kind: 'soap-assertion-loop-v1',
    repositoryRoot: '../..',
    sourceAstSha256: 'd72a55685a82aa1ace8e4b0b535a1d64b3f14d9ebad71a227c73452a3a0496d3',
    loopDescriptorSha256: '28ecc84cabacb8970bc911f9383e95304758e58c2037e76ef6e76e6d306b2754',
    helperSha256: 'cce389a6db4c1cf9d57683cba2bfd9fd82e50f0a27f80f2d2420a25f11b075a7',
    proofs: [
      {
        path: 'mirage/test/fixtures/dataverse-soap-sdk-interop-20261109.json',
        sha256: 'e741418ee71a1a70eb92493569c8bf4f2606fb16990ed0ecee319b9b20271ea2',
        mode: 'official-package',
        capturePointers: ['/runs/0/rawSha256', '/runs/1/rawSha256'],
        package: {
          id: 'Microsoft.CrmSdk.CoreAssemblies',
          version: '9.0.2.60',
          sha256: '59650574cdc89c1f506fabd7275fe6325a59a8bae9fa9f92c5b5c2cbe31d5e1f',
          source:
            'https://api.nuget.org/v3-flatcontainer/microsoft.crmsdk.coreassemblies/9.0.2.60/microsoft.crmsdk.coreassemblies.9.0.2.60.nupkg',
          signatureVerified: false,
        },
        packagePointer: '/package',
        facts: [
          {
            id: 'soap-fact-0',
            pointer: '/runs/0/results/0/direct',
            sha256: 'f0df88c4ac96198676ce4d84efb7cf683bcd8e85de86b0b419e7d0d05183f0a7',
            replicatedPointers: ['/runs/0/results/0/direct', '/runs/1/results/0/direct'],
          },
          {
            id: 'soap-fact-1',
            pointer: '/runs/0/results/0/renamed',
            sha256: 'f0df88c4ac96198676ce4d84efb7cf683bcd8e85de86b0b419e7d0d05183f0a7',
            replicatedPointers: ['/runs/0/results/0/renamed', '/runs/1/results/0/renamed'],
          },
          {
            id: 'soap-fact-2',
            pointer: '/runs/0/results/1/direct',
            sha256: 'd5c7a9248d213614da270bb20e145cb1b20862bf425bbd511b10439b9a14d8b7',
            replicatedPointers: ['/runs/0/results/1/direct', '/runs/1/results/1/direct'],
          },
          {
            id: 'soap-fact-3',
            pointer: '/runs/0/results/1/renamed',
            sha256: 'd5c7a9248d213614da270bb20e145cb1b20862bf425bbd511b10439b9a14d8b7',
            replicatedPointers: ['/runs/0/results/1/renamed', '/runs/1/results/1/renamed'],
          },
          {
            id: 'soap-fact-4',
            pointer: '/runs/0/results/2/direct',
            sha256: '8e2a672b7a0192e3ae2db5187af1105157e0d190b5ed4e55c87857c21b64607c',
            replicatedPointers: ['/runs/0/results/2/direct', '/runs/1/results/2/direct'],
          },
          {
            id: 'soap-fact-5',
            pointer: '/runs/0/results/2/renamed',
            sha256: '8e2a672b7a0192e3ae2db5187af1105157e0d190b5ed4e55c87857c21b64607c',
            replicatedPointers: ['/runs/0/results/2/renamed', '/runs/1/results/2/renamed'],
          },
          {
            id: 'soap-fact-6',
            pointer: '/runs/0/results/3/direct',
            sha256: 'baf6aba243b7626ad432c73f412cf1c0a1753052ba08612b2680ab76a6d39da4',
            replicatedPointers: ['/runs/0/results/3/direct', '/runs/1/results/3/direct'],
          },
          {
            id: 'soap-fact-7',
            pointer: '/runs/0/results/3/renamed',
            sha256: 'baf6aba243b7626ad432c73f412cf1c0a1753052ba08612b2680ab76a6d39da4',
            replicatedPointers: ['/runs/0/results/3/renamed', '/runs/1/results/3/renamed'],
          },
          {
            id: 'soap-fact-8',
            pointer: '/runs/0/results/4/direct',
            sha256: '4451dc1fe4047998766d3471b32f9696f1e023c72a2810cd4bcc97858dc7d1da',
            replicatedPointers: ['/runs/0/results/4/direct', '/runs/1/results/4/direct'],
          },
          {
            id: 'soap-fact-9',
            pointer: '/runs/0/results/4/renamed',
            sha256: '4451dc1fe4047998766d3471b32f9696f1e023c72a2810cd4bcc97858dc7d1da',
            replicatedPointers: ['/runs/0/results/4/renamed', '/runs/1/results/4/renamed'],
          },
          {
            id: 'soap-fact-10',
            pointer: '/runs/0/results/5/direct',
            sha256: '38c5f72ae4257e9979d5194f43f0c3fe895d494f7ae3667983ded0ec9a2ac254',
            replicatedPointers: ['/runs/0/results/5/direct', '/runs/1/results/5/direct'],
          },
          {
            id: 'soap-fact-11',
            pointer: '/runs/0/results/5/renamed',
            sha256: '38c5f72ae4257e9979d5194f43f0c3fe895d494f7ae3667983ded0ec9a2ac254',
            replicatedPointers: ['/runs/0/results/5/renamed', '/runs/1/results/5/renamed'],
          },
          {
            id: 'soap-fact-12',
            pointer: '/runs/0/results/6/direct',
            sha256: 'd4575a718739ffc2083aa6935c0ab7d74941e4dcbec182fb95b2cdf8407ad468',
            replicatedPointers: ['/runs/0/results/6/direct', '/runs/1/results/6/direct'],
          },
          {
            id: 'soap-fact-13',
            pointer: '/runs/0/results/6/renamed',
            sha256: 'd4575a718739ffc2083aa6935c0ab7d74941e4dcbec182fb95b2cdf8407ad468',
            replicatedPointers: ['/runs/0/results/6/renamed', '/runs/1/results/6/renamed'],
          },
          {
            id: 'soap-fact-14',
            pointer: '/runs/0/results/7/direct',
            sha256: '03007a4979818346ec2bdfa07ff7c9a153793a9487307e3555ea9d4e30ad382a',
            replicatedPointers: ['/runs/0/results/7/direct', '/runs/1/results/7/direct'],
          },
          {
            id: 'soap-fact-15',
            pointer: '/runs/0/results/7/renamed',
            sha256: '03007a4979818346ec2bdfa07ff7c9a153793a9487307e3555ea9d4e30ad382a',
            replicatedPointers: ['/runs/0/results/7/renamed', '/runs/1/results/7/renamed'],
          },
          {
            id: 'soap-fact-16',
            pointer: '/runs/0/results/8/direct',
            sha256: '088eb760474f88b84c6d8ac8c9baeff5b5be4349745b7d7e2b4c23878f5e4dc9',
            replicatedPointers: ['/runs/0/results/8/direct', '/runs/1/results/8/direct'],
          },
          {
            id: 'soap-fact-17',
            pointer: '/runs/0/results/8/renamed',
            sha256: '088eb760474f88b84c6d8ac8c9baeff5b5be4349745b7d7e2b4c23878f5e4dc9',
            replicatedPointers: ['/runs/0/results/8/renamed', '/runs/1/results/8/renamed'],
          },
          {
            id: 'soap-fact-18',
            pointer: '/runs/0/results/9/direct',
            sha256: '1ef5a43a235cc37aaee3e694a36af2b3a5c8a8b43f2eddf5ad8afe835939d80b',
            replicatedPointers: ['/runs/0/results/9/direct', '/runs/1/results/9/direct'],
          },
          {
            id: 'soap-fact-19',
            pointer: '/runs/0/results/9/renamed',
            sha256: '1ef5a43a235cc37aaee3e694a36af2b3a5c8a8b43f2eddf5ad8afe835939d80b',
            replicatedPointers: ['/runs/0/results/9/renamed', '/runs/1/results/9/renamed'],
          },
          {
            id: 'soap-fact-20',
            pointer: '/runs/0/results/10/direct',
            sha256: '1165766099731e9c5de4ecb08944c62fc8e4e83ab10c0fa08456e62c400cd39f',
            replicatedPointers: ['/runs/0/results/10/direct', '/runs/1/results/10/direct'],
          },
          {
            id: 'soap-fact-21',
            pointer: '/runs/0/results/10/renamed',
            sha256: '1165766099731e9c5de4ecb08944c62fc8e4e83ab10c0fa08456e62c400cd39f',
            replicatedPointers: ['/runs/0/results/10/renamed', '/runs/1/results/10/renamed'],
          },
          {
            id: 'soap-fact-22',
            pointer: '/runs/0/results/13/direct',
            sha256: '24f9867a0086f92acc3003bb2092f4c405f4a8bf0fc16b3091bf6f5a1f0228d1',
            replicatedPointers: ['/runs/0/results/13/direct', '/runs/1/results/13/direct'],
          },
          {
            id: 'soap-fact-23',
            pointer: '/runs/0/results/13/renamed',
            sha256: '24f9867a0086f92acc3003bb2092f4c405f4a8bf0fc16b3091bf6f5a1f0228d1',
            replicatedPointers: ['/runs/0/results/13/renamed', '/runs/1/results/13/renamed'],
          },
          {
            id: 'soap-fact-24',
            pointer: '/runs/0/results/14/direct',
            sha256: '72c745f1286836b414a161d1da61963116264ac046dc5cf78317668c7532bd5d',
            replicatedPointers: ['/runs/0/results/14/direct', '/runs/1/results/14/direct'],
          },
          {
            id: 'soap-fact-25',
            pointer: '/runs/0/results/14/renamed',
            sha256: '72c745f1286836b414a161d1da61963116264ac046dc5cf78317668c7532bd5d',
            replicatedPointers: ['/runs/0/results/14/renamed', '/runs/1/results/14/renamed'],
          },
          {
            id: 'soap-fact-26',
            pointer: '/runs/0/results/15/direct',
            sha256: 'bbfd96ff3bdcad549b495566c24a6fbaa0f5aa0c47e81dc295db471b2aa9e443',
            replicatedPointers: ['/runs/0/results/15/direct', '/runs/1/results/15/direct'],
          },
          {
            id: 'soap-fact-27',
            pointer: '/runs/0/results/15/renamed',
            sha256: 'bbfd96ff3bdcad549b495566c24a6fbaa0f5aa0c47e81dc295db471b2aa9e443',
            replicatedPointers: ['/runs/0/results/15/renamed', '/runs/1/results/15/renamed'],
          },
          {
            id: 'soap-fact-28',
            pointer: '/runs/0/results/16/direct',
            sha256: '9dc66e3dd6749b705096b4566260a32b0c350300fc1e0f7556168c2bf18a11d1',
            replicatedPointers: ['/runs/0/results/16/direct', '/runs/1/results/16/direct'],
          },
          {
            id: 'soap-fact-29',
            pointer: '/runs/0/results/16/renamed',
            sha256: '9dc66e3dd6749b705096b4566260a32b0c350300fc1e0f7556168c2bf18a11d1',
            replicatedPointers: ['/runs/0/results/16/renamed', '/runs/1/results/16/renamed'],
          },
          {
            id: 'soap-fact-30',
            pointer: '/runs/0/results/17/direct',
            sha256: '8e05fa735ed9f1482eaccec0910750be1dfc70b878a04e1328d84bdf2907cd3f',
            replicatedPointers: ['/runs/0/results/17/direct', '/runs/1/results/17/direct'],
          },
          {
            id: 'soap-fact-31',
            pointer: '/runs/0/results/17/renamed',
            sha256: '8e05fa735ed9f1482eaccec0910750be1dfc70b878a04e1328d84bdf2907cd3f',
            replicatedPointers: ['/runs/0/results/17/renamed', '/runs/1/results/17/renamed'],
          },
          {
            id: 'soap-fact-32',
            pointer: '/runs/0/results/18/direct',
            sha256: 'd07f2cd81aa26d1046d1984d18fd57872e41a689a3ba83d8c303a92c2986271e',
            replicatedPointers: ['/runs/0/results/18/direct', '/runs/1/results/18/direct'],
          },
          {
            id: 'soap-fact-33',
            pointer: '/runs/0/results/18/renamed',
            sha256: 'd07f2cd81aa26d1046d1984d18fd57872e41a689a3ba83d8c303a92c2986271e',
            replicatedPointers: ['/runs/0/results/18/renamed', '/runs/1/results/18/renamed'],
          },
          {
            id: 'soap-fact-34',
            pointer: '/runs/0/results/19/direct',
            sha256: '844fcf3028815e9cd9c5f14e418d6d7ba5d6cc397ef3889f1da046625246bea3',
            replicatedPointers: ['/runs/0/results/19/direct', '/runs/1/results/19/direct'],
          },
          {
            id: 'soap-fact-35',
            pointer: '/runs/0/results/19/renamed',
            sha256: '844fcf3028815e9cd9c5f14e418d6d7ba5d6cc397ef3889f1da046625246bea3',
            replicatedPointers: ['/runs/0/results/19/renamed', '/runs/1/results/19/renamed'],
          },
          {
            id: 'soap-fact-36',
            pointer: '/runs/0/results/21/direct',
            sha256: '2e4afa7d58ce222da36fb8f4fd78176df2e195092c67786e0aeb18039a007e1b',
            replicatedPointers: ['/runs/0/results/21/direct', '/runs/1/results/21/direct'],
          },
          {
            id: 'soap-fact-37',
            pointer: '/runs/0/results/21/renamed',
            sha256: '2e4afa7d58ce222da36fb8f4fd78176df2e195092c67786e0aeb18039a007e1b',
            replicatedPointers: ['/runs/0/results/21/renamed', '/runs/1/results/21/renamed'],
          },
          {
            id: 'soap-fact-38',
            pointer: '/runs/0/results/22/direct',
            sha256: '301f02e9b0d04866a5036ea4cf7418334cf3a557f0d91edce80178092020e7ad',
            replicatedPointers: ['/runs/0/results/22/direct', '/runs/1/results/22/direct'],
          },
          {
            id: 'soap-fact-39',
            pointer: '/runs/0/results/22/renamed',
            sha256: '301f02e9b0d04866a5036ea4cf7418334cf3a557f0d91edce80178092020e7ad',
            replicatedPointers: ['/runs/0/results/22/renamed', '/runs/1/results/22/renamed'],
          },
          {
            id: 'soap-fact-40',
            pointer: '/runs/0/results/23/direct',
            sha256: '02e81e04915f0dd0d03882fb326ec05a858176e3509d5b45533f05e882b82bd7',
            replicatedPointers: ['/runs/0/results/23/direct', '/runs/1/results/23/direct'],
          },
          {
            id: 'soap-fact-41',
            pointer: '/runs/0/results/23/renamed',
            sha256: '02e81e04915f0dd0d03882fb326ec05a858176e3509d5b45533f05e882b82bd7',
            replicatedPointers: ['/runs/0/results/23/renamed', '/runs/1/results/23/renamed'],
          },
          {
            id: 'soap-fact-42',
            pointer: '/runs/0/results/27/direct',
            sha256: 'f75ba73e190a51ef6f01edf44da0a8a95a4d30816d71983b23f52ce95471ff16',
            replicatedPointers: ['/runs/0/results/27/direct', '/runs/1/results/27/direct'],
          },
          {
            id: 'soap-fact-43',
            pointer: '/runs/0/results/28/direct',
            sha256: 'fbad148f288c9336ae8104baaa3da98c8f7c330de74d7b7f34e7cd9c3416a72f',
            replicatedPointers: ['/runs/0/results/28/direct', '/runs/1/results/28/direct'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/dataverse-soap-sdk-interop-46-candidate.json',
        sha256: '39bf05aaa833e7ab069421550354748bae1a78a8e639048b3521b3a2345f8645',
        mode: 'official-package',
        capturePointers: ['/runs/0/rawSha256', '/runs/1/rawSha256'],
        package: {
          id: 'Microsoft.CrmSdk.CoreAssemblies',
          version: '9.0.2.60',
          sha256: '59650574cdc89c1f506fabd7275fe6325a59a8bae9fa9f92c5b5c2cbe31d5e1f',
          source:
            'https://api.nuget.org/v3-flatcontainer/microsoft.crmsdk.coreassemblies/9.0.2.60/microsoft.crmsdk.coreassemblies.9.0.2.60.nupkg',
          signatureVerified: false,
        },
        packagePointer: '/package',
        facts: [
          {
            id: 'soap-fact-44',
            pointer: '/runs/0/results/25/direct',
            sha256: '28101968a0d8300e8c320b669d9172e0bece090b6e0db90fb1a6356b37785f87',
            replicatedPointers: ['/runs/0/results/25/direct', '/runs/1/results/25/direct'],
          },
          {
            id: 'soap-fact-45',
            pointer: '/runs/0/results/25/renamed',
            sha256: '28101968a0d8300e8c320b669d9172e0bece090b6e0db90fb1a6356b37785f87',
            replicatedPointers: ['/runs/0/results/25/renamed', '/runs/1/results/25/renamed'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/dataverse-soap-sdk-namespaces-20261109.json',
        sha256: '7318e8dd833cc842738f49b40aede8b7f5236a9bd37490ae3b13b88206ca45b6',
        mode: 'official-package',
        package: {
          id: 'Microsoft.CrmSdk.CoreAssemblies',
          version: '9.0.2.60',
          source:
            'https://api.nuget.org/v3-flatcontainer/microsoft.crmsdk.coreassemblies/9.0.2.60/microsoft.crmsdk.coreassemblies.9.0.2.60.nupkg',
          sha256: '59650574cdc89c1f506fabd7275fe6325a59a8bae9fa9f92c5b5c2cbe31d5e1f',
          signatureVerified: false,
        },
        packagePointer: '/package',
        capturePointers: ['/runs/0/rawSha256', '/runs/1/rawSha256'],
        facts: [
          {
            id: 'sdk-namespace-0',
            pointer: '/runs/0/facts/0/namespace',
            sha256: '3e6f50f8a33461976eed3a262b75f601e1fbf6447efa58292ec64db4db8b56ea',
            replicatedPointers: ['/runs/0/facts/0/namespace', '/runs/1/facts/0/namespace'],
          },
          {
            id: 'sdk-namespace-1',
            pointer: '/runs/0/facts/1/namespace',
            sha256: '8a86fb7ff6b66a7d30f468dab5ccb6c31e63312efa28ac5f6b388362d2db8fe3',
            replicatedPointers: ['/runs/0/facts/1/namespace', '/runs/1/facts/1/namespace'],
          },
        ],
      },
    ],
    namespaceRegions: [
      {
        baselineId: 'mirage/test/dataverse-soap-xml.test.mjs:373:0',
        baselineCommit: '1171cccc8baed9218f7fd7689afae4abdc89252b',
        baselineSourceSha256: 'f9714a545510a9a6eeec463c04d866cbd42015f8acafef5f48e5f0f4c32440cf',
        titleExpressionSha256: 'e26030c0abbee5be6f3ea4def890ad49bdcc0bfdd3ea0027bb2b8d86978c8bcb',
        originalBodyAstSha256: '4c89f56be7a894fe060c8e56595f7d493e1d68e6c73b60c1f783ef658e5a01c3',
        assertionSha256: '2df51c4149a6ac649b74ca40f5905e489942cabde557dd836378c0d09d7b1c4d',
        factId: 'sdk-namespace-0',
        namespace: 'http://schemas.microsoft.com/xrm/7.1/Contracts',
      },
      {
        baselineId: 'mirage/test/dataverse-soap-xml.test.mjs:386:0',
        baselineCommit: '1171cccc8baed9218f7fd7689afae4abdc89252b',
        baselineSourceSha256: 'f9714a545510a9a6eeec463c04d866cbd42015f8acafef5f48e5f0f4c32440cf',
        titleExpressionSha256: '03dba7815e2631315d7904e13da519e0dde0e90cb2bc8bd94c8d7531819cd26e',
        originalBodyAstSha256: 'ae16a6b15bf509736b1ca6eab69bf8c914304c4bd11267b8a52dde70633a8170',
        assertionSha256: 'cf06fb5fed196f64bc9abc4407f53ad6d68938b6ea23274a79798e857db8caf1',
        factId: 'sdk-namespace-1',
        namespace: 'http://schemas.microsoft.com/xrm/2011/Contracts',
      },
    ],
  },
]);
import { assertSoapNamespaceProof as __paqSoapNamespaceProof } from '../../scripts/qualify-parity.mjs';

// @parity-evidence: Microsoft.CrmSdk.CoreAssemblies 9.0.2.60 writes and reads the corrected held Entity related-graph XML; the 44 previously selected assertion inputs and bindings are unchanged.

// Dataverse SOAP XML codec: namespace-aware parsing, value round trips, envelopes, faults.
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataError } from '../lib/data-error.mjs';
import {
  NS,
  decodePairs,
  decodeValue,
  encodeValue,
  envelope,
  executeResponse,
  fault,
  parseEnvelope,
  parseOrganizationRequest,
  parseXml,
} from '../lib/dataverse-soap-xml.mjs';

const GUID = '6f1d7c1e-2b3a-4c5d-8e9f-0a1b2c3d4e5f';
const USER = 'aaaaaaaa-0000-4000-8000-000000000001';
const BUSINESS_UNIT = 'aaaaaaaa-0000-4000-8000-000000000002';
const text = (value) => ({ type: 'string', value });

// Every prefix in encoded XML is renamed, so decoding must rely on namespace URIs only.
// The lookaheads leave xmlns:xml, xml:lang and http(s) URI text alone.
const renamed = (xml) =>
  xml
    .replace(/xmlns:([a-z0-9]+)=/g, 'xmlns:p$1=')
    .replace(/(?<=[<\s"/])(?!xmlns:|xml:|https?:)([a-z0-9]+)(?=:)/g, 'p$1');

const decodeFrom = (xml) => decodeValue(parseEnvelope(xml).request);
const byName = (node, name) => node.children.find((c) => c.name === name);

const VALUES = [
  text('a & <b> "c"'),
  { type: 'int', value: -7 },
  { type: 'long', value: 9007199254740 },
  { type: 'decimal', value: '1234.5600' },
  { type: 'double', value: 2.5 },
  { type: 'double', value: Infinity },
  { type: 'boolean', value: false },
  { type: 'dateTime', value: '2026-10-19T08:30:00Z' },
  { type: 'guid', value: GUID },
  { type: 'base64', value: 'AQID' },
  { type: 'duration', value: 'PT5S' },
  {
    type: 'EntityReference',
    logicalName: 'widget',
    id: GUID,
    name: 'Blue',
    keyAttributes: new Map([['code', text('W-1')]]),
  },
  { type: 'EntityReference', logicalName: 'widget', id: GUID, name: null, keyAttributes: new Map() },
  ...[null, '17'].map((rowVersion) => ({
    type: 'EntityReference',
    logicalName: 'widget',
    id: GUID,
    name: null,
    keyAttributes: new Map(),
    rowVersion,
  })),
  { type: 'OptionSetValue', value: 2 },
  { type: 'Money', value: '99.9000' }, // four-digit exact scale on the wire and after decode
  { type: 'OptionSetValueCollection', values: [1, 3] },
  { type: 'AliasedValue', attribute: 'name', entity: 'widget', value: text('Blue') },
  { type: 'Relationship', schemaName: 'widget_gadgets', primaryEntityRole: 'Referenced' },
  {
    type: 'Entity',
    logicalName: 'widget',
    id: GUID,
    attributes: new Map([
      ['name', text('Blue')],
      ['price', { type: 'Money', value: '5.0000' }],
    ]),
    formattedValues: new Map([['price', '$5.00']]),
    keyAttributes: new Map([['code', text('W-1')]]),
    relatedEntities: null,
    rowVersion: '123',
    entityState: null,
  },
  { type: 'long', value: '9007199254740993' },
  { type: 'ColumnSet', allColumns: false, columns: ['name', 'createdon'] },
  { type: 'ColumnSet', allColumns: true, columns: [] },
  {
    type: 'EntityReferenceCollection',
    values: [{ type: 'EntityReference', logicalName: 'widget', id: GUID, name: 'Blue', keyAttributes: new Map() }],
  },
  {
    type: 'Entity',
    logicalName: 'widget',
    id: GUID,
    attributes: new Map(),
    formattedValues: new Map(),
    keyAttributes: new Map(),
    relatedEntities: [
      {
        relationship: { schemaName: 'widget_gadgets', primaryEntityRole: 'Referenced' },
        entities: {
          type: 'EntityCollection',
          entityName: 'gadget',
          entities: [],
          moreRecords: false,
          pagingCookie: null,
          totalRecordCount: 1,
          totalRecordCountLimitExceeded: false,
          minActiveRowVersion: null,
        },
      },
    ],
    rowVersion: null,
    entityState: null,
  },
  {
    type: 'EntityCollection',
    entityName: 'widget',
    entities: [
      {
        type: 'Entity',
        logicalName: 'widget',
        id: GUID,
        attributes: new Map([['name', text('Blue')]]),
        formattedValues: new Map(),
        keyAttributes: new Map(),
        relatedEntities: null,
        rowVersion: null,
        entityState: null,
      },
    ],
    moreRecords: true,
    pagingCookie: '<cookie page="2"/>',
    totalRecordCount: 12,
    totalRecordCountLimitExceeded: false,
    minActiveRowVersion: null,
  },
];

test('every value type round-trips with canonical and arbitrary prefixes', () => {
  let __paqSoapIndex = 0;
  for (const value of VALUES) {
    const xml = envelope(encodeValue('v', value));
    __paqSoapValue(VALUES, __paqSoapIndex++, value, xml, __paqSoapDescriptor);

    assert.deepStrictEqual(decodeFrom(xml), value, `direct ${value.type}`);
    assert.deepStrictEqual(decodeFrom(renamed(xml)), value, `renamed ${value.type}`);
  }
  __paqSoapComplete(__paqSoapIndex, __paqSoapDescriptor);

  assert.equal(decodeFrom(__paqSoapTail(envelope(encodeValue('v', null)), 0, __paqSoapDescriptor)), null);
  assert.deepStrictEqual(
    decodeFrom(__paqSoapTail(envelope(encodeValue('v', 'plain')), 1, __paqSoapDescriptor)),
    text('plain'),
  );
});

test('i:type and element names resolve by namespace URI, not prefix', () => {
  // The prefix "zz" is bound to the XML Schema URI, so this is a string.
  const bound = `<s:Envelope xmlns:s="${NS.s}"><s:Body><v xmlns:i="${NS.i}" xmlns:zz="${NS.c}" i:type="zz:string">hi</v></s:Body></s:Envelope>`;
  assert.deepStrictEqual(decodeFrom(bound), text('hi'));
  // The prefix "c" is bound to another URI, so the same spelling is not a known type.
  const other = `<s:Envelope xmlns:s="${NS.s}"><s:Body><v xmlns:i="${NS.i}" xmlns:c="http://example.test/other" i:type="c:string">hi</v></s:Body></s:Envelope>`;
  const raw = decodeFrom(other);
  assert.equal(raw.type, 'Raw');
  assert.deepStrictEqual(raw.qname, { ns: 'http://example.test/other', name: 'string' });
});

test('comments, processing instructions and CDATA are handled', () => {
  const doc = parseXml('<?xml version="1.0"?>\n<!-- note --><r a="1 &amp; 2"><![CDATA[x<y & z]]></r>');
  assert.equal(doc.name, 'r');
  assert.equal(doc.text, 'x<y & z');
  assert.equal(doc.attrs[0].value, '1 & 2');
});

test('https:// namespace forms from Microsoft samples are accepted', () => {
  const whoAmI = whoAmIRequest().replaceAll('http://', 'https://');
  const { operation, request } = parseEnvelope(whoAmI);
  assert.equal(operation, 'Execute');
  assert.equal(parseOrganizationRequest(request).requestName, 'WhoAmI');
});

// @test-kind security: XML hardening: DTDs, unbalanced tags and undeclared prefixes are refused
test('DTDs, unbalanced tags and undeclared prefixes throw DataError 400', () => {
  for (const bad of ["<!DOCTYPE x [<!ENTITY y 'z'>]><x/>", '<a><b></a>', '<p:a xmlns:q="urn:x"/>']) {
    assert.throws(
      () => parseXml(bad),
      (error) => error instanceof DataError && error.status === 400,
      bad,
    );
  }
});

function whoAmIRequest() {
  return (
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>' +
    '<Execute xmlns="http://schemas.microsoft.com/xrm/2011/Contracts/Services" xmlns:i="http://www.w3.org/2001/XMLSchema-instance">' +
    '<request i:type="b:WhoAmIRequest" xmlns:a="http://schemas.microsoft.com/xrm/2011/Contracts" xmlns:b="http://schemas.microsoft.com/crm/2011/Contracts">' +
    '<a:Parameters xmlns:c="http://schemas.datacontract.org/2004/07/System.Collections.Generic" />' +
    '<a:RequestId i:nil="true" /><a:RequestName>WhoAmI</a:RequestName>' +
    '</request></Execute></s:Body></s:Envelope>'
  );
}

test('WhoAmI request decodes to its request name, type and empty parameters', () => {
  const { headers, operation, request } = parseEnvelope(whoAmIRequest());
  assert.deepStrictEqual(headers, {});
  assert.equal(operation, 'Execute');
  assert.deepStrictEqual(parseOrganizationRequest(request), {
    requestName: 'WhoAmI',
    requestType: 'WhoAmIRequest',
    requestId: null,
    parameters: new Map(),
  });
});

test('WhoAmI response carries the g: response type and typed guid results', () => {
  const body = executeResponse({
    responseType: 'WhoAmIResponse',
    namespace: NS.g,
    responseName: 'WhoAmI',
    results: new Map([
      ['UserId', { type: 'guid', value: USER }],
      ['BusinessUnitId', { type: 'guid', value: BUSINESS_UNIT }],
      ['OrganizationId', { type: 'guid', value: GUID }],
    ]),
  });
  const xml = envelope(body);
  const { operation, request } = parseEnvelope(xml);
  assert.equal(operation, 'ExecuteResponse');
  const result = byName(request, 'ExecuteResult');
  assert.equal(result.attrs.find((a) => a.name === 'type').value, 'r:WhoAmIResponse');
  assert.equal(result.scope.get('r'), NS.g);
  assert.equal(byName(result, 'ResponseName').text, 'WhoAmI');
  assert.deepStrictEqual(
    decodePairs(byName(result, 'Results')),
    new Map([
      ['UserId', { type: 'guid', value: USER }],
      ['BusinessUnitId', { type: 'guid', value: BUSINESS_UNIT }],
      ['OrganizationId', { type: 'guid', value: GUID }],
    ]),
  );
  assert.equal(parseEnvelope(renamed(xml)).operation, 'ExecuteResponse');
});

test('Entity members are emitted in DataContract order', () => {
  const xml = encodeValue('v', {
    type: 'Entity',
    logicalName: 'widget',
    id: GUID,
    attributes: new Map([['name', text('Blue')]]),
    formattedValues: new Map([['name', 'Blue']]),
    keyAttributes: new Map([['code', text('W-1')]]),
    relatedEntities: [],
    rowVersion: '1',
    entityState: 'Created',
  });
  const order = [
    '<a:Attributes',
    '<a:EntityState',
    '<a:FormattedValues',
    '<a:Id',
    '<a:KeyAttributes',
    '<a:LogicalName',
    '<a:RelatedEntities',
    '<a:RowVersion',
  ];
  const positions = order.map((marker) => xml.indexOf(marker));
  assert.ok(
    positions.every((p) => p >= 0),
    `missing member in ${xml}`,
  );
  assert.deepStrictEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
});

test('EntityCollection members are emitted in DataContract order', () => {
  const xml = encodeValue('v', {
    type: 'EntityCollection',
    entityName: 'widget',
    entities: [],
    moreRecords: true,
    pagingCookie: '<c/>',
    totalRecordCount: 3,
    totalRecordCountLimitExceeded: false,
    minActiveRowVersion: '9',
  });
  const order = [
    '<a:Entities>',
    '<a:EntityName>',
    '<a:MinActiveRowVersion>',
    '<a:MoreRecords>',
    '<a:PagingCookie>',
    '<a:TotalRecordCount>',
    '<a:TotalRecordCountLimitExceeded>',
  ];
  const positions = order.map((marker) => xml.indexOf(marker));
  assert.ok(
    positions.every((p) => p >= 0),
    `missing member in ${xml}`,
  );
  assert.deepStrictEqual(
    positions,
    [...positions].sort((a, b) => a - b),
  );
});

test('OrganizationServiceFault has the documented shape', () => {
  const xml = fault({
    errorCode: -2147220969,
    message: 'Account With Id = 0 Does Not Exist',
    timestamp: '2026-10-19T08:30:00Z',
  });
  assert.match(xml, /<faultcode>s:Client<\/faultcode>/);
  const { operation, request } = parseEnvelope(xml);
  assert.equal(operation, 'Fault');
  assert.equal(request.ns, NS.s);
  const detail = byName(request, 'detail');
  const ofs = byName(detail, 'OrganizationServiceFault');
  assert.equal(ofs.ns, NS.a);
  assert.equal(byName(ofs, 'ErrorCode').text, '-2147220969');
  assert.equal(byName(ofs, 'Message').text, 'Account With Id = 0 Does Not Exist');
  assert.equal(byName(ofs, 'Timestamp').text, '2026-10-19T08:30:00Z');
  assert.equal(decodeValue(byName(ofs, 'InnerFault')), null);
  assert.equal(decodeValue(byName(ofs, 'TraceText')), null);
  assert.equal(decodePairs(byName(ofs, 'ErrorDetails')).size, 0);
});

test('throttling fault carries Retry-After as an e:duration detail', () => {
  const xml = fault({
    errorCode: -2147220969,
    message: 'Throttled',
    timestamp: '2026-10-19T08:30:00Z',
    traceText: 'trace',
    errorDetails: new Map([['Retry-After', { type: 'duration', value: 'PT5S' }]]),
  });
  const ofs = byName(byName(parseEnvelope(xml).request, 'detail'), 'OrganizationServiceFault');
  assert.deepStrictEqual(
    decodePairs(byName(ofs, 'ErrorDetails')),
    new Map([['Retry-After', { type: 'duration', value: 'PT5S' }]]),
  );
  assert.equal(byName(ofs, 'TraceText').text, 'trace');
});

test('unsupported value types and non-integer fault codes are refused', () => {
  assert.throws(() => encodeValue('v', { type: 'Raw' }), DataError);
  assert.throws(() => fault({ errorCode: 1.5, message: 'x', timestamp: 't' }), TypeError);
});

// Regression tests. Golden strings and literal namespace URIs pin the SDK wire shape; the
// round trips above cannot, because the decoder ignores item element names.
const encodedNode = (xml) => parseEnvelope(envelope(xml)).request;
// Hand-written SDK-shaped XML: only the SOAP envelope prefix is declared at the root.
const sdkNode = (xml) => parseEnvelope(`<s:Envelope xmlns:s="${NS.s}"><s:Body>${xml}</s:Body></s:Envelope>`).request;
const sdkValue = (xml) => decodeValue(sdkNode(xml));
const SDK_ARRAYS = 'http://schemas.microsoft.com/2003/10/Serialization/Arrays';

test('FormattedValues items are KeyValuePairOfstringstring with untyped values', () => {
  const xml = encodeValue('v', {
    type: 'Entity',
    logicalName: 'widget',
    id: GUID,
    attributes: new Map(),
    formattedValues: new Map([['statecode', 'Active']]),
    keyAttributes: new Map(),
    relatedEntities: null,
    rowVersion: null,
    entityState: null,
  });
  assert.ok(
    xml.includes(
      '<a:FormattedValues><a:KeyValuePairOfstringstring><b:key>statecode</b:key><b:value>Active</b:value></a:KeyValuePairOfstringstring></a:FormattedValues>',
    ),
    xml,
  );
  assert.deepStrictEqual(
    decodePairs(byName(encodedNode(xml), 'FormattedValues'), (v) => v.text),
    new Map([['statecode', 'Active']]),
  );
});

test('KeyAttributes items are in the xrm/7.1 namespace (KeyAttributeCollection)', () => {
  const xml = encodeValue('v', {
    type: 'EntityReference',
    logicalName: 'widget',
    id: GUID,
    name: null,
    keyAttributes: new Map([['code', text('W-1')]]),
  });
  assert.ok(xml.includes('<a:KeyAttributes><o:KeyValuePairOfstringanyType><b:key>code</b:key>'), xml);
  const item = byName(byName(encodedNode(xml), 'KeyAttributes'), 'KeyValuePairOfstringanyType');
  {
    __paqSoapNamespaceProof(import.meta.url, 'sdk-namespace-0');
    assert.equal(item.ns, 'http://schemas.microsoft.com/xrm/7.1/Contracts');
  }
});

test('ErrorDetails items are KeyValuePairOfstringanyType in the xrm/2011 namespace', () => {
  const xml = fault({
    errorCode: -2147220969,
    message: 'Throttled',
    timestamp: '2026-10-19T08:30:00Z',
    errorDetails: new Map([['Retry-After', { type: 'duration', value: 'PT5S' }]]),
  });
  assert.ok(
    xml.includes(
      '<ErrorDetails xmlns:b="http://schemas.datacontract.org/2004/07/System.Collections.Generic"><KeyValuePairOfstringanyType><b:key>Retry-After</b:key><b:value i:type="e:duration">PT5S</b:value></KeyValuePairOfstringanyType></ErrorDetails>',
    ),
    xml,
  );
  const details = byName(
    byName(byName(parseEnvelope(xml).request, 'detail'), 'OrganizationServiceFault'),
    'ErrorDetails',
  );
  {
    __paqSoapNamespaceProof(import.meta.url, 'sdk-namespace-1');
    assert.equal(details.children[0].ns, 'http://schemas.microsoft.com/xrm/2011/Contracts');
  }
});

test('untyped a:Value decodes OptionSetValue and its collection as int, and Money as text (SDK wire)', () => {
  const head = `xmlns:i="${NS.i}" xmlns:a="${NS.a}"`;
  assert.deepStrictEqual(sdkValue(`<v ${head} i:type="a:OptionSetValue"><a:Value>1</a:Value></v>`), {
    type: 'OptionSetValue',
    value: 1,
  });
  assert.deepStrictEqual(
    sdkValue(
      `<v ${head} xmlns:x9="${NS.x9}" i:type="x9:OptionSetValueCollection"><x9:OptionSetValue><a:Value>1</a:Value></x9:OptionSetValue><x9:OptionSetValue><a:Value>3</a:Value></x9:OptionSetValue></v>`,
    ),
    { type: 'OptionSetValueCollection', values: [1, 3] },
  );
  assert.deepStrictEqual(sdkValue(`<v ${head} i:type="a:Money"><a:Value>12.50</a:Value></v>`), {
    type: 'Money',
    value: '12.50',
  });
  assert.equal(
    encodeValue('v', { type: 'OptionSetValue', value: 2 }),
    '<v i:type="a:OptionSetValue"><a:Value>2</a:Value></v>',
  );
});

test('Money encodes an exact four-digit decimal in a typed c:decimal Value, rounding beyond four digits', () => {
  assert.equal(
    encodeValue('v', { type: 'Money', value: 12.5 }),
    '<v i:type="a:Money"><a:Value i:type="c:decimal">12.5000</a:Value></v>',
  );
  assert.equal(
    encodeValue('v', { type: 'Money', value: '0.123456' }),
    '<v i:type="a:Money"><a:Value i:type="c:decimal">0.1235</a:Value></v>',
  );
  assert.equal(encodeValue('v', { type: 'Money', value: null }), '<v i:nil="true"/>');
});

test('an invalid Date is a 400 DataError with the invalid-argument code, not a RangeError', () => {
  assert.throws(
    () => encodeValue('v', { type: 'dateTime', value: new Date(Number.NaN) }),
    (error) => error instanceof DataError && error.status === 400 && error.details?.innerCode === '0x80040203',
  );
});

test('an ExecuteTransactionFault is an OrganizationServiceFault element typed by i:type, its prefixes declared on that element', () => {
  // WCF reads FaultException<OrganizationServiceFault> from the detail element; a root named ExecuteTransactionFault is not that contract.
  const xml = fault({
    errorCode: -2147220969,
    message: 'failed',
    timestamp: '2026-10-19T08:30:00Z',
    faultedRequestIndex: 2,
  });
  assert.match(
    xml,
    /<OrganizationServiceFault xmlns="http:\/\/schemas\.microsoft\.com\/xrm\/2011\/Contracts" xmlns:i="[^"]+" xmlns:o="http:\/\/schemas\.microsoft\.com\/xrm\/7\.1\/Contracts" i:type="o:ExecuteTransactionFault">/,
  );
  const serviceFault = byName(byName(parseEnvelope(xml).request, 'detail'), 'OrganizationServiceFault');
  assert.equal(serviceFault.ns, NS.a);
  assert.equal(serviceFault.attrs.find((a) => a.name === 'type').value, 'o:ExecuteTransactionFault');
  assert.equal(byName(serviceFault, 'ErrorCode').ns, NS.a);
  assert.equal(byName(serviceFault, 'ErrorCode').text, '-2147220969');
  // Base members (xrm/2011) come first; FaultedRequestIndex, the derived member, is last and in xrm/7.1.
  assert.equal(serviceFault.children.at(-1).name, 'FaultedRequestIndex');
  assert.equal(serviceFault.children.at(-1).ns, NS.o);
  assert.equal(serviceFault.children.at(-1).text, '2');
});

test('a plain OrganizationServiceFault has no i:type and no FaultedRequestIndex', () => {
  const xml = fault({ errorCode: -2147220969, message: 'failed', timestamp: '2026-10-19T08:30:00Z' });
  assert.doesNotMatch(xml, /i:type=/);
  assert.doesNotMatch(xml, /FaultedRequestIndex/);
  assert.match(
    xml,
    /<OrganizationServiceFault xmlns="http:\/\/schemas\.microsoft\.com\/xrm\/2011\/Contracts" xmlns:i="[^"]+">/,
  );
});

test('an out-of-range character reference is a 400 DataError, not a RangeError', () => {
  for (const bad of ['<r>&#99999999;</r>', '<r a="&#x110000;"/>']) {
    assert.throws(
      () => parseXml(bad),
      (error) => error instanceof DataError && error.status === 400,
      bad,
    );
  }
});

test('TotalRecordCount is always written: -1 when no count was requested', () => {
  const xml = encodeValue('v', {
    type: 'EntityCollection',
    entityName: 'widget',
    entities: [],
    moreRecords: false,
    pagingCookie: null,
    totalRecordCount: null,
    totalRecordCountLimitExceeded: null,
    minActiveRowVersion: null,
  });
  assert.ok(
    xml.endsWith(
      '<a:TotalRecordCount>-1</a:TotalRecordCount><a:TotalRecordCountLimitExceeded>false</a:TotalRecordCountLimitExceeded></v>',
    ),
    xml,
  );
  assert.equal(decodeValue(encodedNode(xml)).totalRecordCount, -1);
});

test('an AliasedValue with a null inner value stays typed and writes a nil a:Value', () => {
  assert.equal(
    encodeValue('v', { type: 'AliasedValue', attribute: 'name', entity: 'widget', value: null }),
    '<v i:type="a:AliasedValue"><a:AttributeLogicalName>name</a:AttributeLogicalName><a:EntityLogicalName>widget</a:EntityLogicalName><a:Value i:nil="true"/></v>',
  );
  assert.deepStrictEqual(
    decodeValue(
      encodedNode(encodeValue('v', { type: 'AliasedValue', attribute: 'name', entity: 'widget', value: null })),
    ),
    { type: 'AliasedValue', attribute: 'name', entity: 'widget', value: null },
  );
});

test('a null AliasedValue name is nil, not the text null; a null OptionSetValue stays nil as a whole', () => {
  assert.equal(
    encodeValue('v', { type: 'AliasedValue', attribute: null, entity: 'widget', value: text('x') }),
    '<v i:type="a:AliasedValue"><a:AttributeLogicalName i:nil="true"/><a:EntityLogicalName>widget</a:EntityLogicalName><a:Value i:type="c:string">x</a:Value></v>',
  );
  assert.equal(encodeValue('v', { type: 'OptionSetValue', value: null }), '<v i:nil="true"/>');
});

test('ColumnSet encodes AllColumns and string Columns in the arrays namespace, and decodes SDK-shaped XML', () => {
  assert.equal(
    encodeValue('v', { type: 'ColumnSet', allColumns: false, columns: ['name', 'createdon'] }),
    '<v i:type="a:ColumnSet"><a:AllColumns>false</a:AllColumns><a:Columns><f:string>name</f:string><f:string>createdon</f:string></a:Columns></v>',
  );
  const head = `xmlns:i="${NS.i}" xmlns:a="${NS.a}" xmlns:f="${SDK_ARRAYS}"`;
  const node = sdkNode(
    `<v ${head} i:type="a:ColumnSet"><a:AllColumns>true</a:AllColumns><a:Columns><f:string>name</f:string></a:Columns></v>`,
  );
  assert.deepStrictEqual(decodeValue(node), { type: 'ColumnSet', allColumns: true, columns: ['name'] });
  assert.equal(byName(node, 'Columns').children[0].ns, SDK_ARRAYS);
});

test('EntityReferenceCollection encodes untyped EntityReference items and decodes SDK-shaped XML', () => {
  assert.equal(
    encodeValue('v', {
      type: 'EntityReferenceCollection',
      values: [{ type: 'EntityReference', logicalName: 'widget', id: GUID, name: 'Blue', keyAttributes: new Map() }],
    }),
    `<v i:type="a:EntityReferenceCollection"><a:EntityReference><a:Id>${GUID}</a:Id><a:KeyAttributes></a:KeyAttributes><a:LogicalName>widget</a:LogicalName><a:Name>Blue</a:Name></a:EntityReference></v>`,
  );
  assert.deepStrictEqual(
    sdkValue(
      `<v xmlns:i="${NS.i}" xmlns:a="${NS.a}" i:type="a:EntityReferenceCollection"><a:EntityReference><a:Id>${GUID}</a:Id><a:LogicalName>widget</a:LogicalName><a:Name i:nil="true"/></a:EntityReference></v>`,
    ),
    {
      type: 'EntityReferenceCollection',
      values: [{ type: 'EntityReference', logicalName: 'widget', id: GUID, name: null, keyAttributes: new Map() }],
    },
  );
});

// @parity-evidence: Microsoft.CrmSdk.CoreAssemblies 9.0.2.60 DataContractSerializer produced the suffixed collection item and consumed the corrected graph in both prefix forms.
test('RelatedEntities items are KeyValuePairOfRelationshipEntityCollectionX_PsK4FkN with declared key and value', () => {
  const related = [
    {
      relationship: { schemaName: 'widget_gadgets', primaryEntityRole: 'Referenced' },
      entities: {
        type: 'EntityCollection',
        entityName: 'gadget',
        entities: [],
        moreRecords: false,
        pagingCookie: null,
        totalRecordCount: 1,
        totalRecordCountLimitExceeded: false,
        minActiveRowVersion: null,
      },
    },
  ];
  const xml = encodeValue('v', {
    type: 'Entity',
    logicalName: 'widget',
    id: GUID,
    attributes: new Map(),
    formattedValues: new Map(),
    keyAttributes: new Map(),
    relatedEntities: related,
    rowVersion: null,
    entityState: null,
  });
  assert.ok(
    xml.includes(
      '<a:RelatedEntities><a:KeyValuePairOfRelationshipEntityCollectionX_PsK4FkN><b:key><a:PrimaryEntityRole>Referenced</a:PrimaryEntityRole><a:SchemaName>widget_gadgets</a:SchemaName></b:key>' +
        '<b:value><a:Entities></a:Entities><a:EntityName>gadget</a:EntityName><a:MoreRecords>false</a:MoreRecords><a:TotalRecordCount>1</a:TotalRecordCount><a:TotalRecordCountLimitExceeded>false</a:TotalRecordCountLimitExceeded></b:value></a:KeyValuePairOfRelationshipEntityCollectionX_PsK4FkN></a:RelatedEntities>',
    ),
    xml,
  );
  const item = byName(
    byName(encodedNode(xml), 'RelatedEntities'),
    'KeyValuePairOfRelationshipEntityCollectionX_PsK4FkN',
  );
  assert.equal(item.ns, 'http://schemas.microsoft.com/xrm/2011/Contracts');
  assert.deepStrictEqual(decodeValue(encodedNode(xml)).relatedEntities, related);
});

test('a long beyond 2^53 is a decimal string, and a safe long stays a Number', () => {
  assert.equal(
    encodeValue('v', { type: 'long', value: '9007199254740993' }),
    '<v i:type="c:long">9007199254740993</v>',
  );
  assert.deepStrictEqual(sdkValue(`<v xmlns:i="${NS.i}" xmlns:c="${NS.c}" i:type="c:long">9007199254740993</v>`), {
    type: 'long',
    value: '9007199254740993',
  });
  assert.deepStrictEqual(sdkValue(`<v xmlns:i="${NS.i}" xmlns:c="${NS.c}" i:type="c:long">-42</v>`), {
    type: 'long',
    value: -42,
  });
});
