async () => {
  // Живая проверка п.1–2: базовые действия, Грязный приём, Кристалл усиления, Чёрный порох, Реагирующий удар / Возможность для атаки /
  // Старая выучка (кнопка «Ударить»), Обманка, Танец клинков, Оплетающая лоза. Только временные актёры (NPC кампании — копии), сцена, с уборкой.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = window.__afP12 = { notes: [], prompts: [], dialogs: [] };
  const N = ui.notifications, orig = { warn: N.warn, info: N.info, error: N.error };
  for (const k of Object.keys(orig)) N[k] = function (m, ...r) { out.notes.push(`${k}: ${String(m).slice(0, 160)}`); return orig[k].call(this, m, ...r); };
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const userFlags = foundry.utils.deepClone(game.user.flags.pf2e?.settings ?? {});
  const tbPrev = game.settings.get(MOD, "useToolbeltTargetHelper");
  let stop = false; const seen = new Set();
  (async () => {   // окна: ChoiceSet pf2e — первый вариант; наши DialogV2 — кнопка ok/первая
    while (!stop) {
      for (const app of [...foundry.applications.instances.values()]) {
        if (seen.has(app.id) || !app.element) continue;
        const cls = app.constructor.name;
        if (/Prompt|Picker/i.test(cls)) {
          seen.add(app.id);
          out.prompts.push({ cls, title: app.title, html: app.element.innerHTML.replace(/\s+/g, " ").slice(0, 300) });
          if (Array.isArray(app.choices) && app.choices.length) { app.selection = app.choices[0]; app.close(); }
        } else if (app instanceof foundry.applications.api.DialogV2 && out.answerDialogs) {
          seen.add(app.id);
          out.dialogs.push(app.title);
          (app.element.querySelector("button[data-action=ok]") ?? app.element.querySelector("footer button"))?.click();
        }
      }
      await wait(200);
    }
  })();
  out.answerDialogs = true;
  const scene = await Scene.create({ name: "AF tmp p12", width: 2400, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
  const actors = [];
  const only = window.__afP12Only ?? null;
  const step = async (name, fn) => { if (only && !only.includes(name)) return; try { out[name] = await fn(); } catch (e) { out[name] = { error: String(e?.stack ?? e).slice(0, 400) }; } };
  try {
    await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    await game.settings.set(MOD, "useToolbeltTargetHelper", false);   // спасброски NPC — автоброском ГМа (Toolbelt проверен отдельно)
    await scene.view(); await wait(800);
    const mkActor = async (data) => { const a = await Actor.create({ folder: null, ownership: { default: 0 }, ...data }); actors.push(a); return a; };
    const gob = (await fromUuid("Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4")).toObject();
    const bonus = { type: "effect", name: "AF bonus", system: { slug: "af-bonus", rules: [{ key: "FlatModifier", selector: ["skill-check", "strike-attack-roll", "spell-attack-roll"], value: 30 }] } };
    const hero = await mkActor({ name: "AF tmp hero", type: "character", system: { details: { alliance: "party", languages: { value: ["common"] } } } });
    const ally = await mkActor({ name: "AF tmp ally", type: "character", system: { details: { alliance: "party" } } });
    const foe = await mkActor({ ...gob, name: "AF tmp foe", folder: null, ownership: { default: 0 } });
    const foe2 = await mkActor({ ...gob, name: "AF tmp foe2", folder: null, ownership: { default: 0 } });
    const eq = game.packs.get("pf2e.equipment-srd"), ei = await eq.getIndex({ fields: ["system.slug"] });
    const fp = game.packs.get("pf2e.feats-srd"), fi = await fp.getIndex({ fields: ["system.slug"] });
    const ap = game.packs.get("pf2e.actionspf2e"), ai = await ap.getIndex({ fields: ["system.slug"] });
    const cp = game.packs.get("pf2e.classfeatures"), ci = await cp.getIndex({ fields: ["system.slug"] });
    const get = async (pack, idx, slug) => { const e = idx.find((i) => i.system?.slug === slug); if (!e) { out.notes.push(`нет в компендиуме: ${slug}`); return null; } return (await pack.getDocument(e._id)).toObject(); };
    const held = (d, hands = 1) => { if (!d) return null; d.system.equipped = { carryType: "held", handsHeld: hands }; return d; };
    await hero.createEmbeddedDocuments("Item", [bonus, held(await get(eq, ei, "shortsword")), held(await get(eq, ei, "crossbow"), 2),
      await get(fp, fi, "dirty-trick"), await get(fp, fi, "fake-out"), await get(fp, fi, "bon-mot"), await get(cp, ci, "reactive-strike"),
      await get(eq, ei, "potency-crystal"), await get(eq, ei, "black-powder-horn"),
      await get(ap, ai, "aid"), await get(ap, ai, "treat-poison"), await get(ap, ai, "treat-disease"), await get(ap, ai, "drop-prone")].filter(Boolean));
    const anc = game.packs.get("pf2e.ancestries"); const human = (await anc.getDocument((await anc.getIndex({ fields: ["system.slug"] })).find((i) => i.system?.slug === "human")._id)).toObject();
    await hero.createEmbeddedDocuments("Item", [human]); await ally.createEmbeddedDocuments("Item", [foundry.utils.deepClone(human)]);
    await hero.update({ "system.attributes.hp.value": 8 }); await ally.update({ "system.attributes.hp.value": 8 });
    out.hp = [hero.hitPoints?.value, ally.hitPoints?.value];
    await ally.createEmbeddedDocuments("Item", [bonus, held(await get(eq, ei, "shortsword"))]);
    const mk = async (a, x, y, d) => { const [t] = await scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition: d }]); return t; };
    const tH = await mk(hero, 500, 500, 1), tA = await mk(ally, 400, 500, 1), tF = await mk(foe, 600, 500, -1), tF2 = await mk(foe2, 600, 600, -1);
    await wait(800);
    const T = (t) => scene.tokens.get(t.id);
    const st = (a) => a.items.filter((i) => ["condition", "effect"].includes(i.type) && !/^af-bonus/.test(i.system.slug ?? "")).map((i) => `${i.system.slug ?? i.name}${i.system.value?.value ? ":" + i.system.value.value : ""}${i.flags?.[MOD]?.meta ? "*" : ""}`);
    const clear = async () => { for (const t of [tH, tA, tF, tF2]) { const a = T(t).actor; const ids = a.items.filter((i) => ["condition", "effect"].includes(i.type) && !/^af-bonus/.test(i.system.slug ?? "")).map((i) => i.id); if (ids.length) await a.deleteEmbeddedDocuments("Item", ids); } };
    const aim = async (ctrl, ...targets) => { T(ctrl).object.control({ releaseOthers: true }); game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false })); for (const t of targets) T(t).object.setTarget(true, { releaseOthers: false }); await wait(250); };
    const block = (m) => document.querySelector(`#chat [data-message-id="${m?.id}"] .pf2e-automato`);
    const clickApply = async (m) => { for (const b of [...(block(m)?.querySelectorAll("button[data-action^=apply]:not([disabled])") ?? [])]) { b.click(); await wait(1200); } };
    const since = () => Date.now();
    const msgsFrom = (t) => game.messages.contents.filter((m) => m._stats.createdTime >= t);
    const res = (m) => Object.fromEntries(Object.entries(game.messages.get(m?.id)?.flags?.[MOD]?.use?.state?.challenge?.results ?? {}).map(([k, v]) => [k, v.degree]));

    // --- базовые действия через систему ---
    for (const slug of ["grapple", "shove", "disarm", "reposition", "tumble-through", "create-a-diversion"]) {
      await step(`act:${slug}`, async () => {
        await clear(); await aim(tH, tF);
        const t0 = since();
        await game.pf2e.actions.get(slug).use({ actors: [hero], multipleAttackPenalty: 0, ...(slug === "create-a-diversion" && { variant: "gesture" }) });
        await wait(3500);
        const m = msgsFrom(t0).find((x) => x.flags?.pf2e?.context?.options?.includes(`action:${slug}`));
        const r = { outcome: m?.flags.pf2e.context.outcome ?? null, ours: !!game.messages.get(m?.id)?.flags?.[MOD]?.use, results: res(m), buttons: [...(block(m)?.querySelectorAll("button[data-action]") ?? [])].map((b) => b.dataset.action), text: (block(m)?.textContent ?? "").replace(/\s+/g, " ").slice(0, 200) };
        await clickApply(m); await wait(500);
        return { ...r, foe: st(T(tF).actor), hero: st(hero) };
      });
    }
    // Высвобождение: герой схвачен гоблином
    await step("act:escape", async () => {
      await clear(); await hero.increaseCondition("grabbed"); await aim(tH, tF);
      const t0 = since();
      await game.pf2e.actions.get("escape").use({ actors: [hero] }); await wait(3500);
      const m = msgsFrom(t0).find((x) => x.flags?.pf2e?.context?.options?.includes("action:escape"));
      return { outcome: m?.flags.pf2e.context.outcome ?? null, ours: !!game.messages.get(m?.id)?.flags?.[MOD]?.use, text: (block(m)?.textContent ?? "").replace(/\s+/g, " ").slice(0, 200), hero: st(hero) };
    });
    // --- действия и черты карточкой ---
    const card = async (actor, slug, ...targets) => {
      await clear(); await aim(targets.shift() ?? tH, ...targets);
      const it = actor.items.find((i) => i.slug === slug);
      const t0 = since();
      await it.toMessage(undefined, { create: true }); await wait(5000);
      const ms = msgsFrom(t0), c = ms.find((x) => x.flags?.pf2e?.origin?.uuid === it.uuid);
      const r = { card: !!c, use: game.messages.get(c?.id)?.flags?.[MOD]?.use?.kind ?? null, results: res(c), buttons: [...(block(c)?.querySelectorAll("button[data-action]") ?? [])].map((b) => b.dataset.action), text: (block(c)?.textContent ?? "").replace(/\s+/g, " ").slice(0, 220), rolls: ms.filter((x) => x.flags?.pf2e?.context).map((x) => `${x.flags.pf2e.context.type}:${x.flags.pf2e.context.outcome ?? ""}`) };
      await clickApply(c); await wait(500);
      return { ...r, hero: st(hero), ally: st(ally), foe: st(T(tF).actor) };
    };
    await step("dirty-trick", () => card(hero, "dirty-trick", tH, tF));
    await step("bon-mot", () => card(hero, "bon-mot", tH, tF));
    await step("aid", () => card(hero, "aid", tH, tA));
    await step("treat-poison", () => card(hero, "treat-poison", tH, tA));
    await step("treat-disease", () => card(hero, "treat-disease", tH, tA));
    await step("drop-prone", () => card(hero, "drop-prone", tH));
    // --- расходники ---
    await step("potency-crystal", async () => {
      await clear(); await aim(tH);
      const it = hero.items.find((i) => i.slug === "potency-crystal");
      await it.consume(); await wait(4000);
      return { hero: st(hero), weapons: hero.itemTypes.weapon.map((w) => `${w.name}:${w.system.runes?.potency ?? 0}`) };
    });
    await step("black-powder-horn", async () => {
      await clear(); await aim(tH);
      const it = hero.items.find((i) => i.slug === "black-powder-horn");
      const t0 = since();
      await it.consume(); await wait(2500);
      const c = msgsFrom(t0).find((x) => x.flags?.pf2e?.origin?.uuid === it.uuid || x.flags?.pf2e?.origin?.slug === "black-powder-horn");
      const use = game.messages.get(c?.id)?.flags?.[MOD]?.use;
      const origin = c?.flags?.pf2e?.origin;
      const r = { card: !!c, use: use ? { kind: use.kind, targets: use.rule?.onUse?.targets, challenge: use.rule?.onUse?.challenge?.statistic ?? null, awaiting: !!use.state?.awaitingRegion } : null };
      if (c && origin) {
        const [reg] = await scene.createEmbeddedDocuments("Region", [{ name: it.name, shapes: [{ type: "circle", radius: 150, x: 650, y: 550 }], color: "#ff6600", highlightMode: "coverage",
          visibility: CONST.REGION_VISIBILITY.ALWAYS, flags: { pf2e: { areaShape: "burst", messageId: c.id, origin } } }]);
        await wait(5000);
        r.results = res(c); r.text = (block(c)?.textContent ?? "").replace(/\s+/g, " ").slice(0, 250);
        await reg?.delete();
      }
      return r;
    });
    // --- реакции-Удары ---
    const rs = await import("/modules/pf2e-automato/scripts/builtin/reactive-strike.mjs");
    const whispersSince = (t) => msgsFrom(t).filter((m) => m.flags?.[MOD]?.builtin === "reactive-strike");
    const pressStrike = async (m) => { const b = document.querySelector(`#chat [data-message-id="${m.id}"] [data-af-react-strike]`); b?.click(); await wait(4500); return !!b; };
    await step("reactive-strike", async () => {
      await clear();
      const t0 = since();
      await rs.onMessage({ speaker: { scene: scene.id, token: tF.id }, flags: { pf2e: { origin: { rollOptions: ["origin:item:trait:manipulate"] } } } }); await wait(1500);
      const w = whispersSince(t0);
      const t1 = since();
      const pressed = w[0] ? await pressStrike(w[0]) : false;
      return { whispers: w.length, pressed, strikes: msgsFrom(t1).filter((m) => m.flags?.pf2e?.context?.type === "attack-roll").map((m) => `${m.speaker.alias}->${m.flags.pf2e.context.target?.token?.split(".").pop() === tF.id ? "foe" : "?"}:${m.flags.pf2e.context.outcome}`) };
    });
    await step("attack-of-opportunity", async () => {
      await clear();
      await foe2.createEmbeddedDocuments("Item", [{ type: "action", name: "Возможность для атаки", system: { slug: "attack-of-opportunity", actionType: { value: "reaction" } } }]);
      const t0 = since();
      await rs.onMessage({ speaker: { scene: scene.id, token: tH.id }, flags: { pf2e: { origin: { rollOptions: ["origin:item:trait:manipulate"] } } } }); await wait(1500);
      const w = whispersSince(t0);
      const r = { whispers: w.map((m) => m.flags[MOD].strike?.actor === T(tF2).actor.uuid ? "foe2" : m.flags[MOD].strike?.actor === T(tF).actor.uuid ? "foe" : "?") };
      await T(tF2).actor.deleteEmbeddedDocuments("Item", T(tF2).actor.items.filter((i) => i.slug === "attack-of-opportunity").map((i) => i.id));
      return r;
    });
    await step("old-training", async () => {
      await clear();
      await T(tF2).actor.createEmbeddedDocuments("Item", [{ type: "action", name: "Старая выучка", system: { slug: null, actionType: { value: "reaction" } } }]);
      const t0 = since();
      // герой наносит урон союзнику держателя (foe) — foe2 в досягаемости героя
      await rs.onMessage({ speaker: { scene: scene.id, token: tH.id }, flags: { pf2e: { origin: { rollOptions: [] }, context: { type: "damage-roll", target: { token: T(tF).uuid } } } } }); await wait(1500);
      const w = whispersSince(t0);
      const t1 = since();
      const pressed = w[0] ? await pressStrike(w[0]) : false;
      return { whispers: w.length, holder: w[0]?.flags[MOD].strike?.actor === T(tF2).actor.uuid, pressed, strikes: msgsFrom(t1).filter((m) => m.flags?.pf2e?.context?.type === "attack-roll").map((m) => `${m.speaker.alias}:${m.flags.pf2e.context.outcome}`) };
    });
    // --- Обманка ---
    await step("fake-out", async () => {
      await clear(); await aim(tH, tF);
      const it = hero.items.find((i) => i.slug === "fake-out");
      const t0 = since();
      await it.toMessage(undefined, { create: true }); await wait(5000);
      const checks = msgsFrom(t0).filter((m) => m.flags?.pf2e?.context?.type === "check").map((m) => `${m.flags.pf2e.context.outcome}:${m.rolls[0]?.total}/dc${m.flags.pf2e.context.dc?.value}`);
      const allyEff = st(ally);
      const s = ally.system.actions.find((a) => a.item?.slug === "shortsword");
      const t1 = since();
      await s.variants[0].roll({ target: { document: T(tF) } }); await wait(2500);
      const atk = msgsFrom(t1).find((m) => m.flags?.pf2e?.context?.type === "attack-roll");
      return { checks, allyEff, aidMod: atk?.flags.pf2e.modifiers?.filter((x) => x.type === "circumstance").map((x) => `${x.label}:${x.modifier}`) ?? [], allyAfterAttack: st(ally) };
    });
    // --- NPC кампании: Танец клинков, Оплетающая лоза ---
    const clone = async (name) => { const src = game.actors.find((a) => a.name === name); if (!src) return null; const d = src.toObject(); delete d._id; return mkActor({ ...d, name: `AF tmp ${name}`, folder: null, ownership: { default: 0 } }); };
    await step("blade-dance", async () => {
      const ag = await clone("Теневой агент") ?? await clone("Мастер Львиных Клинков");
      if (!ag) return "нет NPC в мире";
      await ag.createEmbeddedDocuments("Item", [bonus]);
      const tAg = await mk(ag, 500, 600, -1); await wait(800);
      await clear(); await aim(tAg, tH);
      const it = T(tAg).actor.items.find((i) => i.name === "Танец клинков");
      const t0 = since();
      await it.toMessage(undefined, { create: true }); await wait(7000);
      const ms = msgsFrom(t0);
      return { strikes: T(tAg).actor.system.actions.filter((a) => a.item?.isMelee).map((a) => a.item.name), attacks: ms.filter((m) => m.flags?.pf2e?.context?.type === "attack-roll").map((m) => `${m.item?.name}:${m.flags.pf2e.context.outcome}:${m.flags.pf2e.modifiers?.find((x) => x.slug === "multiple-attack-penalty")?.modifier ?? 0}`), damage: ms.filter((m) => m.flags?.pf2e?.context?.type === "damage-roll").length, hero: st(hero) };
    });
    await step("tangle-vine", async () => {
      const py = await clone("Гоблин-пироман");
      if (!py) return "нет NPC в мире";
      await py.createEmbeddedDocuments("Item", [bonus]);
      const tPy = await mk(py, 800, 500, -1); await wait(800);
      await clear(); await aim(tPy, tH);
      const sp = T(tPy).actor.itemTypes.spell.find((s) => s.slug === "tangle-vine");
      const t0 = since();
      await sp.spellcasting.cast(sp, { rank: sp.rank }); await wait(2000);
      const castCard = msgsFrom(t0).find((m) => m.flags?.pf2e?.origin?.uuid === sp.uuid);
      const t1 = since();
      await sp.rollAttack?.(new MouseEvent("click")); await wait(4000);
      const atk = msgsFrom(t1).find((m) => m.flags?.pf2e?.context?.type === "attack-roll");
      const r = { castSnapshot: !!game.messages.get(castCard?.id)?.flags?.[MOD]?.use, attack: atk?.flags.pf2e.context.outcome ?? null, results: res(atk), buttons: [...(block(atk)?.querySelectorAll("button[data-action]") ?? [])].map((b) => b.dataset.action) };
      await clickApply(atk); await wait(800);
      return { ...r, hero: st(hero) };
    });
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 500); }
  finally {
    stop = true; out.answerDialogs = false;
    Object.assign(N, orig); Hooks.off("createChatMessage", hM);
    try { await game.settings.set(MOD, "useToolbeltTargetHelper", tbPrev); } catch { }
    await game.user.update({ "flags.pf2e.settings": userFlags });
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete();
    for (const a of actors) await a.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length, tb: game.settings.get(MOD, "useToolbeltTargetHelper") };
  }
  return out;
}
