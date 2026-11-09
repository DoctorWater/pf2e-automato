// Единообразие: урон всегда бросается кнопкой «Урон». У заклинаний и Ударов pf2e есть свои кнопки; у действий, черт (импульсы), расходников,
// снаряжения и способностей NPC урон лежит только инлайн-ссылкой @Damage в описании, часто свёрнутом. Для таких карточек использования
// добавляем кнопку «Урон» на каждую формулу; нажатие — тот же клик по ссылке (pf2e бросает урон с origin карточки, basic-damage его связывает).
// Чистый продолжительный урон не бросается, а накладывается: кнопка «Наложить продолжительный урон» — состояние на цели (по итогу спасброска).
// Формулы, которые наносит само правило модуля (шаги damage/persistent, триггеры зоны — урон опасной местности при входе), кнопки не получают, а их ссылки в
// описании гасятся (quench) — но только пока модуль и вправду наносит: режимы effect/challenge/apply (ruleFormulas).
// Место — под блоком спасбросков модуля (порядок сверху вниз: спасброски, урон); блок рисуется асинхронно, переносит chat.mjs (placeUnder).
import { MOD, L, DEGREES, callGM } from "./util.mjs";
import { modeOf } from "./settings.mjs";
import { EXTERNAL } from "./compat.mjs";
import { applyPersistent } from "./apply.mjs";
import * as saves from "./saves.mjs";

const SEL = EXTERNAL.selectors;

const USE_TYPES = new Set([undefined, "self-effect", "spell-cast"]);

/** Чистая: формула без пробелов и хвостового [тип]. */
export const normFormula = (f) => String(f ?? "").replace(/\s+/g, "").replace(/\[[^\]]*\]$/, "");

/**
 * Чистая: формулы урона, которые правило наносит само (шаг/триггер с damage.formula или persistent.formula), с учётом режимов:
 * шаги onUse.apply — пока effect не off; шаги триггеров зоны и событий (events.mjs) — только effect=auto; шаги по степеням испытания —
 * пока challenge и apply не off. Не наносится модулем — формулы в наборе нет, кнопка «Урон» остаётся.
 * Продолжительный урон добавляет ещё `p:<тип>`: в тексте его ссылка часто с другой переменной (@item.level вместо @item.rank).
 */
export function ruleDamageSteps(rule, { effect = "auto", challenge = "auto", apply = "auto", zone = "auto" } = {}) {
  const out = [];
  const walk = (v, auto) => {
    if (!v || typeof v !== "object") return;
    for (const k of ["damage", "persistent"]) if (v[k]?.formula) out.push({ formula: v[k].formula, type: v[k].damageType, persistent: k === "persistent" });
    for (const [k, x] of Object.entries(v)) {
      if (k === "apply" && Array.isArray(x) && (auto ? effect !== "auto" : effect === "off")) continue;
      if (k === "byDegree" && (challenge === "off" || apply === "off")) continue;
      if (k === "triggers" && zone === "off") continue;   // зона не ставится — урон при входе никто не наносит
      walk(x, auto || k === "triggers" || k === "onEvent");
    }
  };
  walk(rule, false);
  return out;
}

/** Набор для гашения ссылок: нормализованные формулы шагов (+ `p:<тип>` у продолжительных). */
export const ruleFormulas = (rule, modes) => new Set(ruleDamageSteps(rule, modes).flatMap((s) => [normFormula(s.formula), ...(s.persistent ? [`p:${s.type}`] : [])]));

/** Чистая: ссылку с этой формулой (data-damage-roll) наносит правило. Продолжительная того же типа — тоже (формула в тексте может отличаться). */
export function coveredByRule(damageRoll, skip) {
  const raw = String(damageRoll ?? "").trim().replace(/^\{(.*)\}$/, "$1"), f = normFormula(raw), tags = /\[([a-z,\s-]+)\]$/.exec(raw)?.[1]?.split(",").map((s) => s.trim()) ?? [];
  const types = tags.filter((t) => t !== "persistent");
  return skip.has(f) || (types.length === 1 && (tags.includes("persistent") || types[0] === "bleed") && skip.has(`p:${types[0]}`));   // [bleed] без persistent у pf2e — тоже кровотечение «по ходам» (Тёмные нити)
}

/** Режимы, от которых зависит, наносит ли правило урон сам. */
export const dealModes = () => ({ effect: modeOf("effect"), challenge: modeOf("challenge"), apply: modeOf("apply"), zone: modeOf("zone") });

