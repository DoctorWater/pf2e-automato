// Разовый импорт пака эффектов pf2e-automations (PA, MIT, см. NOTICE) -> packs/_source/effects/*.json + tools/pa-effects.json (карта «эффект PA -> что с ним делать»).
// Нужны установленные PA и Foundry (classic-level, tools/packs.mjs). Повторный запуск воспроизводит источники; руками правятся только таблицы EQUIV и ACTIVITY ниже.
// Виды: conditions — только GrantItem состояний (-> шаги condition, пака нет), pf2e — эквивалент в pf2e 8.6.1, own — копия в наш пак,
// script — ни правил, ни описания: пустая метка, работает только через JS PA (обработчик 0.5e/0.5g), в паке не живёт; immunity — иммунитеты PA (0.5c, challenge.immunity), marker — иконки активностей исследования (не переносим по решению пользователя),
// Эффекты временного снаряжения (0.5g5) — own с флагом gear, предметы лежат во втором паке (packs/_source/equipment). Всё прочее — own, целиком, чтобы связи между эффектами и обращения кода PA по slug работали.
import { cpSync, rmSync, mkdirSync, writeFileSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DATA, ROOT, readJson, writeJson, isMain, cmp } from "./lib.mjs";
import { classicLevel, openPacks } from "./packs.mjs";
import { sluggify } from "../scripts/util.mjs";
import { AUTHORED, AUTHORED_EQUIPMENT, authoredDoc, authoredEquipmentDoc, authoredMapEntry } from "./pa-effects.authored.mjs";

export const SRC_DIR = join(ROOT, "packs", "_source", "effects");
export const MAP_FILE = join(ROOT, "tools", "pa-effects.json");
const PA_DIR = join(DATA, "modules/pf2e-automations");

// Сверено по правилам, а не по имени: Resistance all-damage `max(@item.level -1,0)` и Aura с тем же эффектом, радиус 15, союзники
const EQUIV = {
  FJAGbFPO8SZHx0TQ: "Compendium.pf2e.spell-effects.Item.3bcUiWwc5KLc4X0T",   // Aura: Protector's Sphere
  IDhtOTQmmc8zSNki: "Compendium.pf2e.spell-effects.Item.XXtz5BDNNBmP9ub2"    // Effect: Protector's Sphere
};
const EQ_LINK = /Compendium\.pf2e-automations\.equipment\.Item\.(\w+)/g;
const PA_LINK = /Compendium\.pf2e-automations\.effects\.Item\.(\w+)/g;
const PF2E_REF = /Compendium\.pf2e\.[\w-]+\.Item\.\w+/g;
const effKey = (n) => n.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const COND_ID = /conditionitems\.(?:Item\.)?(\w+)$/;
const UNITS = ["rounds", "minutes", "hours", "days"];

// every() истинно и для пустого списка правил: эффект без правил, описание которого — одна ссылка на действие, тоже иконка
const isMarker = (e) => e.system.rules.every((r) => r.key === "TokenEffectIcon") && /^<p>@UUID\[Compendium\.pf2e\.actionspf2e\.Item\.\w+\](?:\{[^}]*\})?<\/p>$/.test(e.system.description.value.trim());

/** GrantItem-эффект из одних состояний с числовым значком -> {steps, duration} | null. */
function conditionsOf(e, condSlug) {
  const rs = e.system.rules;
  if (!rs.length || !rs.every((r) => r.key === "GrantItem" && COND_ID.test(r.uuid ?? "") && (r.alterations ?? []).every((a) => a.property === "badge-value" && Number.isInteger(a.value)))) return null;
  const steps = rs.map((r) => {
    const slug = condSlug[COND_ID.exec(r.uuid)[1]], v = r.alterations?.[0]?.value;
    return slug ? { slug, ...(v != null && { value: v }) } : null;
  });
  if (steps.includes(null)) return null;
  // cascade у нескольких GrantItem — «одно держится, пока держится другое» (Fleeing, пока Frightened): шагами condition это не выразить, эффект остаётся в паке
  if (rs.length > 1 && rs.some((r) => r.onDeleteActions?.grantee === "cascade")) return null;
  const d = e.system.duration ?? {};
  const duration = UNITS.includes(d.unit) && d.value >= 0 ? { value: d.value, unit: d.unit, expiry: ["turn-start", "turn-end"].includes(d.expiry) ? d.expiry : null } : null;
  return { steps, duration: duration && (duration.value >= 1 || duration.expiry === "turn-end") ? duration : null };
}

