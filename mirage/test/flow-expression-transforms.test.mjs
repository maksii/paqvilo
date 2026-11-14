// @test-kind contract: Paqvilo's designed runtime behaviour for flow expressions, checked on invented values and fixed clocks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DataStore, emptyState } from '../lib/data.mjs';
import { executeFlowDefinition, resolveFlowValue } from '../lib/flow-runtime.mjs';
import { FLOW_EXPRESSION_ARITY } from '../lib/flow-expression-functions.mjs';
import { fixedClock, sequentialIds } from '../lib/runtime-clock.mjs';

const state = (input = {}) => ({ input, variables: {}, parameters: {}, results: {}, items: [] });
const value = (expression, input) => resolveFlowValue(expression, state(input));
const definition = (actions) => ({ triggers: { manual: { type: 'Request', kind: 'Button' } }, actions });
const invalid = (expression) =>
  assert.throws(
    () => value(expression),
    (error) => error.status === 400 && error.code === 'LocalFlowExpression',
    expression,
  );

test('split uses literal case-sensitive delimiters and preserves empty segments', () => {
  assert.deepEqual(value("@split('red::blue::::green::', '::')"), ['red', 'blue', '', 'green', '']);
  assert.deepEqual(value("@split('left.right', '.')"), ['left', 'right']);
  assert.deepEqual(value("@split('leftRIGHT', 'right')"), ['leftRIGHT']);
  assert.deepEqual(value("@split('', ',')"), ['']);
  assert.deepEqual(value("@split('plain', ',')"), ['plain']);
  invalid("@split(null, ',')");
  invalid("@split('plain', 1)");
  assert.throws(
    () => value("@split('plain', '')"),
    (error) => error.code === 'LocalFlowUnsupported' && /empty delimiter/.test(error.message),
  );
});

test('join shares string conversion with Join actions and preserves exact numeric digits', () => {
  assert.equal(value("@join(createArray('red', 'blue'), '::')"), 'red::blue');
  assert.equal(value("@join(json('[]'), ',')"), '');
  assert.equal(value("@join(createArray('red'), ',')"), 'red');
  assert.equal(value("@join(createArray('red', 'blue'), '')"), 'redblue');
  assert.equal(
    value("@join(createArray(9007199254740993, true, null, json('[9007199254740993]')), '|')"),
    '9007199254740993|true||[9007199254740993]',
  );
  invalid("@join('red', ',')");
  invalid('@join(createArray(1), 2)');
});

test('join refuses an oversized result before allocating the combined string', () => {
  const input = { values: Array(1100).fill('x'), separator: 'x'.repeat(100000) };
  assert.throws(
    () => value("@join(triggerBody()?['values'], triggerBody()?['separator'])", input),
    /output exceeds 104857600 characters/,
  );
});

test('substring supports optional length and checks bounds instead of silently clamping', () => {
  assert.equal(value("@substring('local sample', 6)"), 'sample');
  assert.equal(value("@substring('local sample', 6, 3)"), 'sam');
  assert.equal(value("@substring('local sample', 0, 12)"), 'local sample');
  assert.equal(value("@substring('local sample', 12, 0)"), '');
  assert.equal(value("@substring('', 0)"), '');
  assert.equal(value("@substring('🙂x', 2, 1)"), 'x');
  for (const expression of [
    "@substring('abc', -1)",
    "@substring('abc', 4)",
    "@substring('abc', 1, 3)",
    "@substring('abc', 1, -1)",
    "@substring('abc', 0.5)",
    "@substring('abc', true)",
    "@substring('abc', '1')",
    "@substring('abc', 9007199254740993)",
    '@substring(null, 0)',
  ])
    invalid(expression);
});

test('first and last accept only strings or arrays and preserve valid endpoint values', async () => {
  for (const name of ['first', 'last']) {
    assert.equal(value(`@${name}(createArray(0))`), 0);
    assert.equal(value(`@${name}(createArray(false))`), false);
    assert.equal(value(`@${name}(json('[]'))`), null);
    assert.equal(value(`@${name}('')`), null);
    for (const literal of ['null', '1', 'true', 'json(\'{"0":"invented"}\')', '9007199254740993'])
      invalid(`@${name}(${literal})`);
  }
  assert.equal(value("@first('hello')"), 'h');
  assert.equal(value("@last('hello')"), 'o');
  assert.equal(value('@first(createArray(0, false))'), 0);
  assert.equal(value('@last(createArray(0, false))'), false);
  const answer = await executeFlowDefinition({
    definition: definition({
      Endpoint: { type: 'Compose', inputs: '@last(triggerBody())' },
      Failure: {
        type: 'Response',
        runAfter: { Endpoint: ['Failed'] },
        inputs: { statusCode: 422, body: "@outputs('Endpoint')?['error']?['code']" },
      },
    }),
    input: { 0: 'invented' },
  });
  assert.deepEqual(answer, { status: 422, body: 'LocalFlowExpression' });
});

