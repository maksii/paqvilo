// @parity-evidence: Existing region assertions and exact reviewed proof bindings are preserved during cumulative qualification.
// @test-kind unproven: Evaluator cases use local SQL models; only separately guarded inputs have independent engine evidence.
import {
  parityCaseBindings as __paqParityCaseBindings,
  assertParityBindings as __paqParityBindings,
  freezeParityDescriptor as __paqParityFreeze,
} from '../../scripts/qualify-parity.mjs';
const __paqParityShared = __paqParityFreeze([
  {
    baselineId: 'mirage/test/dataverse-tds-sql-eval.test.mjs:613:2',
    repositoryRoot: '../..',
    titleExpressionSha256: 'be581c65831be7753511428b9af41aa34354fb1a1d0c095c3ff0d7a9c9f6f7d7',
    sqlEvaluator: true,
    originalCallbackExpression: true,
    conciseSpecs: [
      {
        titleExpressionSha256: 'e1029afd41ccc7d78fa675eac599b649c34c808a3c24ab761add7f43cde8bc1f',
        loopHeaders: ['63c7378b0a3b44124752c7015b208d77bbf9d63458f76746883876e69d31f86e'],
      },
      { titleExpressionSha256: 'be581c65831be7753511428b9af41aa34354fb1a1d0c095c3ff0d7a9c9f6f7d7' },
      { titleExpressionSha256: '18882a870c763a07a4194624833d5892989d8b8e83719c8e4ec5b21a349fe210' },
      {
        titleExpressionSha256: 'e1029afd41ccc7d78fa675eac599b649c34c808a3c24ab761add7f43cde8bc1f',
        loopHeaders: ['9e67bd105f11b35ae5b8da3f38aa00cab09127bc6b2267bb19d55b88195f1adf'],
      },
    ],
    originalAssertions: ['6c0ca2dc6183ccaf46ffe8c06f2dc4987820ded984d5aad5a0614a93b65f0e4b'],
    originalBodyAstSha256: '6c0ca2dc6183ccaf46ffe8c06f2dc4987820ded984d5aad5a0614a93b65f0e4b',
    originalGuardHashes: [],
    moduleContextAstSha256: 'b09d8ca279ffe1375336f891c9b89d142bb10db2a4e93d39cbfd9de6902a2a2f',
    moduleReview: {
      reviewedBy: 'sql_parity',
      reason:
        'Existing engine-proven expectation corrections are preserved exactly; all other source context and assertions remain unchanged.',
      corrections: [],
      addedTests: [],
      fixtureCorrections: [
        {
          binding: 'semanticCases',
          index: 11,
          expectedIndex: 2,
          oldAstSha256: '62ff00f909285102cff85690cf89ef3b67bbf349a80d8fbe604536e14d6310a7',
          currentAstSha256: 'a2ffef9f6b0292a2f2ef78313392250fe4f14265e60e7d675f68f987d3107da8',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-11'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 12,
          expectedIndex: 2,
          oldAstSha256: '041f2b2e4ada7500fb2391e4f4092847d590a3c0fbfe29cfbafadef8a4fed73f',
          currentAstSha256: 'e248951d4bc9db24c8e94181e31ab7bc37285e8a62ad6f6770181bb9c661445c',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-12'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 19,
          expectedIndex: 2,
          oldAstSha256: '93e57cb3679bba3efe010be7841780a36d55a3f33379a2275689e16df7ba7b96',
          currentAstSha256: 'ff9ca36d2a51466d612c484b0d4a10402b646427598ec96bfc765f1758033d19',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-19'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 20,
          expectedIndex: 2,
          oldAstSha256: 'e46eb7a5ced30979951cd1058f056bf5ba1e47f540430d9fb68d54bc9f9a068e',
          currentAstSha256: '2a0deadf2c208af0420b30eba05756fa585cfebdbfbce2951a4d4a6c04f21c04',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-20'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 21,
          expectedIndex: 2,
          oldAstSha256: '3de59fd2b731daa5f3a941c947f98cb6c6517a59f3e0eff0021a304f0cce52fa',
          currentAstSha256: '0bfa743b12232a98f4f0cfc392a739e33ca489aba927329ad788a1cf050544eb',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-21'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 22,
          expectedIndex: 2,
          oldAstSha256: '6a210ceffba4d35118e256f138f58e311aafb0641ae5eb62d3d6aa59c10bfc68',
          currentAstSha256: 'f44305258bdac70b04be0e31a7a587abe9f406b7db2b5bf3f699411d7beb24a1',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-22'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 41,
          expectedIndex: 2,
          oldAstSha256: '69d9f52c47e95b49ccdafce89d75b7de5aaf8f42ba305ab59e4872fece2c058c',
          currentAstSha256: '826bcf550e74361b5ce02fc3e356077c8c4dc73fcab91e3024772756162ca283',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-41'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'semanticCases',
          index: 44,
          expectedIndex: 2,
          oldAstSha256: '2af7fc27fdd1c5c45c98c35d8941f78232faf48861486b1ef081dad25247e330',
          currentAstSha256: '9d0ce680dc6298ed2ae9d833a0117a03f0701f5f6316a31837400521c57da493',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-semanticCases-44'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
        {
          binding: 'orderedCases',
          index: 11,
          expectedIndex: 2,
          oldAstSha256: '18405a7ef4796ae3910241cad90366755dc5428db680dfbcc01daa6044d9d3f0',
          currentAstSha256: '531bb28317f73dda7075f5324e9a68e537bf3f74a4e90d6612e06927d48a1be0',
          sameGuarantee: true,
          guaranteeId: 'sql-server-evaluator-fixed-expressions',
          factIds: ['sql-eval-correction-orderedCases-11'],
          reviewedBy: 'sql_parity',
          reason:
            'Repeated official SQL Server captures of the unchanged statement support this existing expected-value correction.',
        },
      ],
    },
    importRoles: [
      {
        source: '../lib/dataverse-tds-sql-eval.mjs',
        role: 'implementation-under-test',
        reviewedBy: 'sql_parity',
        reason: 'The original evaluator implementation is exercised by the unchanged helper.',
      },
    ],
    runtimeInputs: [],
    inputDependencies: [
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-evaluator-corrections-review-v1.json',
        sha256: '81f25a82d097c19a2245951d6083cb6acdd0a2ab8369a1888abe64a1bee0f52c',
      },
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-evaluator-review-v1.json',
        sha256: '0d697976587a36d18a1309be96aba48fe70f401a6a6f1e0045724a2bbd58c5c7',
      },
    ],
    sourceBindings: [
      {
        name: 'semanticCases',
        initializerAstSha256: '4bff6eafe0048df2a5ce0f78e995cd798f2ba80c620e6938c90934338ad72419',
      },
    ],
    baselineSourceBindings: [
      {
        name: 'semanticCases',
        initializerAstSha256: '2117761e977538298004f23bbc52297095fd627a861cc56201c032a8545e8a0d',
      },
    ],
    loopHeaders: ['009c01860fa405eca9d01cd9244742216a20578e69efd0b09cbf89f02c3c0c49'],
    caseUniverse: {
      encoding: 'sql-eval-v1',
      count: 52,
      cases: [
        'T-SQL semantics: decimal division keeps scale 6 for an integer literal divisor',
        'T-SQL semantics: decimal 1 / 3.0 has scale 6',
        'T-SQL semantics: decimal 10 / 3.0',
        'T-SQL semantics: negative decimal division truncates toward zero',
        'T-SQL semantics: decimal multiplication adds scales',
        'T-SQL semantics: decimal subtraction is exact',
        'T-SQL semantics: decimal modulo',
        'T-SQL semantics: a float literal divides as float',
        'T-SQL semantics: CAST to float divides as float',
        'T-SQL semantics: declared decimal(10,2) variable divides exactly',
        'T-SQL semantics: int overflow is 8115',
        'T-SQL semantics: bigint overflow is 8115',
        'T-SQL semantics: bigint product in range',
        'T-SQL semantics: decimal overflow is 8115',
        'T-SQL semantics: decimal divide by zero is 8134',
        'T-SQL semantics: string converts to int in arithmetic',
        'T-SQL semantics: non-numeric string in arithmetic is 245',
        'T-SQL semantics: string with a fraction against int is 245',
        'T-SQL semantics: string against decimal converts to decimal',
        'T-SQL semantics: string compares with int',
        'T-SQL semantics: string compares with decimal',
        'T-SQL semantics: non-numeric string compared with int is 245',
        'T-SQL semantics: malformed date string compared with datetime is 241',
        'T-SQL semantics: DECLARE int converts the string',
        'T-SQL semantics: DECLARE nvarchar(3) truncates',
        'T-SQL semantics: DECLARE decimal(10,2) keeps scale',
        'T-SQL semantics: DECLARE int overflow is 8115',
        'T-SQL semantics: SET converts to the declared type',
        'T-SQL semantics: SELECT assignment truncates to the declared type',
        'T-SQL semantics: WHERE on a bare int column is 4145',
        'T-SQL semantics: WHERE on arithmetic is 4145',
        'T-SQL semantics: searched CASE WHEN on a literal is 4145',
        'T-SQL semantics: ON on a bare column is 4145',
        'T-SQL semantics: HAVING on a literal is 4145',
        'T-SQL semantics: a comparison predicate is still boolean',
        'T-SQL semantics: datetime plus days',
        'T-SQL semantics: int plus datetime',
        'T-SQL semantics: datetime minus a fractional day',
        'T-SQL semantics: datetime plus days past 9999 is 517',
        'T-SQL semantics: datetime times int is 8117',
        'T-SQL semantics: datetime plus datetime is 206',
        'T-SQL semantics: binary literal equals the int it encodes',
        "T-SQL semantics: CAST binary to int reads two's complement",
        'T-SQL semantics: odd-length binary literal pads with a zero',
        'T-SQL semantics: binary arithmetic is 402',
        'T-SQL semantics: DISTINCT with ORDER BY a column outside the list is 145',
        'T-SQL semantics: DISTINCT with ORDER BY a listed column by name passes',
        'T-SQL semantics: DISTINCT with ORDER BY an ordinal passes',
        'T-SQL semantics: star over a JOIN with a shared column name is 40000',
        'T-SQL semantics: a star inside EXISTS may repeat names',
        'T-SQL semantics: aggregate in ON is 147',
        'T-SQL semantics: aggregate inside a subquery in ON is 147',
      ],
      casesSha256: '189f78a485accfcb87ee57a39fd39ba9ac5015536a6997c01285cae688e8f212',
      currentCaseBindingsSha256: '4b3325cc00c11ab84c78e6619efbdef07e3fe10579417bc87c690d80aeb552cf',
      sourceBindings: [
        {
          name: 'semanticCases',
          initializerAstSha256: '2117761e977538298004f23bbc52297095fd627a861cc56201c032a8545e8a0d',
        },
      ],
      ancestorLoops: [{ headerAstSha256: '009c01860fa405eca9d01cd9244742216a20578e69efd0b09cbf89f02c3c0c49' }],
      caseBindingsSha256: '92002479b0c66f232c7ef676113fe80c92590bd9626594a0d1a4c68ae7c8019a',
    },
    caseSelection: {
      selected: [
        { caseIndex: 0, factIds: ['sql-eval-semantic-0'] },
        { caseIndex: 1, factIds: ['sql-eval-semantic-1'] },
        { caseIndex: 2, factIds: ['sql-eval-semantic-2'] },
        { caseIndex: 3, factIds: ['sql-eval-semantic-3'] },
        { caseIndex: 4, factIds: ['sql-eval-semantic-4'] },
        { caseIndex: 5, factIds: ['sql-eval-semantic-5'] },
        { caseIndex: 6, factIds: ['sql-eval-semantic-6'] },
        { caseIndex: 7, factIds: ['sql-eval-semantic-7'] },
        { caseIndex: 8, factIds: ['sql-eval-semantic-8'] },
        { caseIndex: 10, factIds: ['sql-eval-semantic-10'] },
        { caseIndex: 13, factIds: ['sql-eval-semantic-13'] },
        { caseIndex: 14, factIds: ['sql-eval-semantic-14'] },
        { caseIndex: 15, factIds: ['sql-eval-semantic-15'] },
        { caseIndex: 16, factIds: ['sql-eval-semantic-16'] },
        { caseIndex: 17, factIds: ['sql-eval-semantic-17'] },
        { caseIndex: 18, factIds: ['sql-eval-semantic-18'] },
        { caseIndex: 30, factIds: ['sql-eval-semantic-30'] },
        { caseIndex: 31, factIds: ['sql-eval-semantic-31'] },
        { caseIndex: 34, factIds: ['sql-eval-semantic-34'] },
        { caseIndex: 42, factIds: ['sql-eval-semantic-42'] },
        { caseIndex: 43, factIds: ['sql-eval-semantic-43'] },
      ],
      encoding: 'sql-eval-v1',
      bindings: [
        {
          label: 'decimal division keeps scale 6 for an integer literal divisor',
          sql: 'SELECT 7.0 / 2 AS d',
          expected: [['3.500000']],
        },
        { label: 'decimal 1 / 3.0 has scale 6', sql: 'SELECT 1 / 3.0 AS d', expected: [['0.333333']] },
        { label: 'decimal 10 / 3.0', sql: 'SELECT 10 / 3.0 AS d', expected: [['3.333333']] },
        {
          label: 'negative decimal division truncates toward zero',
          sql: 'SELECT -7.0 / 2 AS d',
          expected: [['-3.500000']],
        },
        { label: 'decimal multiplication adds scales', sql: 'SELECT 7.0 * 2.5 AS d', expected: [['17.50']] },
        { label: 'decimal subtraction is exact', sql: 'SELECT 7.5 - 0.25 AS d', expected: [['7.25']] },
        { label: 'decimal modulo', sql: 'SELECT 7 % 3.0 AS d', expected: [['1.0']] },
        { label: 'a float literal divides as float', sql: 'SELECT 7.0E0 / 2 AS d', expected: [[3.5]] },
        { label: 'CAST to float divides as float', sql: 'SELECT CAST(1 AS float) / 4 AS d', expected: [[0.25]] },
        {
          label: 'declared decimal(10,2) variable divides exactly',
          sql: 'DECLARE @p decimal(10,2) = 7; SELECT @p / 2 AS d',
          expected: [['3.500000']],
        },
        { label: 'int overflow is 8115', sql: 'SELECT 2147483647 + 1 AS d', expected: { error: 8115 } },
        {
          label: 'bigint overflow is 8115',
          sql: 'SELECT 9223372036854775807 + 1 AS d',
          expected: [['9223372036854775808']],
        },
        {
          label: 'bigint product in range',
          sql: 'SELECT 2147483647 * 4294967296 AS d',
          expected: [['9223372032559808512']],
        },
        {
          label: 'decimal overflow is 8115',
          sql: "SELECT CAST('99999999999999999999999999999999999999' AS decimal(38,0)) * 10 AS d",
          expected: { error: 8115 },
        },
        { label: 'decimal divide by zero is 8134', sql: 'SELECT 1.0 / 0 AS d', expected: { error: 8134 } },
        { label: 'string converts to int in arithmetic', sql: "SELECT '5' + 1 AS d", expected: [[6]] },
        { label: 'non-numeric string in arithmetic is 245', sql: "SELECT 'x' + 1 AS d", expected: { error: 245 } },
        { label: 'string with a fraction against int is 245', sql: "SELECT '2.5' * 2 AS d", expected: { error: 245 } },
        { label: 'string against decimal converts to decimal', sql: "SELECT '2.5' * 2.0 AS d", expected: [['5.00']] },
        { label: 'string compares with int', sql: "SELECT 1 = '1' AS d", expected: { error: 102 } },
        { label: 'string compares with decimal', sql: "SELECT 2.5 = '2.50' AS d", expected: { error: 102 } },
        {
          label: 'non-numeric string compared with int is 245',
          sql: "SELECT 'abc' = 1 AS d",
          expected: { error: 156 },
        },
        {
          label: 'malformed date string compared with datetime is 241',
          sql: "SELECT '2020-13-01' = CAST('2020-01-01' AS datetime) AS d",
          expected: { error: 156 },
        },
        { label: 'DECLARE int converts the string', sql: "DECLARE @n int = '5'; SELECT @n AS n", expected: [[5]] },
        {
          label: 'DECLARE nvarchar(3) truncates',
          sql: "DECLARE @s nvarchar(3) = 'abcdef'; SELECT @s AS s",
          expected: [['abc']],
        },
        {
          label: 'DECLARE decimal(10,2) keeps scale',
          sql: 'DECLARE @p decimal(10,2) = 7; SELECT @p AS p',
          expected: [['7.00']],
        },
        {
          label: 'DECLARE int overflow is 8115',
          sql: 'DECLARE @n int = 3000000000; SELECT @n AS n',
          expected: { error: 8115 },
        },
        {
          label: 'SET converts to the declared type',
          sql: "DECLARE @n int; SET @n = '7'; SELECT @n AS n",
          expected: [[7]],
        },
        {
          label: 'SELECT assignment truncates to the declared type',
          sql: "DECLARE @s nvarchar(2); SELECT @s = 'xyz'; SELECT @s AS s",
          expected: [['xy']],
        },
        {
          label: 'WHERE on a bare int column is 4145',
          sql: 'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity',
          expected: { error: 4145 },
        },
        { label: 'WHERE on arithmetic is 4145', sql: 'SELECT 1 AS d WHERE 1 + 1', expected: { error: 4145 } },
        {
          label: 'searched CASE WHEN on a literal is 4145',
          sql: "SELECT CASE WHEN 1 THEN 'y' END AS d",
          expected: { error: 4145 },
        },
        {
          label: 'ON on a bare column is 4145',
          sql: 'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON p.contoso_cost',
          expected: { error: 4145 },
        },
        {
          label: 'HAVING on a literal is 4145',
          sql: 'SELECT p.contoso_code AS c FROM contoso_part p HAVING 1',
          expected: { error: 4145 },
        },
        { label: 'a comparison predicate is still boolean', sql: 'SELECT 1 AS d WHERE 1 = 1', expected: [[1]] },
        {
          label: 'datetime plus days',
          sql: "DECLARE @d datetime = '2020-01-01'; SELECT @d + 1 AS d",
          expected: [['2020-01-02T00:00:00.000Z']],
        },
        {
          label: 'int plus datetime',
          sql: "DECLARE @d datetime = '2020-01-01'; SELECT 1 + @d AS d",
          expected: [['2020-01-02T00:00:00.000Z']],
        },
        {
          label: 'datetime minus a fractional day',
          sql: "DECLARE @d datetime = '2020-01-01 12:00'; SELECT @d - 0.5 AS d",
          expected: [['2020-01-01T00:00:00.000Z']],
        },
        {
          label: 'datetime plus days past 9999 is 517',
          sql: "DECLARE @d datetime = '9999-12-31'; SELECT @d + 1 AS d",
          expected: { error: 517 },
        },
        {
          label: 'datetime times int is 8117',
          sql: "DECLARE @d datetime = '2020-01-01'; SELECT @d * 2 AS d",
          expected: { error: 8117 },
        },
        {
          label: 'datetime plus datetime is 206',
          sql: "DECLARE @d datetime = '2020-01-01'; SELECT @d + @d AS d",
          expected: { error: 206 },
        },
        {
          label: 'binary literal equals the int it encodes',
          sql: 'SELECT 0x0102 = 258 AS d',
          expected: { error: 102 },
        },
        {
          label: "CAST binary to int reads two's complement",
          sql: 'SELECT CAST(0xFFFFFFFF AS int) AS d',
          expected: [[-1]],
        },
        { label: 'odd-length binary literal pads with a zero', sql: 'SELECT CAST(0x1 AS int) AS d', expected: [[1]] },
        { label: 'binary arithmetic is 402', sql: 'SELECT 0x41 + 1 AS d', expected: [[66]] },
        {
          label: 'DISTINCT with ORDER BY a column outside the list is 145',
          sql: 'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY p.contoso_cost',
          expected: { error: 145 },
        },
        {
          label: 'DISTINCT with ORDER BY a listed column by name passes',
          sql: 'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY p.contoso_code',
          expected: [[null], ['X-1'], ['X-2'], ['Y-1']],
        },
        {
          label: 'DISTINCT with ORDER BY an ordinal passes',
          sql: 'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY 1',
          expected: [[null], ['X-1'], ['X-2'], ['Y-1']],
        },
        {
          label: 'star over a JOIN with a shared column name is 40000',
          sql: 'SELECT * FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid',
          expected: { error: 40000 },
        },
        {
          label: 'a star inside EXISTS may repeat names',
          sql: 'SELECT 1 AS d WHERE EXISTS (SELECT * FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid)',
          expected: [[1]],
        },
        {
          label: 'aggregate in ON is 147',
          sql: 'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON COUNT(*) > 0',
          expected: { error: 147 },
        },
        {
          label: 'aggregate inside a subquery in ON is 147',
          sql: 'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON p.contoso_cost = (SELECT MAX(x.contoso_cost) AS m FROM contoso_part x)',
          expected: { error: 147 },
        },
      ],
      source: 'semanticCases',
      names: ['label', 'sql', 'expected'],
      parentKinds: ['unproven'],
    },
    proofs: [
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-evaluator-facts-v1.json',
        sha256: 'd3822bc8898acafde9c564db8cc7bf225df259de192663a73537253aad8bc7fc',
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
            id: 'sql-eval-semantic-0',
            pointer: '/runs/0/facts/sql-eval-semantic-0',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-0', '/runs/1/facts/sql-eval-semantic-0'],
            sha256: '1a542a5f8fd42bbdacb8ee9a49f0669505ac1c8897ac975df1e26b9560a148b3',
          },
          {
            id: 'sql-eval-semantic-1',
            pointer: '/runs/0/facts/sql-eval-semantic-1',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-1', '/runs/1/facts/sql-eval-semantic-1'],
            sha256: 'fdf0f400af7a3d73f6335aac87723fdcbb08ebd7687a7fb019c6479c1359b5f1',
          },
          {
            id: 'sql-eval-semantic-2',
            pointer: '/runs/0/facts/sql-eval-semantic-2',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-2', '/runs/1/facts/sql-eval-semantic-2'],
            sha256: '231201157ae4d599560dc0e61cf5d1d4b3391eae4487dc83c57c917aed9a694a',
          },
          {
            id: 'sql-eval-semantic-3',
            pointer: '/runs/0/facts/sql-eval-semantic-3',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-3', '/runs/1/facts/sql-eval-semantic-3'],
            sha256: '16913734ddedc3ad78bd38ffec5b23aeca6055d954564c689f19b32436ae86f9',
          },
          {
            id: 'sql-eval-semantic-4',
            pointer: '/runs/0/facts/sql-eval-semantic-4',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-4', '/runs/1/facts/sql-eval-semantic-4'],
            sha256: 'a0a4c3a21318b16a036cd7b6a9779d9cadd85caf71cca673a56a16d42cba1303',
          },
          {
            id: 'sql-eval-semantic-5',
            pointer: '/runs/0/facts/sql-eval-semantic-5',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-5', '/runs/1/facts/sql-eval-semantic-5'],
            sha256: '10c9b685cfdec88fe58126f68e7615a1a23ff3ac270a26771d4e8289ff40b442',
          },
          {
            id: 'sql-eval-semantic-6',
            pointer: '/runs/0/facts/sql-eval-semantic-6',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-6', '/runs/1/facts/sql-eval-semantic-6'],
            sha256: '9a606354c21cbb31e884acb247925b8c86f6f9feaf4f0766261cb8e8543c4984',
          },
          {
            id: 'sql-eval-semantic-7',
            pointer: '/runs/0/facts/sql-eval-semantic-7',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-7', '/runs/1/facts/sql-eval-semantic-7'],
            sha256: '364ec90995edb05821e718501147ca73d9c1f95ae7a7669a84f5fd8b9fc7bed6',
          },
          {
            id: 'sql-eval-semantic-8',
            pointer: '/runs/0/facts/sql-eval-semantic-8',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-8', '/runs/1/facts/sql-eval-semantic-8'],
            sha256: 'a44643a58f6f6e6e5711a46b841aeed537b4b144b88f1ac8e46ba4ca7905bb82',
          },
          {
            id: 'sql-eval-semantic-10',
            pointer: '/runs/0/facts/sql-eval-semantic-10',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-10', '/runs/1/facts/sql-eval-semantic-10'],
            sha256: '24620e8b36ef25e1ee4d323943a1f5c700a3e78ba4c2559f967f99d0e36cca0f',
          },
          {
            id: 'sql-eval-semantic-13',
            pointer: '/runs/0/facts/sql-eval-semantic-13',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-13', '/runs/1/facts/sql-eval-semantic-13'],
            sha256: 'c961c657dd5d57837d27919941565c5cd1c68578ffdbce91a298f1d35a316377',
          },
          {
            id: 'sql-eval-semantic-14',
            pointer: '/runs/0/facts/sql-eval-semantic-14',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-14', '/runs/1/facts/sql-eval-semantic-14'],
            sha256: '1d6a454217ac31b0f7f4952f3be36174fa7f006c9485b3f6f1502acaf314037c',
          },
          {
            id: 'sql-eval-semantic-15',
            pointer: '/runs/0/facts/sql-eval-semantic-15',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-15', '/runs/1/facts/sql-eval-semantic-15'],
            sha256: 'a7ee763223d1258b1bdf8743ce43e60a335481f9d69cc4ac7be652d58a2ca692',
          },
          {
            id: 'sql-eval-semantic-16',
            pointer: '/runs/0/facts/sql-eval-semantic-16',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-16', '/runs/1/facts/sql-eval-semantic-16'],
            sha256: '75d74c50903f3e6e19ac18c1292de7311e90768a869d91070b004ef823e8faf4',
          },
          {
            id: 'sql-eval-semantic-17',
            pointer: '/runs/0/facts/sql-eval-semantic-17',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-17', '/runs/1/facts/sql-eval-semantic-17'],
            sha256: '5aced3c236b3f8fb736e044162865d907bb17d3eaead4ca02fe3ca21bbce6e63',
          },
          {
            id: 'sql-eval-semantic-18',
            pointer: '/runs/0/facts/sql-eval-semantic-18',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-18', '/runs/1/facts/sql-eval-semantic-18'],
            sha256: 'af9c37b797c08e8bfabfa03abce430f1a7b4fc09a6ba4ff06a53763fbf698a0a',
          },
          {
            id: 'sql-eval-semantic-30',
            pointer: '/runs/0/facts/sql-eval-semantic-30',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-30', '/runs/1/facts/sql-eval-semantic-30'],
            sha256: '272ffe024403a31e3388208f25651587599aa43b30bfc11f0e7b957e5d06d9b1',
          },
          {
            id: 'sql-eval-semantic-31',
            pointer: '/runs/0/facts/sql-eval-semantic-31',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-31', '/runs/1/facts/sql-eval-semantic-31'],
            sha256: '35b640de988bde1e7b957c9b47f288213e81908c4ad4bb7047c058cc7627f83e',
          },
          {
            id: 'sql-eval-semantic-34',
            pointer: '/runs/0/facts/sql-eval-semantic-34',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-34', '/runs/1/facts/sql-eval-semantic-34'],
            sha256: '1627236f1f8faf6915bbb3ad6410ea02826b97586633d0ea2d95d4be13bd7507',
          },
          {
            id: 'sql-eval-semantic-42',
            pointer: '/runs/0/facts/sql-eval-semantic-42',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-42', '/runs/1/facts/sql-eval-semantic-42'],
            sha256: 'b4afaa91ca24eb2d2e88355d17b312b19b1edd888770435e9a4cf930e255a0b3',
          },
          {
            id: 'sql-eval-semantic-43',
            pointer: '/runs/0/facts/sql-eval-semantic-43',
            replicatedPointers: ['/runs/0/facts/sql-eval-semantic-43', '/runs/1/facts/sql-eval-semantic-43'],
            sha256: '594afdcf3d33e5a99b7da77e96362aaa2b7c576722e0df479a97ea0fbfe3601b',
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/dataverse-sql-server-evaluator-corrections-v1.json',
        sha256: '95727620ce55bfb4ad3f3d61f54a65ef1d4b2b9963a88a1d7eb53f6e388358d2',
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
            id: 'sql-eval-correction-semanticCases-11',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-11',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-11',
              '/runs/1/facts/sql-eval-correction-semanticCases-11',
            ],
            sha256: 'd3de0203daa83af730e352b5579b5884e702928f1432c87a8c4ec9d9a307a671',
          },
          {
            id: 'sql-eval-correction-semanticCases-12',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-12',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-12',
              '/runs/1/facts/sql-eval-correction-semanticCases-12',
            ],
            sha256: 'f12e26f75b6501c88b022e694562fb28b80cd3ed738e9b882ebe61ef8d8036b5',
          },
          {
            id: 'sql-eval-correction-semanticCases-19',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-19',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-19',
              '/runs/1/facts/sql-eval-correction-semanticCases-19',
            ],
            sha256: '3c407ffd95f4f0a10ef9850cf5233a33edb417b87ec43ef5ba808bdc39c6000e',
          },
          {
            id: 'sql-eval-correction-semanticCases-20',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-20',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-20',
              '/runs/1/facts/sql-eval-correction-semanticCases-20',
            ],
            sha256: 'ee679ecf5f50f6d1aed03fe9bed0a00851547e10baf89454b0a58ace2f07f065',
          },
          {
            id: 'sql-eval-correction-semanticCases-21',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-21',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-21',
              '/runs/1/facts/sql-eval-correction-semanticCases-21',
            ],
            sha256: '28f304cbadba89f89b9d40537a140596971ac6cc0f1222d005a7ac7373275b45',
          },
          {
            id: 'sql-eval-correction-semanticCases-22',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-22',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-22',
              '/runs/1/facts/sql-eval-correction-semanticCases-22',
            ],
            sha256: '1275ea5991de95530486f5ec28b59372373f3f679ac3fd66c42a7839abeb8e01',
          },
          {
            id: 'sql-eval-correction-semanticCases-41',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-41',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-41',
              '/runs/1/facts/sql-eval-correction-semanticCases-41',
            ],
            sha256: 'db92c080b199859ee3d5a145fc2dc6536e3fb65d0169dda69992c33165a00d80',
          },
          {
            id: 'sql-eval-correction-semanticCases-44',
            pointer: '/runs/0/facts/sql-eval-correction-semanticCases-44',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-semanticCases-44',
              '/runs/1/facts/sql-eval-correction-semanticCases-44',
            ],
            sha256: '2a22dfa8a8a9632de31be74582ccb55f412b71b894298682778f7e9400292f7b',
          },
          {
            id: 'sql-eval-correction-orderedCases-11',
            pointer: '/runs/0/facts/sql-eval-correction-orderedCases-11',
            replicatedPointers: [
              '/runs/0/facts/sql-eval-correction-orderedCases-11',
              '/runs/1/facts/sql-eval-correction-orderedCases-11',
            ],
            sha256: 'f494ee8045e2191e863bdb2514ea1967a05d10a9e7a4dd5611ece79a9edc1457',
          },
        ],
      },
    ],
  },
]);
__paqParityBindings(import.meta.url, __paqParityShared);

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { executeBatch } from '../lib/dataverse-tds-sql-eval.mjs';