// Временное снаряжение от эффекта (0.5g5, scripts/builtin/gear.mjs): флаг gear на эффектах PA и пак снаряжения packs/_source/equipment.
// Тот же GrantItem с каскадным удалением даёт Blazing Armory (оружие) и Шиты-эффекты (Shield Block) без кода.
const EQ = (id) => `Compendium.pf2e-automato.equipment.Item.${id}`, EFF = (id) => `Compendium.pf2e-automato.effects.Item.${id}`;
const SHIELD_SCALE = { every: 3, hardness: 1, hp: 4 };   // «Level (+3)»: Твёрдость +1, ОЗ +4 за каждые 3 уровня
export const GEAR = {
  NT4T6gEdEQsoHItQ: { armor: EQ("TDvicwRah0zBhsYg"), upgrade: { level: 3, acBonus: 5, traits: ["bulwark"], category: "heavy" } },   // Armor in Earth
  mxIt7zfVKgLZ8AeC: { armor: EQ("9jbCQQAzUbXNGzZq"), shieldEffect: EFF("iqvdFq5V1b2HSAW4") },                   // Hardwood Armor
  wITJ6L8mcbbgoCHu: { armor: EQ("A0AP7oLqdRwOCje7"), shieldEffect: EFF("aH805tedt3A5Suuc"), shatterOnCrit: true },   // Metal Carapace: урон от критического попадания ломает панцирь
  iqvdFq5V1b2HSAW4: { shield: EQ("gkqzWcFgbib1BFne"), scale: SHIELD_SCALE, pa: "hardwood-armor" },              // Effect: Wooden Shield
  aH805tedt3A5Suuc: { shield: EQ("Yr9yCuJiAlFh3QEB"), scale: SHIELD_SCALE, pa: "metal-carapace" }                // Effect: Rusty Metal Carapace Shield
};
const CASCADE = new Set(["Rl0ztZNeVjXQDDGB", "iqvdFq5V1b2HSAW4", "aH805tedt3A5Suuc"]);   // Blazing Armory, щиты: выданное уходит с эффектом
export const gearFlags = (id) => (GEAR[id] ? { "pf2e-automato": { gear: GEAR[id] } } : {});
const MIGRATION = { version: 0.959, previous: null };   // схема документов pf2e 8.6.1 (MigrationRunner.LATEST_SCHEMA_VERSION)
// granter:"cascade" — предмет, выданный правилом, удаляется вместе с эффектом-хозяином (pf2e.mjs GrantItemRuleElement: onDeleteActions.granter). Shield Block выдаётся, только если черты нет:
// allowDuplicate:false привязал бы к эффекту уже имеющуюся черту, и каскад удалил бы её у персонажа
export const patchGear = (id, system) => (CASCADE.has(id) || GEAR[id]
  ? { ...system, _migration: MIGRATION, rules: system.rules.map((r) => (r.key === "GrantItem" ? { ...r, onDeleteActions: { granter: "cascade" }, ...(GEAR[id]?.shield && { predicate: [{ not: "feat:shield-block" }] }) } : r)) }
  : system);
// Мастерство: временная броня использует наивысшее из unarmored/light/medium/heavy, категория остаётся по тексту (MartialProficiency kind:defense, как у классовых умений pf2e)
const BEST_RANK = ["unarmored", "light", "medium", "heavy"].map((c) => `@actor.system.proficiencies.defenses.${c}.rank`).join(", ");
const proficiency = (slug) => ({ key: "MartialProficiency", kind: "defense", slug: `gear-${slug}`, label: "PF2E_AUTOMATO.builtin.gear.proficiency", definition: [`item:slug:${slug}`], value: `max(${BEST_RANK})` });
// Armor in Earth: «вы получаете эффект специализации брони» — группа plate, сопротивление рубящему как у Armor Expertise / Armor Specialist pf2e 8.6.1 (1 + potency у средней, 2 + potency у тяжёлой)
const PLATE_SPECIALIZATION = [["medium", 1], ["heavy", 2]].map(([c, n]) => ({ key: "Resistance", type: "slashing", predicate: [`armor:category:${c}`, "armor:group:plate"], value: `${n} + @armor.system.runes.potency` }));
const EQUIP_FIX = {
  TDvicwRah0zBhsYg: { rules: [proficiency("stone-armor"), ...PLATE_SPECIALIZATION] },
  "9jbCQQAzUbXNGzZq": { rules: [proficiency("hardwood-armor")] },
  A0AP7oLqdRwOCje7: { rules: [proficiency("metal-carapace")] },
  gkqzWcFgbib1BFne: { baseItem: "wooden-shield" }
};
export const EQUIP_DIR = join(ROOT, "packs", "_source", "equipment");

