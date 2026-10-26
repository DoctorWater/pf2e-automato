// strike-gate: «Make a Strike. If it hits, the target must attempt a save» — испытание привязано к исходу Удара (onEvent.afterUse, plan.md §1.1b).
// Модель пишет обычный onUse.challenge; здесь он переезжает в запись onEvent на бросок атаки сразу после карточки предмета.
// Запуск по принятым черновикам: node tools/strike-gate.mjs [--write]   (без --write — только список; ничего не пишет)
import { join } from "node:path";
import { readdirSync } from "node:fs";
import { ACCEPTED, serializeDrafts, readJson, readOut, writeText, isMain } from "./lib.mjs";
import { strikeGate, validateRule } from "../scripts/rules.mjs";

// «Strike» отличает от остальных бросков атаки опция броска (есть и у NPC, и у персонажа): pf2e.mjs:20349, 35808
export const STRIKE_OPTION = "self:action:slug:strike";
const CRIT = /critical(?:ly)?\s+(?:success\s+on\s+your\s+attack|hits?\b|succe)|on\s+a\s+critical\s+hit/i;
const plain = (html) => String(html ?? "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ");

/** Исход Удара, при котором испытание: предложение с испытанием говорит о критическом попадании — только крит, иначе попадание (успех или крит). */
export function strikeWhen(html) {
  const save = plain(html).split(/(?<=[.!?])\s+/).find((s) => /@Check|saving throw|\bsave\b/i.test(s)) ?? "";
  return [STRIKE_OPTION, ...(CRIT.test(save) ? ["outcome:criticalSuccess"] : [{ or: ["outcome:success", "outcome:criticalSuccess"] }])];
}

const TYPES = new Set(["feat", "action"]);   // боеприпасы и бомбы («when damaged by») — отдельная подпачка, здесь не переводим
// несколько Ударов за использование («все пять попали», both/all Strikes, Flurry): одной связью «карточка -> первый Удар» не выразить — долг multi-strike
const MULTI = /\b(?:all|both|every|each)\b[^.]{0,30}\bStrikes\b|\b(?:two|three|four|five|six)\b[^.]{0,20}\b(?:Strikes|attacks)\b|\bStrike\b[^.]{0,80}\bthen\b[^.]{0,80}\bStrike\b|\bStrike\s+twice\b|\bFlurry\b/i;
// «counts as two attacks for your multiple attack penalty» — один Удар, а не два
const ONE_STRIKE = /\bcounts?\s+as\s+(?:two|three|four|five|six)\s+attacks?\b[^.]{0,60}\battack\s+penalty/gi;
export const multiStrike = (html) => MULTI.test(plain(html).replace(ONE_STRIKE, " "));
const ACTIVE = { condition: 1, effect: 1, damage: 1, removeCondition: 1, removeEffect: 1, extendEffect: 1, rollOption: 1, persistent: 1, visibility: 1, choose: 1 };
const isNote = (s) => !!s.note && !Object.keys(ACTIVE).some((k) => s[k]);

/** kind: тип предмета строкой или { type, actionType }. Карточка есть только у feat/action, не passive: у пассива и оружия afterUse был бы мёртвым. */
export const hasCard = (kind) => { const k = typeof kind === "string" ? { type: kind } : kind ?? {}; return TYPES.has(k.type) && k.actionType !== "passive"; };

/**
 * Правило с onUse.challenge на тексте strike-gate -> то же правило, но испытание — запись onEvent {attack-roll, afterUse}.
 * Заметки onUse.apply (предпосылки: «урон этим оружием за минуту», «вы спрятаны») и шаги к цели переезжают в apply записи: заметки ГМ видит вместе с испытанием, шаги ложатся только при попадании.
 * -> { rule, changed }. Нет карточки (пассив, оружие, боеприпас), нет испытания, текст не strike-gate или несколько Ударов — правило как есть.
 */
export function gateToEvent(rule, html, kind) {
  const c = rule?.onUse?.challenge;
  if (!c || !hasCard(kind) || !strikeGate(html) || multiStrike(html)) return { rule, changed: false };
  const out = structuredClone(rule), u = out.onUse;
  u.challenge = null;
  // шаги к цели («2d8 кровотечения») при использовании легли бы и на промахе: они переезжают вместе с испытанием (events.mjs: splitSteps.theirs)
  const moved = (s) => isNote(s) || s.to === "target";
  const notes = (u.apply ?? []).filter(moved);
  u.apply = (u.apply ?? []).filter((s) => !moved(s));
  if (!(u.check || u.zone || u.apply.length)) out.onUse = null;
  out.onEvent = [...(out.onEvent ?? []), { on: "attack-roll", side: "self", afterUse: true, when: strikeWhen(html), ...(notes.length && { apply: notes }), challenge: c }];
  const v = validateRule(out);
  return v.ok ? { rule: v.rule, changed: true } : { rule, changed: false };
}

function main() {
  const write = process.argv.includes("--write"), html = readOut("html.json"), meta = new Map(readOut("items.json").items.map((i) => [i.uuid, i]));
  let n = 0, skipped = 0;
  for (const f of readdirSync(ACCEPTED).filter((x) => x.endsWith(".json"))) {
    const p = join(ACCEPTED, f), data = readJson(p);
    if (!Array.isArray(data.items)) continue;
    let touched = false;
    const items = data.items.map((d) => {
      if (!/strike-gate/.test(d.reason ?? "") || !d.rule) return d;
      const r = gateToEvent(d.rule, html[d.uuid] ?? "", { type: d.type, actionType: meta.get(d.uuid)?.actionType });
      if (!r.changed) { skipped++; console.log(`пропущено ${f} ${d.name}`); return d; }
      n++; touched = true;
      console.log(`${write ? "переведено" : "будет переведено"} ${f} ${d.name}: ${JSON.stringify(r.rule.onEvent[0].when)}`);
      // «missing: strike-gate, <ещё что-то>» — недостающее другое остаётся долгом: статус не меняем
      return /^needs-primitive: strike-gate/.test(d.reason) ? { ...d, confidence: "model", reason: d.reason.replace(/^needs-primitive: strike-gate;?\s*/, "model: strike-gate; "), rule: r.rule } : { ...d, rule: r.rule };
    });
    if (write && touched) writeText(p, serializeDrafts(data.meta, items));
  }
  console.log(`${n} ${write ? "переведено" : "к переводу"}, ${skipped} пропущено`);
}
if (isMain(import.meta.url)) main();
