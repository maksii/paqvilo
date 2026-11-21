/**
 * Contributor scripts answer --help or -h with their usage (exit 0) and refuse an unknown option in one line, both
 * before any work. `options` names the flags the script accepts; it parses their values itself.
 */
export function answerHelp(args, { name, usage, options = [], exitCode = 1 }) {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(usage.trim());
    process.exit(0);
  }
  const unknown = args.find((arg) => arg.startsWith('-') && !options.includes(arg.split('=')[0]));
  if (unknown === undefined) return;
  console.error(`${name}: unknown option ${unknown} (see --help).`);
  process.exit(exitCode);
}