/** Формулы, которые наносит модуль по карточке; правило уступило другому модулю (yielded) — ничего. */
export const dealtBy = (use) => (use?.state?.yielded ? new Set() : ruleFormulas(use?.rule, dealModes()));

/** Чистая: чистый продолжительный урон из data-formula ссылки ("{1d4[persistent,bleed]}") -> {formula, damageType}; обычный или смешанный — null. */
export function persistentOf(f, types) {
  const m = String(f ?? "").trim().replace(/^\{(.*)\}$/, "$1").match(/^(.+?)\[([a-z,-]+)\]$/);
  if (!m || /[[\]]/.test(m[1])) return null;
  const tags = m[2].split(","), damageType = tags.find((t) => t !== "persistent");
  return tags.includes("persistent") && tags.length === 2 && types.has(damageType) ? { formula: m[1].replace(/^\((.*)\)$/, "$1"), damageType } : null;
}

/** Чистая: степень (0 крит. провал … 3 крит. успех) по метке абзаца «Провал …»; names[d] — подписи степени (ru/en). Нет метки — null. */
export function degreeOfLabel(text, names) {
  const t = String(text ?? "").trim().replace(/[:.]$/, "").toLowerCase();
  const d = names.findIndex((list) => list.some((n) => n.toLowerCase() === t));
  return d >= 0 ? d : null;
}

/** Чистая: кому накладывать. list [{key, name, r?}], r — результат испытания; degrees — степени абзацев с этой формулой (null — без метки,
 *  всем); challenge — у карточки есть испытание модуля (без него итогов нет: цели выбрал нажавший). */
export function planPersistent(list, degrees, challenge) {
  const out = { apply: [], waiting: [] };
  for (const t of list) {
    if (degrees == null || !challenge) out.apply.push(t);
    else if (!t.r) out.waiting.push(t);
    else if (degrees.includes(t.r.degree)) out.apply.push(t);
  }
  return out;
}

/** Чистая: различные ссылки урона (по формуле, иначе по тексту) без нанесённых правилом; одна — без подписи формулы, несколько — с подписью.
 *  links у кнопки — все ссылки с той же формулой (одна формула в абзацах «Провал» и «Крит. провал» — одна кнопка на обе степени). */
const RECHARGE = /recharge|перезаряд/i;
export function damageButtons(links, label, skip = new Set(), persistent = () => null, persistentLabel = label) {
  const seen = new Map(), out = [];
  for (const a of links) {
    if (RECHARGE.test(a.dataset?.flavor ?? "")) continue;   // «перезарядка через 1d4 раунда» — не урон (pf2e помечает [[/r]] пустым data-damage-roll)
    const text = (a.textContent ?? "").trim(), key = a.dataset?.formula ?? text;
    if (coveredByRule(a.dataset?.damageRoll, skip)) continue;
    if (seen.has(key)) { seen.get(key).links.push(a); continue; }
    const pers = persistent(a), e = { a, links: [a], text: pers?.text ?? text, pers };
    seen.set(key, e);
    out.push(e);   // у продолжительного — «формула тип»: в ссылке бывает одно число
  }
  return out.map(({ a, links, text, pers }) => {
    const base = pers ? persistentLabel : label;
    return { a, links, pers, label: out.length > 1 && text ? `${base}: ${text}` : base };
  });
}

/** Перенести кнопки под блок спасбросков модуля (вызывает chat.mjs после вставки блока). Пока не у всех целей есть итог —
 *  урон (свой и системный у заклинания) скрыт: одна кнопка в один момент, «спасброски → урон». */
export function placeUnder(html, anchor) {
  const box = html.querySelector(".paf-damage-box");
  if (box && anchor) anchor.after(box);
  const sys = html.querySelector(SEL.spellDamage)?.closest(".spell-button");   // системная «Бросить урон» заклинания — тоже под спасброски
  if (sys && anchor) anchor.after(sys);
  // шаг спасбросков пройден (у всех целей итог) — кнопка спасброска pf2e больше не нужна; пока ждём — через неё бросают вручную / Toolbelt
  if (anchor?.dataset?.resolved === "true" && Number(anchor.dataset.rows) > 0) for (const b of html.querySelectorAll(SEL.spellSave)) b.hidden = true;
  if (anchor?.dataset?.resolved !== "false") return;
  if (box) box.hidden = true;
  for (const b of html.querySelectorAll(SEL.spellDamage)) b.hidden = true;
}

