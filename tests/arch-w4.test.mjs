import test from "node:test";
import assert from "node:assert/strict";
import { findConflicts, splitKey } from "../tools/check-catalogs.mjs";
import * as leader from "../scripts/leader.mjs";

test("check-catalogs: slug и slug@type", () => {
  assert.deepEqual(splitKey("a-b@feat"), { slug: "a-b", type: "feat" });
  const items = [{ uuid: "U1", slug: "x", type: "feat" }, { uuid: "U2", slug: "x", type: "action" }, { uuid: "U3", slug: "y", type: "spell" }];
  const gen = { "m.json": { U1: {}, U2: {}, U3: {} }, "p.json": { U2: {} } };
  const r = findConflicts(["x@action", "z"], items, gen);
  assert.deepEqual(r.map((c) => `${c.file}:${c.uuid}`), ["m.json:U2", "p.json:U2"]);
  assert.equal(findConflicts(["x"], items, gen).length, 3);
});

test("leader: до start() whenSettled уже разрешён, isLeader истинен (одиночная сессия)", async () => {
  await leader.whenSettled();
  assert.equal(leader.isLeader(), true);
});
