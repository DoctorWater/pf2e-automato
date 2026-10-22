// Исполняется ТОЛЬКО на клиенте активного ГМа. Записи на актёре сериализованы queue("actor:<uuid>").
// ВАЖНО: queue не реентерабелен — вызывающий (zone.hold и т.п.) НЕ должен сам держать queue("actor:"+uuid)
// вокруг applyCondition/applyEffect/removeByKey, иначе зависнет. Очередь "msg:<id>" apply не берёт (её держит вызывающий).
import { MOD, L, flagPath, sluggify, queue, forcedDelete, socket, ENDS_EARLY, sharedDialog } from "./util.mjs";
import { runMacros } from "./macros.mjs";
import { effectSource } from "./builtin/lib.mjs";
import { inRange } from "./range.mjs";
import { resolveFormula, isZeroFormula } from "./rules.mjs";
import { setSource, dropSource, visionActive } from "./vision.mjs";
import { escapeDC, offerEscape } from "./escape.mjs";

const metaOf = (item) => item?.flags?.[MOD]?.meta;
const notify = (key, data) => globalThis.ui?.notifications?.warn?.(L(key, data));

export function findByKey(actor, key) {
  return key ? actor.items.find((i) => metaOf(i)?.key === key) ?? null : null;
}

/** Формула дедупа эффекта (§1.4): тот же источник + тот же автор, либо совпал meta.key. byActorUuid==null — автор не важен. */
export function hasEffect(actor, uuid, byActorUuid, key = null) {
  if (key && findByKey(actor, key)) return true;
  return actor.items.some((i) => i.type === "effect" && i._stats?.compendiumSource === uuid
    && (byActorUuid == null || i.system?.context?.origin?.actor === byActorUuid));
}

const withMeta = (data, meta) => { data.flags ??= {}; data.flags[MOD] = { ...data.flags[MOD], meta }; };

/**
 * Состояние с длительностью: эффект-обёртка pf2e + GrantItem состояния (значение — алтерацией badge-value, она применяется один раз при выдаче).
 * Снимается вместе с обёрткой (cascade). Обычные состояния обёртка держит (grantee restrict — ГМ не удалит состояние, пока жива обёртка);
 * убывающие и кончающиеся досрочно (ENDS_EARLY) — detach: ГМ уменьшает/снимает их вручную, а обёртка по истечении срока снимет остаток.
 */
async function createTimed(actor, spec, meta, ctx, base) {
  const d = spec.duration, valued = !!base.system?.value?.isValued;
  // getCondition() отдаёт копию без uuid — источник в компендиуме берём из _stats/sourceId
  const uuid = base.uuid ?? base._stats?.compendiumSource ?? base.sourceId;
  const grant = { key: "GrantItem", uuid, onDeleteActions: { grantee: ENDS_EARLY.has(sluggify(spec.slug)) ? "detach" : "restrict" },
    ...(valued && { alterations: [{ mode: "override", property: "badge-value", value: spec.value ?? 1 }] }) };
  const tToken = ctx.target ?? actor.getActiveTokens(true, true)[0];
  // pf2e считает turn-start/turn-end по ходу context.origin.actor: для of:"target" автором срока делаем получателя
  const who = d.of === "target" ? { actor: actor.uuid, token: tToken?.uuid, item: ctx.originItem?.uuid }
    : { actor: ctx.originActor?.uuid, token: ctx.originToken?.uuid, item: ctx.originItem?.uuid };
  const data = effectSource({
    name: `${base.name}${valued ? ` ${spec.value ?? 1}` : ""}`, img: base.img, rules: [grant],
    duration: { value: d.value, unit: d.unit, expiry: d.expiry ?? null }, origin: who, target: { actor: actor.uuid, token: tToken?.uuid }
  });
  withMeta(data, meta);
  const [item] = await actor.createEmbeddedDocuments("Item", [data]);
  return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет к состоянию)
}

// при активном Vision видимость — только метками матрицы, без состояний на актёрах
const SIGHT_CONDITIONS = new Set(["concealed", "hidden", "undetected", "unnoticed", "observed"]);