// подписи степеней: перевод pf2e и английские («Critical Failure») — описание бывает и непереведённым
const degreeNames = () => DEGREES.map((k) => [game.i18n.localize(`PF2E.Check.Result.Degree.Check.${k}`), k.replace(/([A-Z])/g, " $1")]);
const labelOf = (a) => a.closest("p, li")?.querySelector("strong, b")?.textContent ?? "";
/** Чистая: степени абзацев «As failure …» без своей ссылки урона наследуют продолжительный урон названной степени (Silk Bracelet: «Крит. провал: как провал, и …»).
 *  paras: [{degree, ref (степень, на которую ссылается, или null), link (в абзаце своя ссылка урона)}]. */
export function inheritDegrees(degrees, paras) {
  const out = new Set(degrees);
  for (let more = true; more;) {
    more = false;
    for (const p of paras) if (p.ref != null && !p.link && out.has(p.ref) && !out.has(p.degree)) { out.add(p.degree); more = true; }
  }
  return [...out];
}
const REF = /^\W*as (critical success|success|failure|critical failure)\b/i;
/** Степени абзацев ссылок (с наследованием «As …»); хоть одна ссылка без метки степени — null (накладывать всем). */
function degreesOf(links) {
  const names = degreeNames(), ds = links.map((l) => degreeOfLabel(labelOf(l), names));
  if (ds.includes(null)) return null;
  const root = links[0]?.closest(".chat-card, .message-content") ?? links[0]?.ownerDocument;
  const paras = [...(root?.querySelectorAll?.("p, li") ?? [])].flatMap((p) => {
    const lab = p.querySelector("strong, b")?.textContent ?? "", degree = degreeOfLabel(lab, names), m = REF.exec(p.textContent.trim().slice(lab.length));
    return degree == null ? [] : [{ degree, ref: m ? degreeOfLabel(m[1], names) : null, link: !!p.querySelector(SEL.damageRoll) }];
  });
  return inheritDegrees([...new Set(ds)], paras);
}

/** У активного ГМа: наложить продолжительный урон целям карточки (по итогу испытания, если абзац помечен степенью). */
// ponytail: «вы получаете» (урон себе) не отличаем — накладываем целям карточки; ГМ снимет вручную
export async function applyInline(messageId, spec, degrees, tokenUuids = []) {
  const msg = game.messages.get(messageId);
  if (!msg) throw new Error(`нет сообщения ${messageId}`);
  const use = msg.flags?.[MOD]?.use, results = use?.state?.challenge?.results ?? {};
  const challenge = !!use?.rule?.onUse?.challenge;
  // цели: испытания модуля; иначе снимка карточки; иначе нажавшего
  let list = challenge ? (await saves.challengeTargets(msg)).map((t) => ({ key: t.key, token: t.token, name: t.token?.name, r: results[t.key] })) : [];
  if (!list.length) {
    const uuids = (use?.targets ?? []).filter((t) => !t.far).map((t) => t.uuid).filter(Boolean);
    list = (uuids.length ? uuids : tokenUuids).map((u) => fromUuidSync(u)).filter(Boolean).map((d) => ({ key: d.id, token: d, name: d.name }));
  }
  const plan = planPersistent(list, degrees, challenge);
  const applied = [];
  for (const t of plan.apply) {
    const actor = t.token?.actor;
    if (!actor) continue;
    const r = await applyPersistent(actor, spec, { key: `${messageId}:${t.key}:pers:${spec.formula}:${spec.damageType}` });   // ключ — повторное нажатие не дублирует
    if (r.op === "created") applied.push(t.name);
  }
  return { applied, waiting: plan.waiting.map((t) => t.name) };
}

async function onPersistent(message, pers, degrees) {
  const tokens = [...(game.user.targets ?? [])].map((t) => t.document.uuid);   // запасные цели — нажавшего
  const res = await callGM("applyInlinePersistent", message.id, pers, degrees, tokens);
  if (!res?.ok) return;
  const { applied, waiting } = res.result;
  if (waiting.length) ui.notifications.warn(L("chat.persistent.waiting", { names: waiting.join(", ") }));
  if (applied.length) ui.notifications.info(L("chat.persistent.done", { names: applied.join(", ") }));
  else if (!waiting.length) ui.notifications.warn(L("chat.persistent.none"));
}

