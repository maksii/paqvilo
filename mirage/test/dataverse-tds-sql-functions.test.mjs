// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: Original function cases contain a mix of local contracts and independently evidenced SQL behavior.
import {
  parityCaseBindings as __paqParityCaseBindings,
  assertParityBindings as __paqParityBindings,
  freezeParityDescriptor as __paqParityFreeze,
} from '../../scripts/qualify-parity.mjs';
const __paqParityShared = __paqParityFreeze([
  {
    baselineId: 'mirage/test/dataverse-tds-sql-functions.test.mjs:238:2',
    repositoryRoot: '../..',
    titleExpressionSha256: '0870482be29bf0e30e431409cbca95af5aafc15c1745c1d1678b505605d18d1b',
    originalAssertions: ['cf60392995a11111755931aae17b92b36e4d1cf1447f3103b43baf642efd3dab'],
    originalBodyAstSha256: '2610f9fc4de036a2b0045876356b6746ab864f7175c005d11fc09e931b2d7f4c',
    originalGuardHashes: [],
    moduleContextAstSha256: '9174faa0c21934be8a7f3d008f432441c855d545ec32785ecbe42aac6b775316',
    moduleReview: {
      reviewedBy: 'sql_parity',
      reason:
        'Only two original fixture expectations differ; repeated SQL engine controls and independent fixed-input review bind their corrections.',
      corrections: [],
      fixtureCorrections: [
        {
          binding: 'cases',
          index: 6,
          expectedIndex: 2,
          oldAstSha256: '983bf29d90e628a2f85e762472ff293c94114ff3db7f6541fbb71c78dd709b23',
          currentAstSha256: 'f0a72217a5bcbfdb55d3bd767aa3fcaca7e98f19c5ba66b64a756533397b5dc5',
          sameGuarantee: true,
          guaranteeId: 'sql-server-function-fixed-primitive-cases',
          factIds: ['sql-function-correction-6'],
          reviewedBy: 'ci_diagnostics',
          reason:
            'Repeated official SQL Server engine controls on the same input support the separately audited expected-value correction in the fixed captured context.',
        },
        {
          binding: 'cases',
          index: 38,
          expectedIndex: 2,
          oldAstSha256: '976f5428a6e4330400a160ad79fbdf0e3e91692b8e428a8ebf6e7bff102cf269',
          currentAstSha256: '9a674cba847b5108e02bd6c8a89c9ce4898bed5afade366ff9efb9936cb18a9e',
          sameGuarantee: true,
          guaranteeId: 'sql-server-function-fixed-primitive-cases',
          factIds: ['sql-function-correction-38'],
          reviewedBy: 'ci_diagnostics',
          reason:
            'Repeated official SQL Server engine controls on the same input support the separately audited expected-value correction in the fixed captured context.',
        },
      ],
      addedTests: [],
    },
    importRoles: [
      {
        source: '../lib/dataverse-tds-sql-functions.mjs',
        role: 'implementation-under-test',
        reviewedBy: 'sql_parity',
        reason: 'This is the scalar SQL function implementation exercised by the original assertion.',
      },
    ],
    runtimeInputs: [],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-primitive-review-v1.json',
        sha256: 'eb325d95299b7c0bd25372d4696c92f2b0633b5c517c24e8b177d1229a9b6835',
      },
    ],
    sourceBindings: [
      { name: 'cases', initializerAstSha256: 'a42c4716a392c37e0024fdd94bf9c4689a5654dcf318d9ab360c64eec04b6303' },
    ],
    baselineSourceBindings: [
      { name: 'cases', initializerAstSha256: '702f55fa89e8479b8b577ee3905d812ef16dac9c15e1a10f9675e78c7014bcbe' },
    ],
    loopHeaders: ['cf403e9be96e7dc44dc62aedb699c2e7e5e2e467bc3bc79fd577cb0e772e9447'],
    caseUniverse: {
      count: 140,
      cases: [
        'LEN(null)',
        'LEFT(null, 2)',
        'DATEADD("day", null, 2026-01-01T00:00:00.000Z)',
        'ROUND({"decimal":"1.5"}, null)',
        'CONCAT("a", null, "b")',
        'CONCAT_WS(",", "a", null, "b")',
        'CONCAT_WS(null, "a", "b")',
        'ISNULL(null, "x")',
        'ISNULL("y", "x")',
        'COALESCE(null, null, 3)',
        'NULLIF(1, 1)',
        'NULLIF(1, null)',
        'NULLIF(null, 1)',
        'IIF(null, 1, 2)',
        'IIF(true, 1, 2)',
        'CHOOSE(2, "a", "b", "c")',
        'CHOOSE(4, "a")',
        'CHOOSE(null, "a")',
        'ISNUMERIC(null)',
        'ISDATE(null)',
        'LEN("abc   ")',
        'LEN("")',
        'DATALENGTH("abc")',
        'DATALENGTH(2026-01-01T00:00:00.000Z)',
        'LEFT("abcdef", 2)',
        'LEFT("ab", 5)',
        'RIGHT("abcdef", 2)',
        'RIGHT("ab", 0)',
        'SUBSTRING("abcdef", 2, 3)',
        'SUBSTRING("abc", 0, 2)',
        'SUBSTRING("abc", 5, 2)',
        'CHARINDEX("bicycle", "Reflectors are vital safety components of your bicycle.")',
        'CHARINDEX("vital", "Reflectors are vital safety components of your bicycle.", 5)',
        'CHARINDEX("bike", "Reflectors are vital safety components of your bicycle.")',
        'CHARINDEX("vital", "Reflectors are vital safety components of your bicycle.", 17)',
        'CHARINDEX("TEST", "This is a Test")',
        'CHARINDEX("TEST", "This is a Test", 1) {"caseSensitive":true}',
        'PATINDEX("%[0-9]%", "abc4")',
        'PATINDEX("a_c", "zabc")',
        'PATINDEX("%x%", "abc")',
        'REPLACE("abcabc", "B", "X")',
        'REPLACE("abcabc", "B", "X") {"caseSensitive":true}',
        'REPLICATE("ab", 3)',
        'REPLICATE("a", -1)',
        'REVERSE("abc")',
        'LTRIM("  a ")',
        'RTRIM("  a ")',
        'TRIM("  a  ")',
        'TRIM("x", "xxaxx")',
        'STUFF("abcdef", 2, 3, "XY")',
        'STUFF("abc", 2, 0, "X")',
        'STUFF("abc", 4, 0, "x")',
        'SPACE(3)',
        'SPACE(-1)',
        'STR(123.456)',
        'STR(123.456, 6, 2)',
        'STR(12345, 3)',
        'QUOTENAME("abc[]def")',
        'QUOTENAME("user\'s", "\'")',
        'QUOTENAME("x", "%")',
        'QUOTENAME("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")',
        'ASCII("A")',
        'ASCII("")',
        'CHAR(65)',
        'CHAR(256)',
        'UNICODE("é")',
        'NCHAR(8364)',
        'NCHAR(70000)',
        'CONCAT("a", 1)',
        'FORMAT(1234.5, "#,##0.00")',
        'FORMAT(0.5, "0.00")',
        'FORMAT(2026-10-19T15:04:05.000Z, "yyyy-MM-dd HH:mm:ss")',
        'FORMAT(2026-10-19T00:00:00.000Z, "dddd")',
        'FORMAT(1234.5, "N2", "en-US")',
        'FORMAT(1234.5, "N2", "de-DE")',
        'FORMAT(1234.5, "#,##0.00", "de-DE")',
        'FORMAT(1234.5, "C", "en-US")',
        'FORMAT(0.5, "P0", "en-US")',
        'FORMAT(2026-10-19T00:00:00.000Z, "d")',
        'FORMAT(2026-10-19T00:00:00.000Z, "d", "de-DE")',
        'FORMAT(2026-10-19T00:00:00.000Z, "dddd, dd MMMM yyyy", "de-DE")',
        'FORMAT(1234.5, "N2", "xx-YY")',
        'FORMAT(1234.5, "N2", "not a culture")',
        'DATEDIFF("day", "2036-03-01", "2036-02-28")',
        'DATEDIFF("day", "2007-05-06 23:59:59.999", "2007-05-07 00:00:00")',
        'DATEDIFF("year", "2000-12-31", "2001-01-01")',
        'DATEDIFF("month", "2026-01-31", "2026-02-01")',
        'DATEDIFF("week", "2026-10-17", "2026-10-18")',
        'DATEDIFF("hour", "2026-01-01 00:59", "2026-01-01 01:00")',
        'DATEDIFF("second", "2026-01-01 00:00:00", "2026-01-01 00:01:30")',
        'DATEADD("month", 1, "2026-01-31")',
        'DATEADD("day", 1, "2026-02-28")',
        'DATEADD("year", -1, "2024-02-29")',
        'DATEADD("hour", 25, "2026-01-01")',
        'DATEADD("millisecond", 1500, "2026-01-01 00:00:00")',
        'DATEPART("weekday", 2026-10-19T00:00:00.000Z)',
        'DATEPART("dayofyear", 2026-10-19T00:00:00.000Z)',
        'DATEPART("week", 2026-01-01T00:00:00.000Z)',
        'DATEPART("week", 2026-01-04T00:00:00.000Z)',
        'DATENAME("month", 2026-10-19T00:00:00.000Z)',
        'DATENAME("weekday", 2026-10-19T00:00:00.000Z)',
        'DATENAME("quarter", 2026-10-19T00:00:00.000Z)',
        'YEAR(2026-10-19T00:00:00.000Z)',
        'MONTH(2026-10-19T00:00:00.000Z)',
        'DAY(2026-10-19T00:00:00.000Z)',
        'EOMONTH("2026-02-10")',
        'EOMONTH("2026-02-10", 1)',
        'EOMONTH("2024-02-10")',
        'DATEFROMPARTS(2024, 2, 29)',
        'ISDATE("2026-02-28")',
        'ISDATE("2026-02-30")',
        'ABS(-5)',
        'ABS({"decimal":"-1.50"})',
        'ABS(-7n)',
        'CEILING({"decimal":"1.20"})',
        'FLOOR({"decimal":"-1.20"})',
        'CEILING(-1.5)',
        'FLOOR(1.5)',
        'ROUND({"decimal":"123.9994"}, 3)',
        'ROUND({"decimal":"123.9995"}, 3)',
        'ROUND({"decimal":"123.4545"}, 2)',
        'ROUND({"decimal":"123.45"}, -2)',
        'ROUND({"decimal":"748.58"}, -1)',
        'ROUND({"decimal":"748.58"}, -2)',
        'ROUND({"decimal":"748.58"}, -4)',
        'ROUND({"decimal":"150.75"}, 0)',
        'ROUND({"decimal":"150.75"}, 0, 1)',
        'ROUND({"decimal":"1.15"}, 1)',
        'ROUND({"decimal":"-1.15"}, 1)',
        'ROUND(2.5, 0)',
        'ROUND(-2.5, 0)',
        'ROUND(123.45, -2)',
        'SIGN(-3)',
        'SIGN({"decimal":"0.0"})',
        'POWER(2, 10)',
        'SQRT(16)',
        'SQUARE(3)',
        'EXP(0)',
        'LOG10(1000)',
        'PI()',
      ],
      casesSha256: '968448ff55ed83c3d90ee90a7fd882378d940772934028fc7ce84f11f6473c63',
      sourceBindings: [
        { name: 'cases', initializerAstSha256: '702f55fa89e8479b8b577ee3905d812ef16dac9c15e1a10f9675e78c7014bcbe' },
      ],
      ancestorLoops: [{ headerAstSha256: 'cf403e9be96e7dc44dc62aedb699c2e7e5e2e467bc3bc79fd577cb0e772e9447' }],
      encoding: 'typed-v1',
      currentCaseBindingsSha256: '9206c2ef7441edf607f6c5e2f9a16df5de4c8801a8ffb5b9264549947d5cf15e',
      caseBindingsSha256: '4f7afb0e73ae157e23a87cc3319baba7cf49dd6e7cd17244ada5b31dea65c056',
    },
    caseSelection: {
      selected: [
        { caseIndex: 0, factIds: ['sql-function-0'] },
        { caseIndex: 1, factIds: ['sql-function-1'] },
        { caseIndex: 4, factIds: ['sql-function-4'] },
        { caseIndex: 5, factIds: ['sql-function-5'] },
        { caseIndex: 6, factIds: ['sql-function-correction-6'] },
        { caseIndex: 7, factIds: ['sql-function-7'] },
        { caseIndex: 8, factIds: ['sql-function-8'] },
        { caseIndex: 9, factIds: ['sql-function-9'] },
        { caseIndex: 10, factIds: ['sql-function-10'] },
        { caseIndex: 11, factIds: ['sql-function-11'] },
        { caseIndex: 15, factIds: ['sql-function-15'] },
        { caseIndex: 16, factIds: ['sql-function-16'] },
        { caseIndex: 17, factIds: ['sql-function-17'] },
        { caseIndex: 18, factIds: ['sql-function-18'] },
        { caseIndex: 19, factIds: ['sql-function-19'] },
        { caseIndex: 20, factIds: ['sql-function-20'] },
        { caseIndex: 21, factIds: ['sql-function-21'] },
        { caseIndex: 22, factIds: ['sql-function-22'] },
        { caseIndex: 24, factIds: ['sql-function-24'] },
        { caseIndex: 25, factIds: ['sql-function-25'] },
        { caseIndex: 26, factIds: ['sql-function-26'] },
        { caseIndex: 27, factIds: ['sql-function-27'] },
        { caseIndex: 28, factIds: ['sql-function-28'] },
        { caseIndex: 29, factIds: ['sql-function-29'] },
        { caseIndex: 30, factIds: ['sql-function-30'] },
        { caseIndex: 31, factIds: ['sql-function-31'] },
        { caseIndex: 32, factIds: ['sql-function-32'] },
        { caseIndex: 33, factIds: ['sql-function-33'] },
        { caseIndex: 34, factIds: ['sql-function-34'] },
        { caseIndex: 35, factIds: ['sql-function-35'] },
        { caseIndex: 37, factIds: ['sql-function-37'] },
        { caseIndex: 38, factIds: ['sql-function-correction-38'] },
        { caseIndex: 39, factIds: ['sql-function-39'] },
        { caseIndex: 40, factIds: ['sql-function-40'] },
        { caseIndex: 42, factIds: ['sql-function-42'] },
        { caseIndex: 43, factIds: ['sql-function-43'] },
        { caseIndex: 44, factIds: ['sql-function-44'] },
        { caseIndex: 45, factIds: ['sql-function-45'] },
        { caseIndex: 46, factIds: ['sql-function-46'] },
        { caseIndex: 49, factIds: ['sql-function-49'] },
        { caseIndex: 50, factIds: ['sql-function-50'] },
        { caseIndex: 51, factIds: ['sql-function-51'] },
        { caseIndex: 52, factIds: ['sql-function-52'] },
        { caseIndex: 53, factIds: ['sql-function-53'] },
        { caseIndex: 56, factIds: ['sql-function-56'] },
        { caseIndex: 57, factIds: ['sql-function-57'] },
        { caseIndex: 58, factIds: ['sql-function-58'] },
        { caseIndex: 59, factIds: ['sql-function-59'] },
        { caseIndex: 61, factIds: ['sql-function-61'] },
        { caseIndex: 62, factIds: ['sql-function-62'] },
        { caseIndex: 63, factIds: ['sql-function-63'] },
        { caseIndex: 64, factIds: ['sql-function-64'] },
        { caseIndex: 65, factIds: ['sql-function-65'] },
        { caseIndex: 66, factIds: ['sql-function-66'] },
        { caseIndex: 67, factIds: ['sql-function-67'] },
        { caseIndex: 68, factIds: ['sql-function-68'] },
        { caseIndex: 111, factIds: ['sql-function-111'] },
        { caseIndex: 132, factIds: ['sql-function-132'] },
        { caseIndex: 134, factIds: ['sql-function-134'] },
        { caseIndex: 135, factIds: ['sql-function-135'] },
        { caseIndex: 136, factIds: ['sql-function-136'] },
        { caseIndex: 137, factIds: ['sql-function-137'] },
        { caseIndex: 138, factIds: ['sql-function-138'] },
      ],
      encoding: 'typed-v1',
      bindings: [
        {
          name: { type: 'string', value: 'LEN' },
          args: { type: 'array', value: [{ type: 'null' }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LEFT' },
          args: { type: 'array', value: [{ type: 'null' }, { type: 'number', value: 2 }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEADD' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'day' },
              { type: 'null' },
              { type: 'date', value: '2026-01-01T00:00:00.000Z' },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [{ type: 'object', value: { decimal: { type: 'string', value: '1.5' } } }, { type: 'null' }],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CONCAT' },
          args: {
            type: 'array',
            value: [{ type: 'string', value: 'a' }, { type: 'null' }, { type: 'string', value: 'b' }],
          },
          expected: { type: 'string', value: 'ab' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CONCAT_WS' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: ',' },
              { type: 'string', value: 'a' },
              { type: 'null' },
              { type: 'string', value: 'b' },
            ],
          },
          expected: { type: 'string', value: 'a,b' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CONCAT_WS' },
          args: {
            type: 'array',
            value: [{ type: 'null' }, { type: 'string', value: 'a' }, { type: 'string', value: 'b' }],
          },
          expected: { type: 'string', value: 'ab' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ISNULL' },
          args: { type: 'array', value: [{ type: 'null' }, { type: 'string', value: 'x' }] },
          expected: { type: 'string', value: 'x' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ISNULL' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'y' },
              { type: 'string', value: 'x' },
            ],
          },
          expected: { type: 'string', value: 'y' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'COALESCE' },
          args: { type: 'array', value: [{ type: 'null' }, { type: 'null' }, { type: 'number', value: 3 }] },
          expected: { type: 'number', value: 3 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'NULLIF' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1 },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'NULLIF' },
          args: { type: 'array', value: [{ type: 'number', value: 1 }, { type: 'null' }] },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'NULLIF' },
          args: { type: 'array', value: [{ type: 'null' }, { type: 'number', value: 1 }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'IIF' },
          args: {
            type: 'array',
            value: [{ type: 'null' }, { type: 'number', value: 1 }, { type: 'number', value: 2 }],
          },
          expected: { type: 'number', value: 2 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'IIF' },
          args: {
            type: 'array',
            value: [
              { type: 'boolean', value: true },
              { type: 'number', value: 1 },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHOOSE' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 2 },
              { type: 'string', value: 'a' },
              { type: 'string', value: 'b' },
              { type: 'string', value: 'c' },
            ],
          },
          expected: { type: 'string', value: 'b' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHOOSE' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 4 },
              { type: 'string', value: 'a' },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHOOSE' },
          args: { type: 'array', value: [{ type: 'null' }, { type: 'string', value: 'a' }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ISNUMERIC' },
          args: { type: 'array', value: [{ type: 'null' }] },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ISDATE' },
          args: { type: 'array', value: [{ type: 'null' }] },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LEN' },
          args: { type: 'array', value: [{ type: 'string', value: 'abc   ' }] },
          expected: { type: 'number', value: 3 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LEN' },
          args: { type: 'array', value: [{ type: 'string', value: '' }] },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATALENGTH' },
          args: { type: 'array', value: [{ type: 'string', value: 'abc' }] },
          expected: { type: 'number', value: 6 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATALENGTH' },
          args: { type: 'array', value: [{ type: 'date', value: '2026-01-01T00:00:00.000Z' }] },
          expected: { type: 'number', value: 8 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LEFT' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abcdef' },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'string', value: 'ab' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LEFT' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'ab' },
              { type: 'number', value: 5 },
            ],
          },
          expected: { type: 'string', value: 'ab' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'RIGHT' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abcdef' },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'string', value: 'ef' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'RIGHT' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'ab' },
              { type: 'number', value: 0 },
            ],
          },
          expected: { type: 'string', value: '' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SUBSTRING' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abcdef' },
              { type: 'number', value: 2 },
              { type: 'number', value: 3 },
            ],
          },
          expected: { type: 'string', value: 'bcd' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SUBSTRING' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abc' },
              { type: 'number', value: 0 },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'string', value: 'a' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SUBSTRING' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abc' },
              { type: 'number', value: 5 },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'string', value: '' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHARINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'bicycle' },
              { type: 'string', value: 'Reflectors are vital safety components of your bicycle.' },
            ],
          },
          expected: { type: 'number', value: 48 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHARINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'vital' },
              { type: 'string', value: 'Reflectors are vital safety components of your bicycle.' },
              { type: 'number', value: 5 },
            ],
          },
          expected: { type: 'number', value: 16 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHARINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'bike' },
              { type: 'string', value: 'Reflectors are vital safety components of your bicycle.' },
            ],
          },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHARINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'vital' },
              { type: 'string', value: 'Reflectors are vital safety components of your bicycle.' },
              { type: 'number', value: 17 },
            ],
          },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHARINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'TEST' },
              { type: 'string', value: 'This is a Test' },
            ],
          },
          expected: { type: 'number', value: 11 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHARINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'TEST' },
              { type: 'string', value: 'This is a Test' },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'object', value: { caseSensitive: { type: 'boolean', value: true } } },
        },
        {
          name: { type: 'string', value: 'PATINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: '%[0-9]%' },
              { type: 'string', value: 'abc4' },
            ],
          },
          expected: { type: 'number', value: 4 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'PATINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'a_c' },
              { type: 'string', value: 'zabc' },
            ],
          },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'PATINDEX' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: '%x%' },
              { type: 'string', value: 'abc' },
            ],
          },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'REPLACE' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abcabc' },
              { type: 'string', value: 'B' },
              { type: 'string', value: 'X' },
            ],
          },
          expected: { type: 'string', value: 'aXcaXc' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'REPLACE' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abcabc' },
              { type: 'string', value: 'B' },
              { type: 'string', value: 'X' },
            ],
          },
          expected: { type: 'string', value: 'abcabc' },
          ctx: { type: 'object', value: { caseSensitive: { type: 'boolean', value: true } } },
        },
        {
          name: { type: 'string', value: 'REPLICATE' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'ab' },
              { type: 'number', value: 3 },
            ],
          },
          expected: { type: 'string', value: 'ababab' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'REPLICATE' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'a' },
              { type: 'number', value: -1 },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'REVERSE' },
          args: { type: 'array', value: [{ type: 'string', value: 'abc' }] },
          expected: { type: 'string', value: 'cba' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LTRIM' },
          args: { type: 'array', value: [{ type: 'string', value: '  a ' }] },
          expected: { type: 'string', value: 'a ' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'RTRIM' },
          args: { type: 'array', value: [{ type: 'string', value: '  a ' }] },
          expected: { type: 'string', value: '  a' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'TRIM' },
          args: { type: 'array', value: [{ type: 'string', value: '  a  ' }] },
          expected: { type: 'string', value: 'a' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'TRIM' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'x' },
              { type: 'string', value: 'xxaxx' },
            ],
          },
          expected: { type: 'string', value: 'a' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'STUFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abcdef' },
              { type: 'number', value: 2 },
              { type: 'number', value: 3 },
              { type: 'string', value: 'XY' },
            ],
          },
          expected: { type: 'string', value: 'aXYef' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'STUFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abc' },
              { type: 'number', value: 2 },
              { type: 'number', value: 0 },
              { type: 'string', value: 'X' },
            ],
          },
          expected: { type: 'string', value: 'aXbc' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'STUFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'abc' },
              { type: 'number', value: 4 },
              { type: 'number', value: 0 },
              { type: 'string', value: 'x' },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SPACE' },
          args: { type: 'array', value: [{ type: 'number', value: 3 }] },
          expected: { type: 'string', value: '   ' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SPACE' },
          args: { type: 'array', value: [{ type: 'number', value: -1 }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'STR' },
          args: { type: 'array', value: [{ type: 'number', value: 123.456 }] },
          expected: { type: 'string', value: '       123' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'STR' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 123.456 },
              { type: 'number', value: 6 },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'string', value: '123.46' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'STR' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 12345 },
              { type: 'number', value: 3 },
            ],
          },
          expected: { type: 'string', value: '***' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'QUOTENAME' },
          args: { type: 'array', value: [{ type: 'string', value: 'abc[]def' }] },
          expected: { type: 'string', value: '[abc[]]def]' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'QUOTENAME' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: "user's" },
              { type: 'string', value: "'" },
            ],
          },
          expected: { type: 'string', value: "'user''s'" },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'QUOTENAME' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'x' },
              { type: 'string', value: '%' },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'QUOTENAME' },
          args: {
            type: 'array',
            value: [
              {
                type: 'string',
                value:
                  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
              },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ASCII' },
          args: { type: 'array', value: [{ type: 'string', value: 'A' }] },
          expected: { type: 'number', value: 65 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ASCII' },
          args: { type: 'array', value: [{ type: 'string', value: '' }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHAR' },
          args: { type: 'array', value: [{ type: 'number', value: 65 }] },
          expected: { type: 'string', value: 'A' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CHAR' },
          args: { type: 'array', value: [{ type: 'number', value: 256 }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'UNICODE' },
          args: { type: 'array', value: [{ type: 'string', value: 'é' }] },
          expected: { type: 'number', value: 233 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'NCHAR' },
          args: { type: 'array', value: [{ type: 'number', value: 8364 }] },
          expected: { type: 'string', value: '€' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'NCHAR' },
          args: { type: 'array', value: [{ type: 'number', value: 70000 }] },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CONCAT' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'a' },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'string', value: 'a1' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: '#,##0.00' },
            ],
          },
          expected: { type: 'string', value: '1,234.50' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 0.5 },
              { type: 'string', value: '0.00' },
            ],
          },
          expected: { type: 'string', value: '0.50' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'date', value: '2026-10-19T15:04:05.000Z' },
              { type: 'string', value: 'yyyy-MM-dd HH:mm:ss' },
            ],
          },
          expected: { type: 'string', value: '2026-10-19 15:04:05' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
              { type: 'string', value: 'dddd' },
            ],
          },
          expected: { type: 'string', value: 'Monday' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: 'N2' },
              { type: 'string', value: 'en-US' },
            ],
          },
          expected: { type: 'string', value: '1,234.50' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: 'N2' },
              { type: 'string', value: 'de-DE' },
            ],
          },
          expected: { type: 'string', value: '1.234,50' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: '#,##0.00' },
              { type: 'string', value: 'de-DE' },
            ],
          },
          expected: { type: 'string', value: '1.234,50' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: 'C' },
              { type: 'string', value: 'en-US' },
            ],
          },
          expected: { type: 'string', value: '$1,234.50' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 0.5 },
              { type: 'string', value: 'P0' },
              { type: 'string', value: 'en-US' },
            ],
          },
          expected: { type: 'string', value: '50%' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
              { type: 'string', value: 'd' },
            ],
          },
          expected: { type: 'string', value: '10/19/2026' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
              { type: 'string', value: 'd' },
              { type: 'string', value: 'de-DE' },
            ],
          },
          expected: { type: 'string', value: '19.10.2026' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
              { type: 'string', value: 'dddd, dd MMMM yyyy' },
              { type: 'string', value: 'de-DE' },
            ],
          },
          expected: { type: 'string', value: 'Montag, 19 Oktober 2026' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: 'N2' },
              { type: 'string', value: 'xx-YY' },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FORMAT' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 1234.5 },
              { type: 'string', value: 'N2' },
              { type: 'string', value: 'not a culture' },
            ],
          },
          expected: { type: 'null' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'day' },
              { type: 'string', value: '2036-03-01' },
              { type: 'string', value: '2036-02-28' },
            ],
          },
          expected: { type: 'number', value: -2 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'day' },
              { type: 'string', value: '2007-05-06 23:59:59.999' },
              { type: 'string', value: '2007-05-07 00:00:00' },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'year' },
              { type: 'string', value: '2000-12-31' },
              { type: 'string', value: '2001-01-01' },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'month' },
              { type: 'string', value: '2026-01-31' },
              { type: 'string', value: '2026-02-01' },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'week' },
              { type: 'string', value: '2026-10-17' },
              { type: 'string', value: '2026-10-18' },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'hour' },
              { type: 'string', value: '2026-01-01 00:59' },
              { type: 'string', value: '2026-01-01 01:00' },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEDIFF' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'second' },
              { type: 'string', value: '2026-01-01 00:00:00' },
              { type: 'string', value: '2026-01-01 00:01:30' },
            ],
          },
          expected: { type: 'number', value: 90 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEADD' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'month' },
              { type: 'number', value: 1 },
              { type: 'string', value: '2026-01-31' },
            ],
          },
          expected: { type: 'date', value: '2026-02-28T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEADD' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'day' },
              { type: 'number', value: 1 },
              { type: 'string', value: '2026-02-28' },
            ],
          },
          expected: { type: 'date', value: '2026-03-01T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEADD' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'year' },
              { type: 'number', value: -1 },
              { type: 'string', value: '2024-02-29' },
            ],
          },
          expected: { type: 'date', value: '2023-02-28T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEADD' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'hour' },
              { type: 'number', value: 25 },
              { type: 'string', value: '2026-01-01' },
            ],
          },
          expected: { type: 'date', value: '2026-01-02T01:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEADD' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'millisecond' },
              { type: 'number', value: 1500 },
              { type: 'string', value: '2026-01-01 00:00:00' },
            ],
          },
          expected: { type: 'date', value: '2026-01-01T00:00:01.500Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEPART' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'weekday' },
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
            ],
          },
          expected: { type: 'number', value: 2 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEPART' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'dayofyear' },
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
            ],
          },
          expected: { type: 'number', value: 292 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEPART' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'week' },
              { type: 'date', value: '2026-01-01T00:00:00.000Z' },
            ],
          },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEPART' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'week' },
              { type: 'date', value: '2026-01-04T00:00:00.000Z' },
            ],
          },
          expected: { type: 'number', value: 2 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATENAME' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'month' },
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
            ],
          },
          expected: { type: 'string', value: 'October' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATENAME' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'weekday' },
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
            ],
          },
          expected: { type: 'string', value: 'Monday' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATENAME' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: 'quarter' },
              { type: 'date', value: '2026-10-19T00:00:00.000Z' },
            ],
          },
          expected: { type: 'string', value: '4' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'YEAR' },
          args: { type: 'array', value: [{ type: 'date', value: '2026-10-19T00:00:00.000Z' }] },
          expected: { type: 'number', value: 2026 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'MONTH' },
          args: { type: 'array', value: [{ type: 'date', value: '2026-10-19T00:00:00.000Z' }] },
          expected: { type: 'number', value: 10 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DAY' },
          args: { type: 'array', value: [{ type: 'date', value: '2026-10-19T00:00:00.000Z' }] },
          expected: { type: 'number', value: 19 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'EOMONTH' },
          args: { type: 'array', value: [{ type: 'string', value: '2026-02-10' }] },
          expected: { type: 'date', value: '2026-02-28T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'EOMONTH' },
          args: {
            type: 'array',
            value: [
              { type: 'string', value: '2026-02-10' },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'date', value: '2026-03-31T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'EOMONTH' },
          args: { type: 'array', value: [{ type: 'string', value: '2024-02-10' }] },
          expected: { type: 'date', value: '2024-02-29T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'DATEFROMPARTS' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 2024 },
              { type: 'number', value: 2 },
              { type: 'number', value: 29 },
            ],
          },
          expected: { type: 'date', value: '2024-02-29T00:00:00.000Z' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ISDATE' },
          args: { type: 'array', value: [{ type: 'string', value: '2026-02-28' }] },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ISDATE' },
          args: { type: 'array', value: [{ type: 'string', value: '2026-02-30' }] },
          expected: { type: 'number', value: 0 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ABS' },
          args: { type: 'array', value: [{ type: 'number', value: -5 }] },
          expected: { type: 'number', value: 5 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ABS' },
          args: { type: 'array', value: [{ type: 'object', value: { decimal: { type: 'string', value: '-1.50' } } }] },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '1.50' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ABS' },
          args: { type: 'array', value: [{ type: 'bigint', value: '-7' }] },
          expected: { type: 'bigint', value: '7' },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CEILING' },
          args: { type: 'array', value: [{ type: 'object', value: { decimal: { type: 'string', value: '1.20' } } }] },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '2' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FLOOR' },
          args: { type: 'array', value: [{ type: 'object', value: { decimal: { type: 'string', value: '-1.20' } } }] },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '-2' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'CEILING' },
          args: { type: 'array', value: [{ type: 'number', value: -1.5 }] },
          expected: { type: 'number', value: -1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'FLOOR' },
          args: { type: 'array', value: [{ type: 'number', value: 1.5 }] },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '123.9994' } } },
              { type: 'number', value: 3 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '123.9990' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '123.9995' } } },
              { type: 'number', value: 3 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '124.0000' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '123.4545' } } },
              { type: 'number', value: 2 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '123.4500' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '123.45' } } },
              { type: 'number', value: -2 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '100.00' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '748.58' } } },
              { type: 'number', value: -1 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '750.00' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '748.58' } } },
              { type: 'number', value: -2 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '700.00' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '748.58' } } },
              { type: 'number', value: -4 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '0.00' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '150.75' } } },
              { type: 'number', value: 0 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '151.00' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '150.75' } } },
              { type: 'number', value: 0 },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '150.00' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '1.15' } } },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '1.20' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'object', value: { decimal: { type: 'string', value: '-1.15' } } },
              { type: 'number', value: 1 },
            ],
          },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '-1.20' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 2.5 },
              { type: 'number', value: 0 },
            ],
          },
          expected: { type: 'number', value: 3 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: -2.5 },
              { type: 'number', value: 0 },
            ],
          },
          expected: { type: 'number', value: -3 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'ROUND' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 123.45 },
              { type: 'number', value: -2 },
            ],
          },
          expected: { type: 'number', value: 100 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SIGN' },
          args: { type: 'array', value: [{ type: 'number', value: -3 }] },
          expected: { type: 'number', value: -1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SIGN' },
          args: { type: 'array', value: [{ type: 'object', value: { decimal: { type: 'string', value: '0.0' } } }] },
          expected: { type: 'object', value: { decimal: { type: 'string', value: '0' } } },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'POWER' },
          args: {
            type: 'array',
            value: [
              { type: 'number', value: 2 },
              { type: 'number', value: 10 },
            ],
          },
          expected: { type: 'number', value: 1024 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SQRT' },
          args: { type: 'array', value: [{ type: 'number', value: 16 }] },
          expected: { type: 'number', value: 4 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'SQUARE' },
          args: { type: 'array', value: [{ type: 'number', value: 3 }] },
          expected: { type: 'number', value: 9 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'EXP' },
          args: { type: 'array', value: [{ type: 'number', value: 0 }] },
          expected: { type: 'number', value: 1 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'LOG10' },
          args: { type: 'array', value: [{ type: 'number', value: 1000 }] },
          expected: { type: 'number', value: 3 },
          ctx: { type: 'undefined' },
        },
        {
          name: { type: 'string', value: 'PI' },
          args: { type: 'array', value: [] },
          expected: { type: 'number', value: 3.141592653589793 },
          ctx: { type: 'undefined' },
        },
      ],
      source: 'cases',
      names: ['name', 'args', 'expected', 'ctx'],
      parentKinds: ['unproven'],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-original-reviewed-v1.json',
        sha256: 'cddefa7eac228d11acc520c829cc2c3fbc81d114e5920a20283bdbc662af7473',
        mode: 'official-package',
        package: {
          ecosystem: 'microsoft-oci',
          id: 'mssql/server',
          sha256: 'cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718',
          source:
            'https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718',
          bodyBase64:
            'eyJzY2hlbWFWZXJzaW9uIjoyLCJtZWRpYVR5cGUiOiJhcHBsaWNhdGlvbi92bmQuZG9ja2VyLmRpc3RyaWJ1dGlvbi5tYW5pZmVzdC52Mitqc29uIiwiY29uZmlnIjp7Im1lZGlhVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5kb2NrZXIuY29udGFpbmVyLmltYWdlLnYxK2pzb24iLCJzaXplIjozMzcwLCJkaWdlc3QiOiJzaGEyNTY6N2ZiMjEzOTM0MTcxNWU4YTcxODQzY2ZjMmYwMmJhYjZlOTVmMWM1MmMwZmE5ZjlhNmIyZTdiNzYxZjA2MDc4MCJ9LCJsYXllcnMiOlt7Im1lZGlhVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5kb2NrZXIuaW1hZ2Uucm9vdGZzLmRpZmYudGFyLmd6aXAiLCJzaXplIjozMTU1OTQwMCwiZGlnZXN0Ijoic2hhMjU2OmNiNWUzNzRiZTY2MmE1NjJiODI3MTE1ODYzOWU5MThiOWM2MzRhYTRkZmRjOGIzYWEzMWNjZmM5OWNmOGMwNzcifSx7Im1lZGlhVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5kb2NrZXIuaW1hZ2Uucm9vdGZzLmRpZmYudGFyLmd6aXAiLCJzaXplIjo1MDIxMjIzODQsImRpZ2VzdCI6InNoYTI1NjpjZjc2ZTQ3YzIzN2Y5YmZkZThjNzM4ZmQzZTNmYTgzMWI1M2E2MmFlNTI2OTQ0MTYwMGQ0MTM4OTAwNTVkOGFlIn0seyJtZWRpYVR5cGUiOiJhcHBsaWNhdGlvbi92bmQuZG9ja2VyLmltYWdlLnJvb3Rmcy5kaWZmLnRhci5nemlwIiwic2l6ZSI6OTMwMjcwMDMsImRpZ2VzdCI6InNoYTI1NjoxNmU4NDM2YzBjYmFlN2RmNWEzODEzMTE2MWU4OGYxMGE0OTdhZjZlMjRhOWVlNmRjYzcwMDY3ZThjYjI4YWU3In1dfQ==',
        },
        packagePointer: '/package',
        capturePointers: ['/runs/0/runSha256', '/runs/1/runSha256'],
        facts: [
          {
            id: 'sql-function-0',
            pointer: '/runs/0/facts/sql-function-0',
            sha256: '1c2c09c782aec802a72946a777310ecf464854fbefc5f7eafcc5ffe4ebf78163',
            replicatedPointers: ['/runs/0/facts/sql-function-0', '/runs/1/facts/sql-function-0'],
          },
          {
            id: 'sql-function-1',
            pointer: '/runs/0/facts/sql-function-1',
            sha256: 'ac4ed3f18ec761e19ff681f410c350ccfe37e806d7a826a8c5ae37a0fd03d73e',
            replicatedPointers: ['/runs/0/facts/sql-function-1', '/runs/1/facts/sql-function-1'],
          },
          {
            id: 'sql-function-4',
            pointer: '/runs/0/facts/sql-function-4',
            sha256: 'cf9346b1849d104b628cc4d3bf579be36294151b0355a0755e081b63395bc62f',
            replicatedPointers: ['/runs/0/facts/sql-function-4', '/runs/1/facts/sql-function-4'],
          },
          {
            id: 'sql-function-5',
            pointer: '/runs/0/facts/sql-function-5',
            sha256: 'ebe23b5ec477636840305192d66ff4eaec4b267a3ea274cfb716729e6733cc04',
            replicatedPointers: ['/runs/0/facts/sql-function-5', '/runs/1/facts/sql-function-5'],
          },
          {
            id: 'sql-function-7',
            pointer: '/runs/0/facts/sql-function-7',
            sha256: '2158636a2941a2f13d037c31c11b9d8f6635362c9bf72a90144236bab5834926',
            replicatedPointers: ['/runs/0/facts/sql-function-7', '/runs/1/facts/sql-function-7'],
          },
          {
            id: 'sql-function-8',
            pointer: '/runs/0/facts/sql-function-8',
            sha256: 'b78b33cd54d1e0d84b5242a3ba624baf0b427e140ff1e31d83b044aafc8b17a1',
            replicatedPointers: ['/runs/0/facts/sql-function-8', '/runs/1/facts/sql-function-8'],
          },
          {
            id: 'sql-function-9',
            pointer: '/runs/0/facts/sql-function-9',
            sha256: 'fbb6b340b876d636e64c90e2fdcf78695150b7e3a9a4b5eeb969705c5d627c5f',
            replicatedPointers: ['/runs/0/facts/sql-function-9', '/runs/1/facts/sql-function-9'],
          },
          {
            id: 'sql-function-10',
            pointer: '/runs/0/facts/sql-function-10',
            sha256: '070f7e657473fbda585881aa760ed43086adfa398a1f651c6c2af43f7d1dd91f',
            replicatedPointers: ['/runs/0/facts/sql-function-10', '/runs/1/facts/sql-function-10'],
          },
          {
            id: 'sql-function-11',
            pointer: '/runs/0/facts/sql-function-11',
            sha256: '8a9ea19a8f2ad16016829c7377375641d2d7b18f903f89b4b0baa30df9a31a05',
            replicatedPointers: ['/runs/0/facts/sql-function-11', '/runs/1/facts/sql-function-11'],
          },
          {
            id: 'sql-function-15',
            pointer: '/runs/0/facts/sql-function-15',
            sha256: '1f5cc925769c6edfb5c6a9b5f90df49b2353af1273b0cb66ff2fe4d6738835f2',
            replicatedPointers: ['/runs/0/facts/sql-function-15', '/runs/1/facts/sql-function-15'],
          },
          {
            id: 'sql-function-16',
            pointer: '/runs/0/facts/sql-function-16',
            sha256: '9dea3a58a5387852699147b9dbdb37e7decb0fbe1d8f9f738afdb7f4a7c65a4c',
            replicatedPointers: ['/runs/0/facts/sql-function-16', '/runs/1/facts/sql-function-16'],
          },
          {
            id: 'sql-function-17',
            pointer: '/runs/0/facts/sql-function-17',
            sha256: '734073b4af200ccaaa8ae9f8b4b18518d1a5c405eb43ace45f2e9e241b4c8bb3',
            replicatedPointers: ['/runs/0/facts/sql-function-17', '/runs/1/facts/sql-function-17'],
          },
          {
            id: 'sql-function-18',
            pointer: '/runs/0/facts/sql-function-18',
            sha256: '56d70d3108404827fa687c995d6f9ef305aa129fef3f2320ae51262d53ab419f',
            replicatedPointers: ['/runs/0/facts/sql-function-18', '/runs/1/facts/sql-function-18'],
          },
          {
            id: 'sql-function-19',
            pointer: '/runs/0/facts/sql-function-19',
            sha256: '04a8758c414eadd734519a32f5bba2d09636e66f34c117309e55dd8d723eb886',
            replicatedPointers: ['/runs/0/facts/sql-function-19', '/runs/1/facts/sql-function-19'],
          },
          {
            id: 'sql-function-20',
            pointer: '/runs/0/facts/sql-function-20',
            sha256: 'c182aa3ce16c9575fc0a4bc2e00c12c0bbd1e57196428b612da4e6943591751a',
            replicatedPointers: ['/runs/0/facts/sql-function-20', '/runs/1/facts/sql-function-20'],
          },
          {
            id: 'sql-function-21',
            pointer: '/runs/0/facts/sql-function-21',
            sha256: '0e8a86abc8bcaac72b910befed3a7cb5fc3941482aee209f16be8c4260aeb744',
            replicatedPointers: ['/runs/0/facts/sql-function-21', '/runs/1/facts/sql-function-21'],
          },
          {
            id: 'sql-function-22',
            pointer: '/runs/0/facts/sql-function-22',
            sha256: '2418b10bbba19bed76bea14837e48bc265cbeeb61b2a6904877aca27e97b635e',
            replicatedPointers: ['/runs/0/facts/sql-function-22', '/runs/1/facts/sql-function-22'],
          },
          {
            id: 'sql-function-24',
            pointer: '/runs/0/facts/sql-function-24',
            sha256: '87ae6429f237049aa74dfcd1cef428cbb29cdc0afec903e95e86de384b3bd262',
            replicatedPointers: ['/runs/0/facts/sql-function-24', '/runs/1/facts/sql-function-24'],
          },
          {
            id: 'sql-function-25',
            pointer: '/runs/0/facts/sql-function-25',
            sha256: 'ca610c347c7c22200a03befe1c7f517dc14a5fab383d6d8ade528f5ba0981f3c',
            replicatedPointers: ['/runs/0/facts/sql-function-25', '/runs/1/facts/sql-function-25'],
          },
          {
            id: 'sql-function-26',
            pointer: '/runs/0/facts/sql-function-26',
            sha256: 'a5c2338bff743f02cd269dcb485f6be0722289f631499c67ad5956398f0f727b',
            replicatedPointers: ['/runs/0/facts/sql-function-26', '/runs/1/facts/sql-function-26'],
          },
          {
            id: 'sql-function-27',
            pointer: '/runs/0/facts/sql-function-27',
            sha256: '5031184547edd633df7e5b365b319e8c4e227b0851bf17c786c8135ab3b919a8',
            replicatedPointers: ['/runs/0/facts/sql-function-27', '/runs/1/facts/sql-function-27'],
          },
          {
            id: 'sql-function-28',
            pointer: '/runs/0/facts/sql-function-28',
            sha256: 'ee1cd41d60d4ed7b4882628743f494b99775f64e908951acf5b13f4dfa96a84b',
            replicatedPointers: ['/runs/0/facts/sql-function-28', '/runs/1/facts/sql-function-28'],
          },
          {
            id: 'sql-function-29',
            pointer: '/runs/0/facts/sql-function-29',
            sha256: 'c11762b12b0f68f0e4af3d439cb0a31d96cb6c6780390ff523a998fbdace1a20',
            replicatedPointers: ['/runs/0/facts/sql-function-29', '/runs/1/facts/sql-function-29'],
          },
          {
            id: 'sql-function-30',
            pointer: '/runs/0/facts/sql-function-30',
            sha256: '6dc8cb08851fdf4d3d2d2b26390d7b86e5a6e031516b2c6164eda08731c8e4a2',
            replicatedPointers: ['/runs/0/facts/sql-function-30', '/runs/1/facts/sql-function-30'],
          },
          {
            id: 'sql-function-31',
            pointer: '/runs/0/facts/sql-function-31',
            sha256: '9f90909da3624e3376a136b5e8b163442a99adab5436c00eb9f64d65d2e6a7bb',
            replicatedPointers: ['/runs/0/facts/sql-function-31', '/runs/1/facts/sql-function-31'],
          },
          {
            id: 'sql-function-32',
            pointer: '/runs/0/facts/sql-function-32',
            sha256: '220a661713821c7d6b786a343bc79f1b74affb9bb6d23ea0b7774d4763298d24',
            replicatedPointers: ['/runs/0/facts/sql-function-32', '/runs/1/facts/sql-function-32'],
          },
          {
            id: 'sql-function-33',
            pointer: '/runs/0/facts/sql-function-33',
            sha256: '5f3dfa4ec55c365417971d23954b61a8aac74f8b3b66f569fea447e95f92479d',
            replicatedPointers: ['/runs/0/facts/sql-function-33', '/runs/1/facts/sql-function-33'],
          },
          {
            id: 'sql-function-34',
            pointer: '/runs/0/facts/sql-function-34',
            sha256: '3301482b7bfa6722609b34dbb4c380310e11842ddccb4078a5a9293546837ee3',
            replicatedPointers: ['/runs/0/facts/sql-function-34', '/runs/1/facts/sql-function-34'],
          },
          {
            id: 'sql-function-35',
            pointer: '/runs/0/facts/sql-function-35',
            sha256: 'e1952e7d83ae5c0fa39c45b86e5277f7c849d1719cacb12925fd6f3be9c4e712',
            replicatedPointers: ['/runs/0/facts/sql-function-35', '/runs/1/facts/sql-function-35'],
          },
          {
            id: 'sql-function-37',
            pointer: '/runs/0/facts/sql-function-37',
            sha256: '5350ae078ea42c7da61a9823a74fa31619ab463c90383ff7dc1e3b888b236361',
            replicatedPointers: ['/runs/0/facts/sql-function-37', '/runs/1/facts/sql-function-37'],
          },
          {
            id: 'sql-function-39',
            pointer: '/runs/0/facts/sql-function-39',
            sha256: '94b1fcf7f5ae4100083f7a072a3eb37e3e416a01661e4b33f2a971b83756b2c5',
            replicatedPointers: ['/runs/0/facts/sql-function-39', '/runs/1/facts/sql-function-39'],
          },
          {
            id: 'sql-function-40',
            pointer: '/runs/0/facts/sql-function-40',
            sha256: 'dacaaf9bd5f36362d5c507f4c95ab6b3b84f5432aea52411fa11939b2540af30',
            replicatedPointers: ['/runs/0/facts/sql-function-40', '/runs/1/facts/sql-function-40'],
          },
          {
            id: 'sql-function-42',
            pointer: '/runs/0/facts/sql-function-42',
            sha256: 'd8f54c9bf56d797e17695dbf3fbb69233186da7807338594c9b8bd8d7e243df0',
            replicatedPointers: ['/runs/0/facts/sql-function-42', '/runs/1/facts/sql-function-42'],
          },
          {
            id: 'sql-function-43',
            pointer: '/runs/0/facts/sql-function-43',
            sha256: '810c8fe88c95325604d4f87e75348d7d4d56ca8404ca9a938edfdda515bee903',
            replicatedPointers: ['/runs/0/facts/sql-function-43', '/runs/1/facts/sql-function-43'],
          },
          {
            id: 'sql-function-44',
            pointer: '/runs/0/facts/sql-function-44',
            sha256: 'e2c87cdf2bb702b2ef83860529e846a602d18d86ee5307fbb192e6848e6019c4',
            replicatedPointers: ['/runs/0/facts/sql-function-44', '/runs/1/facts/sql-function-44'],
          },
          {
            id: 'sql-function-45',
            pointer: '/runs/0/facts/sql-function-45',
            sha256: '0b85f9ae9acd6dd331ed90bcead8975ffed81e0ce68a240e7fb93e835566c64b',
            replicatedPointers: ['/runs/0/facts/sql-function-45', '/runs/1/facts/sql-function-45'],
          },
          {
            id: 'sql-function-46',
            pointer: '/runs/0/facts/sql-function-46',
            sha256: '6a056023bbb518bca43b270cf3b482b673bcb5cccdb5aeed51431576825ec88a',
            replicatedPointers: ['/runs/0/facts/sql-function-46', '/runs/1/facts/sql-function-46'],
          },
          {
            id: 'sql-function-49',
            pointer: '/runs/0/facts/sql-function-49',
            sha256: '0cb97a9a72be3a5cc38fb0b28199fcc87231c197fdab574163f18eb1a7d0041d',
            replicatedPointers: ['/runs/0/facts/sql-function-49', '/runs/1/facts/sql-function-49'],
          },
          {
            id: 'sql-function-50',
            pointer: '/runs/0/facts/sql-function-50',
            sha256: '916f4672022bff55a14c4346c1d1f5f4074d1161c26a5de77128b9350e0be31f',
            replicatedPointers: ['/runs/0/facts/sql-function-50', '/runs/1/facts/sql-function-50'],
          },
          {
            id: 'sql-function-51',
            pointer: '/runs/0/facts/sql-function-51',
            sha256: '23aa68f4a9eb85487210403b6bdbd7711b63366588e04842f68f1108c851f130',
            replicatedPointers: ['/runs/0/facts/sql-function-51', '/runs/1/facts/sql-function-51'],
          },
          {
            id: 'sql-function-52',
            pointer: '/runs/0/facts/sql-function-52',
            sha256: 'e54d1e3677ff72efbfb50bcb0f2410b93dfb919f735009a73e28de9c9ebdee78',
            replicatedPointers: ['/runs/0/facts/sql-function-52', '/runs/1/facts/sql-function-52'],
          },
          {
            id: 'sql-function-53',
            pointer: '/runs/0/facts/sql-function-53',
            sha256: '9d350d152928c607f9ed1e029c4e43148b5d2da5b261fb6c22f6495f6fb8da8f',
            replicatedPointers: ['/runs/0/facts/sql-function-53', '/runs/1/facts/sql-function-53'],
          },
          {
            id: 'sql-function-56',
            pointer: '/runs/0/facts/sql-function-56',
            sha256: '4e330914d046d554a494b70e8c51748c1bf073dfa698765043e5d455379dae36',
            replicatedPointers: ['/runs/0/facts/sql-function-56', '/runs/1/facts/sql-function-56'],
          },
          {
            id: 'sql-function-57',
            pointer: '/runs/0/facts/sql-function-57',
            sha256: '61b1f54a56ecce7361ebfd5efa2a12fdd32c700493046c72d12e847897c7b535',
            replicatedPointers: ['/runs/0/facts/sql-function-57', '/runs/1/facts/sql-function-57'],
          },
          {
            id: 'sql-function-58',
            pointer: '/runs/0/facts/sql-function-58',
            sha256: '8e2275fa409922ac2337b7b595bf73c541daac3f6e0850f1578cdc022764fa17',
            replicatedPointers: ['/runs/0/facts/sql-function-58', '/runs/1/facts/sql-function-58'],
          },
          {
            id: 'sql-function-59',
            pointer: '/runs/0/facts/sql-function-59',
            sha256: 'e28a95d4d359deb5cdcda5f4d90cea2033ca873306c8f4e8a68b931a03448c46',
            replicatedPointers: ['/runs/0/facts/sql-function-59', '/runs/1/facts/sql-function-59'],
          },
          {
            id: 'sql-function-61',
            pointer: '/runs/0/facts/sql-function-61',
            sha256: 'd54fbd3835298f1e076842dd8ecd9b36a1154195dc61f41a3a91bae8a5681212',
            replicatedPointers: ['/runs/0/facts/sql-function-61', '/runs/1/facts/sql-function-61'],
          },
          {
            id: 'sql-function-62',
            pointer: '/runs/0/facts/sql-function-62',
            sha256: 'c4ae794532c227d3a9cc51528de1b96eb998f61fa4d0433c2b12c61e3c9c7fd8',
            replicatedPointers: ['/runs/0/facts/sql-function-62', '/runs/1/facts/sql-function-62'],
          },
          {
            id: 'sql-function-63',
            pointer: '/runs/0/facts/sql-function-63',
            sha256: '139ffcfb8fe737e7c04860be15d6434f2ce101fa98a8ce7e625a8625e54c82cf',
            replicatedPointers: ['/runs/0/facts/sql-function-63', '/runs/1/facts/sql-function-63'],
          },
          {
            id: 'sql-function-64',
            pointer: '/runs/0/facts/sql-function-64',
            sha256: 'cc105095541de43d2f55ee7665d8abec917eb9d2fb8ffd7b591c4bc07660e2bb',
            replicatedPointers: ['/runs/0/facts/sql-function-64', '/runs/1/facts/sql-function-64'],
          },
          {
            id: 'sql-function-65',
            pointer: '/runs/0/facts/sql-function-65',
            sha256: '1c6c8f9fbf45711fa7553da71d3cce6540844bb3a1c475b240283f971479130d',
            replicatedPointers: ['/runs/0/facts/sql-function-65', '/runs/1/facts/sql-function-65'],
          },
          {
            id: 'sql-function-66',
            pointer: '/runs/0/facts/sql-function-66',
            sha256: '65becd828d6972ce0c7db1994d667c00c9c344b3406878eb02d9178de64d01fc',
            replicatedPointers: ['/runs/0/facts/sql-function-66', '/runs/1/facts/sql-function-66'],
          },
          {
            id: 'sql-function-67',
            pointer: '/runs/0/facts/sql-function-67',
            sha256: '26b1b0bfb7c0b424ad3cb798d6117eddb63918ebdfe6c16401b254c4f0af6211',
            replicatedPointers: ['/runs/0/facts/sql-function-67', '/runs/1/facts/sql-function-67'],
          },
          {
            id: 'sql-function-68',
            pointer: '/runs/0/facts/sql-function-68',
            sha256: 'ba86751e788b4de6ca7854c3f2c1d3dbd9f3e752d3dc6e0418d1a3069f3544ed',
            replicatedPointers: ['/runs/0/facts/sql-function-68', '/runs/1/facts/sql-function-68'],
          },
          {
            id: 'sql-function-111',
            pointer: '/runs/0/facts/sql-function-111',
            sha256: '8420e2307a6c16ec9b4ed17109de4c16b1c453074efa82c43f7b570952c52111',
            replicatedPointers: ['/runs/0/facts/sql-function-111', '/runs/1/facts/sql-function-111'],
          },
          {
            id: 'sql-function-132',
            pointer: '/runs/0/facts/sql-function-132',
            sha256: '4765b54cfd61d7d36a338748a5cb4e37d954bfab6330f9d4e3c52a85c41046d2',
            replicatedPointers: ['/runs/0/facts/sql-function-132', '/runs/1/facts/sql-function-132'],
          },
          {
            id: 'sql-function-134',
            pointer: '/runs/0/facts/sql-function-134',
            sha256: '21784d911eef0d549792904a57acc3d38d83b933a2539578d97548466bf3eda8',
            replicatedPointers: ['/runs/0/facts/sql-function-134', '/runs/1/facts/sql-function-134'],
          },
          {
            id: 'sql-function-135',
            pointer: '/runs/0/facts/sql-function-135',
            sha256: '82707f94d319beacb63d2827ec9179f82058f222907751bc4d53466fc628d02d',
            replicatedPointers: ['/runs/0/facts/sql-function-135', '/runs/1/facts/sql-function-135'],
          },
          {
            id: 'sql-function-136',
            pointer: '/runs/0/facts/sql-function-136',
            sha256: '459d681827ac74d331aa3768b10665e44b92d8c3363f01096401780914b98215',
            replicatedPointers: ['/runs/0/facts/sql-function-136', '/runs/1/facts/sql-function-136'],
          },
          {
            id: 'sql-function-137',
            pointer: '/runs/0/facts/sql-function-137',
            sha256: '8d7ea035321f04cf1e50b9a5891a99758171c2c1eb3f4948d72b2f59d78e13e6',
            replicatedPointers: ['/runs/0/facts/sql-function-137', '/runs/1/facts/sql-function-137'],
          },
          {
            id: 'sql-function-138',
            pointer: '/runs/0/facts/sql-function-138',
            sha256: 'af5c8b8744cbca6af4c2bdb2c65f4432108bd5f6be3d7ca0bce5e1023d502d31',
            replicatedPointers: ['/runs/0/facts/sql-function-138', '/runs/1/facts/sql-function-138'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-corrections-reviewed-v1.json',
        sha256: '04f2884df009bcf10b03a59b083a9c264d0dfb59b7c090e3fc9cdda7608356e3',
        mode: 'official-package',
        package: {
          ecosystem: 'microsoft-oci',
          id: 'mssql/server',
          sha256: 'cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718',
          source:
            'https://mcr.microsoft.com/v2/mssql/server/manifests/sha256:cf8f0ab2ebe61feec2eed2629061a07d247f791c2a8ddda74a4ac9f06a291718',
          bodyBase64:
            'eyJzY2hlbWFWZXJzaW9uIjoyLCJtZWRpYVR5cGUiOiJhcHBsaWNhdGlvbi92bmQuZG9ja2VyLmRpc3RyaWJ1dGlvbi5tYW5pZmVzdC52Mitqc29uIiwiY29uZmlnIjp7Im1lZGlhVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5kb2NrZXIuY29udGFpbmVyLmltYWdlLnYxK2pzb24iLCJzaXplIjozMzcwLCJkaWdlc3QiOiJzaGEyNTY6N2ZiMjEzOTM0MTcxNWU4YTcxODQzY2ZjMmYwMmJhYjZlOTVmMWM1MmMwZmE5ZjlhNmIyZTdiNzYxZjA2MDc4MCJ9LCJsYXllcnMiOlt7Im1lZGlhVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5kb2NrZXIuaW1hZ2Uucm9vdGZzLmRpZmYudGFyLmd6aXAiLCJzaXplIjozMTU1OTQwMCwiZGlnZXN0Ijoic2hhMjU2OmNiNWUzNzRiZTY2MmE1NjJiODI3MTE1ODYzOWU5MThiOWM2MzRhYTRkZmRjOGIzYWEzMWNjZmM5OWNmOGMwNzcifSx7Im1lZGlhVHlwZSI6ImFwcGxpY2F0aW9uL3ZuZC5kb2NrZXIuaW1hZ2Uucm9vdGZzLmRpZmYudGFyLmd6aXAiLCJzaXplIjo1MDIxMjIzODQsImRpZ2VzdCI6InNoYTI1NjpjZjc2ZTQ3YzIzN2Y5YmZkZThjNzM4ZmQzZTNmYTgzMWI1M2E2MmFlNTI2OTQ0MTYwMGQ0MTM4OTAwNTVkOGFlIn0seyJtZWRpYVR5cGUiOiJhcHBsaWNhdGlvbi92bmQuZG9ja2VyLmltYWdlLnJvb3Rmcy5kaWZmLnRhci5nemlwIiwic2l6ZSI6OTMwMjcwMDMsImRpZ2VzdCI6InNoYTI1NjoxNmU4NDM2YzBjYmFlN2RmNWEzODEzMTE2MWU4OGYxMGE0OTdhZjZlMjRhOWVlNmRjYzcwMDY3ZThjYjI4YWU3In1dfQ==',
        },
        packagePointer: '/package',
        capturePointers: ['/runs/0/runSha256', '/runs/1/runSha256'],
        facts: [
          {
            id: 'sql-function-correction-6',
            pointer: '/runs/0/facts/sql-function-correction-6',
            sha256: '28232f2bf5423d9618b1d7680f4552b0380c7405655a4877f6d0bfd5f47b136e',
            replicatedPointers: ['/runs/0/facts/sql-function-correction-6', '/runs/1/facts/sql-function-correction-6'],
          },
          {
            id: 'sql-function-correction-38',
            pointer: '/runs/0/facts/sql-function-correction-38',
            sha256: '48f7fcd8909bb785aabb8f3dd56d2ec6e0b019394631733228ddedaee6542470',
            replicatedPointers: [
              '/runs/0/facts/sql-function-correction-38',
              '/runs/1/facts/sql-function-correction-38',
            ],
          },
        ],
      },
    ],
  },
]);
__paqParityBindings(import.meta.url, __paqParityShared);