// Schema and rows: contoso_widget and contoso_part.

const col = (name, sqlType, extra = {}) => ({
  name,
  sqlType,
  length: null,
  precision: null,
  scale: null,
  nullable: true,
  ...extra,
});

const catalog = {
  tables: new Map([
    [
      'contoso_widget',
      {
        logicalName: 'contoso_widget',
        columns: [
          col('contoso_widgetid', 'uniqueidentifier', { nullable: false }),
          col('contoso_name', 'nvarchar', { length: 100 }),
          col('contoso_ownerid', 'uniqueidentifier'),
          col('contoso_owneridname', 'nvarchar', { length: 160 }),
          col('contoso_status', 'int'),
          col('contoso_statusname', 'nvarchar', { length: 100 }),
          col('contoso_price', 'money', { precision: 19, scale: 4 }),
          col('contoso_quantity', 'int'),
          col('contoso_active', 'bit'),
          col('contoso_created', 'datetime'),
        ],
      },
    ],
    [
      'contoso_part',
      {
        logicalName: 'contoso_part',
        columns: [
          col('contoso_partid', 'uniqueidentifier', { nullable: false }),
          col('contoso_widgetid', 'uniqueidentifier'),
          col('contoso_widgetidname', 'nvarchar', { length: 160 }),
          col('contoso_code', 'nvarchar', { length: 20 }),
          col('contoso_cost', 'int'),
        ],
      },
    ],
  ]),
};