/** Ссылки, чей урон наносит само правило, гасим: клик дал бы второй путь к тому же урону (а в basic-damage — ложную связь с карточкой). У всех зрителей. */
function quench(html, skip) {
  for (const a of html.querySelectorAll(SEL.damageRoll)) if (coveredByRule(a.dataset.damageRoll, skip)) dim(a, L("chat.dealt"));
}
/** Ссылка гасится заглушкой; hidden — сама ссылка остаётся в DOM скрытой (кнопка «Урон» шлёт ей клик). */
function dim(a, tip, hidden = false) {
  const s = document.createElement("span");
  s.className = "inline-roll paf-dealt";
  s.innerHTML = a.innerHTML;
  s.dataset.tooltip = tip;
  s.style.cssText = "opacity:.6;cursor:help;text-decoration:line-through";
  a.replaceWith(s);
  if (hidden) { a.hidden = true; s.after(a); }
}

function bind(message, html) {
  const skip = dealtBy(message.flags?.[MOD]?.use);
  if (skip.size) quench(html, skip);
  if (!message.item || !message.actor?.isOwner || !USE_TYPES.has(message.flags?.pf2e?.context?.type)) return;
  const card = html.querySelector(".chat-card");
  placeAreaButton(html, card, message.item);
  attackOrder(message, html);
  // порядок «область → спасброски → урон», одна кнопка в один момент. Ждём области у правила «область» и у заклинания с областью
  // (не у предмета с @Template в тексте: там область бывает альтернативой одной цели), кроме заклинаний «1 to 3» (область — не при каждом сотворении).
  const use = message.flags?.[MOD]?.use, item = message.item, yielded = !!use?.state?.yielded;
  const areaRule = use?.rule?.onUse?.targets === "area" && !yielded;
  const variable = /\d\s*(?:to|or)\s*\d/i.test(item.system?.time?.value ?? "");
  const gated = areaRule || (!!html.querySelector(SEL.spellTemplate) && !variable && !yielded);
  const rolls = rollsOf(message), regionUuid = use?.state?.area?.regionUuid;
  // регион стоит сейчас — «Разместить» не нужна; удалили — кнопка возвращается (поставить заново: цели заменятся). Шаг пройден, если область
  // ставили или по карточке уже есть броски — удаление шаблона после бросков не откатывает карточку к «Разместить»
  const placedNow = areaRule ? !!(regionUuid && fromUuidSync(regionUuid)) : regionOf(message.id);
  const placedEver = areaRule ? !!regionUuid : placedNow || rolls.any > 0;
  const tpl = [...html.querySelectorAll(`${SEL.spellTemplate}, .paf-area-box`)];
  if (placedNow) for (const b of tpl) b.hidden = true;
  else if (tpl.length && !placedEver) {
    const first = html.querySelector(SEL.spellSave) ?? html.querySelector(SEL.spellDamage);
    const place = tpl[0].closest(".spell-button, .message-buttons") ?? tpl[0];
    if (first && !place.contains(first) && first.compareDocumentPosition(place) & Node.DOCUMENT_POSITION_FOLLOWING) (first.closest(".spell-button") ?? first).before(place);
    if (gated) {
      for (const b of html.querySelectorAll(`${SEL.spellDamage}, ${SEL.spellSave}`)) b.hidden = true;
      for (const a of card?.querySelectorAll(SEL.damageRoll) ?? []) if (!RECHARGE.test(a.dataset?.flavor ?? "")) dim(a, L("chat.afterArea"));   // урон — после области, ссылка не обходит порядок
      return;
    }
  }
  // урон заклинания брошен — шаг пройден; кроме повторных бросков с той же карточки (поддерживаемые, атаки по нескольким целям)
  if (item.type === "spell" && spellDamageDone({ damages: rolls.damages.length, sustained: !!item.system?.duration?.sustained, multiAttack: !!html.querySelector(ATTACK_SEL) && multiTarget(item.system?.target?.value) }))
    for (const b of html.querySelectorAll(SEL.spellDamage)) b.hidden = true;
  if (html.querySelector(`.paf-damage-box, ${SEL.anyDamageButton}`)) return;   // своя кнопка урона у системы (заклинание) — не дублируем
  const types = new Set(Object.keys(CONFIG.PF2E?.damageTypes ?? {}));
  const typeName = (t) => game.i18n.localize(CONFIG.PF2E.damageTypes[t] ?? t).toLocaleLowerCase();
  const pers = modeOf("apply") === "off" ? () => null : (a) => { const p = persistentOf(a.dataset?.formula, types); return p && { ...p, text: `${p.formula} ${typeName(p.damageType)}` }; };   // apply off — модуль не накладывает: обычный бросок pf2e
  const all = damageButtons([...(card?.querySelectorAll(SEL.damageRoll) ?? [])], game.i18n.localize("PF2E.DamageLabel"), skip, pers, L("chat.persistent.button"));
  // брошенная формула — её шаг пройден (у не-заклинаний формулы независимы: «6d8, затем 3d8 каждый ход» — прячем только брошенную)
  const done = new Set(rolls.damages.map((m) => rolledCore(m.rolls?.[0])));
  const isDone = (x) => !x.pers && done.has(coreFormula(x.a.dataset?.damageRoll || x.a.dataset?.formula));
  // одна кнопка — один путь: ссылки с кнопкой гасим (клик по ссылке дал бы второй бросок / ложную связь с карточкой).
  // html ещё не в документе (renderChatMessageHTML) — проверка по html, не isConnected
  for (const x of all) for (const a of x.links) if (html.contains(a)) dim(a, L(isDone(x) ? "chat.damageRolled" : "chat.byButton"), true);
  const list = all.filter((x) => !isDone(x));
  if (!list.length) return;
  const box = document.createElement("div");
  box.className = "message-buttons paf-damage-box";
  for (const { a, links, pers: p, label } of list) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.addEventListener("click", (ev) => {
      ev.preventDefault();
      if (p) return void onPersistent(message, { formula: p.formula, damageType: p.damageType }, degreesOf(links));
      const { shiftKey, ctrlKey, altKey, metaKey } = ev;
      a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, shiftKey, ctrlKey, altKey, metaKey }));
    });
    box.append(b);
  }
  const anchor = html.querySelector(".pf2e-automato details.paf-challenge");
  if (anchor) { anchor.after(box); placeUnder(html, anchor); }   // блок модуля уже вставлен (шаблон в кэше): «спасброски → урон» — здесь
  else (html.querySelector(".message-buttons") ?? card).after(box);
}

