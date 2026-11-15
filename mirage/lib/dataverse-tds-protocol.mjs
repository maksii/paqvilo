// Dataverse TDS server over node:net: the MS-TDS connection sequence for TDS 7.x (PRELOGIN-wrapped TLS) and TDS 8.0
// (strict, TLS first). Login and queries are delegated to the caller. Protocol only: no SQL or store knowledge.
//
// createTdsServer({ secureContext, serverName, version, onLogin, onQuery, packetSize, preloginIdleMs, fedAuthIdleMs })
//   -> { listen(port, host), close() }
//   secureContext  tls.SecureContext, or a function returning one at each handshake. Wrapped (TDS 7.x) TLS needs
//                  maxVersion 'TLSv1.2' on it (see framing.mjs).
//   serverName     LOGINACK program name (default 'Microsoft SQL Server'). version: PRELOGIN/LOGINACK version (default '12.0.2000').
//   onLogin({ token, fedAuth, login }) -> { ok: true, principal } | { ok: false, error?: { number, message, state, class } }
//                                     | { fedAuthInfo: { stsUrl, spn } }
//                                     fedAuthInfo (library 0x02) sends FEDAUTHINFO; onLogin runs again once the client's
//                                     FEDAUTH token arrives, with fedAuth.token set.
//   onQuery({ sql, params, principal, signal }) -> { resultSets: [{ columns, rows }], rowCount? }
//                                     params: { '@name': value } from sp_executesql. signal aborts on ATTENTION.
//                                     A thrown { number, message, state, class } (or Error) becomes ERROR + DONE(ERROR).
//   listen(port, host) resolves with the server address. close() destroys open connections and the listener.
import net from 'node:net';
import {
  DEFAULT_PACKET_SIZE,
  MAX_MESSAGE_BYTES,
  TDS,
  acceptTls,
  createMessageReader,
  decodePrelogin,
  detectTdsMode,
  encodePrelogin,
  writeMessage,
} from './dataverse-tds-framing.mjs';
import { ENV_TYPE, decodeLogin7, envChange, featureExtAck, fedAuthInfo, loginAck } from './dataverse-tds-login.mjs';
import {
  TdsProtocolError,
  attentionAck,
  decodeRpc,
  decodeSqlBatch,
  doneInProc,
  doneProc,
  doneToken,
  errorToken,
  returnStatus,
  rpcToQuery,
} from './dataverse-tds-messages.mjs';
import { columnMetadata, row } from './dataverse-tds-types.mjs';

const ATTENTION = 0x06;
const FEDAUTH_TOKEN = 0x08;
const FEDAUTH_FEATURE = 0x02;
const HEADER_BYTES = 8;
const ENCRYPT_OFF = 0x00;
const ENCRYPT_ON = 0x01;
const ENCRYPT_REQ = 0x03;
const CUR_CMD_SELECT = 0xc1;
const INTERNAL_ERROR = 50000;
// A message sent before login completes (PRELOGIN, LOGIN7, FEDAUTH token) larger than this closes the connection. A
// connection silent before login is closed after preloginIdleMs (PRELOGIN_IDLE_MS by default). While the server waits for
// the client's FEDAUTH token, the limit is fedAuthIdleMs (FEDAUTH_IDLE_MS by default): the hang guard for the client's
// interactive token acquisition, which can take minutes. Once login succeeds the timeout is cleared, so an authenticated
// session has no idle limit.
const PRELOGIN_MAX_BYTES = 64 * 1024;
const PRELOGIN_IDLE_MS = 30_000;
const FEDAUTH_IDLE_MS = 15 * 60_000;
const LOGIN_FAILED = { number: 18456, state: 1, class: 14, message: 'Login failed.' };
const COLLATION = Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34]); // Latin1_General_CI_AS
const EMPTY = Buffer.alloc(0);
const contextOf = (context) => (typeof context === 'function' ? context() : context);

// An idle limit is a positive finite number of milliseconds: 0 would switch the limit off, and Node refuses the others.
function requireIdleLimit(name, value) {
  if (!Number.isFinite(value) || value <= 0)
    throw new RangeError(`createTdsServer ${name} must be a positive finite number`);
}

