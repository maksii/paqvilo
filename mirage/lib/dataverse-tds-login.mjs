// MS-TDS login-phase buffer codecs for the Dataverse TDS simulator. Pure functions: no sockets, no store.
//
// decodeLogin7(buffer) -> {
//   tdsVersion, packetSize, clientProgVer, clientPid, connectionId, clientTimeZone, clientLcid,
//   optionFlags1, optionFlags2, typeFlags, optionFlags3, clientId (6 bytes),
//   hostName, userName, password (de-obfuscated), appName, serverName, libraryName, language, database,
//   fedAuth: null | { library, echo, token?, workflow?, nonce? }
// }
//   LOGIN7 is a 94-byte fixed header followed by UTF-16LE variable data at (offset, length) pairs. The
//   length field must equal the buffer length. FeatureExt is reached through the DWORD at ibExtension.
//   FEDAUTH library 0x01 (SecurityToken) carries a UTF-16LE access token; library 0x02 (ADAL/MSAL workflow)
//   carries a workflow byte instead. Out-of-range offsets throw RangeError.
//
// Token encoders (each returns a Buffer holding one complete token):
//   loginAck({ tdsVersion = 0x74000004, progName, version = '12.0.2000' })   LOGINACK 0xAD
//   envChange(type, newValue, oldValue = '')   ENVCHANGE 0xE3. Types: 1 database, 2 language, 3 charset,
//                                              4 packet size, 7 SQL collation (values are Buffers for 7)
//   featureExtAck([{ id, data? }])              FEATUREEXTACK 0xAE, terminated by 0xFF
//   fedAuthInfo({ stsUrl, spn })                FEDAUTHINFO 0xEE (library 0x02 only)
//   info({ number, state = 1, class = 0, message, serverName, procName, line })    INFO 0xAB
//   error({ number, state = 1, class = 16, message, serverName, procName, line })  ERROR 0xAA
//   done({ status = 0, curCmd = 0, rowCount = 0 })                                 DONE 0xFD
//
// Byte order: all fields are little-endian except LOGINACK TDSVersion, which is big-endian.
// Strings: B_VARCHAR (1-byte char count), US_VARCHAR (2-byte char count), UTF-16LE.
// Constants: TOKEN, DONE_STATUS, FEDAUTH_LIBRARY and ENV_TYPE are exported for callers.

export const TOKEN = Object.freeze({ ERROR: 0xaa, INFO: 0xab, LOGINACK: 0xad, FEATUREEXTACK: 0xae, ENVCHANGE: 0xe3, FEDAUTHINFO: 0xee, DONE: 0xfd });
export const DONE_STATUS = Object.freeze({ MORE: 0x01, ERROR: 0x02, INXACT: 0x04, COUNT: 0x10, ATTN: 0x20 });
export const FEDAUTH_LIBRARY = Object.freeze({ SECURITY_TOKEN: 0x01, ADAL: 0x02 });
export const ENV_TYPE = Object.freeze({ DATABASE: 1, LANGUAGE: 2, CHARSET: 3, PACKET_SIZE: 4, SQL_COLLATION: 7 });

const LOGIN7_FIXED_LENGTH = 94;
const FEATURE_EXT_FLAG = 0x10; // OptionFlags3 bit: FeatureExt present
const FEATURE_FEDAUTH = 0x02;
const FEATURE_TERMINATOR = 0xff;
const FEDAUTHINFO_STSURL = 0x01;
const FEDAUTHINFO_SPN = 0x02;
const NONCE_LENGTH = 32;

// Returns buf[offset, offset + length) or throws when the range leaves the buffer.
function slice(buf, offset, length, what) {
  if (!Number.isInteger(offset) || !Number.isInteger(length) || offset < 0 || length < 0 || offset + length > buf.length) {
    throw new RangeError(`TDS ${what} is outside its buffer`);
  }
  return buf.subarray(offset, offset + length);
}

// MS-TDS password obfuscation: swap nibbles, then XOR 0xA5. Decoding is the reverse: XOR, then swap.
function unobfuscate(bytes) {
  const out = Buffer.alloc(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    const x = bytes[i] ^ 0xa5;
    out[i] = ((x << 4) | (x >> 4)) & 0xff;
  }
  return out;
}