const W1 = '00000000-0000-0000-0000-000000000001';
const W2 = '00000000-0000-0000-0000-000000000002';
const W3 = '00000000-0000-0000-0000-000000000003';
const W4 = '00000000-0000-0000-0000-000000000004';
const ANN = '00000000-0000-0000-0000-0000000000A1';
const BOB = '00000000-0000-0000-0000-0000000000B2';

const widgets = [
  {
    contoso_widgetid: W1,
    contoso_name: 'Bolt',
    contoso_ownerid: ANN,
    contoso_owneridname: 'Ann',
    contoso_status: 1,
    contoso_statusname: 'Active',
    contoso_price: { decimal: '2.5000' },
    contoso_quantity: 10,
    contoso_active: true,
    contoso_created: new Date('2026-01-02T03:04:05Z'),
  },
  {
    contoso_widgetid: W2,
    contoso_name: 'Nut',
    contoso_ownerid: BOB,
    contoso_owneridname: 'Bob',
    contoso_status: 2,
    contoso_statusname: 'Inactive',
    contoso_price: { decimal: '1.2500' },
    contoso_quantity: 0,
    contoso_active: false,
    contoso_created: new Date('2026-02-01T00:00:00Z'),
  },
  {
    contoso_widgetid: W3,
    contoso_name: 'Gear',
    contoso_ownerid: null,
    contoso_owneridname: null,
    contoso_status: 1,
    contoso_statusname: 'Active',
    contoso_price: { decimal: '10.0000' },
    contoso_quantity: null,
    contoso_active: null,
    contoso_created: null,
  },
  {
    contoso_widgetid: W4,
    contoso_name: 'bolt pack',
    contoso_ownerid: ANN,
    contoso_owneridname: 'Ann',
    contoso_status: null,
    contoso_statusname: null,
    contoso_price: { decimal: '0.5000' },
    contoso_quantity: 3,
    contoso_active: true,
    contoso_created: null,
  },
];

const parts = [
  { contoso_partid: 'P1', contoso_widgetid: W1, contoso_widgetidname: 'Bolt', contoso_code: 'X-1', contoso_cost: 4 },
  { contoso_partid: 'P2', contoso_widgetid: W1, contoso_widgetidname: 'Bolt', contoso_code: 'X-2', contoso_cost: 9 },
  { contoso_partid: 'P3', contoso_widgetid: W3, contoso_widgetidname: 'Gear', contoso_code: 'Y-1', contoso_cost: 1 },
  { contoso_partid: 'P4', contoso_widgetid: null, contoso_widgetidname: null, contoso_code: null, contoso_cost: null },
];

const data = { contoso_widget: widgets, contoso_part: parts };
const NOW = new Date('2026-06-15T12:00:00Z');

// Scan stub: counts calls per table and returns copies keyed by column name.
function makeScan(source = data) {
  const calls = {};
  const scan = async (name) => {
    calls[name] = (calls[name] ?? 0) + 1;
    return (source[name] ?? []).map((row) => ({ ...row }));
  };
  return { scan, calls };
}

const run = (sql, options = {}) => {
  const { scan } = makeScan();
  return executeBatch(sql, { catalog, scan, now: NOW, ...options });
};