export function createTdsServer({
  secureContext,
  strictSecureContext = secureContext, // TDS 8 (strict) may use TLS 1.3, so the caller can pass a context without the 1.2 cap.
  serverName = 'Microsoft SQL Server',
  version = '12.0.2000',
  onLogin,
  onQuery,
  packetSize = DEFAULT_PACKET_SIZE,
  preloginIdleMs = PRELOGIN_IDLE_MS,
  fedAuthIdleMs = FEDAUTH_IDLE_MS,
} = {}) {
  requireIdleLimit('preloginIdleMs', preloginIdleMs);
  requireIdleLimit('fedAuthIdleMs', fedAuthIdleMs);
  if (!secureContext || typeof onLogin !== 'function' || typeof onQuery !== 'function') {
    throw new TypeError('createTdsServer needs secureContext, onLogin and onQuery');
  }
  const versionField = versionBytes(version);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
    socket.setTimeout(preloginIdleMs, () => socket.destroy());
    accept(socket).catch(() => socket.destroy());
  });

  async function accept(socket) {
    const inbox = rawInbox(socket);
    const first = await inbox.bytes(1);
    const mode = detectTdsMode(first);
    if (mode === 'tds8')
      return session(
        acceptTls(socket, { secureContext: contextOf(strictSecureContext), initial: inbox.detach(), strict: true }),
        true,
        socket,
      );
    if (mode !== 'tds7') throw new Error('connection does not start with PRELOGIN or TLS');
    const request = await inbox.message();
    if (request.type !== TDS.PRELOGIN) throw new Error(`expected PRELOGIN, got 0x${request.type.toString(16)}`);
    const fields = decodePrelogin(request.payload);
    const encryption = fields.encryption?.[0] === ENCRYPT_OFF ? ENCRYPT_REQ : ENCRYPT_ON;
    writeMessage(socket, TDS.TABULAR, preloginReply(fields, encryption), packetSize);
    return session(
      acceptTls(socket, { secureContext: contextOf(secureContext), initial: inbox.detach() }),
      false,
      socket,
    );
  }

  function preloginReply(fields, encryption) {
    return encodePrelogin({
      version: versionField,
      encryption,
      instOpt: 0,
      threadId: EMPTY,
      mars: 0,
      ...(fields.fedAuthRequired ? { fedAuthRequired: 1 } : {}),
    });
  }

  // One TLS-wrapped (or strict) connection. Messages are handled in order; ATTENTION is answered at once.
  // transport is the TCP socket under the TLS stream: its idle timeout is fedAuthIdleMs while the client's token is
  // awaited, preloginIdleMs again after a rejected login, and cleared at a successful login.
  function session(stream, strict, transport) {
    stream.on('error', () => stream.destroy());
    const conn = {
      loggedIn: false,
      principal: undefined,
      pendingLogin: null,
      rejected: false,
      running: /** @type {AbortController | null} */ (null),
      queue: Promise.resolve(),
    };
    const reply = (...tokens) => {
      if (!stream.destroyed) writeMessage(stream, TDS.TABULAR, Buffer.concat(tokens), packetSize);
    };
    const read = createMessageReader(
      (type, payload) => {
        if (type === ATTENTION) {
          // Every client message gets exactly one response. A cancelled request still owes its response (DONE ATTN),
          // which comes before the ATTENTION's own acknowledgement; the cancelled query then sends nothing more.
          if (conn.running) {
            conn.running.abort();
            conn.running = null;
            reply(doneToken({ attn: true }));
          }
          return reply(attentionAck());
        }
        conn.queue = conn.queue.then(() => handle(type, payload)).catch(() => stream.destroy());
      },
      { maxBytes: () => (conn.loggedIn ? MAX_MESSAGE_BYTES : PRELOGIN_MAX_BYTES) },
    );
    stream.on('data', (chunk) => {
      try {
        read(chunk);
      } catch {
        stream.destroy();
      }
    });

    async function handle(type, payload) {
      if (type === TDS.PRELOGIN && strict) return reply(preloginReply(decodePrelogin(payload), ENCRYPT_OFF));
      if (type === TDS.LOGIN7) return login(payload);
      if (type === FEDAUTH_TOKEN) return fedAuthToken(payload);
      if (!conn.loggedIn) throw new Error(`TDS message 0x${type.toString(16)} before LOGIN7`);
      if (type === TDS.SQL_BATCH || type === TDS.RPC) {
        let request;
        try {
          request =
            type === TDS.SQL_BATCH ? { sql: decodeSqlBatch(payload).sql, params: {} } : rpcToQuery(decodeRpc(payload));
        } catch (err) {
          if (!(err instanceof TdsProtocolError)) throw err;
          return reply(errorToken({ number: INTERNAL_ERROR, message: err.message }), doneToken({ error: true }));
        }
        return query(request, type === TDS.RPC);
      }
      return reply(
        errorToken({ number: INTERNAL_ERROR, message: `unsupported TDS message type 0x${type.toString(16)}` }),
        doneToken({ error: true }),
      );
    }

    async function login(payload) {
      if (conn.rejected || conn.loggedIn || conn.pendingLogin) throw new Error('unexpected LOGIN7');
      const request = decodeLogin7(payload);
      const fedAuth = request.fedAuth;
      const decision = await onLogin({ token: fedAuth?.token, fedAuth, login: request });
      return decide(decision, request, fedAuth);
    }

    async function fedAuthToken(payload) {
      const pending = conn.pendingLogin;
      if (!pending) throw new Error('unexpected FEDAUTH token');
      conn.pendingLogin = null;
      let token;
      try {
        token = fedAuthTokenText(payload);
      } catch (error) {
        if (!(error instanceof TdsProtocolError)) throw error;
        transport.setTimeout(preloginIdleMs);
        return reply(errorToken({ number: INTERNAL_ERROR, message: error.message }), doneToken({ error: true }));
      }
      const fedAuth = { ...pending.fedAuth, token };
      const decision = await onLogin({ token, fedAuth, login: pending.request });
      if (decision?.fedAuthInfo) throw new Error('FEDAUTHINFO requested twice');
      return decide(decision, pending.request, fedAuth);
    }

    function decide(decision, request, fedAuth) {
      if (decision?.fedAuthInfo) {
        conn.pendingLogin = { request, fedAuth };
        transport.setTimeout(fedAuthIdleMs);
        return reply(fedAuthInfo(decision.fedAuthInfo));
      }
      if (!decision?.ok) return reject(decision?.error);
      conn.loggedIn = true;
      conn.principal = decision.principal;
      transport.setTimeout(0);
      return reply(
        envChange(ENV_TYPE.DATABASE, request.database || 'master', 'master'),
        envChange(ENV_TYPE.SQL_COLLATION, COLLATION, EMPTY),
        envChange(ENV_TYPE.LANGUAGE, 'us_english'),
        envChange(ENV_TYPE.PACKET_SIZE, String(packetSize), String(packetSize)),
        loginAck({ progName: serverName, version }),
        ...(fedAuth ? [featureExtAck([{ id: FEDAUTH_FEATURE }])] : []),
        doneToken(),
      );
    }

    function reject(error) {
      conn.rejected = true;
      transport.setTimeout(preloginIdleMs);
      reply(errorToken({ ...LOGIN_FAILED, ...error }), doneToken({ error: true }));
      stream.end();
    }

    async function query({ sql, params }, rpc) {
      const controller = new AbortController();
      conn.running = controller;
      try {
        const result = await onQuery({ sql, params, principal: conn.principal, signal: controller.signal });
        if (controller.signal.aborted) return undefined;
        return reply(...resultTokens(result, rpc));
      } catch (err) {
        if (controller.signal.aborted) return undefined;
        return reply(sqlError(err), doneToken({ error: true }));
      } finally {
        if (conn.running === controller) conn.running = null;
      }
    }
  }

  return {
    listen(port = 0, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve(server.address());
        });
      });
    },
    close() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

