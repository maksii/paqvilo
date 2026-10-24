import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DONE_STATUS,
  ENV_TYPE,
  FEDAUTH_LIBRARY,
  decodeLogin7,
  done,
  envChange,
  error,
  featureExtAck,
  fedAuthInfo,
  info,
  loginAck,
} from "../lib/dataverse-tds-login.mjs";

const utf16 = (s) => Buffer.from(s, "utf16le");
const bytes = (...values) => Buffer.from(values);

// MS-TDS password obfuscation (test copy): swap nibbles, then XOR 0xA5.
const obfuscate = (buf) => Buffer.from([...buf].map((x) => (((x << 4) | (x >> 4)) & 0xff) ^ 0xa5));

// Builds a LOGIN7 from the MS-TDS 2.2.6.4 layout. The fixed header is 94 bytes; variable data follows and is
// addressed by (offset, character count) pairs. The FeatureExt block is reached through the DWORD at ibExtension.
// Test-only: decodeLogin7 must read these offsets back.
function encodeLogin7(o = {}) {
  const fixed = Buffer.alloc(94);
  const parts = [];
  let at = 94;
  const put = (buf) => {
    const offset = at;
    parts.push(buf);
    at += buf.length;
    return offset;
  };
  const str = (ibAt, buf) => {
    fixed.writeUInt16LE(put(buf), ibAt);
    fixed.writeUInt16LE(buf.length / 2, ibAt + 2);
  };

  fixed.writeUInt32LE(o.tdsVersion ?? 0x74000004, 4);
  fixed.writeUInt32LE(o.packetSize ?? 4096, 8);
  fixed.writeUInt32LE(o.clientLcid ?? 0x0409, 32);
  (o.clientId ?? Buffer.alloc(6)).copy(fixed, 72);

  str(36, utf16(o.hostName ?? "HOST"));
  str(40, utf16(o.userName ?? ""));
  str(44, o.obfuscatedPassword ?? obfuscate(utf16(o.password ?? "")));
  str(48, utf16(o.appName ?? "tedious"));
  str(52, utf16(o.serverName ?? "localhost"));
  const extPointer = Buffer.alloc(4);
  fixed.writeUInt16LE(put(extPointer), 56);
  fixed.writeUInt16LE(4, 58);
  str(60, utf16(o.libraryName ?? "tedious"));
  str(64, utf16(o.language ?? ""));
  str(68, utf16(o.database ?? ""));

  if (o.features?.length) {
    fixed[27] |= 0x10;
    const block = [];
    for (const { id, data } of o.features) {
      const head = Buffer.alloc(5);
      head[0] = id;
      head.writeUInt32LE(data.length, 1);
      block.push(head, data);
    }
    block.push(bytes(0xff));
    extPointer.writeUInt32LE(put(Buffer.concat(block)), 0);
  }

  const body = Buffer.concat([fixed, ...parts]);
  body.writeUInt32LE(body.length, 0);
  return body;
}

const fedSecurityToken = (token, echo = false) => {
  const t = utf16(token);
  const head = Buffer.alloc(5);
  head[0] = (FEDAUTH_LIBRARY.SECURITY_TOKEN << 1) | (echo ? 1 : 0);
  head.writeUInt32LE(t.length, 1);
  return { id: 0x02, data: Buffer.concat([head, t]) };
};
const fedAdal = (workflow, echo = false) => ({
  id: 0x02,
  data: bytes((FEDAUTH_LIBRARY.ADAL << 1) | (echo ? 1 : 0), workflow),
});

