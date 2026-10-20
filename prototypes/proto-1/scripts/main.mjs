// PF2e Autoflow proto-1: chat pipeline. One file on purpose (prototype).
const MOD = "pf2e-autoflow-proto-1";
const ZONE_TYPE = `${MOD}.zone`;
const L = (k, d) => (d ? game.i18n.format(`AFP1.${k}`, d) : game.i18n.localize(`AFP1.${k}`));
const { fromUuid } = foundry.utils;
const EFFECT_LINK = /@UUID\[(Compendium\.pf2e\.(?:equipment|spell|feat|bestiary|other|campaign)-effects\.[^\]]+)\]/g;
const slugify = (s) => String(s ?? "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/* ---------- Declarative rules: catalog by slug (the rest is derived from markup) ---------- */
// degree keys: 0 crit failure, 1 failure, 2 success, 3 crit success
const SMOKE_ZONE = { zone: { condition: "concealed", seconds: 60 } };
const RULES = {
  "smoke-ball-lesser": SMOKE_ZONE,
  "smoke-screen": SMOKE_ZONE, // prototype: slug of the agents' action is a guess
  "breathe-fire": {
    area: true,
    steps: [
      { save: { stat: "reflex", dc: 17 } }, // prototype: fallback DC when @Check has no plain number
      { byDegree: { 0: { note: "x2 damage" }, 1: { note: "x1 damage" }, 2: { note: "x1/2 damage" }, 3: { note: "no damage" } } }
    ]
  },
  "frightful-presence": {
    steps: [
      { save: { stat: "will", dc: 17 } },
      { byDegree: {
        0: { actions: [{ condition: "frightened", value: 3 }] },
        1: { actions: [{ condition: "frightened", value: 2 }] },
        2: { actions: [{ condition: "frightened", value: 1 }] }
      } }
    ]
  },
  "nimble-dodge": { reaction: { trigger: "attack-on-self", bonus: 2 } }
};
const slugOf = (item) => item?.system?.slug || slugify(item?.flags?.babele?.originalName) || null;

/* Rule for an item: catalog first, else derived from markup (effect links on a consumable -> apply to self). */
function ruleFor(item) {
  const slug = slugOf(item);
  if (RULES[slug]) return RULES[slug];
  const desc = item?.system?.description?.value ?? "";
  const links = [...desc.matchAll(EFFECT_LINK)].map((m) => m[1]);
  if (item?.type === "consumable" && links.length) {
    return { steps: [{ apply: { to: "self", actions: links.map((effect) => ({ effect })) } }] };
  }
  return null;
}
const checkDC = (item, fallback) => {
  const m = (item?.system?.description?.value ?? "").match(/@Check\[[^\]]*?dc:(\d+)/);
  return m ? Number(m[1]) : fallback;
};

/* ---------- Engine ---------- */
async function runRule(rule, ctx) {
  let rows = ctx.targets.map((token) => ({ tokenUuid: token.uuid, name: token.name, degree: null, actions: [], note: "", applied: false }));
  let header = "";
  for (const step of rule.steps ?? []) {
    if (step.apply) {
      const self = ctx.selfToken;
      rows = self ? [{ tokenUuid: self.uuid, name: self.name, degree: null, actions: step.apply.actions, note: "", applied: false }] : [];
    }
    if (step.save) {
      const dc = checkDC(ctx.item, step.save.dc);
      header = L("Save", { stat: step.save.stat, dc });
      for (const r of rows) {
        const actor = (await fromUuid(r.tokenUuid))?.actor;
        const roll = await actor?.saves?.[step.save.stat]?.roll({ dc: { value: dc }, skipDialog: true, createMessage: false });
        r.degree = roll?.degreeOfSuccess ?? null; // pf2e CheckRoll#degreeOfSuccess
      }
    }
    if (step.byDegree) {
      for (const r of rows) {
        const d = step.byDegree[r.degree];
        r.actions = d?.actions ?? [];
        r.note = d?.note ?? "";
      }
    }
  }
  return { header, rows };
}

const DEGREE = ["Critical Failure", "Failure", "Success", "Critical Success"];
function renderBlock(title, header, rows) {
  const body = rows.length ? rows.map((r, i) => {
    const acts = r.actions.map((a) => a.condition ? `${a.condition}${a.value ? " " + a.value : ""}` : "effect").join(", ");
    const btn = r.applied ? `<em>${L("Applied")}</em>` : (r.actions.length ? `<button type="button" data-af="apply" data-i="${i}">${L("Apply")}</button>` : "");
    return `<div class="af-row"><span class="af-name">${r.name}</span>
      ${r.degree != null ? `<span class="af-deg-${r.degree}">${DEGREE[r.degree]}</span>` : ""}
      <span class="af-note">${acts}${r.note ? " " + r.note : ""}</span>${btn}</div>`;
  }).join("") : `<p>${L("Targets")}</p>`;
  const all = rows.some((r) => r.actions.length && !r.applied) ? `<button type="button" data-af="apply" data-i="all">${L("ApplyAll")}</button>` : "";
  return `<div class="pf2e-autoflow"><div class="af-title">${title}</div><div class="af-note">${header}</div>${body}${all}</div>`;
}

async function postBlock(ctx, rule) {
  const { header, rows } = await runRule(rule, ctx);
  const title = L("Item", { name: ctx.item?.name ?? "" });
  const msg = await ChatMessage.create({
    content: renderBlock(title, header, rows),
    speaker: { alias: "Autoflow" },
    flags: { [MOD]: { title, header, rows } }
  });
  if (game.settings.get(MOD, "mode") === "auto") await applyBlock(msg.id, "all");
}

/* ---------- Applying (runs on GM via socketlib) ---------- */
async function applyActions(actor, actions) {
  for (const a of actions) {
    if (a.condition) {
      const cur = actor.itemTypes.condition.find((c) => c.slug === a.condition);
      if (cur && (cur.value ?? 0) >= (a.value ?? 0)) continue;
      await actor.increaseCondition(a.condition, a.value ? { value: a.value } : {});
    } else if (a.effect) {
      if (actor.itemTypes.effect.some((e) => e._stats?.compendiumSource === a.effect)) continue;
      const src = await fromUuid(a.effect);
      if (src) await actor.createEmbeddedDocuments("Item", [src.toObject()]);
    }
  }
}
async function applyBlock(messageId, which) {
  const msg = game.messages.get(messageId);
  const f = msg?.flags[MOD];
  if (!f) return;
  for (const [i, r] of f.rows.entries()) {
    if (r.applied || !r.actions.length || (which !== "all" && Number(which) !== i)) continue;
    const actor = (await fromUuid(r.tokenUuid))?.actor;
    if (actor) { await applyActions(actor, r.actions); r.applied = true; }
  }
  await msg.update({ content: renderBlock(f.title, f.header, f.rows), [`flags.${MOD}.rows`]: f.rows });
}
async function useReaction(actorUuid, bonus) {
  const actor = await fromUuid(actorUuid);
  await actor?.createEmbeddedDocuments("Item", [{
    type: "effect", name: L("EffectName"), img: "icons/magic/movement/trail-streak-zigzag-yellow.webp",
    system: {
      slug: "effect-nimble-dodge-proto", // prototype: lasts until the start of our next turn, not "this attack only"
      duration: { value: 1, unit: "rounds", sustained: false, expiry: "turn-start" },
      rules: [{ key: "FlatModifier", selector: "ac", type: "circumstance", value: bonus }]
    }
  }]);
}

/* ---------- Zones: custom RegionBehavior type ---------- */
class ZoneBehavior extends foundry.data.regionBehaviors.RegionBehaviorType {
  static defineSchema() {
    return { condition: new foundry.data.fields.StringField({ required: true, initial: "concealed" }) };
  }
  static async #enter(event) {
    if (!game.user.isActiveGM) return;
    const actor = event.data.token.actor;
    if (!actor || actor.itemTypes.condition.some((c) => c.slug === this.condition)) return;
    const item = await actor.increaseCondition(this.condition);
    await item?.setFlag(MOD, "zone", this.region.id);
  }
  static async #exit(event) {
    if (!game.user.isActiveGM) return;
    const actor = event.data.token.actor;
    const item = actor?.itemTypes.condition.find((c) => c.getFlag(MOD, "zone") === this.region?.id);
    await item?.delete();
  }
  static events = { tokenEnter: this.#enter, tokenExit: this.#exit };
}

