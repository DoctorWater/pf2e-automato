const MOD = "pf2e-autoflow-proto-3";
const TYPE = `${MOD}.zone`;
const GRACE_MS = 120_000;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const t = (k, d) => game.i18n.format(`PF2E_AUTOFLOW.${k}`, d);
const mode = k => game.settings.get(MOD, `mode_${k}`);
const slugify = s => String(s ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
const esc = s => String(s).replace(/[&<>"]/g, c => ESC[c]);
const itemSlug = item => item?.slug || slugify(item?.flags?.babele?.originalName);
let socket;
const removing = new Set(); // ids регионов, удаляемых самим модулем (истёкшие) — их не восстанавливаем

// prototype: таблицы правил по slug вместо UI-редактора
const ZONES = {
  "smoke-ball-lesser": { condition: "concealed", duration: 60 },
  "smoke-ball-greater": { condition: "concealed", duration: 60 },
  "smoke-screen": { condition: "concealed", duration: 60 } // prototype: slug «Дымовой завесы» угадан
};
const CHALLENGES = {
  // prototype: DC и эффекты по степеням (0 крит.провал .. 3 крит.успех) — заглушки
  "breathe-fire": { save: "reflex", dc: 17, basic: true, degrees: {} },
  "frightful-presence": {
    save: "will", dc: 19, basic: false,
    degrees: { 2: [{ condition: "frightened", value: 1 }], 1: [{ condition: "frightened", value: 2 }], 0: [{ condition: "frightened", value: 3 }] }
  }
};
const MULT = { 0: 2, 1: 1, 2: 0.5, 3: 0 };
const EFFECT_LINK = /@UUID\[(Compendium\.pf2e\.(?:equipment|feat|spell|bestiary|other)-effects\.[^\]]+)\]/;

/* ---------- Region Behavior: зона ---------- */

class ZoneBehavior extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PF2E_AUTOFLOW.zone", "BEHAVIOR.TYPES.base"];

  static defineSchema() {
    const f = foundry.data.fields, ev = CONST.REGION_EVENTS;
    const events = [ev.TOKEN_ENTER, ev.TOKEN_EXIT, ev.TOKEN_TURN_START];
    return {
      events: this._createEventsField({ events, initial: events }),
      condition: new f.StringField({ required: true, blank: false, initial: "concealed" }),
      expiresAt: new f.NumberField({ required: true, integer: true, min: 0, initial: 0 }),
      persist: new f.BooleanField({ initial: true }),
      originUuid: new f.StringField({ required: true, blank: true, initial: "" }),
      originActor: new f.StringField({ required: true, blank: true, initial: "" })
    };
  }

  get expired() { return this.expiresAt > 0 && game.time.worldTime >= this.expiresAt; }

  async _handleRegionEvent(event) {
    if (!game.user.isActiveGM) return; // события приходят на все клиенты; меняет только ГМ
    const actor = event.data?.token?.actor;
    if (!actor) return;
    if (event.name === CONST.REGION_EVENTS.TOKEN_EXIT) return this.release(actor);
    return this.hold(actor);
  }

  async hold(actor) {
    const src = this.behavior.uuid;
    if (this.expired || actor.itemTypes.condition.some(c => c.flags[MOD]?.meta?.source === src)) return;
    if (actor.hasCondition(this.condition)) return; // чужое состояние не трогаем и не забираем
    const item = await actor.increaseCondition(this.condition);
    await item?.setFlag(MOD, "meta", { source: src, by: this.originActor, from: this.originUuid, until: this.expiresAt });
  }

  async release(actor) {
    const src = this.behavior.uuid;
    const ids = actor.itemTypes.condition.filter(c => c.flags[MOD]?.meta?.source === src).map(c => c.id);
    if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
  }
}

async function sweep(region) {
  await sleep(400); // region.tokens заполняется ГМом асинхронно после создания
  const b = region.behaviors.find(b => b.type === TYPE);
  if (b && !b.disabled) for (const tk of region.tokens) if (tk.actor) await b.system.hold(tk.actor);
}

async function spawnZone(region, rule, origin) {
  await region.setFlag(MOD, "zone", { createdAt: Date.now(), restores: 0 });
  await region.createEmbeddedDocuments("RegionBehavior", [{
    name: t("zone.label"), type: TYPE,
    system: {
      condition: rule.condition, expiresAt: game.time.worldTime + rule.duration,
      originUuid: origin.uuid ?? "", originActor: origin.actor ?? ""
    }
  }]);
  await sweep(region);
}

async function expireZones() {
  if (!game.user.isActiveGM) return;
  for (const scene of game.scenes) for (const r of scene.regions) {
    if (r.behaviors.find(b => b.type === TYPE)?.system.expired) { removing.add(r.id); await r.delete(); }
  }
}

/* ---------- Действия на стороне ГМа ---------- */

async function give(actor, slug, value, meta) {
  const had = actor.hasCondition(slug);
  const item = await actor.increaseCondition(slug, value ? { value } : {});
  if (item && !had) await item.setFlag(MOD, "meta", meta);
}

function targetsOf(msg, ch) {
  if (ch.targets.length) return ch.targets;
  const region = canvas.scene?.regions.find(r => r.flags.pf2e?.messageId === msg.id);
  return region ? [...region.tokens].map(tk => ({ uuid: tk.uuid, name: tk.name })) : [];
}

async function act(msgId, action, arg) {
  const msg = game.messages.get(msgId);
  const f = msg?.flags[MOD];
  if (!f) return;
  const origin = msg.flags.pf2e?.origin ?? {};
  const meta = { by: origin.actor ?? "", from: origin.uuid ?? "", message: msg.id };

  if (action === "effect") {
    const ef = foundry.utils.deepClone(f.effect);
    const actor = await fromUuid(ef.actor), src = await fromUuid(ef.uuid);
    if (!actor || !src || ef.state === "applied") return;
    const data = src.toObject();
    delete data._id;
    const d = data.system?.duration, secs = { rounds: 6, minutes: 60, hours: 3600, days: 86400 }[d?.unit];
    foundry.utils.setProperty(data, `flags.${MOD}.meta`, { ...meta, until: secs ? game.time.worldTime + secs * d.value : 0 });
    await actor.createEmbeddedDocuments("Item", [data]);
    ef.state = "applied";
    return msg.setFlag(MOD, "effect", ef);
  }

  if (action === "roll" || action === "apply" || action === "applyAll") {
    const ch = foundry.utils.deepClone(f.challenge);
    ch.targets = targetsOf(msg, ch);
    if (action === "roll") {
      for (const tg of ch.targets) {
        const actor = (await fromUuid(tg.uuid))?.actor;
        const roll = await actor?.saves?.[ch.save]?.check.roll({ dc: { value: ch.dc }, skipDialog: true });
        if (roll) ch.results[tg.uuid] = { degree: roll.degreeOfSuccess ?? roll.options?.degreeOfSuccess ?? null, total: roll.total };
      }
    } else {
      const list = action === "apply" ? [arg] : ch.targets.map(x => x.uuid);
      for (const uuid of list) {
        const degree = ch.results[uuid]?.degree;
        if (degree == null || ch.applied[uuid]) continue;
        const actor = (await fromUuid(uuid))?.actor;
        for (const e of CHALLENGES[ch.rule]?.degrees[degree] ?? []) if (actor) await give(actor, e.condition, e.value, meta);
        ch.applied[uuid] = true;
      }
    }
    return msg.setFlag(MOD, "challenge", ch);
  }

  if (action === "reaction") {
    const re = foundry.utils.deepClone(f.reaction);
    const actor = await fromUuid(re.actor);
    if (!actor || re.used) return;
    await actor.createEmbeddedDocuments("Item", [{
      type: "effect", name: t("reaction.effect"), img: "icons/svg/shield.svg",
      system: {
        slug: "proto-nimble-dodge",
        duration: { value: 1, unit: "rounds", sustained: false, expiry: "turn-start" },
        rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: 2 }]
      },
      flags: { [MOD]: { meta: { by: actor.uuid, from: "nimble-dodge", message: msg.id, until: 0 } } }
    }]);
    re.used = true;
    return msg.setFlag(MOD, "reaction", re);
  }
}

