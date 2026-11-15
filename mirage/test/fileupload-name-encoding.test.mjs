// @test-kind unproven: no native capture of the platform's wire form for file names outside Latin-1 exists; the percent-encoding and its marker are Paqvilo's own design
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(new URL('../lib/fileuploadcontrol-compat.js', import.meta.url), 'utf8');

// Runs the attach control in a vm context. XMLHttpRequest follows the header rule of a browser: a value
// with a character above U+00FF is rejected by setRequestHeader, as the platform's ByteString check does.
async function uploadFile(file) {
  const requests = [];
  class FakeRequest {
    constructor() {
      this.headers = {};
      this.status = 0;
    }
    open(method, url) {
      this.method = method;
      this.url = url;
      requests.push(this);
    }
    setRequestHeader(name, value) {
      if ([...value].some((char) => char.codePointAt(0) > 0xff)) throw new TypeError('ByteString');
      this.headers[name] = value;
    }
    send() {
      this.status = 200;
      this.responseText = JSON.stringify({ AnnotationId: 'annotation-1', FileContinuationToken: 'token-1' });
      this.onload();
    }
  }
  const input = { files: [file], value: '' };
  const elements = {
    AttachFile: input,
    newdivforfileinfo: { append() {} },
    AttachFile_HiddenField_AnnotationIds: { value: '' },
    AttachFile_HiddenField_MaxFile: { value: '5' },
    UploadButton: { disabled: false, blur() {} },
  };
  const sandbox = {
    document: {
      readyState: 'complete',
      getElementById: (id) => elements[id] ?? null,
      querySelector: () => null,
      createElement: () => ({ style: {}, append() {} }),
      addEventListener() {},
    },
    XMLHttpRequest: FakeRequest,
    URLSearchParams,
    console,
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SOURCE, sandbox);
  sandbox.chooseAttachment();
  await sandbox.__ppAttachUploads;
  return requests;
}

const isAscii = (text) => [...text].every((char) => char.codePointAt(0) < 0x80);

test('a plain ASCII file name is sent in the header unchanged', async () => {
  const [initialize] = await uploadFile({ name: 'plain name.pdf', type: 'application/pdf', size: 3 });
  assert.equal(initialize.method, 'POST');
  assert.deepEqual(initialize.headers, {
    __RequestVerificationToken: '',
    'Content-Type': 'application/pdf',
    'x-ms-file-name': 'plain name.pdf',
    'x-ms-file-type': 'application/pdf',
    'x-ms-form-session-id': '',
    'X-Requested-With': 'XMLHttpRequest',
    'x-ms-file-size': '3',
  });
});

test('an ASCII file name with percent signs is not decoded by the server: it is sent literally, unmarked', async () => {
  const [initialize] = await uploadFile({ name: '100%.pdf', type: 'application/pdf', size: 3 });
  assert.equal(initialize.headers['x-ms-file-name'], '100%.pdf');
  assert.equal(initialize.headers['x-ms-file-name-encoding'], undefined);
});

test('a file name outside printable ASCII is percent-encoded as UTF-8 and marked, and decodes to the original', async () => {
  const name = 'отчёт 測試.pdf';
  const [initialize] = await uploadFile({ name, type: 'application/pdf', size: 3 });
  const header = initialize.headers['x-ms-file-name'];
  assert.equal(typeof header, 'string');
  assert.equal(isAscii(header), true);
  assert.equal(decodeURIComponent(header), name);
  assert.equal(initialize.headers['x-ms-file-name-encoding'], 'uri-component');
});

test('a Latin-1 file name outside ASCII is encoded too, so no header carries a non-ASCII byte', async () => {
  const name = 'Łódź.pdf';
  const [initialize] = await uploadFile({ name, type: 'application/pdf', size: 3 });
  assert.equal(isAscii(initialize.headers['x-ms-file-name']), true);
  assert.equal(decodeURIComponent(initialize.headers['x-ms-file-name']), name);
});