// Tokens for one request: each result set is COLMETADATA, ROWs and a DONE (DONEINPROC inside RPC) with MORE on every
// set but the last; RPC ends with RETURNSTATUS and DONEPROC.
function resultTokens(result, rpc) {
  const sets = result?.resultSets ?? [];
  const endOfSet = rpc ? doneInProc : doneToken;
  const tokens = [];
  if (sets.length === 0) tokens.push(endOfSet({ more: rpc, rowCount: result?.rowCount }));
  sets.forEach((set, i) => {
    tokens.push(
      columnMetadata(set.columns),
      ...set.rows.map((values) => row(set.columns, values)),
      endOfSet({ more: rpc || i < sets.length - 1, rowCount: set.rows.length, curCmd: CUR_CMD_SELECT }),
    );
  });
  if (rpc) tokens.push(returnStatus(0), doneProc());
  return tokens;
}

// FEDAUTH_TOKEN: DWORD DataLen, DWORD TokenLen, then the UTF-16LE token. Each length is checked against the payload.
function fedAuthTokenText(payload) {
  if (payload.length < 8) {
    throw new TdsProtocolError(`FEDAUTH token message is ${payload.length} bytes, shorter than its header`);
  }
  const length = payload.readUInt32LE(4);
  if (length % 2) throw new TdsProtocolError(`FEDAUTH token of ${length} bytes is not UTF-16LE`);
  if (payload.length < 8 + length) throw new TdsProtocolError('FEDAUTH token is truncated');
  return payload.subarray(8, 8 + length).toString('utf16le');
}

function sqlError(err) {
  const { number = INTERNAL_ERROR, message = 'internal error', state = 1, class: severity = 16 } = err ?? {};
  return errorToken({ number, message: String(message), state, class: severity });
}

