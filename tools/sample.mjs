// Случайная выборка N правил пачки (ROADMAP §10) с фиксированным сидом -> файл для Критика: правило + свойства предмета + descEn + descRu.
// Запуск: node tools/sample.mjs <batch> [--source markup|model|pa-port|all] [--n 50] [--seed 1] [--with immunity] [--subpack 0.5b|0.5d|0.5f|0.5g1|0.5g2|0.5g3]
// --with <поле>: в пул только правила, у чьего challenge/check есть это поле (выборка по примитиву подпачки, напр. immunity для 0.5c)
// Отдельная выборка по источнику нужна, чтобы считать долю ошибок Haiku (model) отдельно от разметки (markup) и переноса PA.
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ROOT, ACCEPTED, readJson, readOut, writeText, outPath, arg, cmp, isMain } from "./lib.mjs";

/** mulberry32: детерминированный ГСЧ по целому сиду. */
export function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** n элементов без повторов; порядок входа не влияет на выбор (сортируем по uuid), результат стабилен по сиду. */
export function pick(list, n, seed) {
  const a = [...list].sort((x, y) => cmp(x.uuid, y.uuid)), r = rng(seed);
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a.slice(0, Math.min(n, a.length));
}

/** Источник правила черновика: markup (deriveFromMarkup), model (ответ Haiku/Sonnet, в т.ч. model-null), pa-port (перенос PA). */
export const sourceOf = (d) => (d.confidence === "model" || d.reason?.startsWith("model-null") ? "model" : d.status === "pa-port" ? "pa-port" : d.status?.startsWith("markup") ? "markup" : null);

/** В пул выборки идут правила и model-null (проверка «модель зря сказала: нечего автоматизировать»). */
export const poolOf = (items, source = "all") => items.filter((d) => (d.rule || d.reason?.startsWith("model-null")) && sourceOf(d) && (source === "all" || sourceOf(d) === source));

const props = (it) => [it.defense && `save ${it.defense.save}${it.defense.basic ? " (basic)" : ""}`, it.range && `range ${it.range}`, it.duration && `duration ${it.duration}`, it.area && `area ${it.area}`, it.target && `target ${it.target}`, it.cost && `cost ${it.cost}`, it.frequency && `freq ${it.frequency}`].filter(Boolean).join(" | ") || "—";

export function sampleMd(batch, source, seed, picked, itemBy) {
  const head = `# Sample ${batch} [${source}]: ${picked.length} rules, seed ${seed}\nFor each: does the rule match the item text (who, which degree, what, DC, duration, range)? Verdict: ok / wrong (why). For model-null: was there really nothing to automate?\n`;
  return head + picked.map((d, i) => {
    const it = itemBy.get(d.uuid) ?? {};
    return `\n## ${i + 1}. ${d.name}${d.nameRu ? ` / ${d.nameRu}` : ""}  [${sourceOf(d)}: ${d.status}, ${d.confidence}]\n${d.uuid}\nPROPS: ${props(it)}\n\nRULE:\n\`\`\`json\n${d.rule ? JSON.stringify(d.rule) : "null  // " + d.reason}\n\`\`\`\nEN: ${it.descEn ?? ""}\n\nRU: ${it.descRu ?? "(no translation)"}\n`;
  }).join("");
}

