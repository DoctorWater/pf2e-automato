import test from "node:test";
import assert from "node:assert/strict";
import { hintsView, hintList } from "../scripts/hints.mjs";

test("hintsView: разбор «степень:slug», мусор отбрасывается", () => {
  const v = hintsView({ possible: ["failure:blinded", "bad", "x:y"], excluded: ["success:hidden"] }, { condLabel: (s) => s.toUpperCase(), degLabel: (d) => d[0] });
  assert.deepEqual(v.possible.map((x) => x.label), ["BLINDED"]);
  assert.equal(hintList(v.excluded), "HIDDEN (s)");
  assert.equal(v.isEmpty, false);
  assert.equal(hintsView(undefined).isEmpty, true);
});