/* ---------- Сообщения чата: флаги ---------- */

async function onItemMessage(msg) {
  const item = msg.item ?? (msg.flags.pf2e?.origin?.uuid ? fromUuidSync(msg.flags.pf2e.origin.uuid) : null);
  const actor = msg.actor ?? item?.actor;
  if (!item || !actor) return;
  const slug = itemSlug(item), desc = item.system?.description?.value ?? "";

  const rule = CHALLENGES[slug];
  if (rule && mode("challenge") !== "off") {
    const chk = /@Check\[([^\]]+)\]/.exec(desc)?.[1].split("|") ?? [];
    const dc = parseInt(chk.find(p => p.startsWith("dc:"))?.slice(3));
    const save = ["fortitude", "reflex", "will"].includes(chk[0]) ? chk[0] : rule.save;
    const targets = [...(msg.author?.targets ?? [])].map(tk => ({ uuid: tk.document.uuid, name: tk.name }));
    await msg.setFlag(MOD, "challenge", { rule: slug, save, dc: dc || rule.dc, basic: rule.basic, targets, results: {}, applied: {} });
    if (mode("challenge") === "auto" && targets.length) { await act(msg.id, "roll"); await act(msg.id, "applyAll"); }
    return;
  }

  const link = item.type === "consumable" ? EFFECT_LINK.exec(desc)?.[1] : null;
  if (link && mode("effect") !== "off") {
    await msg.setFlag(MOD, "effect", { uuid: link, actor: actor.uuid, name: actor.name, state: "pending" });
    if (mode("effect") === "auto") await act(msg.id, "effect");
  }
}