/** --subpack 0.5d: правила, полученные через эффекты PA (наш пак, эквивалент pf2e, шаги condition из GrantItem). --subpack 0.5b: правила, поднятые признаками остатка 0.5b (снятые ограничения translateItem, СЛ из разметки копии, ключ slug@type, ручной вердикт). */
/** --subpack 0.5f: правила с примитивами 0.5f — шаг removeCondition, effect.badge, шаг rank, проверка без vs. */
export const usesPrimitive05f = (rule) => {
  const u = rule?.onUse;
  if (!u) return false;
  const steps = [...(u.apply ?? []), ...Object.values(u.challenge?.byDegree ?? {}).flat(), ...Object.values(u.check?.byDegree ?? {}).flat()];
  return !!u.check && !u.check.vs || steps.some((a) => a.removeCondition || a.effect?.badge || a.rank);
};
/** --subpack 0.5g2: правила с примитивами 0.5g2 — условие шага when, removeEffect, extendEffect, rollOption, effect.badge:"decrement", получатели party/allies. */
export const usesPrimitive05g2 = (rule) => {
  const u = rule?.onUse;
  if (!u) return false;
  const steps = [...(u.apply ?? []), ...Object.values(u.challenge?.byDegree ?? {}).flat(), ...Object.values(u.check?.byDegree ?? {}).flat()];
  return steps.some((a) => a.when || a.removeEffect || a.extendEffect || a.rollOption || a.effect?.badge === "decrement" || a.to === "party" || a.to === "allies");
};
/** --subpack 0.5g3: правила с примитивом onEvent (правило срабатывает по событию: бросок, урон, ход, эффект). */
export const usesPrimitive05g3 = (rule) => !!rule?.onEvent?.length;
/** --subpack 0.5g1: правила, поднятые скриптом 0.5g1 (карточка пассивки, self спасброска -> получатель) и ручные вердикты этой пачки (lifted: verdict-0.5g1). */
const G1 = ["passive-postinfo", "save-self-target", "verdict-0.5g1"];
/** --subpack 0.5g4: правила с примитивами 0.5g4 — шаги choose / to:"chosen" / damage, condition.policy:"reduce", duration у шага effect (в т.ч. кубик) и у состояния-кубика, запись onEvent с side:"origin" или испытанием на side:"target". */
export const usesPrimitive05g4 = (rule) => {
  const u = rule?.onUse, bd = (c) => Object.values(c?.byDegree ?? {}).flat();
  const steps = [...(u?.apply ?? []), ...bd(u?.challenge), ...bd(u?.check), ...(rule?.onEvent ?? []).flatMap((e) => [...(e.apply ?? []), ...bd(e.challenge)])];
  return steps.some((a) => a.choose || a.to === "chosen" || a.damage || a.condition?.policy === "reduce" || (a.effect && a.duration) || typeof a.duration?.value === "string") || !!rule?.onEvent?.some((e) => e.side === "origin" || (e.side === "target" && e.challenge));
};
export const inSubpack = (d, sub) => sub === "0.5g4" ? usesPrimitive05g4(d.rule) : sub === "0.5g1" ? !!d.lifted?.some((l) => G1.includes(l)) : sub === "0.5g3" ? usesPrimitive05g3(d.rule) : sub === "0.5g2" ? usesPrimitive05g2(d.rule) : sub === "0.5f" ? usesPrimitive05f(d.rule) : sub === "0.5d" ? !!d.paEffects?.length : sub !== "0.5b" || !!(d.lifted?.some((l) => !G1.includes(l)) || d.confidence === "manual" || /@/.test(d.catSlug ?? "") || d.rule?.onUse?.challenge?.dc?.expr === "markup");

function main() {
  const batch = process.argv[2];
  if (!batch || batch.startsWith("--")) throw new Error("usage: node tools/sample.mjs <batch> [--source markup|model|pa-port|all] [--n 50] [--seed 1] [--with <поле>] [--subpack 0.5b|0.5d|0.5f|0.5g1|0.5g2|0.5g3|0.5g4]");
  const n = +arg("n", 50), seed = +arg("seed", 1), source = arg("source", batch === "pa-port" ? "pa-port" : "all");
  // pa-port: только правила, попавшие в rules/catalog.pa.json впервые (tools/pa-port.mjs пишет их в out/pa-catalog.json; база сравнения — `--since <rev>` у pa-port.mjs, по умолчанию HEAD)
  const drafts = batch === "pa-port" ? readOut("pa-catalog.json") : readJson(join(ROOT, "rules/drafts", `${batch}.json`));
  const itemBy = new Map(readOut("items.json").items.map((i) => [i.uuid, i]));
  const only = arg("with", null), sub = arg("subpack", null);
  if (sub && !["0.5b", "0.5d", "0.5f", "0.5g1", "0.5g2", "0.5g3", "0.5g4"].includes(sub)) throw new Error(`unknown --subpack ${sub}: 0.5b|0.5d|0.5f|0.5g1|0.5g2|0.5g3|0.5g4`);
  const tag = (only ? `+${only}` : "") + (sub ? `@${sub}` : "");
  const pool = poolOf(drafts.items, source).filter((d) => (!only || (d.rule?.onUse?.challenge ?? d.rule?.onUse?.check)?.[only] != null) && (!sub || inSubpack(d, sub)));
  const picked = pick(pool, n, seed);
  // правила с проверкой/испытанием редки — берём все сверх случайных n (не при --with: там все такие)
  if (batch === "pa-port" && !only && !sub) for (const d of pool) if ((d.rule.onUse?.check || d.rule.onUse?.challenge) && !picked.includes(d)) picked.push(d);
  writeText(outPath("sample", `${batch}-${source}${tag}-seed${seed}.md`), sampleMd(batch, source, seed, picked, itemBy));
  // сид хранится отдельно от черновиков (drafts.mjs их перегенерирует): rules/drafts-accepted/_samples.json; ключ с сидом, иначе история сидов затирается
  const sp = join(ACCEPTED, "_samples.json");
  const all = existsSync(sp) ? readJson(sp) : {};
  all[`${batch}:${source}${tag}:seed${seed}`] = { seed, n: picked.length, pool: pool.length };
  writeText(sp, JSON.stringify(all, null, 1) + "\n");
  console.log(`sample ${batch} [${source}${tag}]: ${picked.length} из ${pool.length}, seed ${seed}`);
}

if (isMain(import.meta.url)) main();