export function applyCondition(actor, spec /* {slug,value,policy,duration?} */, meta = {}, ctx = {}) {
  if (SIGHT_CONDITIONS.has(sluggify(spec.slug)) && visionActive()) return Promise.resolve({ op: "skipped", reason: "vision" });
  return queue(`actor:${actor.uuid}`, async () => {
    if (findByKey(actor, meta.key)) return { op: "skipped" };
    const slug = sluggify(spec.slug);
    const CM = game.pf2e.ConditionManager;
    if (spec.duration) {
      const b = CM.getCondition(slug);
      if (!b) throw new Error(`applyCondition: неизвестное состояние "${spec.slug}"`);
      return createTimed(actor, spec, meta, ctx, b);
    }
    const policy = spec.policy ?? "max";
    // зона всегда создаёт свою копию (meta.key "zone:<uuid>"), остальное работает с уже существующим состоянием
    const existing = meta.source === "zone" ? null : actor.itemTypes.condition.find((c) => c.slug === slug && !c.isLocked && !c.grantedBy);   // выданное обёрткой-сроком не повышаем: истечёт вместе с чужим значением
    if (existing) {
      const cur = existing._source?.system?.value?.value ?? existing.system?.value?.value ?? null;
      if (cur === null) return { op: "skipped" };   // не valued
      const want = spec.value ?? 1;
      const next = policy === "add" ? cur + want : want;
      if (next <= cur) return { op: "skipped" };
      await CM.updateConditionValue(existing.id, actor, next);
      return { op: "raised", item: existing, prev: cur };
    }
    const base = CM.getCondition(slug);
    if (!base) throw new Error(`applyCondition: неизвестное состояние "${spec.slug}"`);
    const data = base.toObject();
    if (data.system.value?.isValued) data.system.value.value = spec.value ?? 1;
    withMeta(data, meta);
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет к состоянию)
  });
}

/** Продолжительный урон как у pf2e (applyDamage / PersistentDamageEditor): состояние persistent-damage с system.persistent; иммунитеты и сопротивления учтёт pf2e при броске. */
/** vars: {rank, level, actorLevel} — для формул с @item.rank / @item.level / @actor.level (подставляются и считаются здесь, в состояние уходит готовая формула). */
export function applyPersistent(actor, spec /* {formula,damageType,dc?} */, meta = {}, vars = {}) {
  return queue(`actor:${actor.uuid}`, async () => {
    if (findByKey(actor, meta.key)) return { op: "skipped" };
    if (!(spec.damageType in (CONFIG.PF2E?.damageTypes ?? {}))) throw new Error(`applyPersistent: неизвестный тип урона "${spec.damageType}"`);
    const base = game.pf2e.ConditionManager.getCondition("persistent-damage");
    if (!base) throw new Error("applyPersistent: нет состояния persistent-damage");
    const formula = spec.formula.includes("@") ? resolveFormula(spec.formula, vars) : spec.formula;
    if (!formula) throw new Error(`applyPersistent: формула "${spec.formula}" не считается`);
    if (isZeroFormula(formula)) { notify("apply.zeroPersistent", { name: actor.name }); return { op: "skipped", reason: "zero" }; }
    const data = foundry.utils.mergeObject(base.toObject(), { system: { persistent: { formula, damageType: spec.damageType, dc: spec.dc ?? 15 } } });
    withMeta(data, meta);
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет к типу урона)
  });
}

/**
 * Предзаполнить selection у ChoiceSet с массивом choices по предмету-источнику (так же делает pf2e-automations):
 * совпал value с UUID источника, либо предикат варианта называет slug/уровень источника (parent:origin:item:slug:X).
 * Берём только единственное совпадение; иначе pf2e сам спросит ГМа. Мутирует rules, возвращает число нерешённых ChoiceSet.
 */