// Readable form of a value: decimals as text, dates as ISO, bigints with an "n" suffix.
const plain = (value) => {
  if (value !== null && typeof value === 'object' && 'decimal' in value) return value.decimal;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return `${value}n`;
  return value;
};
const rowsOf = (result, index = 0) => result.resultSets[index].rows.map((row) => row.map(plain));

// expected is an array of rows, or { error: number }.
async function check(sql, expected) {
  if (Array.isArray(expected)) assert.deepEqual(rowsOf(await run(sql)), expected);
  else await assert.rejects(run(sql), { number: expected.error });
}

// [label, sql, expected]: expected is an array of rows, or { error: number }.
const cases = [
  [
    'WHERE and ORDER BY alias',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_status = 1 ORDER BY n',
    [['Bolt'], ['Gear']],
  ],
  [
    'scan order without ORDER BY',
    'SELECT p.contoso_code AS c FROM contoso_part p',
    [['X-1'], ['X-2'], ['Y-1'], [null]],
  ],
  [
    'p.* keeps the row',
    "SELECT p.* FROM contoso_part p WHERE p.contoso_partid = 'P4'",
    [['P4', null, null, null, null]],
  ],
  [
    'schema-qualified, upper-case table name',
    "SELECT x.contoso_code AS c FROM DBO.CONTOSO_PART x WHERE x.contoso_partid = 'P3'",
    [['Y-1']],
  ],
  ['upper-case column name', "SELECT p.CONTOSO_CODE AS c FROM contoso_part p WHERE p.contoso_partid = 'P1'", [['X-1']]],
  ['NULL equality is unknown', 'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost = NULL', []],
  [
    'NOT of unknown stays unknown',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE NOT (p.contoso_cost > 3)',
    [['P3']],
  ],
  ['IS NULL', 'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost IS NULL', [['P4']]],
  [
    'IS NOT NULL with DESC',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost IS NOT NULL ORDER BY id DESC',
    [['P3'], ['P2'], ['P1']],
  ],
  [
    'IN with a NULL item',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost IN (1, NULL)',
    [['P3']],
  ],
  [
    'NOT IN with a NULL item',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost NOT IN (1, NULL)',
    [],
  ],
  [
    'BETWEEN',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost BETWEEN 2 AND 9 ORDER BY id',
    [['P1'], ['P2']],
  ],
  [
    'NOT BETWEEN',
    'SELECT p.contoso_partid AS id FROM contoso_part p WHERE p.contoso_cost NOT BETWEEN 2 AND 9',
    [['P3']],
  ],
  [
    'LIKE with % and _ is case-insensitive',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name LIKE 'b_lt%' ORDER BY n",
    [['Bolt'], ['bolt pack']],
  ],
  [
    'LIKE with a character list',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name LIKE '[GN]%' ORDER BY n",
    [['Gear'], ['Nut']],
  ],
  [
    'LIKE with a negated character list',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name LIKE '[^BG]%'",
    [['Nut']],
  ],
  [
    'LIKE with ESCAPE matches a literal %',
    "SELECT x.s AS s FROM (SELECT 'a%b' AS s) AS x WHERE x.s LIKE 'a!%b' ESCAPE '!'",
    [['a%b']],
  ],
  [
    'LIKE with ESCAPE does not wildcard the %',
    "SELECT x.s AS s FROM (SELECT 'axb' AS s) AS x WHERE x.s LIKE 'a!%b' ESCAPE '!'",
    [],
  ],
  [
    'equality is case-insensitive',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name = 'BOLT'",
    [['Bolt']],
  ],
  [
    'CONTAINS is a substring match',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE CONTAINS(w.contoso_name, 'BOLT')",
    [['Bolt'], ['bolt pack']],
  ],
  [
    'searched CASE with NULL branch',
    "SELECT w.contoso_name AS n, CASE WHEN w.contoso_quantity > 5 THEN 'many' WHEN w.contoso_quantity IS NULL THEN 'unknown' ELSE 'few' END AS q FROM contoso_widget w ORDER BY n",
    [
      ['Bolt', 'many'],
      ['bolt pack', 'few'],
      ['Gear', 'unknown'],
      ['Nut', 'few'],
    ],
  ],
  [
    'simple CASE',
    "SELECT CASE w.contoso_status WHEN 1 THEN 'A' WHEN 2 THEN 'I' ELSE 'N' END AS s FROM contoso_widget w",
    [['A'], ['I'], ['A'], ['N']],
  ],
  [
    'CAST to nvarchar',
    'SELECT CAST(w.contoso_quantity AS nvarchar(10)) AS q FROM contoso_widget w WHERE w.contoso_quantity = 10',
    [['10']],
  ],
  ['TRY_CAST returns NULL on failure', "SELECT TRY_CAST('abc' AS int) AS v", [[null]]],
  ['CONVERT text to int', "SELECT CONVERT(int, '42') AS v", [[42]]],
  [
    'ISNULL over a lookup name',
    "SELECT ISNULL(w.contoso_owneridname, 'none') AS o FROM contoso_widget w",
    [['Ann'], ['Bob'], ['none'], ['Ann']],
  ],
  ['@@VERSION', 'SELECT @@VERSION AS v', [['Microsoft SQL Azure (RTM) - 12.0.2000.8']]],
  ['@@ROWCOUNT before any rows', 'SELECT @@ROWCOUNT AS rc', [[0]]],
  ['FROM-less arithmetic', "SELECT 1 + 2 AS total, 'x' + 'y' AS s", [[3, 'xy']]],
  ['integer division and modulo', 'SELECT 7 / 2 AS q, -7 % 3 AS m', [[3, -1]]],
  ['division by zero', 'SELECT 1 / 0 AS x', { error: 8134 }],
  ['bigint arithmetic', 'SELECT CAST(5 AS bigint) + 1 AS b', [['6n']]],
  ['decimal literal keeps its scale', 'SELECT 1.50 AS d', [['1.50']]],
  [
    'money column text',
    "SELECT w.contoso_price AS p FROM contoso_widget w WHERE w.contoso_widgetid = '00000000-0000-0000-0000-000000000002'",
    [['1.2500']],
  ],
  [
    'date comparison with a string',
    "SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_created > '2026-01-15'",
    [['Nut']],
  ],
  [
    'bit equals 1',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_active = 1',
    [['Bolt'], ['bolt pack']],
  ],
  ['TOP n', 'SELECT TOP 2 p.contoso_partid AS id FROM contoso_part p ORDER BY p.contoso_partid', [['P1'], ['P2']]],
  [
    'TOP n PERCENT rounds up',
    'SELECT TOP 30 PERCENT p.contoso_partid AS id FROM contoso_part p ORDER BY id',
    [['P1'], ['P2']],
  ],
  [
    'TOP (variable)',
    'DECLARE @n int = 1; SELECT TOP (@n) p.contoso_partid AS id FROM contoso_part p ORDER BY id',
    [['P1']],
  ],
  [
    'DISTINCT keeps the first occurrence',
    'SELECT DISTINCT p.contoso_widgetidname AS n FROM contoso_part p',
    [['Bolt'], ['Gear'], [null]],
  ],
  [
    'ORDER BY ordinal sorts NULL first',
    'SELECT p.contoso_partid AS id, p.contoso_cost AS c FROM contoso_part p ORDER BY 2',
    [
      ['P4', null],
      ['P3', 1],
      ['P1', 4],
      ['P2', 9],
    ],
  ],
  [
    'ORDER BY DESC puts NULL last',
    'SELECT p.contoso_partid AS id FROM contoso_part p ORDER BY p.contoso_cost DESC',
    [['P2'], ['P1'], ['P3'], ['P4']],
  ],
  [
    'ORDER BY alias with NULL first',
    'SELECT p.contoso_partid AS id, p.contoso_cost AS c FROM contoso_part p ORDER BY c',
    [
      ['P4', null],
      ['P3', 1],
      ['P1', 4],
      ['P2', 9],
    ],
  ],
  ['ORDER BY ordinal out of range', 'SELECT p.contoso_partid AS id FROM contoso_part p ORDER BY 2', { error: 149 }],
  [
    'UNION removes duplicates, case-insensitively',
    'SELECT p.contoso_widgetidname AS n FROM contoso_part p UNION SELECT w.contoso_name AS n FROM contoso_widget w',
    [['Bolt'], ['Gear'], [null], ['Nut'], ['bolt pack']],
  ],
  ['UNION ALL keeps duplicates', 'SELECT 1 AS a UNION ALL SELECT 1 AS a', [[1], [1]]],
  ['UNION with ORDER BY ordinal', 'SELECT 2 AS a UNION SELECT 1 AS a ORDER BY 1', [[1], [2]]],
  ['UNION column count mismatch', 'SELECT 1 AS a UNION SELECT 1 AS a, 2 AS b', { error: 205 }],
  [
    'UNION ORDER BY expression',
    'SELECT p.contoso_partid AS id FROM contoso_part p UNION SELECT p.contoso_partid AS id FROM contoso_part p ORDER BY p.contoso_partid',
    { error: 104 },
  ],
  [
    'derived table',
    'SELECT d.n AS n FROM (SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_status = 1) AS d ORDER BY n',
    [['Bolt'], ['Gear']],
  ],
  [
    'INNER JOIN',
    'SELECT w.contoso_name AS n, p.contoso_code AS c FROM contoso_widget w INNER JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid ORDER BY c',
    [
      ['Bolt', 'X-1'],
      ['Bolt', 'X-2'],
      ['Gear', 'Y-1'],
    ],
  ],
  [
    'LEFT JOIN null-extends',
    'SELECT w.contoso_name AS n, p.contoso_code AS c FROM contoso_widget w LEFT JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid ORDER BY n',
    [
      ['Bolt', 'X-1'],
      ['Bolt', 'X-2'],
      ['bolt pack', null],
      ['Gear', 'Y-1'],
      ['Nut', null],
    ],
  ],
  [
    'RIGHT JOIN keeps unmatched right rows',
    'SELECT w.contoso_name AS n, p.contoso_partid AS id FROM contoso_widget w RIGHT JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid ORDER BY id',
    [
      ['Bolt', 'P1'],
      ['Bolt', 'P2'],
      ['Gear', 'P3'],
      [null, 'P4'],
    ],
  ],
  [
    'FULL JOIN keeps both sides',
    'SELECT w.contoso_name AS n, p.contoso_partid AS id FROM contoso_widget w FULL JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid',
    [
      ['Bolt', 'P1'],
      ['Bolt', 'P2'],
      ['Nut', null],
      ['Gear', 'P3'],
      ['bolt pack', null],
      [null, 'P4'],
    ],
  ],
  [
    'CROSS JOIN',
    'SELECT w.contoso_widgetid AS a, p.contoso_partid AS b FROM contoso_widget w CROSS JOIN contoso_part p',
    crossRows(),
  ],
  [
    'comma join with WHERE',
    "SELECT w.contoso_name AS n, p.contoso_partid AS id FROM contoso_widget w, contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid AND p.contoso_partid = 'P3'",
    [['Gear', 'P3']],
  ],
  [
    'OUTER APPLY null-extends',
    "SELECT w.contoso_name AS n, x.code AS c FROM contoso_widget w OUTER APPLY (SELECT p.contoso_code AS code FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid AND p.contoso_partid = 'P2') AS x WHERE w.contoso_status = 1 ORDER BY n",
    [
      ['Bolt', 'X-2'],
      ['Gear', null],
    ],
  ],
  [
    'CROSS APPLY',
    "SELECT w.contoso_name AS n, x.code AS c FROM contoso_widget w CROSS APPLY (SELECT p.contoso_code AS code FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid) AS x WHERE w.contoso_name = 'Bolt' ORDER BY c",
    [
      ['Bolt', 'X-1'],
      ['Bolt', 'X-2'],
    ],
  ],
  [
    'correlated scalar subquery',
    'SELECT w.contoso_name AS n, (SELECT TOP 1 p.contoso_code AS code FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid ORDER BY p.contoso_partid) AS c FROM contoso_widget w',
    [
      ['Bolt', 'X-1'],
      ['Nut', null],
      ['Gear', 'Y-1'],
      ['bolt pack', null],
    ],
  ],
  [
    'scalar subquery with more than one row',
    'SELECT (SELECT p.contoso_code AS code FROM contoso_part p) AS c',
    { error: 512 },
  ],
  [
    'scalar subquery with two columns',
    "SELECT (SELECT p.contoso_code AS code, p.contoso_cost AS cost FROM contoso_part p WHERE p.contoso_partid = 'P1') AS c",
    { error: 116 },
  ],
  [
    'correlated EXISTS',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE EXISTS (SELECT 1 AS one FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid)',
    [['Bolt'], ['Gear']],
  ],
  [
    'correlated NOT EXISTS',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE NOT EXISTS (SELECT 1 AS one FROM contoso_part p WHERE p.contoso_widgetid = w.contoso_widgetid)',
    [['Nut'], ['bolt pack']],
  ],
  [
    'IN subquery',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_widgetid IN (SELECT p.contoso_widgetid AS wid FROM contoso_part p)',
    [['Bolt'], ['Gear']],
  ],
  [
    '> ANY subquery with NULL',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity > ANY (SELECT p.contoso_cost AS c FROM contoso_part p)',
    [['Bolt'], ['bolt pack']],
  ],
  [
    '> ALL subquery',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity > ALL (SELECT p.contoso_cost AS c FROM contoso_part p WHERE p.contoso_cost IS NOT NULL)',
    [['Bolt']],
  ],
  [
    'variable in WHERE',
    "DECLARE @s nvarchar(20) = 'Bolt'; SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_name = @s",
    [['Bolt']],
  ],
  [
    'SET after DECLARE',
    'DECLARE @n int; SET @n = 2; SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_status = @n',
    [['Nut']],
  ],
  ['undeclared variable', 'SELECT @nope AS x', { error: 137 }],
  ['unknown table', 'SELECT x.a AS a FROM nope x', { error: 208 }],
  ['unknown column', 'SELECT w.nope AS n FROM contoso_widget w', { error: 207 }],
  ['unknown column with no rows', 'SELECT w.nope AS n FROM contoso_widget w WHERE 1 = 0', { error: 207 }],
  ['ambiguous column', 'SELECT contoso_name AS n FROM contoso_widget w, contoso_widget v', { error: 209 }],
  ['syntax error', 'SELECT FROM contoso_widget', { error: 102 }],
];

