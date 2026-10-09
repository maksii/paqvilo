import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  collectFetchXmlPages,
  escapeXmlAttribute,
} from "../lib/paging-validation.mjs";
import { createSimulator } from "../server.mjs";
import { decodePagingCookie } from "../lib/live.mjs";

test("bounded complete paging preserves cookie continuity and rejects missing/repeated/error/partial continuations", async () => {
  const calls = [];
  const collect = await collectFetchXmlPages({
    idColumn: "id",
    pageSize: 1,
    readPage: async (options) => {
      calls.push(options);
      return {
        entities: [{ id: String(options.page) }],
        more_records: options.page === 1,
        paging_cookie: options.page === 1 ? '<cookie page="1"/>' : null,
      };
    },
  });
  assert.deepEqual(calls, [
    { page: 1, cookie: null, pageSize: 1 },
    { page: 2, cookie: '<cookie page="1"/>', pageSize: 1 },
  ]);
  assert.equal(collect.complete, true);
  assert.equal(collect.records.length, 2);
  for (const second of [
    { entities: [{ id: "two" }], more_records: true, paging_cookie: "cookie" },
    { entities: [{ id: "one" }], more_records: false },
    { entities: [], more_records: true, paging_cookie: "second" },
    { entities: [{}], more_records: false },
    { entities: [{ id: "two" }], more_records: "false" },
  ])
    await assert.rejects(
      collectFetchXmlPages({
        idColumn: "id",
        readPage: async ({ page }) =>
          page === 1
            ? {
                entities: [{ id: "one" }],
                more_records: true,
                paging_cookie: "cookie",
              }
            : second,
      }),
    );
  await assert.rejects(
    collectFetchXmlPages({
      idColumn: "id",
      maxPages: 1,
      readPage: async () => ({
        entities: [{ id: "one" }],
        more_records: true,
        paging_cookie: "cookie",
      }),
    }),
    /bounded page limit/,
  );
  await assert.rejects(
    collectFetchXmlPages({
      idColumn: "id",
      readPage: async () => {
        throw Error("HTTP403");
      },
    }),
    /HTTP403/,
  );
});

test("public FetchXML returns genuine continuation annotations while preserving record scope and selected columns", async (t) => {
  const dir = await fs.mkdtemp(
    path.join(os.tmpdir(), "pp-fetch-continuation-"),
  );
  let app;
  t.after(async () => {
    await app?.close();
    await fs.rm(dir, { recursive: true, force: true });
  });
  await fs.writeFile(
    path.join(dir, "website.yml"),
    "adx_websiteid: site\nadx_name: Paging",
  );
  await fs.writeFile(
    path.join(dir, "sitesetting.yml"),
    "- adx_name: Webapi/item/enabled\n  adx_value: true\n- adx_name: Webapi/item/fields\n  adx_value: itemid,name",
  );
  app = await createSimulator({
    sourceDir: dir,
    stateFile: path.join(dir, "state.json"),
    watch: false,
    initial: {
      mappings: { item: { entitySet: "items", idColumn: "itemid" } },
      tables: {
        item: [
          { itemid: "a", owner: "person", name: "First", secret: "hidden" },
          { itemid: "b", owner: "person", name: "Second", secret: "hidden" },
          { itemid: "c", owner: "other", name: "Denied" },
        ],
      },
      permissions: [
        {
          entity: "item",
          roles: ["Member"],
          operations: ["read"],
          scope: "contact",
          field: "owner",
        },
      ],
      simulator: { identityScope: "configured", identity: { contactId: "person", roles: ["Member"] } },
      settings: { permissionMode: "enforce" },
    },
  });
  const collected = await collectFetchXmlPages({
    idColumn: "itemid",
    pageSize: 1,
    readPage: async ({ page, cookie, pageSize }) => {
      const xml = `<fetch count="${pageSize}" page="${page}" returntotalrecordcount="true"${cookie ? ' paging-cookie="' + escapeXmlAttribute(cookie) + '"' : ""}><entity name="item"><attribute name="itemid"/><attribute name="name"/><order attribute="itemid"/></entity></fetch>`;
      const response = await fetch(
        app.url + "/_api/items?fetchXml=" + encodeURIComponent(xml),
      );
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body["@Microsoft.Dynamics.CRM.totalrecordcount"], 2);
      assert.equal(
        body["@Microsoft.Dynamics.CRM.totalrecordcountlimitexceeded"],
        false,
      );
      for (const row of body.value) {
        assert.equal(row.secret, undefined);
        assert.equal(row.owner, undefined);
      }
      if (page === 1)
        assert.match(
          body["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"],
          // Dataverse publishes the doubly encoded cookie with lowercase escapes
          // (count-rows and page-results documentation samples).
          /^<cookie pagenumber="2" pagingcookie="%253ccookie%2520page%253d%25221%2522%253e/,
        );
      return {
        entities: body.value,
        more_records: body["@Microsoft.Dynamics.CRM.morerecords"],
        paging_cookie: decodePagingCookie(
          body["@Microsoft.Dynamics.CRM.fetchxmlpagingcookie"],
        ),
      };
    },
  });
  assert.deepEqual(
    collected.records.map((row) => row.itemid),
    ["a", "b"],
  );
  assert.equal(collected.pages.length, 2);
});
