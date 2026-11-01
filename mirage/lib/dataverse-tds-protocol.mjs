// Dataverse TDS server over node:net: the MS-TDS connection sequence for TDS 7.x (PRELOGIN-wrapped TLS) and TDS 8.0
// (strict, TLS first). Login and queries are delegated to the caller. Protocol only: no SQL or store knowledge.
//
// createTdsServer({ secureContext, serverName, version, onLogin, onQuery, packetSize }) -> { listen(port, host), close() }
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
const LOGIN_FAILED = { number: 18456, state: 1, class: 14, message: 'Login failed.' };
const COLLATION = Buffer.from([0x09, 0x04, 0xd0, 0x00, 0x34]); // Latin1_General_CI_AS
const EMPTY = Buffer.alloc(0);
const contextOf = (context) => (typeof context === 'function' ? context() : context);

export function createTdsServer({
  secureContext,
  strictSecureContext = secureContext, // TDS 8 (strict) may use TLS 1.3, so the caller can pass a context without the 1.2 cap.
  serverName = 'Microsoft SQL Server',
  version = '12.0.2000',
  onLogin,
  onQuery,
  packetSize = DEFAULT_PACKET_SIZE,
} = {}) {
  if (!secureContext || typeof onLogin !== 'function' || typeof onQuery !== 'function') {
    throw new TypeError('createTdsServer needs secureContext, onLogin and onQuery');
  }
  const versionField = versionBytes(version);
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => socket.destroy());
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
      );
    if (mode !== 'tds7') throw new Error('connection does not start with PRELOGIN or TLS');
    const request = await inbox.message();
    if (request.type !== TDS.PRELOGIN) throw new Error(`expected PRELOGIN, got 0x${request.type.toString(16)}`);
    const fields = decodePrelogin(request.payload);
    const encryption = fields.encryption?.[0] === ENCRYPT_OFF ? ENCRYPT_REQ : ENCRYPT_ON;
    writeMessage(socket, TDS.TABULAR, preloginReply(fields, encryption), packetSize);
    return session(acceptTls(socket, { secureContext: contextOf(secureContext), initial: inbox.detach() }), false);
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
  function session(stream, strict) {
    stream.on('error', () => stream.destroy());
    const conn = { loggedIn: false, principal: undefined, pendingLogin: null, running: null, queue: Promise.resolve() };
    const reply = (...tokens) => {
      if (!stream.destroyed) writeMessage(stream, TDS.TABULAR, Buffer.concat(tokens), packetSize);
    };
    const read = createMessageReader((type, payload) => {
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
    });
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
      if (conn.loggedIn || conn.pendingLogin) throw new Error('unexpected LOGIN7');
      const request = decodeLogin7(payload);
      const fedAuth = request.fedAuth;
      const decision = await onLogin({ token: fedAuth?.token, fedAuth, login: request });
      return decide(decision, request, fedAuth);
    }

    async function fedAuthToken(payload) {
      const pending = conn.pendingLogin;
      if (!pending) throw new Error('unexpected FEDAUTH token');
      conn.pendingLogin = null;
      // FEDAUTH_TOKEN: DWORD DataLen, DWORD TokenLen, then the UTF-16LE token.
      const length = payload.readUInt32LE(4);
      if (payload.length < 8 + length) throw new Error('FEDAUTH token is truncated');
      const token = payload.subarray(8, 8 + length).toString('utf16le');
      const fedAuth = { ...pending.fedAuth, token };
      const decision = await onLogin({ token, fedAuth, login: pending.request });
      if (decision?.fedAuthInfo) throw new Error('FEDAUTHINFO requested twice');
      return decide(decision, pending.request, fedAuth);
    }

    function decide(decision, request, fedAuth) {
      if (decision?.fedAuthInfo) {
        conn.pendingLogin = { request, fedAuth };
        return reply(fedAuthInfo(decision.fedAuthInfo));
      }
      if (!decision?.ok) return reject(decision?.error);
      conn.loggedIn = true;
      conn.principal = decision.principal;
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
      reply(errorToken({ ...LOGIN_FAILED, ...(error ?? {}) }), doneToken({ error: true }));
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
    tokens.push(columnMetadata(set.columns), ...set.rows.map((values) => row(set.columns, values)));
    tokens.push(endOfSet({ more: rpc || i < sets.length - 1, rowCount: set.rows.length, curCmd: CUR_CMD_SELECT }));
  });
  if (rpc) tokens.push(returnStatus(0), doneProc());
  return tokens;
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

// Buffers raw bytes until the caller takes them. detach() returns the unread bytes, so the TLS adapter can start from them.
// It is called synchronously with the handoff, so no socket data is lost in between.
function rawInbox(socket) {
  let buffer = EMPTY;
  let wake = null;
  let closed = false;
  const notify = () => {
    const resume = wake;
    wake = null;
    resume?.();
  };
  const onData = (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
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
      const found = ready(buffer);
      if (found) return found;
      if (closed) throw new Error('connection closed before the TDS message completed');
      await new Promise((resolve) => {
        wake = resolve;
      });
    }
  };
  return {
    async bytes(count) {
      await until((b) => (b.length >= count ? b : null));
      return buffer;
    },
    async message() {
      const found = await until(takeMessage);
      buffer = found.rest;
      return found;
    },
    detach() {
      socket.off('data', onData);
      socket.off('end', onClose);
      socket.off('close', onClose);
      const rest = buffer;
      buffer = EMPTY;
      return rest;
    },
  };
}

// The first complete TDS message in raw bytes, as { type, payload, rest }; null while packets are still missing.
function takeMessage(buffer) {
  const parts = [];
  let type;
  let at = 0;
  for (;;) {
    if (buffer.length - at < HEADER_BYTES) return null;
    const length = buffer.readUInt16BE(at + 2);
    if (length < HEADER_BYTES) throw new Error(`TDS packet length ${length} is below the header size`);
    if (buffer.length - at < length) return null;
    if (type === undefined) type = buffer[at];
    else if (buffer[at] !== type) throw new Error('TDS message packets mix message types');
    parts.push(buffer.subarray(at + HEADER_BYTES, at + length));
    const endOfMessage = (buffer[at + 1] & 0x01) !== 0;
    at += length;
    if (at > MAX_MESSAGE_BYTES) throw new Error(`TDS message exceeds ${MAX_MESSAGE_BYTES} bytes`);
    if (endOfMessage)
      return { type, payload: parts.length === 1 ? parts[0] : Buffer.concat(parts), rest: buffer.subarray(at) };
  }
}