// Cross product in scan order: four widgets, then four parts per widget.
function crossRows() {
  const out = [];
  for (const w of widgets) for (const p of parts) out.push([w.contoso_widgetid, p.contoso_partid]);
  return out;
}

for (const [label, sql, expected] of cases) {
  test(`evaluates: ${label}`, () => check(sql, expected));
}

// T-SQL semantics: exact numerics, type precedence, declared types, predicates, date and binary values,
// DISTINCT ordering, duplicate star columns and aggregates in ON. Same shape as `cases`.
const semanticCases = [
  // 1. Exact numeric arithmetic
  ['decimal division keeps scale 6 for an integer literal divisor', 'SELECT 7.0 / 2 AS d', [['3.500000']]],
  ['decimal 1 / 3.0 has scale 6', 'SELECT 1 / 3.0 AS d', [['0.333333']]],
  ['decimal 10 / 3.0', 'SELECT 10 / 3.0 AS d', [['3.333333']]],
  ['negative decimal division truncates toward zero', 'SELECT -7.0 / 2 AS d', [['-3.500000']]],
  ['decimal multiplication adds scales', 'SELECT 7.0 * 2.5 AS d', [['17.50']]],
  ['decimal subtraction is exact', 'SELECT 7.5 - 0.25 AS d', [['7.25']]],
  ['decimal modulo', 'SELECT 7 % 3.0 AS d', [['1.0']]],
  ['a float literal divides as float', 'SELECT 7.0E0 / 2 AS d', [[3.5]]],
  ['CAST to float divides as float', 'SELECT CAST(1 AS float) / 4 AS d', [[0.25]]],
  [
    'declared decimal(10,2) variable divides exactly',
    'DECLARE @p decimal(10,2) = 7; SELECT @p / 2 AS d',
    [['3.500000']],
  ],
  ['int overflow is 8115', 'SELECT 2147483647 + 1 AS d', { error: 8115 }],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['bigint overflow is 8115', 'SELECT 9223372036854775807 + 1 AS d', [['9223372036854775808']]],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['bigint product in range', 'SELECT 2147483647 * 4294967296 AS d', [['9223372032559808512']]],
  [
    'decimal overflow is 8115',
    "SELECT CAST('99999999999999999999999999999999999999' AS decimal(38,0)) * 10 AS d",
    { error: 8115 },
  ],
  ['decimal divide by zero is 8134', 'SELECT 1.0 / 0 AS d', { error: 8134 }],
  // 2. Data type precedence and implicit conversion
  ['string converts to int in arithmetic', "SELECT '5' + 1 AS d", [[6]]],
  ['non-numeric string in arithmetic is 245', "SELECT 'x' + 1 AS d", { error: 245 }],
  ['string with a fraction against int is 245', "SELECT '2.5' * 2 AS d", { error: 245 }],
  ['string against decimal converts to decimal', "SELECT '2.5' * 2.0 AS d", [['5.00']]],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['string compares with int', "SELECT 1 = '1' AS d", { error: 102 }],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['string compares with decimal', "SELECT 2.5 = '2.50' AS d", { error: 102 }],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['non-numeric string compared with int is 245', "SELECT 'abc' = 1 AS d", { error: 156 }],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  [
    'malformed date string compared with datetime is 241',
    "SELECT '2020-13-01' = CAST('2020-01-01' AS datetime) AS d",
    { error: 156 },
  ],
  // 3. Declared types
  ['DECLARE int converts the string', "DECLARE @n int = '5'; SELECT @n AS n", [[5]]],
  ['DECLARE nvarchar(3) truncates', "DECLARE @s nvarchar(3) = 'abcdef'; SELECT @s AS s", [['abc']]],
  ['DECLARE decimal(10,2) keeps scale', 'DECLARE @p decimal(10,2) = 7; SELECT @p AS p', [['7.00']]],
  ['DECLARE int overflow is 8115', 'DECLARE @n int = 3000000000; SELECT @n AS n', { error: 8115 }],
  ['SET converts to the declared type', "DECLARE @n int; SET @n = '7'; SELECT @n AS n", [[7]]],
  [
    'SELECT assignment truncates to the declared type',
    "DECLARE @s nvarchar(2); SELECT @s = 'xyz'; SELECT @s AS s",
    [['xy']],
  ],
  // 4. Non-boolean predicates
  [
    'WHERE on a bare int column is 4145',
    'SELECT w.contoso_name AS n FROM contoso_widget w WHERE w.contoso_quantity',
    { error: 4145 },
  ],
  ['WHERE on arithmetic is 4145', 'SELECT 1 AS d WHERE 1 + 1', { error: 4145 }],
  ['searched CASE WHEN on a literal is 4145', "SELECT CASE WHEN 1 THEN 'y' END AS d", { error: 4145 }],
  [
    'ON on a bare column is 4145',
    'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON p.contoso_cost',
    { error: 4145 },
  ],
  ['HAVING on a literal is 4145', 'SELECT p.contoso_code AS c FROM contoso_part p HAVING 1', { error: 4145 }],
  ['a comparison predicate is still boolean', 'SELECT 1 AS d WHERE 1 = 1', [[1]]],
  // 5. Date arithmetic and binary values
  ['datetime plus days', "DECLARE @d datetime = '2020-01-01'; SELECT @d + 1 AS d", [['2020-01-02T00:00:00.000Z']]],
  ['int plus datetime', "DECLARE @d datetime = '2020-01-01'; SELECT 1 + @d AS d", [['2020-01-02T00:00:00.000Z']]],
  [
    'datetime minus a fractional day',
    "DECLARE @d datetime = '2020-01-01 12:00'; SELECT @d - 0.5 AS d",
    [['2020-01-01T00:00:00.000Z']],
  ],
  ['datetime plus days past 9999 is 517', "DECLARE @d datetime = '9999-12-31'; SELECT @d + 1 AS d", { error: 517 }],
  ['datetime times int is 8117', "DECLARE @d datetime = '2020-01-01'; SELECT @d * 2 AS d", { error: 8117 }],
  ['datetime plus datetime is 206', "DECLARE @d datetime = '2020-01-01'; SELECT @d + @d AS d", { error: 206 }],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['binary literal equals the int it encodes', 'SELECT 0x0102 = 258 AS d', { error: 102 }],
  ["CAST binary to int reads two's complement", 'SELECT CAST(0xFFFFFFFF AS int) AS d', [[-1]]],
  ['odd-length binary literal pads with a zero', 'SELECT CAST(0x1 AS int) AS d', [[1]]],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  ['binary arithmetic is 402', 'SELECT 0x41 + 1 AS d', [[66]]],
  // 6. DISTINCT and ORDER BY
  [
    'DISTINCT with ORDER BY a column outside the list is 145',
    'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY p.contoso_cost',
    { error: 145 },
  ],
  [
    'DISTINCT with ORDER BY a listed column by name passes',
    'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY p.contoso_code',
    [[null], ['X-1'], ['X-2'], ['Y-1']],
  ],
  [
    'DISTINCT with ORDER BY an ordinal passes',
    'SELECT DISTINCT p.contoso_code AS c FROM contoso_part p ORDER BY 1',
    [[null], ['X-1'], ['X-2'], ['Y-1']],
  ],
  // 7. Duplicate column names from a star
  [
    'star over a JOIN with a shared column name is 40000',
    'SELECT * FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid',
    { error: 40000 },
  ],
  [
    'a star inside EXISTS may repeat names',
    'SELECT 1 AS d WHERE EXISTS (SELECT * FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid)',
    [[1]],
  ],
  // 8. Aggregates in ON
  [
    'aggregate in ON is 147',
    'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON COUNT(*) > 0',
    { error: 147 },
  ],
  [
    'aggregate inside a subquery in ON is 147',
    'SELECT w.contoso_name AS n FROM contoso_widget w JOIN contoso_part p ON p.contoso_cost = (SELECT MAX(x.contoso_cost) AS m FROM contoso_part x)',
    { error: 147 },
  ],
];
for (const [label, sql, expected] of semanticCases) {
  test(`T-SQL semantics: ${label}`, () => {
    __paqParityCaseBindings(
      import.meta.url,
      semanticCases,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 10, 13, 14, 15, 16, 17, 18, 30, 31, 34, 42, 43],
      { label, sql, expected },
      __paqParityShared,
    );
    return check(sql, expected);
  });
}

// Behaviour outside the table: options, batches, metadata, cancellation and scan reuse.

test('FROM-less SELECT gives an unnamed column the empty name', async () => {
  const result = await run('SELECT 1 + 2');
  assert.equal(result.resultSets[0].columns[0].name, '');
  assert.deepEqual(rowsOf(result), [[3]]);
});

test('SELECT @v = expr produces no result set', async () => {
  const sql =
    "DECLARE @v nvarchar(100); SELECT @v = w.contoso_name FROM contoso_widget w WHERE w.contoso_widgetid = '00000000-0000-0000-0000-000000000002'; SELECT @v AS v";
  const result = await run(sql);
  assert.equal(result.resultSets.length, 1);
  assert.deepEqual(rowsOf(result), [['Nut']]);
});

test('variables do not survive GO', async () => {
  await assert.rejects(run('DECLARE @x int = 5\nGO\nSELECT @x AS x'), { number: 137 });
});

test("@@ROWCOUNT is the previous statement's row count", async () => {
  const result = await run('SELECT w.contoso_name AS n FROM contoso_widget w; SELECT @@ROWCOUNT AS rc');
  assert.deepEqual(rowsOf(result, 1), [[4]]);
  assert.equal(result.rowCount, 1);
});

test('@@ROWCOUNT is 0 after DECLARE', async () => {
  const result = await run('SELECT 1 AS a; DECLARE @x int; SELECT @@ROWCOUNT AS rc');
  assert.deepEqual(rowsOf(result, 1), [[0]]);
});