// @parity-evidence: Repeated Microsoft SQL Server 2022 engine captures, mirage/test/fixtures/dataverse-sql-server-function-facts.json SHA-256 e6aa0995861d943219e153b10df0815bd8d62ad7b5c07978f008b02f2f01c9f5; CONCAT_WS NULL separator and PATINDEX anchoring.
import test from 'node:test';
import assert from 'node:assert/strict';
import { FUNCTIONS, callFunction, castValue, returnType, systemVariable } from '../lib/dataverse-tds-sql-functions.mjs';

const utc = (y, mo, d, h = 0, mi = 0, s = 0, ms = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi, s, ms));
const dec = (decimal) => ({ decimal });
const call = (name, args, ctx) => callFunction(name, args, ctx);
const fails = (number, message) => (e) => e.number === number && (message === undefined || e.message === message);

const REQUIRED = [
  'LEN',
  'DATALENGTH',
  'LEFT',
  'RIGHT',
  'SUBSTRING',
  'CHARINDEX',
  'PATINDEX',
  'REPLACE',
  'REPLICATE',
  'REVERSE',
  'LOWER',
  'UPPER',
  'LTRIM',
  'RTRIM',
  'TRIM',
  'CONCAT',
  'CONCAT_WS',
  'STUFF',
  'SPACE',
  'STR',
  'FORMAT',
  'QUOTENAME',
  'ASCII',
  'CHAR',
  'UNICODE',
  'NCHAR',
  'GETDATE',
  'GETUTCDATE',
  'SYSDATETIME',
  'SYSUTCDATETIME',
  'DATEADD',
  'DATEDIFF',
  'DATEPART',
  'DATENAME',
  'YEAR',
  'MONTH',
  'DAY',
  'EOMONTH',
  'DATEFROMPARTS',
  'ISDATE',
  'ABS',
  'CEILING',
  'FLOOR',
  'ROUND',
  'POWER',
  'SQRT',
  'SQUARE',
  'SIGN',
  'EXP',
  'LOG',
  'LOG10',
  'PI',
  'RAND',
  'ISNULL',
  'COALESCE',
  'NULLIF',
  'IIF',
  'CHOOSE',
  'NEWID',
  'CONVERT',
  'TRY_CONVERT',
  'ISNUMERIC',
  'ROWCOUNT_BIG',
  'GETANSINULL',
];