const decodeCases = [
  {
    name: "SQL login: user, database, app and server names, no FEDAUTH",
    buffer: () => encodeLogin7({ userName: "sa", password: "p@ss w0rd", database: "org", appName: "tedious" }),
    expect: { userName: "sa", password: "p@ss w0rd", database: "org", appName: "tedious", serverName: "localhost", fedAuth: null },
  },
  {
    name: "password obfuscation vector: 'a' is stored as B3 A5",
    buffer: () => encodeLogin7({ obfuscatedPassword: bytes(0xb3, 0xa5) }),
    expect: { password: "a" },
  },
  {
    name: "fixed header fields: TDS version, packet size, LCID, client id",
    buffer: () => encodeLogin7({ tdsVersion: 0x74000004, packetSize: 8192, clientLcid: 0x0409, clientId: bytes(1, 2, 3, 4, 5, 6) }),
    expect: { tdsVersion: 0x74000004, packetSize: 8192, clientLcid: 0x0409, clientId: bytes(1, 2, 3, 4, 5, 6), optionFlags3: 0 },
  },
  {
    name: "FEDAUTH SecurityToken with echo: token is UTF-16LE",
    buffer: () => encodeLogin7({ features: [fedSecurityToken("eyJhbGciOiJSUzI1NiJ9.x.y", true)] }),
    expect: { optionFlags3: 0x10, fedAuth: { library: 1, echo: true, token: "eyJhbGciOiJSUzI1NiJ9.x.y" } },
  },
  {
    name: "FEDAUTH SecurityToken without echo",
    buffer: () => encodeLogin7({ features: [fedSecurityToken("t")] }),
    expect: { fedAuth: { library: 1, echo: false, token: "t" } },
  },
  {
    name: "FEDAUTH SecurityToken with a 32-byte nonce after the token",
    buffer: () => {
      const nonce = Buffer.alloc(32, 0x7e);
      const t = utf16("tok");
      const head = bytes(0x03);
      const len = Buffer.alloc(4);
      len.writeUInt32LE(t.length);
      return encodeLogin7({ features: [{ id: 0x02, data: Buffer.concat([head, len, t, nonce]) }] });
    },
    expect: { fedAuth: { library: 1, echo: true, token: "tok", nonce: Buffer.alloc(32, 0x7e) } },
  },
  {
    name: "FEDAUTH ADAL/MSAL workflow (library 0x02): workflow byte, no token",
    buffer: () => encodeLogin7({ features: [fedAdal(0x01, true)] }),
    expect: { fedAuth: { library: 2, echo: true, workflow: 1 } },
  },
  {
    name: "other features are skipped without error",
    buffer: () => encodeLogin7({ features: [{ id: 0x0a, data: bytes(0) }, fedSecurityToken("t")] }),
    expect: { fedAuth: { library: 1, echo: false, token: "t" } },
  },
];

for (const c of decodeCases) {
  test(`decodeLogin7: ${c.name}`, () => {
    const decoded = decodeLogin7(c.buffer());
    for (const [key, value] of Object.entries(c.expect)) assert.deepEqual(decoded[key], value, key);
  });
}

const rejectCases = [
  {
    name: "shorter than the fixed header",
    message: /shorter than its fixed header/,
    buffer: () => Buffer.alloc(10),
  },
  {
    name: "length field disagrees with the buffer",
    message: /length field does not match/,
    buffer: () => {
      const b = encodeLogin7({ userName: "sa" });
      b.writeUInt32LE(b.length + 4, 0);
      return b;
    },
  },
  {
    name: "variable-data offset points past the end",
    message: /outside its buffer/,
    buffer: () => {
      const b = encodeLogin7({ userName: "sa" });
      b.writeUInt16LE(0xfff0, 40);
      return b;
    },
  },
  {
    name: "feature block runs past the end (no 0xFF terminator)",
    message: /outside its buffer/,
    buffer: () => {
      const b = Buffer.from(encodeLogin7({ features: [fedSecurityToken("t")] }).subarray(0, -1));
      b.writeUInt32LE(b.length, 0);
      return b;
    },
  },
];

for (const c of rejectCases) {
  test(`decodeLogin7 rejects: ${c.name}`, () => {
    assert.throws(() => decodeLogin7(c.buffer()), { name: "RangeError", message: c.message });
  });
}

test("loginAck: LOGINACK 0xAD with big-endian TDS version and progName 'mirage' 12.0.2000", () => {
  assert.deepEqual(
    loginAck({ progName: "mirage" }),
    Buffer.concat([
      bytes(0xad, 0x16, 0x00, 0x01, 0x74, 0x00, 0x00, 0x04, 0x06),
      utf16("mirage"),
      bytes(0x0c, 0x00, 0x07, 0xd0),
    ]),
  );
});

test("loginAck rejects a malformed version", () => {
  assert.throws(() => loginAck({ version: "12.0" }), { name: "RangeError", message: /not major\.minor\.build/ });
});