test('@@ROWCOUNT carries across GO', async () => {
  const result = await run('SELECT 1 AS a\nGO\nSELECT @@ROWCOUNT AS rc');
  assert.deepEqual(rowsOf(result, 1), [[1]]);
});

test('GO with a repeat count runs the batch that many times', async () => {
  const result = await run('SELECT 1 AS a\nGO 2');
  assert.deepEqual([rowsOf(result, 0), rowsOf(result, 1), result.resultSets.length], [[[1]], [[1]], 2]);
});

test('sp_executesql parameters are visible', async () => {
  const result = await run('SELECT @p1 AS v', { params: { '@p1': 7 } });
  assert.deepEqual(rowsOf(result), [[7]]);
});

test('GETDATE uses the injected clock', async () => {
  const result = await run('SELECT GETDATE() AS d');
  assert.deepEqual(rowsOf(result), [[NOW.toISOString()]]);
});

test('empty input gives no result sets', async () => {
  const result = await run('');
  assert.deepEqual(result.resultSets, []);
});

test('SELECT * names match the catalog columns', async () => {
  const result = await run('SELECT * FROM contoso_part');
  assert.deepEqual(
    result.resultSets[0].columns.map((c) => c.name),
    catalog.tables.get('contoso_part').columns.map((c) => c.name),
  );
});

test('result columns carry catalog types and scales', async () => {
  const result = await run(
    "SELECT w.contoso_name AS n, w.contoso_price AS p, 1 AS one, 'ab' AS s FROM contoso_widget w WHERE w.contoso_widgetid = '00000000-0000-0000-0000-000000000001'",
  );
  const [n, p, one, s] = result.resultSets[0].columns;
  assert.deepEqual([n.type, n.length], ['nvarchar', 100]);
  assert.deepEqual([p.type, p.precision, p.scale], ['money', 19, 4]);
  assert.equal(one.type, 'int');
  assert.deepEqual([s.type, s.length], ['nvarchar', 2]);
});

test('decimal values in one column share a scale', async () => {
  const result = await run('SELECT 1.5 AS d UNION ALL SELECT 2.25 AS d');
  assert.deepEqual(rowsOf(result), [['1.50'], ['2.25']]);
  assert.equal(result.resultSets[0].columns[0].scale, 2);
});

test('zero-row CROSS APPLY still exposes its columns', async () => {
  const result = await run(
    'SELECT w.contoso_name AS n, x.code AS c FROM contoso_widget w CROSS APPLY (SELECT p.contoso_code AS code FROM contoso_part p WHERE 1 = 0) AS x',
  );
  assert.deepEqual(
    result.resultSets[0].columns.map((c) => c.name),
    ['n', 'c'],
  );
  assert.deepEqual(rowsOf(result), []);
});

test('a table is scanned once per batch', async () => {
  const { scan, calls } = makeScan();
  const result = await executeBatch('SELECT w.contoso_name AS n FROM contoso_widget w CROSS JOIN contoso_widget v', {
    catalog,
    scan,
    now: NOW,
  });
  assert.equal(result.resultSets[0].rows.length, 16);
  assert.equal(calls.contoso_widget, 1);
});

test('an aborted signal fails before any row', async () => {
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(run('SELECT 1 AS a', { signal: controller.signal }), { number: 3617 });
});

test('abort during a scan stops the row loop', async () => {
  const controller = new AbortController();
  const scan = async () => {
    controller.abort();
    return parts.map((row) => ({ ...row }));
  };
  await assert.rejects(
    executeBatch('SELECT p.contoso_partid AS id FROM contoso_part p', { catalog, scan, signal: controller.signal }),
    { number: 3617 },
  );
});

// ---- Aggregates, GROUP BY and HAVING. Expected values follow SQL Server.
const aggregateCases = [
  ['COUNT(*) counts rows', 'SELECT COUNT(*) AS n FROM contoso_widget', [[4]]],
  ['COUNT(expr) skips NULLs', 'SELECT COUNT(w.contoso_quantity) AS n FROM contoso_widget w', [[3]]],
  ['COUNT of no rows is 0', 'SELECT COUNT(*) AS n FROM contoso_widget WHERE 1 = 0', [[0]]],
  ['COUNT_BIG returns bigint', 'SELECT COUNT_BIG(w.contoso_name) AS n FROM contoso_widget w', [['4n']]],
  ['COUNT(DISTINCT) skips NULLs', 'SELECT COUNT(DISTINCT w.contoso_status) AS n FROM contoso_widget w', [[2]]],
  ['SUM of int', 'SELECT SUM(w.contoso_quantity) AS s FROM contoso_widget w', [[13]]],
  ['SUM of no rows is NULL', 'SELECT SUM(w.contoso_quantity) AS s FROM contoso_widget w WHERE 1 = 0', [[null]]],
  ['SUM DISTINCT', 'SELECT SUM(DISTINCT w.contoso_status) AS s FROM contoso_widget w', [[3]]],
  ['SUM of money keeps four places', 'SELECT SUM(w.contoso_price) AS s FROM contoso_widget w', [['14.2500']]],
  [
    'SUM of NULL-only column is NULL',
    'SELECT SUM(w.contoso_quantity) AS q FROM contoso_widget w WHERE w.contoso_quantity IS NULL',
    [[null]],
  ],
  ['SUM of bigint is bigint', 'SELECT SUM(CAST(5 AS bigint)) AS s FROM contoso_part', [['20n']]],
  ['SUM of decimal keeps scale', 'SELECT SUM(CAST(1.25 AS decimal(5,2))) AS s FROM contoso_part', [['5.00']]],
  ['SUM int overflow is 8115', 'SELECT SUM(CAST(2147483647 AS int)) AS s FROM contoso_widget', { error: 8115 }],
  ['AVG of int is integer division', 'SELECT AVG(w.contoso_quantity) AS a FROM contoso_widget w', [[4]]],
  ['AVG of money', 'SELECT AVG(w.contoso_price) AS a FROM contoso_widget w', [['3.5625']]],
  ['AVG of no rows is NULL', 'SELECT AVG(p.contoso_cost) AS a FROM contoso_part p WHERE 1 = 0', [[null]]],
  ['MIN of strings', 'SELECT MIN(w.contoso_name) AS m FROM contoso_widget w', [['Bolt']]],
  ['MAX of strings compares case-insensitively', 'SELECT MAX(w.contoso_name) AS m FROM contoso_widget w', [['Nut']]],
  ['MIN ignores NULL', 'SELECT MIN(w.contoso_quantity) AS m FROM contoso_widget w', [[0]]],
  ['MAX of int', 'SELECT MAX(w.contoso_quantity) AS m FROM contoso_widget w', [[10]]],
  ['MIN of no rows is NULL', 'SELECT MIN(w.contoso_quantity) AS m FROM contoso_widget w WHERE 1 = 0', [[null]]],
  [
    'GROUP BY with COUNT, NULL group first',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status ORDER BY s',
    [
      [null, 1],
      [1, 2],
      [2, 1],
    ],
  ],
  [
    'GROUP BY with SUM over a NULL group',
    'SELECT w.contoso_owneridname AS o, SUM(w.contoso_quantity) AS q FROM contoso_widget w GROUP BY w.contoso_owneridname ORDER BY o',
    [
      [null, null],
      ['Ann', 13],
      ['Bob', 0],
    ],
  ],
  [
    'HAVING on COUNT',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status HAVING COUNT(*) > 1',
    [[1, 2]],
  ],
  [
    'HAVING on an aggregate not in the select list',
    'SELECT w.contoso_status AS s FROM contoso_widget w GROUP BY w.contoso_status HAVING SUM(w.contoso_quantity) > 5',
    [[1]],
  ],
  [
    'ORDER BY an aggregate',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status ORDER BY COUNT(*) DESC, s',
    [
      [1, 2],
      [null, 1],
      [2, 1],
    ],
  ],
  [
    'ORDER BY an alias of an aggregate',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status ORDER BY n DESC, s DESC',
    [
      [1, 2],
      [2, 1],
      [null, 1],
    ],
  ],
  [
    'no GROUP BY over no rows is one row',
    'SELECT COUNT(*) AS n, SUM(w.contoso_quantity) AS q FROM contoso_widget w WHERE 1 = 0',
    [[0, null]],
  ],
  [
    'GROUP BY over no rows is no rows',
    'SELECT w.contoso_status AS s, COUNT(*) AS n FROM contoso_widget w WHERE 1 = 0 GROUP BY w.contoso_status',
    [],
  ],
  ['HAVING without GROUP BY', 'SELECT COUNT(*) AS n FROM contoso_widget HAVING COUNT(*) > 3', [[4]]],
  ['aggregate inside an expression', 'SELECT COUNT(*) + 1 AS n FROM contoso_widget', [[5]]],
  [
    'int aggregates divide as integers',
    'SELECT SUM(w.contoso_quantity) / COUNT(w.contoso_quantity) AS a FROM contoso_widget w',
    [[4]],
  ],
  [
    'aggregate inside CASE',
    "SELECT CASE WHEN COUNT(*) > 3 THEN 'many' ELSE 'few' END AS v FROM contoso_widget",
    [['many']],
  ],
  [
    'aggregate assigned to a variable',
    'DECLARE @n int; SELECT @n = COUNT(*) FROM contoso_widget; SELECT @n AS n',
    [[4]],
  ],
  [
    'GROUP BY expression reused in the select list',
    'SELECT w.contoso_status + 0 AS s, COUNT(*) AS n FROM contoso_widget w GROUP BY w.contoso_status + 0 ORDER BY s',
    [
      [null, 1],
      [1, 2],
      [2, 1],
    ],
  ],
  [
    'GROUP BY over a join',
    'SELECT w.contoso_name AS n, COUNT(p.contoso_partid) AS c FROM contoso_widget w JOIN contoso_part p ON p.contoso_widgetid = w.contoso_widgetid GROUP BY w.contoso_name ORDER BY n',
    [
      ['Bolt', 2],
      ['Gear', 1],
    ],
  ],
  [
    'STRING_AGG joins non-NULL values',
    "SELECT STRING_AGG(w.contoso_name, ',') AS s FROM contoso_widget w WHERE w.contoso_status = 1",
    [['Bolt,Gear']],
  ],
  [
    'STRING_AGG skips NULLs',
    "SELECT STRING_AGG(w.contoso_owneridname, '/') AS s FROM contoso_widget w",
    [['Ann/Bob/Ann']],
  ],
  [
    'STRING_AGG of no rows is NULL',
    "SELECT STRING_AGG(w.contoso_name, ',') AS s FROM contoso_widget w WHERE 1 = 0",
    [[null]],
  ],
  [
    'VARP is the population variance',
    'SELECT VARP(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_cost > 3',
    [[6.25]],
  ],
  [
    'VAR is the sample variance',
    'SELECT VAR(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_cost > 3',
    [[12.5]],
  ],
  [
    'VAR of one row is NULL',
    "SELECT VAR(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_partid = 'P1'",
    [[null]],
  ],
  [
    'STDEVP of one row is 0',
    "SELECT STDEVP(p.contoso_cost) AS v FROM contoso_part p WHERE p.contoso_partid = 'P1'",
    [[0]],
  ],
  [
    'column outside GROUP BY is 8120',
    'SELECT w.contoso_name AS n, COUNT(*) AS c FROM contoso_widget w GROUP BY w.contoso_status',
    { error: 8120 },
  ],
  [
    'HAVING column outside GROUP BY is 8120',
    "SELECT w.contoso_status AS s FROM contoso_widget w GROUP BY w.contoso_status HAVING w.contoso_name = 'x'",
    { error: 8120 },
  ],
  [
    'ORDER BY column outside GROUP BY is 8120',
    'SELECT COUNT(*) AS c FROM contoso_widget w ORDER BY w.contoso_name',
    { error: 8120 },
  ],
  [
    'star with GROUP BY is 8120 for ungrouped columns',
    'SELECT * FROM contoso_widget w GROUP BY w.contoso_status',
    { error: 8120 },
  ],
  ['aggregate in WHERE is 147', 'SELECT w.contoso_name AS n FROM contoso_widget w WHERE COUNT(*) > 1', { error: 147 }],
  ['nested aggregate is 130', 'SELECT SUM(COUNT(*)) AS s FROM contoso_widget', { error: 130 }],
  [
    'aggregate over a subquery is 130',
    'SELECT MAX((SELECT MAX(p.contoso_cost) AS m FROM contoso_part p)) AS m FROM contoso_widget',
    { error: 130 },
  ],
  ['aggregate in GROUP BY is 144', 'SELECT COUNT(*) AS c FROM contoso_widget GROUP BY COUNT(*)', { error: 144 }],
  ['wrong argument count is 174', 'SELECT SUM(w.contoso_quantity, 1) AS s FROM contoso_widget w', { error: 174 }],
  ['CHECKSUM_AGG is unsupported', 'SELECT CHECKSUM_AGG(w.contoso_quantity) AS c FROM contoso_widget w', { error: 195 }],
  [
    'GROUPING is unsupported',
    'SELECT GROUPING(w.contoso_status) AS g FROM contoso_widget w GROUP BY w.contoso_status',
    { error: 195 },
  ],
];

