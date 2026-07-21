import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createIdb } from "../src/index.js";

const callbackRun = (database, statement, ...args) =>
  new Promise((resolve, reject) => {
    database.run(statement, ...args, (error, result) => {
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
        ? await database.run(statement, params[0])
        : await database.run(statement);

    assert.equal(outcome.error, null);
    return outcome.result;
  };

  try {
    await t.test("run resolves a success or error envelope", async () => {
      const success = await database.run("INSERT INTO envelopes", {
        value: 1,
      });

      assert.equal(success.error, null);
      assert.equal(typeof success.result, "number");

      const failure = await database.run("NOT AN IDB STATEMENT");

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
        "FIND callback_documents",
      );

      assert.deepEqual(documents, [{ key: "callback", value: 7 }]);

      const callbackError = await new Promise((resolve) => {
        database.run("NOT AN IDB STATEMENT", (error, result) => {
          resolve({ error, result });
        });
      });

      assert.ok(callbackError.error instanceof Error);
      assert.equal(callbackError.result, undefined);
    });

    await t.test("execute returns results directly and rejects errors", async () => {
      const insertedId = await database.execute(
        "INSERT INTO execute_documents",
        { key: "execute" },
      );

      assert.equal(typeof insertedId, "number");
      await assert.rejects(
        database.execute("NOT AN IDB STATEMENT"),
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

      const documents = await run("FIND insert_documents ORDER BY key");

      assert.deepEqual(
        documents.map(({ key }) => key),
        ["batch-a", "batch-b", "single"],
      );
    });

    await t.test("FIND reconstructs complete documents", async () => {
      await run("INSERT INTO retrieval_documents", [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);

      const documents = await run("FIND retrieval_documents ORDER BY key");

      assert.deepEqual(documents, [
        { key: "a", value: 1 },
        { key: "b", value: 2 },
      ]);
    });

    await t.test("command-like scalar strings remain valid document payloads", async () => {
      const directId = await database.execute(
        "INSERT INTO scalar_documents",
        "FIND is stored data",
      );
      assert.equal(typeof directId, "number");

      const outcome = await database.run(
        "INSERT INTO scalar_documents",
        "UPDATE is also stored data",
      );
      assert.equal(outcome.error, null);
      assert.equal(typeof outcome.result, "number");
      assert.deepEqual(await database.execute("FIND scalar_documents ORDER BY object_id"), [
        "FIND is stored data",
        "UPDATE is also stored data",
      ]);
      assert.deepEqual(await database.execute("SELECT * FROM scalar_documents ORDER BY object_id"), [
        "FIND is stored data",
        "UPDATE is also stored data",
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
        "FIND typed_documents WHERE key = $key",
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

      const [document] = await run("FIND merge_documents WHERE key = $key", {
        $key: "merge",
      });

      assert.deepEqual(document, {
        key: "merge",
        preserved: "yes",
        added: true,
        nested: { changed: 9, preserved: 2 },
      });
    });

    await t.test("REPLACE INTO removes omitted fields", async () => {
      await run("INSERT INTO replace_documents", {
        key: "replace",
        stale: true,
        nested: { stale: true },
      });

      await run(
        "REPLACE INTO replace_documents WHERE key = 'replace'",
        { key: "replace", fresh: true },
      );

      const documents = await run(
        "FIND replace_documents WHERE key = $key",
        { $key: "replace" },
      );

      assert.deepEqual(documents, [{ key: "replace", fresh: true }]);
    });

    await t.test("requireMatch makes replace and upsert atomic must-exist mutations", async () => {
      await database.execute("INSERT INTO required_matches", {
        key: "existing",
        stale: true,
      });

      const replaced = await database.execute(
        "REPLACE INTO required_matches WHERE key = 'existing'",
        { key: "existing", fresh: true },
        { requireMatch: true },
      );
      const missed = await database.execute(
        "UPSERT INTO required_matches WHERE key = 'missing'",
        { key: "missing", inserted: false },
        { requireMatch: true },
      );

      assert.equal(replaced.length, 1);
      assert.deepEqual(missed, []);
      assert.deepEqual(await database.execute("SELECT * FROM required_matches"), [
        { key: "existing", fresh: true },
      ]);
      await assert.rejects(
        database.execute("SELECT * FROM required_matches", [], { requireMatch: true }),
        /requireMatch.*UPSERT INTO.*REPLACE INTO/i,
      );
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

      const documents = await run("FIND upsert_documents ORDER BY key");

      assert.deepEqual(documents, [
        { key: "existing", preserved: true, value: 2 },
        { key: "new", value: 3 },
      ]);
    });

    await t.test("UNSET removes fields and DELETE removes complete documents", async () => {
      await run("INSERT INTO delete_documents", {
        key: "delete",
        keep: true,
        remove: { nested: true },
      });

      const fieldDeletion = await run(
        "UNSET remove FROM delete_documents WHERE key = $key",
        { $key: "delete" },
      );

      assert.equal(fieldDeletion.length, 1);
      assert.deepEqual(
        await run("FIND delete_documents WHERE key = $key", {
          $key: "delete",
        }),
        [{ key: "delete", keep: true }],
      );

      const documentDeletion = await run(
        "DELETE FROM delete_documents WHERE key = $key",
        { $key: "delete" },
      );

      assert.equal(documentDeletion.length, 1);
      assert.deepEqual(await run("FIND delete_documents"), []);
    });

    await t.test("document selectors reject grouped mutation results", async () => {
      await run("INSERT INTO selector_documents", { category: "one", value: 1 });

      for (const statement of [
        "FIND selector_documents GROUP BY category",
        "UPDATE selector_documents GROUP BY category",
        "UPSERT INTO selector_documents WHERE value > 0 GROUP BY category",
        "REPLACE INTO selector_documents WHERE value > 0 HAVING COUNT(*) > 0",
        "UNSET value FROM selector_documents GROUP BY category",
        "DELETE FROM selector_documents HAVING COUNT(*) > 0",
      ]) {
        await assert.rejects(database.execute(statement, { updated: true }), /GROUP BY|HAVING.*SELECT/i);
      }

      assert.deepEqual(await run("FIND selector_documents"), [{ category: "one", value: 1 }]);
    });

    await t.test("removed statement aliases report their canonical replacements", async (t) => {
      const cases = [
        ["GET envelopes", /GET.*removed.*SELECT \* FROM/i],
        ["COLLECT envelopes", /COLLECT.*removed.*SELECT \* FROM/i],
        ["INSERT envelopes", /INSERT.*INTO/i],
        ["UPSERT envelopes WHERE value = 1", /UPSERT INTO/i],
        ["INSERT OR UPDATE INTO envelopes WHERE value = 1", /INSERT OR UPDATE.*UPSERT INTO/i],
        ["INSERT OR REPLACE INTO envelopes WHERE value = 1", /INSERT OR REPLACE.*REPLACE INTO/i],
        ["DELETE value FROM envelopes", /DELETE.*UNSET/i],
        ["DELETE envelopes FROM envelopes", /DELETE FROM/i],
        ["ON envelopes SELECT 1", /QUERY ON/i],
      ];

      for (const [statement, expected] of cases) {
        await t.test(statement, async () => {
          await assert.rejects(database.execute(statement), expected);
        });
      }
    });

    await t.test("removed project arguments fail with migration guidance", async () => {
      await assert.rejects(
        database.execute("legacy-project", "FIND envelopes"),
        /execute.*no longer accepts a project/i,
      );

      const outcome = await database.run("legacy-project", "FIND envelopes");
      assert.match(String(outcome.error), /run.*no longer accepts a project/i);
      assert.equal(outcome.result, undefined);

      const callbackError = await new Promise((resolve) => {
        database.run("legacy-project", "FIND envelopes", [], (error, result) => {
          resolve({ error, result });
        });
      });
      assert.match(String(callbackError.error), /run.*no longer accepts a project/i);
      assert.equal(callbackError.result, undefined);
    });

    await t.test("close rejects the removed project parameter without closing", async () => {
      await assert.rejects(database.close("legacy-project"), /no longer accepts a project/i);
      assert.equal((await database.execute("FIND envelopes")).length, 1);
    });

    await t.test("close is terminal and idempotent", async () => {
      const firstClose = database.close();
      const secondClose = database.close();
      assert.equal(secondClose, firstClose);
      await firstClose;

      await assert.rejects(
        database.execute("FIND envelopes"),
        /closed/i,
      );
      const outcome = await database.run("FIND envelopes");
      assert.match(String(outcome.error), /closed/i);
      assert.equal(outcome.result, undefined);
    });
  } finally {
    await database.close().catch(() => {});
    await rm(storagePath, { recursive: true, force: true });
  }
});
