// Полный прогон: build-packs (пак эффектов модуля) -> extract -> triage -> pa-port (+ rules/catalog.pa.json) -> drafts -> haiku-input -> coverage. validate и sample — по требованию.
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "./lib.mjs";

const t0 = Date.now();
for (const step of ["build-packs", "extract", "onhit", "triage", "pa-port", "drafts", "haiku-input", "coverage"]) {
  const r = spawnSync(process.execPath, [join(ROOT, "tools", `${step}.mjs`)], { stdio: "inherit" });
  if (r.status !== 0) { console.error(`run: шаг ${step} упал`); process.exit(r.status ?? 1); }
}
const g = spawnSync(process.execPath, [join(ROOT, "tools", "copy-guard-report.mjs"), "--check", "--top", "0"], { stdio: "inherit" });   // фикстуры ограждения копий NPC (plan-copy-guard.md §4)
if (g.status !== 0) { console.error("run: copy-guard-report: фикстуры нарушены"); process.exit(g.status ?? 1); }
console.log(`run: готово за ${((Date.now() - t0) / 1000).toFixed(1)} c`);
