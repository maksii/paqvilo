// @test-kind unproven: remaining query reader cases retain local evidence only.
import {
  assertQueryParityBindings as __paqQueryBindings,
  assertQueryCase as __paqQueryCase,
  assertQueryCompletion as __paqQueryComplete,
} from '../../scripts/qualify-parity.mjs';
const __paqQueryDescriptor = {
  universe: [
    ['$filter', 'quantity eq', 400, "Expression expected at position 11 in 'quantity eq'."],
    ['$filter', 'quantity eq ', 400, "Expression expected at position 12 in 'quantity eq '."],
    ['$filter', '(quantity eq 1', 400, "')' or operator expected at position 14 in '(quantity eq 1'."],
    ['$filter', ' (quantity eq 1', 400, "')' or operator expected at position 15 in ' (quantity eq 1'."],
    ['$filter', '((quantity eq 1)', 400, "')' or operator expected at position 16 in '((quantity eq 1)'."],
    ['$filter', '(quantity eq 1 ', 400, "')' or operator expected at position 15 in '(quantity eq 1 '."],
    ['$filter', '(quantity eq 12', 400, "')' or operator expected at position 15 in '(quantity eq 12'."],
    [
      '$filter',
      '((quantity eq 1) and (quantity eq 2)',
      400,
      "')' or operator expected at position 36 in '((quantity eq 1) and (quantity eq 2)'.",
    ],
    ['$filter', 'sampleid eq not-a-guid', 400, "Syntax error at position 18 in 'sampleid eq not-a-guid'."],
    ['$filter', 'sampleid eq bad-guid', 400, "Syntax error at position 16 in 'sampleid eq bad-guid'."],
    ['$orderby', 'name sideways', 400, "Syntax error at position 13 in 'name sideways'."],
    ['$orderby', 'name sideways ', 400, "Syntax error at position 13 in 'name sideways '."],
    ['$orderby', 'name asc sideways', 400, "Syntax error at position 17 in 'name asc sideways'."],
    ['$orderby', 'name asc, quantity sideways', 400, "Syntax error at position 27 in 'name asc, quantity sideways'."],
    ['$filter', 'quantity eq -quantity', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', '-quantity lt 0', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', 'quantity eq -(quantity)', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', 'quantity eq -(1)', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', 'quantity eq -null', 501, 'The "Negate" operator isn\'t supported.'],
    [
      '$filter',
      'name eq -name',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.String' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'enabled eq -enabled',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.Boolean' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'stamp eq -stamp',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.DateTimeOffset' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'sampleid eq -sampleid',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.Guid' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'quantity eq +quantity',
      400,
      "Syntax error: character '+' is not valid at position 12 in 'quantity eq +quantity'.",
    ],
    [
      '$filter',
      'name eq -2147483648',
      400,
      "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Int32' for operator kind 'Equal'.",
    ],
    [
      '$filter',
      'name eq 2147483648',
      400,
      "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Int64' for operator kind 'Equal'.",
    ],
    [
      '$filter',
      'name eq 1.5',
      400,
      "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Single' for operator kind 'Equal'.",
    ],
    [
      '$filter',
      'name eq 0.1',
      400,
      "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Single' for operator kind 'Equal'.",
    ],
    [
      '$filter',
      'name eq 1e2',
      400,
      "A binary operator with incompatible types was detected. Found operand types 'Edm.String' and 'Edm.Single' for operator kind 'Equal'.",
    ],
    ['$filter', 'quantity eq @', 400, "Syntax error at position 13 in 'quantity eq @'."],
    ['$filter', '@', 400, "Syntax error at position 1 in '@'."],
    ['$filter', 'quantity eq @ ', 400, "Syntax error: character ' ' is not valid at position 13 in 'quantity eq @ '."],
    ['$filter', 'quantity eq @1', 400, "Syntax error: character '1' is not valid at position 13 in 'quantity eq @1'."],
    [
      '$filter',
      'quantity eq @@v',
      400,
      "Syntax error: character '@' is not valid at position 13 in 'quantity eq @@v'.",
    ],
    ['$filter', 'quantity eq --1', 400, "Unrecognized 'Edm.Int32' literal '--1' at '12' in 'quantity eq --1'."],
    ['$filter', 'quantity eq --1.5', 400, "Unrecognized 'Edm.Single' literal '--1.5' at '12' in 'quantity eq --1.5'."],
    ['$filter', 'quantity eq --1L', 400, "Unrecognized 'Edm.Int64' literal '--1L' at '12' in 'quantity eq --1L'."],
    ['$filter', 'quantity eq --1m', 400, "Unrecognized 'Edm.Decimal' literal '--1m' at '12' in 'quantity eq --1m'."],
    ['$filter', 'quantity eq --1e2', 400, "Unrecognized 'Edm.Single' literal '--1e2' at '12' in 'quantity eq --1e2'."],
    [
      '$filter',
      'quantity eq --2147483648',
      400,
      "Unrecognized 'Edm.Int32' literal '--2147483648' at '12' in 'quantity eq --2147483648'.",
    ],
    [
      '$filter',
      'quantity eq --2147483649',
      400,
      "Unrecognized 'Edm.Int64' literal '--2147483649' at '12' in 'quantity eq --2147483649'.",
    ],
    [
      '$filter',
      'quantity eq --9223372036854775808',
      400,
      "Unrecognized 'Edm.Int64' literal '--9223372036854775808' at '12' in 'quantity eq --9223372036854775808'.",
    ],
    [
      '$filter',
      'quantity eq --9223372036854775809',
      400,
      "Unrecognized 'Edm.Decimal' literal '--9223372036854775809' at '12' in 'quantity eq --9223372036854775809'.",
    ],
    ['$filter', 'quantity eq --0.1', 400, "Unrecognized 'Edm.Single' literal '--0.1' at '12' in 'quantity eq --0.1'."],
    [
      '$filter',
      'quantity eq --1.2345678',
      400,
      "Unrecognized 'Edm.Double' literal '--1.2345678' at '12' in 'quantity eq --1.2345678'.",
    ],
    [
      '$filter',
      'quantity eq --1.23456789',
      400,
      "Unrecognized 'Edm.Double' literal '--1.23456789' at '12' in 'quantity eq --1.23456789'.",
    ],
    [
      '$filter',
      'quantity eq --0.10000000000000001',
      400,
      "Unrecognized 'Edm.Decimal' literal '--0.10000000000000001' at '12' in 'quantity eq --0.10000000000000001'.",
    ],
    [
      '$filter',
      'quantity eq --1e100',
      400,
      "Unrecognized 'Edm.Double' literal '--1e100' at '12' in 'quantity eq --1e100'.",
    ],
    ['$filter', 'quantity eq --1d', 400, "Unrecognized 'Edm.Double' literal '--1d' at '12' in 'quantity eq --1d'."],
    ['$filter', 'quantity eq --1f', 400, "Unrecognized 'Edm.Single' literal '--1f' at '12' in 'quantity eq --1f'."],
    [
      '$filter',
      'quantity eq --79228162514264337593543950335',
      400,
      "Unrecognized 'Edm.Decimal' literal '--79228162514264337593543950335' at '12' in 'quantity eq --79228162514264337593543950335'.",
    ],
    [
      '$filter',
      'quantity eq --79228162514264337593543950336',
      400,
      "Unrecognized 'Edm.Double' literal '--79228162514264337593543950336' at '12' in 'quantity eq --79228162514264337593543950336'.",
    ],
    [
      '$filter',
      'quantity eq --10000000000000000000',
      400,
      "Unrecognized 'Edm.Single' literal '--10000000000000000000' at '12' in 'quantity eq --10000000000000000000'.",
    ],
    [
      '$filter',
      'quantity eq --18446744073709551616',
      400,
      "Unrecognized 'Edm.Decimal' literal '--18446744073709551616' at '12' in 'quantity eq --18446744073709551616'.",
    ],
    [
      '$filter',
      'quantity eq --10000000000000000000000000000',
      400,
      "Unrecognized 'Edm.Double' literal '--10000000000000000000000000000' at '12' in 'quantity eq --10000000000000000000000000000'.",
    ],
    ['$filter', 'quantity eq ---1', 400, "Unrecognized 'Edm.Int32' literal '--1' at '13' in 'quantity eq ---1'."],
    ['$filter', 'quantity eq - -1', 400, "Unrecognized 'Edm.Int32' literal '--1' at '12' in 'quantity eq - -1'."],
    ['$filter', 'quantity eq --1e400', 400, "Numeric string '-1e400' is not a valid Int32/Int64/Double/Decimal."],
    ['$filter', 'quantity eq --quantity', 501, 'The "Negate" operator isn\'t supported.'],
    ['$skip', '1', 400, 'Skip Clause is not supported in CRM'],
    ['$skip', '0', 400, 'Skip Clause is not supported in CRM'],
    ['$skip', '-1', 400, 'Skip Clause is not supported in CRM'],
    ['$skip', 'abc', 400, 'Skip Clause is not supported in CRM'],
  ],
  selectedIndices: [
    0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 14, 15, 16, 17, 18, 19, 20, 21, 22, 24, 25, 26, 27, 28, 30, 34, 35, 36,
    37, 38, 39, 40, 41, 42, 43, 45, 46, 47, 48, 49, 51, 52, 53, 55, 57, 58, 59, 60, 61, 62,
  ],
};
__paqQueryBindings(import.meta.url, [
  {
    kind: 'query-reader-matrix-v1',
    repositoryRoot: '../..',
    sourceAstSha256: '5366883dcbcb099c28df9afbac5efd2248aee8a7bfada05f8d1fa65ef50c6a2e',
    queryDescriptorSha256: '478b750a24a45e364d9dfccb534d64f316d048eefabacc7a596dfde04f54cba2',
    helperSha256: '0c7afdd9e036fbb2282d88bfbc5b72a76220a2deae3c635c5cd6c51841ff1eea',
    proofs: [
      {
        path: 'mirage/test/fixtures/dataverse-query-five-case-facts.json',
        sha256: '8dda4ccf3c63fe17462b3af97015064748b0ea1e8a83bec21f9822380e9b5801',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'query-30-status',
            pointer: '/captures/0/cases/0/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/0/facts/status', '/captures/1/cases/0/facts/status'],
          },
          {
            id: 'query-30-code',
            pointer: '/captures/0/cases/0/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/0/facts/code', '/captures/1/cases/0/facts/code'],
          },
          {
            id: 'query-30-message',
            pointer: '/captures/0/cases/0/facts/message',
            sha256: '110ef273bfee6b2b0a9524428b5bdcb38a074df00b78cbaec55d6ce25e57cb0b',
            replicatedPointers: ['/captures/0/cases/0/facts/message', '/captures/1/cases/0/facts/message'],
          },
          {
            id: 'query-59-status',
            pointer: '/captures/0/cases/1/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/1/facts/status', '/captures/1/cases/1/facts/status'],
          },
          {
            id: 'query-59-code',
            pointer: '/captures/0/cases/1/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/1/facts/code', '/captures/1/cases/1/facts/code'],
          },
          {
            id: 'query-59-message',
            pointer: '/captures/0/cases/1/facts/message',
            sha256: '7932eb898188b61d55a98e44b377268ff310615e00780363e4b9a73cb418a1ab',
            replicatedPointers: ['/captures/0/cases/1/facts/message', '/captures/1/cases/1/facts/message'],
          },
          {
            id: 'query-60-status',
            pointer: '/captures/0/cases/2/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/2/facts/status', '/captures/1/cases/2/facts/status'],
          },
          {
            id: 'query-60-code',
            pointer: '/captures/0/cases/2/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/2/facts/code', '/captures/1/cases/2/facts/code'],
          },
          {
            id: 'query-60-message',
            pointer: '/captures/0/cases/2/facts/message',
            sha256: '7932eb898188b61d55a98e44b377268ff310615e00780363e4b9a73cb418a1ab',
            replicatedPointers: ['/captures/0/cases/2/facts/message', '/captures/1/cases/2/facts/message'],
          },
          {
            id: 'query-61-status',
            pointer: '/captures/0/cases/3/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/3/facts/status', '/captures/1/cases/3/facts/status'],
          },
          {
            id: 'query-61-code',
            pointer: '/captures/0/cases/3/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/3/facts/code', '/captures/1/cases/3/facts/code'],
          },
          {
            id: 'query-61-message',
            pointer: '/captures/0/cases/3/facts/message',
            sha256: '7932eb898188b61d55a98e44b377268ff310615e00780363e4b9a73cb418a1ab',
            replicatedPointers: ['/captures/0/cases/3/facts/message', '/captures/1/cases/3/facts/message'],
          },
          {
            id: 'query-62-status',
            pointer: '/captures/0/cases/4/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/4/facts/status', '/captures/1/cases/4/facts/status'],
          },
          {
            id: 'query-62-code',
            pointer: '/captures/0/cases/4/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/4/facts/code', '/captures/1/cases/4/facts/code'],
          },
          {
            id: 'query-62-message',
            pointer: '/captures/0/cases/4/facts/message',
            sha256: '7932eb898188b61d55a98e44b377268ff310615e00780363e4b9a73cb418a1ab',
            replicatedPointers: ['/captures/0/cases/4/facts/message', '/captures/1/cases/4/facts/message'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/dataverse-query-sixteen-case-facts.json',
        sha256: '599668485be03c6b521212a806871becc636809bf1061f0cd8596b93665d456a',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'query-14-status',
            pointer: '/captures/0/cases/0/facts/status',
            sha256: '1158e7e12c5e7362318e5e3c2e1f2f1ab49578ab1d1691e9818a7c3f6b30b528',
            replicatedPointers: ['/captures/0/cases/0/facts/status', '/captures/1/cases/0/facts/status'],
          },
          {
            id: 'query-14-code',
            pointer: '/captures/0/cases/0/facts/code',
            sha256: '8ac23cc3456a03cef1d40eefb627035a0934ea8e61f7b59770cac49cb1717bf6',
            replicatedPointers: ['/captures/0/cases/0/facts/code', '/captures/1/cases/0/facts/code'],
          },
          {
            id: 'query-14-message',
            pointer: '/captures/0/cases/0/facts/message',
            sha256: '2b09b2c98b7cd4a359178da3bf71cdea8fc7b495b6586616090aaaff506bdee2',
            replicatedPointers: ['/captures/0/cases/0/facts/message', '/captures/1/cases/0/facts/message'],
          },
          {
            id: 'query-15-status',
            pointer: '/captures/0/cases/1/facts/status',
            sha256: '1158e7e12c5e7362318e5e3c2e1f2f1ab49578ab1d1691e9818a7c3f6b30b528',
            replicatedPointers: ['/captures/0/cases/1/facts/status', '/captures/1/cases/1/facts/status'],
          },
          {
            id: 'query-15-code',
            pointer: '/captures/0/cases/1/facts/code',
            sha256: '8ac23cc3456a03cef1d40eefb627035a0934ea8e61f7b59770cac49cb1717bf6',
            replicatedPointers: ['/captures/0/cases/1/facts/code', '/captures/1/cases/1/facts/code'],
          },
          {
            id: 'query-15-message',
            pointer: '/captures/0/cases/1/facts/message',
            sha256: '2b09b2c98b7cd4a359178da3bf71cdea8fc7b495b6586616090aaaff506bdee2',
            replicatedPointers: ['/captures/0/cases/1/facts/message', '/captures/1/cases/1/facts/message'],
          },
          {
            id: 'query-16-status',
            pointer: '/captures/0/cases/2/facts/status',
            sha256: '1158e7e12c5e7362318e5e3c2e1f2f1ab49578ab1d1691e9818a7c3f6b30b528',
            replicatedPointers: ['/captures/0/cases/2/facts/status', '/captures/1/cases/2/facts/status'],
          },
          {
            id: 'query-16-code',
            pointer: '/captures/0/cases/2/facts/code',
            sha256: '8ac23cc3456a03cef1d40eefb627035a0934ea8e61f7b59770cac49cb1717bf6',
            replicatedPointers: ['/captures/0/cases/2/facts/code', '/captures/1/cases/2/facts/code'],
          },
          {
            id: 'query-16-message',
            pointer: '/captures/0/cases/2/facts/message',
            sha256: '2b09b2c98b7cd4a359178da3bf71cdea8fc7b495b6586616090aaaff506bdee2',
            replicatedPointers: ['/captures/0/cases/2/facts/message', '/captures/1/cases/2/facts/message'],
          },
          {
            id: 'query-17-status',
            pointer: '/captures/0/cases/3/facts/status',
            sha256: '1158e7e12c5e7362318e5e3c2e1f2f1ab49578ab1d1691e9818a7c3f6b30b528',
            replicatedPointers: ['/captures/0/cases/3/facts/status', '/captures/1/cases/3/facts/status'],
          },
          {
            id: 'query-17-code',
            pointer: '/captures/0/cases/3/facts/code',
            sha256: '8ac23cc3456a03cef1d40eefb627035a0934ea8e61f7b59770cac49cb1717bf6',
            replicatedPointers: ['/captures/0/cases/3/facts/code', '/captures/1/cases/3/facts/code'],
          },
          {
            id: 'query-17-message',
            pointer: '/captures/0/cases/3/facts/message',
            sha256: '2b09b2c98b7cd4a359178da3bf71cdea8fc7b495b6586616090aaaff506bdee2',
            replicatedPointers: ['/captures/0/cases/3/facts/message', '/captures/1/cases/3/facts/message'],
          },
          {
            id: 'query-18-status',
            pointer: '/captures/0/cases/4/facts/status',
            sha256: '1158e7e12c5e7362318e5e3c2e1f2f1ab49578ab1d1691e9818a7c3f6b30b528',
            replicatedPointers: ['/captures/0/cases/4/facts/status', '/captures/1/cases/4/facts/status'],
          },
          {
            id: 'query-18-code',
            pointer: '/captures/0/cases/4/facts/code',
            sha256: '8ac23cc3456a03cef1d40eefb627035a0934ea8e61f7b59770cac49cb1717bf6',
            replicatedPointers: ['/captures/0/cases/4/facts/code', '/captures/1/cases/4/facts/code'],
          },
          {
            id: 'query-18-message',
            pointer: '/captures/0/cases/4/facts/message',
            sha256: '2b09b2c98b7cd4a359178da3bf71cdea8fc7b495b6586616090aaaff506bdee2',
            replicatedPointers: ['/captures/0/cases/4/facts/message', '/captures/1/cases/4/facts/message'],
          },
          {
            id: 'query-19-status',
            pointer: '/captures/0/cases/5/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/5/facts/status', '/captures/1/cases/5/facts/status'],
          },
          {
            id: 'query-19-code',
            pointer: '/captures/0/cases/5/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/5/facts/code', '/captures/1/cases/5/facts/code'],
          },
          {
            id: 'query-19-message',
            pointer: '/captures/0/cases/5/facts/message',
            sha256: '1b42e2a7bfc1f60482e27cc3c839a515383d0656859a7f48684d2e0d6b52a09d',
            replicatedPointers: ['/captures/0/cases/5/facts/message', '/captures/1/cases/5/facts/message'],
          },
          {
            id: 'query-20-status',
            pointer: '/captures/0/cases/6/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/6/facts/status', '/captures/1/cases/6/facts/status'],
          },
          {
            id: 'query-20-code',
            pointer: '/captures/0/cases/6/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/6/facts/code', '/captures/1/cases/6/facts/code'],
          },
          {
            id: 'query-20-message',
            pointer: '/captures/0/cases/6/facts/message',
            sha256: '159dca0ba4672160a0b3b5413f6632b2689ad823a14049147eefbcc3df28821d',
            replicatedPointers: ['/captures/0/cases/6/facts/message', '/captures/1/cases/6/facts/message'],
          },
          {
            id: 'query-21-status',
            pointer: '/captures/0/cases/7/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/7/facts/status', '/captures/1/cases/7/facts/status'],
          },
          {
            id: 'query-21-code',
            pointer: '/captures/0/cases/7/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/7/facts/code', '/captures/1/cases/7/facts/code'],
          },
          {
            id: 'query-21-message',
            pointer: '/captures/0/cases/7/facts/message',
            sha256: '734294ab13363a15250b8139450af6a32a1e435c32572d3d8f651856776ded1e',
            replicatedPointers: ['/captures/0/cases/7/facts/message', '/captures/1/cases/7/facts/message'],
          },
          {
            id: 'query-22-status',
            pointer: '/captures/0/cases/8/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/8/facts/status', '/captures/1/cases/8/facts/status'],
          },
          {
            id: 'query-22-code',
            pointer: '/captures/0/cases/8/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/8/facts/code', '/captures/1/cases/8/facts/code'],
          },
          {
            id: 'query-22-message',
            pointer: '/captures/0/cases/8/facts/message',
            sha256: '6cc207708756c25c231ffb22c3a4758cea351c09afd0039400d860344137a835',
            replicatedPointers: ['/captures/0/cases/8/facts/message', '/captures/1/cases/8/facts/message'],
          },
          {
            id: 'query-24-status',
            pointer: '/captures/0/cases/9/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/9/facts/status', '/captures/1/cases/9/facts/status'],
          },
          {
            id: 'query-24-code',
            pointer: '/captures/0/cases/9/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/9/facts/code', '/captures/1/cases/9/facts/code'],
          },
          {
            id: 'query-24-message',
            pointer: '/captures/0/cases/9/facts/message',
            sha256: 'e7ab725db74e38e1aeb264d7f3d59c5fddef82e66135056974cfa7de19bc277f',
            replicatedPointers: ['/captures/0/cases/9/facts/message', '/captures/1/cases/9/facts/message'],
          },
          {
            id: 'query-25-status',
            pointer: '/captures/0/cases/10/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/10/facts/status', '/captures/1/cases/10/facts/status'],
          },
          {
            id: 'query-25-code',
            pointer: '/captures/0/cases/10/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/10/facts/code', '/captures/1/cases/10/facts/code'],
          },
          {
            id: 'query-25-message',
            pointer: '/captures/0/cases/10/facts/message',
            sha256: '10583e5efee17e638ad523b7211d1a837df79d8dd2b34519e6d3420df620ba27',
            replicatedPointers: ['/captures/0/cases/10/facts/message', '/captures/1/cases/10/facts/message'],
          },
          {
            id: 'query-26-status',
            pointer: '/captures/0/cases/11/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/11/facts/status', '/captures/1/cases/11/facts/status'],
          },
          {
            id: 'query-26-code',
            pointer: '/captures/0/cases/11/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/11/facts/code', '/captures/1/cases/11/facts/code'],
          },
          {
            id: 'query-26-message',
            pointer: '/captures/0/cases/11/facts/message',
            sha256: 'f8d6b46278ef6c65123d2c16cd5ab94fbd750b6bc5edebb85a574095c472de5c',
            replicatedPointers: ['/captures/0/cases/11/facts/message', '/captures/1/cases/11/facts/message'],
          },
          {
            id: 'query-27-status',
            pointer: '/captures/0/cases/12/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/12/facts/status', '/captures/1/cases/12/facts/status'],
          },
          {
            id: 'query-27-code',
            pointer: '/captures/0/cases/12/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/12/facts/code', '/captures/1/cases/12/facts/code'],
          },
          {
            id: 'query-27-message',
            pointer: '/captures/0/cases/12/facts/message',
            sha256: 'f8d6b46278ef6c65123d2c16cd5ab94fbd750b6bc5edebb85a574095c472de5c',
            replicatedPointers: ['/captures/0/cases/12/facts/message', '/captures/1/cases/12/facts/message'],
          },
          {
            id: 'query-28-status',
            pointer: '/captures/0/cases/13/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/13/facts/status', '/captures/1/cases/13/facts/status'],
          },
          {
            id: 'query-28-code',
            pointer: '/captures/0/cases/13/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/13/facts/code', '/captures/1/cases/13/facts/code'],
          },
          {
            id: 'query-28-message',
            pointer: '/captures/0/cases/13/facts/message',
            sha256: 'f8d6b46278ef6c65123d2c16cd5ab94fbd750b6bc5edebb85a574095c472de5c',
            replicatedPointers: ['/captures/0/cases/13/facts/message', '/captures/1/cases/13/facts/message'],
          },
          {
            id: 'query-57-status',
            pointer: '/captures/0/cases/14/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/14/facts/status', '/captures/1/cases/14/facts/status'],
          },
          {
            id: 'query-57-code',
            pointer: '/captures/0/cases/14/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/14/facts/code', '/captures/1/cases/14/facts/code'],
          },
          {
            id: 'query-57-message',
            pointer: '/captures/0/cases/14/facts/message',
            sha256: '76c516d82e4cdef64d9c65dbba91b04fa465279836c8d8e7c71ac06fde05cb49',
            replicatedPointers: ['/captures/0/cases/14/facts/message', '/captures/1/cases/14/facts/message'],
          },
          {
            id: 'query-58-status',
            pointer: '/captures/0/cases/15/facts/status',
            sha256: '1158e7e12c5e7362318e5e3c2e1f2f1ab49578ab1d1691e9818a7c3f6b30b528',
            replicatedPointers: ['/captures/0/cases/15/facts/status', '/captures/1/cases/15/facts/status'],
          },
          {
            id: 'query-58-code',
            pointer: '/captures/0/cases/15/facts/code',
            sha256: '8ac23cc3456a03cef1d40eefb627035a0934ea8e61f7b59770cac49cb1717bf6',
            replicatedPointers: ['/captures/0/cases/15/facts/code', '/captures/1/cases/15/facts/code'],
          },
          {
            id: 'query-58-message',
            pointer: '/captures/0/cases/15/facts/message',
            sha256: '2b09b2c98b7cd4a359178da3bf71cdea8fc7b495b6586616090aaaff506bdee2',
            replicatedPointers: ['/captures/0/cases/15/facts/message', '/captures/1/cases/15/facts/message'],
          },
        ],
      },
      {
        path: 'mirage/test/fixtures/dataverse-query-thirty-two-case-facts.json',
        sha256: '033411f3c05530aea01b0ace2aed8a0d07a9fe1d0c4ed59a0a62e90f14a941bf',
        mode: 'reproduced-native',
        capturePointers: ['/captures/0/runSha256', '/captures/1/runSha256'],
        facts: [
          {
            id: 'query-0-status',
            pointer: '/captures/0/cases/0/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/0/facts/status', '/captures/1/cases/0/facts/status'],
          },
          {
            id: 'query-0-code',
            pointer: '/captures/0/cases/0/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/0/facts/code', '/captures/1/cases/0/facts/code'],
          },
          {
            id: 'query-0-raw-message',
            pointer: '/captures/0/cases/0/facts/message',
            sha256: 'fffa2d26d9c9b9a898fd45ee16f0626bc53bb09d6a8387ccbe553e990678349c',
            replicatedPointers: ['/captures/0/cases/0/facts/message', '/captures/1/cases/0/facts/message'],
          },
          {
            id: 'query-0-original-sdk',
            pointer: '/captures/0/cases/0/originalSdkMessages',
            sha256: '091cdb41333cba2dbd13a0b2a2ef13beae17161ff3fe471e7cd9aaf545b3cbbd',
            replicatedPointers: ['/captures/0/cases/0/originalSdkMessages', '/captures/1/cases/0/originalSdkMessages'],
          },
          {
            id: 'query-0-adapted-sdk',
            pointer: '/captures/0/cases/0/adaptedSdkMessages',
            sha256: '9135a118fd3a0834876706beb8e89431a574be2c9bd06a3b6805e3f326edc7ed',
            replicatedPointers: ['/captures/0/cases/0/adaptedSdkMessages', '/captures/1/cases/0/adaptedSdkMessages'],
          },
          {
            id: 'query-0-source-roles',
            pointer: '/captures/0/cases/0/sourceRoles',
            sha256: '8aac29fd063dea07a1af32b58d6c4b55cf3f45d3afe0f2b9dc509552fe5cee86',
            replicatedPointers: ['/captures/0/cases/0/sourceRoles', '/captures/1/cases/0/sourceRoles'],
          },
          {
            id: 'query-1-status',
            pointer: '/captures/0/cases/1/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/1/facts/status', '/captures/1/cases/1/facts/status'],
          },
          {
            id: 'query-1-code',
            pointer: '/captures/0/cases/1/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/1/facts/code', '/captures/1/cases/1/facts/code'],
          },
          {
            id: 'query-1-raw-message',
            pointer: '/captures/0/cases/1/facts/message',
            sha256: '7b72a684cde12c04207e4b2d83c98008ec8e2ec3c1530efad1da653e5a18cf36',
            replicatedPointers: ['/captures/0/cases/1/facts/message', '/captures/1/cases/1/facts/message'],
          },
          {
            id: 'query-1-original-sdk',
            pointer: '/captures/0/cases/1/originalSdkMessages',
            sha256: '2a36ab83c1739cd9dc04c61bf3dc76f56cef768bb9dcf78f0ad9600ba46dafb3',
            replicatedPointers: ['/captures/0/cases/1/originalSdkMessages', '/captures/1/cases/1/originalSdkMessages'],
          },
          {
            id: 'query-1-adapted-sdk',
            pointer: '/captures/0/cases/1/adaptedSdkMessages',
            sha256: '58d35c6fb4656d8ed4eb9deeb5b6c65a27b70a13b70fb2545f6d3fcd5684618d',
            replicatedPointers: ['/captures/0/cases/1/adaptedSdkMessages', '/captures/1/cases/1/adaptedSdkMessages'],
          },
          {
            id: 'query-1-source-roles',
            pointer: '/captures/0/cases/1/sourceRoles',
            sha256: 'd692db06bdb1dad8f732e71676c4af0bc1c1e395d05c7556b2eb2596ad98e604',
            replicatedPointers: ['/captures/0/cases/1/sourceRoles', '/captures/1/cases/1/sourceRoles'],
          },
          {
            id: 'query-2-status',
            pointer: '/captures/0/cases/2/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/2/facts/status', '/captures/1/cases/2/facts/status'],
          },
          {
            id: 'query-2-code',
            pointer: '/captures/0/cases/2/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/2/facts/code', '/captures/1/cases/2/facts/code'],
          },
          {
            id: 'query-2-raw-message',
            pointer: '/captures/0/cases/2/facts/message',
            sha256: '8ec696f4aa8fdd8f1e0a5619b0464da90c81987761cb8f0182072a2a9083fd03',
            replicatedPointers: ['/captures/0/cases/2/facts/message', '/captures/1/cases/2/facts/message'],
          },
          {
            id: 'query-2-original-sdk',
            pointer: '/captures/0/cases/2/originalSdkMessages',
            sha256: '1e19080dad8f586d77fc17a5a634440e333026103baa8d480e9795157a28e97d',
            replicatedPointers: ['/captures/0/cases/2/originalSdkMessages', '/captures/1/cases/2/originalSdkMessages'],
          },
          {
            id: 'query-2-adapted-sdk',
            pointer: '/captures/0/cases/2/adaptedSdkMessages',
            sha256: '000b16ba2b5430c66f548c161e76767e19608f9a86293dddb8d3c9e23d430da5',
            replicatedPointers: ['/captures/0/cases/2/adaptedSdkMessages', '/captures/1/cases/2/adaptedSdkMessages'],
          },
          {
            id: 'query-2-source-roles',
            pointer: '/captures/0/cases/2/sourceRoles',
            sha256: 'e8e3dd4f0dc037253bec87d87827c350fb5ee916f7f3b10fcfdca0ab366ddfdd',
            replicatedPointers: ['/captures/0/cases/2/sourceRoles', '/captures/1/cases/2/sourceRoles'],
          },
          {
            id: 'query-3-status',
            pointer: '/captures/0/cases/3/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/3/facts/status', '/captures/1/cases/3/facts/status'],
          },
          {
            id: 'query-3-code',
            pointer: '/captures/0/cases/3/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/3/facts/code', '/captures/1/cases/3/facts/code'],
          },
          {
            id: 'query-3-raw-message',
            pointer: '/captures/0/cases/3/facts/message',
            sha256: 'a3b2fc7b9abb90085441404756a251c0c76674fd9e05fb3270fdcb3e0429a3d0',
            replicatedPointers: ['/captures/0/cases/3/facts/message', '/captures/1/cases/3/facts/message'],
          },
          {
            id: 'query-3-original-sdk',
            pointer: '/captures/0/cases/3/originalSdkMessages',
            sha256: '8e5e079e29eb7c7fa8d40304f3602cb33936ccfe9e555b6a151015d97bdf0743',
            replicatedPointers: ['/captures/0/cases/3/originalSdkMessages', '/captures/1/cases/3/originalSdkMessages'],
          },
          {
            id: 'query-3-adapted-sdk',
            pointer: '/captures/0/cases/3/adaptedSdkMessages',
            sha256: 'f6f8bc3f047a3f52b2706ac4175a3a9206d5e39f0693f53ba2cf3a727961ea7c',
            replicatedPointers: ['/captures/0/cases/3/adaptedSdkMessages', '/captures/1/cases/3/adaptedSdkMessages'],
          },
          {
            id: 'query-3-source-roles',
            pointer: '/captures/0/cases/3/sourceRoles',
            sha256: '3334192509ee6c1cbdc5680caf72ddccc542fa41d730b1a0f15667ef353e246c',
            replicatedPointers: ['/captures/0/cases/3/sourceRoles', '/captures/1/cases/3/sourceRoles'],
          },
          {
            id: 'query-4-status',
            pointer: '/captures/0/cases/4/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/4/facts/status', '/captures/1/cases/4/facts/status'],
          },
          {
            id: 'query-4-code',
            pointer: '/captures/0/cases/4/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/4/facts/code', '/captures/1/cases/4/facts/code'],
          },
          {
            id: 'query-4-raw-message',
            pointer: '/captures/0/cases/4/facts/message',
            sha256: '778f1156fd6504bf9dbd38fc9a4e7a3918fa3744a6e3b0920b3c033ffeb5fee1',
            replicatedPointers: ['/captures/0/cases/4/facts/message', '/captures/1/cases/4/facts/message'],
          },
          {
            id: 'query-4-original-sdk',
            pointer: '/captures/0/cases/4/originalSdkMessages',
            sha256: '364e63880424ee03c0a0922d1cf83e2dec179f941c4273973fcba4a09db5632a',
            replicatedPointers: ['/captures/0/cases/4/originalSdkMessages', '/captures/1/cases/4/originalSdkMessages'],
          },
          {
            id: 'query-4-adapted-sdk',
            pointer: '/captures/0/cases/4/adaptedSdkMessages',
            sha256: '0195b555cb33e7860680e4b23eef82352595f93da307914e3d1b51d903807b0a',
            replicatedPointers: ['/captures/0/cases/4/adaptedSdkMessages', '/captures/1/cases/4/adaptedSdkMessages'],
          },
          {
            id: 'query-4-source-roles',
            pointer: '/captures/0/cases/4/sourceRoles',
            sha256: 'fae83005a1c27103f4001a4891006f5552d00e9e8b3494bec78182fa109f1c37',
            replicatedPointers: ['/captures/0/cases/4/sourceRoles', '/captures/1/cases/4/sourceRoles'],
          },
          {
            id: 'query-5-status',
            pointer: '/captures/0/cases/5/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/5/facts/status', '/captures/1/cases/5/facts/status'],
          },
          {
            id: 'query-5-code',
            pointer: '/captures/0/cases/5/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/5/facts/code', '/captures/1/cases/5/facts/code'],
          },
          {
            id: 'query-5-raw-message',
            pointer: '/captures/0/cases/5/facts/message',
            sha256: '430b9847dfce5dd07a83160498e74ab473a2f0cd34996dfa10d5a675e763ab2d',
            replicatedPointers: ['/captures/0/cases/5/facts/message', '/captures/1/cases/5/facts/message'],
          },
          {
            id: 'query-5-original-sdk',
            pointer: '/captures/0/cases/5/originalSdkMessages',
            sha256: '780a7d2fc2cd566cd4a2c9d7fede5ef322937fceb8ee27c8274c25acf1385124',
            replicatedPointers: ['/captures/0/cases/5/originalSdkMessages', '/captures/1/cases/5/originalSdkMessages'],
          },
          {
            id: 'query-5-adapted-sdk',
            pointer: '/captures/0/cases/5/adaptedSdkMessages',
            sha256: '0b1d49cb51106b8933ddce5f65fe85089515b3646ed5d194e3ff98d76363963b',
            replicatedPointers: ['/captures/0/cases/5/adaptedSdkMessages', '/captures/1/cases/5/adaptedSdkMessages'],
          },
          {
            id: 'query-5-source-roles',
            pointer: '/captures/0/cases/5/sourceRoles',
            sha256: '3c632503718a3e3982427f47fb4cf4365cb330c045d1cacc15de6bca795b6ada',
            replicatedPointers: ['/captures/0/cases/5/sourceRoles', '/captures/1/cases/5/sourceRoles'],
          },
          {
            id: 'query-6-status',
            pointer: '/captures/0/cases/6/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/6/facts/status', '/captures/1/cases/6/facts/status'],
          },
          {
            id: 'query-6-code',
            pointer: '/captures/0/cases/6/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/6/facts/code', '/captures/1/cases/6/facts/code'],
          },
          {
            id: 'query-6-raw-message',
            pointer: '/captures/0/cases/6/facts/message',
            sha256: '9a4fe3fb795c6a2de3e2a354626c34b67b5b035f1794c05ae96e406f030c5f4f',
            replicatedPointers: ['/captures/0/cases/6/facts/message', '/captures/1/cases/6/facts/message'],
          },
          {
            id: 'query-6-original-sdk',
            pointer: '/captures/0/cases/6/originalSdkMessages',
            sha256: 'a3996b2084eccaf34c2d92e917c2ab03a47d26c11b917c9a9c0e83fdc2c4b871',
            replicatedPointers: ['/captures/0/cases/6/originalSdkMessages', '/captures/1/cases/6/originalSdkMessages'],
          },
          {
            id: 'query-6-adapted-sdk',
            pointer: '/captures/0/cases/6/adaptedSdkMessages',
            sha256: 'b5e2b2f0f76a726685609817f2c182c8efd7b1668ddce833301c720fc4696b1b',
            replicatedPointers: ['/captures/0/cases/6/adaptedSdkMessages', '/captures/1/cases/6/adaptedSdkMessages'],
          },
          {
            id: 'query-6-source-roles',
            pointer: '/captures/0/cases/6/sourceRoles',
            sha256: '59d6dab3dbb734bd9f73b827481d08bfcd4f0c3199a666d898210d08d24d6008',
            replicatedPointers: ['/captures/0/cases/6/sourceRoles', '/captures/1/cases/6/sourceRoles'],
          },
          {
            id: 'query-7-status',
            pointer: '/captures/0/cases/7/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/7/facts/status', '/captures/1/cases/7/facts/status'],
          },
          {
            id: 'query-7-code',
            pointer: '/captures/0/cases/7/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/7/facts/code', '/captures/1/cases/7/facts/code'],
          },
          {
            id: 'query-7-raw-message',
            pointer: '/captures/0/cases/7/facts/message',
            sha256: 'f2bafa7259c7d7fcce0341ecc08c2229eb2e95397b5ff60e08bd56355fc0f839',
            replicatedPointers: ['/captures/0/cases/7/facts/message', '/captures/1/cases/7/facts/message'],
          },
          {
            id: 'query-7-original-sdk',
            pointer: '/captures/0/cases/7/originalSdkMessages',
            sha256: 'd83273b426d0f706f0cd1c750fbc63172249517b358c7b25e08f4dc73a310bf1',
            replicatedPointers: ['/captures/0/cases/7/originalSdkMessages', '/captures/1/cases/7/originalSdkMessages'],
          },
          {
            id: 'query-7-adapted-sdk',
            pointer: '/captures/0/cases/7/adaptedSdkMessages',
            sha256: '144d282b6615f59952a28f2e6019f9c747b968d38f52c5b879c3c89ebf7f5316',
            replicatedPointers: ['/captures/0/cases/7/adaptedSdkMessages', '/captures/1/cases/7/adaptedSdkMessages'],
          },
          {
            id: 'query-7-source-roles',
            pointer: '/captures/0/cases/7/sourceRoles',
            sha256: '0168010064802de94f34b01341a2b4ffb698a54e5defb1b1efbf8a4eaec5d395',
            replicatedPointers: ['/captures/0/cases/7/sourceRoles', '/captures/1/cases/7/sourceRoles'],
          },
          {
            id: 'query-8-status',
            pointer: '/captures/0/cases/8/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/8/facts/status', '/captures/1/cases/8/facts/status'],
          },
          {
            id: 'query-8-code',
            pointer: '/captures/0/cases/8/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/8/facts/code', '/captures/1/cases/8/facts/code'],
          },
          {
            id: 'query-8-raw-message',
            pointer: '/captures/0/cases/8/facts/message',
            sha256: 'd67db2575580ab3f4f830b55f1fca82b3943d6d58b07d083386d0fbe23cf9390',
            replicatedPointers: ['/captures/0/cases/8/facts/message', '/captures/1/cases/8/facts/message'],
          },
          {
            id: 'query-8-original-sdk',
            pointer: '/captures/0/cases/8/originalSdkMessages',
            sha256: '8b2af931b07c7f0d59769a212206b2e1075789166c9d29115e018e31c45da55b',
            replicatedPointers: ['/captures/0/cases/8/originalSdkMessages', '/captures/1/cases/8/originalSdkMessages'],
          },
          {
            id: 'query-8-adapted-sdk',
            pointer: '/captures/0/cases/8/adaptedSdkMessages',
            sha256: 'be85bf6b3a068ef47d0f1c68f0342ba85d25a457177b72c47212b6c3f3c82bb8',
            replicatedPointers: ['/captures/0/cases/8/adaptedSdkMessages', '/captures/1/cases/8/adaptedSdkMessages'],
          },
          {
            id: 'query-8-source-roles',
            pointer: '/captures/0/cases/8/sourceRoles',
            sha256: '44328ac03f17d32028fd8e511243a808b5dc7749f6f0bf863ce154ba0b3c09d3',
            replicatedPointers: ['/captures/0/cases/8/sourceRoles', '/captures/1/cases/8/sourceRoles'],
          },
          {
            id: 'query-9-status',
            pointer: '/captures/0/cases/9/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/9/facts/status', '/captures/1/cases/9/facts/status'],
          },
          {
            id: 'query-9-code',
            pointer: '/captures/0/cases/9/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/9/facts/code', '/captures/1/cases/9/facts/code'],
          },
          {
            id: 'query-9-raw-message',
            pointer: '/captures/0/cases/9/facts/message',
            sha256: 'f29086366acc256453cc6fdd26bd611506fe0beda66f0b48f8177d5bb68b1c75',
            replicatedPointers: ['/captures/0/cases/9/facts/message', '/captures/1/cases/9/facts/message'],
          },
          {
            id: 'query-9-original-sdk',
            pointer: '/captures/0/cases/9/originalSdkMessages',
            sha256: 'c9ef57e1e3c848838530d941b16bc8f80ce101017f9596206c46b0ee2385b84a',
            replicatedPointers: ['/captures/0/cases/9/originalSdkMessages', '/captures/1/cases/9/originalSdkMessages'],
          },
          {
            id: 'query-9-adapted-sdk',
            pointer: '/captures/0/cases/9/adaptedSdkMessages',
            sha256: '3265e2910f4af9fce2b6c30a15d52c2a4627be0fcbd0ca80f108382a241fc321',
            replicatedPointers: ['/captures/0/cases/9/adaptedSdkMessages', '/captures/1/cases/9/adaptedSdkMessages'],
          },
          {
            id: 'query-9-source-roles',
            pointer: '/captures/0/cases/9/sourceRoles',
            sha256: 'ae66eeb05e031df42cc0b4d8fd3e70725b6432f8f8b4de646bee8d72e4c179e1',
            replicatedPointers: ['/captures/0/cases/9/sourceRoles', '/captures/1/cases/9/sourceRoles'],
          },
          {
            id: 'query-10-status',
            pointer: '/captures/0/cases/10/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/10/facts/status', '/captures/1/cases/10/facts/status'],
          },
          {
            id: 'query-10-code',
            pointer: '/captures/0/cases/10/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/10/facts/code', '/captures/1/cases/10/facts/code'],
          },
          {
            id: 'query-10-raw-message',
            pointer: '/captures/0/cases/10/facts/message',
            sha256: 'a0e091cdb66f3985d7994045dd78eaaa2bba08e1f1f4b9241008836b71dd6731',
            replicatedPointers: ['/captures/0/cases/10/facts/message', '/captures/1/cases/10/facts/message'],
          },
          {
            id: 'query-10-original-sdk',
            pointer: '/captures/0/cases/10/originalSdkMessages',
            sha256: '68694661d7cd8bc85f0b45d6fd70edcd51725adcae9e0584584538d48a28cd8c',
            replicatedPointers: [
              '/captures/0/cases/10/originalSdkMessages',
              '/captures/1/cases/10/originalSdkMessages',
            ],
          },
          {
            id: 'query-10-adapted-sdk',
            pointer: '/captures/0/cases/10/adaptedSdkMessages',
            sha256: '3c49baeecc39bd38d65ebd091450ab3e93be65f329ca39b9bd2eb45ce75b126c',
            replicatedPointers: ['/captures/0/cases/10/adaptedSdkMessages', '/captures/1/cases/10/adaptedSdkMessages'],
          },
          {
            id: 'query-10-source-roles',
            pointer: '/captures/0/cases/10/sourceRoles',
            sha256: '2dff467a08bf26c917053bcb5c242dc7daf20eed5a0301361963e65a2cd6193d',
            replicatedPointers: ['/captures/0/cases/10/sourceRoles', '/captures/1/cases/10/sourceRoles'],
          },
          {
            id: 'query-11-status',
            pointer: '/captures/0/cases/11/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/11/facts/status', '/captures/1/cases/11/facts/status'],
          },
          {
            id: 'query-11-code',
            pointer: '/captures/0/cases/11/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/11/facts/code', '/captures/1/cases/11/facts/code'],
          },
          {
            id: 'query-11-raw-message',
            pointer: '/captures/0/cases/11/facts/message',
            sha256: '26ade920b4917d82bf377766cd5599b6febe050a36ed8983570b214c2e2a94ea',
            replicatedPointers: ['/captures/0/cases/11/facts/message', '/captures/1/cases/11/facts/message'],
          },
          {
            id: 'query-11-original-sdk',
            pointer: '/captures/0/cases/11/originalSdkMessages',
            sha256: 'f3481841492f4fc611c03f29bea29ffd22d99f589cd7b963db7416d4ec3c4e9c',
            replicatedPointers: [
              '/captures/0/cases/11/originalSdkMessages',
              '/captures/1/cases/11/originalSdkMessages',
            ],
          },
          {
            id: 'query-11-adapted-sdk',
            pointer: '/captures/0/cases/11/adaptedSdkMessages',
            sha256: '6b1232ec0f6dabf9a8246cf030109e8cec6183bcc7fc6d957e1db2e8e1166a53',
            replicatedPointers: ['/captures/0/cases/11/adaptedSdkMessages', '/captures/1/cases/11/adaptedSdkMessages'],
          },
          {
            id: 'query-11-source-roles',
            pointer: '/captures/0/cases/11/sourceRoles',
            sha256: '2b53c107573711c81c98edee8e249168fa498411ec3ea0ae5c59946280393577',
            replicatedPointers: ['/captures/0/cases/11/sourceRoles', '/captures/1/cases/11/sourceRoles'],
          },
          {
            id: 'query-12-status',
            pointer: '/captures/0/cases/12/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/12/facts/status', '/captures/1/cases/12/facts/status'],
          },
          {
            id: 'query-12-code',
            pointer: '/captures/0/cases/12/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/12/facts/code', '/captures/1/cases/12/facts/code'],
          },
          {
            id: 'query-12-raw-message',
            pointer: '/captures/0/cases/12/facts/message',
            sha256: 'f7b95d53acdc0d5420ae3d946caee4065b63a184de3bbbec9c352afa03134a51',
            replicatedPointers: ['/captures/0/cases/12/facts/message', '/captures/1/cases/12/facts/message'],
          },
          {
            id: 'query-12-original-sdk',
            pointer: '/captures/0/cases/12/originalSdkMessages',
            sha256: 'd13e448e10b9a8adba5622038decd0b601af700109fa7bc6cf6b5f4bdb6a76be',
            replicatedPointers: [
              '/captures/0/cases/12/originalSdkMessages',
              '/captures/1/cases/12/originalSdkMessages',
            ],
          },
          {
            id: 'query-12-adapted-sdk',
            pointer: '/captures/0/cases/12/adaptedSdkMessages',
            sha256: 'd4ff6d5a97bd3ecdb3626e9106607bc0de857f18f0f924cd4f4a43966865cf4c',
            replicatedPointers: ['/captures/0/cases/12/adaptedSdkMessages', '/captures/1/cases/12/adaptedSdkMessages'],
          },
          {
            id: 'query-12-source-roles',
            pointer: '/captures/0/cases/12/sourceRoles',
            sha256: 'f52d0369c60bf518d0394620f1b935a6a0130e51a5df80a69fd1133c13c8fbb2',
            replicatedPointers: ['/captures/0/cases/12/sourceRoles', '/captures/1/cases/12/sourceRoles'],
          },
          {
            id: 'query-34-status',
            pointer: '/captures/0/cases/13/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/13/facts/status', '/captures/1/cases/13/facts/status'],
          },
          {
            id: 'query-34-code',
            pointer: '/captures/0/cases/13/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/13/facts/code', '/captures/1/cases/13/facts/code'],
          },
          {
            id: 'query-34-raw-message',
            pointer: '/captures/0/cases/13/facts/message',
            sha256: 'b917bb8b8d312f75398fd5b8846f254ce4e953629f5599b78e3698a5bda3d96c',
            replicatedPointers: ['/captures/0/cases/13/facts/message', '/captures/1/cases/13/facts/message'],
          },
          {
            id: 'query-34-original-sdk',
            pointer: '/captures/0/cases/13/originalSdkMessages',
            sha256: '097a91460620ce5295f8276e02154618b27d009ab6a9b56380e68f4e1cdb8451',
            replicatedPointers: [
              '/captures/0/cases/13/originalSdkMessages',
              '/captures/1/cases/13/originalSdkMessages',
            ],
          },
          {
            id: 'query-34-adapted-sdk',
            pointer: '/captures/0/cases/13/adaptedSdkMessages',
            sha256: '58d70bb3f513c33b508313af62ef68756785701c498b135a0062254b9e473d44',
            replicatedPointers: ['/captures/0/cases/13/adaptedSdkMessages', '/captures/1/cases/13/adaptedSdkMessages'],
          },
          {
            id: 'query-34-source-roles',
            pointer: '/captures/0/cases/13/sourceRoles',
            sha256: 'afe76073db4c25eac1fe5d84500de5008dfbd2e5a05cf80d89bee97af041276c',
            replicatedPointers: ['/captures/0/cases/13/sourceRoles', '/captures/1/cases/13/sourceRoles'],
          },
          {
            id: 'query-35-status',
            pointer: '/captures/0/cases/14/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/14/facts/status', '/captures/1/cases/14/facts/status'],
          },
          {
            id: 'query-35-code',
            pointer: '/captures/0/cases/14/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/14/facts/code', '/captures/1/cases/14/facts/code'],
          },
          {
            id: 'query-35-raw-message',
            pointer: '/captures/0/cases/14/facts/message',
            sha256: 'a161e3813a35ffd92621a7a2c804a2aaa44ba844060ef5c143bf7cf53cfe8a6c',
            replicatedPointers: ['/captures/0/cases/14/facts/message', '/captures/1/cases/14/facts/message'],
          },
          {
            id: 'query-35-original-sdk',
            pointer: '/captures/0/cases/14/originalSdkMessages',
            sha256: '3d1705b34dfd68d2c50dd05f16de45da0cb25a2eca87dce7dac3facff81f7905',
            replicatedPointers: [
              '/captures/0/cases/14/originalSdkMessages',
              '/captures/1/cases/14/originalSdkMessages',
            ],
          },
          {
            id: 'query-35-adapted-sdk',
            pointer: '/captures/0/cases/14/adaptedSdkMessages',
            sha256: '0832d63b04894421b07e45cd39baa52d4cf65c801ccf4629e70b660e570db4f3',
            replicatedPointers: ['/captures/0/cases/14/adaptedSdkMessages', '/captures/1/cases/14/adaptedSdkMessages'],
          },
          {
            id: 'query-35-source-roles',
            pointer: '/captures/0/cases/14/sourceRoles',
            sha256: '493d100d1883042ff5a5e371aeacae10059a09655814d5c4ff51688718ffb316',
            replicatedPointers: ['/captures/0/cases/14/sourceRoles', '/captures/1/cases/14/sourceRoles'],
          },
          {
            id: 'query-36-status',
            pointer: '/captures/0/cases/15/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/15/facts/status', '/captures/1/cases/15/facts/status'],
          },
          {
            id: 'query-36-code',
            pointer: '/captures/0/cases/15/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/15/facts/code', '/captures/1/cases/15/facts/code'],
          },
          {
            id: 'query-36-raw-message',
            pointer: '/captures/0/cases/15/facts/message',
            sha256: '6ac8d899dcc2a5ec8dce845c53e0c36ebe06d4f54c60e8ba95c0f483785363fb',
            replicatedPointers: ['/captures/0/cases/15/facts/message', '/captures/1/cases/15/facts/message'],
          },
          {
            id: 'query-36-original-sdk',
            pointer: '/captures/0/cases/15/originalSdkMessages',
            sha256: '46f7699e2ddcee950c0102186078a0d2ad979f74592ad2b7162e10d3407756ed',
            replicatedPointers: [
              '/captures/0/cases/15/originalSdkMessages',
              '/captures/1/cases/15/originalSdkMessages',
            ],
          },
          {
            id: 'query-36-adapted-sdk',
            pointer: '/captures/0/cases/15/adaptedSdkMessages',
            sha256: '4b5e75749a3050e4ab9f27eaa71d0dabb7edcd756b9a4936e32c2890c374d50d',
            replicatedPointers: ['/captures/0/cases/15/adaptedSdkMessages', '/captures/1/cases/15/adaptedSdkMessages'],
          },
          {
            id: 'query-36-source-roles',
            pointer: '/captures/0/cases/15/sourceRoles',
            sha256: 'd81052b2ebd734a2be6213bfdba16b0b993675a910f2ff45bd744982ffc5d6f7',
            replicatedPointers: ['/captures/0/cases/15/sourceRoles', '/captures/1/cases/15/sourceRoles'],
          },
          {
            id: 'query-37-status',
            pointer: '/captures/0/cases/16/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/16/facts/status', '/captures/1/cases/16/facts/status'],
          },
          {
            id: 'query-37-code',
            pointer: '/captures/0/cases/16/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/16/facts/code', '/captures/1/cases/16/facts/code'],
          },
          {
            id: 'query-37-raw-message',
            pointer: '/captures/0/cases/16/facts/message',
            sha256: '818e2e603211add445a68d623afe39e6eacf6e555cb1609d6ffe8fcb67e1707f',
            replicatedPointers: ['/captures/0/cases/16/facts/message', '/captures/1/cases/16/facts/message'],
          },
          {
            id: 'query-37-original-sdk',
            pointer: '/captures/0/cases/16/originalSdkMessages',
            sha256: '5955598ccdd5ef2a9a179b67dd77b9b6ecf9c7df9a017df6850e0be5526223a5',
            replicatedPointers: [
              '/captures/0/cases/16/originalSdkMessages',
              '/captures/1/cases/16/originalSdkMessages',
            ],
          },
          {
            id: 'query-37-adapted-sdk',
            pointer: '/captures/0/cases/16/adaptedSdkMessages',
            sha256: '9a6ee114e2d53a81f816696a9910c220eb04340b48139dc523259a2e0276dc47',
            replicatedPointers: ['/captures/0/cases/16/adaptedSdkMessages', '/captures/1/cases/16/adaptedSdkMessages'],
          },
          {
            id: 'query-37-source-roles',
            pointer: '/captures/0/cases/16/sourceRoles',
            sha256: '66d98dccd566993f2312c324309fbf16ae57f8ff064c9ada4ff988dfcb3947ed',
            replicatedPointers: ['/captures/0/cases/16/sourceRoles', '/captures/1/cases/16/sourceRoles'],
          },
          {
            id: 'query-38-status',
            pointer: '/captures/0/cases/17/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/17/facts/status', '/captures/1/cases/17/facts/status'],
          },
          {
            id: 'query-38-code',
            pointer: '/captures/0/cases/17/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/17/facts/code', '/captures/1/cases/17/facts/code'],
          },
          {
            id: 'query-38-raw-message',
            pointer: '/captures/0/cases/17/facts/message',
            sha256: '90cda81cfedd94a17f04f0d84d70bb4811283c2b3f96b80a5f587bf1575cde93',
            replicatedPointers: ['/captures/0/cases/17/facts/message', '/captures/1/cases/17/facts/message'],
          },
          {
            id: 'query-38-original-sdk',
            pointer: '/captures/0/cases/17/originalSdkMessages',
            sha256: '57b249d7f68a5cef15eb4348a1e0df6ebbd2f42980f87303fa359fcd80cbb4af',
            replicatedPointers: [
              '/captures/0/cases/17/originalSdkMessages',
              '/captures/1/cases/17/originalSdkMessages',
            ],
          },
          {
            id: 'query-38-adapted-sdk',
            pointer: '/captures/0/cases/17/adaptedSdkMessages',
            sha256: '533c922ec05113ac02c55692eb3c1c52d3ee49973326bc4b6c3cc463ec19ef68',
            replicatedPointers: ['/captures/0/cases/17/adaptedSdkMessages', '/captures/1/cases/17/adaptedSdkMessages'],
          },
          {
            id: 'query-38-source-roles',
            pointer: '/captures/0/cases/17/sourceRoles',
            sha256: '7c19671d8e31b52aa6a6b4b13fa24dd2e095a6e03ae556d114bee9a8957bb264',
            replicatedPointers: ['/captures/0/cases/17/sourceRoles', '/captures/1/cases/17/sourceRoles'],
          },
          {
            id: 'query-39-status',
            pointer: '/captures/0/cases/18/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/18/facts/status', '/captures/1/cases/18/facts/status'],
          },
          {
            id: 'query-39-code',
            pointer: '/captures/0/cases/18/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/18/facts/code', '/captures/1/cases/18/facts/code'],
          },
          {
            id: 'query-39-raw-message',
            pointer: '/captures/0/cases/18/facts/message',
            sha256: 'bdc112887e2ff77d0a7124dc4a29dcd52cb978cd48aedfa77c22fa1377638ba1',
            replicatedPointers: ['/captures/0/cases/18/facts/message', '/captures/1/cases/18/facts/message'],
          },
          {
            id: 'query-39-original-sdk',
            pointer: '/captures/0/cases/18/originalSdkMessages',
            sha256: 'ac1e2695fc23c37ed2db29b1c402b5f8aa2609bae6fb9453c9d4cb3be49b4d8d',
            replicatedPointers: [
              '/captures/0/cases/18/originalSdkMessages',
              '/captures/1/cases/18/originalSdkMessages',
            ],
          },
          {
            id: 'query-39-adapted-sdk',
            pointer: '/captures/0/cases/18/adaptedSdkMessages',
            sha256: 'b54e7dfdb1b05e6fe7f8f753315e596c144e9091fa71a15afa7dce899c78b075',
            replicatedPointers: ['/captures/0/cases/18/adaptedSdkMessages', '/captures/1/cases/18/adaptedSdkMessages'],
          },
          {
            id: 'query-39-source-roles',
            pointer: '/captures/0/cases/18/sourceRoles',
            sha256: '2c4a9e782e8af3893942294b7c56be4b78fd4272da85d2981eb7c42b635f14e0',
            replicatedPointers: ['/captures/0/cases/18/sourceRoles', '/captures/1/cases/18/sourceRoles'],
          },
          {
            id: 'query-40-status',
            pointer: '/captures/0/cases/19/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/19/facts/status', '/captures/1/cases/19/facts/status'],
          },
          {
            id: 'query-40-code',
            pointer: '/captures/0/cases/19/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/19/facts/code', '/captures/1/cases/19/facts/code'],
          },
          {
            id: 'query-40-raw-message',
            pointer: '/captures/0/cases/19/facts/message',
            sha256: 'c0079191391225aa3ad8a072b8aed822af6fd190ed80c60e855987b448c61270',
            replicatedPointers: ['/captures/0/cases/19/facts/message', '/captures/1/cases/19/facts/message'],
          },
          {
            id: 'query-40-original-sdk',
            pointer: '/captures/0/cases/19/originalSdkMessages',
            sha256: '07fe2c46f3fe9c0beefccdb4b2dbdfcc5f8d498e34991eab932d9aa92008e795',
            replicatedPointers: [
              '/captures/0/cases/19/originalSdkMessages',
              '/captures/1/cases/19/originalSdkMessages',
            ],
          },
          {
            id: 'query-40-adapted-sdk',
            pointer: '/captures/0/cases/19/adaptedSdkMessages',
            sha256: 'b90e88378a1c6cebf3516dcc89b7f1965597adb2da10cf86ba07fc13b346e866',
            replicatedPointers: ['/captures/0/cases/19/adaptedSdkMessages', '/captures/1/cases/19/adaptedSdkMessages'],
          },
          {
            id: 'query-40-source-roles',
            pointer: '/captures/0/cases/19/sourceRoles',
            sha256: '61ba9f310b67c1399b2c48f606decb1971d1d2019778b3f23e1e609601921c5a',
            replicatedPointers: ['/captures/0/cases/19/sourceRoles', '/captures/1/cases/19/sourceRoles'],
          },
          {
            id: 'query-41-status',
            pointer: '/captures/0/cases/20/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/20/facts/status', '/captures/1/cases/20/facts/status'],
          },
          {
            id: 'query-41-code',
            pointer: '/captures/0/cases/20/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/20/facts/code', '/captures/1/cases/20/facts/code'],
          },
          {
            id: 'query-41-raw-message',
            pointer: '/captures/0/cases/20/facts/message',
            sha256: 'd44db76d092228a21b983ae7b9a30a55809653d9e81456453c96fac2baddc517',
            replicatedPointers: ['/captures/0/cases/20/facts/message', '/captures/1/cases/20/facts/message'],
          },
          {
            id: 'query-41-original-sdk',
            pointer: '/captures/0/cases/20/originalSdkMessages',
            sha256: '8441c5c936a77471bb6f38a926ae1e6d3fb5be1b86b25f0a87710c18c6e15517',
            replicatedPointers: [
              '/captures/0/cases/20/originalSdkMessages',
              '/captures/1/cases/20/originalSdkMessages',
            ],
          },
          {
            id: 'query-41-adapted-sdk',
            pointer: '/captures/0/cases/20/adaptedSdkMessages',
            sha256: '733abb6c8990b557e818a950eb1d6062a78ce6d191fb15a3028d4590b849d361',
            replicatedPointers: ['/captures/0/cases/20/adaptedSdkMessages', '/captures/1/cases/20/adaptedSdkMessages'],
          },
          {
            id: 'query-41-source-roles',
            pointer: '/captures/0/cases/20/sourceRoles',
            sha256: '76e88702213ed2ec05a5c2d6feb802c0dd6db888b8039aa4f4c188177066535b',
            replicatedPointers: ['/captures/0/cases/20/sourceRoles', '/captures/1/cases/20/sourceRoles'],
          },
          {
            id: 'query-42-status',
            pointer: '/captures/0/cases/21/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/21/facts/status', '/captures/1/cases/21/facts/status'],
          },
          {
            id: 'query-42-code',
            pointer: '/captures/0/cases/21/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/21/facts/code', '/captures/1/cases/21/facts/code'],
          },
          {
            id: 'query-42-raw-message',
            pointer: '/captures/0/cases/21/facts/message',
            sha256: 'b0172fdb14edb3c89e8f8aab0c3863914b37ee325cc9c1efb576d6a0103be271',
            replicatedPointers: ['/captures/0/cases/21/facts/message', '/captures/1/cases/21/facts/message'],
          },
          {
            id: 'query-42-original-sdk',
            pointer: '/captures/0/cases/21/originalSdkMessages',
            sha256: '83f929a6700ac027b9b262f7062f923e1412e7d314ea27e7a4f8668dbc99eddf',
            replicatedPointers: [
              '/captures/0/cases/21/originalSdkMessages',
              '/captures/1/cases/21/originalSdkMessages',
            ],
          },
          {
            id: 'query-42-adapted-sdk',
            pointer: '/captures/0/cases/21/adaptedSdkMessages',
            sha256: 'ff6df5ef56d76111dc7532ebf2712eb411316d874cf8273765f36dbe972b5f57',
            replicatedPointers: ['/captures/0/cases/21/adaptedSdkMessages', '/captures/1/cases/21/adaptedSdkMessages'],
          },
          {
            id: 'query-42-source-roles',
            pointer: '/captures/0/cases/21/sourceRoles',
            sha256: 'da3a4f94b9cea225b764cc81da101270edb4dd47d464b044d5b7788b6c8657e9',
            replicatedPointers: ['/captures/0/cases/21/sourceRoles', '/captures/1/cases/21/sourceRoles'],
          },
          {
            id: 'query-43-status',
            pointer: '/captures/0/cases/22/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/22/facts/status', '/captures/1/cases/22/facts/status'],
          },
          {
            id: 'query-43-code',
            pointer: '/captures/0/cases/22/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/22/facts/code', '/captures/1/cases/22/facts/code'],
          },
          {
            id: 'query-43-raw-message',
            pointer: '/captures/0/cases/22/facts/message',
            sha256: '248b7036426befb3b6fb4f5f6f38366f8a67ce47376a3cc808ee7e88d26b9707',
            replicatedPointers: ['/captures/0/cases/22/facts/message', '/captures/1/cases/22/facts/message'],
          },
          {
            id: 'query-43-original-sdk',
            pointer: '/captures/0/cases/22/originalSdkMessages',
            sha256: '3df485972c833018ac57812f292cde041af685a79db8852bf80127dad38ad02f',
            replicatedPointers: [
              '/captures/0/cases/22/originalSdkMessages',
              '/captures/1/cases/22/originalSdkMessages',
            ],
          },
          {
            id: 'query-43-adapted-sdk',
            pointer: '/captures/0/cases/22/adaptedSdkMessages',
            sha256: '4bc81a2c406cc95ae1f2c73f1c770f64447408a3e167a094fc5392b8b2f67608',
            replicatedPointers: ['/captures/0/cases/22/adaptedSdkMessages', '/captures/1/cases/22/adaptedSdkMessages'],
          },
          {
            id: 'query-43-source-roles',
            pointer: '/captures/0/cases/22/sourceRoles',
            sha256: '138ee8581ba6a2174f7a07d97e340f2e59ee8c89db4b8be11c7f8e932d7af003',
            replicatedPointers: ['/captures/0/cases/22/sourceRoles', '/captures/1/cases/22/sourceRoles'],
          },
          {
            id: 'query-45-status',
            pointer: '/captures/0/cases/23/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/23/facts/status', '/captures/1/cases/23/facts/status'],
          },
          {
            id: 'query-45-code',
            pointer: '/captures/0/cases/23/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/23/facts/code', '/captures/1/cases/23/facts/code'],
          },
          {
            id: 'query-45-raw-message',
            pointer: '/captures/0/cases/23/facts/message',
            sha256: '5fb247b169db7f201fe08ae92e792977dbd623945634561e2cca79638dd47dee',
            replicatedPointers: ['/captures/0/cases/23/facts/message', '/captures/1/cases/23/facts/message'],
          },
          {
            id: 'query-45-original-sdk',
            pointer: '/captures/0/cases/23/originalSdkMessages',
            sha256: '24f43c022e0e1e096db8396bc209ad0b9bf9069bc11eba84dfc4f30e26be1dd2',
            replicatedPointers: [
              '/captures/0/cases/23/originalSdkMessages',
              '/captures/1/cases/23/originalSdkMessages',
            ],
          },
          {
            id: 'query-45-adapted-sdk',
            pointer: '/captures/0/cases/23/adaptedSdkMessages',
            sha256: 'b2d91fab3f2531129b6b34735d8bbe266a88c60b3f11d08063e2e6b97b3d829e',
            replicatedPointers: ['/captures/0/cases/23/adaptedSdkMessages', '/captures/1/cases/23/adaptedSdkMessages'],
          },
          {
            id: 'query-45-source-roles',
            pointer: '/captures/0/cases/23/sourceRoles',
            sha256: '4d0a9153963bbe84c7c8c234b6b5ec5287090169f739076435c17641cf5e3638',
            replicatedPointers: ['/captures/0/cases/23/sourceRoles', '/captures/1/cases/23/sourceRoles'],
          },
          {
            id: 'query-46-status',
            pointer: '/captures/0/cases/24/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/24/facts/status', '/captures/1/cases/24/facts/status'],
          },
          {
            id: 'query-46-code',
            pointer: '/captures/0/cases/24/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/24/facts/code', '/captures/1/cases/24/facts/code'],
          },
          {
            id: 'query-46-raw-message',
            pointer: '/captures/0/cases/24/facts/message',
            sha256: 'b20ae7a99985c78f656522a16bb78d902c4f03a4f12a064ff9da1693925c5584',
            replicatedPointers: ['/captures/0/cases/24/facts/message', '/captures/1/cases/24/facts/message'],
          },
          {
            id: 'query-46-original-sdk',
            pointer: '/captures/0/cases/24/originalSdkMessages',
            sha256: '89fd6e48fd84819dbc35af99244738d2d25ab78e6c126f1348cff303e2592553',
            replicatedPointers: [
              '/captures/0/cases/24/originalSdkMessages',
              '/captures/1/cases/24/originalSdkMessages',
            ],
          },
          {
            id: 'query-46-adapted-sdk',
            pointer: '/captures/0/cases/24/adaptedSdkMessages',
            sha256: '9517f7fd5b6b36945dfcc6b0c540b51ce3cd4660f6013154de177b25b81b5d28',
            replicatedPointers: ['/captures/0/cases/24/adaptedSdkMessages', '/captures/1/cases/24/adaptedSdkMessages'],
          },
          {
            id: 'query-46-source-roles',
            pointer: '/captures/0/cases/24/sourceRoles',
            sha256: '6d1cfa17f7d68a4f8c3f051cf35857dcab27b7cc721a60b2273f0d1b32417666',
            replicatedPointers: ['/captures/0/cases/24/sourceRoles', '/captures/1/cases/24/sourceRoles'],
          },
          {
            id: 'query-47-status',
            pointer: '/captures/0/cases/25/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/25/facts/status', '/captures/1/cases/25/facts/status'],
          },
          {
            id: 'query-47-code',
            pointer: '/captures/0/cases/25/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/25/facts/code', '/captures/1/cases/25/facts/code'],
          },
          {
            id: 'query-47-raw-message',
            pointer: '/captures/0/cases/25/facts/message',
            sha256: '1ee0442d4e44454bba30b1ddc81f30fdeb08d2dd864597443decaadf1b46f36f',
            replicatedPointers: ['/captures/0/cases/25/facts/message', '/captures/1/cases/25/facts/message'],
          },
          {
            id: 'query-47-original-sdk',
            pointer: '/captures/0/cases/25/originalSdkMessages',
            sha256: 'fc65c5213e0bbc2f5965d99a4351ee4e8a57b1f012117407120ee13583888958',
            replicatedPointers: [
              '/captures/0/cases/25/originalSdkMessages',
              '/captures/1/cases/25/originalSdkMessages',
            ],
          },
          {
            id: 'query-47-adapted-sdk',
            pointer: '/captures/0/cases/25/adaptedSdkMessages',
            sha256: 'e918edd776d2510a340dde30166d1d535257e0f68dbc024134618364e47555c5',
            replicatedPointers: ['/captures/0/cases/25/adaptedSdkMessages', '/captures/1/cases/25/adaptedSdkMessages'],
          },
          {
            id: 'query-47-source-roles',
            pointer: '/captures/0/cases/25/sourceRoles',
            sha256: 'a7719d68eb2b1a4c77b83134da301b31f7835309fa9b913db3e979c3aa1dcc85',
            replicatedPointers: ['/captures/0/cases/25/sourceRoles', '/captures/1/cases/25/sourceRoles'],
          },
          {
            id: 'query-48-status',
            pointer: '/captures/0/cases/26/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/26/facts/status', '/captures/1/cases/26/facts/status'],
          },
          {
            id: 'query-48-code',
            pointer: '/captures/0/cases/26/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/26/facts/code', '/captures/1/cases/26/facts/code'],
          },
          {
            id: 'query-48-raw-message',
            pointer: '/captures/0/cases/26/facts/message',
            sha256: 'e181f5fa862335d85a27ccc80dad73223a16af032278f8a4e56ebeb2e4670c37',
            replicatedPointers: ['/captures/0/cases/26/facts/message', '/captures/1/cases/26/facts/message'],
          },
          {
            id: 'query-48-original-sdk',
            pointer: '/captures/0/cases/26/originalSdkMessages',
            sha256: 'd8966717f8993f7f25162369e9cfd61f9372ee8042e7a46efd673d3c95424be8',
            replicatedPointers: [
              '/captures/0/cases/26/originalSdkMessages',
              '/captures/1/cases/26/originalSdkMessages',
            ],
          },
          {
            id: 'query-48-adapted-sdk',
            pointer: '/captures/0/cases/26/adaptedSdkMessages',
            sha256: '80f4a4d5d45e4042baed342a5b7c85d80aed229fad2ea13dedc06006f6fc848e',
            replicatedPointers: ['/captures/0/cases/26/adaptedSdkMessages', '/captures/1/cases/26/adaptedSdkMessages'],
          },
          {
            id: 'query-48-source-roles',
            pointer: '/captures/0/cases/26/sourceRoles',
            sha256: '23e04fe498e8ca7c8031432d2bf0fe3de899284b67546a28c66d1ccb93ed459d',
            replicatedPointers: ['/captures/0/cases/26/sourceRoles', '/captures/1/cases/26/sourceRoles'],
          },
          {
            id: 'query-49-status',
            pointer: '/captures/0/cases/27/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/27/facts/status', '/captures/1/cases/27/facts/status'],
          },
          {
            id: 'query-49-code',
            pointer: '/captures/0/cases/27/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/27/facts/code', '/captures/1/cases/27/facts/code'],
          },
          {
            id: 'query-49-raw-message',
            pointer: '/captures/0/cases/27/facts/message',
            sha256: '11284fedd47720d86213eea1f18c063e986a47b7faff9d638a1d73d539077df5',
            replicatedPointers: ['/captures/0/cases/27/facts/message', '/captures/1/cases/27/facts/message'],
          },
          {
            id: 'query-49-original-sdk',
            pointer: '/captures/0/cases/27/originalSdkMessages',
            sha256: '349d357456dc4fa18fb10487ed1f1eaf33b740b5981e354104316955bfbc29b6',
            replicatedPointers: [
              '/captures/0/cases/27/originalSdkMessages',
              '/captures/1/cases/27/originalSdkMessages',
            ],
          },
          {
            id: 'query-49-adapted-sdk',
            pointer: '/captures/0/cases/27/adaptedSdkMessages',
            sha256: '345989687a9079a68645f7602234079b749e4c7dda950f782c257d625829d36a',
            replicatedPointers: ['/captures/0/cases/27/adaptedSdkMessages', '/captures/1/cases/27/adaptedSdkMessages'],
          },
          {
            id: 'query-49-source-roles',
            pointer: '/captures/0/cases/27/sourceRoles',
            sha256: '421acd5035eb548097e062384061141def0bea685376d1113539c0c0c1f705db',
            replicatedPointers: ['/captures/0/cases/27/sourceRoles', '/captures/1/cases/27/sourceRoles'],
          },
          {
            id: 'query-51-status',
            pointer: '/captures/0/cases/28/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/28/facts/status', '/captures/1/cases/28/facts/status'],
          },
          {
            id: 'query-51-code',
            pointer: '/captures/0/cases/28/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/28/facts/code', '/captures/1/cases/28/facts/code'],
          },
          {
            id: 'query-51-raw-message',
            pointer: '/captures/0/cases/28/facts/message',
            sha256: '828e491b4f4473a26239f137b1f235bd5587d3e8354a427bf2e6cc7493e1792a',
            replicatedPointers: ['/captures/0/cases/28/facts/message', '/captures/1/cases/28/facts/message'],
          },
          {
            id: 'query-51-original-sdk',
            pointer: '/captures/0/cases/28/originalSdkMessages',
            sha256: '3c6d03705f143a447f7f955a23780257b716dfa6aa4e21d1a76cd24d8e9581ea',
            replicatedPointers: [
              '/captures/0/cases/28/originalSdkMessages',
              '/captures/1/cases/28/originalSdkMessages',
            ],
          },
          {
            id: 'query-51-adapted-sdk',
            pointer: '/captures/0/cases/28/adaptedSdkMessages',
            sha256: '0d776b418590297d3164f84733d5c2b6a3d53f80417f041b0656fd9a7d740e72',
            replicatedPointers: ['/captures/0/cases/28/adaptedSdkMessages', '/captures/1/cases/28/adaptedSdkMessages'],
          },
          {
            id: 'query-51-source-roles',
            pointer: '/captures/0/cases/28/sourceRoles',
            sha256: 'c26615984461e30e6517315f3ee2ffe536ff4f8315da1d2779c4ad89c3fe40d7',
            replicatedPointers: ['/captures/0/cases/28/sourceRoles', '/captures/1/cases/28/sourceRoles'],
          },
          {
            id: 'query-52-status',
            pointer: '/captures/0/cases/29/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/29/facts/status', '/captures/1/cases/29/facts/status'],
          },
          {
            id: 'query-52-code',
            pointer: '/captures/0/cases/29/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/29/facts/code', '/captures/1/cases/29/facts/code'],
          },
          {
            id: 'query-52-raw-message',
            pointer: '/captures/0/cases/29/facts/message',
            sha256: '67a8d0c799f1225cb3c27bb5c7e5f1de02a280ca53471b5a9e22404bc84589d5',
            replicatedPointers: ['/captures/0/cases/29/facts/message', '/captures/1/cases/29/facts/message'],
          },
          {
            id: 'query-52-original-sdk',
            pointer: '/captures/0/cases/29/originalSdkMessages',
            sha256: '3fd48d690b45f9bb2d848cd4a740b924f60a62e846bebd3560e6797a85b92bf3',
            replicatedPointers: [
              '/captures/0/cases/29/originalSdkMessages',
              '/captures/1/cases/29/originalSdkMessages',
            ],
          },
          {
            id: 'query-52-adapted-sdk',
            pointer: '/captures/0/cases/29/adaptedSdkMessages',
            sha256: 'e23cef35e6bcf0862d983669ece1ad11b18215f96a2c1d161f68fed46d77f630',
            replicatedPointers: ['/captures/0/cases/29/adaptedSdkMessages', '/captures/1/cases/29/adaptedSdkMessages'],
          },
          {
            id: 'query-52-source-roles',
            pointer: '/captures/0/cases/29/sourceRoles',
            sha256: '3ff8107c79ab3cd50b9064f37df7970c1d4d76f95b815573847d68deea8596e7',
            replicatedPointers: ['/captures/0/cases/29/sourceRoles', '/captures/1/cases/29/sourceRoles'],
          },
          {
            id: 'query-53-status',
            pointer: '/captures/0/cases/30/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/30/facts/status', '/captures/1/cases/30/facts/status'],
          },
          {
            id: 'query-53-code',
            pointer: '/captures/0/cases/30/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/30/facts/code', '/captures/1/cases/30/facts/code'],
          },
          {
            id: 'query-53-raw-message',
            pointer: '/captures/0/cases/30/facts/message',
            sha256: '882f99b13dc3d91bd10420a4924527ec5d7706bdebfd3bed70ebee9e69ee0456',
            replicatedPointers: ['/captures/0/cases/30/facts/message', '/captures/1/cases/30/facts/message'],
          },
          {
            id: 'query-53-original-sdk',
            pointer: '/captures/0/cases/30/originalSdkMessages',
            sha256: '227505584ba26cce0152c624660f2a2a895d6a0adb8349d1526f1ca7ef67288f',
            replicatedPointers: [
              '/captures/0/cases/30/originalSdkMessages',
              '/captures/1/cases/30/originalSdkMessages',
            ],
          },
          {
            id: 'query-53-adapted-sdk',
            pointer: '/captures/0/cases/30/adaptedSdkMessages',
            sha256: '922cf0c5215e094a97118db99b949f2551a6a10fd504d6bfcc5c3badebf1c280',
            replicatedPointers: ['/captures/0/cases/30/adaptedSdkMessages', '/captures/1/cases/30/adaptedSdkMessages'],
          },
          {
            id: 'query-53-source-roles',
            pointer: '/captures/0/cases/30/sourceRoles',
            sha256: '8f5d18d1b001edc244c94a4f2824ec56e5bceb32e417b53cb5fe2e6c86128d1e',
            replicatedPointers: ['/captures/0/cases/30/sourceRoles', '/captures/1/cases/30/sourceRoles'],
          },
          {
            id: 'query-55-status',
            pointer: '/captures/0/cases/31/facts/status',
            sha256: '26d228663f13a88592a12d16cf9587caab0388b262d6d9f126ed62f9333aca94',
            replicatedPointers: ['/captures/0/cases/31/facts/status', '/captures/1/cases/31/facts/status'],
          },
          {
            id: 'query-55-code',
            pointer: '/captures/0/cases/31/facts/code',
            sha256: 'a5f233d50178ea4d95f4bf2e628750130ffdc3c181ff7e68139962a49da33a4b',
            replicatedPointers: ['/captures/0/cases/31/facts/code', '/captures/1/cases/31/facts/code'],
          },
          {
            id: 'query-55-raw-message',
            pointer: '/captures/0/cases/31/facts/message',
            sha256: '78c0305b038d2114d2c8131f82ee26b59a6105c996cbc705e8b5d68246260136',
            replicatedPointers: ['/captures/0/cases/31/facts/message', '/captures/1/cases/31/facts/message'],
          },
          {
            id: 'query-55-original-sdk',
            pointer: '/captures/0/cases/31/originalSdkMessages',
            sha256: '8515a1b4b399e7c4b69a57639ec89573ce31155287e808de606be8f610103116',
            replicatedPointers: [
              '/captures/0/cases/31/originalSdkMessages',
              '/captures/1/cases/31/originalSdkMessages',
            ],
          },
          {
            id: 'query-55-adapted-sdk',
            pointer: '/captures/0/cases/31/adaptedSdkMessages',
            sha256: 'cb383c3588c2c6c95259d19082e62ee7a7265d8edd1a9c1d490532d26766733c',
            replicatedPointers: ['/captures/0/cases/31/adaptedSdkMessages', '/captures/1/cases/31/adaptedSdkMessages'],
          },
          {
            id: 'query-55-source-roles',
            pointer: '/captures/0/cases/31/sourceRoles',
            sha256: '6b39a24a0650766ddbf46bf84ab83b3a22192701fed24e6d51cea2abf8047283',
            replicatedPointers: ['/captures/0/cases/31/sourceRoles', '/captures/1/cases/31/sourceRoles'],
          },
        ],
      },
    ],
    queryBridgeAuthoritySha256: 'd9920769e404611f0a5d643c127cf7fc12f924cce07822e76f098f1138a06e17',
  },
]);
import test from 'node:test';
import assert from 'node:assert/strict';
import { DataStore, emptyState } from '../lib/data.mjs';
import { dataverseSettings } from '../lib/dataverse-settings.mjs';
import { startDataverseApi } from '../lib/dataverse-api.mjs';
import { parseODataExpression, parseOrderBy } from '../lib/odata-query.mjs';
const APP = '10000000-0000-4000-8000-000000000001',
  ID = '20000000-0000-4000-8000-000000000001';