/** Кнопка «Разместить …» для области из инлайн-ссылки (@Template → a.effect-area) — у импульсов, действий, расходников; у заклинания с областью
 *  своя кнопка pf2e (spell-template) — не дублируем. Клик — тот же клик по ссылке: pf2e ставит регион с messageId и origin карточки. Ссылку гасим (один путь). */
function placeAreaButton(html, card, item) {
  // варианты pf2e с областью (Heal: только за 3 действия) — кнопку даёт система у такого варианта; у прочих (Falling Stars) область лишь в тексте
  const base = item?.original ?? item;
  if (!card || html.querySelector(`${SEL.spellTemplate}, .paf-area-box`) || Object.values(base?._source?.system?.overlays ?? {}).some((o) => o?.system?.area)) return;
  const a = card.querySelector(SEL.effectArea);
  if (!a) return;
  const box = document.createElement("div");
  box.className = "message-buttons paf-area-box";
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = game.i18n.format("PF2E.Item.Spell.MeasuredTemplate.Place", { area: a.textContent.trim() });   // подпись как у кнопки заклинания pf2e
  b.addEventListener("click", (ev) => { ev.preventDefault(); a.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true })); });
  box.append(b);
  card.after(box);   // над блоком спасбросков модуля (он дописывается в конец сообщения)
  dim(a, L("chat.byButton"), true);
}

/* ---------- заклинание с атакой: одна кнопка в один момент — атака, потом урон ---------- */

const ATTACK_SEL = "button[data-action='spell-attack'], button[data-action='spell-attack-2'], button[data-action='spell-attack-3']";
const hitOf = (m) => { const d = m.rolls?.[0]?.options?.degreeOfSuccess; const o = m.flags?.pf2e?.context?.outcome; return Number.isInteger(d) ? d >= 2 : o === "success" || o === "criticalSuccess"; };

/** Чистая: что прятать на карточке заклинания с атакой. До попадания — урона нет; после броска урона (или после атаки по единственной цели) — атак нет. */
export function attackStage({ attacks, hits, damages, multi }) {
  return { hideDamage: hits === 0, hideAttack: damages > 0 || (attacks > 0 && !multi) };
}

/** Чистая: цель заклинания допускает несколько существ («1 or 2 creatures», «up to 3», «2 существа»). */
export const multiTarget = (text) => /(\d+)\s*(?:or|или|to|до|-|–)\s*\d+/i.test(String(text ?? "")) || (String(text ?? "").match(/\d+/g) ?? []).some((n) => Number(n) > 1);