export function presetChoiceSets(rules, { slug, uuids = [], level } = {}) {
  const quoted = (p, t) => JSON.stringify(p ?? []).includes(`:${t}"`);
  let unresolved = 0;
  for (const r of rules ?? []) {
    if (r?.key !== "ChoiceSet" || r.selection != null) continue;
    if (Array.isArray(r.choices)) {
      const hit = r.choices.filter((c) => uuids.includes(c.value)
        || (slug && quoted(c.predicate, `origin:item:slug:${slug}`)) || (level != null && quoted(c.predicate, `origin:item:level:${level}`)));
      if (hit.length === 1) { r.selection = hit[0].value; continue; }
    }
    if (!r.allowNoSelection) unresolved++;
  }
  return unresolved;
}


/** ctx: { originActor, originToken, originItem (документы), rollOptions?, target (TokenDocument)?, roll?: {total, degreeOfSuccess} — pf2e по нему сам выбирает вариант ChoiceSet по исходу } */
export function applyEffect(actor, spec /* {uuid} */, meta = {}, ctx = {}) {
  return queue(`actor:${actor.uuid}`, async () => {
    if (hasEffect(actor, spec.uuid, ctx.originActor?.uuid, meta.key)) return { op: "skipped" };
    const src = await fromUuid(spec.uuid);
    if (!src || src.type !== "effect") { console.warn(`${MOD} | applyEffect: ${spec.uuid} не эффект`); return { op: "skipped" }; }
    const data = src.toObject();
    delete data._id;
    data._stats = { ...data._stats, compendiumSource: spec.uuid };
    const valid = CONFIG.PF2E.Item.documentClasses.effect.validTraits;
    const rollOptions = ctx.rollOptions ?? ctx.originItem?.getOriginData?.().rollOptions ?? [];
    data.system = foundry.utils.mergeObject(data.system, {
      context: {
        origin: { actor: ctx.originActor?.uuid ?? null, token: ctx.originToken?.uuid ?? null, item: ctx.originItem?.uuid ?? null, spellcasting: null, rollOptions },
        target: { actor: actor.uuid, token: (ctx.target ?? actor.getActiveTokens(true, true)[0])?.uuid ?? null },
        roll: ctx.roll ?? null
      },
      ...(ctx.originItem && { traits: { value: (ctx.originItem.system?.traits?.value ?? []).filter((t) => t in valid) } })
    });
    // уровень эффекта = круг сотворения: формулы @item.level (твёрдость Щита, бонус Защиты, руны) растут как при перетаскивании из карточки
    if (ctx.castRank != null && data.system.level) data.system.level.value = ctx.castRank;
    // метка TokenMark: без uuid pf2e берёт цель/запрос у ГМа (pf2e.mjs TokenMarkRuleElement.preCreate) — подставляем выбранного автором врага
    if (ctx.markUuid) for (const r of data.system.rules ?? []) if (r.key === "TokenMark" && !r.uuid) r.uuid = ctx.markUuid;
    if (ctx.choice != null) { const cs = (data.system.rules ?? []).find((r) => r.key === "ChoiceSet" && r.selection == null); if (cs) cs.selection = ctx.choice; }
    if (!(await chooseChoices(actor, data, ctx.chooser))) { notify("apply.noChoice", { name: data.name }); return { op: "skipped" }; }
    withMeta(data, meta);
    const [item] = await actor.createEmbeddedDocuments("Item", [data]);
    return item ? { op: "created", item } : { op: "skipped" };   // pf2e выкинул документ (иммунитет, отмена метки)
  });
}

/** ChoiceSet без выбора (напр. оружие для Рунного оружия): варианты считает pf2e на временном предмете (без окна),
 *  выбирает автор-игрок у себя (сокет pickChoice) либо, если игрока нет (user = null), ГМ — общим окном во всех своих вкладках;
 *  selection пишется в источник — pf2e при создании берёт её без запроса. false — отказ. */
