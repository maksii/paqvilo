import path from 'node:path';

function stopArgument(value, platform) {
  value = String(value);
  if (platform === 'win32') {
    if (/^[a-z0-9_./:\\-]+$/i.test(value)) return value;
    // Common quoted paths work in both CMD and PowerShell. Expansion, quote,
    // control and CRT trailing-backslash cases instead use shell-free argv.
    // eslint-disable-next-line no-control-regex -- Shell quoting rejects control characters deliberately.
    if (!value || /["$`%!\x00-\x1f\x7f]/.test(value) || value.endsWith('\\')) return null;
    return `"${value}"`;
  }
  // Literal POSIX quotes preserve controls, but a copied hint must stay one line.
  // eslint-disable-next-line no-control-regex -- Control arguments use encoded argv rather than literal shell text.
  if (/[\x00-\x1f\x7f]/.test(value)) return null;
  if (/^[a-z0-9_./:-]+$/i.test(value)) return value;
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

/** A copyable stop hint: CMD/PowerShell on Windows, POSIX shells elsewhere. */
export function mirageStopCommand(args, { cli, platform = process.platform }) {
  if (
    typeof cli !== 'string' ||
    !path.isAbsolute(cli) ||
    cli.includes('\0') ||
    args.some((value) => String(value).includes('\0'))
  )
    throw new Error('Stop command arguments require an absolute CLI path and cannot contain NUL bytes.');
  const arguments_ = ['mirage', 'stop', ...args.map(String)];
  const quoted = ['npx', 'paqvilo', ...arguments_].map((value) => stopArgument(value, platform));
  if (quoted.every((value) => value !== null)) return quoted.join(' ');
  // All supported shells receive only fixed ASCII code and a base64 payload.
  // Decode after shell parsing and invoke this installed toolkit without a shell.
  const payload = Buffer.from(JSON.stringify([cli, ...arguments_])).toString('base64');
  return `node -e "require('node:child_process').execFileSync(process.execPath,JSON.parse(Buffer.from('${payload}','base64').toString('utf8')),{stdio:'inherit'})"`;
}