test('HTTP native query reader retains qualified parser positions and unary Negate statuses without changing rows', async (t) => {
  const variable = 'PAQVILO_QUERY_DIAGNOSTIC_TEST_SECRET';
  process.env[variable] = 'Invented native query test secret';
  t.after(() => delete process.env[variable]);
  const state = emptyState();
  state.mappings.sample = {
    logicalName: 'sample',
    entitySet: 'samples',
    idColumn: 'sampleid',
    nameColumn: 'name',
    fields: {
      name: { dataverseType: 'nvarchar' },
      quantity: { dataverseType: 'int' },
      enabled: { dataverseType: 'bit' },
      stamp: { dataverseType: 'datetime' },
      parentid: { dataverseType: 'lookup', target: 'sample' },
    },
    relationships: {
      parent: {
        entity: 'sample',
        from: 'parentid',
        to: 'sampleid',
        type: 'lookup',
      },
    },
  };
  state.tables.sample = [
    {
      sampleid: ID,
      name: 'Unchanged',
      quantity: 1,
      enabled: true,
      stamp: '2020-01-01T00:00:00Z',
    },
  ];
  const store = await new DataStore({ state }).init(),
    server = await startDataverseApi({
      store,
      change: (fn) => fn(),
      settings: dataverseSettings({
        enabled: true,
        applications: [
          {
            appId: APP,
            displayName: 'Invented query client',
            secretEnvironmentVariable: variable,
            roles: ['System Administrator'],
          },
        ],
      }),
      log() {},
    });
  t.after(() => server.close());
  const auth = await fetch(server.authority + '/oauth2/v2.0/token', {
    method: 'POST',
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: APP,
      client_secret: process.env[variable],
      scope: server.origin + '/.default',
    }),
  });
  assert.equal(auth.status, 200);
  const token = (await auth.json()).access_token;
  const initial = JSON.stringify(store.state.tables.sample),
    request = (params) =>
      fetch(server.origin + '/api/data/v9.2/samples?' + new URLSearchParams({ $select: 'sampleid', ...params }), {
        headers: { authorization: 'Bearer ' + token },
      });
  const cases = [
    ['$filter', 'quantity eq', 400, "Expression expected at position 11 in 'quantity eq'."],
    ['$filter', 'quantity eq ', 400, "Expression expected at position 12 in 'quantity eq '."],
    ['$filter', '(quantity eq 1', 400, "')' or operator expected at position 14 in '(quantity eq 1'."],
    ['$filter', ' (quantity eq 1', 400, "')' or operator expected at position 15 in ' (quantity eq 1'."],
    ['$filter', '((quantity eq 1)', 400, "')' or operator expected at position 16 in '((quantity eq 1)'."],
    ['$filter', '(quantity eq 1 ', 400, "')' or operator expected at position 15 in '(quantity eq 1 '."],
    ['$filter', '(quantity eq 12', 400, "')' or operator expected at position 15 in '(quantity eq 12'."],
    [
      '$filter',
      '((quantity eq 1) and (quantity eq 2)',
      400,
      "')' or operator expected at position 36 in '((quantity eq 1) and (quantity eq 2)'.",
    ],
    ['$filter', 'sampleid eq not-a-guid', 400, "Syntax error at position 18 in 'sampleid eq not-a-guid'."],
    ['$filter', 'sampleid eq bad-guid', 400, "Syntax error at position 16 in 'sampleid eq bad-guid'."],
    ['$orderby', 'name sideways', 400, "Syntax error at position 13 in 'name sideways'."],
    ['$orderby', 'name sideways ', 400, "Syntax error at position 13 in 'name sideways '."],
    ['$orderby', 'name asc sideways', 400, "Syntax error at position 17 in 'name asc sideways'."],
    ['$orderby', 'name asc, quantity sideways', 400, "Syntax error at position 27 in 'name asc, quantity sideways'."],
    ['$filter', 'quantity eq -quantity', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', '-quantity lt 0', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', 'quantity eq -(quantity)', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', 'quantity eq -(1)', 501, 'The "Negate" operator isn\'t supported.'],
    ['$filter', 'quantity eq -null', 501, 'The "Negate" operator isn\'t supported.'],
    [
      '$filter',
      'name eq -name',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.String' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'enabled eq -enabled',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.Boolean' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'stamp eq -stamp',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.DateTimeOffset' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'sampleid eq -sampleid',
      400,
      "A unary operator with an incompatible type was detected. Found operand type 'Edm.Guid' for operator kind 'Negate'.",
    ],
    [
      '$filter',
      'quantity eq +quantity',
      400,
      "Syntax error: character '+' is not valid at position 12 in 'quantity eq +quantity'.",
    ],
    ...[
      ['-2147483648', 'Edm.Int32'],
      ['2147483648', 'Edm.Int64'],
      ['1.5', 'Edm.Single'],
      ['0.1', 'Edm.Single'],
      ['1e2', 'Edm.Single'],
    ].map(([literal, type]) => [
      '$filter',
      `name eq ${literal}`,
      400,
      `A binary operator with incompatible types was detected. Found operand types 'Edm.String' and '${type}' for operator kind 'Equal'.`,
    ]),
    ...[
      ['quantity eq @', "Syntax error at position 13 in 'quantity eq @'."],
      ['@', "Syntax error at position 1 in '@'."],
      ['quantity eq @ ', "Syntax error: character ' ' is not valid at position 13 in 'quantity eq @ '."],
      ['quantity eq @1', "Syntax error: character '1' is not valid at position 13 in 'quantity eq @1'."],
      ['quantity eq @@v', "Syntax error: character '@' is not valid at position 13 in 'quantity eq @@v'."],
    ].map(([filter, message]) => ['$filter', filter, 400, message]),
    ...[
      ['1', 'Edm.Int32'],
      ['1.5', 'Edm.Single'],
      ['1L', 'Edm.Int64'],
      ['1m', 'Edm.Decimal'],
      ['1e2', 'Edm.Single'],
      ['2147483648', 'Edm.Int32'],
      ['2147483649', 'Edm.Int64'],
      ['9223372036854775808', 'Edm.Int64'],
      ['9223372036854775809', 'Edm.Decimal'],
      ['0.1', 'Edm.Single'],
      ['1.2345678', 'Edm.Double'],
      ['1.23456789', 'Edm.Double'],
      ['0.10000000000000001', 'Edm.Decimal'],
      ['1e100', 'Edm.Double'],
      ['1d', 'Edm.Double'],
      ['1f', 'Edm.Single'],
      ['79228162514264337593543950335', 'Edm.Decimal'],
      ['79228162514264337593543950336', 'Edm.Double'],
      ['10000000000000000000', 'Edm.Single'],
      ['18446744073709551616', 'Edm.Decimal'],
      ['10000000000000000000000000000', 'Edm.Double'],
    ].map(([literal, type]) => [
      '$filter',
      `quantity eq --${literal}`,
      400,
      `Unrecognized '${type}' literal '--${literal}' at '12' in 'quantity eq --${literal}'.`,
    ]),
    ['$filter', 'quantity eq ---1', 400, "Unrecognized 'Edm.Int32' literal '--1' at '13' in 'quantity eq ---1'."],
    ['$filter', 'quantity eq - -1', 400, "Unrecognized 'Edm.Int32' literal '--1' at '12' in 'quantity eq - -1'."],
    ['$filter', 'quantity eq --1e400', 400, "Numeric string '-1e400' is not a valid Int32/Int64/Double/Decimal."],
    ['$filter', 'quantity eq --quantity', 501, 'The "Negate" operator isn\'t supported.'],
    ...['1', '0', '-1', 'abc'].map((value) => ['$skip', value, 400, 'Skip Clause is not supported in CRM']),
  ];
  let __paqQueryIndex = 0;
  for (const [option, value, status, message] of cases)
    await t.test(option + ' ' + value, async () => {
      __paqQueryCase(cases, __paqQueryIndex++, [option, value, status, message], __paqQueryDescriptor);
      const response = await request({ [option]: value });
      assert.equal(response.status, status);
      const error = (await response.json()).error;
      assert.equal(error.code, status === 501 ? '0x8006088a' : '0x80060888');
      assert.equal(error.message, message);
    });
  __paqQueryComplete(__paqQueryIndex, __paqQueryDescriptor);
  // Accepted filters still select by value: a negative literal is not read as its absolute value.
  for (const [filter, aliases, expected] of [
    ['quantity eq -1', {}, []],
    ['quantity eq @v', { '@v': '-1' }, []],
    ['quantity ne -1', {}, [ID]],
    ['quantity gt -2', {}, [ID]],
    ['quantity eq null', {}, []],
    ['not enabled', {}, []],
    ['not (quantity eq -1)', {}, [ID]],
  ]) {
    const response = await request({ $filter: filter, ...aliases });
    assert.equal(response.status, 200, filter);
    assert.deepEqual(
      (await response.json()).value.map((row) => row.sampleid),
      expected,
      filter,
    );
  }
  for (const rows of [store.state.tables.sample, []]) {
    store.state.tables.sample = rows;
    for (const [filter, aliases, expectedStatus, cause] of [
      ['quantity eq -parent/quantity', {}, 400, /Unsupported OData (?:expression negate|filter near -)/],
      ["quantity eq -contains(name,'x')", {}, 400, /Unsupported OData (?:expression negate|filter near -)/],
      ['quantity eq -@v', { '@v': '1' }, 501, /Negate.*isn't supported/],
      ['quantity eq -missing', {}, 400, /Could not find a property named 'missing'/],
      ['quantity eq -@v', { '@v': 'missing' }, 400, /Parameter alias @v must be a literal value/],
    ]) {
      const response = await request({ $filter: filter, ...aliases });
      assert.equal(response.status, expectedStatus, filter);
      const error = (await response.json()).error;
      assert.match(error.message, cause, filter);
    }
  }
  store.state.tables.sample = JSON.parse(initial);
  for (const [method, body, set] of [
    ['PATCH', '{bad', ''],
    ['POST', '{"name":', 'samples'],
    ['PATCH', '{"name":"unfinished', ''],
  ]) {
    const response = await fetch(server.origin + '/api/data/v9.2/samples' + (method === 'PATCH' ? `(${ID})` : ''), {
      method,
      body,
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
    });
    assert.equal(response.status, 400);
    const error = (await response.json()).error;
    assert.equal(error.code, '0x80048d19');
    assert.equal(
      error.message,
      `Error identified in Payload provided by the user for Entity :'${set}', For more information on this error please follow this help link https://go.microsoft.com/fwlink/?linkid=2195293  ---->  InnerException : System.ArgumentException: Stream was not readable.`,
    );
    assert.equal(Object.hasOwn(error, 'cause'), false);
    assert.equal(Object.hasOwn(error, 'stack'), false);
  }
  assert.equal(JSON.stringify(store.state.tables.sample), initial);
});