/** Броски этой карточки: после неё, тот же предмет (origin.uuid), до следующей карточки этого предмета. */
function rollsOf(message) {
  const uuid = message.flags?.pf2e?.origin?.uuid, all = game.messages.contents, i = all.findIndex((m) => m.id === message.id);
  const out = { attacks: [], damages: [], any: 0 };
  if (!uuid || i < 0) return out;
  for (const m of all.slice(i + 1)) {
    if (m.flags?.pf2e?.origin?.uuid !== uuid) continue;
    const t = m.flags?.pf2e?.context?.type;
    if (isCard(m)) break;   // следующая карточка того же предмета — дальше чужие броски
    if (t) out.any++;   // любой бросок по карточке: спасбросок, проверка, атака, урон
    if (t === "attack-roll") out.attacks.push(m);
    else if (t === "damage-roll") out.damages.push(m);
  }
  return out;
}

function attackOrder(message, html) {
  if (message.item?.type !== "spell" || !html.querySelector(ATTACK_SEL)) return;
  const { attacks, damages } = rollsOf(message);
  const st = attackStage({ attacks: attacks.length, hits: attacks.filter(hitOf).length, damages: damages.length, multi: multiTarget(message.item.system?.target?.value) });
  if (st.hideDamage) for (const b of html.querySelectorAll(SEL.spellDamage)) b.hidden = true;
  if (st.hideAttack) for (const b of html.querySelectorAll(ATTACK_SEL)) b.hidden = true;
}

/** Карточка использования предмета (не бросок): заклинание, эффект на себя, карточка действия / расходника. */
const isCard = (m) => { const t = m.flags?.pf2e?.context?.type; return t === "spell-cast" || t === "self-effect" || (!t && !!m.item); };

const coreOne = (f) => String(f ?? "").replace(/\[[^\]]*\]/g, "").replace(/[\s{}()]/g, "").toLowerCase();
/** Чистая: части формулы ссылки урона без типов и скобок, как множество («{6d8[fire],2d6[cold]}» -> «2d6|6d8»). */
export const coreFormula = (f) => String(f ?? "").trim().replace(/^\{|\}$/g, "").replace(/\[[^\]]*\]/g, "").split(",").map(coreOne).filter(Boolean).sort().join("|");
/** Чистая: то же для брошенного урона — по выражениям частей (instances[].head.expression): formula у pf2e с переведённым типом («6d8 огонь»). */
export const rolledCore = (roll) => (roll?.instances?.length ? roll.instances.map((i) => coreOne(i.head?.expression ?? i.formula)).filter(Boolean).sort().join("|") : coreFormula(roll?.formula));

/** Чистая: прятать «Урон» заклинания после броска. Не прячем, где урон с той же карточки бросают повторно: поддерживаемые заклинания
 *  (Floating Flame, Whirlwind) и атаки по нескольким целям (урон на каждую цель). */
export const spellDamageDone = ({ damages, sustained, multiAttack }) => damages > 0 && !sustained && !multiAttack;

/** Регион pf2e, размещённый с этой карточки (flags.pf2e.messageId), есть на какой-либо сцене. */
const regionOf = (id) => game.scenes.some((s) => s.regions.some((r) => r.flags?.pf2e?.messageId === id));

/** Бросок (создан или удалён) — перерисовать его карточку (кнопки меняются по ходу): последнюю карточку того же предмета не позже броска. */
function refreshCard(m) {
  const t = m.flags?.pf2e?.context?.type, uuid = m.flags?.pf2e?.origin?.uuid, at = m.timestamp ?? Infinity;
  if (!uuid || !t || isCard(m)) return;
  const card = game.messages.contents.findLast((x) => x.id !== m.id && (x.timestamp ?? 0) <= at && x.flags?.pf2e?.origin?.uuid === uuid && isCard(x));
  if (card) ui.chat?.updateMessage?.(card);
}

export function init() {
  Hooks.on("renderChatMessageHTML", bind);
  Hooks.on("createChatMessage", refreshCard);
  Hooks.on("deleteChatMessage", refreshCard);
  // регион с карточки предмета без правила «область» — перерисовать карточку (кнопки шага области)
  const regionCard = (r) => { const id = r.flags?.pf2e?.messageId, m = id && game.messages.get(id); if (m) ui.chat?.updateMessage?.(m); };
  Hooks.on("createRegion", regionCard);
  Hooks.on("deleteRegion", regionCard);
}
