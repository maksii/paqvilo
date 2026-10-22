import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Worker } from "node:worker_threads";
import { redactEmbeddedQueryValues as redact, writeCapture, redactTokens } from "../baseline-capture.mjs";

test('HTML and inline script URLs remove every query value while preserving neighboring structure',()=>{const value='<script src="https://maps.invalid/control?key=fixture-secret&amp;callback=loadMap&amp;page=2"></script><script>const url="/map?token=second-secret&x=17"; const sibling=17;</script>';assert.equal(redact(value),'<script src="https://maps.invalid/control?key=…&amp;callback=…&amp;page=2"></script><script>const url="/map?token=…&x=…"; const sibling=17;</script>');});
test('JSON escaped slashes and encoded ampersands preserve valid structure and siblings',()=>{for(const sep of['&amp;','&#38;','&#x26;','\\u0026']){const url='https:\\/\\/maps.invalid\\/control?key=fixture-secret'+sep+'other=second-secret',input='{"url":"'+url+'","label":"keep","count":17}';const output=redact(input);assert.equal(output,'{"url":"https:\\/\\/maps.invalid\\/control?key=…'+sep+'other=…","label":"keep","count":17}');if(sep==='\\u0026')assert.equal(JSON.parse(output).count,17);}});
test('URL path identity, duplicate query keys, flags and trailing expression punctuation survive',()=>{assert.equal(redact('fetch("https://maps.invalid/00000000-0000-0000-0000-000000000001?key=a&key=b&flag&page=3"); next();'),'fetch("https://maps.invalid/00000000-0000-0000-0000-000000000001?key=…&key=…&flag&page=3"); next();');assert.equal(redact('const next = (https://maps.invalid/control?key=fixture-secret);'),'const next = (https://maps.invalid/control?key=…);');});
test('ordinary text and URLs without query values remain unchanged',()=>{for(const input of['{"value":17,"name":"key"}','https://maps.invalid/control#details','/literal/path','<div data-key="not-a-url">untouched</div>'])assert.equal(redact(input),input);});

test("large query-free paths finish in a bounded worker and a final query is still redacted", { timeout: 10000 }, async () => {
  const worker = new Worker(`const {parentPort,workerData}=require('node:worker_threads');
    import(workerData.module).then(({redactEmbeddedQueryValues:redact})=>{
      const path='/a'.repeat(250000);
      parentPort.postMessage({unchanged:redact(path)===path,redacted:redact(path+'?key=fixture-secret')===path+'?key=…'});
    }).catch(error=>{throw error;});`, { eval: true, workerData: { module: new URL("../baseline-capture.mjs", import.meta.url).href } });
  let timer;
  try {
    const result = await new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error("Query redaction exceeded its worker deadline.")), 5000);
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    assert.deepEqual(result, { unchanged: true, redacted: true });
  } finally {
    clearTimeout(timer);
    await worker.terminate();
  }
});

test("redacted text hashes exclude original secret bytes while unchanged text and binary retain raw hashes", async () => {
  const out = await fs.mkdtemp(path.join(os.tmpdir(), "paqvilo-redaction-hash-"));
  const secret = '<script src="https://maps.invalid/control?key=fixture-secret"></script>';
  const unchanged = "\uFEFFunchanged text";
  const binary = Buffer.from([0, 255, 17, 42]);
  const hash = value => createHash("sha256").update(value).digest("hex");
  const response = (body, bytes) => ({ status: 200, headers: {}, body, bodyBytes: bytes.length, bodyHashInput: bytes.toString("base64") });
  try {
    await writeCapture({ summary: { id: "invented/hash", status: "captured", problems: [] }, raw: {
      finalUrl: "https://portal.invalid/", console: [], pageErrors: [], dialogs: [], dom: "<main>Fixture</main>", elements: [],
      requests: [response(secret, Buffer.from(secret)), response(unchanged, Buffer.from(unchanged)), response(null, binary)].map((value, seq) => ({ seq, method: "GET", url: "https://portal.invalid/asset-" + seq, headers: {}, body: null, response: value })),
    } }, { outDir: out, origin: "https://portal.invalid", side: "native", scenarioId: "invented/hash" });
    const requests = JSON.parse(await fs.readFile(path.join(out, "requests.json"), "utf8"));
    assert.equal(requests[0].response.bodySha256, hash(redactTokens(secret)));
    assert.equal(requests[0].response.bodyHashProvenance, "redacted-text-sha256");
    assert.equal(requests[0].response.bodyBytes, Buffer.byteLength(secret));
    assert.equal(requests[1].response.bodySha256, hash(Buffer.from(unchanged)));
    assert.equal(requests[2].response.bodySha256, hash(binary));
    for (const file of await fs.readdir(out)) {
      if (!/\.(json|html)$/.test(file)) continue;
      const text = await fs.readFile(path.join(out, file), "utf8");
      assert.equal(text.includes("fixture-secret"), false, file);
      assert.equal(text.includes(hash(secret)), false, file);
    }
  } finally {
    await fs.rm(out, { recursive: true, force: true });
  }
});

test('capture persistence redacts URL queries in DOM, bodies, frames, element inventory and console',async()=>{const out=await fs.mkdtemp(path.join(os.tmpdir(),'paqvilo-redaction-'));try{
 const url='https://maps.invalid/control?key=fixture-secret&callback=init',html=`<script src="${url}"></script>`,json=JSON.stringify({url,sibling:17});
 await writeCapture({summary:{id:'invented/geo',status:'captured',problems:[],startedAt:'2026-01-01T00:00:00Z',finishedAt:'2026-01-01T00:00:01Z'},raw:{finalUrl:'https://portal.invalid/geo',requests:[{seq:1,method:'GET',url:'https://portal.invalid/geo',headers:{},body:null,response:{status:200,headers:{},body:html,mime:'text/html'}}],console:[{type:'log',text:url}],pageErrors:[],dialogs:[],dom:html,frames:[{path:'frame',dom:html}],elements:[{tag:'script',attributes:{src:url},sibling:17}]}},{outDir:out,origin:'https://portal.invalid',side:'native',scenarioId:'invented/geo'});
 for(const file of(await fs.readdir(out)).filter(f=>/\.(?:json|html)$/.test(f))){const text=await fs.readFile(path.join(out,file),'utf8');assert.equal(text.includes('fixture-secret'),false,file);}
 const elements=JSON.parse(await fs.readFile(path.join(out,'elements.json'),'utf8'));assert.equal(elements[0].sibling,17);assert.equal(elements[0].attributes.src,'https://maps.invalid/control?key=…&callback=…');
 assert.deepEqual(JSON.parse(redactTokens(json)),{url:'https://maps.invalid/control?key=…&callback=…',sibling:17});
 }finally{await fs.rm(out,{recursive:true,force:true});}});
