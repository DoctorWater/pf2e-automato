// Группа «щит прикрывает союзника»: черты и способности, дающие Блок щитом за другого (scripts/builtin/shield-ward.mjs). У pf2e этого нет в правилах, только в тексте,
// поэтому таблицу с дистанцией выводим из английского текста паков (tools/out/items.json) и пишем в scripts/builtin/ward-cover.data.mjs. Запуск: node tools/ward-cover.mjs
// Признак: «Shield Block … (adjacent ally | ally adjacent | ally within N feet)» либо «(adjacent ally | ally within N feet) … Shield Block». Скакун («your mount») связи всадник–скакун
// в данных не имеет — в долг с причиной. Слаг с документами, не подходящими под признак (общий «shield-block»), не берём.
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, readOut, stripHtml, isMain } from "./lib.mjs";
import { sluggify } from "../scripts/util.mjs";

const ALLY = String.raw`(?:any )?(?:adjacent allies|adjacent ally|ally adjacent|allies? within (\d+) feet|ally within (\d+) feet)`;
const BEFORE = new RegExp(String.raw`Shield Block[^.]{0,120}?\b${ALLY}`, "i");
const AFTER = new RegExp(String.raw`\b${ALLY}[^.]{0,160}?Shield Block`, "i");
const MOUNT = /Shield Block[^.]{0,100}\byour mount\b/i;

/** Чистая: текст -> {feet, physical} | {mount: true} | null. */
export function coverOf(text) {
  const m = BEFORE.exec(text) ?? AFTER.exec(text);
  if (m && !/also benefit/i.test(text)) {   // «также получают уменьшение урона» (Improved Reflexive Shield) — не Блок за союзника
    const window = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 120);
    return { feet: Number(m[1] ?? m[2]) || 5, physical: /physical damage/i.test(window) || undefined };
  }
  return MOUNT.test(text) ? { mount: true } : null;
}

/** Чистая: документы (feat/action) -> {cover, debt}. */
export function buildCover(items) {
  const by = new Map();
  for (const it of items) {
    if (!["feat", "action"].includes(it.type)) continue;
    const slug = it.slug || sluggify(it.name);
    if (!slug) continue;
    const g = by.get(slug) ?? by.set(slug, []).get(slug);
    g.push({ it, c: coverOf(stripHtml(it.descEn ?? "")) });
  }
  const cover = {}, debt = {};
  for (const [slug, docs] of [...by].sort((a, b) => a[0].localeCompare(b[0]))) {
    const hits = docs.filter((d) => d.c);
    if (!hits.length) continue;
    if (hits.length < docs.length) { debt[slug] = "slug-shared"; continue; }   // общий slug у несвязанных способностей (shield-block, living-shield): по slug не различить
    const c = hits[0].c;
    if (c.mount) { debt[slug] = "mount-link"; continue; }
    const stance = docs.some((d) => d.it.selfEffect && (d.it.traits ?? []).includes("stance"));   // эффект стойки pf2e: slug «stance-<slug>»
    cover[slug] = { feet: Math.max(...hits.map((d) => d.c.feet ?? 5)), ...(c.physical && { physical: true }), ...(stance && { stance: `stance-${slug}` }) };
  }
  return { cover, debt };
}

if (isMain(import.meta.url)) {
  const { cover, debt } = buildCover(readOut("items.json").items);
  const out = `// Сгенерировано tools/ward-cover.mjs по тексту паков pf2e — не править руками.\n// debt: черты, которые модуль не ведёт (причина) — Блок щитом за скакуна: в данных нет связи всадник–скакун.\nexport const COVER = ${JSON.stringify(cover, null, 2)};\nexport const COVER_DEBT = ${JSON.stringify(debt, null, 2)};\n`;
  writeFileSync(join(ROOT, "scripts", "builtin", "ward-cover.data.mjs"), out);
  console.log(`ward-cover: ${Object.keys(cover).length} черт, долг ${Object.keys(debt).length}`, Object.keys(cover).join(", "), JSON.stringify(debt));
}
