// Эффекты пака модуля, написанные здесь, а не импортированные из pf2e-automations (0.5g4): у PA это пустые метки (kind script) или иммунитеты (kind immunity),
// а нам нужны настоящие Rule Elements по тексту pf2e. id — тот же, что у метки PA: ссылки правил PA и каталога остаются теми же.
// Запись попадает в packs/_source/effects и в tools/pa-effects.json как kind "own" (pa-effects.mjs: полный импорт и `--authored`).
const BLANK_DUR = { expiry: null, sustained: false };
const dur = (value, unit, expiry = null) => ({ ...BLANK_DUR, value, unit, expiry });

export const AUTHORED = {
  // 0.5d: Dirge of Doom у PA — эффект из Workbench (копировать нельзя), в pf2e 8.6.1 родного нет. Тот же id, что у эффекта Workbench: ссылка правила PA остаётся прежней.
  // Аура 30 фт. на врагов; выданный ею эффект даёт Frightened 1 и держит его, пока враг в ауре (аура вешает эффект заново каждый ход)
  wOcAf3pf04cTM4Uk: { name: "Effect: Dirge of Doom", level: 1, duration: dur(1, "rounds", "turn-start"), rules: [{ key: "Aura", slug: "aura-dirge-of-doom", radius: 30, traits: [], effects: [{ uuid: "Compendium.pf2e-automato.effects.Item.dRgDoomFrightEf1", affects: "enemies", predicate: [] }] }], description: "<p>Aura for @UUID[Compendium.pf2e.spells-srd.Item.1xLVcA8Y1onw7toT]{Dirge of Doom}.</p>" },
  dRgDoomFrightEf1: { name: "Spell Effect: Dirge of Doom", level: 1, duration: dur(1, "rounds", "turn-start"), rules: [{ key: "GrantItem", uuid: "Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL", alterations: [{ mode: "override", property: "badge-value", value: 1 }], onDeleteActions: { grantee: "cascade" } }], description: "<p>You are @UUID[Compendium.pf2e.conditionitems.Item.TBSHQspnbcqxsmjL]{Frightened 1}, and you can't reduce your frightened value below 1 while you remain in the area of @UUID[Compendium.pf2e.spells-srd.Item.1xLVcA8Y1onw7toT]{Dirge of Doom}.</p>" },
  // 0.5c: иммунитеты PA вне спасброска (метка без правил: правило каталога пропускает шаги, пока она есть — unlessEffect)
  XWte9oUQ4x0sBHMq: { name: "Effect: Rousing Splash Immunity 10 minutes", level: 0, duration: dur(10, "minutes"), rules: [], description: "<p>The creature is temporarily immune to the temporary Hit Points from rousing splash for 10 minutes.</p>" },
  Ru9goDwRnRAzcQU3: { name: "Spell Effect: Translocate Immunity", level: 0, duration: dur(1, "hours"), rules: [], description: "<p>You are temporarily immune to translocate for 1 hour.</p>" },
  // Невосприимчивость цели к «Пучку трав» на 10 минут: шаг unlessEffect правила берёт её как метку
  rg21PkfOqRC4wKwa: { name: "Effect: Dash of Herbs Immunity", level: 0, duration: dur(10, "minutes"), rules: [], description: "<p>The creature is temporarily immune to Dash of Herbs for 10 minutes.</p>" },
  // Conjure Bullet: порождённый боеприпас живёт, пока длится эффект (до конца хода); GrantItem с каскадом, как у Blazing Armory (pf2e GrantItemRuleElement onDeleteActions.granter)
  CnjrBulletEffct1: { name: "Effect: Conjure Bullet (Bullet)", level: 0, duration: dur(0, "rounds", "turn-end"), rules: [{ key: "GrantItem", uuid: "Compendium.pf2e.equipment-srd.Item.MKSeXwUm56c15MZa", onDeleteActions: { granter: "cascade" } }], description: "<p>You conjure an ordinary level-0 sling bullet. If it isn't fired before the end of your turn, the effect is wasted.</p>" },
  CnjrBoltEffect01: { name: "Effect: Conjure Bullet (Bolt)", level: 0, duration: dur(0, "rounds", "turn-end"), rules: [{ key: "GrantItem", uuid: "Compendium.pf2e.equipment-srd.Item.AITVZmakiu3RgfKo", onDeleteActions: { granter: "cascade" } }], description: "<p>You conjure an ordinary level-0 bolt. If it isn't fired before the end of your turn, the effect is wasted.</p>" },
  // Маска ужаса: носитель страшен; правило-носитель с испытанием нападающего лежит в tools/pa-carriers.mjs (bySource этого эффекта)
  Pdq3C29GY18nbVg9: { name: "Spell Effect: Mask of Terror", level: 4, duration: dur(1, "minutes"), rules: [], description: "<p>You appear to be a gruesome and terrifying creature. When a creature attacks you, it must attempt a Will save against the spell DC of Mask of Terror: on a failure it becomes frightened 2.</p>" }
};

const STATS = { coreVersion: "14.366", systemId: "pf2e", systemVersion: "8.6.1", createdTime: null, modifiedTime: null, lastModifiedBy: null, compendiumSource: null, duplicateSource: null, exportSource: null };

/** Документ эффекта пака (формат packs/_source/effects, как у импортированных PA). slug — sluggify имени без префикса «Effect:» не нужен: pf2e берёт slug из имени. */
export function authoredDoc(id, a, slug) {
  return {
    _id: id, name: a.name, type: "effect", img: a.img ?? "icons/svg/aura.svg",
    system: {
      description: { value: a.description ?? "" }, duration: a.duration, level: { value: a.level ?? 0 }, publication: { license: "", remaster: false, title: "" },
      rules: a.rules ?? [], start: { initiative: null, value: 0 }, tokenIcon: { show: true }, traits: { rarity: "common", value: a.traits ?? [] }, slug
    },
    effects: [], folder: null, sort: 0, ownership: { default: 0 }, flags: a.flags ?? {}, _stats: STATS, _key: `!items!${id}`
  };
}

/** Запись карты pa-effects.json для эффекта: kind own, срок — для проверки «срок правила PA отличается от срока эффекта». */
export const authoredMapEntry = (a) => ({ name: a.name, kind: "own", dur: a.duration.unit && a.duration.value >= 0 ? { value: a.duration.value, unit: a.duration.unit } : null, authored: true });