test('skip and take preserve collection types, return new arrays and reject unsafe count coercions', () => {
  const input = { rows: [{ x_id: 1 }, { x_id: 2 }, { x_id: 3 }] },
    before = structuredClone(input);
  assert.deepEqual(value("@skip(triggerBody()?['rows'], 1)", input), input.rows.slice(1));
  assert.deepEqual(value("@take(triggerBody()?['rows'], 2)", input), input.rows.slice(0, 2));
  assert.notEqual(value("@take(triggerBody()?['rows'], 9)", input), input.rows);
  assert.deepEqual(value("@skip(triggerBody()?['rows'], 0)", input), input.rows);
  assert.deepEqual(value("@skip(triggerBody()?['rows'], 9)", input), []);
  assert.deepEqual(value("@take(triggerBody()?['rows'], 0)", input), []);
  assert.deepEqual(input, before);
  assert.equal(value("@take('sample', 3)"), 'sam');
  assert.equal(value("@take('sample', 9)"), 'sample');
  assert.equal(value("@take('sample', 0)"), '');
  for (const name of ['skip', 'take'])
    for (const count of ['-1', '0.5', 'true', "'1'", '9007199254740993']) invalid(`@${name}(createArray(1), ${count})`);
  invalid("@skip('sample', 1)");
  invalid('@take(null, 1)');
});

test('new transform functions reject missing and extra arguments', () => {
  for (const expression of [
    "@split('a')",
    "@split('a', 'b', 'c')",
    '@join(createArray(1))',
    "@join(createArray(1), ',', 'extra')",
    "@substring('a')",
    "@substring('a', 0, 1, 2)",
    '@skip(createArray(1))',
    '@skip(createArray(1), 1, 2)',
    '@take(createArray(1))',
    '@take(createArray(1), 1, 2)',
  ])
    assert.throws(() => value(expression), /Invalid argument count/);
});

test('imported Compose, Query and Select actions combine transforms without action mocks', async () => {
  const answer = await executeFlowDefinition({
    definition: definition({
      Tokens: { type: 'Compose', inputs: "@split(triggerBody()?['text'], '|')" },
      Window: { type: 'Compose', runAfter: { Tokens: ['Succeeded'] }, inputs: "@take(skip(outputs('Tokens'), 1), 2)" },
      Keep: {
        type: 'Query',
        runAfter: { Window: ['Succeeded'] },
        inputs: { from: "@outputs('Window')", where: "@startsWith(item(), 'keep:')" },
      },
      Names: {
        type: 'Select',
        runAfter: { Keep: ['Succeeded'] },
        inputs: { from: "@body('Keep')", select: '@substring(item(), 5)' },
      },
      Reply: { type: 'Response', runAfter: { Names: ['Succeeded'] }, inputs: { body: "@join(body('Names'), ',')" } },
    }),
    input: { text: 'ignore:first|keep:red|drop:blue|keep:green' },
  });
  assert.deepEqual(answer, { status: 200, body: 'red' });
});

test('substring bounds failure follows the imported flow failure branch', async () => {
  const answer = await executeFlowDefinition({
    definition: definition({
      Extract: { type: 'Compose', inputs: "@substring('short', 4, 2)" },
      Failed: {
        type: 'Response',
        runAfter: { Extract: ['Failed'] },
        inputs: { statusCode: 422, body: "@outputs('Extract')?['error']?['code']" },
      },
    }),
    input: {},
  });
  assert.deepEqual(answer, { status: 422, body: 'LocalFlowExpression' });
});

const GUID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const clockState = (startMs, ids = { uuid: () => GUID }) => ({
  ...state(),
  clock: fixedClock(Date.parse(startMs)),
  ids,
});

// @test-kind compatibility: Reference guide to functions in expressions for workflows in Azure Logic Apps and Power Automate, utcNow: the format defaults to "o" (yyyy-MM-ddTHH:mm:ss.fffffffZ) and the clock is the run clock.
test('utcNow reads the run clock and keeps seven fractional digits', () => {
  const clock = clockState('2026-01-02T03:04:05.006Z');
  assert.equal(resolveFlowValue('@utcNow()', clock), '2026-01-02T03:04:05.0060000Z');
  assert.equal(resolveFlowValue("@utcNow('yyyy-MM-dd')", clock), '2026-01-02');
});