test('every required function is registered and refuses a call outside its arity with 174', () => {
  for (const name of REQUIRED) {
    const f = FUNCTIONS.get(name);
    assert.ok(f, `missing ${name}`);
    for (const count of [f.minArgs - 1, f.maxArgs + 1].filter((n) => n >= 0)) {
      assert.throws(() => call(name, Array(count).fill(1)), fails(174), `${name} with ${count} arguments`);
    }
  }
});

const cases = [
  // NULL propagation
  ['LEN', [null], null],
  ['LEFT', [null, 2], null],
  ['DATEADD', ['day', null, utc(2026, 1, 1)], null],
  ['ROUND', [dec('1.5'), null], null],
  ['CONCAT', ['a', null, 'b'], 'ab'],
  ['CONCAT_WS', [',', 'a', null, 'b'], 'a,b'],
  ['CONCAT_WS', [null, 'a', 'b'], 'ab'],
  ['ISNULL', [null, 'x'], 'x'],
  ['ISNULL', ['y', 'x'], 'y'],
  ['COALESCE', [null, null, 3], 3],
  ['NULLIF', [1, 1], null],
  ['NULLIF', [1, null], 1],
  ['NULLIF', [null, 1], null],
  ['IIF', [null, 1, 2], 2],
  ['IIF', [true, 1, 2], 1],
  ['CHOOSE', [2, 'a', 'b', 'c'], 'b'],
  ['CHOOSE', [4, 'a'], null],
  ['CHOOSE', [null, 'a'], null],
  ['ISNUMERIC', [null], 0],
  ['ISDATE', [null], 0],

  // strings
  ['LEN', ['abc   '], 3],
  ['LEN', [''], 0],
  ['DATALENGTH', ['abc'], 6],
  ['DATALENGTH', [utc(2026, 1, 1)], 8],
  ['LEFT', ['abcdef', 2], 'ab'],
  ['LEFT', ['ab', 5], 'ab'],
  ['RIGHT', ['abcdef', 2], 'ef'],
  ['RIGHT', ['ab', 0], ''],
  ['SUBSTRING', ['abcdef', 2, 3], 'bcd'],
  ['SUBSTRING', ['abc', 0, 2], 'a'],
  ['SUBSTRING', ['abc', 5, 2], ''],
  ['CHARINDEX', ['bicycle', 'Reflectors are vital safety components of your bicycle.'], 48],
  ['CHARINDEX', ['vital', 'Reflectors are vital safety components of your bicycle.', 5], 16],
  ['CHARINDEX', ['bike', 'Reflectors are vital safety components of your bicycle.'], 0],
  ['CHARINDEX', ['vital', 'Reflectors are vital safety components of your bicycle.', 17], 0],
  ['CHARINDEX', ['TEST', 'This is a Test'], 11],
  ['CHARINDEX', ['TEST', 'This is a Test', 1], 0, { caseSensitive: true }],
  ['PATINDEX', ['%[0-9]%', 'abc4'], 4],
  ['PATINDEX', ['a_c', 'zabc'], 0],
  ['PATINDEX', ['%x%', 'abc'], 0],
  ['REPLACE', ['abcabc', 'B', 'X'], 'aXcaXc'],
  ['REPLACE', ['abcabc', 'B', 'X'], 'abcabc', { caseSensitive: true }],
  ['REPLICATE', ['ab', 3], 'ababab'],
  ['REPLICATE', ['a', -1], null],
  ['REVERSE', ['abc'], 'cba'],
  ['LTRIM', ['  a '], 'a '],
  ['RTRIM', ['  a '], '  a'],
  ['TRIM', ['  a  '], 'a'],
  ['TRIM', ['x', 'xxaxx'], 'a'],
  ['STUFF', ['abcdef', 2, 3, 'XY'], 'aXYef'],
  ['STUFF', ['abc', 2, 0, 'X'], 'aXbc'],
  ['STUFF', ['abc', 4, 0, 'x'], null],
  ['SPACE', [3], '   '],
  ['SPACE', [-1], null],
  ['STR', [123.456], '       123'],
  ['STR', [123.456, 6, 2], '123.46'],
  ['STR', [12345, 3], '***'],
  ['QUOTENAME', ['abc[]def'], '[abc[]]def]'],
  ['QUOTENAME', ["user's", "'"], "'user''s'"],
  ['QUOTENAME', ['x', '%'], null],
  ['QUOTENAME', ['a'.repeat(129)], null],
  ['ASCII', ['A'], 65],
  ['ASCII', [''], null],
  ['CHAR', [65], 'A'],
  ['CHAR', [256], null],
  ['UNICODE', ['é'], 233],
  ['NCHAR', [0x20ac], '€'],
  ['NCHAR', [70000], null],
  ['CONCAT', ['a', 1], 'a1'],
  ['FORMAT', [1234.5, '#,##0.00'], '1,234.50'],
  ['FORMAT', [0.5, '0.00'], '0.50'],
  ['FORMAT', [utc(2026, 10, 19, 15, 4, 5), 'yyyy-MM-dd HH:mm:ss'], '2026-10-19 15:04:05'],
  ['FORMAT', [utc(2026, 10, 19), 'dddd'], 'Monday'],
  ['FORMAT', [1234.5, 'N2', 'en-US'], '1,234.50'],
  ['FORMAT', [1234.5, 'N2', 'de-DE'], '1.234,50'],
  ['FORMAT', [1234.5, '#,##0.00', 'de-DE'], '1.234,50'],
  ['FORMAT', [1234.5, 'C', 'en-US'], '$1,234.50'],
  ['FORMAT', [0.5, 'P0', 'en-US'], '50%'],
  ['FORMAT', [utc(2026, 10, 19), 'd'], '10/19/2026'],
  ['FORMAT', [utc(2026, 10, 19), 'd', 'de-DE'], '19.10.2026'],
  ['FORMAT', [utc(2026, 10, 19), 'dddd, dd MMMM yyyy', 'de-DE'], 'Montag, 19 Oktober 2026'],
  ['FORMAT', [1234.5, 'N2', 'xx-YY'], null],
  ['FORMAT', [1234.5, 'N2', 'not a culture'], null],

  // date and time
  ['DATEDIFF', ['day', '2036-03-01', '2036-02-28'], -2],
  ['DATEDIFF', ['day', '2007-05-06 23:59:59.999', '2007-05-07 00:00:00'], 1],
  ['DATEDIFF', ['year', '2000-12-31', '2001-01-01'], 1],
  ['DATEDIFF', ['month', '2026-01-31', '2026-02-01'], 1],
  ['DATEDIFF', ['week', '2026-10-17', '2026-10-18'], 1],
  ['DATEDIFF', ['hour', '2026-01-01 00:59', '2026-01-01 01:00'], 1],
  ['DATEDIFF', ['second', '2026-01-01 00:00:00', '2026-01-01 00:01:30'], 90],
  ['DATEADD', ['month', 1, '2026-01-31'], utc(2026, 2, 28)],
  ['DATEADD', ['day', 1, '2026-02-28'], utc(2026, 3, 1)],
  ['DATEADD', ['year', -1, '2024-02-29'], utc(2023, 2, 28)],
  ['DATEADD', ['hour', 25, '2026-01-01'], utc(2026, 1, 2, 1)],
  ['DATEADD', ['millisecond', 1500, '2026-01-01 00:00:00'], utc(2026, 1, 1, 0, 0, 1, 500)],
  ['DATEPART', ['weekday', utc(2026, 10, 19)], 2],
  ['DATEPART', ['dayofyear', utc(2026, 10, 19)], 292],
  ['DATEPART', ['week', utc(2026, 1, 1)], 1],
  ['DATEPART', ['week', utc(2026, 1, 4)], 2],
  ['DATENAME', ['month', utc(2026, 10, 19)], 'October'],
  ['DATENAME', ['weekday', utc(2026, 10, 19)], 'Monday'],
  ['DATENAME', ['quarter', utc(2026, 10, 19)], '4'],
  ['YEAR', [utc(2026, 10, 19)], 2026],
  ['MONTH', [utc(2026, 10, 19)], 10],
  ['DAY', [utc(2026, 10, 19)], 19],
  ['EOMONTH', ['2026-02-10'], utc(2026, 2, 28)],
  ['EOMONTH', ['2026-02-10', 1], utc(2026, 3, 31)],
  ['EOMONTH', ['2024-02-10'], utc(2024, 2, 29)],
  ['DATEFROMPARTS', [2024, 2, 29], utc(2024, 2, 29)],
  ['ISDATE', ['2026-02-28'], 1],
  ['ISDATE', ['2026-02-30'], 0],

  // math
  ['ABS', [-5], 5],
  ['ABS', [dec('-1.50')], dec('1.50')],
  ['ABS', [-7n], 7n],
  ['CEILING', [dec('1.20')], dec('2')],
  ['FLOOR', [dec('-1.20')], dec('-2')],
  ['CEILING', [-1.5], -1],
  ['FLOOR', [1.5], 1],
  ['ROUND', [dec('123.9994'), 3], dec('123.9990')],
  ['ROUND', [dec('123.9995'), 3], dec('124.0000')],
  ['ROUND', [dec('123.4545'), 2], dec('123.4500')],
  ['ROUND', [dec('123.45'), -2], dec('100.00')],
  ['ROUND', [dec('748.58'), -1], dec('750.00')],
  ['ROUND', [dec('748.58'), -2], dec('700.00')],
  ['ROUND', [dec('748.58'), -4], dec('0.00')],
  ['ROUND', [dec('150.75'), 0], dec('151.00')],
  ['ROUND', [dec('150.75'), 0, 1], dec('150.00')],
  ['ROUND', [dec('1.15'), 1], dec('1.20')],
  ['ROUND', [dec('-1.15'), 1], dec('-1.20')],
  ['ROUND', [2.5, 0], 3],
  ['ROUND', [-2.5, 0], -3],
  ['ROUND', [123.45, -2], 100],
  ['SIGN', [-3], -1],
  ['SIGN', [dec('0.0')], dec('0')],
  ['POWER', [2, 10], 1024],
  ['SQRT', [16], 4],
  ['SQUARE', [3], 9],
  ['EXP', [0], 1],
  ['LOG10', [1000], 3],
  ['PI', [], Math.PI],
];

