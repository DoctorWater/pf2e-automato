async () => {
  // Живой сценарий «по одному в каждой руке»: копия «AF тест: …» актёра со стопкой одноручного оружия (по умолчанию «Меллик Легкоступ»).
  // Проверяется: пункт в меню «как нести» есть у стопки и нет у одиночного; клик ставит флаг dual, held/handsHeld 2; значок строки;
  // Двойной финт видит двух кандидатов; у «Меча-бастарда» (two-hand-d12; у трезубца в pf2e 8.7 этой черты нет) кость не растёт при dual
  // и растёт при обычных «двух руках»; «одна рука» снимает флаг; на листе NPC пункт тоже есть и ставит флаг.
  // Меню — locked-tooltip (aside.locked-tooltip.carry-type-menu); сам #tooltip ядра тоже носит класс carry-type-menu, его не трогаем.
  // Параметры: window.__afDW = { actor: "<имя или id>", cleanOnly }. Результат — window.__afDWResult. Нужны открытые листы (рендер меню), активный ГМ не обязателен.
  const MOD = "pf2e-automato", PFX = "AF тест: ";
  const opts = { actor: "Меллик Легкоступ", ...(window.__afDW ?? {}) };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const waitFor = async (fn, ms = 6000, step = 150) => {
    const end = Date.now() + ms;
    while (Date.now() < end) { try { const v = await fn(); if (v) return v; } catch { /* ещё не готово */ } await wait(step); }
    return null;
  };
  const sweep = async () => {
    for (const a of game.actors.filter((a) => a.name.startsWith(PFX))) { a.sheet?.close?.({ force: true }); await a.delete().catch(() => {}); }
    return game.actors.filter((a) => a.name.startsWith(PFX)).length;
  };
  if (opts.cleanOnly) return { left: await sweep() };

  const fails = []; let n = 0;
  const ok = (c, label) => { n++; if (!c) fails.push(label); };
  let result;
  try {
    const src = game.actors.get(opts.actor) ?? game.actors.getName(opts.actor);
    if (!src) return (window.__afDWResult = [`SKIP: нет актёра ${opts.actor}`]);
    const d = src.toObject(); delete d._id; delete d.folder;
    const a = await Actor.create({ ...d, name: PFX + src.name, folder: null, ownership: { default: 0 } });
    const pack = game.packs.get("pf2e.equipment-srd"), idx = await pack.getIndex({ fields: ["system.slug"] });
    const tObj = (await pack.getDocument(idx.find((i) => i.system?.slug === "bastard-sword")._id)).toObject(); delete tObj._id;
    tObj.system.quantity = 2; tObj.system.equipped = { carryType: "held", handsHeld: 1 };
    const [tr] = await a.createEmbeddedDocuments("Item", [tObj]);
    const single = a.itemTypes.weapon.find((w) => w.id !== tr.id && w.system.quantity === 1 && w.system.usage.hands === 1);
    await a.sheet.render(true); await wait(1500);
    const { twoWeaponCandidates } = await import(`/modules/${MOD}/scripts/builtin/strikes.mjs`);
    const dual = (it) => !!it.getFlag(MOD, "dual");
    const die = () => a.system.actions.find((s) => s.item.id === tr.id)?.item.system.damage.die;
    const cands = () => twoWeaponCandidates(a.system.actions).filter((s) => s.item.id === tr.id).length;
    const MENU = "aside.locked-tooltip.carry-type-menu", closeMenu = () => game.tooltip.dismissLockedTooltips();
    const menu = async (item, sheet = a.sheet) => {
      closeMenu();
      sheet.element[0]?.querySelector(`li[data-item-id="${item.id}"] [data-action="open-carry-type-menu"]`)?.click();
      return waitFor(() => document.querySelector(MENU), 3000);
    };
    const pickItem = async (sel) => {
      const m = await menu(tr), el = m?.querySelector(sel);
      el?.click(); await wait(1200);
      return !!el;
    };

    // исходно «одна рука»: кость базовая
    await tr.update({ "system.equipped": { carryType: "held", handsHeld: 1 } }); await wait(500);
    const base = die();
    // обычные «две руки»: pf2e поднимает кость; пункта «по одному» у стопки есть
    const m1 = await menu(tr);
    ok(!!m1?.querySelector("a[data-af-dual]"), "в меню стопки есть пункт «по одному в каждой руке»");
    m1?.querySelector('a[data-hands-held="2"]')?.click(); await wait(1200);
    ok(tr.system.equipped.handsHeld === 2 && !dual(tr), "«две руки»: handsHeld 2, флага нет");
    ok(die() !== base, `без dual кость растёт (${base} -> ${die()})`);
    ok(cands() === 0, "двуручный хват без dual — не пара");
    // «по одному в каждой руке»
    const m2 = await menu(tr);
    ok(m2?.querySelector('a[data-hands-held="2"]')?.classList.contains("selected"), "«две руки» выделено, пока нет флага");
    m2?.querySelector("a[data-af-dual]")?.click(); await wait(1500);
    ok(dual(tr) && tr.system.equipped.carryType === "held" && tr.system.equipped.handsHeld === 2, "клик ставит флаг dual, held, handsHeld 2");
    ok(!!a.sheet.element[0]?.querySelectorAll?.(`li[data-item-id="${tr.id}"] .fa-stack[data-af-dual]`).length, "в строке предмета значок «две руки по 1»");
    ok(die() === base, `при dual кость не растёт (${base} -> ${die()})`);
    ok(cands() === 2, `Двойной финт видит двух кандидатов (${cands()})`);
    const m3 = await menu(tr);
    ok(m3?.querySelector("a[data-af-dual]")?.classList.contains("selected"), "в меню выделен «по одному в каждой руке»");
    ok(!m3?.querySelector('a[data-hands-held="2"]')?.classList.contains("selected"), "«две руки» не выделено");
    closeMenu();
    // «одна рука» снимает флаг
    ok(await pickItem('a[data-hands-held="1"]'), "пункт «одна рука» есть");
    ok(!dual(tr) && tr.system.equipped.handsHeld === 1, "«одна рука» снимает флаг");
    ok(die() === base, "кость базовая");
    // одиночное оружие: пункта нет
    if (single) { const m = await menu(single); ok(m && !m.querySelector("a[data-af-dual]"), "у одиночного оружия пункта нет"); closeMenu(); }
    // лист NPC: то же меню (CreatureSheetPF2e), пункт ставит флаг
    const npc = await Actor.create({ name: PFX + "NPC", type: "npc", ownership: { default: 0 }, items: [tObj] }), nw = npc.itemTypes.weapon[0];
    await npc.sheet.render(true); await wait(1500);
    const mn = await menu(nw, npc.sheet);
    ok(!!mn?.querySelector("a[data-af-dual]"), "NPC: в меню стопки есть пункт");
    mn?.querySelector("a[data-af-dual]")?.click(); await wait(1500);
    ok(dual(nw) && nw.system.equipped.handsHeld === 2, "NPC: клик ставит флаг dual, handsHeld 2");
    closeMenu();
    result = fails.length ? [`FAIL: ${fails.join("; ")}`] : [`PASS: ${n} проверок`];
  } catch (err) {
    console.error(`${MOD} dual-wield`, err);
    result = [`FAIL: ${fails.join("; ")} ошибка: ${String(err?.message ?? err).slice(0, 300)}`];
  } finally {
    const left = await sweep();
    if (left) result.push(`после уборки осталось: ${left}`);
  }
  window.__afDWResult = result;
  return result;
}
