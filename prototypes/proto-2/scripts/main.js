// pf2e-autoflow proto-2: automation as custom pf2e Rule Elements.
// Flow: item used (chat card) -> module finds AutoflowX rules on the item -> rule.onUse(message) -> chat block + GM socket.
const MOD = "pf2e-autoflow-proto-2";
const L = (k, d) => game.i18n.format(`AUTOFLOW2.${k}`, d);
const esc = (s) => foundry.utils.escapeHTML(String(s ?? ""));
const DEGREE_KEYS = ["criticalFailure", "failure", "success", "criticalSuccess"];
let socket;

// Mini catalog: item slug -> rule sources injected into the item at prepareRuleElements time.
// prototype: slugs other than the 4 test items are guesses; the "Smoke Curtain" agent action is not listed (slug unknown).
const CATALOG = {
  "smoke-ball-lesser": [{ key: "AutoflowZone", condition: "concealed", minutes: 1 }],
  "breathe-fire": [{ key: "AutoflowSave", basic: true }],
  "frightful-presence": [{
    key: "AutoflowSave", save: "will",
    outcomes: { success: [{ condition: "frightened", value: 1 }], failure: [{ condition: "frightened", value: 2 }], criticalFailure: [{ condition: "frightened", value: 3 }] }
  }],
  "bravos-brew-lesser": [{ key: "AutoflowEffect", target: "self" }],
  "nimble-dodge": [{ key: "AutoflowReaction", trigger: "attacked", bonus: 2 }]
};

const itemSlug = (item) => item.system.slug
  ?? (item.flags?.babele?.originalName ? game.pf2e.system.sluggify(item.flags.babele.originalName) : null);

/** Extract the first @Check from the description: {type, dc, basic}. */
function parseCheck(item) {
  const m = item.system.description?.value?.match(/@Check\[([^\]]+)\]/);
  if (!m) return {};
  const out = {};
  for (const p of m[1].split("|")) {
    if (p.startsWith("dc:") && /^\d+$/.test(p.slice(3))) out.dc = Number(p.slice(3));
    else if (p === "basic" || p === "basic:true") out.basic = true;
    else if (p.startsWith("type:")) out.type = p.slice(5);
    else if (!p.includes(":")) out.type ??= p;
  }
  return out;
}

const firstEffectUuid = (item) => item.system.description?.value
  ?.match(/@UUID\[(Compendium\.[^\]]*?(?:equipment|spell|feat|bestiary)-effects[^\]]*?)\]/)?.[1] ?? null;

const modeIs = (m) => game.settings.get(MOD, "mode") === m;

/* ------------------------------------------------------------------ Rule Elements */

function defineRules() {
  const { RuleElement } = game.pf2e;
  const f = foundry.data.fields;
  const str = (extra = {}) => new f.StringField({ required: false, nullable: true, initial: null, ...extra });

  class AutoflowZone extends RuleElement {
    static defineSchema() {
      return {
        ...super.defineSchema(),
        condition: str(), effect: str(),
        value: new f.NumberField({ required: false, nullable: true, initial: null }),
        minutes: new f.NumberField({ required: false, nullable: false, initial: 1 })
      };
    }
    // Zone spec travels with the chat message: the region (placed later from the card) points back via flags.pf2e.messageId.
    async onUse(message) {
      const { condition, effect, value, minutes } = this;
      await message.setFlag(MOD, "zone", { label: this.item.name, condition, effect, value, minutes });
    }
  }

  class AutoflowSave extends RuleElement {
    static defineSchema() {
      return {
        ...super.defineSchema(),
        save: str({ choices: ["fortitude", "reflex", "will"] }),
        dc: new f.NumberField({ required: false, nullable: true, initial: null }),
        basic: new f.BooleanField({ required: false, initial: false }),
        outcomes: new f.ObjectField({ required: false, initial: {} })
      };
    }
    async onUse(message) {
      if (modeIs("off")) return;
      const check = parseCheck(this.item);
      const spec = {
        label: this.item.name, type: this.save ?? check.type ?? "reflex",
        // prototype: no DC from actor stats (class/spell DC); falls back to 15
        dc: this.dc ?? check.dc ?? 15, basic: this.basic || !!check.basic, outcomes: this.outcomes
      };
      await message.setFlag(MOD, "save", spec);
      const uuids = [...game.user.targets].map((t) => t.document.uuid);
      if (uuids.length) await postSave(message, spec, uuids);
      // else: waits for the area region created from this card (createRegion hook)
    }
  }

  class AutoflowEffect extends RuleElement {
    static defineSchema() {
      return { ...super.defineSchema(), effect: str(), target: str({ choices: ["self", "targets"], initial: "self" }) };
    }
    async onUse() {
      if (modeIs("off")) return;
      const uuid = this.effect ?? firstEffectUuid(this.item);
      if (!uuid) return ui.notifications.warn(L("Effect.NoEffect"));
      const actors = this.target === "targets" ? [...game.user.targets].map((t) => t.actor) : [this.item.actor];
      const rows = actors.filter(Boolean).map((a) => ({ actor: a.uuid, name: a.name, specs: [{ effect: uuid }], applied: false }));
      await postBlock({ kind: "effect", title: L("Effect.Title", { item: this.item.name }), rows });
    }
  }

  class AutoflowReaction extends RuleElement {
    static defineSchema() {
      return {
        ...super.defineSchema(),
        trigger: str({ choices: ["attacked"], initial: "attacked" }),
        bonus: new f.NumberField({ required: false, nullable: false, initial: 2 })
      };
    }
  }

  return { AutoflowZone, AutoflowSave, AutoflowEffect, AutoflowReaction };
}