const tokenCases = [
  {
    name: "ENVCHANGE database, B_VARCHAR old and new values",
    buffer: () => envChange(ENV_TYPE.DATABASE, "org", "master"),
    expect: Buffer.concat([bytes(0xe3, 0x15, 0x00, 0x01, 0x03), utf16("org"), bytes(0x06), utf16("master")]),
  },
  {
    name: "ENVCHANGE packet size, numeric value as text",
    buffer: () => envChange(ENV_TYPE.PACKET_SIZE, 4096, 4096),
    expect: Buffer.concat([bytes(0xe3, 0x13, 0x00, 0x04, 0x04), utf16("4096"), bytes(0x04), utf16("4096")]),
  },
  {
    name: "ENVCHANGE SQL collation, B_VARBYTE new value and empty old value",
    buffer: () => envChange(ENV_TYPE.SQL_COLLATION, bytes(0x09, 0x04, 0xd0, 0x00, 0x34)),
    expect: bytes(0xe3, 0x08, 0x00, 0x07, 0x05, 0x09, 0x04, 0xd0, 0x00, 0x34, 0x00),
  },
  {
    name: "FEATUREEXTACK with an empty FEDAUTH ack",
    buffer: () => featureExtAck([{ id: 0x02 }]),
    expect: bytes(0xae, 0x02, 0, 0, 0, 0, 0xff),
  },
  {
    name: "FEATUREEXTACK with ack data",
    buffer: () => featureExtAck([{ id: 0x02, data: bytes(0x01) }]),
    expect: bytes(0xae, 0x02, 0x01, 0, 0, 0, 0x01, 0xff),
  },
  {
    name: "DONE with DONE_COUNT, SELECT and two rows",
    buffer: () => done({ status: DONE_STATUS.COUNT, curCmd: 0xc1, rowCount: 2 }),
    expect: bytes(0xfd, 0x10, 0x00, 0xc1, 0x00, 0x02, 0, 0, 0, 0, 0, 0, 0),
  },
  {
    name: "ERROR 18456 login failed, class 14",
    buffer: () => error({ number: 18456, state: 1, class: 14, message: "Login failed." }),
    expect: Buffer.concat([
      bytes(0xaa, 0x28, 0x00, 0x18, 0x48, 0x00, 0x00, 0x01, 0x0e, 0x0d, 0x00),
      utf16("Login failed."),
      bytes(0x00, 0x00, 0x00, 0x00, 0x00, 0x00),
    ]),
  },
];

for (const c of tokenCases) {
  test(`token encoder: ${c.name}`, () => {
    assert.deepEqual(c.buffer(), c.expect);
  });
}

const infoDefaults = [
  { name: "INFO defaults to class 0", buffer: () => info({ number: 5701, message: "x" }), state: 1, severity: 0 },
  { name: "ERROR defaults to class 16", buffer: () => error({ number: 50000, message: "x" }), state: 1, severity: 16 },
];

for (const c of infoDefaults) {
  test(`message token: ${c.name}`, () => {
    const b = c.buffer();
    assert.deepEqual([b[7], b[8]], [c.state, c.severity]);
    assert.equal(b.readUInt16LE(1), b.length - 3);
  });
}

const fedAuthInfoCases = [
  { name: "Azure AD STS URL and SPN", stsUrl: "https://login.example.test/tenant", spn: "https://org.example.test/" },
];

for (const c of fedAuthInfoCases) {
  test(`fedAuthInfo: ${c.name}`, () => {
    const b = fedAuthInfo({ stsUrl: c.stsUrl, spn: c.spn });
    assert.equal(b[0], 0xee);
    assert.equal(b.readUInt32LE(1), b.length - 5, "TokenLength excludes the 5-byte header");
    assert.equal(b.readUInt32LE(5), 2, "CountOfInfoIDs");
    const entries = [0, 1].map((i) => {
      const at = 9 + i * 9;
      const id = b[at];
      const len = b.readUInt32LE(at + 1);
      const offset = b.readUInt32LE(at + 5);
      return [id, b.subarray(5 + offset, 5 + offset + len).toString("utf16le")];
    });
    assert.deepEqual(entries, [
      [0x01, c.stsUrl],
      [0x02, c.spn],
    ]);
  });
}