for (const [name, args, expected, ctx] of cases) {
  test(`${name}(${args.map((a) => (a instanceof Date ? a.toISOString() : typeof a === 'bigint' ? `${a}n` : JSON.stringify(a))).join(', ')})${ctx ? ` ${JSON.stringify(ctx)}` : ''}`, () => {
    __paqParityCaseBindings(
      import.meta.url,
      cases,
      [
        0, 1, 4, 5, 6, 7, 8, 9, 10, 11, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35,
        37, 38, 39, 40, 42, 43, 44, 45, 46, 49, 50, 51, 52, 53, 56, 57, 58, 59, 61, 62, 63, 64, 65, 66, 67, 68, 111,
        132, 134, 135, 136, 137, 138,
      ],
      { name, args, expected, ctx },
      __paqParityShared,
    );
    assert.deepStrictEqual(call(name, args, ctx), expected);
  });
}

test('error cases carry SQL Server numbers', () => {
  assert.throws(() => call('LEFT', ['ab', -1]), fails(536));
  assert.throws(() => call('SUBSTRING', ['abc', 1, -1]), fails(537));
  assert.throws(() => call('ROUND', [dec('748.58'), -3]), fails(8115));
  assert.throws(() => call('POWER', [-8, 1 / 3]), fails(3623));
  assert.throws(() => call('SQRT', [-1]), fails(3623));
  assert.throws(() => call('LOG', [0]), fails(3623));
  assert.throws(() => call('DATEADD', ['year', 8000, '2026-01-01']), fails(517));
  assert.throws(() => call('DATEDIFF', ['millisecond', '1753-01-01', '9999-12-31']), fails(535));
  assert.throws(() => call('DATEFROMPARTS', [2026, 2, 30]), fails(289));
  assert.throws(() => call('DATEADD', ['microsecond', 1, '2026-01-01']), fails(155));
  assert.throws(() => call('FORMAT', ['x', '0']), fails(8116));
  assert.throws(() => call('LEN', []), fails(174));
  assert.throws(() => call('ISNULL', [null]), fails(174));
});

