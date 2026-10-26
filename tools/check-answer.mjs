// Проверка файла ответа агента без записи состояния (можно запускать параллельно): node tools/check-answer.mjs <ответ.json>
import { readFileSync } from "node:fs";
import { readOut } from "./lib.mjs";
import { checkAnswer } from "./validate.mjs";

const refs = readOut("refs.json"), html = readOut("html.json"), items = new Map(readOut("items.json").items.map((i) => [i.uuid, i]));
const answers = JSON.parse(readFileSync(process.argv[2], "utf8").trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
const n = {};
for (const a of answers) {
  const c = checkAnswer(a, refs, html[a?.uuid] ?? "", { type: items.get(a?.uuid)?.type, actionType: items.get(a?.uuid)?.actionType, area: items.get(a?.uuid)?.area ?? null, persistentDmg: items.get(a?.uuid)?.persistentDmg ?? [] });
  n[c.kind] = (n[c.kind] ?? 0) + 1;
  if (c.kind === "error") console.log(`${a.uuid}\n  ${c.errors.join("\n  ")}`);
}
console.log(n);