async function onRegion(region) {
  if (!game.user.isActiveGM) return;
  const origin = region.flags.pf2e?.origin;
  const rule = RULES[origin?.slug];
  if (!rule) return;
  if (rule.zone) {
    await region.setFlag(MOD, "expireAt", game.time.worldTime + rule.zone.seconds);
    await region.createEmbeddedDocuments("RegionBehavior", [{ type: ZONE_TYPE, name: L("ZoneBehavior"), system: { condition: rule.zone.condition } }]);
    await ChatMessage.create({ speaker: { alias: "Autoflow" }, content: `<div class="pf2e-autoflow af-note">${L("Zone", { name: region.name, condition: rule.zone.condition, seconds: rule.zone.seconds })}</div>` });
  }
  if (rule.steps && rule.area) {
    const message = game.messages.get(region.flags.pf2e?.messageId);
    const item = message?.item ?? (origin.uuid ? await fromUuid(origin.uuid) : null);
    // prototype: tokens are tested by center point at current elevation
    const targets = region.parent.tokens.filter((t) => t.object && region.testPoint({ ...t.object.center, elevation: t.elevation }));
    await postBlock({ item, targets, selfToken: null }, rule);
  }
}

/* ---------- Chat pipeline ---------- */
async function onMessage(message) {
  if (!game.user.isActiveGM || message.flags[MOD]) return;
  const mode = game.settings.get(MOD, "mode");
  if (mode === "off") return;
  const pf = message.flags.pf2e ?? {};
  const ctxType = pf.context?.type ?? "";

  // Reaction: attack roll against an actor that owns Nimble Dodge
  if (ctxType.includes("attack") && pf.context?.target?.actor) {
    const target = await fromUuid(pf.context.target.actor);
    const feat = target?.items.find((i) => RULES[slugOf(i)]?.reaction);
    if (feat) {
      const { bonus } = RULES[slugOf(feat)].reaction;
      const total = message.rolls[0]?.total, dc = pf.context.dc?.value;
      const flip = total != null && dc != null && [dc, dc + 10].some((t) => total >= t && total < t + bonus);
      const whisper = game.users.filter((u) => target.testUserPermission(u, "OWNER")).map((u) => u.id);
      await ChatMessage.create({
        whisper, speaker: { alias: "Autoflow" }, flags: { [MOD]: { reaction: true } },
        content: `<div class="pf2e-autoflow"><div class="af-title">${L("Reaction", { name: feat.name })}</div>
          <div class="af-note">${L("ReactionAttack", { target: target.name, total: total ?? "?", dc: dc ?? "?" })}</div>
          ${flip ? `<div class="af-deg-0">${L("ReactionFlip")}</div>` : ""}
          <button type="button" data-af="reaction" data-actor="${target.uuid}" data-bonus="${bonus}">${L("ReactionUse")}</button></div>`
      });
    }
    return;
  }

  // Item / action / spell usage
  const origin = pf.origin;
  if (!origin?.uuid || ctxType) return;
  const item = message.item ?? await fromUuid(origin.uuid);
  const rule = ruleFor(item);
  if (!rule?.steps || rule.area) return; // area rules wait for the region (onRegion)
  const actor = message.speakerActor;
  const selfToken = actor?.getActiveTokens(true, true)[0];
  const targets = [...(message.author?.targets ?? [])].map((t) => t.document); // prototype: relies on User#targets sync
  await postBlock({ item, targets, selfToken }, rule);
}