test('unknown and unsupported functions are rejected with the documented shape', () => {
  assert.throws(() => call('NOPE', []), fails(195, "'NOPE' is not a recognized built-in function name."));
  for (const name of ['ROW_NUMBER', 'OBJECT_ID', 'ERROR_MESSAGE', 'STRING_SPLIT', 'JSON_VALUE', 'SERVERPROPERTY']) {
    assert.throws(() => call(name, []), fails(195, `'${name}' is not supported in Dataverse SQL.`));
  }
  assert.equal(call('len', ['ab']), 2);
});

test('datetime functions read the statement clock and seeded RAND is repeatable', () => {
  const now = utc(2026, 1, 2, 3, 4, 5);
  assert.deepStrictEqual(call('GETDATE', [], { now }), now);
  assert.deepStrictEqual(call('SYSUTCDATETIME', [], { now: () => now }), now);
  const a = {};
  const first = call('RAND', [42], a);
  assert.equal(call('RAND', [], a) < 1, true);
  assert.equal(call('RAND', [42], {}), first);
  const id = call('NEWID', [], { newId: () => 'FIXED' });
  assert.equal(id, 'FIXED');
  assert.match(call('NEWID', []), /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/);
  assert.equal(call('ROWCOUNT_BIG', [], { rowCount: 5 }), 5n);
});

