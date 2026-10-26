async () => {
  // Живая проверка эффектов обхода укрытия пака модуля (plan-cover-bypass.md): проводник на атакующем (EphemeralEffect + носитель removeAfterRoll) -> КБ в броске ниже.
  // Вкладка активного ГМа-лидера. NPC-атакующий бьёт ближним Ударом по цели с «Effect: Cover» (уровень — через rule.selection, как scripts/hud.mjs setCover).
  // Проверяет: КБ из message.flags.pf2e.context.dc.value для форм all / L / LS / LSG / step на укрытии lesser / standard / greater; проводник снят после броска, второй Удар — обычное КБ.
  // Результат: { summary, rows:[{id, ok, detail}] }; console.table и window.__afCoverBypassResult. «AF тест: …» удаляются в конце.
  const MOD = "pf2e-automato", PFX = "AF тест: ", P = `Compendium.${MOD}.effects.Item.`, COVER_UUID = "Compendium.pf2e.other-effects.Item.I9lfZUiCwMiGogVi";
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(150); } return null; };
  const rows = [], check = (id, ok, detail = "") => rows.push({ id, ok: !!ok, detail: String(detail) });
  const FORM = { all: "pAfCoverAll00001", L: "pAfCoverL0000001", LS: "pAfCoverLS000001", LSG: "pAfCoverLSG00001", step: "pAfCoverStep0001" };
  const BONUS = { lesser: 1, standard: 2, greater: 4 };
  // КБ после формы: сколько остаётся от бонуса укрытия
  const LEFT = { all: { lesser: 0, standard: 0, greater: 0 }, L: { lesser: 0, standard: 2, greater: 4 }, LS: { lesser: 0, standard: 0, greater: 4 }, LSG: { lesser: 0, standard: 0, greater: 2 }, step: { lesser: 0, standard: 1, greater: 2 } };
  const made = { scene: null, actors: [], msgs: [] };
  const prevScene = game.scenes.viewed;
  try {
    const scene = made.scene = await Scene.create({ name: `${PFX}cover`, width: 1500, height: 1500, padding: 0, grid: { size: 100, distance: 5 }, navigation: false, tokenVision: false });
    await scene.view(); await wait(800);
    const mk = async (name, type) => { const a = await Actor.create({ name: `${PFX}${name}`, type, folder: null, ownership: { default: 0 } }); made.actors.push(a); return a; };
    const att = await mk("атакующий", "npc"), foe = await mk("цель", "npc");
    await att.createEmbeddedDocuments("Item", [{ name: "AF Коготь", type: "melee", system: { bonus: { value: 10 }, damageRolls: { a: { damage: "1d4", damageType: "slashing" } } } }]);
    const mkTok = async (a, x, d) => (await scene.createEmbeddedDocuments("Token", [(await a.getTokenDocument({ x, y: 500, disposition: d })).toObject()]))[0];
    const tA = await mkTok(att, 500, -1), tF = await mkTok(foe, 600, 1);
    await wait(500);
    const A = () => scene.tokens.get(tA.id).actor, F = () => scene.tokens.get(tF.id).actor;
    const baseAC = F().system.attributes.ac.value;
    const setCover = async (lv, name) => {
      await F().deleteEmbeddedDocuments("Item", F().itemTypes.effect.filter((e) => e._stats?.compendiumSource === COVER_UUID).map((e) => e.id));
      if (!lv) return;
      const data = { ...(await fromUuid(COVER_UUID)).toObject(), _id: null }; if (name) { data.name = name; data.system.slug = null; } data._stats = { ...data._stats, compendiumSource: COVER_UUID };
      data.system.rules.find((r) => r.key === "ChoiceSet").selection = { bonus: BONUS[lv], level: lv };
      await F().createEmbeddedDocuments("Item", [data]); await wait(300);
    };
    const give = async (form) => { const src = await fromUuid(P + FORM[form]); await A().createEmbeddedDocuments("Item", [{ ...src.toObject(), _id: null }]); await wait(300); };
    const carrier = () => A().itemTypes.effect.filter((e) => e.system.slug?.startsWith("cover-bypass-"));
    const SHIFT = () => new MouseEvent("click", { shiftKey: !!game.user.flags.pf2e?.settings?.showCheckDialogs });
    const strike = async () => {
      scene.tokens.get(tF.id).object.setTarget(true, { releaseOthers: true, groupSelection: false }); await wait(300);
      const t0 = Date.now(), s = A().system.actions.find((x) => x.item?.type === "melee");
      await s.variants[0].roll({ event: SHIFT() });
      const m = await waitFor(() => game.messages.contents.find((x) => x.timestamp >= t0 && x.flags?.pf2e?.context?.type === "attack-roll"));
      if (m) made.msgs.push(m.id);
      return m?.flags?.pf2e?.context?.dc?.value;
    };
    check("base", baseAC > 0, `КБ цели ${baseAC}`);
    // имя копии Cover: язык мира как есть (null), slug `cover` и slug `укрытие` — поправки должны работать на обоих независимо от языка мира
    for (const nm of [null, "Effect: Cover", "Эффект: Укрытие"]) for (const lv of ["lesser", "standard", "greater"]) {
      const tag = `${nm ?? "мир"}/${lv}`;
      await setCover(lv, nm);
      const plain = await strike();
      check(`${tag}: без эффекта`, plain === baseAC + BONUS[lv], `КБ ${plain}, ждали ${baseAC + BONUS[lv]}`);
      for (const f of Object.keys(FORM)) {
        await give(f);
        const dc = await strike();
        check(`${tag}: ${f}`, dc === baseAC + LEFT[f][lv], `КБ ${dc}, ждали ${baseAC + LEFT[f][lv]}`);
        check(`${tag}: ${f} снят после броска`, await waitFor(() => !carrier().length, 4000), `осталось ${carrier().length}`);
        const again = await strike();
        check(`${tag}: ${f} второй Удар обычный`, again === baseAC + BONUS[lv], `КБ ${again}`);
      }
    }
    // без укрытия проводник тоже снимается (носитель срабатывает всегда), КБ не меняется
    await setCover(null); await give("all");
    const nc = await strike();
    check("без укрытия: КБ базовое", nc === baseAC, `КБ ${nc}`);
    check("без укрытия: проводник снят", await waitFor(() => !carrier().length, 4000));
  } catch (e) {
    check("exception", false, e?.stack ?? e);
  } finally {
    try { game.user.targets.forEach((t) => t.setTarget(false, { releaseOthers: false })); } catch { /* нет целей */ }
    try { if (made.msgs.length) await ChatMessage.deleteDocuments(made.msgs.filter((id) => game.messages.has(id))); } catch { /* уже нет */ }
    await made.scene?.delete().catch(() => {});
    for (const a of made.actors) await a.delete().catch(() => {});
    if (prevScene) await prevScene.view().catch(() => {});
  }
  const fails = rows.filter((r) => !r.ok), res = { summary: `ok ${rows.length - fails.length} / fail ${fails.length}`, rows };
  console.table(rows); window.__afCoverBypassResult = res;
  return res;
}