function versionBytes(version) {
  const [major, minor, build, ...extra] = String(version).split('.').map(Number);
  if (
    extra.length ||
    [major, minor, build].some((n) => !Number.isInteger(n) || n < 0) ||
    major > 0xff ||
    minor > 0xff ||
    build > 0xffff
  ) {
    throw new RangeError(`TDS version "${version}" is not major.minor.build`);
  }
  return Buffer.from([major, minor, build >> 8, build & 0xff, 0, 0]);
}

// Raw bytes from the socket until the caller takes them: bytes(count) peeks, message() waits for a whole message
// and detach() returns the unread bytes, so the TLS adapter can start from them. It is called synchronously with
// the handoff, so no socket data is lost in between.
function rawInbox(socket) {
  const assembler = createMessageAssembler({ maxBytes: PRELOGIN_MAX_BYTES });
  let arrivals = 0;
  let wake = null;
  let closed = false;
  const notify = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const onData = (chunk) => {
    assembler.push(chunk);
    arrivals += 1;
    notify();
  };
  const onClose = () => {
    closed = true;
    notify();
  };
  socket.on('data', onData);
  socket.on('end', onClose);
  socket.on('close', onClose);
  const until = async (ready) => {
    for (;;) {
      if (ready()) return;
      if (closed) throw new Error('connection closed before the TDS message completed');
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  };
  return {
    async bytes(count) {
      await until(() => assembler.available >= count);
      return assembler.peek(count);
    },
    async message() {
      for (;;) {
        const found = assembler.next();
        if (found) return found;
        const seen = arrivals;
        await until(() => arrivals !== seen);
      }
    },
    detach() {
      socket.off('data', onData);
      socket.off('end', onClose);
      socket.off('close', onClose);
      return assembler.unread();
    },
  };
}

const packetLength = (buffer, at) => buffer.readUInt16BE(at + 2);

// Reassembles TDS messages from raw chunks. A packet's header is read once, when the packet starts (readLength
// gives its length), and its bytes are copied only once the whole packet has arrived. Nothing is rescanned.
export function createMessageAssembler({ maxBytes = MAX_MESSAGE_BYTES, readLength = packetLength } = {}) {
  const chunks = [];
  let cursor = 0; // index of the chunk holding the first unread byte
  let available = 0;
  let packetSize = null; // length of the packet being collected, once its header is read
  let parts = [];
  let size = 0;
  let type;

  const peek = (count) => {
    const out = Buffer.allocUnsafe(count);
    let filled = 0;
    let i = cursor;
    while (filled < count) {
      const taken = Math.min(chunks[i].length, count - filled);
      chunks[i].copy(out, filled, 0, taken);
      filled += taken;
      i += 1;
    }
    return out;
  };

  const drop = (count) => {
    let left = count;
    while (left > 0) {
      const chunk = chunks[cursor];
      if (chunk.length <= left) {
        left -= chunk.length;
        cursor += 1;
      } else {
        chunks[cursor] = chunk.subarray(left);
        left = 0;
      }
    }
    available -= count;
    chunks.splice(0, cursor);
    cursor = 0;
  };

  // Adds one whole packet to the message in progress; returns the message when its last packet arrives.
  const addPacket = (packet) => {
    if (type !== undefined && packet[0] !== type) throw new Error('TDS message packets mix message types');
    type = packet[0];
    size += packet.length;
    if (size > maxBytes) throw new Error(`TDS message exceeds ${maxBytes} bytes`);
    parts.push(packet.subarray(HEADER_BYTES));
    if ((packet[1] & 0x01) === 0) return null;
    const message = { type, payload: parts.length === 1 ? parts[0] : Buffer.concat(parts) };
    parts = [];
    size = 0;
    type = undefined;
    return message;
  };

  const take = (count) => {
    const out = peek(count);
    drop(count);
    return out;
  };

  // The next complete message, or null while its packets are still missing.
  const next = () => {
    for (;;) {
      if (packetSize === null) {
        if (available < HEADER_BYTES) return null;
        packetSize = readLength(peek(HEADER_BYTES), 0);
        if (packetSize < HEADER_BYTES) throw new Error(`TDS packet length ${packetSize} is below the header size`);
      }
      if (available < packetSize) return null;
      const message = addPacket(take(packetSize));
      packetSize = null;
      if (message) return message;
    }
  };

  return {
    push(chunk) {
      chunks.push(chunk);
      available += chunk.length;
    },
    next,
    peek,
    get available() {
      return available;
    },
    unread: () => Buffer.concat(chunks.slice(cursor)),
  };
}