const FORMATMESSAGE_CASES = [
  ['%s-%s', ['a', 'b'], 'a-b'],
  ['%5d|', [42], '   42|'],
  ['[%-10s]', ['ab'], `[${'ab'.padEnd(10)}]`],
  ['%.3s', ['abcdef'], 'abc'],
  ['%x %X %o', [255, 255, 8], 'ff FF 10'],
  ['%05d %+d', [42, 5], '00042 +5'],
  ['100%%', [], '100%'],
  ['%s|%d', [null, dec('12.9')], '(null)|12'],
  ['%u %i', [-1, 7n], '4294967295 7'],
];
for (const [message, args, expected] of FORMATMESSAGE_CASES) {
  test(`FORMATMESSAGE(${JSON.stringify(message)}, ${args.length} args)`, () => {
    assert.equal(call('FORMATMESSAGE', [message, ...args]), expected);
  });
}

test('FORMATMESSAGE rejects a message number and missing parameters', () => {
  assert.throws(
    () => call('FORMATMESSAGE', [50001, 'x']),
    fails(195, "'FORMATMESSAGE' is not supported in Dataverse SQL."),
  );
  assert.throws(() => call('FORMATMESSAGE', ['%s %s', 'a']), fails(2787));
});

// Byte order that SQL Server uses for uniqueidentifier comparison: the node bytes first, then the rest.
const sqlGuidOrder = (g) => {
  const bytes = g.replace(/-/g, '').match(/../g);
  return [10, 11, 12, 13, 14, 15, 3, 2, 1, 0, 5, 4, 7, 6, 8, 9].map((i) => bytes[i]).join('');
};
test('NEWSEQUENTIALID returns increasing GUIDs in SQL Server order', () => {
  const guid = /^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$/;
  const first = call('NEWSEQUENTIALID', []);
  const second = call('NEWSEQUENTIALID', []);
  assert.match(first, guid);
  assert.match(second, guid);
  assert.ok(sqlGuidOrder(second) > sqlGuidOrder(first));
});