for (const [label, sql, expected] of aggregateCases) {
  test(`aggregate: ${label}`, () => check(sql, expected));
}

test('aggregate result columns carry SQL Server types', async () => {
  const result = await run(
    'SELECT COUNT(*) AS c, COUNT_BIG(w.contoso_name) AS cb, SUM(w.contoso_price) AS sp, AVG(w.contoso_quantity) AS aq, MIN(w.contoso_name) AS mn FROM contoso_widget w',
  );
  const [c, cb, sp, aq, mn] = result.resultSets[0].columns;
  assert.equal(c.type, 'int');
  assert.equal(cb.type, 'bigint');
  assert.deepEqual([sp.type, sp.precision, sp.scale], ['money', 19, 4]);
  assert.equal(aq.type, 'int');
  assert.deepEqual([mn.type, mn.length], ['nvarchar', 100]);
});

test('zero-row aggregate columns keep their static types', async () => {
  const result = await run(
    'SELECT SUM(w.contoso_quantity) AS s, MAX(w.contoso_name) AS m FROM contoso_widget w WHERE 1 = 0',
  );
  const [s, m] = result.resultSets[0].columns;
  assert.equal(s.type, 'int');
  assert.equal(m.type, 'nvarchar');
  assert.equal(m.length, 100);
});

// ---- Typing
test('a float variable with an integral value divides as float', async () => {
  const result = await run('DECLARE @f float = 7.0; SELECT @f / 2 AS d');
  assert.deepEqual(rowsOf(result), [[3.5]]);
  assert.equal(result.resultSets[0].columns[0].type, 'float');
});

test('a NULL-only and a zero-row decimal column get their static types', async () => {
  const result = await run('SELECT NULL AS x, CAST(NULL AS decimal(10,2)) AS d FROM contoso_widget WHERE 1 = 0');
  const [x, d] = result.resultSets[0].columns;
  assert.equal(x.type, 'int');
  assert.deepEqual([d.type, d.precision, d.scale], ['decimal', 10, 2]);
});

test('datetime minus datetime is a datetime from 1900-01-01', async () => {
  const result = await run("SELECT CAST('2020-01-03' AS datetime) - CAST('2020-01-01' AS datetime) AS d");
  assert.deepEqual(rowsOf(result), [['1900-01-03T00:00:00.000Z']]);
  assert.equal(result.resultSets[0].columns[0].type, 'datetime');
});

test("0x41 = 'A' is true, since a varchar string converts to single-byte varbinary", async () => {
  assert.deepEqual(rowsOf(await run("SELECT CASE WHEN 0x41 = 'A' THEN 1 ELSE 0 END AS v")), [[1]]);
});

test("0x41 = N'A' is false, since an nvarchar string converts to UTF-16LE", async () => {
  assert.deepEqual(rowsOf(await run("SELECT CASE WHEN 0x41 = N'A' THEN 1 ELSE 0 END AS v")), [[0]]);
});

test('a varbinary result column is error 40000', async () => {
  await assert.rejects(run('SELECT 0x41 AS b'), {
    number: 40000,
    message: 'The data type varbinary is not supported.',
  });
});

test('a varbinary result column is error 40000, even with no rows', async () => {
  await assert.rejects(run('SELECT 0x41 AS b FROM contoso_widget WHERE 1 = 0'), { number: 40000 });
});

// STRING_AGG ordering, COUNT_BIG(*), binary expressions and static column types (table-driven).
const orderedCases = [
  [
    'WITHIN GROUP ascending orders text case-insensitively',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_name) AS s FROM contoso_widget w",
    [['Bolt,bolt pack,Gear,Nut']],
  ],
  [
    'WITHIN GROUP descending reverses the order',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_name DESC) AS s FROM contoso_widget w",
    [['Nut,Gear,bolt pack,Bolt']],
  ],
  [
    'WITHIN GROUP orders by a key other than the value',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_quantity) AS s FROM contoso_widget w",
    [['Gear,Nut,bolt pack,Bolt']],
  ],
  [
    'WITHIN GROUP DESC puts NULL keys last',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_quantity DESC) AS s FROM contoso_widget w",
    [['Bolt,bolt pack,Nut,Gear']],
  ],
  [
    'WITHIN GROUP with two keys breaks ties',
    "SELECT STRING_AGG(w.contoso_name, ',') WITHIN GROUP (ORDER BY w.contoso_status, w.contoso_name DESC) AS s FROM contoso_widget w",
    [['bolt pack,Gear,Bolt,Nut']],
  ],
  [
    'WITHIN GROUP with a separator expression',
    "SELECT STRING_AGG(w.contoso_name, UPPER(';')) WITHIN GROUP (ORDER BY w.contoso_name) AS s FROM contoso_widget w",
    [['Bolt;bolt pack;Gear;Nut']],
  ],
  [
    'WITHIN GROUP per group',
    "SELECT w.contoso_status AS st, STRING_AGG(w.contoso_name, ';') WITHIN GROUP (ORDER BY w.contoso_quantity) AS s FROM contoso_widget w GROUP BY w.contoso_status ORDER BY w.contoso_status",
    [
      [null, 'bolt pack'],
      [1, 'Gear;Bolt'],
      [2, 'Nut'],
    ],
  ],
  [
    'STRING_AGG without WITHIN GROUP keeps row order',
    "SELECT STRING_AGG(w.contoso_name, ',') AS s FROM contoso_widget w",
    [['Bolt,Nut,Gear,bolt pack']],
  ],
  ['COUNT_BIG(*) counts rows as bigint', 'SELECT COUNT_BIG(*) AS c FROM contoso_widget', [['4n']]],
  ['COUNT_BIG(*) of no rows is zero', 'SELECT COUNT_BIG(*) AS c FROM contoso_widget WHERE 1 = 0', [['0n']]],
  [
    'COUNT_BIG(*) in HAVING',
    'SELECT w.contoso_status AS st FROM contoso_widget w GROUP BY w.contoso_status HAVING COUNT_BIG(*) > 1',
    [[1]],
  ],
  // @parity-evidence: fixtures/tds-root-sql-server-expressions-v1.json records two SQL Server engine executions.
  [
    'CAST text to varbinary and back to nvarchar',
    "SELECT CAST(CAST('ab' AS varbinary(8)) AS nvarchar(10)) AS s",
    [['扡']],
  ],
  ['binary bytes read as a big-endian int', 'SELECT CONVERT(int, CAST(0x00000102 AS binary(4))) AS n', [[258]]],
  ['DECLAREd binary pads a short literal', 'DECLARE @x binary(4) = 0x01; SELECT CAST(@x AS int) AS n', [[16777216]]],
  [
    'DECLAREd varbinary truncates a long literal',
    'DECLARE @x varbinary(2) = 0x010203; SELECT CAST(@x AS int) AS n',
    [[258]],
  ],
  [
    'binary values compare as bytes',
    "SELECT CASE WHEN CAST(1 AS binary(4)) = 0x00000001 THEN 'y' ELSE 'n' END AS s",
    [['y']],
  ],
];
for (const [label, sql, expected] of orderedCases) {
  test(`evaluates: ${label}`, () => check(sql, expected));
}

// Static column types of the result set (the type name and length of the first column).
const typeColumnCases = [
  [
    'scalar subquery takes its column type',
    "SELECT (SELECT w.contoso_name FROM contoso_widget w WHERE w.contoso_name = 'Nut') AS s",
    'nvarchar',
    100,
  ],
  [
    'scalar subquery of money keeps money',
    "SELECT (SELECT w.contoso_price FROM contoso_widget w WHERE w.contoso_name = 'Nut') AS p",
    'money',
    null,
  ],
  [
    'scalar subquery of an aggregate',
    'SELECT (SELECT MAX(w.contoso_status) AS mx FROM contoso_widget w) AS m',
    'int',
    null,
  ],
  [
    'scalar subquery with a correlated int',
    'SELECT (SELECT x.contoso_status FROM contoso_widget x WHERE x.contoso_widgetid = w.contoso_widgetid) AS c, w.contoso_name AS n FROM contoso_widget w',
    'int',
    null,
  ],
  ['UPPER of a column keeps its length', 'SELECT UPPER(w.contoso_name) AS u FROM contoso_widget w', 'nvarchar', 100],
  ['ABS of money keeps money', 'SELECT ABS(w.contoso_price) AS a FROM contoso_widget w', 'money', null],
  ['SQRT of an int is float', 'SELECT SQRT(w.contoso_quantity) AS r FROM contoso_widget w', 'float', null],
  [
    'COALESCE of int and money is money',
    'SELECT COALESCE(w.contoso_quantity, w.contoso_price) AS c FROM contoso_widget w',
    'money',
    null,
  ],
  [
    'CASE with a decimal literal is decimal',
    'SELECT CASE WHEN w.contoso_status = 1 THEN w.contoso_quantity ELSE 2.5 END AS c FROM contoso_widget w',
    'decimal',
    null,
  ],
  ['CONVERT to varchar(5)', 'SELECT CONVERT(varchar(5), w.contoso_name) AS v FROM contoso_widget w', 'varchar', 5],
  ['NEWID is a uniqueidentifier', 'SELECT NEWID() AS g', 'uniqueidentifier', null],
  ['COUNT_BIG(*) is bigint', 'SELECT COUNT_BIG(*) AS c FROM contoso_widget', 'bigint', null],
];
for (const [label, sql, type, length] of typeColumnCases) {
  test(`column type: ${label}`, async () => {
    const column = (await run(sql)).resultSets[0].columns[0];
    assert.deepEqual([column.type, column.length ?? null], [type, length]);
  });
}