/** Предметы пака снаряжения PA -> packs/_source/equipment (slug Stone Armor у PA ошибочно hardwood-armor, пустой признак убран). */
async function extractEquipment() {
  rmSync(EQUIP_DIR, { recursive: true, force: true });
  mkdirSync(EQUIP_DIR, { recursive: true });
  const stats = { coreVersion: "14.366", systemId: "pf2e", systemVersion: "8.6.1", createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null };
  const docs = await readPaPack("equipment");
  for (const e of docs) {
    const system = JSON.parse(JSON.stringify(e.system).replace(EQ_LINK, "Compendium.pf2e-automato.equipment.Item.$1"));
    system.slug = sluggify(e.name);
    if (system.traits) system.traits.value = system.traits.value.filter(Boolean);
    Object.assign(system, EQUIP_FIX[e._id], { _migration: MIGRATION });
    const doc = { _id: e._id, name: e.name, type: e.type, img: e.img, system, effects: [], folder: null, sort: 0, ownership: { default: 0 }, flags: {}, _stats: stats, _key: `!items!${e._id}` };
    writeFileSync(join(EQUIP_DIR, `${sluggify(e.name)}_${e._id}.json`), JSON.stringify(doc, null, 2) + "\n");
  }
  writeAuthoredDocs();   // свои предметы лежат в том же каталоге, который выше очищен
  return docs.length;
}

async function readPaPack(name = "effects") {
  const tmp = join(tmpdir(), `pa-effects-${process.pid}`);
  rmSync(tmp, { recursive: true, force: true });
  cpSync(join(PA_DIR, "packs", name), tmp, { recursive: true });
  const db = new (classicLevel())(tmp, { keyEncoding: "utf8", valueEncoding: "utf8" });
  await db.open();
  const docs = [];
  for await (const [, v] of db.iterator({ gte: "!items!", lt: "!items!\xff" })) docs.push(JSON.parse(v));
  await db.close();
  rmSync(tmp, { recursive: true, force: true });
  return docs.sort((a, b) => cmp(a._id, b._id));
}

/** Записи карты с `module: true` (документы, написанные руками, не из PA) и их файлы: полный импорт пересобирает папку и не должен их терять. */
export function readModuleDocs() {
  const entries = Object.fromEntries(Object.entries(readJson(MAP_FILE).effects).filter(([, e]) => e.module));
  const files = {};
  for (const f of readdirSync(SRC_DIR)) if (Object.keys(entries).some((id) => f.endsWith(`_${id}.json`))) files[f] = readFileSync(join(SRC_DIR, f), "utf8");
  return { entries, files };
}

