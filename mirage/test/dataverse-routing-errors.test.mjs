// @test-kind unproven: Local HTTP routing/admission models; exact repeated native guarantees are individually protected below.
import { parityAssertions as __paqParityAssertions } from '../../scripts/qualify-parity.mjs';
__paqParityBindings(import.meta.url, [
  {
    baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:125:2',
    repositoryRoot: '../..',
    titleExpressionSha256: 'df4934e386a46534c5ee42894ed9b0c6a5a23a6d5b46e8399dcb522bfb800a76',
    originalAssertions: [
      '7899cafaeae892a6b506f53046ed7a582934a0701b7dc46609000f3ce68b5bd7',
      'f6f738d042da0198ef21b6e7353a8e11783d895103ea9da1570ffa8d60b71655',
      'd988958167d8ea1835747d7cd1a97cc141f295927a220dc7299715a3809787b5',
      'a63482c764ed6d11741b88008d2fe0641247ca2b81490ad9659538d631cb8802',
      '268d62d514576b960be48928bed8a34da707e52d3dda706cc1da051dd370226f',
    ],
    originalBodyAstSha256: '8b781a494c393bc039655eda87356bc96725a6da533b2e9dd98fedda270dc18b',
    originalGuardHashes: [],
    moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
    isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
    importRoles: [
      {
        source: '../lib/data.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/api_qualify',
        reason:
          'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
      },
      {
        source: '../lib/dataverse-settings.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/api_qualify',
        reason:
          'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
      },
      {
        source: '../lib/dataverse-api.mjs',
        role: 'implementation-under-test',
        reviewedBy: '/root/api_qualify',
        reason:
          'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
      },
    ],
    runtimeInputs: [],
    inputDependencies: [],
    sourceBindings: [],
    loopHeaders: [],
    caseUniverse: {
      count: 1,
      cases: [
        'answers an authenticated OPTIONS that is not a preflight with 405, and keeps CORS preflight and anonymous OPTIONS at 204',
      ],
      casesSha256: '49c4eb024551f5f3f1f53f8883bc0643ad48faebdf83510457337eca219355c7',
      sourceBindings: [],
      ancestorLoops: [],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/dataverse-batch23-existing-row-methods.json',
        sha256: 'e830ef7e2ed1257ae0a7046650af606152c20228d2d86f4135088640190b7e22',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'method-1',
            pointer: '/captures/0/cases/1/facts',
            sha256: '9f200d6f6d5e9536d4417e6591d610f16c3430991edd1eaf35cd3ec42c8f9475',
            replicatedPointers: ['/captures/0/cases/1/facts', '/captures/1/cases/1/facts'],
          },
        ],
      },
    ],
    regionHashes: [
      [
        '7899cafaeae892a6b506f53046ed7a582934a0701b7dc46609000f3ce68b5bd7',
        'f6f738d042da0198ef21b6e7353a8e11783d895103ea9da1570ffa8d60b71655',
      ],
    ],
    regionFactIds: [[['method-1'], ['method-1']]],
  },
]);
import {
  assertParityBindings as __paqParityBindings,
  assertParityBindingsFromSource as __paqParitySourceBindings,
} from '../../scripts/qualify-parity.mjs';
// Routing and admission errors of the Dataverse Web API, over HTTP. Each expectation mirrors a native response.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:http';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';

const APP_ID = '44444444-4444-4444-4444-444444444444';
const SECRET_VAR = 'PAQVILO_ROUTING_TEST_SECRET';
const WIDGET = 'aaaaaaaa-0000-4000-8000-000000000001';
const GADGET = 'bbbbbbbb-0000-4000-8000-000000000001';
const MISSING = '00000000-0000-4000-8000-0000000000ff';
const API = '/api/data/v9.2';