test('systemVariable exposes @@VERSION and @@ROWCOUNT and rejects unsupported variables', () => {
  assert.equal(systemVariable('@@VERSION'), 'Microsoft SQL Azure (RTM) - 12.0.2000.8');
  assert.equal(systemVariable('@@ROWCOUNT', { rowCount: 3 }), 3);
  assert.throws(() => systemVariable('@@ERROR'), fails(195));
});

test('castValue follows CAST rules and raises the T-SQL conversion errors', () => {
  assert.equal(castValue(' -7 ', 'int'), -7);
  assert.equal(castValue(12.9, 'int'), 12);
  assert.equal(castValue(dec('-12.9'), 'int'), -12);
  assert.equal(castValue(7, 'bigint'), 7n);
  assert.throws(
    () => castValue('12.5', 'int'),
    fails(245, "Conversion failed when converting the nvarchar value '12.5' to data type int."),
  );
  assert.throws(
    () => castValue('abc', 'int'),
    fails(245, "Conversion failed when converting the nvarchar value 'abc' to data type int."),
  );
  assert.throws(() => castValue('3000000000', 'int'), fails(8115));
  assert.deepStrictEqual(castValue('12.345', 'decimal(10,2)'), dec('12.35'));
  assert.throws(() => castValue('1234567890123', 'decimal(5,2)'), fails(8115));
  assert.throws(() => castValue('x', 'decimal(5,2)'), fails(8114));
  assert.equal(castValue('1.5', 'float'), 1.5);
  assert.throws(() => castValue('abc', 'float'), fails(8114));
  assert.equal(castValue('bigtext', 'varchar(3)'), 'big');
  assert.equal(castValue(123, 'varchar'), '123');
  assert.equal(castValue(dec('10.50'), 'nvarchar(10)'), '10.50');
  assert.equal(castValue(true, 'nvarchar'), '1');
  assert.equal(castValue(null, 'int'), null);
  assert.equal(
    castValue('0f8fad5b-d9cb-469f-a165-70867728950e', 'uniqueidentifier'),
    '0F8FAD5B-D9CB-469F-A165-70867728950E',
  );
  assert.throws(() => castValue('nope', 'uniqueidentifier'), fails(8169));
  assert.deepStrictEqual(castValue('1', 'binary'), Buffer.from([0x31]));
  assert.deepStrictEqual(castValue('2026-10-19', 'datetime'), utc(2026, 10, 19));
  assert.deepStrictEqual(castValue('2026-10-19 13:45:10.5', 'datetime'), utc(2026, 10, 19, 13, 45, 10, 500));
  assert.throws(() => castValue('2026-02-30', 'datetime'), fails(241));
  assert.throws(() => castValue('1752-12-31', 'datetime'), fails(242));
});