/* ------------------------------------------------------------------ chat blocks */

const degreeOf = (total, dc) => (total >= dc + 10 ? 3 : total >= dc ? 2 : total <= dc - 10 ? 0 : 1);
// prototype: natural 1/20 steps are ignored in the reaction preview

function specLabel(s) {
  if (s.condition) return `${s.condition}${s.value ? " " + s.value : ""}`;
  return s.effect ? "effect" : (s.source?.name ?? "?");
}

function render(st) {
  let h = `<div class="af2-block"><h4>${esc(st.title)}</h4>`;
  const buttons = [];
  if (st.kind === "reaction") {
    h += `<p>${esc(st.text)}</p>`;
    buttons.push(st.used ? null : ["use", L("Reaction.Use")]);
    if (st.used) h += `<p><em>${L("Reaction.Used")}</em></p>`;
  } else if (st.kind === "zone") {
    h += `<p>${esc(st.text)}</p>`;
    buttons.push(st.closed ? null : ["close", L("Zone.Close")]);
  } else {
    h += "<ul>";
    for (const r of st.rows) {
      const d = r.degree == null ? `<em>${L("Save.Pending")}</em>` : `<span class="af2-d${r.degree}">${L(`Degree.${r.degree}`)}</span> (${r.total})`;
      const fx = r.specs.length ? ` &rarr; ${esc(r.specs.map(specLabel).join(", "))}` : "";
      h += `<li>${esc(r.name)}${st.kind === "save" ? ": " + d : ""}${fx}${r.applied ? " &#10003;" : ""}</li>`;
    }
    h += "</ul>";
    if (!st.rows.length) h += `<p>${L("Save.NoTargets")}</p>`;
    if (st.kind === "save" && st.rows.some((r) => r.degree == null)) buttons.push(["roll", L("Save.Roll")]);
    if (st.rows.some((r) => r.specs.length && !r.applied)) buttons.push(["apply", L("Apply")]);
    if (st.rows.some((r) => r.applied)) buttons.push(["undo", L("Undo")]);
  }
  return h + buttons.filter(Boolean).map(([a, t]) => `<button type="button" data-af="${a}">${esc(t)}</button>`).join("") + "</div>";
}

async function postBlock(st, whisper) {
  const msg = await ChatMessage.create({
    content: render(st), speaker: { alias: "Autoflow" }, flags: { [MOD]: { state: st } },
    ...(whisper ? { whisper } : {})
  });
  return msg;
}

async function postSave(srcMessage, spec, tokenUuids) {
  await srcMessage.setFlag(MOD, "blockPosted", true);
  const rows = tokenUuids.map((u) => ({ actor: u, name: fromUuidSync(u)?.name ?? "?", degree: null, total: null, specs: [], applied: false }));
  const title = L("Save.Title", { item: spec.label, type: game.i18n.localize(CONFIG.PF2E.saves?.[spec.type] ?? spec.type), dc: spec.dc, basic: spec.basic ? L("Save.Basic") : "" });
  const msg = await postBlock({ kind: "save", title, spec, rows });
  if (modeIs("auto")) await socket.executeAsGM("act", msg.id, "roll");
}

/* ------------------------------------------------------------------ GM-side operations (socketlib) */

const busy = new Set();

async function gmApply(actorUuid, specs, tag) {
  const actor = await fromUuid(actorUuid);
  const target = actor?.actor ?? actor; // token uuid -> document -> actor
  if (!target) return;
  const docs = [];
  for (const s of specs) {
    let src = null;
    if (s.condition) {
      src = game.pf2e.ConditionManager.getCondition(s.condition)?.toObject();
      if (src && s.value && typeof src.system.value.value === "number") src.system.value.value = s.value;
    } else if (s.effect) src = (await fromUuid(s.effect))?.toObject();
    else if (s.source) src = foundry.utils.deepClone(s.source);
    if (!src) continue;
    delete src._id;
    foundry.utils.setProperty(src, `flags.${MOD}.tag`, tag);
    docs.push(src);
  }
  if (docs.length) await target.createEmbeddedDocuments("Item", docs);
}

