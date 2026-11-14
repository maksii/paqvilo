/**
 * Attributes a timer call to the code that made it. Call it from inside a test's recording replacement of a timer
 * function, with `recorder` set to that test file's `import.meta.url`. The caller is the frame right below the
 * replacement, past the test runner's mock wrapper. Returns true when the text of that frame contains `origin`, a
 * module or directory URL of the code under test.
 *
 * A test records only what this returns true for: other code in the process, such as the fetch connection of an earlier
 * test, also calls the global timer functions, and its timers are not the call's.
 */
export function calledFrom(origin, recorder) {
  const limit = Error.stackTraceLimit;
  let frames;
  try {
    Error.stackTraceLimit = 50;
    frames = new Error().stack.split('\n').slice(2);
  } finally {
    Error.stackTraceLimit = limit;
  }
  const replacement = frames.findIndex((frame) => frame.includes(recorder));
  const caller = frames.slice(replacement + 1).find((frame) => !frame.includes('node:internal/test_runner/'));
  return replacement >= 0 && (caller?.includes(origin) ?? false);
}