export function decodeLogin7(buffer) {
  const p = Buffer.from(buffer);
  if (p.length < LOGIN7_FIXED_LENGTH) throw new RangeError('TDS LOGIN7 is shorter than its fixed header');
  if (p.readUInt32LE(0) !== p.length) throw new RangeError('TDS LOGIN7 length field does not match the buffer');

  // (offset, length) pair at `at`, in characters, read as UTF-16LE.
  const text = (at, what) => slice(p, p.readUInt16LE(at), p.readUInt16LE(at + 2) * 2, what).toString('utf16le');

  const password = unobfuscate(slice(p, p.readUInt16LE(44), p.readUInt16LE(46) * 2, 'LOGIN7 password')).toString('utf16le');

  const features = {};
  const flags3 = p[27];
  if (flags3 & FEATURE_EXT_FLAG) {
    let at = slice(p, p.readUInt16LE(56), 4, 'LOGIN7 FeatureExt pointer').readUInt32LE(0);
    for (;;) {
      const id = slice(p, at, 1, 'LOGIN7 feature id')[0];
      if (id === FEATURE_TERMINATOR) break;
      const length = slice(p, at + 1, 4, 'LOGIN7 feature length').readUInt32LE(0);
      features[id] = slice(p, at + 5, length, 'LOGIN7 feature data');
      at += 5 + length;
    }
  }

  let fedAuth = null;
  if (features[FEATURE_FEDAUTH]) {
    const fed = features[FEATURE_FEDAUTH];
    const options = slice(fed, 0, 1, 'FEDAUTH options')[0];
    fedAuth = { library: options >> 1, echo: (options & 1) === 1 };
    let rest = 1;
    if (fedAuth.library === FEDAUTH_LIBRARY.SECURITY_TOKEN) {
      const tokenLength = slice(fed, 1, 4, 'FEDAUTH token length').readUInt32LE(0);
      fedAuth.token = slice(fed, 5, tokenLength, 'FEDAUTH token').toString('utf16le');
      rest = 5 + tokenLength;
    } else if (fedAuth.library === FEDAUTH_LIBRARY.ADAL) {
      fedAuth.workflow = slice(fed, 1, 1, 'FEDAUTH workflow')[0];
      rest = 2;
    }
    if (fed.length - rest === NONCE_LENGTH) fedAuth.nonce = fed.subarray(rest);
  }

  return {
    tdsVersion: p.readUInt32LE(4),
    packetSize: p.readUInt32LE(8),
    clientProgVer: p.readUInt32LE(12),
    clientPid: p.readUInt32LE(16),
    connectionId: p.readUInt32LE(20),
    optionFlags1: p[24],
    optionFlags2: p[25],
    typeFlags: p[26],
    optionFlags3: flags3,
    clientTimeZone: p.readInt32LE(28),
    clientLcid: p.readUInt32LE(32),
    hostName: text(36, 'LOGIN7 hostname'),
    userName: text(40, 'LOGIN7 username'),
    password,
    appName: text(48, 'LOGIN7 app name'),
    serverName: text(52, 'LOGIN7 server name'),
    libraryName: text(60, 'LOGIN7 client interface name'),
    language: text(64, 'LOGIN7 language'),
    database: text(68, 'LOGIN7 database'),
    clientId: Buffer.from(slice(p, 72, 6, 'LOGIN7 client id')),
    fedAuth,
  };
}

// Length-prefixed token: type, USHORT length (LE), body. Used by LOGINACK, ENVCHANGE, INFO and ERROR.
function withLength16(type, body) {
  if (body.length > 0xffff) throw new RangeError('TDS token body exceeds 65535 bytes');
  const head = Buffer.alloc(3);
  head[0] = type;
  head.writeUInt16LE(body.length, 1);
  return Buffer.concat([head, body]);
}

function bVarChar(value) {
  const chars = String(value);
  if (chars.length > 255) throw new RangeError('TDS B_VARCHAR longer than 255 characters');
  return Buffer.concat([Buffer.from([chars.length]), Buffer.from(chars, 'utf16le')]);
}