function schema() {
  const state = emptyState();
  state.mappings.contoso_widget = {
    logicalName: 'contoso_widget',
    entitySet: 'contoso_widgets',
    idColumn: 'contoso_widgetid',
    nameColumn: 'contoso_name',
    alternateKeys: [{ name: 'contoso_code', attributes: ['contoso_code'] }],
    fields: { contoso_name: { dataverseType: 'nvarchar' }, contoso_code: { dataverseType: 'nvarchar' } },
    relationships: {},
  };
  state.mappings.contoso_gadget = {
    logicalName: 'contoso_gadget',
    entitySet: 'contoso_gadgets',
    idColumn: 'contoso_gadgetid',
    nameColumn: 'contoso_name',
    fields: { contoso_name: { dataverseType: 'nvarchar' }, contoso_widgetid: { dataverseType: 'lookup' } },
    relationships: {
      contoso_widget: { entity: 'contoso_widget', from: 'contoso_widgetid', to: 'contoso_widgetid', many: false },
    },
  };
  state.tables.contoso_widget = [{ contoso_widgetid: WIDGET, contoso_name: 'alpha', contoso_code: 'A1' }];
  state.tables.contoso_gadget = [{ contoso_gadgetid: GADGET, contoso_name: 'gizmo' }];
  return state;
}

