// Группа «пассивка Удара срабатывает только при критическом попадании»: признак считается при сборке по английскому descEn (items.json),
// в рантайме читается оверлей rules/crit-only.json {bySource: uuid -> 1, bySlug: "slug@тип" -> 1} (rules.mjs, critOnlyEntry; strike-link.mjs).
// Почему не текст в рантайме: в мире с pf2ru описание русское, английская регулярка его не видит (по корпусу en=110, ru=63 из пассивок).
// bySlug — только если ВСЕ пассивки с этим slug и типом согласны (у массовых предметов бестиария uuid есть лишь у представителя группы одинаковых текстов).
// Записей «нет крита» нет: отсутствие записи = эффект на каждое попадание. Запуск: node tools/crit-only.mjs
import { join } from "node:path";
import { ROOT, readOut, writeJson, isMain } from "./lib.mjs";
import { sluggify } from "../scripts/util.mjs";

const CRIT_HIT = /\bcritical(?:ly)?\s+hits?\b|\bcritical success\b[^.]{0,60}\bStrike\b/i;
const HIT = /\b(?:hits?|struck|damaged)\b/i;

/** Чистая: markup-описание (английское) -> истина, если эффект только при крит. попадании. Условие запуска — фраза до спасброска/стадий, не в скобках и не «удваивается при крите».
 *  Не крит-только: «hit or critical hit», «X or if the attack was a critical hit», и если ДО предложения с критом есть предложение про обычное попадание («Hit: clumsy 3. On a critical hit, also …»). */
export function critOnly(html) {
  let t = String(html ?? "").replace(/<[^>]+>/g, " ").replace(/@\w+\[[^\]]*\](?:\{[^}]*\})?/g, " ").replace(/\([^)]*\)/g, " ");
  t = t.split(/---|\bsaving throw\b|\bmust (?:attempt|succeed)|\bsave\b/i)[0].replace(/\b(?:is |are )?doubled on a critical (?:hit|success)\b/gi, " ");
  const m = CRIT_HIT.exec(t);
  if (!m || /\bhits?\b[^.]{0,30}\bor\s+critical(?:ly)?\b/i.test(t)) return false;
  const head = t.slice(0, m.index).replace(/\s+/g, " ");
  return !/\bor\s+(?:if\s+)?[^.,;]{0,40}$/i.test(head) && !HIT.test(head.replace(/[^.]*$/, ""));   // второе: целые предложения до того, где крит
}

/** Чистая: документы -> {bySource, bySlug, report}. Только пассивные action/feat. */
export function buildCritOnly(items) {
  const bySource = {}, groups = new Map();
  for (const it of items) {
    if (!["action", "feat"].includes(it.type) || it.actionType !== "passive") continue;
    const crit = critOnly(it.descEn), key = `${it.slug || sluggify(it.name)}@${it.type}`;
    (groups.get(key) ?? groups.set(key, []).get(key)).push(crit);
    if (crit && it.uuid) bySource[it.uuid] = 1;
  }
  const bySlug = {};
  for (const [k, v] of groups) if (v.every(Boolean)) bySlug[k] = 1;
  return { bySource, bySlug };
}

if (isMain(import.meta.url)) {
  const out = buildCritOnly(readOut("items.json").items);
  writeJson(join(ROOT, "rules", "crit-only.json"), { v: 1, ...out }, 1);
  console.log(`crit-only: bySource ${Object.keys(out.bySource).length}, bySlug ${Object.keys(out.bySlug).length}`);
}