function usVarChar(value) {
  const chars = String(value);
  const head = Buffer.alloc(2);
  head.writeUInt16LE(chars.length);
  return Buffer.concat([head, Buffer.from(chars, 'utf16le')]);
}

export function loginAck({ tdsVersion = 0x74000004, progName = 'Microsoft SQL Server', version = '12.0.2000' } = {}) {
  const parts = String(version).split('.').map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0)) throw new RangeError(`TDS version "${version}" is not major.minor.build`);
  const [major, minor, build] = parts;
  if (major > 0xff || minor > 0xff || build > 0xffff) throw new RangeError(`TDS version "${version}" is out of range`);
  const tds = Buffer.alloc(4);
  tds.writeUInt32BE(tdsVersion);
  return withLength16(TOKEN.LOGINACK, Buffer.concat([
    Buffer.from([0x01]), // interface: SQL_TSQL
    tds,
    bVarChar(progName),
    Buffer.from([major, minor, build >> 8, build & 0xff]),
  ]));
}

export function envChange(type, newValue, oldValue = '') {
  // Collation values are byte strings (B_VARBYTE); the others are character strings (B_VARCHAR).
  const value = (v) => (Buffer.isBuffer(v) ? Buffer.concat([Buffer.from([v.length]), v]) : bVarChar(v));
  return withLength16(TOKEN.ENVCHANGE, Buffer.concat([Buffer.from([type]), value(newValue), value(oldValue)]));
}

// Features are acknowledged in order. An empty FEDAUTH ack is what a SecurityToken login needs.
export function featureExtAck(features = []) {
  const parts = [Buffer.from([TOKEN.FEATUREEXTACK])];
  for (const { id, data = Buffer.alloc(0) } of features) {
    const head = Buffer.alloc(5);
    head[0] = id;
    head.writeUInt32LE(data.length, 1);
    parts.push(head, data);
  }
  parts.push(Buffer.from([FEATURE_TERMINATOR]));
  return Buffer.concat(parts);
}

// InfoDataOffset counts from the CountOfInfoIDs field. The spike verified this against tedious 20.3.8.
export function fedAuthInfo({ stsUrl, spn }) {
  const items = [
    [FEDAUTHINFO_STSURL, Buffer.from(String(stsUrl), 'utf16le')],
    [FEDAUTHINFO_SPN, Buffer.from(String(spn), 'utf16le')],
  ];
  const head = Buffer.alloc(4 + items.length * 9);
  head.writeUInt32LE(items.length, 0);
  let offset = head.length;
  items.forEach(([id, data], i) => {
    const at = 4 + i * 9;
    head[at] = id;
    head.writeUInt32LE(data.length, at + 1);
    head.writeUInt32LE(offset, at + 5);
    offset += data.length;
  });
  const body = Buffer.concat([head, ...items.map(([, data]) => data)]);
  const token = Buffer.alloc(5);
  token[0] = TOKEN.FEDAUTHINFO;
  token.writeUInt32LE(body.length, 1);
  return Buffer.concat([token, body]);
}

function messageToken(type, { number, state = 1, class: severity = 0, message, serverName = '', procName = '', line = 0 }) {
  const head = Buffer.alloc(6);
  head.writeInt32LE(number, 0);
  head[4] = state;
  head[5] = severity;
  const lineNumber = Buffer.alloc(4);
  lineNumber.writeInt32LE(line, 0);
  return withLength16(type, Buffer.concat([head, usVarChar(message), bVarChar(serverName), bVarChar(procName), lineNumber]));
}

export function info(options) {
  return messageToken(TOKEN.INFO, options);
}

export function error(options) {
  return messageToken(TOKEN.ERROR, { class: 16, ...options });
}

// type selects DONE (0xFD, default), DONEPROC (0xFE) or DONEINPROC (0xFF); the layout is the same for all three.
export function done({ status = 0, curCmd = 0, rowCount = 0, type = TOKEN.DONE } = {}) {
  const token = Buffer.alloc(13);
  token[0] = type;
  token.writeUInt16LE(status, 1);
  token.writeUInt16LE(curCmd, 3);
  token.writeBigUInt64LE(BigInt(rowCount), 5);
  return token;
}