async function onAttackMessage(msg) {
  const ctx = msg.flags.pf2e.context;
  const actor = ctx.target?.actor ? await fromUuid(ctx.target.actor) : null;
  if (!actor || !actor.items.some(i => itemSlug(i) === "nimble-dodge")) return;
  await msg.setFlag(MOD, "reaction", { actor: actor.uuid, name: actor.name, ac: ctx.dc?.value ?? null, total: msg.rolls[0]?.total ?? null, used: false });
  if (mode("reaction") === "auto") await act(msg.id, "reaction");
}

/* ---------- Блок в чате ---------- */

function renderBlock(msg, f) {
  const btn = (a, label, arg = "") => `<button type="button" data-act="${a}" data-arg="${esc(arg)}">${esc(label)}</button>`;
  const canGM = game.user.isGM || msg.isAuthor;
  let html = "";

  if (f.effect) {
    const e = f.effect, mine = game.user.isGM || fromUuidSync(e.actor)?.isOwner;
    html += `<h4>${t("effect.title")}</h4>` + (e.state === "applied"
      ? `<div class="muted">${t("effect.applied", { name: esc(e.name) })}</div>`
      : mine && mode("effect") !== "auto" ? btn("effect", t("effect.apply", { name: e.name })) : "");
  }

  if (f.challenge) {
    const c = f.challenge, rule = CHALLENGES[c.rule];
    html += `<h4>${t("challenge.title", { save: c.save, dc: c.dc })}</h4>`;
    if (!c.targets.length && !Object.keys(c.results).length) html += `<div class="muted">${t("challenge.noTargets")}</div>`;
    for (const tg of c.targets) {
      const r = c.results[tg.uuid];
      const extra = !r ? "" : c.basic ? ` — ${t("challenge.basic", { mult: MULT[r.degree] })}` : "";
      const can = r && !c.applied[tg.uuid] && rule?.degrees[r.degree]?.length && canGM;
      html += `<div class="row"><span>${esc(tg.name)}</span>`
        + (r ? `<span class="d${r.degree}">${r.total} ${r.degree == null ? "" : t(`degree.${r.degree}`)}${extra}${c.applied[tg.uuid] ? ` (${t("challenge.applied")})` : ""}</span>` : "")
        + (can ? btn("apply", t("challenge.apply"), tg.uuid) : "") + `</div>`;
    }
    if (canGM && mode("challenge") !== "auto") {
      html += btn("roll", t("challenge.roll"));
      if (Object.keys(c.results).length) html += btn("applyAll", t("challenge.applyAll"));
    }
  }

  if (f.reaction && (game.user.isGM || fromUuidSync(f.reaction.actor)?.isOwner)) {
    const r = f.reaction;
    html += `<h4>${t("reaction.title", { name: esc(r.name) })}</h4>`;
    if (r.ac != null && r.total != null) {
      const ac2 = t(r.total >= r.ac && r.total < r.ac + 2 ? "reaction.flip" : "reaction.same");
      html += `<div>${t("reaction.hint", { total: r.total, ac: r.ac, ac2 })}</div>`;
    }
    html += r.used ? `<div class="muted">${t("reaction.used")}</div>` : mode("reaction") !== "auto" ? btn("reaction", t("reaction.use")) : "";
  }
  return html;
}