// @test-kind compatibility: Reference guide to functions in expressions for workflows in Azure Logic Apps and Power Automate, formatDateTime: format and locale parameters, en-us default locale.
test('formatDateTime applies standard and custom .NET formats for en-us', () => {
  assert.equal(value("@formatDateTime('2026-01-02T03:04:05Z', 'yyyy-MM-dd')"), '2026-01-02');
  assert.equal(value("@formatDateTime('2026-01-02T03:04:05Z')"), '2026-01-02T03:04:05.0000000Z');
  assert.equal(value("@formatDateTime('2026-01-02T03:04:05Z', 'D', 'en-us')"), 'Friday, January 2, 2026');
  assert.equal(value("@formatDateTime('2026-01-02T15:04:05Z', 'h:mm tt')"), '3:04 PM');
  invalid("@formatDateTime('2026-01-02T03:04:05Z', 'Q')");
  assert.throws(
    () => value("@formatDateTime('2026-01-02T03:04:05Z', 'yyyy', 'de-de')"),
    (error) => error.status === 501 && error.code === 'LocalFlowUnsupported',
  );
});

// @test-kind compatibility: Reference guide to functions in expressions for workflows in Azure Logic Apps and Power Automate, addDays, addHours, addMinutes and addSeconds: (timestamp, interval, format) with the "o" default.
test('addDays and the sub-day adders keep the default format and cross month boundaries', () => {
  assert.equal(value("@addDays('2018-03-15T00:00:00Z', 10)"), '2018-03-25T00:00:00.0000000Z');
  assert.equal(value("@addDays('2026-02-27T00:00:00Z', 2)"), '2026-03-01T00:00:00.0000000Z');
  assert.equal(value("@addDays('2026-03-01T00:00:00Z', -1, 'yyyy-MM-dd')"), '2026-02-28');
  assert.equal(value("@addHours('2018-03-15T15:00:00Z', -5, 'yyyy-MM-dd HH:mm')"), '2018-03-15 10:00');
  assert.equal(value("@addSeconds('2018-03-15T00:00:30Z', -5)"), '2018-03-15T00:00:25.0000000Z');
  assert.equal(value("@addMinutes('2018-03-15T23:50:00Z', 15)"), '2018-03-16T00:05:00.0000000Z');
  assert.equal(value("@addDays('2018-03-15T00:00:00.0000001Z', 1)"), '2018-03-16T00:00:00.0000001Z');
  invalid("@addDays('2026-02-30T00:00:00Z', 1)");
  invalid("@addDays('2026-01-01T00:00:00Z', 1.5)");
});

// @test-kind compatibility: Reference guide to functions in expressions for workflows in Azure Logic Apps and Power Automate, addToTime and subtractFromTime: units Second, Minute, Hour, Day, Week, Month, Year; a month clamps to the last day.
test('addToTime clamps calendar months and years and subtractFromTime reverses it', () => {
  assert.equal(value("@addToTime('2018-01-01T00:00:00Z', 1, 'Day')"), '2018-01-02T00:00:00.0000000Z');
  assert.equal(value("@addToTime('2026-01-31T00:00:00Z', 1, 'Month')"), '2026-02-28T00:00:00.0000000Z');
  assert.equal(value("@addToTime('2024-02-29T00:00:00Z', 1, 'Year')"), '2025-02-28T00:00:00.0000000Z');
  assert.equal(value("@addToTime('2026-01-01T00:00:00Z', -1, 'month')"), '2025-12-01T00:00:00.0000000Z');
  assert.equal(value("@subtractFromTime('2018-01-01T00:00:00Z', 1, 'Week')"), '2017-12-25T00:00:00.0000000Z');
  assert.equal(value("@subtractFromTime('2018-01-01T01:00:00Z', 1, 'Hour', 'HH:mm')"), '00:00');
  invalid("@addToTime('2018-01-01T00:00:00Z', 1, 'Fortnight')");
});

