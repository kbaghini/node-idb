import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { createIdb } from "../src/index.js";

let database;
let temporaryRoot;

const withoutObjectIds = (rows) =>
  rows.map(({ object_id: _objectId, ...row }) => row);

const insert = (collection, documents) =>
  database.execute(`INSERT INTO ${collection}`, documents);

describe("IDB SQL contract", { concurrency: false }, () => {
  before(async () => {
    temporaryRoot = await mkdtemp(path.join(tmpdir(), "ev3-idb-sql-"));
    database = createIdb({
      storagePath: path.join(temporaryRoot, "idbs"),
    });
  });

  after(async () => {
    await database?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  });

  test("nested aliases are exact, explicit, collision-safe, and deterministic", async () => {
    await insert("alias_home_first", [
      {
        title: "first",
        home: { city: "Tehran", code: 11 },
        work: { city: "Shiraz", code: 22 },
      },
    ]);
    await insert("alias_work_first", [
      {
        title: "first",
        work: { city: "Shiraz", code: 22 },
        home: { city: "Tehran", code: 11 },
      },
    ]);

    const explicit = withoutObjectIds(
      await database.execute(
        `SELECT home.city AS residence, work.city AS office
           FROM alias_home_first`,
      ),
    );
    assert.deepEqual(explicit, [
      { residence: "Tehran", office: "Shiraz" },
    ]);

    const exact = withoutObjectIds(
      await database.execute(
        "SELECT home.city FROM alias_home_first",
      ),
    );
    assert.deepEqual(exact, [{ "home.city": "Tehran" }]);

    for (const collection of ["alias_home_first", "alias_work_first"]) {
      const [row] = withoutObjectIds(
        await database.execute(`SELECT city FROM ${collection}`),
      );

      assert.deepEqual(Object.keys(row).sort(), ["home.city", "work.city"]);
      assert.equal(row["home.city"], "Tehran");
      assert.equal(row["work.city"], "Shiraz");
    }
  });

  test("table aliases qualify projections, filters, and ordering fields", async () => {
    await insert("table_alias_docs", [
      { name: "Ada", score: 91, profile: { city: "Tehran" } },
      { name: "Bob", score: 72, profile: { city: "Tabriz" } },
      { name: "Cara", score: 85, profile: { city: "Shiraz" } },
    ]);

    const rows = withoutObjectIds(
      await database.execute(
        `SELECT person.name AS person, person.profile.city AS city
           FROM table_alias_docs AS person
          WHERE person.score >= ?
          ORDER BY person.score DESC`,
        [80],
      ),
    );

    assert.deepEqual(rows, [
      { person: "Ada", city: "Tehran" },
      { person: "Cara", city: "Shiraz" },
    ]);
  });

  test("direct object projections reconstruct mixed native values while arrays remain atomic", async () => {
    const born = new Date("2026-01-02T03:04:05.678Z");
    const changed = new Date("2026-02-03T04:05:06.789Z");
    const bytes = Buffer.from([0, 1, 127, 128, 255]);
    const longText = "structured-value-".repeat(30);
    await insert("structured_projection_docs", [
      {
        ordinal: 1,
        name: "object",
        active: true,
        contact: {
          details: {
            email: "ada@example.test",
            born,
            big: 9_007_199_254_740_993n,
            bytes,
            longText,
            empty: {},
            nestedArray: [changed, 10n, Buffer.from([9, 8]), { valid: true }],
          },
        },
        tags: ["admin", { changed, big: 11n, bytes: Buffer.from([7, 6]) }],
      },
      { ordinal: 2, name: "array", contact: { details: ["one", { nested: true }] }, tags: [] },
      { ordinal: 3, name: "scalar", contact: { details: "plain" }, tags: null },
      { ordinal: 4, name: "null", contact: { details: null } },
      { ordinal: 5, name: "empty", contact: { details: {} } },
      { ordinal: 6, name: "missing" },
    ]);

    const rows = await database.execute(
      `SELECT person.contact.details AS ContactDetails,
              person.name,
              person.tags,
              person.active
         FROM structured_projection_docs AS person
        ORDER BY person.ordinal`,
    );
    assert.deepEqual(rows[0], {
      object_id: rows[0].object_id,
      ContactDetails: {
        email: "ada@example.test",
        born,
        big: 9_007_199_254_740_993n,
        bytes,
        longText,
        empty: {},
        nestedArray: [changed, 10n, Buffer.from([9, 8]), { valid: true }],
      },
      name: "object",
      tags: ["admin", { changed, big: 11n, bytes: Buffer.from([7, 6]) }],
      active: 1,
    });
    assert.deepEqual(rows.slice(1).map(({ ContactDetails, name, tags }) => ({
      ContactDetails,
      name,
      tags,
    })), [
      { ContactDetails: ["one", { nested: true }], name: "array", tags: [] },
      { ContactDetails: "plain", name: "scalar", tags: null },
      { ContactDetails: null, name: "null", tags: null },
      { ContactDetails: {}, name: "empty", tags: null },
      { ContactDetails: null, name: "missing", tags: null },
    ]);

    const [overlap] = await database.execute(
      `SELECT person.contact, person.contact.details AS details
         FROM structured_projection_docs AS person
        WHERE person.ordinal = 1`,
    );
    assert.deepEqual(overlap.contact.details, overlap.details);
    assert.notStrictEqual(overlap.contact.details, overlap.details);

    const [collisionSafe] = await database.execute(
      `SELECT object_id AS source_id, contact.details AS object_id
         FROM structured_projection_docs WHERE ordinal = 1`,
    );
    assert.equal(typeof collisionSafe.source_id, "number");
    assert.deepEqual(collisionSafe.object_id, rows[0].ContactDetails);

    assert.deepEqual(
      await database.execute("SELECT DISTINCT tags FROM structured_projection_docs"),
      [
        { tags: rows[0].tags },
        { tags: [] },
        { tags: null },
      ],
    );
    const groupedTags = await database.execute(
      "SELECT tags, COUNT(*) AS total FROM structured_projection_docs GROUP BY tags",
    );
    assert.deepEqual(groupedTags.find(({ tags }) => tags === null), { tags: null, total: 4 });
    assert.deepEqual(groupedTags.find(({ tags }) => Array.isArray(tags) && tags.length === 0), {
      tags: [],
      total: 1,
    });
    assert.deepEqual(
      groupedTags.find(({ tags }) => Array.isArray(tags) && tags.length === 2),
      { tags: rows[0].tags, total: 1 },
    );
    await assert.rejects(
      database.execute("SELECT DISTINCT contact.details FROM structured_projection_docs"),
      /object projections.*DISTINCT/i,
    );
    await assert.rejects(
      database.execute(
        "SELECT contact.details, COUNT(*) AS count FROM structured_projection_docs GROUP BY contact.details",
      ),
      /object projections.*aggregate|GROUP BY/i,
    );
    await assert.rejects(
      database.execute(
        "SELECT contact.details AS value, name AS VALUE FROM structured_projection_docs",
      ),
      /duplicate.*alias/i,
    );

    await insert("persons", {
      user: {
        name: "Ada",
        contact: {
          details: { email: "ada@example.test", channels: ["email", "sms"] },
        },
      },
    });
    assert.deepEqual(
      withoutObjectIds(await database.execute(
        "SELECT user.contact.details, user.name FROM persons",
      )),
      [{
        details: { email: "ada@example.test", channels: ["email", "sms"] },
        name: "Ada",
      }],
    );
    const [storedPathWildcard] = withoutObjectIds(
      await database.execute("SELECT user.* FROM persons"),
    );
    assert.equal(storedPathWildcard.name, "Ada");
    assert.equal(storedPathWildcard.email, "ada@example.test");
    assert.deepEqual(
      await database.execute("SELECT user.* FROM persons AS user"),
      [{
        user: {
          name: "Ada",
          contact: {
            details: { email: "ada@example.test", channels: ["email", "sms"] },
          },
        },
      }],
    );
  });

  test("quoted reserved words and hyphens work in collection and field names", async () => {
    await database.execute("INSERT INTO `order-log`", [
      {
        "first-name": "Ada",
        order: "priority",
        select: 7,
        group: "staff",
        "from city": "Tehran",
        "comma,field": "present",
        "shipping-address": { "zip-code": "12345" },
      },
    ]);

    const rows = withoutObjectIds(
      await database.execute(
        `SELECT entry.\`first-name\` AS first_name,
                entry.\`order\` AS ordering,
                entry.\`select\` AS selected,
                entry.\`from city\` AS from_city,
                entry.\`comma,field\` AS comma_field,
                \`shipping-address.zip-code\` AS zip_code
           FROM \`order-log\` AS entry
          WHERE entry.\`group\` = ?`,
        ["staff"],
      ),
    );

    assert.deepEqual(rows, [
      {
        first_name: "Ada",
        ordering: "priority",
        selected: 7,
        from_city: "Tehran",
        comma_field: "present",
        zip_code: "12345",
      },
    ]);

    await database.execute(
      "UNSET `from city`, `comma,field` FROM `order-log` WHERE `group`='staff'",
    );
    const [remaining] = await database.execute("FIND `order-log`");
    assert.ok(!("from city" in remaining));
    assert.ok(!("comma,field" in remaining));

    await database.execute(
      "DELETE FROM `order-log` WHERE `group`='staff'",
    );
    assert.deepEqual(await database.execute("FIND `order-log`"), []);
  });

  test("question-mark and star field wildcards retain their distinct depth", async () => {
    await insert("wildcard_docs", [
      {
        label: "one",
        profile: {
          displayName: "Ada",
          contactEmail: "ada@example.test",
          contact: { phoneNumber: "111" },
        },
        metrics: { scoreValue: 9 },
      },
    ]);

    const [topLevel] = withoutObjectIds(
      await database.execute("SELECT ? FROM wildcard_docs"),
    );
    assert.equal(topLevel.label, "one");
    assert.ok("profile" in topLevel);
    assert.ok("metrics" in topLevel);
    assert.ok(!("displayName" in topLevel));
    assert.ok(!("phoneNumber" in topLevel));

    const [oneLevel] = withoutObjectIds(
      await database.execute("SELECT profile.? FROM wildcard_docs"),
    );
    assert.equal(oneLevel.displayName, "Ada");
    assert.equal(oneLevel.contactEmail, "ada@example.test");
    assert.ok(!("phoneNumber" in oneLevel));

    const [recursiveProfile] = withoutObjectIds(
      await database.execute("SELECT profile.* FROM wildcard_docs"),
    );
    assert.equal(recursiveProfile.displayName, "Ada");
    assert.equal(recursiveProfile.phoneNumber, "111");
    assert.ok(!("scoreValue" in recursiveProfile));

    const expectedDocument = {
      label: "one",
      profile: {
        displayName: "Ada",
        contactEmail: "ada@example.test",
        contact: { phoneNumber: "111" },
      },
      metrics: { scoreValue: 9 },
    };
    assert.deepEqual(
      await database.execute("SELECT * FROM wildcard_docs"),
      [expectedDocument],
    );
    assert.deepEqual(
      await database.execute("SELECT document.* FROM wildcard_docs AS document"),
      [expectedDocument],
    );
    assert.deepEqual(await database.execute("FIND wildcard_docs"), [expectedDocument]);
    await assert.rejects(
      database.execute("SELECT DISTINCT * FROM wildcard_docs"),
      /complete documents.*DISTINCT/i,
    );
    await assert.rejects(
      database.execute("SELECT * FROM wildcard_docs GROUP BY label"),
      /complete documents.*GROUP BY/i,
    );
  });

  test("positional and named parameters bind values without mutating inputs", async () => {
    await insert("parameter_docs", [
      { name: "Ada", score: 91, active: true },
      { name: "Alan", score: 67, active: true },
      { name: "Bob", score: 82, active: false },
    ]);

    const positionalParameters = [70, true];
    const positional = withoutObjectIds(
      await database.execute(
        `SELECT name, score FROM parameter_docs
          WHERE score >= ? AND active = ?
          ORDER BY score DESC`,
        positionalParameters,
      ),
    );
    assert.deepEqual(positional, [{ name: "Ada", score: 91 }]);
    assert.deepEqual(positionalParameters, [70, true]);

    const namedParameters = { $minimum: 60, $pattern: "A%" };
    const named = withoutObjectIds(
      await database.execute(
        `SELECT name FROM parameter_docs
          WHERE score >= $minimum AND name LIKE $pattern
          ORDER BY name`,
        namedParameters,
      ),
    );
    assert.deepEqual(named, [{ name: "Ada" }, { name: "Alan" }]);
    assert.deepEqual(namedParameters, {
      $minimum: 60,
      $pattern: "A%",
    });
  });

  test("WHERE supports logical, comparison, IN, BETWEEN, LIKE, and NULL operators", async () => {
    await insert("filter_docs", [
      { name: "Ada", age: 31, role: "admin", score: 88, nickname: null },
      { name: "Bob", age: 24, role: "user", score: 72, nickname: "Bobby" },
      { name: "Cara", age: 40, role: "owner", score: 95, nickname: null },
      { name: "Dale", age: 18, role: "guest", score: 55, nickname: "D" },
    ]);

    const names = async (where) =>
      withoutObjectIds(
        await database.execute(
          `SELECT name FROM filter_docs WHERE ${where} ORDER BY name`,
        ),
      ).map((row) => row.name);

    assert.deepEqual(
      await names("(age >= 24 AND score < 90) OR role = 'owner'"),
      ["Ada", "Bob", "Cara"],
    );
    assert.deepEqual(await names("role IN ('admin', 'owner')"), [
      "Ada",
      "Cara",
    ]);
    assert.deepEqual(await names("age BETWEEN 20 AND 35"), ["Ada", "Bob"]);
    assert.deepEqual(await names("name LIKE 'A%'"), ["Ada"]);
    assert.deepEqual(await names("name NOT LIKE 'A%'"), ["Bob", "Cara", "Dale"]);
    assert.deepEqual(await names("nickname IS NULL"), ["Ada", "Cara"]);
    assert.deepEqual(await names("nickname IS NOT NULL"), ["Bob", "Dale"]);
    assert.deepEqual(await names("age <> 24 AND score != 55"), [
      "Ada",
      "Cara",
    ]);

    await insert("escaped_pattern_docs", [
      { value: "rate%fixed" },
      { value: "rate-variable" },
    ]);
    assert.deepEqual(
      withoutObjectIds(await database.execute(
        "SELECT value FROM escaped_pattern_docs WHERE value LIKE 'rate!%%' ESCAPE '!'",
      )),
      [{ value: "rate%fixed" }],
    );
  });

  test("ORDER BY, GROUP BY, aggregate functions, LIMIT, and OFFSET compose", async () => {
    await insert("ordered_docs", [
      { name: "Ada", role: "admin", score: 88 },
      { name: "Bob", role: "user", score: 72 },
      { name: "Cara", role: "admin", score: 95 },
      { name: "Dale", role: "user", score: 55 },
    ]);

    const page = withoutObjectIds(
      await database.execute(
        `SELECT name FROM ordered_docs
          ORDER BY score DESC, name ASC
          LIMIT 2 OFFSET 1`,
      ),
    );
    assert.deepEqual(page, [{ name: "Ada" }, { name: "Bob" }]);

    const groups = withoutObjectIds(
      await database.execute(
        `SELECT role, COUNT(*) AS total, AVG(score) AS average
           FROM ordered_docs
          GROUP BY role
          ORDER BY role`,
      ),
    );
    assert.deepEqual(groups, [
      { role: "admin", total: 2, average: 91.5 },
      { role: "user", total: 2, average: 63.5 },
    ]);

    assert.deepEqual(
      withoutObjectIds(await database.execute(
        `SELECT role, COUNT(*) AS total
           FROM ordered_docs
          GROUP BY role
         HAVING total > 1
          ORDER BY role`,
      )),
      [{ role: "admin", total: 2 }, { role: "user", total: 2 }],
    );
    assert.deepEqual(
      await database.execute(
        `SELECT COUNT(DISTINCT role) AS "uniqueRoles" FROM ordered_docs`,
      ),
      [{ uniqueRoles: 2 }],
    );
    assert.deepEqual(
      withoutObjectIds(await database.execute(
        `SELECT name,
                CASE role WHEN 'admin' THEN 'privileged' ELSE 'standard' END AS kind
           FROM ordered_docs
          ORDER BY name`,
      )),
      [
        { name: "Ada", kind: "privileged" },
        { name: "Bob", kind: "standard" },
        { name: "Cara", kind: "privileged" },
        { name: "Dale", kind: "standard" },
      ],
    );

    const distinct = await database.execute(
      "SELECT DISTINCT role FROM ordered_docs ORDER BY role",
    );
    assert.deepEqual(distinct, [{ role: "admin" }, { role: "user" }]);

    await insert("typed_distinct_docs", [
      { value: true },
      { value: 1 },
      { value: new Date(1) },
      { value: false },
      { value: 0 },
    ]);
    assert.deepEqual(
      await database.execute(
        "SELECT DISTINCT value FROM typed_distinct_docs ORDER BY value",
      ),
      [{ value: 0 }, { value: 1 }],
    );

    const objectIds = await database.execute(
      `SELECT item.object_id AS "DocumentID", item.name
         FROM ordered_docs AS item
        ORDER BY item.name`,
    );
    assert.deepEqual(
      objectIds.map(({ DocumentID, name }) => ({ type: typeof DocumentID, name })),
      [
        { type: "number", name: "Ada" },
        { type: "number", name: "Bob" },
        { type: "number", name: "Cara" },
        { type: "number", name: "Dale" },
      ],
    );
    assert.deepEqual(Object.keys(objectIds[0]).sort(), ["DocumentID", "name"]);
  });

  test("UPDATE evaluates arithmetic and SQLite function expressions", async () => {
    await insert("formula_docs", [
      { name: "alpha", count: 2, price: 10.25, label: "mixed" },
      { name: "beta", count: 7, price: 3, label: "untouched" },
    ]);

    const updated = await database.execute(
      `UPDATE formula_docs
          SET count = count + ?,
              price = ROUND(price * ?, 1),
              label = UPPER(label)
        WHERE name = ?`,
      [3, 2, "alpha"],
    );
    assert.equal(updated.length, 1);
    assert.ok(Number.isInteger(updated[0].object_id));

    const rows = withoutObjectIds(
      await database.execute(
        `SELECT name, count, price, label
           FROM formula_docs
          ORDER BY name`,
      ),
    );
    assert.deepEqual(rows, [
      { name: "alpha", count: 5, price: 20.5, label: "MIXED" },
      { name: "beta", count: 7, price: 3, label: "untouched" },
    ]);
  });

  test("indexed predicates preserve SQL NULL outside direct truth context", async () => {
    await insert("null_logic_docs", [
      { key: "one", value: 1 },
      { key: "two", value: 2 },
      { key: "missing" },
    ]);

    assert.deepEqual(
      withoutObjectIds(await database.execute(
        `SELECT key, value=1 AS matches
           FROM null_logic_docs
          ORDER BY key`,
      )),
      [
        { key: "missing", matches: null },
        { key: "one", matches: 1 },
        { key: "two", matches: 0 },
      ],
    );
    assert.deepEqual(
      withoutObjectIds(await database.execute(
        `SELECT key FROM null_logic_docs
          WHERE NOT (value=1)
          ORDER BY key`,
      )),
      [{ key: "two" }],
    );
    assert.deepEqual(
      withoutObjectIds(await database.execute(
        `SELECT key FROM null_logic_docs
          WHERE (value=1) IS NULL`,
      )),
      [{ key: "missing" }],
    );

    await database.execute(
      "UPDATE null_logic_docs SET matches=(value=1)",
    );
    assert.deepEqual(
      await database.execute("FIND null_logic_docs ORDER BY key"),
      [
        { key: "missing", matches: null },
        { key: "one", value: 1, matches: 1 },
        { key: "two", value: 2, matches: 0 },
      ],
    );
  });

  test("UNSET removes selected fields and DELETE removes complete matching documents", async () => {
    await insert("delete_docs", [
      {
        name: "keep",
        status: "active",
        profile: { city: "Tehran", zip: "11111" },
      },
      {
        name: "remove",
        status: "inactive",
        profile: { city: "Shiraz", zip: "22222" },
      },
    ]);

    const partiallyDeleted = await database.execute(
      "UNSET profile.city, status FROM delete_docs WHERE name = ?",
      ["keep"],
    );
    assert.equal(partiallyDeleted.length, 1);

    const [remaining] = await database.execute(
      "FIND delete_docs WHERE name = ?",
      ["keep"],
    );
    assert.deepEqual(remaining, {
      name: "keep",
      profile: { zip: "11111" },
    });

    const fullyDeleted = await database.execute(
      "DELETE FROM delete_docs WHERE name = ?",
      ["remove"],
    );
    assert.equal(fullyDeleted.length, 1);

    const documents = await database.execute(
      "FIND delete_docs ORDER BY name",
    );
    assert.deepEqual(documents, [
      { name: "keep", profile: { zip: "11111" } },
    ]);
  });

  test("QUERY ON accepts read-only SELECT and EXPLAIN statements", async () => {
    await insert("raw_docs", [{ value: 1 }]);

    const queryPrefix = await database.execute(
      "QUERY ON raw_docs SELECT ? AS value",
      [42],
    );
    assert.deepEqual(queryPrefix, [{ value: 42 }]);

    const plan = await database.execute(
      "QUERY ON raw_docs EXPLAIN QUERY PLAN SELECT 1",
    );
    assert.ok(plan.length > 0);
    assert.equal(typeof plan[0].detail, "string");

    await assert.rejects(
      database.execute(
        "QUERY ON raw_docs UPDATE tbl_record SET last_record_id = 0",
      ),
      /read.only|SELECT|EXPLAIN/i,
    );
  });
});
