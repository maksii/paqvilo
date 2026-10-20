// Dataverse TDS client request messages (MS-TDS 2.2.6) and the server tokens a reply needs. Works on whole message payloads;
// packet framing and TLS are the protocol layer's job. RPC parameter values go through decodeTypedValue (dataverse-tds-types.mjs).
// API:
//   decodeSqlBatch(payload) -> { headers, sql }                     SQL_BATCH (0x01): ALL_HEADERS, then UTF-16LE text
//   decodeRpc(payload) -> { headers, procId?, procName?, options, params: [{ name, byRef, value }] }   RPC (0x03)
//   rpcToQuery(rpc) -> { sql, params: { '@p1': value } }            sp_executesql (ProcID 10) only; others throw
//   doneToken / doneProc / doneInProc({ more, error, attn, rowCount, curCmd }) -> 13-byte Buffer (0xFD / 0xFE / 0xFF)
//   returnStatus(value = 0) -> Buffer (RETURNSTATUS 0x79)
//   errorToken({ number, message, state, class, server, procName, line }) -> Buffer (ERROR 0xAA; alias of login's error())
//   readOnlyError() -> ERROR + DONE(ERROR) for a write statement; READ_ONLY_ERROR holds the number and text
//   attentionAck() -> DONE with DONE_ATTN, the reply a client ATTENTION (0x06) requires
// DONE, ERROR and DONE status bits are encoded by dataverse-tds-login.mjs and shared here.
// Malformed or truncated input throws TdsProtocolError; nothing is read past the payload.
import { decodeTypedValue } from "./dataverse-tds-types.mjs";
import { DONE_STATUS, done, error } from "./dataverse-tds-login.mjs";

export class TdsProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "TdsProtocolError";
  }
}

const TOKEN = { DONEPROC: 0xfe, DONEINPROC: 0xff, RETURNSTATUS: 0x79 };
const HEADER_TRANSACTION_DESCRIPTOR = 0x0002;
const PROC_ID_SWITCH = 0xffff;
const SP_EXECUTESQL = 10;

// Error number and text for a write statement; the spike report gives no number, so these are the PoC's values.
export const READ_ONLY_ERROR = { number: 40000, message: "The request is read-only." };

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.offset = 0;
  }
  need(n) {
    if (n < 0 || this.offset + n > this.buf.length) throw new TdsProtocolError(`message truncated at byte ${this.offset}`);
  }
  take(n) {
    this.need(n);
    const out = this.buf.subarray(this.offset, this.offset + n);
    this.offset += n;
    return out;
  }
  u8() {
    return this.take(1)[0];
  }
  u16() {
    return this.take(2).readUInt16LE(0);
  }
  u32() {
    return this.take(4).readUInt32LE(0);
  }
  u64() {
    return this.take(8).readBigUInt64LE(0);
  }
  // B_VARCHAR: a one-byte character count, then UTF-16LE characters.
  bVarchar() {
    return this.take(this.u8() * 2).toString("utf16le");
  }
}

// ALL_HEADERS: a DWORD total length (including itself), then headers of DWORD length, USHORT type and data.
function readAllHeaders(r) {
  const total = r.u32();
  if (total < 4) throw new TdsProtocolError(`ALL_HEADERS length ${total} is too short`);
  r.need(total - 4);
  const end = r.offset + total - 4;
  const headers = {};
  while (r.offset < end) {
    const start = r.offset;
    const length = r.u32();
    if (length < 6 || start + length > end) throw new TdsProtocolError("ALL_HEADERS entry exceeds its block");
    if (r.u16() === HEADER_TRANSACTION_DESCRIPTOR && length === 18) {
      headers.transaction = { descriptor: r.u64(), outstandingRequests: r.u32() };
    }
    r.offset = start + length;
  }
  return headers;
}

export function decodeSqlBatch(payload) {
  const r = new Reader(payload);
  const headers = readAllHeaders(r);
  const text = payload.subarray(r.offset);
  if (text.length % 2) throw new TdsProtocolError("SQL_BATCH text is not UTF-16LE");
  return { headers, sql: text.toString("utf16le") };
}

export function decodeRpc(payload) {
  const r = new Reader(payload);
  const headers = readAllHeaders(r);
  const nameLength = r.u16();
  let procId;
  let procName;
  if (nameLength === PROC_ID_SWITCH) procId = r.u16();
  else procName = r.take(nameLength * 2).toString("utf16le");
  const flags = r.u16();
  const params = [];
  while (r.offset < payload.length) {
    const name = r.bVarchar();
    const status = r.u8();
    const typed = decodeTypedValue(payload, r.offset);
    r.offset = typed.next;
    params.push({ name, byRef: (status & 0x01) !== 0, value: typed.value });
  }
  return {
    headers,
    procId,
    procName,
    options: { recompile: (flags & 0x01) !== 0, noMetaData: (flags & 0x02) !== 0, reuseMetaData: (flags & 0x04) !== 0 },
    params,
  };
}

// ponytail: only sp_executesql is mapped. sp_prepare/sp_prepexec/sp_execute need handle state and RETURNVALUE;
// add them when a client sends prepared statements.
export function rpcToQuery(rpc) {
  const name = rpc.procName?.toLowerCase();
  if (rpc.procId !== SP_EXECUTESQL && name !== "sp_executesql") {
    throw new TdsProtocolError(`RPC ${rpc.procName ?? rpc.procId} is not supported`);
  }
  // sp_executesql(@stmt, @params declaration, value...): the declaration is redundant because each value carries its type.
  const [stmt, , ...values] = rpc.params;
  if (typeof stmt?.value !== "string") throw new TdsProtocolError("sp_executesql needs an NVARCHAR statement");
  const params = {};
  values.forEach((p, k) => {
    const key = p.name ? (p.name.startsWith("@") ? p.name : `@${p.name}`) : `@p${k + 1}`;
    params[key] = p.value;
  });
  return { sql: stmt.value, params };
}

// Boolean flags become DONE status bits; rowCount undefined means no DONE_COUNT bit. type undefined is DONE (0xFD).
export function doneToken({ more = false, error: failed = false, attn = false, rowCount, curCmd = 0 } = {}) {
  let status = 0;
  if (more) status |= DONE_STATUS.MORE;
  if (failed) status |= DONE_STATUS.ERROR;
  if (attn) status |= DONE_STATUS.ATTN;
  if (rowCount !== undefined) status |= DONE_STATUS.COUNT;
  return done({ status, curCmd, rowCount: rowCount ?? 0 });
}
export const doneProc = (opts) => withType(doneToken(opts), TOKEN.DONEPROC);
export const doneInProc = (opts) => withType(doneToken(opts), TOKEN.DONEINPROC);

function withType(token, type) {
  token[0] = type;
  return token;
}

export function returnStatus(value = 0) {
  const b = Buffer.alloc(5);
  b[0] = TOKEN.RETURNSTATUS;
  b.writeInt32LE(value, 1);
  return b;
}

export const errorToken = ({ server = "", ...rest }) => error({ ...rest, serverName: server });

export function readOnlyError() {
  return Buffer.concat([errorToken(READ_ONLY_ERROR), doneToken({ error: true })]);
}

export const attentionAck = () => doneToken({ attn: true });
