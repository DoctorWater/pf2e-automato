// Мгновенные области карточек модуля: шаблон (регион) убирает сам модуль, когда по области всё разрешено. Ни pf2e, ни Workbench этого не делают;
// окно Template Helper Toolbelt («Remove Template») у области, которую ведёт модуль, не показывается (skip на регионе, use.mjs).
// Зоны с длительностью (onUse.zone), Поддержание/импульс и области с длительностью предмета — не здесь: их ведёт zone.mjs.
// Момент удаления: все цели с результатом -> применение по степеням -> урон по итогам спасброска нанесён (link.done по всем целям).
// Запасные: конец хода автора (pf2e.endTurn), вне боя — таймаут AREA_TTL_MS (setTimeout после создания и разбор на ready), удаление карточки.
// Откат урона/удаление карточки после удаления региона его не возвращают; удалённый кем-то раньше (Toolbelt, ГМ) — тихо пропускается.
import { MOD, DEGREES, isActiveGM, queue, debug, flagPath } from "./util.mjs";
import { modeOf } from "./settings.mjs";

export const AREA_TTL_MS = 10 * 60000;

/** Срок у предмета: «sustained» либо непустое значение, кроме 0/instantaneous. Нет предмета/срока — мгновенная. */
export const hasDuration = (d) => {
  const v = String(d?.value ?? "").trim();
  return !!d?.sustained || (!!v && !/^(?:0|instantaneous)$/i.test(v));
};

const targetSteps = (use) => (use?.kind === "use" ? (use.rule?.onUse?.apply ?? []).filter((s) => s.to === "target") : []);

/** Область ведёт модуль (runRegion берёт цели области): испытание/проверка при режиме challenge != off либо шаги на цель при effect != off. */
export function managesArea(use, get = modeOf) {
  const u = use?.rule?.onUse;
  if (!u || use.state?.yielded || u.targets !== "area") return false;
  return ((!!u.challenge || !!u.check) && get("challenge") !== "off") || (!!targetSteps(use).length && get("effect") !== "off");
}

/** Мгновенная область, которую ведёт модуль: без zone, pulse (Поддержание), срока у предмета. item — документ предмета или null. */
export function instantArea(use, item, get = modeOf) {
  const u = use?.rule?.onUse;
  return managesArea(use, get) && !u.zone && !u.pulse && !hasDuration(item?.system?.duration);
}

/**
 * Всё по области разрешено. targets — ключи целей испытания (без иммунных/неприменимых), resolved — у всех есть результат (или иммунитет),
 * damage — "none" | "tracked" (урон ждём, его ведёт basic-damage) | "untracked" (урон есть, а нанесение не отследить — только запасные пути),
 * link — flags.<MOD>.basicDamage сообщения урона; afterApply — вызов сразу после авто-применения по степеням (mode apply=auto), afterTarget — после авто-шагов
 * на цель (mode effect=auto): они отработали, даже если ops пусты. Проверка автора (onUse.check) ждётся наравне с испытанием.
 */
export function areaSettled(use, { targets = [], resolved = true, damage = "none", link = null, afterApply = false, afterTarget = false } = {}) {
  const st = use?.state ?? {}, ch = use?.rule?.onUse?.challenge ?? use?.rule?.onUse?.check;
  if (!st.area?.keys?.length || use.confidence === "low" || st.derived?.pending?.length || !resolved || damage === "untracked") return false;
  const res = st.challenge?.results ?? {};
  const needSteps = !!ch && !afterApply;
  for (const k of targets) {
    if (ch && !res[k]) continue;   // иммунная цель (resolved уже проверил) результата не имеет
    if (needSteps && res[k] && (ch.byDegree?.[DEGREES[res[k].degree]]?.length ?? 0) && !st.challenge?.applied?.[k]) return false;
    if (!afterTarget && targetSteps(use).length && !st.apply?.[k]) return false;
    if (damage === "tracked" && res[k]) { const e = link?.done?.[k]; if (!e || e.reverted) return false; }
  }
  return damage !== "tracked" || !!link;
}

/* ---------- с документами ---------- */

const allRegions = () => game.scenes.contents.flatMap((s) => s.regions.contents);
const cardOf = (region) => game.messages.get(region.flags?.pf2e?.messageId);
const useOf = (m) => m?.flags?.[MOD]?.use;
// message.item знает и предмет без uuid в мире (свиток/палочка — embeddedSpell), как basic-damage
const itemOf = (message, use) => { try { return message?.item ?? (use?.item?.uuid ? fromUuidSync(use.item.uuid) : null); } catch { return null; } };

/** Карточка помечается state.area.closed до удаления: кнопки размещения скрыты, повторный регион runRegion не запускает (иначе урон старого броска ушёл бы новым целям). */
async function removeAll(regions) {
  const { deleteRegionOnce } = await import("./zone.mjs");
  for (const id of new Set(regions.map((r) => r.flags?.pf2e?.messageId))) {
    const m = game.messages.get(id);
    if (m && useOf(m)?.state?.area && !useOf(m).state.area.closed) await m.update({ [flagPath("use", "state", "area", "closed")]: true }).catch((e) => debug("area closed", e));
  }
  for (const r of regions) await deleteRegionOnce(r, "closed").catch((e) => debug("area delete", e));
}