const STYLE_CASES = [
  ['101', '10/19/2026', utc(2026, 10, 19)],
  ['103', '19/10/2026', utc(2026, 10, 19)],
  ['112', '20261019', utc(2026, 10, 19)],
  ['120', '2026-10-19 13:45:10', utc(2026, 10, 19, 13, 45, 10)],
  ['121', '2026-10-19 13:45:10.123', utc(2026, 10, 19, 13, 45, 10, 123)],
  ['126', '2026-10-19T13:45:10.123', utc(2026, 10, 19, 13, 45, 10, 123)],
];
for (const [style, text, expected] of STYLE_CASES) {
  test(`CONVERT(datetime, '${text}', ${style})`, () => {
    assert.deepStrictEqual(call('CONVERT', ['datetime', text, Number(style)]), expected);
  });
}

const OUT_STYLE_CASES = [
  [0, 'Oct 19 2026 01:45PM'],
  [101, '10/19/2026'],
  [103, '19/10/2026'],
  [112, '20261019'],
  [120, '2026-10-19 13:45:10'],
  [121, '2026-10-19 13:45:10.123'],
  [126, '2026-10-19T13:45:10.123'],
];
for (const [style, expected] of OUT_STYLE_CASES) {
  test(`CONVERT(nvarchar(30), datetime, ${style})`, () => {
    assert.equal(call('CONVERT', ['nvarchar(30)', utc(2026, 10, 19, 13, 45, 10, 123), style]), expected);
  });
}

test('CONVERT and TRY_CONVERT edge cases', () => {
  assert.equal(call('CONVERT', ['int', '12']), 12);
  assert.equal(call('TRY_CONVERT', ['int', 'abc']), null);
  assert.equal(call('TRY_CONVERT', ['int', '12']), 12);
  assert.throws(() => call('TRY_CONVERT', ['nosuchtype', 'x']), fails(2715));
  assert.throws(() => call('CONVERT', ['datetime', '2026-10-19', 999]), fails(9809));
  assert.equal(call('CONVERT', ['nvarchar(3)', 'abcdef']), 'abc');
});

// Binary conversions: text as bytes (varchar single-byte, nvarchar UTF-16LE), integers big-endian, binary(n) pads.
const hex = (buf) => (buf === null ? null : Buffer.from(buf).toString('hex'));
const binaryCases = [
  ['nvarchar text to varbinary is UTF-16LE', () => hex(castValue('ab', 'varbinary(8)')), '61006200'],
  [
    'varchar text to varbinary is single-byte',
    () => hex(castValue('ab', 'varbinary(8)', { fromType: 'varchar' })),
    '6162',
  ],
  ['varbinary truncates text bytes', () => hex(castValue('abcd', 'varbinary(3)', { fromType: 'varchar' })), '616263'],
  ['binary(n) pads with zero bytes', () => hex(castValue('a', 'binary(4)', { fromType: 'varchar' })), '61000000'],
  ['binary(n) truncates', () => hex(castValue('abcd', 'binary(2)', { fromType: 'varchar' })), '6162'],
  ['int is four big-endian bytes', () => hex(castValue(1, 'varbinary(4)')), '00000001'],
  ['negative int keeps two-complement bytes', () => hex(castValue(-1, 'varbinary(4)')), 'ffffffff'],
  ['int padded to binary(8) is zero-filled on the right', () => hex(castValue(258, 'binary(8)')), '0000010200000000'],
  ['bigint is eight big-endian bytes', () => hex(castValue(258n, 'varbinary(8)')), '0000000000000102'],
  ['bit true is one byte', () => hex(castValue(true, 'binary(2)')), '0100'],
  ['bit false pads', () => hex(castValue(false, 'varbinary(2)')), '00'],
  [
    'binary to varbinary(max) keeps all bytes',
    () => hex(castValue(Buffer.from('0102', 'hex'), 'varbinary(max)')),
    '0102',
  ],
  ['binary to binary(4) pads on the right', () => hex(castValue(Buffer.from('0102', 'hex'), 'binary(4)')), '01020000'],
  ['binary to varbinary(1) truncates', () => hex(castValue(Buffer.from('0102', 'hex'), 'varbinary(1)')), '01'],
  ['bare binary is one byte', () => hex(castValue('ab', 'binary', { fromType: 'varchar' })), '61'],
  ['bare varbinary is thirty bytes', () => castValue('x'.repeat(40), 'varbinary', { fromType: 'varchar' }).length, 30],
  ['NULL stays NULL', () => castValue(null, 'varbinary(4)'), null],
  ['binary back to int reads big-endian', () => castValue(Buffer.from('00000102', 'hex'), 'int'), 258],
  ['binary back to nvarchar reads UTF-16LE', () => castValue(Buffer.from('6100', 'hex'), 'nvarchar(4)'), 'a'],
];
for (const [label, run, expected] of binaryCases) {
  test(`binary conversion: ${label}`, () => {
    assert.equal(run(), expected);
  });
}
test('binary(max) is a syntax error (102)', () => {
  assert.throws(() => castValue('a', 'binary(max)'), fails(102));
});
test('dates and decimals do not convert to binary (8114)', () => {
  assert.throws(() => castValue(utc(2026, 10, 19), 'binary(8)'), fails(8114));
  assert.throws(() => castValue(dec('1.5'), 'binary(4)'), fails(8114));
});

// Static return types. Each entry: [label, name, argument types, extra, expected type object or null].
const typeCases = [
  ['LEN is int', 'LEN', [{ type: 'nvarchar', length: 9 }], {}, { type: 'int' }],
  ['UPPER keeps the input length', 'UPPER', [{ type: 'varchar', length: 9 }], {}, { type: 'nvarchar', length: 9 }],
  ['UPPER of a non-text is nvarchar(4000)', 'UPPER', [{ type: 'int' }], {}, { type: 'nvarchar', length: 4000 }],
  [
    'LEFT keeps the input length',
    'LEFT',
    [{ type: 'nvarchar', length: 12 }, { type: 'int' }],
    {},
    { type: 'nvarchar', length: 12 },
  ],
  [
    'CONCAT is nvarchar(4000)',
    'CONCAT',
    [{ type: 'nvarchar', length: 3 }, { type: 'int' }],
    {},
    { type: 'nvarchar', length: 4000 },
  ],
  ['CHAR is nvarchar(1)', 'CHAR', [{ type: 'int' }], {}, { type: 'nvarchar', length: 1 }],
  [
    'DATENAME is nvarchar(4000)',
    'DATENAME',
    [{ type: 'nvarchar' }, { type: 'datetime' }],
    {},
    { type: 'nvarchar', length: 4000 },
  ],
  [
    'ABS keeps a decimal type and scale',
    'ABS',
    [{ type: 'decimal', precision: 10, scale: 2 }],
    {},
    { type: 'decimal', precision: 10, scale: 2 },
  ],
  ['ROUND keeps an int', 'ROUND', [{ type: 'int' }, { type: 'int' }], {}, { type: 'int' }],
  ['CEILING keeps bigint', 'CEILING', [{ type: 'bigint' }], {}, { type: 'bigint' }],
  ['ABS of a string is float', 'ABS', [{ type: 'varchar', length: 5 }], {}, { type: 'float' }],
  ['SQRT of an int is float', 'SQRT', [{ type: 'int' }], {}, { type: 'float' }],
  ['LOG is float', 'LOG', [{ type: 'decimal', precision: 9, scale: 1 }], {}, { type: 'float' }],
  [
    'DATEADD is datetime',
    'DATEADD',
    [{ type: 'nvarchar' }, { type: 'int' }, { type: 'datetime' }],
    {},
    { type: 'datetime' },
  ],
  [
    'DATEDIFF is int',
    'DATEDIFF',
    [{ type: 'nvarchar' }, { type: 'datetime' }, { type: 'datetime' }],
    {},
    { type: 'int' },
  ],
  ['DATEPART is int', 'DATEPART', [{ type: 'nvarchar' }, { type: 'datetime' }], {}, { type: 'int' }],
  ['GETDATE is datetime', 'GETDATE', [], {}, { type: 'datetime' }],
  ['NEWID is uniqueidentifier', 'NEWID', [], {}, { type: 'uniqueidentifier' }],
  ['ROWCOUNT_BIG is bigint', 'ROWCOUNT_BIG', [], {}, { type: 'bigint' }],
  [
    'ISNULL takes the first argument type',
    'ISNULL',
    [{ type: 'nvarchar', length: 5 }, { type: 'int' }],
    {},
    { type: 'nvarchar', length: 5 },
  ],
  ['ISNULL of a NULL takes the second', 'ISNULL', [{ type: 'null' }, { type: 'int' }], {}, { type: 'int' }],
  ['NULLIF takes the first argument type', 'NULLIF', [{ type: 'bigint' }, { type: 'int' }], {}, { type: 'bigint' }],
  [
    'COALESCE takes the highest precedence branch',
    'COALESCE',
    [{ type: 'int' }, { type: 'bigint' }],
    {},
    { type: 'bigint' },
  ],
  [
    'COALESCE of text takes the longer length',
    'COALESCE',
    [
      { type: 'nvarchar', length: 3 },
      { type: 'varchar', length: 9 },
    ],
    {},
    { type: 'nvarchar', length: 9 },
  ],
  [
    'IIF ignores the condition type',
    'IIF',
    [{ type: 'bit' }, { type: 'decimal', precision: 5, scale: 2 }, { type: 'int' }],
    {},
    { type: 'decimal', precision: 5, scale: 2 },
  ],
  [
    'CONVERT takes the target type',
    'CONVERT',
    [{ type: 'nvarchar' }, { type: 'int' }],
    { target: 'varbinary(4)' },
    { type: 'varbinary', length: 4 },
  ],
  [
    'TRY_CONVERT takes the target precision',
    'TRY_CONVERT',
    [{ type: 'nvarchar' }, { type: 'int' }],
    { target: 'decimal(10,3)' },
    { type: 'decimal', precision: 10, scale: 3 },
  ],
  ['an unknown function has no static type', 'NO_SUCH_FUNCTION', [], {}, null],
];
for (const [label, name, args, extra, expected] of typeCases) {
  test(`return type: ${label}`, () => {
    assert.deepEqual(returnType(name, args, extra), expected);
  });
}
