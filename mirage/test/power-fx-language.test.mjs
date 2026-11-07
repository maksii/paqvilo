// Power Fx language conformance for the core engine (lib/power-fx.mjs, lib/power-fx-functions.mjs): grammar, operators,
// coercion, error values, date/time zone semantics on a fixed clock, and at least one case per function of the table (the
// documented example where the function's page gives one). The fixed clock is the documented DateAdd/DateDiff example instant,
// July 15, 2013 1:02 PM in Pacific Daylight Time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { LAZY, functionNames, parse, powerFxEngine } from '../lib/power-fx.mjs';

const NOW = Date.UTC(2013, 6, 15, 20, 2);
const hostOf = (extra = {}) => ({
  now: () => NOW,
  timeZone: 'America/Los_Angeles',
  variables: {},
  context: {},
  ...extra,
});
const run = (formula, host = hostOf(), values = {}) => powerFxEngine.evaluateSync(formula, { host, values }).value;

// [formula, expected]: documented examples are marked by the page they come from.
const CASES = [
  // Grammar and operators ("Operators and Identifiers", "Expression grammar")
  ['1 + 2 * 3', 7],
  ['-2^2', -4],
  ['2^3^2', 64],
  ['20%', 0.2],
  ['"a" & 1 & true', 'a1true'],
  ['0.1 + 0.2', 0.3],
  ['"The ""quoted"" text"', 'The "quoted" text'],
  ['$"Sum: {1 + 2} {{x}}"', 'Sum: 3 {x}'],
  ['/* c */ 1 // x', 1],
  ["With({'a b': 2}, 'a b' * 3)", 6],
  ['Not(false) And !false', true],
  ['true Or false && false', true],
  ['"The" in "The keyboard"', true],
  ['"the" exactin "The keyboard"', false],
  ['2 in [1, 2, 3]', true],
  ['{a: 1}.a', 1],
  ['[1, 2].Value', [{ Value: 1 }, { Value: 2 }]],
  ['Blank() = Blank()', true],
  ['Blank() + 1', 1],
  // Logical ("If and Switch", "And, Or, and Not")
  ['If(1 > 2, "a", "b")', 'b'],
  ['If(false, 1, false, 2, 3)', 3],
  ['Switch(2, 1, "one", 2, "two", "other")', 'two'],
  ['And(true, 1 = 1)', true],
  ['Or(false, false)', false],
  ['Not(true)', false],
  // Errors ("Error, IfError, IsError, IsBlankOrError")
  ['IfError(1, 2)', 1],
  ['IfError(1/0, 2)', 2],
  ['IfError(10, 20, 30)', 30],
  ['IfError(10, 11, 20, 21, 300)', 300],
  ['IsError(1/0)', true],
  ['IsError(Blank())', false],
  ['IsBlankOrError(Blank())', true],
  ['IfError(1/0, FirstError.Kind)', 13],
  ['IfError(1/0, CountRows(AllErrors))', 1],
  ['With({a: 1, b: 0}, IfError(a/b, If(FirstError.Kind <> ErrorKind.Div0, Error(FirstError), -1)))', -1],
  ['IfError(Error({Kind: ErrorKind.Validation, Message: "bad"}), FirstError.Message)', 'bad'],
  ['IfError(Error("custom"), FirstError.Kind)', 1000],
  ['IsError(Mid("abc", 0, 1))', true],
  // Blank ("Blank, Coalesce, IsBlank, and IsEmpty")
  ['IsBlank(Blank())', true],
  ['IsBlank("")', true],
  ['Coalesce(Blank(), "", "a")', 'a'],
  ['IsEmpty(Filter([1, 2], Value > 5))', true],
  // Numbers ("Abs, Exp, Ln, Power, Sqrt", "Round", "Mod", "Value", "Aggregates", "Sequence")
  ['Abs(-1) + Exp(0) + Ln(1) + Sqrt(4) + Power(2, 3)', 12],
  ['IsError(Sqrt(-1))', true],
  ['Round(1.005, 2)', 1.01],
  ['Round(-2.5, 0)', -3],
  ['RoundUp(2.1, 0)', 3],
  ['RoundDown(-2.9, 0)', -2],
  ['Int(-2.5)', -3],
  ['Trunc(-2.5)', -2],
  ['Mod(-3, 2)', 1],
  ['IsError(Mod(1, 0))', true],
  ['Value("10%")', 0.1],
  ['Value("$ 12.34")', 12.34],
  ['Value("1,234.5")', 1234.5],
  ['IfError(Value("abc"), -1)', -1],
  ['Decimal("1.5") + Float("2")', 3.5],
  ['Boolean("TRUE")', true],
  ['Sum([1, 2, 3], Value)', 6],
  ['Sum(1, 2, 3)', 6],
  ['Average(1, 2, 3, Blank())', 2],
  ['IsError(Average(Blank()))', true],
  ['Max(1, 5, 3)', 5],
  ['Min([4, 2, 8], Value * 2)', 4],
  ['Concat(Sequence(4, 0, 5), Value, ",")', '0,5,10,15'],
  // Decimal is exact, Float is a double ("Create formula columns with decimal, whole number, float, and choice data types")
  ['0.1 + 0.2 = 0.3', true],
  ['Sum(0.1, 0.2, 0.3) = 0.6', true],
  ['Value("0.1") + Value("0.2") = 0.3', true],
  ['Text(9007199254740992 + 1)', '9007199254740993'],
  ['Text(1/3)', '0.3333333333333333333333333333'],
  // Numeric overflow is an error value IfError handles; invalid date text is an error, not a roll-over;
  // a failed ForAll element makes ForAll an error value
  ['IfError(1e300 * 1e300, 0)', 0],
  ['IfError(Value("1e400"), -1)', -1],
  ['IfError(1e400, 2)', 2],
  ['IsError(DateValue("2023-02-30"))', true],
  ['IsError(DateValue("13/01/2024"))', true],
  ['IsError(TimeValue("25:00"))', true],
  ['IsError(ForAll([1, 0], 1/Value))', true],
  ['IfError(ForAll([1, 0], 1/Value), FirstError.Kind)', 13],
  ['Float(0.1) + Float(0.2) = 0.3', false],
  ['Text(Mod(10.5, 3))', '1.5'],
  ['Round(1.23456789012345678901234567, 25) > 1.234567890123', true],
  // Text ("Text", "Left, Mid, Right", "Len", "Lower, Upper, Proper", "Trim", "Replace and Substitute", "Find", "Split", "Char")
  ['Text(1234.5678, "#,##0.00")', '1,234.57'],
  ['Text(0.123, "0.0%")', '12.3%'],
  ['Text(123, "#")', '123'],
  ['Text(5, "00")', '05'],
  ['Concatenate(Text(123, "#"), "ab")', '123ab'],
  ['Concat(Concatenate(["a", "b"], "!"), Value)', 'a!b!'],
  ['Left("Hello", 2) & Mid("Hello", 2, 3) & Right("Hello", 2)', 'Heelllo'],
  ['Len("Hello")', 5],
  ['Trim("  a   b  ")', 'a b'],
  ['TrimEnds("  a   b  ")', 'a   b'],
  ['Upper("ab") & Lower("CD") & Proper("hello world")', 'ABcdHello World'],
  ['Substitute("Sales Cost", "Cost", "Price")', 'Sales Price'],
  ['Substitute("Quarter 1, 2018", "1", "2", 1)', 'Quarter 2, 2018'],
  ['Replace("abcdef", 2, 3, "X")', 'aXef'],
  ['Find("b", "abcb", 3)', 4],
  ['IsBlank(Find("z", "abc"))', true],
  ['Concat(Split("a,b,c", ","), Value, "-")', 'a-b-c'],
  ['Char(65)', 'A'],
  ['StartsWith("Hello", "he") && EndsWith("Hello", "LO")', true],
  // Regular expressions ("IsMatch, Match, and MatchAll")
  ['IsMatch("joan@contoso.com", Match.Email)', true],
  ['IsMatch("986", "\\d+")', true],
  ['IsMatch("111-111-111", "\\d{3}-\\d{2}-\\d{4}", MatchOptions.Complete)', false],
  ['IsMatch("123", Match.MultipleDigits & Match.Period & Match.OptionalDigits, MatchOptions.Complete)', false],
  ['Match("Bob Jones <bob.jones@contoso.com>", "<(?<email>" & Match.Email & ")>").email', 'bob.jones@contoso.com'],
  ['Match("Bob Jones <bob.jones@contoso.com>", "<(?<email>" & Match.Email & ")>").StartMatch', 11],
  ['Match("The quick brown fox jumps over the lazy dog.", "THE", MatchOptions.IgnoreCase).StartMatch', 1],
  ['CountRows(MatchAll("The quick brown fox jumps over the lazy dog.", "the", MatchOptions.IgnoreCase))', 2],
  ['IsError(IsMatch("a", "("))', true],
  // Tables ("Filter, LookUp", "Sort, SortByColumns", "First, Last, Index", "CountRows, CountIf", "Distinct", "AddColumns...",
  // "ForAll", "Table", "With")
  ['CountRows(Filter([1, 2, 3, 4], Value > 2))', 2],
  ['LookUp([{a: 1, b: "x"}, {a: 2, b: "y"}], a = 2).b', 'y'],
  ['LookUp([{a: 1, b: "x"}], a = 1, b & "!")', 'x!'],
  ['Concat(Sort([3, 1, 2], Value, SortOrder.Descending), Value)', '321'],
  ['Concat(SortByColumns([{n: "b"}, {n: "a"}], "n"), n)', 'ab'],
  ['Concat(SortByColumns([{n: "a"}, {n: "b"}], n, SortOrder.Descending), n)', 'ba'],
  ['Concat(SortByColumns([{n: "a"}, {n: "b"}, {n: "c"}], n, ["c", "a", "b"]), n)', 'cab'],
  ['First([1,2]).Value + Last([1,2]).Value + Index([5,6,7], 2).Value', 9],
  ['CountRows(FirstN([1,2,3], 2)) + CountRows(LastN([1,2,3], 1))', 3],
  ['CountIf([1, 2, 3], Value >= 2)', 2],
  ['Concat(Distinct([1, 1, 2], Value), Value)', '12'],
  ['First(AddColumns([{a: 1}], b, a * 2)).b', 2],
  ['JSON(DropColumns([{a: 1, b: 2}], a))', '[{"b":2}]'],
  ['JSON(ShowColumns([{a: 1, b: 2}], a))', '[{"a":1}]'],
  ['JSON(RenameColumns([{a: 1}], a, z))', '[{"z":1}]'],
  ['Concat(ForAll(Sequence(3), Value * 2), Value, ",")', '2,4,6'],
  ['CountRows(ForAll([1, 2], If(Value = 1, Blank(), Value)))', 1],
  [
    'Concat(ForAll(Sequence(2) As Rank, Concat(ForAll(Sequence(2) As File, If(Mod(Rank.Value + File.Value, 2) = 1, "X", ".")), Value) & "|"), Value)',
    '.X|X.|',
  ],
  ['With({x: 2}, x * ThisRecord.x)', 4],
  ['CountRows(Table({a: 1}, {a: 2}))', 2],
  ['Concat(Filter([{v: 1}, {v: 2}] As R, R.v > 1), v)', '2'],
  ['Sum(Filter([{v: 1}, {v: 5}], v > 1), v)', 5],
  // JSON ("JSON", "ParseJSON")
  ['JSON({a: 1, b: [1, 2]}, JSONFormat.FlattenValueTables)', '{"a":1,"b":[1,2]}'],
  ['JSON(Date(2019, 3, 31))', '"2019-03-31"'],
  ['Value(ParseJSON("{""a"": {""b"": 5}}").a.b) + 1', 6],
  ['Text(Index(ParseJSON("[""x"",""y""]"), 2))', 'y'],
  ['CountRows(Table(ParseJSON("[1,2,3]")))', 3],
  ['IsError(ParseJSON("{"))', true],
  ['Boolean(ParseJSON("true"))', true],
  // GUID and host values ("GUID", "Language")
  ['GUID("77777777-7777-4777-8777-777777777777") = GUID("{77777777777747778777777777777777}")', true],
  ['Len(Text(GUID()))', 36],
  ['Language()', 'en-US'],
  // Dates and time zones ("DateAdd, DateDiff, TimeZoneOffset", "Now, Today, IsToday, UTCNow...", "Date and Time", "Weekday", "WeekNum")
  ['Text(DateAdd(Now(), 3), "dd-mm-yyyy hh:mm")', '18-07-2013 13:02'],
  ['Text(DateAdd(Now(), 4, TimeUnit.Hours), "dd-mm-yyyy hh:mm")', '15-07-2013 17:02'],
  ['Text(DateAdd(Today(), 1, TimeUnit.Months), "dd-mm-yyyy hh:mm")', '15-08-2013 00:00'],
  ['Text(DateAdd(Now(), -30, TimeUnit.Minutes), "dd-mm-yyyy hh:mm")', '15-07-2013 12:32'],
  ['DateDiff(Now(), DateValue("1/1/2014"))', 170],
  ['DateDiff(Now(), DateValue("1/1/2014"), TimeUnit.Months)', 6],
  ['DateDiff(Now(), Today(), TimeUnit.Minutes)', -782],
  ['DateDiff(TimeValue("09:45:00"), TimeValue("10:15:36"), TimeUnit.Hours)', 1],
  ['DateDiff(TimeValue("09:45:00"), TimeValue("10:15:36"), TimeUnit.Minutes)/60', 0.5],
  ['Round(DateDiff(TimeValue("09:45:00"), TimeValue("10:15:36"), TimeUnit.Seconds)/3600, 2)', 0.51],
  ['DateDiff(Date(2024, 1, 1), Date(2025, 1, 1), TimeUnit.Quarters)', 4],
  ['TimeZoneOffset()', 420],
  ['Text(DateAdd(Now(), TimeZoneOffset(), TimeUnit.Minutes), "dd-mm-yyyy hh:mm")', '15-07-2013 20:02'],
  ['Hour(UTCNow())', 20],
  ['Hour(Now())', 13],
  ['Minute(Now()) + Second(Now())', 2],
  ['Day(UTCToday())', 15],
  ['Month(Today())', 7],
  ['IsToday(Now()) && !IsToday(DateAdd(Now(), 12))', true],
  ['IsUTCToday(UTCNow())', true],
  ['Text(Now(), "mm/dd/yyyy hh:mm:ss")', '07/15/2013 13:02:00'],
  ['Year(Date(2024, 2, 30)) * 100 + Month(Date(2024, 2, 30))', 202403],
  ['Weekday(Date(2024, 1, 1))', 2],
  ['Weekday(Date(2024, 1, 1), StartOfWeek.Monday)', 1],
  ['ISOWeekNum(Date(2021, 1, 1))', 53],
  ['WeekNum(Date(2021, 1, 3))', 2],
  ['Text(DateTimeValue("2024-01-02T03:04:05Z"), DateTimeFormat.UTC)', '2024-01-02T03:04:05.000Z'],
  ['Hour(DateTimeValue("2024-01-02T03:04:05Z"))', 19],
  ['Text(Date(2024, 3, 5), "mmmm d, yyyy")', 'March 5, 2024'],
  ['Text(Time(14, 5, 0), "h:mm AM/PM")', '2:05 PM'],
  ['Text(Date(2024, 3, 5), DateTimeFormat.LongDate)', 'Tuesday, March 5, 2024'],
  // Behaviour ("Set", "Collect, Clear, ClearCollect", "Patch", "Remove and RemoveIf", "UpdateContext", "Defaults")
  ['Set(x, 5); x * 2', 10],
  ['Collect(c, {a: 1}); Collect(c, {a: 2}); CountRows(c)', 2],
  ['ClearCollect(c, {a: 9}); First(c).a', 9],
  ['Collect(c, {a: 1}); Clear(c); CountRows(c)', 0],
  ['Patch({a: 1, b: 2}, {b: 3}).b', 3],
  ['Collect(c, {a: 1}); Patch(c, First(c), {a: 5}); First(c).a', 5],
  ['Collect(c, {a: 1}, {a: 2}); Remove(c, {a: 1}); Concat(c, a)', '2'],
  ['Collect(c, [1, 2, 3]); RemoveIf(c, Value > 1); CountRows(c)', 1],
  ['Collect(c, {a: 1}, {a: 2}); UpdateIf(c, a > 1, {a: a + 3}); Sum(c, a)', 6],
  ['UpdateContext({n: 4}); n + 1', 5],
  ['JSON(Defaults([1]))', '{}'],
  ['Trace("invented")', true],
  ['RandBetween(2,2)', 2],
  ['EncodeUrl("a b")', 'a%20b'],
  ['RGBA(255,0,128,0.5)', 'rgba(255, 0, 128, 0.502)'],
  ['ColorValue("Red")', 'rgba(255, 0, 0, 1)'],
  ['ColorFade(RGBA(100,150,200,1),0.5)', 'rgba(177, 202, 227, 1)'],
  ['CountRows(Search([{Name:"Alpha"},{Name:"Beta"}],"PH",Name))', 1],
  ['DataSourceInfo([], DataSourceInfo.Required, Name)', false],
  ['IsError(Choices([{x:1}].x))', true],
  ['IsError(Errors([1]))', true],
];