// @test-kind compatibility: Reference guide to functions in expressions for workflows in Azure Logic Apps and Power Automate, startOfDay, startOfHour, startOfMonth, dayOfWeek, dayOfMonth and dayOfYear (dayOfWeek is 0 for Sunday).
test('start-of and day-part functions return the documented values', () => {
  assert.equal(value("@startOfDay('2018-03-15T13:30:30Z')"), '2018-03-15T00:00:00.0000000Z');
  assert.equal(value("@startOfHour('2018-03-15T13:30:30Z')"), '2018-03-15T13:00:00.0000000Z');
  assert.equal(value("@startOfMonth('2018-03-15T13:30:30Z', 'yyyy-MM-dd')"), '2018-03-01');
  assert.equal(value("@dayOfWeek('2026-01-04T00:00:00Z')"), 0);
  assert.equal(value("@dayOfWeek('2026-01-05T00:00:00Z')"), 1);
  assert.equal(value("@dayOfMonth('2026-01-04T00:00:00Z')"), 4);
  assert.equal(value("@dayOfYear('2026-02-01T00:00:00Z')"), 32);
  invalid("@dayOfWeek('10:30')");
});

// @test-kind compatibility: Reference guide to functions in expressions for workflows in Azure Logic Apps and Power Automate, guid: the default format is "D" and the formats N, D, B, P and X are accepted.
test('guid returns the id source value in the requested format', () => {
  const ids = { uuid: () => GUID };
  const at = (expression) => resolveFlowValue(expression, clockState('2026-01-02T00:00:00Z', ids));
  assert.equal(at('@guid()'), GUID);
  assert.equal(at("@guid('D')"), GUID);
  assert.equal(at("@guid('N')"), GUID.replaceAll('-', ''));
  assert.equal(at("@guid('B')"), '{' + GUID + '}');
  assert.equal(at("@guid('P')"), '(' + GUID + ')');
  assert.equal(at("@guid('X')"), '{0x6ba7b810,0x9dad,0x11d1,{0x80,0xb4,0x00,0xc0,0x4f,0xd4,0x30,0xc8}}');
  invalid("@guid('Q')");
});

// @test-kind contract: Paqvilo's designed runtime behaviour for flow expressions: argument counts and invalid values are expression errors.
test('the date functions reject invalid timestamps, units and argument counts', () => {
  invalid("@formatDateTime('not a date', 'yyyy')");
  invalid("@addDays('10:00', 1)");
  invalid("@startOfDay('')");
  assert.throws(() => value("@utcNow('a', 'b')"), /Invalid argument count/);
});

test('date results outside years 0001 to 9999 are expression errors, and the boundary dates are valid', () => {
  invalid("@addToTime('9999-12-31T00:00:00Z', 1, 'Month')");
  invalid("@subtractFromTime('0001-01-01T00:00:00Z', 1, 'Day')");
  invalid("@addToTime('2018-01-01T00:00:00Z', 9007199254740991, 'Month')");
  invalid("@addDays('9999-12-31T23:59:59.9999999Z', 1)");
  assert.equal(value("@addDays('9999-12-31T23:59:59.9999999Z', 0)"), '9999-12-31T23:59:59.9999999Z');
  assert.equal(value("@subtractFromTime('0001-01-01T00:00:00Z', 0, 'Day')"), '0001-01-01T00:00:00.0000000Z');
  assert.equal(value("@addToTime('9998-12-31T00:00:00Z', 1, 'Year')"), '9999-12-31T00:00:00.0000000Z');
  assert.equal(value("@subtractFromTime('0002-01-01T00:00:00Z', 1, 'Year')"), '0001-01-01T00:00:00.0000000Z');
});

// @test-kind contract: Paqvilo's designed runtime behaviour: a run reads the store clock and id source, so a fixed store is deterministic.
test('workflow date functions read the store clock and id source during a run', async () => {
  const store = await new DataStore({
    state: emptyState(),
    clock: fixedClock(Date.parse('2026-01-02T03:04:05.006Z')),
    ids: sequentialIds(),
  }).init();
  const answer = await executeFlowDefinition({
    definition: definition({
      Stamp: { type: 'Compose', inputs: '@utcNow()' },
      Reply: {
        type: 'Response',
        runAfter: { Stamp: ['Succeeded'] },
        inputs: { body: "@concat(outputs('Stamp'), ' ', guid('N'))" },
      },
    }),
    input: {},
    store,
  });
  assert.equal(answer.status, 200);
  assert.match(answer.body, /^2026-01-02T03:04:05\.0060000Z [0-9a-f]{32}$/);
});

// @test-kind tooling: Repository check that the operations document lists each expression function the interpreter registers.
test('operations.md lists every expression function in FLOW_EXPRESSION_ARITY', async () => {
  const document = (await readFile(new URL('../docs/operations.md', import.meta.url), 'utf8')).toLowerCase();
  const missing = Object.keys(FLOW_EXPRESSION_ARITY).filter((name) => !document.includes('`' + name + '`'));
  assert.deepEqual(missing, []);
});
