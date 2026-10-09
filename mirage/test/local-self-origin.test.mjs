import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { clientLocalSelfOriginRuntime } from "../lib/local-self-origin.mjs";

test("only portless loopback self-origin URLs normalize; external and explicit ports remain intact", async () => {
  const calls = [];
  class Xhr {
    open(...args) {
      calls.push(args);
    }
  }
  const context = {
    URL,
    Request,
    location: new URL("http://127.0.0.1:54321/page/"),
    document: { addEventListener() {} },
    XMLHttpRequest: Xhr,
    fetch: async (input) => {
      calls.push(typeof input === "string" ? input : input.url);
    },
    open: (...args) => calls.push(args),
  };
  context.window = context;
  vm.runInNewContext(`(()=>{${clientLocalSelfOriginRuntime()}})()`, context);
  await context.fetch("http://127.0.0.1/_portal/form?a=1");
  await context.fetch(
    new Request("http://127.0.0.1/api", { method: "POST", body: "local" }),
  );
  await context.fetch("http://127.0.0.1:80/explicit");
  await context.fetch("http://127.0.0.1:54322/other");
  await context.fetch("https://127.0.0.1/secure");
  await context.fetch("http://localhost/alias");
  await context.fetch("https://external.example/api");
  new Xhr().open("GET", "//127.0.0.1/modal");
  context.open("http://127.0.0.1/page", "_blank");
  assert.deepEqual(calls, [
    "http://127.0.0.1:54321/_portal/form?a=1",
    "http://127.0.0.1:54321/api",
    "http://127.0.0.1:80/explicit",
    "http://127.0.0.1:54322/other",
    "https://127.0.0.1/secure",
    "http://localhost/alias",
    "https://external.example/api",
    ["GET", "http://127.0.0.1:54321/modal"],
    ["http://127.0.0.1:54321/page", "_blank"],
  ]);
});