const PICK_MS = 120000;
async function chooseChoices(actor, data, user) {
  const idx = (data.system.rules ?? []).flatMap((r, i) => (r.key === "ChoiceSet" && r.selection == null ? [i] : []));
  if (!idx.length) return true;
  const temp = new CONFIG.Item.documentClass(foundry.utils.deepClone(data), { parent: actor });
  const opts = new Set([actor.getRollOptions(), temp.getRollOptions("parent")].flat());
  for (const i of idx) {
    const re = temp.prepareRuleElements({ suppressWarnings: true }).find((r) => r.sourceIndex === i);   // у временного предмета pf2e правил не готовит
    const choices = re?.inflateChoices ? await re.inflateChoices(opts, []) : [];
    if (!choices.length) continue;   // считать нечего — пусть решает pf2e как обычно
    const prompt = re.prompt ? game.i18n.localize(re.prompt) : "";
    const ask = user
      ? socket.executeAsUser("pickChoice", user.id, { title: data.name, prompt, choices: choices.map((c) => ({ value: c.value, label: c.label })) })
      : sharedDialog({ title: data.name, content: choiceHtml(prompt, choices), buttons: [{ action: "ok", label: L("apply.choose") }] })
        .then((r) => (r?.form ? choices[Number(r.form.choice)]?.value ?? null : null));
    const value = choices.length === 1 ? choices[0].value
      : await Promise.race([ask, new Promise((r) => setTimeout(() => r(null), PICK_MS))]);   // очередь актёра ждёт ответа — не дольше PICK_MS
    if (value == null || !choices.some((c) => c.value === value)) return false;
    data.system.rules[i].selection = value;
  }
  return true;
}

/** Сокет, у игрока: окно выбора варианта по запросу ГМа. -> value | null. */
const choiceHtml = (prompt, choices) => {
  const esc = (x) => foundry.utils.escapeHTML(String(x ?? ""));
  return `${prompt ? `<p>${esc(prompt)}</p>` : ""}<select name="choice">${choices.map((c, i) => `<option value="${i}">${esc(c.label)}</option>`).join("")}</select>`;
};

export async function pickChoice({ title, prompt, choices }) {
  if (!game.users.get(this?.socketdata?.userId)?.isGM) return null;
  const res = await foundry.applications.api.DialogV2.wait({
    window: { title }, classes: ["paf-dialog"], rejectClose: false,
    content: choiceHtml(prompt, choices),
    buttons: [{ action: "ok", label: L("apply.choose"), default: true, callback: (_e, b) => Number(b.form.elements.choice.value) }]
  });
  return Number.isInteger(res) ? choices[res]?.value ?? null : null;
}

/** Чистая: враждебны ли две стороны по disposition токенов (дружественный против прочих). */
export const opposed = (a, b) => (a > 0) !== (b > 0);

/** Чистая: невосприимчив ли получатель к чертам источника (иммунитеты pf2e — по типу, напр. "mental"). */
export const immuneToTraits = (immunities = [], traits = []) => immunities.some((i) => traits.includes(i.type ?? i));

/** Выбор в окнах ChoiceSet делает автор сообщения, если это игрок онлайн и владелец актёра-источника; иначе — ГМ (окно pf2e). */
export function chooserOf(message, originActor) {
  const u = message?.author;
  return u && !u.isGM && u.active && u.id !== globalThis.game?.user?.id && originActor?.testUserPermission?.(u, "OWNER") ? u : null;
}

const actorOf = (doc) => doc?.actor ?? doc ?? null;   // TokenDocument -> синтетический актёр

/**
 * Применить шаги Apply[] к цели/автору и записать state.*.applied.
 * ctx: { scope: "challenge"|"apply"|"derived", degree?, total?, stepKey?, target?: TokenDocument, originActor?, originToken?, originItem?, rollOptions?, region? }
 * Возвращает ops, созданные ЭТИМ вызовом ({op, item:uuid, prev?}); повтор = пусто (идемпотентно по meta.key).
 */