for (const [formula, expected] of CASES) {
  test(`Power Fx ${formula}`, () => assert.deepEqual(run(formula), expected));
}

test('every function of the table has a conformance case', () => {
  const covered = new Set(CASES.flatMap(([formula]) => [...formula.matchAll(/([A-Za-z]+)\(/g)].map((m) => m[1])));
  const hostCovered = ['Navigate', 'Back', 'Notify', 'User', 'Rand'];
  const missing = functionNames().filter((name) => !covered.has(name) && !hostCovered.includes(name));
  assert.deepEqual(missing, []);
});

test('host callbacks: Navigate, Back, Notify and User reach the host; without one they are NotSupported errors', () => {
  const calls = [];
  const host = hostOf({
    navigate: (...args) => calls.push(['navigate', ...args]),
    back: () => calls.push(['back']),
    notify: (...args) => calls.push(['notify', ...args]),
    user: { FullName: 'Invented User' },
  });
  assert.equal(
    run('Navigate(Screen2, "Fade", {a: 1}); Back(); Notify("Saved", NotificationType.Success, 2000)', host, {
      Screen2: { Name: 'Screen2' },
    }),
    true,
  );
  assert.deepEqual(calls, [
    ['navigate', { Name: 'Screen2' }, 'Fade', { a: 1 }],
    ['back'],
    ['notify', 'Saved', 'Success', 2000],
  ]);
  assert.equal(run('User().FullName', host), 'Invented User');
  assert.equal(run('IfError(Notify("x"), FirstError.Kind)', { now: () => NOW }), 20);
});

test('errors: a top-level error value throws 400 PowerFxError with its Learn ErrorKind; unknown names and functions are refused', () => {
  assert.throws(
    () => run('1/0'),
    (error) => error.status === 400 && error.code === 'PowerFxError' && error.details.kind === 'Div0',
  );
  assert.throws(
    () => run('Error({Kind: ErrorKind.Validation, Message: "Invented"})'),
    (error) => error.message === 'Invented' && error.details.errorKind === 11,
  );
  assert.throws(() => run('x_unknown + 1'), { code: 'PowerFxNameUnknown' });
  assert.throws(() => run('x_Unknown(1)'), { code: 'PowerFxFunctionUnsupported' });
  assert.throws(() => run('Left("a")'), { code: 'PowerFxFunctionUnsupported' });
  assert.throws(() => parse('1 +'), { code: 'PowerFxSyntaxError' });
  assert.throws(() => run('ErrorKind.Invented'), { code: 'PowerFxNameUnknown' });
});

test('scopes: ThisRecord, As, [@global] and Table[@field] disambiguation', () => {
  const values = { a: 10, T: [{ a: 1 }, { a: 2 }] };
  assert.equal(run('Sum(Filter(T, a > 1), a)', hostOf(), values), 2);
  assert.equal(
    run('Sum(Filter(T, ThisRecord.a + [@a] > 11), a)', hostOf(), values),
    2,
    '[@a] reads the global past the record scope',
  );
  assert.equal(
    run('Concat(ForAll(T As Outer, Concat(Filter(T, a = Outer.a), Text(a))), Value)', hostOf(), values),
    '12',
  );
  assert.equal(run('Sum(Filter(T, T[@a] = 2), a)', hostOf(), values), 2);
});

test('the implicit ThisRecord (host.scope) and Set on its columns', () => {
  const scope = { x_name: 'invented', x_quantity: 2 };
  assert.equal(run('x_quantity * 2 & ThisRecord.x_name', hostOf({ scope })), '4invented');
  run('Set(x_name, Upper(x_name)); Set(ThisRecord.x_quantity, 3)', hostOf({ scope }));
  assert.deepEqual(scope, { x_name: 'INVENTED', x_quantity: 3 });
});

test('a LAZY host record is not read until a formula selects a property', () => {
  const reads = [];
  const control = {
    [LAZY]: true,
    get Text() {
      reads.push('Text');
      return 'typed';
    },
    get Visible() {
      reads.push('Visible');
      return true;
    },
  };
  assert.equal(run('TextInput1.Text', hostOf(), { TextInput1: control }), 'typed');
  assert.deepEqual(reads, ['Text']);
});

test('date/time + 1 and DateAdd(…, 1, Days) agree across a daylight-saving change', () => {
  const amsterdam = hostOf({ timeZone: 'Europe/Amsterdam' });
  assert.equal(
    run('Text(DateTimeValue("2023-03-25T12:00:00") + 1, "yyyy-mm-dd hh:mm")', amsterdam),
    '2023-03-26 12:00',
  );
  assert.equal(
    run('Text(DateAdd(DateTimeValue("2023-03-25T12:00:00"), 1, TimeUnit.Days), "yyyy-mm-dd hh:mm")', amsterdam),
    '2023-03-26 12:00',
  );
});

test('Value, Decimal and Float read text in the language tag, else the host language (Learn "Decimal, Float, and Value functions")', () => {
  // The documented example rows (user language en-US).
  for (const [formula, expected] of [
    ['Value("123.456")', 123.456],
    ['Value("123.456", "es-ES")', 123456],
    ['Value("123,456")', 123456],
    ['Value("123,456", "es-ES")', 123.456],
    ['Decimal("123,456", "es-ES")', 123.456],
    ['Decimal("123.456", "es-ES")', 123456],
    ['Float("123,456", "es-ES")', 123.456],
    ['Value("12.34%")', 0.1234],
    ['Value("$ 12.34")', 12.34],
    ['Value("24e3")', 24000],
    ['Value(true)', 1],
    ['Float("1e100")', 1e100],
    ['IsError(Decimal("1e100"))', true],
    ['IsError(Value("1.5", "es-ES"))', true],
    ['Value("1 234,5", "fr-FR")', 1234.5],
  ]) {
    assert.deepEqual(run(formula), expected, formula);
  }
  // Without a tag the host language decides: de-DE reads "1.234,5" as 1234.5.
  assert.equal(run('Value("1.234,5")', hostOf({ language: 'de-DE' })), 1234.5);
  assert.equal(run('Value("1,500", "en-US")', hostOf({ language: 'de-DE' })), 1500);
  assert.equal(run('IfError(Value("1", "x-invalid-@"), FirstError.Kind)'), 25);
  // The language's group widths (en-IN 12,34,567), a currency symbol at either end, the exact Decimal bound.
  assert.equal(run('Value("12,34,567.5", "en-IN")'), 1234567.5);
  assert.equal(run('IfError(Value("1,23"), FirstError.Kind)'), 25);
  assert.equal(run('Value("1.234 €", "de-DE")'), 1234);
  assert.equal(run('Value("1’234.5", "de-CH")'), 1234.5);
  assert.equal(String(run('Decimal("79228162514264337593543950335")')?.value), '79228162514264337593543950335');
  assert.equal(run('IfError(Decimal("79228162514264337593543950336"), FirstError.Kind)'), 24);
  assert.equal(run('IfError(Decimal("-79228162514264337593543950336"), FirstError.Kind)'), 24);
});

test('date/time: local parts follow host.timeZone, time zone independent values read in UTC, DST is honoured', () => {
  const tokyo = hostOf({ timeZone: 'Asia/Tokyo' });
  assert.equal(run('Hour(Now())', tokyo), 5);
  assert.equal(run('Day(Today())', tokyo), 16);
  assert.equal(run('Hour(UTCNow())', tokyo), 20);
  // Across the US spring-forward change a day added keeps the wall time (local arithmetic).
  const march = hostOf({ now: () => Date.UTC(2024, 2, 9, 18, 0) });
  assert.equal(run('Text(DateAdd(Now(), 1), "yyyy-mm-dd hh:mm")', march), '2024-03-10 10:00');
  assert.equal(run('DateDiff(Now(), DateAdd(Now(), 1), TimeUnit.Hours)', march), 23);
});

test('checkSync parses and names unsupported functions', () => {
  assert.deepEqual(powerFxEngine.checkSync('Sum(1, 2)'), { ok: true, diagnostics: [] });
  assert.equal(powerFxEngine.checkSync('Sum(1,').diagnostics[0].code, 'POWERFX_SYNTAX');
  assert.equal(
    powerFxEngine.checkSync('Office365Users.MyProfile()').diagnostics[0].function,
    'Office365Users.MyProfile',
  );
});