async function gmRemove(actorUuid, tag) {
  const doc = await fromUuid(actorUuid);
  const actor = doc?.actor ?? doc;
  const ids = actor?.items?.filter((i) => i.getFlag(MOD, "tag") === tag).map((i) => i.id) ?? [];
  if (ids.length) await actor.deleteEmbeddedDocuments("Item", ids);
}

async function gmAct(messageId, act) {
  const msg = game.messages.get(messageId);
  const st = foundry.utils.deepClone(msg?.getFlag(MOD, "state"));
  if (!st) return;
  if (act === "roll") {
    for (const r of st.rows) {
      const token = await fromUuid(r.actor);
      const stat = token?.actor?.saves?.[st.spec.type];
      if (!stat) continue;
      const roll = await stat.roll({ dc: { value: st.spec.dc }, token, skipDialog: true, createMessage: false });
      if (!roll) continue;
      r.total = roll.total;
      r.degree = roll.degreeOfSuccess ?? degreeOf(roll.total, st.spec.dc);
      r.specs = st.spec.outcomes?.[DEGREE_KEYS[r.degree]] ?? [];
    }
    if (modeIs("auto")) act = "apply";
  }
  if (act === "apply") for (const r of st.rows) if (r.specs.length && !r.applied) { await gmApply(r.actor, r.specs, msg.uuid); r.applied = true; }
  if (act === "undo") for (const r of st.rows) if (r.applied) { await gmRemove(r.actor, msg.uuid); r.applied = false; }
  if (act === "use") {
    await gmApply(st.actor, [{ source: reactionEffect(st) }], msg.uuid);
    st.used = true;
  }
  if (act === "close") {
    const region = await fromUuid(st.region);
    st.closed = true;
    await region?.delete();
  }
  await msg.update({ content: render(st), [`flags.${MOD}.state`]: st });
}

const reactionEffect = (st) => ({
  type: "effect", name: st.item, img: st.img,
  system: {
    slug: `autoflow-${game.pf2e.system.sluggify(st.item)}`, tokenIcon: { show: true },
    duration: { value: 1, unit: "rounds", sustained: false, expiry: "turn-start" },
    rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: st.bonus, label: st.item }]
  }
});

/* ------------------------------------------------------------------ zones */

const zoneOf = (region) => region.getFlag(MOD, "zone")
  ?? game.messages.get(region.flags.pf2e?.messageId)?.getFlag(MOD, "zone");

async function zoneEnter(region, tokenDoc) {
  const zone = zoneOf(region);
  const actor = tokenDoc.actor;
  if (!zone || !actor) return;
  const key = `${actor.uuid}|${region.uuid}`;
  if (busy.has(key) || actor.items.some((i) => i.getFlag(MOD, "tag") === region.uuid)) return;
  busy.add(key);
  try { await gmApply(actor.uuid, [zone], region.uuid); } finally { busy.delete(key); }
}

const zoneExit = (region, tokenDoc) => tokenDoc.actor && gmRemove(tokenDoc.actor.uuid, region.uuid);

/* ------------------------------------------------------------------ hooks */

Hooks.once("init", () => {
  game.settings.register(MOD, "mode", {
    name: "AUTOFLOW2.Setting.Mode.Name", hint: "AUTOFLOW2.Setting.Mode.Hint", scope: "world", config: true, type: String, default: "auto",
    choices: { auto: "AUTOFLOW2.Setting.Auto", button: "AUTOFLOW2.Setting.Button", off: "AUTOFLOW2.Setting.Off" }
  });

  // pf2e 8.6.1: RuleElements.custom is a plain extension map read by RuleElements.fromOwnedItem and i18nInit localization.
  const rules = defineRules();
  Object.assign(game.pf2e.RuleElements.custom, rules);

  // Catalog injection: append catalog rules after the item's own rules were built (own Autoflow* rules win).
  libWrapper.register(MOD, "game.pf2e.RuleElements.fromOwnedItem", function (wrapped, options) {
    const res = wrapped(options);
    const item = options?.parent;
    try {
      const sources = CATALOG[itemSlug(item)];
      if (sources && !item.system.rules.some((r) => String(r.key).startsWith("Autoflow"))) {
        for (const src of sources) {
          res.push(new rules[src.key]({ requiresEquipped: false, ...src }, { ...options, sourceIndex: null }));
        }
      }
    } catch (e) { console.warn(`${MOD} | catalog injection failed`, e); }
    return res;
  }, "WRAPPER");

  // Region events: tokenEnter / tokenExit reach every client; only the active GM acts.
  // prototype: _handleEvent is @internal in core v14.
  libWrapper.register(MOD, "CONFIG.Region.documentClass.prototype._handleEvent", function (wrapped, event) {
    if (game.user.isActiveGM && zoneOf(this)) {
      if (event.name === "tokenEnter") zoneEnter(this, event.data.token);
      else if (event.name === "tokenExit") zoneExit(this, event.data.token);
    }
    return wrapped(event);
  }, "WRAPPER");
});

Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MOD);
  socket.register("act", gmAct);
});