test('default and strict SDK/portal parser calls retain existing unsupported syntax diagnostics', () => {
  for (const strictEdm of [false, true])
    assert.throws(
      () =>
        parseODataExpression('quantity eq -quantity', {
          strictEdm,
          columnDefinition: () => ({ dataverseType: 'int' }),
        }),
      (error) => error.status === 400 && error.message === 'Unsupported OData filter near -quantity',
    );
  assert.throws(
    () => parseODataExpression('quantity eq'),
    (error) => error.message === 'Incomplete OData filter',
  );
  assert.throws(
    () => parseOrderBy('name sideways'),
    (error) => error.message === 'Unsupported order name sideways',
  );
  for (const filter of ['quantity eq @', 'quantity eq --1'])
    assert.throws(
      () => parseODataExpression(filter),
      (error) => error.status === 400 && error.message.startsWith('Unsupported OData filter near '),
    );
});

test('invalid adjacent minus chains remain bounded errors rather than recursive stack failures', () => {
  assert.throws(
    () =>
      parseODataExpression('quantity eq ' + '-'.repeat(10000) + '1', {
        nativeSyntax: true,
        strictEdm: true,
        columnDefinition: () => ({ dataverseType: 'int' }),
      }),
    (error) => error.status === 400 && error.message.startsWith("Unrecognized 'Edm.Int32' literal "),
  );
  assert.throws(
    () =>
      parseODataExpression('quantity eq ' + '-'.repeat(10000) + 'quantity', {
        nativeSyntax: true,
        strictEdm: true,
        columnDefinition: () => ({ dataverseType: 'int' }),
      }),
    (error) => error.status === 400 && /bounded query complexity/.test(error.message),
  );
});
