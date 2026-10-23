// Полный прогон: extract -> triage -> pa-port (+ rules/catalog.pa.json) -> drafts -> haiku-input -> coverage. validate и sample — по требованию.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const t0 = Date.now();
for (const step of ["extract", "triage", "pa-port", "drafts", "haiku-input", "coverage"]) {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", `${step}.mjs`)], { stdio: "inherit" });
  if (r.status !== 0) { console.error(`run: шаг ${step} упал`); process.exit(r.status ?? 1); }
}
console.log(`run: готово за ${((Date.now() - t0) / 1000).toFixed(1)} c`);