/* ---------- Wiring ---------- */
let socket;
Hooks.once("init", () => {
  CONFIG.RegionBehavior.dataModels[ZONE_TYPE] = ZoneBehavior;
  CONFIG.RegionBehavior.typeLabels[ZONE_TYPE] = "AFP1.ZoneBehavior";
  CONFIG.RegionBehavior.typeIcons[ZONE_TYPE] = "fa-solid fa-smog";
  game.settings.register(MOD, "mode", {
    name: "AFP1.Mode", hint: "AFP1.ModeHint", scope: "world", config: true, type: String, default: "button",
    choices: { button: "AFP1.ModeButton", auto: "AFP1.ModeAuto", off: "AFP1.ModeOff" }
  });
});
Hooks.once("socketlib.ready", () => {
  socket = socketlib.registerModule(MOD);
  socket.register("applyBlock", applyBlock);
  socket.register("useReaction", useReaction);
});
Hooks.on("createChatMessage", (m) => onMessage(m).catch(console.error));
Hooks.on("createRegion", (r) => onRegion(r).catch(console.error));
Hooks.on("updateWorldTime", (now) => {
  if (!game.user.isActiveGM || !canvas.scene) return;
  const ids = canvas.scene.regions.filter((r) => (r.getFlag(MOD, "expireAt") ?? Infinity) <= now).map((r) => r.id);
  if (ids.length) canvas.scene.deleteEmbeddedDocuments("Region", ids); // deletion fires tokenExit -> conditions removed
});
Hooks.on("renderChatMessageHTML", (message, html) => {
  html.querySelectorAll("[data-af]").forEach((btn) => btn.addEventListener("click", async () => {
    btn.disabled = true;
    if (btn.dataset.af === "apply") await socket.executeAsGM("applyBlock", message.id, btn.dataset.i);
    else await socket.executeAsGM("useReaction", btn.dataset.actor, Number(btn.dataset.bonus));
  }));
});