// Item used: a card with origin and without a roll context (rolls/attacks carry flags.pf2e.context).
Hooks.on("createChatMessage", async (message) => {
  const pf2e = message.flags.pf2e;
  if (message.isAuthor && pf2e?.origin?.uuid && !pf2e.context && !message.flags[MOD]) {
    const item = fromUuidSync(pf2e.origin.uuid);
    for (const rule of item?.rules ?? []) if (rule.onUse && rule.key?.startsWith("Autoflow")) await rule.onUse(message);
  }
  if (game.user.isActiveGM && pf2e?.context?.type === "attack-roll") reactionHint(message);
});

async function reactionHint(message) {
  const ctx = message.flags.pf2e.context;
  const actor = ctx.target?.actor ? fromUuidSync(ctx.target.actor) : null;
  const ac = ctx.dc?.value;
  if (!actor || ac == null) return;
  const total = message.rolls[0]?.total;
  for (const item of actor.items) {
    for (const rule of item.rules ?? []) {
      if (rule.key !== "AutoflowReaction" || rule.trigger !== "attacked") continue;
      // prototype: no check for "reaction already spent" / "can see the attacker"
      const now = L(`Degree.${degreeOf(total, ac)}`), then = L(`Degree.${degreeOf(total, ac + rule.bonus)}`);
      const owners = game.users.filter((u) => u.isGM || actor.testUserPermission(u, "OWNER")).map((u) => u.id);
      await postBlock({
        kind: "reaction", title: L("Reaction.Title", { actor: actor.name, item: item.name }), actor: actor.uuid,
        item: item.name, img: item.img, bonus: rule.bonus,
        text: `${L("Reaction.Attack", { total, ac, now })} ${L("Reaction.With", { bonus: rule.bonus, then })}`
      }, owners);
    }
  }
}

Hooks.on("renderChatMessageHTML", (message, html) => {
  if (!message.flags[MOD]?.state) return;
  html.querySelectorAll("[data-af]").forEach((b) => b.addEventListener("click", () => socket.executeAsGM("act", message.id, b.dataset.af)));
});

Hooks.on("createRegion", async (region) => {
  if (!game.user.isActiveGM) return;
  const src = game.messages.get(region.flags.pf2e?.messageId);
  const zone = src?.getFlag(MOD, "zone");
  if (zone) {
    await region.setFlag(MOD, "zone", { ...zone, expires: game.time.worldTime + zone.minutes * 60 });
    // Safety net: if core did not emit tokenEnter for tokens already inside, sweep them.
    setTimeout(() => region.tokens.forEach((t) => zoneEnter(region, t)), 1500);
    await postBlock({ kind: "zone", title: L("Zone.Title", { item: zone.label }), region: region.uuid, text: `${specLabel(zone)}, ${zone.minutes} min` });
  }
  const save = src?.getFlag(MOD, "save");
  if (save && !src.getFlag(MOD, "blockPosted")) {
    // prototype: region membership is read right away; core may still be updating token._regions, so take a geometric check.
    const uuids = region.parent.tokens.filter((t) => t.actor && t.testInsideRegion(region)).map((t) => t.uuid);
    await postSave(src, save, uuids);
  }
});

// Zone cleanup: region deleted (manually, by expiry, or "Close") -> remove everything it applied.
Hooks.on("deleteRegion", (region) => {
  if (!game.user.isActiveGM || !region.getFlag(MOD, "zone")) return;
  for (const token of region.parent.tokens) if (token.actor) gmRemove(token.actor.uuid, region.uuid);
});

// Zone expiry (1 minute = 60 s of world time; combat rounds advance it by 6 s).
Hooks.on("updateWorldTime", (worldTime) => {
  if (!game.user.isActiveGM) return;
  for (const scene of game.scenes) {
    for (const region of scene.regions) {
      const z = region.getFlag(MOD, "zone");
      if (z?.expires != null && worldTime >= z.expires) region.delete();
    }
  }
});
