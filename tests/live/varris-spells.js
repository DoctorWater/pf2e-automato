async () => {
  // Живая проверка заклинаний Варриса на временном чародее (копии из компендиума), союзнике и гоблине. Сотворение — системный путь
  // spellcasting.cast. Окна выбора (ChoiceSet) фиксируются и закрываются выбором первого варианта. Всё временное удаляется.
  const MOD = "pf2e-automato";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const out = { notes: [], prompts: [], spells: {} };
  const N = ui.notifications, orig = { warn: N.warn, info: N.info, error: N.error };
  for (const k of Object.keys(orig)) N[k] = function (m, ...r) { out.notes.push(`${k}: ${String(m).slice(0, 160)}`); return orig[k].call(this, m, ...r); };
  const prev = game.scenes.viewed;
  const myMsgs = new Set(); const hM = Hooks.on("createChatMessage", (m) => { if (m.author?.id === game.user.id) myMsgs.add(m.id); });
  const userFlags = foundry.utils.deepClone(game.user.flags.pf2e?.settings ?? {});
  let stopPrompts = false;
  const seen = new Set();
  (async () => {   // окна выбора: записать и выбрать первый вариант
    while (!stopPrompts) {
      for (const app of [...foundry.applications.instances.values()]) {
        const name = app.constructor.name;
        if (seen.has(app.id) || !/Prompt|Picker/i.test(name)) continue;
        seen.add(app.id);
        const el = app.element;
        const choices = [...(el?.querySelectorAll("[data-action=choose], button[value], .choice, select option") ?? [])].map((b) => b.textContent.trim()).slice(0, 8);
        out.prompts.push({ cls: name, title: app.title, choices });
        const btn = el?.querySelector("[data-action=choose], button[value], button.choice");
        if (btn) btn.click(); else el?.querySelector("button[type=submit], footer button")?.click();
      }
      await wait(200);
    }
  })();
  const scene = await Scene.create({ name: "AF tmp varris", width: 2000, height: 2000, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
  let sorc, ally, foe;
  try {
    await game.user.update({ "flags.pf2e.settings.showCheckDialogs": false, "flags.pf2e.settings.showDamageDialogs": false });
    await scene.view(); await wait(800);
    sorc = await Actor.create({ name: "AF tmp sorc", type: "character", folder: null, ownership: { default: 0 }, system: { resources: { focus: { max: 1, value: 1 } }, details: { alliance: "party" } } });
    ally = await Actor.create({ name: "AF tmp ally", type: "character", folder: null, ownership: { default: 0 }, system: { details: { alliance: "party" } } });
    const gob = await fromUuid("Compendium.pf2e.pathfinder-monster-core.Actor.fLLKuOXwPq1Iq0U4");
    foe = await Actor.create({ ...gob.toObject(), name: "AF tmp foe", folder: null, ownership: { default: 0 } });
    const eq = game.packs.get("pf2e.equipment-srd"), ei = await eq.getIndex({ fields: ["system.slug"] });
    const sw = (await eq.getDocument(ei.find((i) => i.system?.slug === "shortsword")._id)).toObject(); sw.system.equipped = { carryType: "held", handsHeld: 1 };
    await ally.createEmbeddedDocuments("Item", [sw]);
    const [spont, focus] = await sorc.createEmbeddedDocuments("Item", [
      { type: "spellcastingEntry", name: "AF спонтанные", system: { tradition: { value: "occult" }, prepared: { value: "spontaneous" }, ability: { value: "cha" }, slots: { slot1: { max: 4, value: 4 } } } },
      { type: "spellcastingEntry", name: "AF фокус", system: { tradition: { value: "occult" }, prepared: { value: "focus" }, ability: { value: "cha" } } }
    ]);
    const SP = "Compendium.pf2e.spells-srd.Item.";
    const plan = [
      ["shield", "TVKNbcgTee19PXZR", "none"], ["figment", "0zU8CPejjQFnhZFI", "none"], ["telekinetic-projectile", "60sgbuMWN0268dB7", "foe"],
      ["guidance", "izcxFQFwf3woCnFs", "ally"], ["daze", "4gBIw4IDrSfFHik4", "foe"], ["tentacular-limbs", "i8PBZsnoCrK7IWph", "none"],
      ["forbidding-ward", "RA7VKcen3p56rVyZ", "ally"], ["runic-weapon", "TFitdEOpQC4SzKQQ", "ally"], ["phantom-pain", "R8bqnYiThB6MYTxD", "foe"],
      ["force-barrage", "gKKqvLohtrSJj3BM", "foe"], ["soothe", "szIyEsvihc5e1w8n", "ally"]
    ];
    const docs = [];
    for (const [slug, id] of plan) { const d = (await fromUuid(SP + id)).toObject(); d.system.location = { value: slug === "tentacular-limbs" ? focus.id : spont.id }; docs.push(d); }
    await sorc.createEmbeddedDocuments("Item", docs);
    const mk = async (a, x, y, d) => (await scene.createEmbeddedDocuments("Token", [{ ...(await a.getTokenDocument({ x, y })).toObject(), disposition: d }]))[0];
    const tS = await mk(sorc, 500, 500, 1), tA = await mk(ally, 400, 500, 1), tF = await mk(foe, 700, 500, -1);
    await scene.updateEmbeddedDocuments("Token", [{ _id: tS.id, disposition: 1 }, { _id: tA.id, disposition: 1 }, { _id: tF.id, disposition: -1 }]);
    await wait(800);
    out.disp = [tS, tA, tF].map((t) => scene.tokens.get(t.id).disposition);
    const A = { sorc: () => sorc, ally: () => ally, foe: () => scene.tokens.get(tF.id).actor };
    const state = (a) => a.items.filter((i) => ["condition", "effect"].includes(i.type) && i.system.slug !== "af-pen").map((i) => `${i.system.slug ?? i.name}${i.system.value?.value ? ":" + i.system.value.value : ""}${i.flags?.[MOD]?.meta ? "*" : ""}`);
    const all = () => Object.fromEntries(Object.entries(A).map(([k, f]) => [k, state(f())]));
    const clearAll = async () => { for (const f of Object.values(A)) { const a = f(); const ids = a.items.filter((i) => ["condition", "effect"].includes(i.type) && i.system.slug !== "af-pen").map((i) => i.id); if (ids.length) await a.deleteEmbeddedDocuments("Item", ids); } };
    if (window.__afWillPen) await A.foe().createEmbeddedDocuments("Item", [{ type: "effect", name: "AF pen", system: { slug: "af-pen", rules: [{ key: "FlatModifier", selector: "will", value: window.__afWillPen }] } }]);
    const block = (m) => document.querySelector(`#chat [data-message-id="${m.id}"] .pf2e-automato`);
    const only = window.__afOnly ?? null;
    for (const [slug, , who] of plan) {
      if (only && !only.includes(slug)) continue;
      await clearAll();
      tS.object.control({ releaseOthers: true });
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
      if (who === "ally") tA.object.setTarget(true, { releaseOthers: true });
      if (who === "foe") tF.object.setTarget(true, { releaseOthers: true });
      if (slug === "forbidding-ward") tF.object.setTarget(true, { releaseOthers: false });
      await wait(300);
      const spell = sorc.itemTypes.spell.find((s) => s.slug === slug);
      const since = Date.now();
      let err = null;
      try { await spont.update({ "system.slots.slot1.value": 4 }); await spell.spellcasting.cast(spell, { rank: spell.rank }); } catch (e) { err = String(e?.message ?? e).slice(0, 200); }
      await wait(6000);
      const msgs = game.messages.contents.filter((m) => m._stats.createdTime >= since);
      const card = msgs.find((m) => m.flags.pf2e?.origin?.uuid === spell.uuid);
      const use = card?.flags?.[MOD]?.use;
      const r = {
        err, targets: [...game.user.targets].map((t) => t.name),
        card: !!card, use: use ? { kind: use.kind, yielded: use.state?.yielded ?? null, done: !!use.state?.done, results: Object.fromEntries(Object.entries(use.state?.challenge?.results ?? {}).map(([k, v]) => [k, v.degree])), dc: use.dc } : null,
        buttons: card ? [...(block(card)?.querySelectorAll("button[data-action]") ?? [])].map((b) => `${b.dataset.action}${b.disabled ? "(off)" : ""}`) : [],
        blockText: card ? (block(card)?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300) : null,
        otherMsgs: msgs.filter((m) => m !== card).map((m) => `${m.speaker?.alias}:${m.flags.pf2e?.context?.type ?? "-"}:${m.flags.pf2e?.context?.outcome ?? ""}:${m.flags.pf2e?.context?.dc?.value ?? ""}`),
        before: all()
      };
      if (card && use?.rule?.onUse?.challenge) {
        const el = document.querySelector(`#chat [data-message-id="${card.id}"]`);
        r.tbButtons = [...(el?.querySelectorAll("[data-action]") ?? [])].map((b) => `${b.dataset.action}|${b.closest("[class*=toolbelt]")?.className?.slice(0, 40) ?? ""}|${b.textContent.trim().slice(0, 30)}`);
        const roll = [...(el?.querySelectorAll("[data-action]") ?? [])].find((b) => /roll-save|rollSave|roll/i.test(b.dataset.action) && b.closest("[class*=toolbelt]"));
        r.tbClicked = roll?.dataset.action ?? null;
        roll?.click(); await wait(5000);
        const u2 = game.messages.get(card.id)?.flags?.[MOD]?.use;
        r.resultsAfterToolbelt = Object.fromEntries(Object.entries(u2?.state?.challenge?.results ?? {}).map(([k, v]) => [k, v.degree]));
        r.buttonsAfterToolbelt = [...(block(card)?.querySelectorAll("button[data-action]") ?? [])].map((b) => `${b.dataset.action}${b.disabled ? "(off)" : ""}`);
        r.toolbeltSaves = foundry.utils.deepClone(card.flags?.["pf2e-toolbelt"] ?? null);
      }
      if (card) for (const b of [...(block(card)?.querySelectorAll("button[data-action^=apply]:not([disabled])") ?? [])]) { b.click(); await wait(1200); }
      r.after = all();
      if (slug === "forbidding-ward") r.dbg = { useToken: use?.token, myDisp: use?.token ? (await fromUuid(use.token))?.disposition : null, targets: await Promise.all((use?.targets ?? []).map(async (t) => ({ uuid: t.uuid, disp: (await fromUuid(t.uuid))?.disposition }))) };
      if (slug === "forbidding-ward") r.mark = { allyMark: ally.itemTypes.effect.find((e) => e.slug === "spell-effect-forbidding-ward")?.system.rules.find((x) => x.key === "TokenMark")?.uuid ?? null, foeToken: tF.uuid, allyMarks: [...(ally.synthetics?.tokenMarks?.entries() ?? [])] };
      if (slug === "shield") r.shield = { level: sorc.itemTypes.effect.find((e) => e.slug === "spell-effect-shield")?.level, hardness: sorc.attributes.shield?.hardness, raised: sorc.attributes.shield?.raised };
      out.spells[slug] = r;
    }
    if (!only) {
      // повторное Наставление при действующем иммунитете
      await clearAll();
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false })); tA.object.setTarget(true, { releaseOthers: true }); tS.object.control({ releaseOthers: true });
      const g = sorc.itemTypes.spell.find((x) => x.slug === "guidance");
      await g.spellcasting.cast(g, { rank: g.rank }); await wait(4000);
      const first = state(ally);
      await g.spellcasting.cast(g, { rank: g.rank }); await wait(4000);
      out.guidanceRecast = { first, second: state(ally) };
      // Фантомная боль по цели с иммунитетом к ментальному (крит. провал)
      await clearAll();
      await A.foe().createEmbeddedDocuments("Item", [{ type: "effect", name: "AF mindless", system: { slug: "af-pen", rules: [{ key: "Immunity", type: "mental" }, { key: "FlatModifier", selector: "will", value: -30 }] } }]);
      game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false })); tF.object.setTarget(true, { releaseOthers: true });
      const pp = sorc.itemTypes.spell.find((x) => x.slug === "phantom-pain");
      const since = Date.now();
      await spont.update({ "system.slots.slot1.value": 4 }); await pp.spellcasting.cast(pp, { rank: pp.rank }); await wait(3000);
      const card = game.messages.contents.find((m) => m._stats.createdTime >= since && m.flags.pf2e?.origin?.uuid === pp.uuid);
      const el = document.querySelector(`#chat [data-message-id="${card?.id}"]`);
      [...(el?.querySelectorAll("[data-action=roll-save]") ?? [])].forEach((b) => b.click()); await wait(4000);
      for (const b of [...(block(card)?.querySelectorAll("button[data-action^=apply]:not([disabled])") ?? [])]) { b.click(); await wait(1200); }
      out.mindless = { results: Object.fromEntries(Object.entries(game.messages.get(card?.id)?.flags?.[MOD]?.use?.state?.challenge?.results ?? {}).map(([k, v]) => [k, v.degree])), foe: state(A.foe()) };
    }
  } catch (e) { out.fatal = String(e?.stack ?? e).slice(0, 600); }
  finally {
    stopPrompts = true;
    Object.assign(N, orig); Hooks.off("createChatMessage", hM);
    await game.user.update({ "flags.pf2e.settings": userFlags });
    game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false }));
    if (myMsgs.size) await ChatMessage.deleteDocuments([...myMsgs].filter((id) => game.messages.has(id)));
    await prev?.view(); await scene.delete(); await sorc?.delete(); await ally?.delete(); await foe?.delete();
    out.cleanup = { leftActors: game.actors.filter((a) => /^AF tmp/.test(a.name)).length };
  }
  window.__afVarris = out; return out;
}