/* ---------- Хуки ---------- */

Hooks.once("init", () => {
  CONFIG.RegionBehavior.dataModels[TYPE] = ZoneBehavior;
  CONFIG.RegionBehavior.typeLabels[TYPE] = "PF2E_AUTOFLOW.zone.label";
  CONFIG.RegionBehavior.typeHints[TYPE] = "PF2E_AUTOFLOW.zone.hint";
  CONFIG.RegionBehavior.typeIcons[TYPE] = "fa-solid fa-smog";
  for (const k of ["effect", "challenge", "reaction"]) {
    game.settings.register(MOD, `mode_${k}`, {
      name: `PF2E_AUTOFLOW.mode.${k}`, scope: "world", config: true, type: String, default: "button",
      choices: { auto: "PF2E_AUTOFLOW.mode.auto", button: "PF2E_AUTOFLOW.mode.button", off: "PF2E_AUTOFLOW.mode.off" }
    });
  }
});

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MOD);
  socket.register("act", act);
});

Hooks.once("ready", expireZones);
Hooks.on("updateWorldTime", expireZones);
Hooks.on("pf2e.startTurn", expireZones);

Hooks.on("createRegion", async region => {
  if (!game.user.isActiveGM) return;
  const o = region.flags.pf2e?.origin;
  if (!o) return;
  const slug = o.slug ?? itemSlug(o.uuid ? fromUuidSync(o.uuid) : null);
  if (ZONES[slug]) await spawnZone(region, ZONES[slug], o);
});

// Template Helper из toolbelt удаляет регион после «Target/Cancel» — пересоздаём один раз в пределах GRACE_MS
Hooks.on("deleteRegion", async region => {
  if (!game.user.isActiveGM || removing.delete(region.id)) return;
  const z = region.flags[MOD]?.zone, b = region.behaviors.find(b => b.type === TYPE);
  if (!z || !b?.system.persist || b.system.expired || z.restores >= 1 || Date.now() - z.createdAt > GRACE_MS) return;
  await sleep(1000); // дать событиям выхода снять состояния до повторного входа
  const data = region.toObject();
  delete data._id;
  foundry.utils.setProperty(data, `flags.${MOD}.zone.restores`, z.restores + 1);
  const [copy] = await region.parent.createEmbeddedDocuments("Region", [data]);
  if (copy) await sweep(copy);
});

Hooks.on("createChatMessage", msg => {
  if (!game.user.isActiveGM) return;
  const ctx = msg.flags.pf2e?.context;
  if (!ctx) return onItemMessage(msg);
  if (ctx.type === "attack-roll" && mode("reaction") !== "off") return onAttackMessage(msg);
});

Hooks.on("renderChatMessageHTML", (msg, html) => {
  const f = msg.flags[MOD];
  if (!f) return;
  const inner = renderBlock(msg, f);
  if (!inner) return;
  const div = document.createElement("div");
  div.className = "pf2e-autoflow";
  div.innerHTML = inner;
  div.addEventListener("click", ev => {
    const b = ev.target.closest("button[data-act]");
    if (!b) return;
    b.disabled = true;
    socket.executeAsGM("act", msg.id, b.dataset.act, b.dataset.arg);
  });
  (html.querySelector(".message-content") ?? html).append(div);
});
