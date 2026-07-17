import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIdb } from "../src/index.js";

const project = "idb_api_contract";

const callbackRun = (database, statement, ...args) =>
  new Promise((resolve, reject) => {
    database.run(project, statement, ...args, (error, result) => {
      if (error) reject(error);
      else resolve(result);
    });
  });

test("IDB public API contract", async (t) => {
  const storagePath = await mkdtemp(path.join(os.tmpdir(), "ev3-idb-api-"));
  const database = createIdb({ storagePath });

  const run = async (statement, ...params) => {
    const outcome =
      params.length > 0
        ? await database.run(project, statement, params[0])
        : await database.run(project, statement);

    assert.equal(outcome.error, null);
    return outcome.result;
  };

  try {
    await t.test("run resolves a success or error envelope", async () => {
      const success = await database.run(project, "INSERT INTO envelopes", {
        value: 1,
      });

      assert.equal(success.error, null);
      assert.equal(typeof success.result, "number");

      const failure = await database.run(project, "NOT AN IDB STATEMENT");

      assert.ok(failure.error instanceof Error);
      assert.equal(failure.result, undefined);
    });

    await t.test("run supports callback overloads with and without params", async () => {
      const insertedId = await callbackRun(
        database,
        "INSERT INTO callback_documents",
        { key: "callback", value: 7 },
      );

      assert.equal(typeof insertedId, "number");

      const documents = await callbackRun(
        database,
        "GET callback_documents",
      );

      assert.deepEqual(documents, [{ key: "callback", value: 7 }]);

      const callbackError = await new Promise((resolve) => {
        database.run(project, "NOT AN IDB STATEMENT", (error, result) => {
          resolve({ error, result });
        });
      });

      assert.ok(callbackError.error instanceof Error);
      assert.equal(callbackError.result, undefined);
    });

    await t.test("execute returns results directly and rejects errors", async () => {
      const insertedId = await database.execute(
        project,
        "INSERT INTO execute_documents",
        { key: "execute" },
      );

      assert.equal(typeof insertedId, "number");
      await assert.rejects(
        database.execute(project, "NOT AN IDB STATEMENT"),
        /unsupported|statement|syntax/i,
      );
    });

    await t.test("inserts one document or a batch and returns object IDs", async () => {
      const singleId = await run("INSERT INTO insert_documents", {
        key: "single",
        nested: { value: 1 },
      });
      const batchIds = await run("INSERT INTO insert_documents", [
        { key: "batch-a" },
        { key: "batch-b", nested: { value: 2 } },
      ]);

      assert.equal(typeof singleId, "number");
      assert.equal(singleId > 0, true);
      assert.equal(batchIds.length, 2);
      assert.equal(new Set(batchIds).size, 2);
      assert.ok(batchIds.every((id) => Number.isInteger(id) && id > 0));

      const documents = await run("GET insert_documents ORDER BY key");

      assert.deepEqual(
        documents.map(({ key }) => key),
        ["batch-a", "batch-b", "single"],
      );
    });

    await t.test("GET, FIND, and COLLECT are equivalent document aliases", async () => {
      await run("INSERT INTO retrieval_documents", [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);

      const get = await run("GET retrieval_documents ORDER BY key");
      const find = await run("FIND retrieval_documents ORDER BY key");
      const collect = await run("COLLECT retrieval_documents ORDER BY key");

      assert.deepEqual(find, get);
      assert.deepEqual(collect, get);
      assert.deepEqual(get, [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
    });

    await t.test("round-trips all supported scalar and payload types", async () => {
      const timestamp = new Date("2026-07-17T12:34:56.789Z");
      const bytes = Buffer.from([0, 1, 2, 127, 128, 255]);
      const longText = "long-value-".repeat(40);
      const document = {
        key: "types",
        nullValue: null,
        trueValue: true,
        falseValue: false,
        integer: 42,
        decimal: 1.25,
        bigInteger: 9_007_199_254_740_993n,
        timestamp,
        bytes,
        longText,
        values: [1, null, 4n, { enabled: true }],
        nested: { label: "nested", nullable: null },
      };

      await run("INSERT INTO typed_documents", document);
      const [actual] = await run(
        "GET typed_documents WHERE key = $key",
        { $key: "types" },
      );

      assert.deepEqual(actual, document);
      assert.ok(actual.timestamp instanceof Date);
      assert.ok(Buffer.isBuffer(actual.bytes));
      assert.equal(typeof actual.bigInteger, "bigint");
      assert.equal(typeof actual.values[2], "bigint");
      assert.equal(actual.longText.length, longText.length);
    });

    await t.test("UPDATE merges documents and nested objects", async () => {
      await run("INSERT INTO merge_documents", {
        key: "merge",
        preserved: "yes",
        nested: { changed: 1, preserved: 2 },
      });

      const updated = await run("UPDATE merge_documents WHERE key = 'merge'", {
        key: "merge",
        added: true,
        nested: { changed: 9 },
      });

      assert.equal(updated.length, 1);
      assert.equal(typeof updated[0].object_id, "number");

      const [document] = await run("GET merge_documents WHERE key = $key", {
        $key: "merge",
      });

      assert.deepEqual(document, {
        key: "merge",
        preserved: "yes",
        added: true,
        nested: { changed: 9, preserved: 2 },
      });
    });

    await t.test("INSERT OR REPLACE removes omitted fields", async () => {
      await run("INSERT INTO replace_documents", {
        key: "replace",
        stale: true,
        nested: { stale: true },
      });

      await run(
        "INSERT OR REPLACE INTO replace_documents WHERE key = 'replace'",
        { key: "replace", fresh: true },
      );

      const documents = await run(
        "GET replace_documents WHERE key = $key",
        { $key: "replace" },
      );

      assert.deepEqual(documents, [{ key: "replace", fresh: true }]);
    });

    await t.test("UPSERT merges matches and inserts misses", async () => {
      await run("INSERT INTO upsert_documents", {
        key: "existing",
        preserved: true,
        value: 1,
      });

      await run("UPSERT INTO upsert_documents WHERE key = 'existing'", {
        key: "existing",
        value: 2,
      });
      await run("UPSERT INTO upsert_documents WHERE key = 'new'", {
        key: "new",
        value: 3,
      });

      const documents = await run("GET upsert_documents ORDER BY key");

      assert.deepEqual(documents, [
        { key: "existing", preserved: true, value: 2 },
        { key: "new", value: 3 },
      ]);
    });

    await t.test("DELETE removes selected fields or complete documents", async () => {
      await run("INSERT INTO delete_documents", {
        key: "delete",
        keep: true,
        remove: { nested: true },
      });

      const fieldDeletion = await run(
        "DELETE remove FROM delete_documents WHERE key = $key",
        { $key: "delete" },
      );

      assert.equal(fieldDeletion.length, 1);
      assert.deepEqual(
        await run("GET delete_documents WHERE key = $key", {
          $key: "delete",
        }),
        [{ key: "delete", keep: true }],
      );

      const documentDeletion = await run(
        "DELETE FROM delete_documents WHERE key = $key",
        { $key: "delete" },
      );

      assert.equal(documentDeletion.length, 1);
      assert.deepEqual(await run("GET delete_documents"), []);
    });

    await t.test("close releases one project or all open handles", async () => {
      await assert.doesNotReject(() => database.close(project));

      // A later operation lazily reopens the persisted project.
      const documents = await run("GET envelopes");
      assert.equal(documents.length, 1);

      await assert.doesNotReject(() => database.close());
    });
  } finally {
    await database.close().catch(() => {});
    await rm(storagePath, { recursive: true, force: true });
  }
});