// Pushdown: a scanner that honours the pushdown and column request, and one that ignores both.
// The honouring scanner applies each predicate with OData-like semantics that keep every row SQL keeps
// (a null is kept by <> and not by =), so results must match the full scan exactly.
const pcol = (name, sqlType, kind = 'attribute', extra = {}) => ({
  name,
  sqlType,
  length: null,
  precision: null,
  scale: null,
  nullable: true,
  source: { kind, attribute: name },
  ...extra,
});
const pcatalog = {
  tables: new Map([
    [
      'contoso_gizmo',
      {
        logicalName: 'contoso_gizmo',
        idColumn: 'contoso_gizmoid',
        columns: [
          pcol('contoso_gizmoid', 'uniqueidentifier', 'attribute', { nullable: false }),
          pcol('contoso_name', 'nvarchar', 'attribute', { length: 100 }),
          pcol('contoso_status', 'int'),
          pcol('contoso_quantity', 'int'),
          pcol('contoso_price', 'money', 'attribute', { precision: 19, scale: 4 }),
          pcol('contoso_active', 'bit'),
          pcol('contoso_ownerid', 'uniqueidentifier'),
          pcol('contoso_owneridname', 'nvarchar', 'lookupName', { length: 160 }),
          pcol('contoso_statusname', 'nvarchar', 'choiceName', { length: 100 }),
        ],
      },
    ],
  ]),
};
const G = (n) => `00000000-0000-0000-0000-00000000000${n}`;
const ANN_ID = '00000000-0000-0000-0000-0000000000A1';
const BOB_ID = '00000000-0000-0000-0000-0000000000b2';
const gizmos = [
  {
    contoso_gizmoid: G(1),
    contoso_name: 'Bolt',
    contoso_status: 1,
    contoso_quantity: 5,
    contoso_price: { decimal: '2.5000' },
    contoso_active: true,
    contoso_ownerid: ANN_ID,
    contoso_owneridname: 'Ann',
    contoso_statusname: 'Active',
  },
  {
    contoso_gizmoid: G(2),
    contoso_name: 'Nut',
    contoso_status: 2,
    contoso_quantity: 12,
    contoso_price: { decimal: '1.2500' },
    contoso_active: false,
    contoso_ownerid: BOB_ID,
    contoso_owneridname: 'Bob',
    contoso_statusname: 'Inactive',
  },
  {
    contoso_gizmoid: G(3),
    contoso_name: 'Gear',
    contoso_status: 1,
    contoso_quantity: 0,
    contoso_price: { decimal: '10.0000' },
    contoso_active: true,
    contoso_ownerid: null,
    contoso_owneridname: null,
    contoso_statusname: 'Active',
  },
  {
    contoso_gizmoid: G(4),
    contoso_name: 'bolt pack ',
    contoso_status: null,
    contoso_quantity: 7,
    contoso_price: { decimal: '0.5000' },
    contoso_active: null,
    contoso_ownerid: ANN_ID,
    contoso_owneridname: 'Ann',
    contoso_statusname: null,
  },
  {
    contoso_gizmoid: G(5),
    contoso_name: "'123 pack",
    contoso_status: 2,
    contoso_quantity: 3,
    contoso_price: { decimal: '7.0000' },
    contoso_active: true,
    contoso_ownerid: BOB_ID,
    contoso_owneridname: 'Bob',
    contoso_statusname: 'Inactive',
  },
  {
    contoso_gizmoid: G(6),
    contoso_name: '9-Spring',
    contoso_status: 1,
    contoso_quantity: 9,
    contoso_price: { decimal: '3.7500' },
    contoso_active: false,
    contoso_ownerid: ANN_ID,
    contoso_owneridname: 'Ann',
    contoso_statusname: 'Active',
  },
  {
    contoso_gizmoid: G(7),
    contoso_name: "O'Ring",
    contoso_status: null,
    contoso_quantity: null,
    contoso_price: null,
    contoso_active: null,
    contoso_ownerid: null,
    contoso_owneridname: null,
    contoso_statusname: null,
  },
];
const gizmoTables = { contoso_gizmo: gizmos };

const same = (a, b) =>
  typeof a === 'string'
    ? a.toLowerCase() === String(b).toLowerCase()
    : typeof a === 'boolean'
      ? a === b
      : num(a) === num(b);
const num = (v) => (v !== null && typeof v === 'object' ? Number(v.decimal) : Number(v));
const compareSql = (a, b) => (a === null && b === null ? 0 : a === null ? -1 : b === null ? 1 : num(a) - num(b));

function keepsRow(row, f) {
  const v = row[f.column] ?? null;
  switch (f.op) {
    case 'is-null':
      return v === null;
    case 'not-null':
      return v !== null;
    case '=':
      return v !== null && same(v, f.value);
    case '<>':
      return v === null || !same(v, f.value);
    case 'in':
      return v !== null && f.values.some((x) => same(v, x));
    case 'prefix':
      return typeof v === 'string' && v.startsWith(f.value);
    default: {
      if (v === null) return false;
      const c = num(v) - num(f.value);
      return { '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[f.op];
    }
  }
}

function scanner(tables, { honour }) {
  const calls = [];
  const scan = async (logical, request = {}) => {
    calls.push({ logical, ...request });
    let rows = tables[logical].map((row) => ({ ...row }));
    if (!honour) return rows;
    const { pushdown, columns } = request;
    if (pushdown) {
      rows = rows.filter((row) => pushdown.filters.every((f) => keepsRow(row, f)));
      if (pushdown.orderBy) {
        rows.sort((a, b) =>
          pushdown.orderBy.reduce(
            (acc, o) => acc || (o.desc ? -1 : 1) * compareSql(a[o.column] ?? null, b[o.column] ?? null),
            0,
          ),
        );
      }
      if (pushdown.top !== null) rows = rows.slice(0, pushdown.top);
    }
    return columns
      ? rows.map((row) => Object.fromEntries(Object.entries(row).filter(([k]) => columns.includes(k))))
      : rows;
  };
  return { scan, calls };
}

const W = 'SELECT contoso_name AS n FROM contoso_gizmo';
const pushdownQueries = [
  [`${W} WHERE contoso_status = 1`, {}],
  [`${W} WHERE contoso_status <> 1`, {}],
  [`${W} WHERE contoso_status < 2`, {}],
  [`${W} WHERE contoso_status >= 2 AND contoso_quantity > 0`, {}],
  [`${W} WHERE 3 < contoso_quantity`, {}],
  [`${W} WHERE contoso_status IS NULL`, {}],
  [`${W} WHERE contoso_status IS NOT NULL AND contoso_active = 1`, {}],
  [`${W} WHERE contoso_status IN (1, 2)`, {}],
  [`${W} WHERE contoso_status NOT IN (1)`, {}],
  [`${W} WHERE contoso_name LIKE '9%'`, {}],
  [`${W} WHERE contoso_name LIKE '''%'`, {}],
  [`${W} WHERE contoso_name LIKE 'b%'`, {}],
  [`${W} WHERE contoso_name <> '2 Gear'`, {}],
  [`${W} WHERE contoso_name = 'Gear'`, {}],
  [`${W} WHERE contoso_ownerid = @owner`, { '@owner': ANN_ID }],
  [`${W} WHERE contoso_ownerid <> 'not-a-guid'`, {}],
  [`${W} WHERE contoso_active = 0 OR contoso_quantity = 9`, {}],
  [`${W} WHERE contoso_price > 1.5`, {}],
  [`${W} WHERE contoso_price = 10`, {}],
  [`${W} WHERE contoso_status = @n`, { '@n': null }],
  [`SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1 ORDER BY contoso_quantity DESC`, {}],
  [`SELECT TOP 3 contoso_name AS n FROM contoso_gizmo ORDER BY contoso_name`, {}],
  [`SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status <> 2 ORDER BY contoso_quantity`, {}],
  [`SELECT TOP 1 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 2`, {}],
  [`SELECT contoso_status, COUNT(*) AS n FROM contoso_gizmo WHERE contoso_active = 1 GROUP BY contoso_status`, {}],
  [`SELECT * FROM contoso_gizmo WHERE contoso_status = 1`, {}],
  [`SELECT DISTINCT contoso_status FROM contoso_gizmo WHERE contoso_quantity >= 0`, {}],
  [
    `SELECT g.contoso_name, h.contoso_name AS other FROM contoso_gizmo g JOIN contoso_gizmo h ON h.contoso_gizmoid = g.contoso_gizmoid WHERE g.contoso_status = 1`,
    {},
  ],
  [
    `SELECT x.n FROM (SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1 ORDER BY contoso_quantity) x`,
    {},
  ],
  [`${W} WHERE contoso_status IN (SELECT contoso_status FROM contoso_gizmo WHERE contoso_quantity > 3)`, {}],
  [
    `DECLARE @s int = 1; SELECT TOP 5 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = @s ORDER BY contoso_quantity DESC`,
    {},
  ],
  [`SELECT COUNT(*) AS c FROM contoso_gizmo WHERE contoso_quantity > 3`, {}],
  [`${W} WHERE contoso_quantity > 3 AND contoso_quantity < 12`, {}],
  [`${W} WHERE contoso_status = 1 AND contoso_name LIKE '9%' ORDER BY contoso_quantity`, {}],
];

test('pushdown leaves the results of every query unchanged', async () => {
  for (const [sql, params] of pushdownQueries) {
    const full = scanner(gizmoTables, { honour: false });
    const pushed = scanner(gizmoTables, { honour: true });
    const expected = await executeBatch(sql, { catalog: pcatalog, scan: full.scan, params, now: NOW });
    const actual = await executeBatch(sql, { catalog: pcatalog, scan: pushed.scan, params, now: NOW });
    assert.deepEqual(actual.resultSets, expected.resultSets, sql);
    assert.equal(actual.rowCount, expected.rowCount, sql);
  }
});

async function scannedFor(sql, params = {}) {
  const { scan, calls } = scanner(gizmoTables, { honour: true });
  await executeBatch(sql, { catalog: pcatalog, scan, params, now: NOW });
  return calls.filter((c) => c.logical === 'contoso_gizmo');
}

test('pushdown: equality, IN, IS NULL and prefix reach the scan; text equality does not', async () => {
  const [eq] = await scannedFor(`${W} WHERE contoso_status = 1`);
  assert.deepEqual(eq.pushdown, {
    filters: [{ column: 'contoso_status', op: '=', value: 1, exact: true }],
    top: null,
    orderBy: null,
  });
  const [inList] = await scannedFor(`${W} WHERE contoso_status IN (1, 2) AND contoso_status IS NOT NULL`);
  assert.deepEqual(
    inList.pushdown.filters.map((f) => f.op),
    ['in', 'not-null'],
  );
  const [prefix] = await scannedFor(`${W} WHERE contoso_name LIKE '9%'`);
  assert.deepEqual(prefix.pushdown.filters, [{ column: 'contoso_name', op: 'prefix', value: '9', exact: true }]);
  const [text] = await scannedFor(`${W} WHERE contoso_name = 'Gear' AND contoso_quantity = 0`);
  assert.deepEqual(
    text.pushdown.filters.map((f) => f.column),
    ['contoso_quantity'],
  );
  const [cased] = await scannedFor(`${W} WHERE contoso_name LIKE 'b%'`);
  assert.equal(cased.pushdown, null);
});

test('pushdown: TOP pushes with ORDER BY on a plain numeric column only when the WHERE is exact', async () => {
  const [top] = await scannedFor(
    `SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1 ORDER BY contoso_quantity DESC`,
  );
  assert.equal(top.pushdown.top, 2);
  assert.deepEqual(top.pushdown.orderBy, [{ column: 'contoso_quantity', desc: true }]);
  const [text] = await scannedFor(`SELECT TOP 3 contoso_name AS n FROM contoso_gizmo ORDER BY contoso_name`);
  assert.equal(text.pushdown, null);
  const [inexact] = await scannedFor(
    `SELECT TOP 2 contoso_name AS n FROM contoso_gizmo WHERE contoso_status <> 2 ORDER BY contoso_quantity`,
  );
  assert.equal(inexact.pushdown.top, null);
});

test('pushdown: the columns requested are those the statement reads, plus the id', async () => {
  const [one] = await scannedFor(`${W} WHERE contoso_status = 1`);
  assert.deepEqual(one.columns, ['contoso_gizmoid', 'contoso_name', 'contoso_status']);
  const [star] = await scannedFor(`SELECT * FROM contoso_gizmo WHERE contoso_status = 1`);
  assert.equal(star.columns.length, pcatalog.tables.get('contoso_gizmo').columns.length);
  const [count] = await scannedFor(`SELECT COUNT(*) AS c FROM contoso_gizmo`);
  assert.deepEqual(count.columns, ['contoso_gizmoid']);
});

test('pushdown: joins and derived tables keep the outer scan whole', async () => {
  const [joined] = await scannedFor(
    `SELECT g.contoso_name FROM contoso_gizmo g JOIN contoso_gizmo h ON h.contoso_gizmoid = g.contoso_gizmoid WHERE g.contoso_status = 1`,
  );
  assert.equal(joined.pushdown, null);
  const calls = await scannedFor(
    `SELECT x.n FROM (SELECT contoso_name AS n FROM contoso_gizmo WHERE contoso_status = 1) x`,
  );
  assert.deepEqual(
    calls.map((c) => c.pushdown.filters.length),
    [1],
  );
});
