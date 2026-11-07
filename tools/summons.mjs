// Группа «призыв существа» (черта summon): явный список заклинаний spells-srd, признак существа — по тексту описания.
// Пишет rules/summons.json: {bySource: uuid -> {traits}|{uuid}, +levels?, count?; exceptions: slug -> причина}; рантайм — scripts/rules.mjs (onUse.summon), scripts/summon-index.mjs.
// Уровень по умолчанию — таблица черты summon по рангу (SUMMON_LEVELS), из текста не разбирается; текст лишь сверяется с таблицей на базовом ранге. Запуск: node tools/summons.mjs
import { join } from "node:path";
import { ROOT, readOut, stripHtml, writeJson, isMain } from "./lib.mjs";
import { SUMMON_LEVELS } from "../scripts/summon-index.mjs";

const LESSER = { traits: ["celestial", "fiend", "monitor", "animal"], levels: { 1: -1, 2: 1, 3: 2, 4: 3 } };   // потолок 3 с 4 ранга: текст заклинания
const PHANTASM = "Compendium.pf2e.pathfinder-bestiary.Actor.j7NNPfZwD19BwSEZ";   // @UUID в тексте Призрачного приспешника

/** Вручную: документы с чертой summon, где стандартная запись не годится. */
export const EXCEPTIONS = {
  "summon-anarch": "легаси (chaotic): заменено ремастером",
  "summon-axiom": "легаси (lawful): заменено ремастером",
  "call-ursine-ally": "черта: врождённое Summon Animal с растущим списком конкретных медведей по уровню персонажа",
  "healing-servitor": "воплощение (incarnate), не приспешник",
  "irii": "воплощение (incarnate), не приспешник",
  "stampede": "воплощение (incarnate), не приспешник",
  "elemental-herald": "воплощение (incarnate), не приспешник",
  "warden-of-the-wild": "воплощение (incarnate), не приспешник",
  "ancient-fleshforged": "воплощение (incarnate), не приспешник",
  "oliphaunt": "воплощение (incarnate), не приспешник"
};
const OTHER = "способность/черта NPC или предмет с нестандартным текстом призыва: долг";

/** Чистая: заклинание -> запись onUse.summon | {skip: причина}. */
export function summonOf(it) {
  if (it.slug === "summon-lesser-servitor") return { ...LESSER };
  if (it.slug === "phantasmal-minion") {
    const u = /@UUID\[(Compendium\.pf2e\.[^\]]+\.Actor\.\w+)\]\{Phantasmal Minion\}/.exec(it.descEn ?? "")?.[1];
    return u === PHANTASM ? { uuid: u } : { skip: "uuid существа в тексте не совпал с ожидаемым" };
  }
  const text = stripHtml(it.descEn ?? "");
  const m = /summon a creature that has the (\w+)(?: or (\w+))? trait and whose level is (–|-)?(\d+)(?: or lower)?/i.exec(text);
  if (!m) return { skip: "не распознано «summon a creature that has the X trait and whose level is N»" };
  const lvl = (m[3] ? -1 : 1) * Number(m[4]);
  if (SUMMON_LEVELS[it.rank] !== lvl) return { skip: `уровень в тексте (${lvl}) не сходится с таблицей черты на ранге ${it.rank}` };
  return { traits: [m[1].toLowerCase(), ...(m[2] ? [m[2].toLowerCase()] : [])] };
}

/** Чистая: документы -> {bySource, exceptions}. Заклинания spells-srd с чертой summon — по тексту; прочие документы с чертой — в исключения. */
export function buildSummons(items) {
  const bySource = {}, exceptions = { ...EXCEPTIONS };
  const marked = new Set(items.filter((it) => it.type === "spell" && it.pack === "spells-srd" && it.traits?.includes("summon")).map((it) => it.slug));   // тёзки в бестиариях (копии заклинаний) — не исключения
  for (const it of items) {
    if (!it.traits?.includes("summon")) continue;
    const slug = it.slug;
    if (exceptions[slug] && !(it.type === "spell" && it.pack === "spells-srd")) continue;
    if (it.type !== "spell" || it.pack !== "spells-srd") { if (!marked.has(slug)) exceptions[slug] ??= OTHER; continue; }
    const r = summonOf(it);
    if (r.skip) exceptions[slug] = r.skip; else bySource[it.uuid] = r;
  }
  return { bySource, exceptions };
}

if (isMain(import.meta.url)) {
  const out = buildSummons(readOut("items.json").items);
  writeJson(join(ROOT, "rules", "summons.json"), { v: 1, ...out }, 1);
  console.log(`summons: размечено ${Object.keys(out.bySource).length}, исключений ${Object.keys(out.exceptions).length}`);
}
