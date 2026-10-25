import path from 'node:path';
import { createHash } from 'node:crypto';
import { deflateRawSync } from 'node:zlib';
import { MAX_COMMAND_PAYLOAD_BYTES } from './command-payload.mjs';

// CMD accepts at most 8191 characters. Leave room for its invocation prefix;
// use the same bound for portable hints copied between supported shells.
const MAX_HINT_CHARACTERS = 8000;
const executeBatch = (cwd) => {
  const options =
    cwd === undefined
      ? "{stdio:'inherit'}"
      : `{stdio:'inherit',cwd:Buffer.from('${Buffer.from(cwd).toString('base64')}','base64').toString('utf8')}`;
  return `let failed=false;for(const args of commands)try{require('node:child_process').execFileSync(process.execPath,args,${options})}catch{failed=true}if(failed)process.exitCode=1`;
};
const encodedCommand = (code) => `node -e "${code}"`;

export function listenerPort(value) {
  try {
    const url = new URL(value);
    return ['http:', 'https:'].includes(url.protocol)
      ? url.port || (url.protocol === 'https:' ? '443' : '80')
      : undefined;
  } catch {
    return undefined;
  }
}

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

/** Copyable CLI hints, with an exact argv batch when a group needs distinct selectors. */
export function mirageCommandHint(commands, { cli, platform = process.platform, storePayload, cwd } = {}) {
  if (
    typeof cli !== 'string' ||
    !path.isAbsolute(cli) ||
    cli.includes('\0') ||
    commands.some((args) => args.some((value) => String(value).includes('\0')))
  )
    throw new Error('Command arguments require an absolute CLI path and cannot contain NUL bytes.');
  if (cwd !== undefined && (typeof cwd !== 'string' || !path.isAbsolute(cwd) || cwd.includes('\0')))
    throw new Error('Command working directory must be an absolute path without NUL bytes.');
  if (!commands.length) return null;
  if (commands.length === 1 && cwd === undefined) {
    const quoted = ['npx', 'paqvilo', ...commands[0].map(String)].map((value) => stopArgument(value, platform));
    if (quoted.every((value) => value !== null)) {
      const readable = quoted.join(' ');
      if (readable.length <= MAX_HINT_CHARACTERS) return readable;
    }
  }
  const data = Buffer.from(JSON.stringify(commands.map((args) => [cli, ...args.map(String)])));
  if (data.length > MAX_COMMAND_PAYLOAD_BYTES) throw new Error('Command payload exceeds its byte limit.');
  // Fixed ASCII code and base64 survive all supported shells, including CMD
  // delayed expansion. There are no expansion characters in the generated code.
  const compressed = deflateRawSync(data).toString('base64');
  const inline = encodedCommand(
    `const commands=JSON.parse(require('node:zlib').inflateRawSync(Buffer.from('${compressed}','base64'),{maxOutputLength:${MAX_COMMAND_PAYLOAD_BYTES}}).toString('utf8'));${executeBatch(cwd)}`,
  );
  if (inline.length <= MAX_HINT_CHARACTERS) return inline;
  if (typeof storePayload !== 'function')
    throw new Error('Command exceeds the copyable shell limit; configure owned command payload storage.');
  const file = storePayload(data);
  if (typeof file !== 'string' || !path.isAbsolute(file) || file.includes('\0'))
    throw new Error('Command payload storage must return an absolute filename without NUL bytes.');
  const encodedFile = Buffer.from(file).toString('base64'),
    hash = createHash('sha256').update(data).digest('hex');
  // Read at most the admitted byte limit plus one, and verify immutable argv
  // before invoking any child. Replacing or corrupting a payload cannot change
  // which toolkit or arguments a previously printed command will execute.
  const external = encodedCommand(
    `const fs=require('node:fs'),fd=fs.openSync(Buffer.from('${encodedFile}','base64').toString('utf8'),'r');let data;try{data=Buffer.alloc(${MAX_COMMAND_PAYLOAD_BYTES + 1});let size=0,n;while(size<data.length&&(n=fs.readSync(fd,data,size,data.length-size,null))>0)size+=n;if(size>${MAX_COMMAND_PAYLOAD_BYTES})throw Error('Command payload exceeds its byte limit.');data=data.subarray(0,size)}finally{fs.closeSync(fd)}if(require('node:crypto').createHash('sha256').update(data).digest('hex')==='${hash}'){}else throw Error('Command payload changed.');const commands=JSON.parse(data.toString('utf8'));${executeBatch(cwd)}`,
  );
  if (external.length > MAX_HINT_CHARACTERS)
    throw new Error('Command payload filename exceeds the copyable shell limit.');
  return external;
}

/** A copyable stop hint: CMD/PowerShell on Windows, POSIX shells elsewhere. */
export function mirageStopCommand(args, options) {
  return mirageCommandHint([['mirage', 'stop', ...args]], options);
}