describe('dataverse Web API routing and admission errors', () => {
  let api;
  let token;
  let previousSecret;

  before(async () => {
    previousSecret = process.env[SECRET_VAR];
    process.env[SECRET_VAR] = 'routing-test-secret';
    const store = await new DataStore({ state: schema() }).init();
    const settings = dataverseSettings({
      enabled: true,
      applications: [
        {
          appId: APP_ID,
          displayName: 'Routing test app',
          secretEnvironmentVariable: SECRET_VAR,
          roles: ['System Administrator'],
        },
      ],
    });
    api = await startDataverseApi({ store, change: (fn) => fn(), settings, host: '127.0.0.1', log: () => {} });
    const form = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: process.env[SECRET_VAR],
      scope: `${api.origin}/.default`,
    });
    const response = await fetch(`${api.origin}/${api.tenantId}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form,
    });
    token = (await response.json()).access_token;
  });

  after(async () => {
    try {
      await api?.close();
    } finally {
      if (previousSecret === undefined) delete process.env[SECRET_VAR];
      else process.env[SECRET_VAR] = previousSecret;
    }
  });

  // Plain node:http so that Origin and Access-Control-Request-Method can be sent with an OPTIONS request.
  function send(method, path, { headers = {}, body, auth = true } = {}) {
    const url = new URL(`${api.origin}${path}`);
    const payload = body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const all = { ...(auth ? { authorization: `Bearer ${token}` } : {}), accept: 'application/json', ...headers };
    if (payload !== null && all['content-type'] === undefined) all['content-type'] = 'application/json; charset=utf-8';
    if (payload !== null) all['content-length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const req = request(
        { hostname: url.hostname, port: url.port, path: url.pathname + url.search, method, headers: all },
        (res) => {
          const chunks = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            resolve({ status: res.statusCode, headers: res.headers, text, json: () => JSON.parse(text) });
          });
        },
      );
      req.on('error', reject);
      if (payload !== null) req.write(payload);
      req.end();
    });
  }

  const error = async (response) => (await response.json()).error;
  const record = (id = WIDGET) => `${API}/contoso_widgets(${id})`;

  // @test-kind parity: The native1071 pair rejects3.0 with exact412/code/message and accepts4.01.
  // @parity-evidence: dataverse-existing-routing.json binds headers.odata-old/new to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('refuses an OData-Version other than 4.0 or 4.01 with 412 0x80060888 before the request runs', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:108:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '7be6f842156ebe4ba9ac4a4b5ff481499ba77d2ff9e77ebf10d344cc8459ddb1',
        originalAssertions: [
          'df6dc388720285ef6089e9621cb7871daef86007dcf8cce0c535c30a1259ac9c',
          '3a63ec932ad3147ff3a3b974ecccb925b1dea8b8186f54957ccf163f943fbc1e',
          '44790e3384551fc99780bebef03404283410708b435afb12d9e1fd8708fda846',
        ],
        originalBodyAstSha256: '87c26a8d9ec46f3de84a451e380e6324dd99b1a687457516079cfa40683fe807',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['refuses an OData-Version other than 4.0 or 4.01 with 412 0x80060888 before the request runs'],
          casesSha256: '20f153c51ab81b2d604fa779403b4766f97b589aa4982db236dbc7f5c4d697b7',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case0',
                pointer: '/captures/0/cases/0/facts',
                sha256: '6984ad4ec7c7594aa58b1d53f3d1646eaf23f8043a10e40186700f1332423411',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
              {
                id: 'proof0-case1',
                pointer: '/captures/0/cases/1/facts',
                sha256: '7cd85494eb375cc958155aca095fd0bae01e24f777c4ce4059e2edb82324618c',
                replicatedPointers: ['/captures/0/cases/1/facts', '/captures/1/cases/1/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('GET', record(), { headers: { 'OData-Version': '3.0' } });
    assert.equal(response.status, 412);
    assert.deepEqual(await error(response), {
      code: '0x80060888',
      message:
        "The value '3.0' of the OData-Version HTTP header is invalid. Only '4.0' and '4.01' are supported as values for the OData-Version header.",
    });
    assert.equal((await send('GET', record(), { headers: { 'OData-Version': '4.01' } })).status, 200);
  });

  // @test-kind parity: Both native1071 cohorts answer keyed HEAD405 with exactly zero response bytes.
  // @parity-evidence: dataverse-existing-routing.json binds errors.method-head to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers HEAD on a Web API resource with 405 and no body', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:119:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '74d932274f440c9e601eb51d3e2325101d58222666ab409ac56e8841a02d091c',
        originalAssertions: [
          '146375bcc0785b19d7b88e595816df2c6e9e09814a649c9cf5c262235d0ea0fc',
          '9eb47f0f07c4458a338212a6ec717cb147631551aaf8d678000889571d09983f',
        ],
        originalBodyAstSha256: '96e0e2976b9d2221bd9372807bbbf5353b071ec8c58575df84f1ec907f08b854',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['answers HEAD on a Web API resource with 405 and no body'],
          casesSha256: '3c65a3e633e78921be72cfb109a6c2e487bb52674edb078b3c02a10709d13ecd',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case2',
                pointer: '/captures/0/cases/2/facts',
                sha256: '34d70afdf9f5b305280c5a3d029e4cc4422a86f7f232036e93e6000c7c2e2b15',
                replicatedPointers: ['/captures/0/cases/2/facts', '/captures/1/cases/2/facts'],
              },
            ],
          },
          {
            path: 'mirage/test/fixtures/dataverse-batch23-existing-row-methods.json',
            sha256: 'e830ef7e2ed1257ae0a7046650af606152c20228d2d86f4135088640190b7e22',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'method-0',
                pointer: '/captures/0/cases/0/facts',
                sha256: '544190d79f32c2b9043b4e10a27de57ca92612150a16ef80bce1e421d4c62e9f',
                replicatedPointers: ['/captures/0/cases/0/facts', '/captures/1/cases/0/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('HEAD', record());
    assert.equal(response.status, 405);
    assert.equal(response.text, '');
  });

  it('answers an authenticated OPTIONS that is not a preflight with 405, and keeps CORS preflight and anonymous OPTIONS at 204', async () => {
    const refused = await send('OPTIONS', record());
    {
      __paqParityAssertions(import.meta.url, [
        {
          baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:125:2',
          repositoryRoot: '../..',
          titleExpressionSha256: 'df4934e386a46534c5ee42894ed9b0c6a5a23a6d5b46e8399dcb522bfb800a76',
          originalAssertions: [
            '7899cafaeae892a6b506f53046ed7a582934a0701b7dc46609000f3ce68b5bd7',
            'f6f738d042da0198ef21b6e7353a8e11783d895103ea9da1570ffa8d60b71655',
            'd988958167d8ea1835747d7cd1a97cc141f295927a220dc7299715a3809787b5',
            'a63482c764ed6d11741b88008d2fe0641247ca2b81490ad9659538d631cb8802',
            '268d62d514576b960be48928bed8a34da707e52d3dda706cc1da051dd370226f',
          ],
          originalBodyAstSha256: '8b781a494c393bc039655eda87356bc96725a6da533b2e9dd98fedda270dc18b',
          originalGuardHashes: [],
          moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
          isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
          importRoles: [
            {
              source: '../lib/data.mjs',
              role: 'implementation-under-test',
              reviewedBy: '/root/api_qualify',
              reason:
                'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
            },
            {
              source: '../lib/dataverse-settings.mjs',
              role: 'implementation-under-test',
              reviewedBy: '/root/api_qualify',
              reason:
                'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
            },
            {
              source: '../lib/dataverse-api.mjs',
              role: 'implementation-under-test',
              reviewedBy: '/root/api_qualify',
              reason:
                'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
            },
          ],
          runtimeInputs: [],
          inputDependencies: [],
          sourceBindings: [],
          loopHeaders: [],
          caseUniverse: {
            count: 1,
            cases: [
              'answers an authenticated OPTIONS that is not a preflight with 405, and keeps CORS preflight and anonymous OPTIONS at 204',
            ],
            casesSha256: '49c4eb024551f5f3f1f53f8883bc0643ad48faebdf83510457337eca219355c7',
            sourceBindings: [],
            ancestorLoops: [],
          },
          proofs: [
            {
              path: 'mirage/test/fixtures/dataverse-batch23-existing-row-methods.json',
              sha256: 'e830ef7e2ed1257ae0a7046650af606152c20228d2d86f4135088640190b7e22',
              mode: 'reproduced-native',
              capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
              facts: [
                {
                  id: 'method-1',
                  pointer: '/captures/0/cases/1/facts',
                  sha256: '9f200d6f6d5e9536d4417e6591d610f16c3430991edd1eaf35cd3ec42c8f9475',
                  replicatedPointers: ['/captures/0/cases/1/facts', '/captures/1/cases/1/facts'],
                },
              ],
            },
          ],
          regionHashes: [
            [
              '7899cafaeae892a6b506f53046ed7a582934a0701b7dc46609000f3ce68b5bd7',
              'f6f738d042da0198ef21b6e7353a8e11783d895103ea9da1570ffa8d60b71655',
            ],
          ],
          regionFactIds: [[['method-1'], ['method-1']]],
        },
      ]);
      assert.equal(refused.status, 405);
      assert.deepEqual(await error(refused), {
        code: '',
        message: "The requested resource does not support http method 'OPTIONS'.",
      });
    }

    const preflight = await send('OPTIONS', record(), {
      auth: false,
      headers: { origin: 'https://app.example.test', 'access-control-request-method': 'PATCH' },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers['access-control-allow-origin'], '*');
    assert.equal((await send('OPTIONS', record(), { auth: false })).status, 204);
  });

  // @test-kind parity: Both native1071 cohorts reject text/plain keyed writes415 with empty error code and exact MIME text; normal JSON PATCH remains204.
  // @parity-evidence: dataverse-existing-routing.json binds errors.payload-text/crud.patch-empty to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('refuses a record write whose body is text/plain with 415 and the media type in the message', async () => {
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('PATCH', record(), {
      headers: { 'content-type': 'text/plain', 'if-none-match': '*' },
      body: 'hello',
    });
    assert.equal(response.status, 415);
    assert.deepEqual(await error(response), {
      code: '',
      message: "The request entity's media type 'text/plain' is not supported for this resource.",
    });
    assert.equal((await send('PATCH', record(), { body: { contoso_name: 'beta' } })).status, 204);
  });

  // @test-kind parity: Both native1071 cohorts reject keyed PUT and POST405 with these exact parameterized operation messages.
  // @parity-evidence: dataverse-existing-routing.json binds errors.method-put/post to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers PUT and POST on a record with their native 405 messages', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:155:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '08e2337a844e6c03e9e10cc67ee0f94c61f6e375597673ea6d57b6e0f005a542',
        originalAssertions: [
          'f8c5f34d3d75bce86b73e97b223b4a6ac0f1873b7a5a1bec4463f8cc8347b239',
          'acc114206b0da9b26de5eaf93b9c206d5d859a366112e55e4a44541a1e39767a',
          '85dd6fdbf14d4cb3347ad4bfe3980545db6ba396a06d4fcd745b8820777b7e59',
          '7001eb4409fa83202dc5e93a19db06e76408f3c40ffa9269d4036c3bfc2f8744',
        ],
        originalBodyAstSha256: 'ce9a1aa6ec9d5821cd37e77dc4e1cfe8c53eeb097e8ff7898f822c358e3a7cd4',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['answers PUT and POST on a record with their native 405 messages'],
          casesSha256: '4d7c9359ded56e784808903fed9756a107313ed51d345c86547f40b22c86ecf0',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case5',
                pointer: '/captures/0/cases/5/facts',
                sha256: 'd87512f7df2940ae25f838a5b15239b9eb311da6aba2a83a128b1f4d211cfa89',
                replicatedPointers: ['/captures/0/cases/5/facts', '/captures/1/cases/5/facts'],
              },
              {
                id: 'proof0-case6',
                pointer: '/captures/0/cases/6/facts',
                sha256: '60b76a9e9127bad56543ac668d5290ac42e847d4f1c441416be7072c6dc74b43',
                replicatedPointers: ['/captures/0/cases/6/facts', '/captures/1/cases/6/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const put = await send('PUT', record(), { body: {} });
    assert.equal(put.status, 405);
    assert.deepEqual(await error(put), { code: '0x80060888', message: 'Operation not supported on contoso_widget' });

    const post = await send('POST', record(), { body: {} });
    assert.equal(post.status, 405);
    assert.deepEqual(await error(post), {
      code: '0x80060888',
      message: 'Unmapped Request found, PathTemplate:~/entityset/key, HttpVerb:POST',
    });
  });

  // @test-kind parity: Both native1071 cohorts reject the extra unkeyed path segment400/0x80060888 with exact query-syntax text.
  // @parity-evidence: dataverse-existing-routing.json binds errors.bad-path to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers a plain segment after a set without a key as a query-syntax error (400 0x80060888)', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:168:2',
        repositoryRoot: '../..',
        titleExpressionSha256: 'd24f411dd63d695525592055e11bbcc501511e4a73d9441ca3cb27efbce730a6',
        originalAssertions: [
          '8c8ceb0a0347e2bb42f0a374c5be9674d12a1f76a01648c62ebf83ccf316140e',
          '1395bbee02c72b1c356c86b2184a1f202ec9e54b9253b6e0e3958dd7b46030c6',
        ],
        originalBodyAstSha256: '8f1ba4f53cbd81e28fdeb8fc61446fe9d23c231ee7209f52857f106cedaebdb2',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['answers a plain segment after a set without a key as a query-syntax error (400 0x80060888)'],
          casesSha256: '0c0b4367c717a6d6946421b031b1fe98f543205588bb9954d9286451fcb6748c',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case7',
                pointer: '/captures/0/cases/7/facts',
                sha256: '51aabfca69fd4890aa5c2566afeff2f967d379b38b8df94bd95dbc98682f4e1e',
                replicatedPointers: ['/captures/0/cases/7/facts', '/captures/1/cases/7/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('GET', `${API}/contoso_widgets/invalidsegment`);
    assert.equal(response.status, 400);
    assert.deepEqual(await error(response), { code: '0x80060888', message: 'Bad Request - Error in query syntax.' });
  });

  it('reads set() with empty parentheses as the entity set', async () => {
    const response = await send('GET', `${API}/contoso_widgets()`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).value.length, 1);
  });

  // @test-kind parity: Both native1071 cohorts reject missing, wrong-case and logical-type path segments with404/0x80060888 and exact segment punctuation.
  // @parity-evidence: dataverse-existing-routing.json binds errors.unknown-set/documentation.singular-lower/plural-titlecase/custom-uppercase to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers unknown, wrongly cased and capitalised entity set names with 404 0x80060888 and the segment message', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:180:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '1118386a450ffbef5e75e916f99976a069510de9d161a1de7b7c513853eb5968',
        originalAssertions: [
          '94052a65fbd137ce434af820bcc9ecf3a03193106ccde5a638c965950ed798af',
          'f67987a11d1c22a2755f77168723f0b1cfbc3554f85c3929531c19daf212cadd',
        ],
        originalBodyAstSha256: 'a2b51811beaefca9022f4d6911e89aaaa9bb51ee0a49a90253ffa568ab9e1197',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: [
            'answers unknown, wrongly cased and capitalised entity set names with 404 0x80060888 and the segment message',
          ],
          casesSha256: 'b0fecd57a332291a4269a0280a36a313310dda4ce35c9ce2edbfe7f3ebce215f',
          sourceBindings: [],
          ancestorLoops: [],
        },
        assertionLoops: [
          {
            assertionSha256: '94052a65fbd137ce434af820bcc9ecf3a03193106ccde5a638c965950ed798af',
            loopAstSha256: 'b1164897d2293cfbf8b876bb87cdf7f4359ddec9d767bd3c123acf9afba5a3e6',
            caseBindings: [
              { name: 'contoso_missing' },
              { name: 'CONTOSO_WIDGETS' },
              { name: 'Accounts' },
              { name: 'contoso_widget' },
            ],
            caseBindingsSha256: 'ef8418d6fb739b2eeaa47942ecc7b289bfb6546648807560cb5672977366e526',
            caseFacts: [
              { outerCaseIndex: 0, innerCaseIndex: 0, factIds: ['proof0-case8'] },
              { outerCaseIndex: 0, innerCaseIndex: 1, factIds: ['proof0-case9'] },
              { outerCaseIndex: 0, innerCaseIndex: 2, factIds: ['proof0-case10'] },
              { outerCaseIndex: 0, innerCaseIndex: 3, factIds: ['proof0-case11'] },
            ],
          },
          {
            assertionSha256: 'f67987a11d1c22a2755f77168723f0b1cfbc3554f85c3929531c19daf212cadd',
            loopAstSha256: 'b1164897d2293cfbf8b876bb87cdf7f4359ddec9d767bd3c123acf9afba5a3e6',
            caseBindings: [
              { name: 'contoso_missing' },
              { name: 'CONTOSO_WIDGETS' },
              { name: 'Accounts' },
              { name: 'contoso_widget' },
            ],
            caseBindingsSha256: 'ef8418d6fb739b2eeaa47942ecc7b289bfb6546648807560cb5672977366e526',
            caseFacts: [
              { outerCaseIndex: 0, innerCaseIndex: 0, factIds: ['proof0-case8'] },
              { outerCaseIndex: 0, innerCaseIndex: 1, factIds: ['proof0-case9'] },
              { outerCaseIndex: 0, innerCaseIndex: 2, factIds: ['proof0-case10'] },
              { outerCaseIndex: 0, innerCaseIndex: 3, factIds: ['proof0-case11'] },
            ],
          },
        ],
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case8',
                pointer: '/captures/0/cases/8/facts',
                sha256: '525b6b7c821190352b23966fe4660475b2f8a6d43c636e00502085a1565de40f',
                replicatedPointers: ['/captures/0/cases/8/facts', '/captures/1/cases/8/facts'],
              },
              {
                id: 'proof0-case9',
                pointer: '/captures/0/cases/9/facts',
                sha256: '525b6b7c821190352b23966fe4660475b2f8a6d43c636e00502085a1565de40f',
                replicatedPointers: ['/captures/0/cases/9/facts', '/captures/1/cases/9/facts'],
              },
              {
                id: 'proof0-case10',
                pointer: '/captures/0/cases/10/facts',
                sha256: '525b6b7c821190352b23966fe4660475b2f8a6d43c636e00502085a1565de40f',
                replicatedPointers: ['/captures/0/cases/10/facts', '/captures/1/cases/10/facts'],
              },
              {
                id: 'proof0-case11',
                pointer: '/captures/0/cases/11/facts',
                sha256: '525b6b7c821190352b23966fe4660475b2f8a6d43c636e00502085a1565de40f',
                replicatedPointers: ['/captures/0/cases/11/facts', '/captures/1/cases/11/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    for (const name of ['contoso_missing', 'CONTOSO_WIDGETS', 'Accounts', 'contoso_widget']) {
      const response = await send('GET', `${API}/${name}`);
      assert.equal(response.status, 404, name);
      assert.deepEqual(
        await error(response),
        { code: '0x80060888', message: `Resource not found for the segment '${name}'.` },
        name,
      );
    }
  });

  // @test-kind parity: Both native1071 cohorts reject an unknown keyed property404/0x80060888, with no trailing message period.
  // @parity-evidence: dataverse-existing-routing.json binds property.unknown to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers an unknown property after a record with 404 0x80060888, without a trailing period', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:192:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '1c8527d357010f6af63fc4711cead6f55bc45ef5f3ea5583b2f7c5ec9b67c10b',
        originalAssertions: [
          '6a391cc0e27f7ff195b4b4504e0fbbdafc277a65122b41ebd3bd5b2313cb40f3',
          '7220cc54c7ea1ceaf36a2186ce563101a78808dd3164aae0a3614af3b617f153',
        ],
        originalBodyAstSha256: 'a13a21c17442e7d66cb83a4ec14a9e6287ff3248b0fa662b95e85f75e712a6d3',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['answers an unknown property after a record with 404 0x80060888, without a trailing period'],
          casesSha256: '7663d42fcab2fe27e89229de903d177623fc3b61a7752d17d8867a4e885ef3df',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case12',
                pointer: '/captures/0/cases/12/facts',
                sha256: 'f4884247db07afa6ebf79dac3c9baf1c1ef480e04fc0fc5dcaba67a3d0bcb863',
                replicatedPointers: ['/captures/0/cases/12/facts', '/captures/1/cases/12/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('GET', record() + '/contoso_nosuch');
    assert.equal(response.status, 404);
    assert.deepEqual(await error(response), {
      code: '0x80060888',
      message: "Resource not found for the segment 'contoso_nosuch'",
    });
  });

  it('separates malformed key syntax (400 0x80060888), a valid but missing row (404 0x80040217) and an undeclared alternate key (400 0x80060888)', async () => {
    const malformed = await send('GET', `${API}/contoso_widgets(not-a-guid)`);
    assert.equal(malformed.status, 400);
    assert.deepEqual(await error(malformed), {
      code: '0x80060888',
      message: "')' or ',' expected at position 6 in '(not-a-guid)'.",
    });

    const missing = await send('GET', record(MISSING));
    assert.equal(missing.status, 404);
    assert.deepEqual(await error(missing), {
      code: '0x80040217',
      message: `Entity 'contoso_widget' With Id = ${MISSING} Does Not Exist`,
    });
    // An engine error repeats the request id: two REQ_ID lines (the same id twice, as fetch joins them).
    const id = missing.headers['x-ms-service-request-id'];
    assert.equal(missing.headers.req_id, `${id}, ${id}`);

    const undeclared = await send('GET', `${API}/contoso_widgets(contoso_nope='x')`);
    assert.equal(undeclared.status, 400);
    assert.deepEqual(await error(undeclared), {
      code: '0x80060888',
      message:
        "The key in the request URI is not valid for resource 'Microsoft.Dynamics.CRM.contoso_widget'. Ensure that the names and number of key properties match the declared or alternate key properties for the resource 'Microsoft.Dynamics.CRM.contoso_widget'.",
    });
  });

  it('refuses a malformed GUID in @odata.bind as a key syntax error, not as a missing row', async () => {
    const response = await send('PATCH', `${API}/contoso_gadgets(${GADGET})`, {
      body: { 'contoso_widget@odata.bind': '/contoso_widgets(not-a-guid)' },
    });
    assert.equal(response.status, 400);
    assert.deepEqual(await error(response), {
      code: '0x80060888',
      message: "')' or ',' expected at position 6 in '(not-a-guid)'.",
    });
    // Observed: a bind value's engine error repeats the request id (REQ_ID twice), unlike a malformed URL key.
    const id = response.headers['x-ms-service-request-id'];
    assert.equal(response.headers.req_id, `${id}, ${id}`);
  });

  // @test-kind parity: Both native1071 cohorts reject the unknown EntityDefinitions LogicalName key404 with this exact parameterized metadata error.
  // @parity-evidence: dataverse-existing-routing.json binds metadata.invalid-name to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers an unknown EntityDefinitions key with 404 0x80060888 naming the metadata id', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:242:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '93492fc7b21796b86c6cc45a2c185ce92377973cbf119675808fd8081d7aab24',
        originalAssertions: [
          '6a391cc0e27f7ff195b4b4504e0fbbdafc277a65122b41ebd3bd5b2313cb40f3',
          '5d8d7c1ef5195bc89b2d0587ad61fe4e728bb37e9b305590fa87da7d564e4f1f',
        ],
        originalBodyAstSha256: '39f0a142c49837e56c96cdb39a0e94a3015db34e654ae6a197593f73a28362e6',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['answers an unknown EntityDefinitions key with 404 0x80060888 naming the metadata id'],
          casesSha256: 'f1ddd51dfcb495504c15e005f545839f4ebefe136ed671510ebb64c0b22133f0',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case13',
                pointer: '/captures/0/cases/13/facts',
                sha256: '51d17624f054ff6c266882ba4cf569f3e3316df20d8420a594b6307cdd67030b',
                replicatedPointers: ['/captures/0/cases/13/facts', '/captures/1/cases/13/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('GET', `${API}/EntityDefinitions(LogicalName='contoso_missing')`);
    assert.equal(response.status, 404);
    assert.deepEqual(await error(response), {
      code: '0x80060888',
      message: "EntityMetadata With Id = LogicalName='contoso_missing' does not exist.",
    });
  });

  // @test-kind parity: Both native1071 cohorts reject an unknown impersonated user404 and return these exact _error code/title/numeric-code facts.
  // @parity-evidence: dataverse-existing-routing.json binds headers.impersonation-invalid to both original native raw run/plan/body hashes; origin, owned IDs and schema role names are parameters.
  it('answers an MSCRMCallerID naming no user with 404 in the _error body', async () => {
    // @parity-evidence: Existing exact manifest proof retained while adding source and input guard bindings.
    __paqParityBindings(import.meta.url, [
      {
        baselineId: 'mirage/test/dataverse-routing-errors.test.mjs:251:2',
        repositoryRoot: '../..',
        titleExpressionSha256: '7e9291c9ad6e63b7b7e254fdc842135fc3579767b9b2d20fa8a655bbf68ffc85',
        originalAssertions: [
          '6a391cc0e27f7ff195b4b4504e0fbbdafc277a65122b41ebd3bd5b2313cb40f3',
          '782ee0deaddf67ae100b441780636749efc71fd92a003008e53ee094c508bee8',
          '4dcaf1adf07ace6b28d1934eee4104910685d67fa75978df24d9179eac3249f2',
          '6ffdc0ad388e64a796e0b1592bb732288440dce7adad2ebae290206d5477eefa',
        ],
        originalBodyAstSha256: '8c3a018e5d40504eb0dcc399c57610b70f5033b19009f9f42bdaac05d262ac41',
        originalGuardHashes: [],
        moduleContextAstSha256: '910803cdc05a21b48edc56ea4b84a60b8ee062e961d7e6dc1777e64b7f9f5c4a',
        isolationRegistrationsAstSha256: '2f5caaaa367f44b71756ec7b759a99887e364983d7b45c69a806fa035d99df5d',
        importRoles: [
          {
            source: '../lib/data.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-settings.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
          {
            source: '../lib/dataverse-api.mjs',
            role: 'implementation-under-test',
            reviewedBy: '/root/api_qualify',
            reason:
              'Toolkit implementation used by the original API, record, security, or data behavior; independently reviewed source context remains required.',
          },
        ],
        runtimeInputs: [],
        inputDependencies: [],
        sourceBindings: [],
        loopHeaders: [],
        caseUniverse: {
          count: 1,
          cases: ['answers an MSCRMCallerID naming no user with 404 in the _error body'],
          casesSha256: '36fc6f1b66f0c611d91d1bc822425cdbf2b2afc0901b4fa70d673a6f3590cf8e',
          sourceBindings: [],
          ancestorLoops: [],
        },
        proofs: [
          {
            path: 'mirage/test/fixtures/dataverse-existing-routing.json',
            sha256: '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
            mode: 'reproduced-native',
            capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
            facts: [
              {
                id: 'proof0-case14',
                pointer: '/captures/0/cases/14/facts',
                sha256: 'cdf45a52f06f75183c88505e7df8bdbe4c370bf7841caea4e234e9662d1b37b9',
                replicatedPointers: ['/captures/0/cases/14/facts', '/captures/1/cases/14/facts'],
              },
            ],
          },
        ],
      },
    ]);
    assert.equal(
      createHash('sha256')
        .update(readFileSync(new URL('./fixtures/dataverse-existing-routing.json', import.meta.url)))
        .digest('hex'),
      '0ddd43e66c4a42f2c48099634c8d4c639ba23bb3a558fdd494c32096829ae03c',
    );
    const response = await send('GET', record(), {
      headers: { MSCRMCallerID: '99999999-9999-4999-8999-999999999999' },
    });
    assert.equal(response.status, 404);
    const body = response.json();
    assert.equal(body._error.Code, '0x80040217');
    assert.equal(body._error.Title, 'Record Is Unavailable');
    assert.equal(body._error.ErrorCode, -2147220969);
  });
});

// @test-kind tooling: Shared source guard reads expected bindings from protected parity bodies and runs independently of their generators; no baseline closure credit.
it('parity source bindings 707bc6046dd09655', () => {
  __paqParitySourceBindings(import.meta.url);
});