async function main() {
  const docs = await readPaPack();
  const condSlug = {}, pf2eIds = new Set(), pf2eEffects = {}, pf2eDur = {};
  for await (const { pack, docs: d } of (await openPacks()).packs()) for (const c of d) {
    pf2eIds.add(`Compendium.pf2e.${pack}.Item.${c._id}`);
    if (pack === "conditionitems") condSlug[c._id] = c.system.slug;
    else if (c.type === "effect") (pf2eDur[`Compendium.pf2e.${pack}.Item.${c._id}`] = c.system.duration, pf2eEffects[effKey(c.name)] ??= []).push(`Compendium.pf2e.${pack}.Item.${c._id}`);
  }

  const map = {};
  const durOf = (d) => (UNITS.includes(d?.unit) && d.value >= 0 ? { value: d.value, unit: d.unit } : null);
  for (const e of docs) {
    const base = { name: e.name };
    const c = conditionsOf(e, condSlug);
    if (isMarker(e)) map[e._id] = { ...base, kind: "marker" };
    else if (/immunity/i.test(e.name)) map[e._id] = { ...base, kind: "immunity" };
    else if (!e.system.rules.length && !e.system.description.value.replace(/<[^>]*>|\s/g, "")) map[e._id] = { ...base, kind: "script" };   // ни правил, ни описания: работает только через JS PA
    else if (c) map[e._id] = { ...base, kind: "conditions", ...c };
    else if (EQUIV[e._id]) map[e._id] = { ...base, kind: "pf2e", uuid: EQUIV[e._id], dur: durOf(pf2eDur[EQUIV[e._id]]) };
    else {
      // обёртка PA предлагает варианты по uuid, которых в pf2e 8.6.1 уже нет (формы заклинаний): их заменил один эффект pf2e с собственным выбором — берём его
      const dead = (JSON.stringify(e).match(PF2E_REF) ?? []).filter((u) => !pf2eIds.has(u));
      const twin = pf2eEffects[effKey(e.name)];
      if (dead.length && twin?.length !== 1) throw new Error(`эффект ${e.name} (${e._id}) ссылается на отсутствующие в pf2e ${dead.join(", ")}, а эквивалента по имени нет`);
      map[e._id] = dead.length ? { ...base, kind: "pf2e", uuid: twin[0], obsolete: true, dur: durOf(pf2eDur[twin[0]]) } : { ...base, kind: "own", dur: durOf(e.system.duration) };
    }
  }
  for (const [id, g] of Object.entries(GEAR)) if (g.armor) map[id].replace = true;   // повторное применение импульса заканчивает прежний (по тексту)
  for (const [id, a] of Object.entries(AUTHORED)) map[id] = authoredMapEntry(a);   // 0.5g4: свои эффекты с настоящими RE вместо меток PA
  const NEW = (id) => {
    const k = map[id]?.kind;
    if (k === "own") return `Compendium.pf2e-automato.effects.Item.${id}`;
    if (k === "pf2e") return map[id].uuid;
    throw new Error(`ссылка на эффект ${id} (${map[id]?.name}, ${k}): у него нет места в нашем паке`);
  };

  const kept = readModuleDocs();
  Object.assign(map, kept.entries);
  rmSync(SRC_DIR, { recursive: true, force: true });
  mkdirSync(SRC_DIR, { recursive: true });
  for (const [f, text] of Object.entries(kept.files)) writeFileSync(join(SRC_DIR, f), text);
  const stats = { coreVersion: "14.366", systemId: "pf2e", systemVersion: "8.6.1", createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null };
  for (const e of docs.filter((x) => map[x._id].kind === "own")) {
    const text = JSON.stringify(e).replace(PA_LINK, (m, id) => NEW(id)).replace(EQ_LINK, "Compendium.pf2e-automato.equipment.Item.$1").replace(/conditionitems\.(?!Item\.)(\w{16})/g, "conditionitems.Item.$1");   // старая запись ссылки без «Item»
    const doc = { _id: e._id, name: e.name, type: "effect", img: e.img, system: patchGear(e._id, JSON.parse(text).system), effects: [], folder: null, sort: 0, ownership: { default: 0 }, flags: gearFlags(e._id), _stats: stats, _key: `!items!${e._id}` };
    writeFileSync(join(SRC_DIR, `${sluggify(e.name)}_${e._id}.json`), JSON.stringify(doc, null, 2) + "\n");
  }
  writeAuthoredDocs();
  writeJson(MAP_FILE, { paVersion: readJson(join(PA_DIR, "module.json")).version, effects: map }, 1);
  const by = {};
  for (const m of Object.values(map)) by[m.kind] = (by[m.kind] ?? 0) + 1;
  console.log(`pa-effects: ${docs.length} эффектов PA`, by);
  console.log(`pa-effects: снаряжение PA — ${await extractEquipment()} предметов`);
}

/** Свои эффекты (pa-effects.authored.mjs) -> packs/_source/effects. Не трогает остальные файлы. */
export function writeAuthoredDocs() {
  mkdirSync(SRC_DIR, { recursive: true });
  mkdirSync(EQUIP_DIR, { recursive: true });
  for (const [id, a] of Object.entries(AUTHORED_EQUIPMENT)) writeFileSync(join(EQUIP_DIR, `${sluggify(a.name)}_${id}.json`), JSON.stringify(authoredEquipmentDoc(id, a), null, 2) + "\n");
  for (const [id, a] of Object.entries(AUTHORED))writeFileSync(join(SRC_DIR, `${sluggify(a.name)}_${id}.json`), JSON.stringify(authoredDoc(id, a, sluggify(a.name)), null, 2) + "\n");
}

/** `--authored`: без PA и Foundry — только свои эффекты и их записи в карте pa-effects.json. */
export function applyAuthoredOnly() {
  writeAuthoredDocs();
  const file = readJson(MAP_FILE);
  for (const [id, a] of Object.entries(AUTHORED)) file.effects[id] = authoredMapEntry(a);
  writeJson(MAP_FILE, file, 1);
  console.log(`pa-effects: свои эффекты — ${Object.keys(AUTHORED).length}`);
}

if (isMain(import.meta.url)) await (process.argv.includes("--authored") ? applyAuthoredOnly() : main());