export async function applyOps(message, tokenKey, steps, ctx = {}) {
  const use = message.flags?.[MOD]?.use;
  const scope = ctx.scope ?? "apply";
  const tUuid = use.targets?.find((t) => t.key === tokenKey)?.uuid;
  const targetDoc = ctx.target ?? (tUuid ? await fromUuid(tUuid) : null);
  const selfActor = ctx.originActor ?? actorOf(await fromUuid(use.actor));
  const originItem = ctx.originItem ?? (use.item?.uuid ? await fromUuid(use.item.uuid) : null);
  const originToken = ctx.originToken ?? (use.token ? await fromUuid(use.token) : null);
  const ectx = { originActor: selfActor, originToken, originItem, rollOptions: ctx.rollOptions,
    roll: ctx.degree != null && Number.isFinite(ctx.total) ? { total: ctx.total, degreeOfSuccess: ctx.degree } : null,
    castRank: originItem?.type === "spell" ? (message.flags?.pf2e?.origin?.castRank ?? originItem.rank ?? null) : null,
    chooser: chooserOf(message, selfActor) };
  const traits = originItem?.system?.traits?.value ?? [];
  // переменные формул: круг (при сотворении — поднятый), уровень предмета (у заклинания это круг), уровень автора
  const rank = message.flags?.pf2e?.origin?.castRank ?? originItem?.rank ?? originItem?.level ?? 1;
  const persVars = { rank, level: originItem?.type === "spell" ? rank : originItem?.level ?? rank, actorLevel: selfActor?.level ?? 1 };
  const myDisp = originToken?.disposition ?? 1;
  const ops = [];

  for (const [i, step] of steps.entries()) {
    const actor = step.to === "self" ? selfActor : actorOf(targetDoc);
    if (!actor || (!step.condition && !step.effect && !step.visibility && !step.persistent)) continue;   // note — только текст в блоке
    if (step.visibility && !visionActive()) continue;   // без PF2e Vision — заметка (текст «вручную» даёт чат)
    if (step.to !== "self") {
      const hostile = opposed(myDisp, targetDoc?.disposition ?? 0);
      if (step.who && (step.who === "enemy") !== hostile) continue;
      if (immuneToTraits(actor.attributes?.immunities, traits)) { notify("apply.immune", { name: actor.name }); continue; }
    }
    if (step.unlessEffect && actor.items.some((it) => it.type === "effect" && it._stats?.compendiumSource === step.unlessEffect)) {
      notify("apply.alreadyImmune", { name: actor.name }); continue;
    }
    let markUuid = null;
    if (step.mark === "enemy") {
      const docs = await Promise.all(inRange(use.targets).map((t) => fromUuid(t.uuid)));
      const foes = docs.filter((d) => d && opposed(myDisp, d.disposition));
      if (foes.length !== 1) { notify("apply.needEnemy", { name: use.item?.name ?? "" }); continue; }
      markUuid = foes[0].uuid;
    }
    const stepKey = ctx.stepKey ?? (scope === "challenge" ? `c${ctx.degree}.${i}` : `${i}`);
    // проверка автора — бросок на каждую цель, и «self» считается по каждому броску; испытание — один бросок цели, self общий
    const selfKey = scope === "challenge" && use.rule?.onUse?.check && tokenKey !== "self" ? `self.${tokenKey}` : "self";
    const meta = {
      key: `${message.id}:${step.to === "self" ? selfKey : tokenKey}:${stepKey}`,
      rank: ectx.castRank,
      source: scope, message: message.id, region: ctx.region?.uuid ?? null,
      origin: use.item?.uuid ?? null, by: selfActor?.uuid ?? null
    };
    if (step.visibility) {
      const v = step.visibility, sourceKey = `auto:${meta.key}`;
      const [observer, subject] = [step.to === "self" ? originToken : targetDoc, v.of === "self" ? originToken : targetDoc];
      const scene = observer?.parent;
      const prevOps = foundry.utils.getProperty(message, scope === "challenge" ? flagPath("use", "state", "challenge", "applied", tokenKey) : flagPath("use", "state", "apply", tokenKey))?.ops;
      if (prevOps?.some((o) => o.key === sourceKey)) continue;   // повтор — источник уже стоит (или шаг уже отмечен пропущенным)
      // пропуск пишем в ops, чтобы строка считалась отработанной; причина — уведомлением ГМу
      const skip = !scene || !subject ? "noToken" : subject.parent !== scene ? "scene"
        : (await setSource(scene, sourceKey, [{ observerId: observer.id, targetId: subject.id, level: v.level }],
          { label: use.item?.name ?? use.rule?.label, until: v.until, subjectId: subject.id })) !== "ok" ? "refused" : null;   // "no-combat": срок «до хода» вне боя
      if (skip) notify(`visSkip.${skip}`, { name: use.item?.name ?? "" });
      ops.push(skip ? { op: "vis", skipped: skip, key: sourceKey } : { op: "vis", scene: scene.id, key: sourceKey });
      continue;
    }
    const r = step.persistent ? await applyPersistent(actor, step.persistent, meta, persVars)
      : step.condition
      ? await applyCondition(actor, step.duration ? { ...step.condition, duration: step.duration } : step.condition, meta, { ...ectx, target: step.to === "self" ? null : targetDoc })
      : await applyEffect(actor, step.effect, meta, { ...ectx, markUuid, choice: step.choice, target: step.to === "self" ? null : targetDoc });
    if (step.escape && r.op === "created") {   // жертва вправе освободиться проверкой: шёпот с кнопками (вторичен — сбой не должен терять ops)
      try {
        let spellDc = null, statDc = null;
        try {
          spellDc = originItem?.spellcasting?.statistic?.withRollOptions?.({ item: originItem })?.dc?.value ?? null;
          statDc = step.escape.dcStat && step.escape.dcStat !== "spell" ? selfActor?.getStatistic?.(step.escape.dcStat)?.dc?.value ?? null : null;
        } catch { /* СЛ спросим у жертвы */ }
        await offerEscape(actor, r.item, step.escape, escapeDC(step.escape, { spellDc, statDc, useDc: scope === "challenge" ? use.dc : null }), originItem);
      } catch (e) { console.error(`${MOD} | escape`, e); }
    }
    if (r.reason === "vision") ops.push({ op: "vis", skipped: "marks", key: meta.key });   // видимость — метками: строка отработана
    else if (r.op !== "skipped" && r.op !== "pending") ops.push({ op: r.op, item: r.item.uuid, ...(r.prev != null && { prev: r.prev }) });
  }

  if (ops.length) {
    const path = scope === "challenge" ? flagPath("use", "state", "challenge", "applied", tokenKey) : flagPath("use", "state", "apply", tokenKey);
    const prev = foundry.utils.getProperty(message, path) ?? null;
    await message.update({ [path]: { ops: [...(prev?.ops ?? []), ...ops], ...(scope === "challenge" && { degree: ctx.degree }) } });
  }
  if (ctx.degree != null && use.rule?.macros?.some((m) => m.phase === "onDegree")) {
    await runMacros("onDegree", { message, rule: use.rule, target: targetDoc, degree: ctx.degree });
  }
  return ops;
}