/** Урон, который ждёт карточка: у правила он не свой (ruleDealsDamage), у предмета есть строки урона или испытание задаёт урон по степеням. */
async function damageKind(use, item) {
  const bd = await import("./builtin/basic-damage.mjs");
  const ch = use.rule?.onUse?.challenge;   // урон по итогам — только у испытания цели (check — бросок автора)
  if (bd.ruleDealsDamage(use.rule) || !(Object.keys(item?.system?.damage ?? {}).length || ch?.damageByDegree || ch?.basic === true)) return "none";
  return bd.degreeTable(use.rule, item) ? "tracked" : "untracked";
}

/** Проверить область карточки и убрать регионы, если всё разрешено. flow: вызов после авто-применения (auto-режим apply). */
export function settleArea(messageId, { flow = false } = {}) {
  if (!isActiveGM() || !messageId) return Promise.resolve();
  return queue(`area:${messageId}`, async () => {
    const message = game.messages.get(messageId), use = useOf(message);
    const regions = allRegions().filter((r) => r.flags?.pf2e?.messageId === messageId);
    if (!regions.length || !use) return;
    const item = itemOf(message, use);
    if (!instantArea(use, item)) return;
    const { challengeTargets, allResolved, challengeOf } = await import("./saves.mjs");
    const { modeOf: mode, effectiveMode } = await import("./settings.mjs");
    const ch = challengeOf(use);
    const targets = ch ? (await challengeTargets(message)).map((t) => t.key) : use.state?.area?.keys ?? [];
    const dmgId = use.state?.basicDamage?.msg;
    const link = dmgId ? game.messages.get(dmgId)?.flags?.[MOD]?.basicDamage ?? null : null;
    // авто-шаги отработали: вызов из потока (flow) либо уже есть итоги — runRegion и afterRecord их прошли (поздний вызов из updateChatMessage, когда урон отмечен нанесённым)
    const passed = flow || !!Object.keys(use.state?.challenge?.results ?? {}).length;
    const ok = areaSettled(use, {
      targets, resolved: ch ? await allResolved(message) : true, damage: await damageKind(use, item), link,
      afterApply: passed && effectiveMode("apply", use, mode) === "auto", afterTarget: passed && effectiveMode("effect", use, mode) === "auto"
    });
    if (ok) await removeAll(regions);
  });
}

/** Мгновенные области модуля, которые модуль мог довести сам. low и ожидающие derived — кнопки «Применить»/«Дозапустить» ещё нужны, область не трогаем. */
function eligible() {
  const out = [];
  for (const region of allRegions()) {
    const message = cardOf(region), use = useOf(message);
    if (use && use.confidence !== "low" && !use.state?.derived?.pending?.length && instantArea(use, itemOf(message, use))) out.push({ region, message, use });
  }
  return out;
}

/** Запасной путь: убрать мгновенные области карточек, которым пора (match(region, message, use) — условие). */
async function expire(match) {
  await removeAll(eligible().filter((x) => match(x.region, x.message, x.use)).map((x) => x.region));
}

const inFight = (use) => {
  const a = use.actor ? fromUuidSync(use.actor) : null;
  return !!a && game.combats.some((c) => c.started && c.combatants.some((x) => x.actor?.uuid === a.uuid));
};
const old = (message) => Date.now() - (message.timestamp ?? Date.now()) >= AREA_TTL_MS;

let timer = null;
/** Один таймер на самую молодую оставшуюся область: к его сроку остальные тоже просрочены (после перезагрузки таймеров нет — ставится при ready). */
function rearm() {
  clearTimeout(timer); timer = null;
  const left = eligible().filter((x) => !old(x.message) || inFight(x.use));
  if (!left.length) return;
  const youngest = Math.max(...left.map((x) => x.message.timestamp ?? Date.now()));
  timer = setTimeout(() => sweepAreas().catch((e) => console.error(`${MOD} | area`, e)), Math.max(1000, youngest + AREA_TTL_MS - Date.now() + 1000));
}

/** ready / смена ГМа / конец боя / таймер: регионы, чей срок вышел вне боя. */
export async function sweepAreas() {
  if (!isActiveGM()) return;
  await expire((r, m, use) => old(m) && !inFight(use));
  rearm();
}

export function init() {
  const run = (p) => p?.catch?.((e) => console.error(`${MOD} | area`, e));
  Hooks.on("updateChatMessage", (m) => {
    if (!isActiveGM()) return;
    const card = useOf(m)?.state?.area ? m.id : m.flags?.[MOD]?.basicDamage?.card;
    if (card) run(settleArea(card));
  });
  Hooks.on("pf2e.endTurn", (c) => {
    if (isActiveGM()) run(expire((r, m, use) => (use.token && use.token === c.token?.uuid) || (use.actor && use.actor === c.actor?.uuid)));
  });
  Hooks.on("deleteChatMessage", (m) => {
    const use = useOf(m);
    if (!isActiveGM() || !use?.state?.area || !instantArea(use, itemOf(m, use))) return;
    run(removeAll(allRegions().filter((r) => r.flags?.pf2e?.messageId === m.id)));
  });
  Hooks.on("createRegion", (region) => {
    if (isActiveGM() && region.flags?.pf2e?.messageId) rearm();
  });
  Hooks.on("deleteCombat", () => run(sweepAreas()));
  Hooks.on("userConnected", () => run(sweepAreas()));
}