/** Откат записанного в ops: созданное удаляется, поднятое возвращается к prev; затем запись state чистится. */
export async function undoOps(message, tokenKey) {
  const state = message.flags?.[MOD]?.use?.state ?? {};
  const places = [["challenge", state.challenge?.applied?.[tokenKey]], ["apply", state.apply?.[tokenKey]]];
  let undone = 0;
  for (const [scope, rec] of places) {
    if (!rec) continue;
    for (const o of [...(rec.ops ?? [])].reverse()) {
      if (o.op === "vis" && o.skipped) continue;
      if (o.op === "vis") { await dropSource(game.scenes.get(o.scene), o.key); undone++; continue; }
      const item = await fromUuid(o.item);
      if (!item?.actor) continue;
      await queue(`actor:${item.actor.uuid}`, async () => {
        if (o.op === "created") await item.delete();
        else if (o.op === "raised") await game.pf2e.ConditionManager.updateConditionValue(item.id, item.actor, o.prev);
      });
      undone++;
    }
    const path = scope === "challenge" ? flagPath("use", "state", "challenge", "applied") : flagPath("use", "state", "apply");
    await message.update(forcedDelete(`${path}.${tokenKey}`));
  }
  return { undone };
}

/** Зона: снять всё, у чего meta.key начинается с prefix. */
export function removeByKey(actor, metaKeyPrefix) {
  return queue(`actor:${actor.uuid}`, async () => {
    const ids = actor.items.filter((i) => metaOf(i)?.key?.startsWith(metaKeyPrefix)).map((i) => i.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
    return ids.length;
  });
}
