# pf2e-automato — план реализации (финальный модуль)

Основа: `architecture.md` (решения пользователя 2026-10-20 обязательны и здесь не пересматриваются), `brief.md`, `test-results.md`.
Источники сверки: ядро v14.366 `E:/Foundry VTT v14.366/app/resources/app/client/` (далее `core/`; `common/` — рядом),
pf2e 8.6.1 `.../systems/pf2e/pf2e.mjs` (далее `pf2e:NNNN` — номер строки), socketlib 1.1.4, pf2e-toolbelt 3.59.1 (`scripts/main.js`, минифицирован — маркеры
для grep), pf2e-automations (`src/index.js`, `rules/config.json`). Прототипы — только справка.

Корень нового модуля: `D:/ClaudeFun/pf2e-automato/module/` (junction `…/Data/modules/pf2e-automato` -> туда; id модуля `pf2e-automato`).

## 0. Что в architecture.md пришлось уточнить / исправить (по итогам сверки исходников)

1. **Игрок не может создать регион с поведениями**: `common/documents/region.mjs:112` (`#canCreate`: «Only GMs can create Regions with Behaviors»).
   Значит `preCreateRegion` + `updateSource({behaviors})` на клиенте создающего (architecture.md) работает только если регион ставит ГМ. Путь для игрока
   (основной в кампании) — поведение добавляет активный ГМ в `createRegion`. **План: единый путь для всех** — `createRegion` у активного ГМа
   (`region.createEmbeddedDocuments("RegionBehavior")`), затем **детерминированный свип геометрией** (`token.testInsideRegion(region)` по токенам сцены,
   не по `region.tokens`, без `sleep`). `preCreateRegion` остаётся только для флага Toolbelt `skip` (флаги игрок писать может).
   Идемпотентный `hold()` делает двойное срабатывание (свой свип + штатный `tokenEnter` ядра) безопасным.
2. `getOriginData()` в 8.6.1 = `{actor, uuid, type, rollOptions}` (`pf2e:45537`); у заклинаний ещё `castRank`, `variant` (`pf2e:53487`).
   **Поле `actor` есть** (architecture.md писал без него). Slug по-прежнему нет.
3. У **расходника** (`consume`, `pf2e:51042`) `flags.pf2e.origin` — это `{sourceId, uuid, type}` (`pf2e:51064`, `B(this,["sourceId","uuid","type"])`):
   **ни `actor`, ни `rollOptions`, ни `slug`**. Сообщение «использовал» создаётся **без await** перед удалением предмета (`pf2e:51079–51090`).
   Каскад slug должен это переживать (см. §1.5).
4. `actor.increaseCondition(slug, {value})` **прибавляет** `value` к существующему состоянию (`pf2e:33506–33521`), а не ставит его. Для «frightened по степеням»
   нельзя вызывать с `value` на актёре, у которого уже есть frightened. Свой `applyCondition` (§2, `apply.mjs`).
5. `TokenDocumentPF2e#testInsideRegion` **переопределён** (`pf2e:28166`) и для измеряемых областей (circle/cone/line, квадратная сетка, сцена на канвасе)
   использует `region.getCoverage()` (`pf2e:20865+`, клетки, закрытые стенами, исключены). То есть `testInsideRegion` уже даёт «правила области PF2e» — отдельная логика
   покрытия не нужна. Если активный ГМ смотрит другую сцену, `getCoverage` вернёт `null` и сработает обычная геометрия ядра (`core/documents/token.mjs:3236`).
6. `CONFIG.time.roundTime = 6` (`pf2e:116922`): ядро само двигает `worldTime` на 6 с за раунд боя (`core/documents/combat.mjs:222–258`, `worldTime.delta`).
   Счётчик раундов из architecture.md сохраняем (решение пользователя), но он дублирует время почти всегда; истечение — «что наступит раньше».
7. `preCreateChatMessage` — **синхронный** (`Hooks.call` не ждёт промисов). Разметку в снимке разбираем регулярками, без `enrichHTML`; всё, что требует
   асинхронности (`resolve(...)`-СЛ, `fromUuid` компендиума), доделывает ГМ на исполнении (§3).
8. `pf2e-toolbelt` Template Helper: `createRegion`-хук **только у создающего пользователя**, пропускает регион при `getFlag("pf2e-toolbelt","targetHelper.skip")`
   (проверено по `main.js`: `this.getFlag(e,"skip")` -> `tl(e,key,"skip")` -> `region.getFlag("pf2e-toolbelt","targetHelper.skip")`).

## 1. JSON-схема правила (общий контракт)

Файл-контракт: `scripts/rules.mjs` экспортирует `RULE_VERSION=1`, `validateRule(raw) -> {ok, rule, errors}` (чистая функция, без Foundry — тестируется в `node --test`),
`normalizeRule(raw)`. Все остальные модули принимают только нормализованное правило.

### 1.1 Правило (`Rule`)

```jsonc
{
  "v": 1,                                   // версия схемы, обязательна
  "label": "string?",                       // подпись в блоке чата и во вкладке
  "yield": true | false | null,             // уступить pf2e-automations: null/нет = настройка `yieldToAutomations`;
                                            // true = уступить, если модуль активен и покрывает предмет (реестр compat, §2);
                                            // false = выполнять всегда (+ предупреждение о двойном применении, §6)
  "onUse": {                                // что делать, когда предмет/способность ИСПОЛЬЗОВАН (автор — владелец предмета)
    "targets": "self" | "selected" | "area",// откуда цели: сам; токены в таргете автора (снимок); существа в области (регион)
    "excludeSelf": true | false | null,     // исключить автора из области; null = по форме: emanation -> true, burst/cone/line -> false
    "zone": Zone | null,                    // живая зона (только при targets:"area")
    "challenge": Challenge | null,          // испытания целей по степеням
    "apply": [ Apply ]                      // безусловные эффекты/состояния без броска (на себя/цели)
  } | null,
  "onAttacked": Reaction | null,            // реакция ЗАЩИЩАЮЩЕГОСЯ: правило лежит на предмете/черте, которая у цели атаки
  "onEvent": [ OnEvent ]?,                  // (0.5g3) правило на предмете актёра срабатывает по событию: бросок, урон, ход, эффект, сотворение (§1.1b); нет событий — поля нет
  "macros": [ MacroRef ],                   // макросы по фазам (аналог OnUse в MIDI), см. ниже; по умолчанию []
  "onTurn": null                            // ЗАРЕЗЕРВИРОВАНО (v2), валидатор принимает только null
}
```

Правило содержит `onUse` **или** `onAttacked` (не оба; отдельные случаи — два правила на разных предметах). `macros` и `onEvent` допустимы к любому.
`source` (`"flag"|"world"|"catalog"|"markup"`) и `confidence` (`"high"|"low"`) **не хранятся** в правиле — их выставляет резолвер;
в снимке (§1.4) они сохраняются. Правило из разметки с `confidence:"low"` не исполняется молча (§1.3, §3.G).

```jsonc
Zone := {
  "condition": { "slug": "concealed", "value": 1? } | null,   // состояние pf2e
  "effect":    { "uuid": "Compendium...Item.xxx" } | null,    // и/или эффект (хотя бы одно из двух)
  "duration":  { "seconds": 60?, "rounds": 10? } | null,      // null = до закрытия; оба поля = «что наступит раньше»
  "events":    null                                           // ЗАРЕЗЕРВИРОВАНО (v2: tokenTurnStart/End); принимается только null
}

Challenge := {
  "statistic": "fortitude"|"reflex"|"will"|"perception"|"<skill slug>"|"flat",
  "dc": { "value": 17 }                       // число
      | { "expr": "resolve(...)" }            // выражение pf2e из @Check dc:, доделывает ГМ через enrichHTML
      | { "expr": "markup" }                  // СЛ берётся ГМом из первого @Check описания предмета с тем же statistic; resolveRule подставляет в правило из каталога и всю голову
                                              // испытания (statistic, СЛ, basic, options, traits) из первого спасброска в тексте самого документа (копии NPC различаются именно этим)
                                              // (enrichHTML(description) -> a.inline-check[data-pf2-dc]); нет такого -> блок «СЛ неизвестен», кнопка ввода ГМу
      | { "source": "spell" }                 // СЛ заклинателя: item.spellcasting.statistic.dc (заклинания и монстры)
      | { "against": "class"|"spell"|"..." }, // как @Check[..|against:...]: СЛ от статистики автора
  "basic": true | false,                      // базовое: показывается множитель урона (0/½/1/2); урон НЕ применяется
  "traits": ["fear","mental"]?,               // идут в extraRollOptions/traits броска
  "options": ["..."]?,                        // доп. roll options
  "rollerRole": "target",                     // всегда цель; поле для совместимости с @Check
  "immunity": Immunity?,                      // «после испытания цель невосприимчива к этой способности этого автора» (Immunity — в §1.1a; ауры: «к Пугающему присутствию этого существа»)
  "byDegree": {                               // что применить цели по результату (все ключи необязательны)
    "criticalSuccess": [Apply]?, "success": [Apply]?, "failure": [Apply]?, "criticalFailure": [Apply]?
  }
}

Apply := {
  "to": "self" | "target" | "party" | "allies" | "chosen",  // "chosen" (0.5g4) — существо, выбранное шагом choose выше; кому; в byDegree по умолчанию "target", в onUse.apply по умолчанию "self"; party — участники групп (party) автора, allies (+ range) — союзники в радиусе (0.5g2); группа получает шаг один раз, не на каждую цель
  "condition": { "slug": "frightened", "value": 2?, "policy": "max" } // policy: "max" (по умолчанию: поднять до value, не снижать) | "add" | "reduce" (0.5g4: снизить на value, на нуле снять)
            | null,
  "duration": { "value": 1, "unit": "rounds"|"minutes"|"hours"|"days", "expiry": "turn-start"|"turn-end"|null, "of": "origin"|"target" }?,
                                              // только с condition: состояние живёт в эффекте-обёртке pf2e (GrantItem + alterations badge-value, system.duration);
                                              // of: "origin" (по умолчанию) — срок по ходам автора (context.origin.actor = автор), "target" — по ходам получателя шага;
                                              // снимается вместе с обёрткой; без duration — прямое состояние (policy max/add)
  "effect": { "uuid": "Compendium...Item.xxx", "badge": "increment" | "decrement"? } | null,   // decrement (0.5g2, допустим и -1): значок -1, на минимуме эффект снимается, нет эффекта — пропуск
                                              // badge:"increment" (0.5f): эффект у получателя уже есть -> его значок (counter) +1 вместо второй копии, нет -> создать;
                                              // не выше max значка; ключ шага пишется в flags.pf2e-automato.bumped эффекта (повтор не прибавляет), откат возвращает значение
  "damage": { "formula": "2d6+@actor.level", "damageType": "fire"|"healing"|…, "basic": true? } | null,   // (0.5g4) бросок DamageRoll и applyDamage pf2e без карточки; basic — ×2/×1/×½/×0 по степени; op damaged {amount}, откат не предусмотрен
  "choose": { "from": "allies"|"enemies"|"options", "options": [{"value","label"?,"when"?}]?, "prompt"?, "range"?, "of": "target"? } | null,   // (0.5g4) выбор игрока-автора (окно у него/у ГМа); to у шага всегда "self"; allies/enemies -> шаги to:"chosen" ниже в том же списке, options -> опция choice:<value> для when; op chose {value, actor?}
                                              // у condition (0.5g4): policy "reduce" — снизить значение на value, на нуле снять (op raised/removed); duration у condition — число или кубик "1d4"; duration у effect {value, unit, expiry?} — срок созданного эффекта
  "removeCondition": { "slug": "prone" } | null, // (0.5f) снять состояние целиком (Встать, Стабилизация); нет состояния — шаг пропущен; значение запоминается в op, откат возвращает; иммунитет к чертам источника не мешает
  "when": [predicate]?,                         // (0.5g2) условие шага: предикат pf2e (массив И из строк-опций, {and|or|nor|nand|xor|not|if}, {gte|lte|gt|lt|eq:[a,b]}); набор опций — ctx.rollOptions + origin.rollOptions сообщения + outcome:* + target:* (getSelfRollOptions("target")) + actor.getRollOptions() + item:*; не выполнено — шаг пропущен. Любого вида шаг (scripts/predicate.mjs)
  "removeEffect": { "slug": "rage" | "uuid": "Compendium...", "of": "origin"? } | null,  // (0.5g2) снять эффект получателя; of:"origin" — созданный автором; откат создаёт заново по сохранённым данным (op effRemoved)
  "extendEffect": { "slug": "inspire-courage", "rounds": 1 } | null,   // (0.5g2) продлить действующий эффект на раунды (op extended: prev {value, unit}); повтор по meta.key не продлевает
  "rollOption": { "domain": "all", "option": "mighty-rage-attack", "value": false? } | null,   // (0.5g2) toggleRollOption получателя; value:false — выключить; op option {prev}
  "range": 30?,                               // (0.5g2) только при to:"allies": радиус в футах, целое >= 5
  "rank": { "min": 3?, "max": 5? }?,           // (0.5f) шаг только если круг сотворения (castRank, у не-заклинания — уровень предмета) в границах; 1..10, min<=max. Любого вида шаг
  "note": "string?"                           // текст в блоке (для "ничего не делается", напр. «урон ×½»)
}                                              // ровно одно из condition/effect/note/visibility/persistent/removeCondition/removeEffect/extendEffect/rollOption (rank, when, range, who, mark, … — модификаторы)

Reaction := {
  "trigger": "attack-on-self",                // v1: единственный триггер (остальные — v2)
  "bonus": { "stat": "ac", "type": "circumstance", "value": 2 },
  "cost": "reaction",                         // тратит реакцию (§3.D')
  "notify": ["owner", "gm"]                   // кому шёпотом
}

MacroRef := {
  "uuid": "Macro.xxxxxxxx",                   // мировой макрос (или из компендиума)
  "phase": "onUse" | "afterChallenge" | "onDegree" | "zoneEnter" | "zoneExit" | "onReaction",
  "degree": "criticalSuccess"|"success"|"failure"|"criticalFailure"?   // только для phase:"onDegree" (иначе — на любую степень)
}
```

**Контракт макросов** (`scripts/macros.mjs`, §2). Исполняет **только активный ГМ** (`Macro#execute(scope)`), фазы:
`onUse` — после снимка и разрешения целей (конец `runUse`); `afterChallenge` — когда у всех целей есть результат (или ГМ нажал «Применить всё»);
`onDegree` — для каждой цели при применении её степени (в т.ч. при пустом `byDegree`); `zoneEnter`/`zoneExit` — из `hold/release` зоны (на каждого токена);
`onReaction` — при «Использовать» реакцию. Аргументы (`scope`, имена переменных внутри макроса): `{ phase, actor, token, item, message, rule, targets:[TokenDocument], target (для per-target фаз), degree (0..3|null),
outcome ("criticalSuccess"…|null), results ({tokenId:{degree,total}}), region (RegionDocument|null), dc, args:{} }`; `actor/token/item` — источник использования (`item` может быть `null` у расходника). Правила:
- исполнитель — `game.user` активного ГМа; script-макрос требует `game.user.can("MACRO_SCRIPT")` (иначе фаза пропускается с предупреждением ГМу); chat-макросы допустимы всегда;
- ошибка макроса (`throw`/reject) ловится: `console.error` + `ui.notifications.warn` + запись `state.macros.errors[]`, конвейер **не прерывается**; ожидание макроса ограничено 30 с (`Promise.race`), потом идём дальше;
- идемпотентность: ключ `"<messageId>|<phase>|<tokenKey|->|<macroUuid>"` в `state.macros.done`; повторный запуск фазы не вызывает макрос второй раз. Для зоны макрос вызывается ровно тогда, когда `hold`/`release` реально создал/снял состояние (повторный `tokenEnter` — нет);
- режим `mode.macro` (`auto|off`, по умолчанию `auto`).

**Отложено в v2 (явно)**: поле `onTurn` (триггеры хода теперь — `onEvent`, §1.1b), «при попадании по цели» (`onHit` — теперь `onEvent` + `item:attack-effect:*`, `tools/onhit.mjs`), события зоны `tokenTurnStart/End` (`Zone.events`),
сопровождение «поддерживаемых» эффектов, длительные состояния без обёртки-эффекта. Поля зарезервированы, чтобы схему не ломать.

### 1.1b Событие (`onEvent`, 0.5g3)

Правило лежит на **предмете актёра** (фит, эффект, снаряжение, способность NPC) и срабатывает не от его использования, а от события с участием актёра. `onAttacked` — частный случай (`attack-roll`, `side:"target"`) и не меняется.

```jsonc
OnEvent := {
  "on": "attack-roll" | "skill-check" | "saving-throw" | "damage-roll" | "damage-taken" | "spell-cast"
      | "turn-start" | "turn-end" | "effect-created" | "effect-deleted",
  "side": "self" | "target" | "origin",   // кто держит предмет; по умолчанию self
                                          // self — бросает / получает урон / ходит / у него эффект; target — цель броска (только attack-roll, skill-check, damage-roll, spell-cast);
                                          // origin — источник: автор эффекта (у события эффекта и хода), чья СЛ у броска
  "when": [predicate]?,                   // предикат pf2e (как Apply.when) по roll options события; нет — на любое событие
  "once": true?,                          // один раз на эффект/состояние получателя: ключ шага не зависит от события (Боевое выступление продлевает каждую композицию один раз)
  "apply": [ Apply ]?,                    // шаги: to:"self" — владелец, to:"target" — другой участник (side self: цель броска; target/origin: бросавший / носитель эффекта)
  "challenge": Challenge?                 // другой участник бросает испытание против СЛ владельца (byDegree: self — владелец, target — бросающий)
}                                         // нужен хотя бы apply или challenge
```

Набор опций `when` (как у pf2e-automations): `flags.pf2e.context.options`, `origin.rollOptions`, `outcome:<степень>`, `domain:<область>`, `target` и `target:*`, опции бросавшего (`actor.getRollOptions`, `self:*`), `item:attack-effect:<slug>` у Удара
(связь пассивной способности NPC с Ударом), `damage-taken`, `damage-taken:hp|shield|healing` у урона, `effect:<slug>` у событий эффекта.

Хуки и защита от двойного исполнения (`scripts/events.mjs`):
- `createChatMessage` — по `flags.pf2e.context.type` (`attack-roll`/`spell-attack-roll`, `skill-check`/`perception-check`, `saving-throw`, `damage-roll`, `damage-taken`); сотворение — карточка заклинания, `useKindOf(message) === "use"`; `pf2e.startTurn` / `pf2e.endTurn`; `createItem` / `deleteItem` эффектов.
- Исполняет **только** `isActiveGM()` (активный ГМ и лидер своих вкладок); `mode.effect` должен быть `auto`; `compat.shouldYield` по носителю — как у `onUse`.
- Идемпотентность: ключ `<msgId|id события>:<itemUuid>:<i>` — журнал `flags[MOD].events` на сообщении (`[{key, recs:[{tk, ops}], host?}]`) и память ГМа; у шагов — `meta.key` (`ev:<ключ>:<цель>:<i>.<шаг>`, у `once` — `ev:once:<itemUuid>:<i>…`). Шаги идут через `apply.applyOps` на сообщении-двойнике: на самом сообщении события общий снимок `flags[MOD].use` не пишется.
- `challenge` получает собственную карточку чата со снимком `use` (`state.event` = ключ; бросок по этой карточке события не запускает) — дальше обычный путь `saves` (кнопка игроку, `mode.apply`, иммунитет).
- Переброс: pf2e удаляет старое сообщение и создаёт новое с `isReroll` — журнал старого откладывается под `(актёр, событие)` на 60 с и откатывается через `undoOps` при новом сообщении; простое удаление сообщения ничего не откатывает.
- Эффект, созданный шагом события (`meta.message` с префиксом `ev:`), новых событий effect-created/-deleted не вызывает — цепочек нет.
- 0.5g4: шаги записи идут по одному (`applyOps` на шаг), поэтому выбор шага `choose` (`ctx.picks`: `opts` — опции `choice:*`, `actor` — выбранный) общий на запись. У двойника нет автора сообщения — окно выбора получает игрок онлайн, владеющий актёром-владельцем, иначе ГМ.
- Носители: правило ищется и у эффектов актёра (по `flag` / каталогу по источнику эффекта — `tools/pa-carriers.mjs`: Маска ужаса, Репеллент от паразитов с `side:"target"`) и у предметов, вложенных в оружие (`item.subitems`; опция `sub-item:<slug>` у броска — Защитная статуэтка).

### 1.1a Проверка автора против защиты цели (`onUse.check`)

Общие действия pf2e, где **бросает автор** (Атлетика/Обман/Запугивание/Медицина…) против СЛ защиты цели, а исход по степени накладывается на цель или автора
(Demoralize, Trip, Grapple, Disarm, Shove, Feint, Escape, Treat Wounds, Battle Medicine, Aid). Поле `onUse.check` — **брат** `onUse.challenge`, взаимоисключающи
(`targets` — `selected|area`, не `self`; исключение — проверка без `vs`, ниже). Общий движок (saves.mjs): результаты `state.challenge.results`, применение `state.challenge.applied`,
`applyByDegree`/`undoApplied`, режимы `mode.challenge`/`mode.apply`, yield, low — те же; отличие только в том, **кто бросает и откуда СЛ**.

```jsonc
Check := {
  "statistic": "athletics" | "intimidation" | "medicine" | "perception" | "flat" | "<slug>"   // статистика АВТОРА
            | ["athletics", "acrobatics"],            // список: берётся с наибольшим модификатором (Escape)
  "vs": { "defense": "ac"|"fortitude"|"reflex"|"will"|"perception" }   // СЛ защиты цели (КБ = armorClass)
      | { "dc": 20 }                                  // фиксированная СЛ (Treat Wounds, Battle Medicine)
      | { "against": "athletics" },                   // СЛ любой статистики цели (Escape: Атлетика схватившего)
  "traits": ["auditory","mental"]?, "options": ["action:demoralize"]?,   // traits / extraRollOptions броска
  "mapIncreases": 0|1|2?,                             // штраф последовательных атак: check.roll({attackNumber: n+1})
  "immunity": Immunity?,                              // «иммунитет к этому действию от этого автора» (ниже)
  "byDegree": { "criticalSuccess": [Apply]?, "success": [Apply]?, "failure": [Apply]?, "criticalFailure": [Apply]? }
                                                      // Apply как у Challenge, `to: "target"` (по умолчанию) | `"self"`
}
Immunity := { "slug": "demoralize", "label": "…"?,
              "uuid": "Compendium.pf2e.feat-effects.Item.…"?,        // эффект-иммунитет pf2e, если есть (наложится с origin.actor = автор)
              "duration": { "value": 10, "unit": "minutes"|"hours"|"days" }?,   // иначе — встроенный эффект с флагом flags.pf2e-automato.immunity.slug; нужно uuid или duration
              "scope": "slug"?,                                                  // иммунитет к способности ЛЮБОГО автора («ко всем существам вида»); без поля — только к этому автору
              "degrees": ["criticalSuccess","success"]? }                        // при каких степенях ставится; нет поля (или все четыре) — при любой. Одинаков у check и challenge
```

Поведение:
- **Бросок**: `statistic.check.roll({dc:{value, slug?}, target: <актёр цели>, item, token, extraRollOptions:[marker, …options], traits, attackNumber?})`; `value` = `defenseDc(цель, vs)`
  (`armorClass.value` / `saves[x].dc` / `perception.dc` / `getStatistic(against).dc` / фикс.), `slug` (`ac`->`armor`) отдаёт pf2e контекст цели. Маркер `pf2e-automato:<msgId>:<tokenKey>` — как у спасбросков.
  Бросает клиент автора, если актёр-автор PC (`hasPlayerOwner`; кнопка «Бросить» у владельца и ГМа); автора-NPC за ГМа бросает активный ГМ (`skipDialog`) автоматически или кнопкой (`mode.challenge`).
  Несколько целей — по броску на цель (ключ цели = tokenKey).
- **Приём**: `acceptSavingThrow` принимает `skill-check|perception-check|flat-check`: по маркеру либо (бросок кликнут вручную) по `origin.uuid` предмета + автору + `context.target.token`. Перебросы — как у спасбросков. В результат пишется `dc`.
- **Иммунитет у `challenge`** (0.5c, «невосприимчив на N после испытания» — Пугающее присутствие, ауры, дыхание): тот же `Immunity`, автор = `use.actor`. Цель с таким эффектом (`origin.actor` = автор, тот же slug/uuid) **не бросает** (`rollSave`, `runChallenge`, кнопка в чате: «невосприимчива») и **ничего не получает** (`applyByDegree` пропускает; применённое ранее не трогается). Эффект ставится вместе со степенями (`applyByDegree`) только при `degrees` (нет поля — при любой), откатывается вместе с ними. Эффекта-маркера PA `<x>-immunity` не нужно.
- **Иммунитет**: проверяется **до броска** (`hasImmunity`: эффект на цели с `origin.actor` = автор и тем же `uuid`/slug) — блок пишет «иммунна», броска и кнопки нет. Эффект-иммунитет накладывается вместе с применением степеней (`applyByDegree`, любая степень, откатывается вместе с ней).
- `to:"self"` шаги проверки считаются **по броску на каждую цель**: ключ идемпотентности `<msg>:self.<tokenKey>:c<степень>.<i>`, откат — вместе с целью. У `challenge` ключ прежний (`<msg>:self:c<степень>.<i>`, один раз на использование).

Примеры:
```json
{ "v":1, "label":"Demoralize", "onUse": { "targets":"selected", "check": {
  "statistic":"intimidation", "vs":{"defense":"will"}, "traits":["auditory","emotion","mental"],
  "immunity": { "slug":"demoralize", "duration":{"value":10,"unit":"minutes"} },
  "byDegree": { "criticalSuccess":[{"condition":{"slug":"frightened","value":2}}], "success":[{"condition":{"slug":"frightened","value":1}}] } } } }

{ "v":1, "label":"Trip", "onUse": { "targets":"selected", "check": {
  "statistic":"athletics", "vs":{"defense":"reflex"}, "traits":["attack"],
  "byDegree": { "criticalSuccess":[{"condition":{"slug":"prone"}},{"note":"1d6 урона вручную"}], "success":[{"condition":{"slug":"prone"}}],
                "criticalFailure":[{"to":"self","condition":{"slug":"prone"}}] } } } }

{ "v":1, "label":"Feint", "onUse": { "targets":"selected", "check": {
  "statistic":"deception", "vs":{"defense":"perception"},
  "byDegree": { "criticalSuccess":[{"effect":{"uuid":"Compendium.pf2e.other-effects.Item.y1GwyXv7iOf8DhBg"}}], "success":[{"effect":{"uuid":"Compendium.pf2e.other-effects.Item.y1GwyXv7iOf8DhBg"}}],
                "criticalFailure":[{"note":"следующая атака цели по вам с бонусом"}] } } } }

{ "v":1, "label":"Grapple", "onUse": { "targets":"selected", "check": {
  "statistic":"athletics", "vs":{"defense":"fortitude"}, "traits":["attack"],
  "byDegree": { "criticalSuccess":[{"condition":{"slug":"restrained"}}], "success":[{"condition":{"slug":"grabbed"}}], "criticalFailure":[{"note":"цель может схватить вас или толкнуть"}] } } } }

{ "v":1, "label":"Treat Wounds", "onUse": { "targets":"selected", "check": {
  "statistic":"medicine", "vs":{"dc":20},
  "immunity": { "slug":"treat-wounds", "uuid":"Compendium.pf2e.feat-effects.Item.Lb4q2bBAgxamtix5" },
  "byDegree": { "criticalSuccess":[{"note":"лечение 4d8 — вручную"}], "success":[{"note":"лечение 2d8 — вручную"}], "criticalFailure":[{"note":"урон 1d8 — вручную"}] } } } }
```

**Проверка без цели (0.5f).** `check` без `vs` — бросок только за степень: Прыжок в высоту, Прыжок в длину, Лазание (крит. провал — `prone` на себя). Допустим только с `roll:"system"` (СЛ задаёт система, модуль не бросает), `targets:"self"`, шагами по степеням `to:"self"` (по умолчанию) и без `immunity`. Рантайм: `onRollMessage` берёт «целью» токен автора (ключ — его id), дальше те же `recordResult`/`applyByDegree`; нет исхода в контексте (СЛ не задана) — результата нет. Форма: `vsType:"none"`; в Мастерской — «без цели (бросок системы)». Если правило PA привязано к чужому броску (Panache: любой навык с чертой bravado), оно не этот примитив — 0.5g.

**Бросок действия без карточки (`scripts/actions.mjs`).** Базовые действия из листа, `game.pf2e.actions.*` и Token Action HUD дают check-сообщение pf2e без предмета: `flags.pf2e.context = {type:"skill-check"|"perception-check"|"attack-roll"|"flat-check", options:[…"action:<slug>"…] (отсортированы; `action:cost:N` и `action:<slug>:<вариант>` не считаются), origin:{actor,token}, target:{actor,token}|null, dc:{value,slug,…}|null, outcome:"success"|…|null, isReroll}`, `rolls[0].degreeOfSuccess`. Активный ГМ в `createChatMessage` (после `acceptSavingThrow`: бросок с карточки/нашим маркером принимается там и здесь пропускается) ищет правило `onUse.check` по slug (`resolveRule({origin:{slug}})`), пишет на это же сообщение снимок `kind:"roll"` (автор = `origin.actor`, цель = `context.target`, СЛ = `context.dc`, `state.done`), результат — из броска (`src:"action"`), и дальше те же `afterRecord`/`applyByDegree` (`mode.challenge` off — не обрабатывать; `mode.apply` — как у обычных проверок). Иммунная цель: результат виден, ничего не применяется (проверка в `applyByDegree`). Без цели — блок «нет цели». Переброс pf2e удаляет старое сообщение и создаёт новое без наших флагов: снимок откладывается (память ГМа, 60 с) по ключу (актёр, цель, slug) и переносится на новое; изменение степени после применения — «результат изменён» + шёпот. `yield` к pf2e-automations уважается (тихо пропускаем). Предмет не нужен, поэтому `item.uuid = null`; markup-вывод не используется.

### 1.2 Хранилища и порядок поиска

| # | Где | Формат | Кто пишет |
|---|---|---|---|
| 1 | флаг предмета `flags.pf2e-automato.rule` | `Rule` | вкладка «Автоматизация» (ГМ) |
| 2 | мировая настройка `pf2e-automato.catalog` (`config:false`) | `{ "bySource": { "<compendiumSource uuid>": Rule }, "bySlug": { "<slug>": Rule } }` | кнопки вкладки «Для всех с этим источником / slug» (только ГМ) |
| 3 | встроенный `rules/catalog.json` | `{ "v":1, "bySource": {...}, "bySlug": {...} }`, грузится в `ready` через `fetch`, дальше синхронно | разработчики |
| 4 | вывод из разметки (`deriveFromMarkup(item)`, синхронно) | `Rule` + `confidence` | автоматически |

Порядок: 1 -> 2.bySource -> 2.bySlug -> 3.bySource -> 3.bySlug -> 4. **`bySource` (compendiumSource) приоритетнее slug**: у NPC один slug не означает одно и то же
(одноимённые способности разных монстров). Источник предмета: `item._stats.compendiumSource ?? item.flags.core?.sourceId ?? origin.sourceId`.
`resolveRule(item|originInfo) -> {rule, source, slug, sourceUuid, confidence}|null` — синхронный (нужен в `preCreateChatMessage`/`preCreateRegion`).
Slug — только запасной ключ; имена не используются (русские, Babele).

**Контракт `bySlug` (после 0.5b).** Поиск по slug идёт через `bySlugOf(map, slug, type)`, тип — `item.type ?? origin.type`:
- ключ `"<slug>@<type>"` (например `arcane-cascade@action`) — правило только для документов этого типа, проверяется первым; общий ключ `"<slug>"` — для любого типа;
- **`campaignFeature` (армейские способности Kingmaker) общий ключ не берёт** — они делят slug с обычными действиями (Taunt, Feint, Darkvision); им годится только ключ с типом;
- правило по slug, совпадающее ровно с `selfEffect` самого документа (`isSelfEffectOnly`), пропускается: pf2e применяет его сам, второй раз не нужно;
- ограждение тёзок (документ без источника): ручное правило-проверка автора (`onUse.check`) не применяется, если из разметки документа выводится спасбросок (ловушка «Shove») либо в тексте `[[/act <slug>]]` (делегирует базовому действию, бросок идёт через `actions.mjs`) — тогда работает вывод из разметки;
- `challenge.dc = { "expr": "markup" }` у правила каталога: голова испытания (statistic, dc, basic, options, traits) берётся из первого спасброска в тексте самого документа, степени — из каталога (копии одной способности у разных NPC различаются именно головой).
Тот же поиск использует `reactions.ruleOfItem` (индекс `onAttackedIndex`).

### 1.3 Вывод из разметки (`deriveFromMarkup`, синхронно, по `item.system.description.value` + данным предмета)

Регулярки по сырому HTML. Параметры `@Check[...]` — как у pf2e: split по `|`, первый токен — type (возможно `reflex,will`), остальное `key:value`, флаг `basic` (`pf2e:18895`).
**Блоки степеней**: элемент, начинающийся с `<strong>МЕТКА</strong>`, где МЕТКА — `Critical Success|Success|Failure|Critical Failure` либо русские (Babele, `pf2ru-translation`)
`Критический успех|Успех|Провал|Критический провал` (+ синонимы «Критическая неудача/Критический промах»). Разметку русского перевода **нужно снять с живых предметов** (§7.U-18, кусок K8):
парсер опирается на структуру (`<strong>` в начале блока), а таблицу меток держит в `rules/labels.json` (en/ru), чтобы дополнять без правок кода.
Внутри блока степени каждая `@UUID[Compendium.pf2e.conditionitems.Item.<id>]{подпись}` -> `Apply.condition`;
**slug состояния — синхронно по UUID через `game.pf2e.ConditionManager.conditions.get(uuid)?.slug`** (карта строится и по slug, и по uuid, `pf2e:48889–48891`; `fromUuidSync`/индекс компендиума не используем — в индексе slug нет);
**значение** — последнее целое в подписи (`{Испуган 2}`, `{Frightened 2}`), иначе у valued-состояний 1, у не-valued `null`. Ссылки `@UUID[...effects...]` внутри блока -> `Apply.effect`.

| Признак | Результат | confidence |
|---|---|---|
| `system.defense.save = {statistic, basic}` у заклинания (`pf2e:53260`, `53392`) | `onUse.challenge {statistic, basic, dc:{source:"spell"}}` | high |
| `@Check[<save>|dc:N|basic]` в описании | `challenge {statistic, dc:{value:N}\|{expr}, basic}` | high |
| блоки степеней с состояниями/эффектами при наличии `@Check`/`defense.save` | `challenge.byDegree[...]` | high |
| у заклинания `system.area` или `@Template[...]` в описании | `targets:"area"` | high |
| заклинание, `@UUID[...-effects...]` вне блоков степеней и есть цели (`system.target`) | `onUse.apply:[{to:"target", effect}]`, `targets:"selected"` | high |
| `consumable` с `@UUID[...-effects...]`, без `@Template` | `onUse.apply:[{to:"self", effect}]` (пьющий) | high |
| action/feat с `@UUID[...-effects...]` вне блоков степеней, **без** `system.selfEffect` (на себя или на цель — неясно) | `onUse.apply:[{to:"self", effect}]` | **low** |
| action/feat с `system.selfEffect` | не выводится (делает система, `pf2e:54140`) | — |
| `@Template` и `@UUID[...conditionitems...]` вне блоков степеней | кандидат `zone {condition:{slug}}`, длительность из текста не берём | **low** |
| `@Check[...|options:inflicts:<cond>]` | подсказка `hints.inflicts`, на степени не мапится | — |

Исполнение (решение пользователя): `high` — по режиму вида (`mode.challenge/apply/effect/zone`), как ручное правило; `low` — **всегда кнопкой ГМу «Применить (распознано)» прямо в блоке чата** (§3.G),
даже при `auto`; `mode.<вид>=off` отключает и low-кнопку вида. Вкладка «Автоматизация» (§6) распознанное только показывает — на тысячи предметов вкладка не масштабируется.

### 1.4 Снимок использования (`flags.pf2e-automato.use` на ChatMessage) — «контракт состояния»

Пишется **автором** в `preCreateChatMessage` (синхронно: `message.updateSource({"flags.pf2e-automato.use": snapshot})`), дальше **только активный ГМ**.
Снимок пишется и при уступке pf2e-automations (с `state.yielded`), чтобы блок мог сообщить «Выполняет pf2e-automations» и диагностика была однозначной.

```jsonc
{
  "v": 1,
  "kind": "use" | "card",            // use = факт применения; card = карточка предмета (инфо), см. §3.A
  "rule": Rule,                      // замороженная копия (расходник исчезает)
  "src": "flag"|"world"|"catalog"|"markup",
  "confidence": "high" | "low",
  "slug": "smoke-ball-lesser",
  "sourceUuid": "Compendium...|null",
  "item": { "uuid": "...", "name": "...", "type": "consumable", "sourceId": "Compendium...|null" },
  "actor": "Actor.xxx" | "Scene.x.Token.y.Actor.z",   // uuid актёра-автора
  "token": "Scene.x.Token.y" | null,
  "dc": 17 | null,                   // посчитанный СЛ либо null -> ГМ дорешает по rule.challenge.dc
  "createdAt": 1760000000000,        // Date.now() автора: давность дозапуска (§3.H)
  "targets": [ { "key": "<tokenId>", "uuid": "Scene.x.Token.y", "name": "...", "pc": false } ],  // снимок game.user.targets автора
  "state": {                         // изменяет только ГМ, точечными dotted-путями
    "yielded":   "pf2e-automations" | null,                // единственное решение: пишет АВТОР при создании снимка
    "zone":      { "regionUuid": "...", "status": "pending"|"active"|"closed"|"expired" },   // сроки — ТОЛЬКО в поведении региона (`system.expiresAt/roundsLeft`)
    "area":      { "regionUuid": "...", "keys": ["tokenId", ...] },     // цели из ПОСЛЕДНЕГО региона сообщения (§3.C-3)
    "challenge": { "results": { "<tokenId>": { "degree": 0..3, "total": 21, "by": "userId", "rollMessageId": "...|null", "src": "own|saving-throw", "changedAfterApply": false } },
                   "applied": { "<tokenId>": { "ops": [ {"op":"created"|"raised","item":"Item uuid","prev":1?} ], "degree": 1 } } },
    "apply":     { "<tokenId|self>": { "ops": [ ... ] } },
    "derived":   { "pending": [ "<stepKey>" ], "applied": [ "<stepKey>" ] },      // low-кнопки (§3.G)
    "macros":    { "done": [ "<key>" ], "errors": [ { "key": "...", "msg": "..." } ] }
  }
}
```

Ключи результатов — **id токена** (в UUID есть точки, dotted-пути `update()` ломаются).

Мета на созданных документах (`flags.pf2e-automato.meta` на состоянии/эффекте у цели):
`{ "key": "<messageId>:<tokenId>:<stepKey>" | "zone:<regionUuid>", "source": "zone|challenge|apply|derived", "message": "...", "region": "...|null", "origin": "Item uuid", "by": "Actor uuid" }`.
`meta.key` — ключ идемпотентности (проверяется по документам мира, не только по флагу сообщения). **Единая формула дедупа эффекта** (`apply.hasEffect(actor, uuid, byActorUuid)`):
у актёра есть Item `type:"effect"` с `_stats.compendiumSource === uuid` **и** `system.context.origin.actor === byActorUuid` (либо `meta.key` совпадает). Состояния — по `meta.key` и политике `max`.

### 1.5 Каскад slug и источника (`slugOf(origin, item?)`, `sourceOf(origin, item?)` в `rules.mjs`)

Slug (запасной ключ каталога):
1. `origin.slug` (только у регионов от `placeRegionFromItem`, `pf2e:3379`);
2. `item.slug` живого предмета: `item ?? fromUuidSync(origin.uuid)` (в `preCreateChatMessage` расходник ещё жив — удаление идёт после запроса к серверу);
3. `origin.rollOptions` -> `origin:item:slug:<slug>`;
4. `item.flags.babele?.originalName` -> `sluggify` (`game.pf2e.system.sluggify`).
(Прежний шаг «`fromUuidSync(origin.sourceId).system.slug`» **удалён**: индекс компендиума slug не содержит.)
Источник (`sourceOf`) — основной ключ: `item._stats.compendiumSource`, затем `item.flags.core.sourceId`, затем `origin.sourceId` (у `consume`-сообщения, `pf2e:51064`) — единственный путь для расходника, предмет которого уже исчез.
Оба `null` -> каталоги пропускаем, остаётся вывод из разметки (если предмет жив).

### 1.6 Примеры для четырёх тестов брифа (+ пример макроса)

**(1) Дымовая шашка (малая) — зона** (`rules/catalog.json`: `bySource` на UUID шашки, `bySlug.smoke-ball-lesser` запасной ключ; то же для `-greater`; «Дымовая завеса» агентов — ключ уточнить живьём, slug в architecture.md — догадка):
```json
{ "v": 1, "label": "Дымовая завеса",
  "onUse": { "targets": "area",
    "zone": { "condition": { "slug": "concealed" }, "effect": null, "duration": { "seconds": 60, "rounds": 10 } },
    "challenge": null, "apply": [] } }
```

**(2) «Огненное дыхание» (`breathe-fire`) — испытание Реакции basic** (СЛ от заклинательной статистики NPC; урон модуль НЕ применяет, показывает множитель):
```json
{ "v": 1, "label": "Огненное дыхание",
  "onUse": { "targets": "area", "zone": null,
    "challenge": { "statistic": "reflex", "dc": { "source": "spell" }, "basic": true, "rollerRole": "target", "byDegree": {} },
    "apply": [] } }
```
(без каталога тот же результат даёт вывод из `system.defense.save`, high.)

**(3) Frightful Presence — frightened по степеням, «уступить pf2e-automations»** (в мире pf2e-automations покрывает его: `rules/config.json:8372–8437`; значения frightened — **иллюстрация, сверить с текстом способности**):
```json
{ "v": 1, "label": "Устрашающее присутствие", "yield": true,
  "onUse": { "targets": "selected", "zone": null,
    "challenge": { "statistic": "will", "dc": { "expr": "markup" }, "basic": false, "traits": ["fear","mental","emotion"],
      "byDegree": {
        "success":         [ { "to": "target", "condition": { "slug": "frightened", "value": 1, "policy": "max" } } ],
        "failure":         [ { "to": "target", "condition": { "slug": "frightened", "value": 2, "policy": "max" } } ],
        "criticalFailure": [ { "to": "target", "condition": { "slug": "frightened", "value": 3, "policy": "max" } } ] } },
    "apply": [] } }
```
Пока pf2e-automations активен и покрывает предмет (по slug **или** по UUID источника, §2 compat) и `yield !== false` — модуль пишет снимок с `state.yielded:"pf2e-automations"` и **не исполняет**.
**Почему `yield:false` опасен:** pf2e-automations срабатывает на любое `saving-throw`-сообщение с `item:slug:frightful-presence` (`triggerType:"saving-throw"`, `rules/config.json:8387–8434`);
наш бросок передаёт `item` -> frightened применится дважды. Поэтому при `yield:false` и активной покрывающей группе вкладка и блок показывают предупреждение (§6, §3.G).

**(4) «Ловкое уклонение» (`nimble-dodge`) — реакция** (правило лежит на черте у защищающегося):
```json
{ "v": 1, "label": "Ловкое уклонение",
  "onAttacked": { "trigger": "attack-on-self",
    "bonus": { "stat": "ac", "type": "circumstance", "value": 2 }, "cost": "reaction", "notify": ["owner", "gm"] } }
```

**(5) Макросы** (как OnUse в MIDI): общий после испытаний и отдельный на крит. провал:
```json
{ "v": 1, "onUse": { "targets": "area", "zone": null, "challenge": { "statistic": "reflex", "dc": { "source": "spell" }, "basic": true, "byDegree": {} }, "apply": [] },
  "macros": [ { "uuid": "Macro.AbCdEf1234567890", "phase": "afterChallenge" },
              { "uuid": "Macro.ZyXwVu0987654321", "phase": "onDegree", "degree": "criticalFailure" } ] }
```
Внутри макроса: `const { actor, targets, results, degree } = scope;` (переменные `scope` — аргументы `Macro#execute`; точная форма — §7.U-19).

«Бравая брага»: выводится как `onUse.apply:[{to:"self", effect:{uuid}}]` (consumable, high), но **уступается** pf2e-automations (`rules/config.json:19060–19080`: предикаты `consumable:bravos-brew-*`, `source[]` — UUID компендиума); без него работает по выведенному правилу.

## 2. Структура файлов, публичные функции, хуки

```
module/
  module.json
  rules/catalog.json  rules/labels.json        (labels.json: метки степеней en/ru для разбора разметки, §1.3)
  lang/{ru,en}.json            (+ фрагменты lang/{ru,en}/<chunk>.json — см. §8, если проверка множественных языковых файлов пройдёт)
  scripts/main.mjs  util.mjs  settings.mjs  compat.mjs  rules.mjs  apply.mjs  macros.mjs  use.mjs  zone.mjs  saves.mjs  chat.mjs  reactions.mjs  sheet.mjs
  styles/{chat,sheet,zone}.css
  templates/chat-block.hbs  sheet-tab.hbs
  tests/rules.test.mjs         (node --test, только чистые функции)
  tests/af-harness.js          (живой прогон, §9)
  README.md                    (в т.ч. «прототипы pf2e-autoflow-proto-* отключить»)
```

Дополнения к architecture.md: `util.mjs`, `settings.mjs`, `compat.mjs`, `macros.mjs` выделены, чтобы исполнители не пересекались по файлам. `lib-wrapper` не используется и **не пишется в `relationships.requires`**.

Соглашение: каждый модуль экспортирует `init()` (из `Hooks.once("init")`) и/или `ready()` (из `Hooks.once("ready")`); **хуки навешивает сам модуль-владелец** внутри
этих функций; `main.mjs` только вызывает их в фиксированном порядке. **K0 создаёт все файлы как заглушки с полными сигнатурами из этого раздела**
(тело — `throw new Error("not implemented")` либо безопасный no-op для `init/ready`), чтобы остальные куски вызывали друг друга по контракту и модуль грузился с первого дня.

### module.json
`id:"pf2e-automato"`, `compatibility:{minimum:"14.360", verified:"14.366"}`, `relationships.systems:[pf2e >=8.6.1]`, `relationships.requires:[socketlib]`
(`recommends`: pf2e-toolbelt, pf2e-automations — необязательны), `documentTypes.RegionBehavior:{zone:{}}`, `socket:true` (нужно socketlib), `esmodules:["scripts/main.mjs"]`,
`styles:[3 файла]`, `languages:[ru,en]`. Прототип: `prototypes/proto-3/module.json`.

### util.mjs (K0, целиком, без заглушек)
```js
export const MOD = "pf2e-automato";
export const L = (key, data) => data ? game.i18n.format(`PF2E_AUTOMATO.${key}`, data) : game.i18n.localize(`PF2E_AUTOMATO.${key}`);
export const DEGREES = ["criticalFailure","failure","success","criticalSuccess"];   // индекс = pf2e degreeOfSuccess 0..3
export const sluggify = (s) => game.pf2e.system.sluggify(String(s ?? ""));
export const isActiveGM = () => game.user.isActiveGM;
export const flagPath = (...p) => ["flags", MOD, ...p].join(".");
export function debug(...a)               // только при client-настройке debug
export function tokenKey(tokenDoc)        // = tokenDoc.id
export function degreeFromTotal(total, dc, die)   // 0..3 с поправкой нат.20/нат.1 (логика pf2e:340–379; DegreeOfSuccess не экспортируется)

// Сокет живёт здесь, чтобы не было цикла main <-> модули:
export let socket = null;
export function setSocket(s) { socket = s; }                 // вызывает только main.mjs на socketlib.ready
export async function callGM(name, ...args)                  // = socket.executeAsUser(name, game.users.activeGM.id, ...args);
                                                             // нет activeGM -> один раз ui.notifications.warn(L("noGM")) и { ok:false, reason:"no-gm" }
export function guardActiveGM() -> boolean                   // для обработчиков сокета: false, если !game.user.isActiveGM (обработчик возвращает { ok:false, reason:"not-active-gm" }; callGM повторяет один раз с актуальным activeGM)

// Настоящий сериализатор (на ОДНОМ клиенте): Map<key, Promise> «хвостов»; следующая задача стартует после завершения предыдущей (в т.ч. при её ошибке)
export function queue(key, fn) -> Promise                    // ключи: "msg:<id>", "actor:<uuid>", "region:<uuid>"
```
Межклиентную согласованность дают **не очереди**, а: (1) все мутации идут только через `callGM` на **активного** ГМа и отклоняются любым другим ГМом (`guardActiveGM`),
(2) идемпотентность по документам мира (`meta.key`).

### rules.mjs (контракт; чистая часть без Foundry для node-тестов)
```js
export const RULE_VERSION = 1;
export function validateRule(raw) -> { ok:boolean, rule:Rule|null, errors:{key,data,toString()}[] }     // в т.ч. onTurn/zone.events только null; macros по схеме §1.1 // ошибка = ключ PF2E_AUTOMATO.rules.err.* + data, текст — errText() (util.mjs); toString() — фолбэк
export function slugOf(origin, item = null) -> string|null            // §1.5
export function sourceOf(origin, item = null) -> string|null          // compendiumSource
export function deriveFromMarkup(itemLike, labels, conditionSlugByUuid) -> { rule:Rule, confidence:"high"|"low", hints:object }|null
        // itemLike = {type, slug, system:{description:{value}, defense, area, target, selfEffect}}; labels = rules/labels.json; conditionSlugByUuid = (uuid)=>slug|null (в рантайме ConditionManager.conditions.get(uuid)?.slug)
export function resolveRule(source /* Item | {origin, item?} */) -> { rule, source, slug, sourceUuid, confidence }|null   // порядок §1.2
export async function loadCatalog()                                    // ready: fetch rules/catalog.json + labels.json, validate, индексы bySource/bySlug
export function worldCatalog() -> { bySource:Map, bySlug:Map }
export async function saveWorldRule(key /* {source?|slug?} */, rule|null)   // только ГМ
export function itemFlagRule(item) -> Rule|null
export function onAttackedIndex() -> Map<string(source|slug), Rule>    // для reactions
export function onEventIndex() -> Map<string(source|slug), Rule>       // 0.5g3: правила с onEvent, для events.mjs (кэш до смены каталога)
```
Хуки: нет (чистый модуль), кроме `ready()` -> `loadCatalog()`.

### apply.mjs (контракт; исполняется ТОЛЬКО на клиенте активного ГМа)
```js
export async function applyCondition(actor, spec /* {slug,value,policy} */, meta)
      -> { op:"created"|"raised"|"skipped", item?:Item, prev?:number }
export async function applyEffect(actor, spec /* {uuid} */, meta, ctx /* {originActor, originToken, originItem, rollOptions} */)
      -> { op:"created"|"skipped", item?:Item }
export function hasEffect(actor, uuid, byActorUuid) -> boolean         // формула §1.4
export async function applyOps(message, tokenKey, steps /* Apply[] */, ctx) -> ops[]       // + запись state.*.applied dotted-путём
export async function undoOps(message, tokenKey)                                           // удалить созданное / вернуть prev
export async function removeByKey(actor, metaKeyPrefix)                                   // зона: снять всё с meta.key
export function findByKey(actor, key) -> Item|null
```
Правила реализации:
- **Состояние создаём сами, не через `increaseCondition(slug,{value})`** (§0.4): `game.pf2e.ConditionManager.getCondition(slug).toObject()` (`pf2e:33518`),
  `system.value.value = value` для valued, `flags.pf2e-automato.meta = {...}`, `actor.createEmbeddedDocuments("Item",[data])`. Если состояние уже есть:
  `policy:"max"` и текущее valued `< value` -> `ConditionManager.updateConditionValue(id, actor, value)` (`pf2e:48905`), `op:"raised"` с `prev`; иначе `skipped`.
  Исключение — зона: **всегда своя копия** с `meta.key = "zone:<regionUuid>"` (дубликаты состояний pf2e допускает: `conditions.bySlug`, `appliedBy`, `pf2e:49084+`).
- Эффект: `fromUuid(uuid)` -> `toObject()` + `system.context={origin:{actor,token,item,spellcasting:null,rollOptions},target:{actor,token},roll:null}`, `_id:null`,
  `system.traits.value` как у pf2e (`pf2e:55960–55995`) + `_stats.compendiumSource = uuid` + `meta`. Дедуп — **единственная формула `hasEffect`** (§1.4). Гонка с pf2e-automations (оно создаёт тот же эффект независимо) не устраняется —
  поэтому «уступать» по умолчанию и предупреждение при `yield:false` (§6).
- Несвязанные токены: актёр всегда `tokenDoc.actor` (синтетический). Все функции принимают актёра/токен-документ, не id.
- Все записи сериализованы `queue("actor:"+actor.uuid, ...)`.

### macros.mjs
```js
export async function runMacros(phase, ctx /* {message?, rule, region?, target?, degree?, results?, ...} */)   // активный ГМ; идемпотентно по state.macros.done
export async function runMacroRef(ref /* MacroRef */, scope) -> { ok:boolean, error?:string }               // fromUuid(ref.uuid) -> macro.execute(scope); права MACRO_SCRIPT; try/catch; 30-секундный Promise.race
```
Контракт аргументов и правила — §1.1 «Контракт макросов». Вызовы: `runUse` (onUse), `saves.afterChallenge` (afterChallenge), `apply.applyOps` (onDegree), `zone.hold/release` (zoneEnter/Exit), `reactions.useReaction` (onReaction).

### settings.mjs (K0, целиком)
```js
export function init()              // register* всех настроек (§4)
export const S = { get(key), set(key,val) }   // тонкая обёртка над game.settings с префиксом
export function modeOf(kind /* zone|effect|challenge|apply|reaction|macro */) -> "auto"|"button"|"off"
```

### compat.mjs (K0, целиком, включая `automationsCovers`)
```js
export function init()/ready()                                   // строит индекс pf2e-automations; перестраивает при смене настройки
export function automationsCovers({ slug, sourceUuid }) -> boolean
export function automationsGroups({ slug, sourceUuid }) -> string[]     // имена активных групп, покрывающих предмет (для предупреждения)
export function shouldYield(rule, { slug, sourceUuid }) -> boolean      // (rule.yield ?? settings.yieldToAutomations) && automationsCovers(...)
export function toolbeltTargetHelper() -> { enabled:boolean, checks:boolean, targets:boolean, api:object|null }
export function toolbeltMessageTargets(message) -> TokenDocument[]|null
```
Индекс `automationsCovers`: модуль `pf2e-automations` активен -> `game.settings.get("pf2e-automations","rulesV3")` (запись `uuid -> группа`, `src/index.js: H="rulesV3"`, `xe()`);
для каждой группы с `isActive` собираются **два множества**: `slugs` и `uuids`.
- `source[]`: элементы, начинающиеся с `Compendium.` -> `uuids`; остальные -> `slugs` (в `rules/config.json` встречаются оба вида: slug `"frightful-presence"` на `:8383`, UUID — у группы «Bravo's Brew», `:19060–19063`);
- предикаты (`JSON.stringify(group)`): `/(?:item|origin:item):slug:([a-z0-9-]+)|consumable:([a-z0-9-]+)/g` -> `slugs`.
`automationsCovers({slug, sourceUuid})` = `slugs.has(slug) || uuids.has(sourceUuid)` (сравнение с `_stats.compendiumSource` предмета). `toolbelt*` читают `game.toolbelt.getToolSetting(...)` / `game.toolbelt.api.targetHelper`.
Разбор `saveVariants` Toolbelt **не требуется** (§3.F).

### use.mjs (конвейер; владелец хуков `preCreateChatMessage`, `createChatMessage`, `preCreateRegion`, `createRegion`, `deleteRegion`)
```js
export function init()   // регистрация хуков ниже
// --- клиент автора (синхронные) ---
function onPreCreateMessage(message, data, options, userId)      // userId === game.user.id, иначе return
function onPreCreateRegion(region, data, options, userId)        // только флаг toolbelt skip для зон
// --- активный ГМ (асинхронные; сначала guard isActiveGM) ---
async function onCreateMessage(message, options, userId)         // runUse + приём saving-throw (saves.acceptSavingThrow) + реакции делегирует reactions.mjs
async function onCreateRegion(region, options, userId)
async function onDeleteRegion(region, options, userId)          // страховочная очистка
export async function runUse(messageId)                          // идемпотентно: onUse.apply/macros onUse/challenge без области; область — только из onCreateRegion
export async function runRegion(region, message)                 // зона и испытание по области, «последний регион задаёт цели» (§3.C)
export async function resumePending({ maxAgeMinutes })           // §3.H
export function useKindOf(message) -> "use"|"card"|null         // §3.A
```

### zone.mjs
```js
export class ZoneBehaviorType extends foundry.data.regionBehaviors.RegionBehaviorType {
  static LOCALIZATION_PREFIXES = ["PF2E_AUTOMATO.zone", "BEHAVIOR.TYPES.base"];
  static defineSchema() -> {       // БЕЗ поля events: события — статические и не редактируются в UI
    condition: StringField({blank:true}),  conditionValue: NumberField({integer:true, nullable:true, initial:null}),
    effectUuid: StringField({blank:true}),
    expiresAt: NumberField({nullable:true, initial:null}),            // БЕЗ min! worldTime в мире отрицателен (architecture.md); ЕДИНСТВЕННЫЙ источник срока
    roundsLeft: NumberField({integer:true, nullable:true, initial:null}),   // ЕДИНСТВЕННЫЙ источник счётчика раундов
    originUuid: StringField({blank:true}), originActor: StringField({blank:true}), messageId: StringField({blank:true}), closed: BooleanField()
  }
  static events = { tokenEnter: ZoneBehaviorType.#enter, tokenExit: ZoneBehaviorType.#exit };   // core/documents/region-behavior.mjs:105 (вызываются при любом наборе system.events)
  // #enter/#exit: только game.user.isActiveGM -> hold/release (this = system behavior)
  async hold(tokenDoc)  async release(tokenDoc)   // идемпотентно по meta.key = "zone:<region.uuid>"; macros zoneEnter/zoneExit — только при реальном изменении
  get expired()                                    // expiresAt!=null && worldTime>=expiresAt, или roundsLeft===0, или closed
}
export function init()      // CONFIG.RegionBehavior.dataModels[`${MOD}.zone`], typeLabels/typeHints/typeIcons;  Hooks: updateWorldTime, updateCombat, userConnected, createItem, deleteItem
export async function attachZone(region, rule, originInfo)       // createEmbeddedDocuments("RegionBehavior") + sweepZone (источник срока — поведение)
export async function sweepZone(region)                          // region.hidden -> release всем; иначе токены сцены: testInsideRegion -> hold; не внутри и держат наше -> release
export async function expireZones()                              // сканирует сцены; expired -> deleteRegionOnce
export async function closeZone(regionUuid)                     // кнопка «Закрыть зону» (идемпотентно)
export async function purgeZoneState(regionUuid)                 // deleteRegion: снять всё с meta.key "zone:<uuid>" у актёров токенов сцены (+ world actors)
export async function reconcileZones()                           // ready/смена ГМ: sweepZone для регионов с нашим поведением; уважает modeOf("zone")
async function deleteRegionOnce(region)                          // защита от двойного delete: Set<regionId> «удаляется сейчас» + проверка region.parent.regions.has(id) + try/catch на «does not exist»
```
Хуки: `updateWorldTime(worldTime)` -> `expireZones()` (частый хук: `expireZones` ничего не делает, если нет зон на активных сценах; `deleteRegionOnce` не допускает двойного delete);
`updateCombat(combat, changes, options)` (`"round" in changes && options.direction===1`) -> декремент `roundsLeft` в зонах сцены боя -> `expireZones()`;
`userConnected` -> если `isActiveGM` -> `reconcileZones()` + `resumePending()`.
**Скрытый регион**: `RegionDocument#_handleEvent` для `hidden` ничего не доставляет (`core/documents/region.mjs:2555`, `:2569`) — отдельные enter/exit при смене `hidden` ядро шлёт напрямую поведениям (`:2395–2440`), поэтому `sweepZone` для `hidden`-региона только снимает, а `updateRegion` с изменением `hidden` вызывает `sweepZone`.
**Хуки для pf2e-vision** (из документов, а не из событий региона — реплицируются и срабатывают ровно один раз на каждом клиенте): `createItem`/`deleteItem` для `item.type==="condition"|"effect"` с `flags[MOD].meta.key` на `zone:` ->
`Hooks.callAll("pf2e-automato.zoneEnter" | "pf2e-automato.zoneExit", { region: fromUuidSync(meta.region), actor: item.actor, tokens: item.actor.getActiveTokens(false,true), item, meta })`.

### saves.mjs
```js
export function init()            // нет хуков (приём результатов вызывается из use.onCreateMessage); чистые функции
export function isPcActor(actor) -> boolean                         // actor.hasPlayerOwner
export async function rollSave(actor, challenge, ctx) -> {degree,total,rollMessage}|null     // statistic.check.roll; ctx.marker = `${MOD}:${messageId}:${tokenKey}` в extraRollOptions
export async function runChallenge(message, {only?:tokenKey})       // ГМ: для NPC-целей — бросок; для PC — ждёт кнопку (mode challenge: auto|button)
export async function acceptSavingThrow(message)                    // §3.C-6: любое saving-throw-сообщение -> recordResult
export async function recordResult(messageId, tokenKey, result)     // ГМ; результат принимается, пока не применено; после применения — changedAfterApply + оповещение ГМу
export async function afterChallenge(message)                       // все цели имеют результат -> macros afterChallenge
export async function applyByDegree(messageId, tokenKey|"all")      // ГМ; по mode "apply" вызывается сразу или по кнопке
export async function resolveDC(use, ctx) -> number|null            // value | expr (enrichHTML + a.inline-check[data-pf2-dc]) | markup | spell | against
export function damageMultiplier(degree, basic) -> 0|0.5|1|2|null
```

### chat.mjs
```js
export function init()    // Hooks.on("renderChatMessageHTML")
export async function ready()                                 // getTemplate("modules/pf2e-automato/templates/chat-block.hbs") -> кэш (синхронный вызов в хуке)
function renderBlock(message, html)                          // добавляет <div class="pf2e-automato"> в .message-content из flags[MOD].use; видимость по ролям
export function buildViewModel(message, user) -> object      // чистая функция (юнит-проверяема): строки целей, кнопки, режимы, предупреждения, low-кнопки
```
Кнопки (`data-action`): `roll-save` (владелец актёра-цели или ГМ), `apply` / `apply-all` / `undo` / `apply-derived` / `set-dc` / `resume` / `create-zone` / `close-zone` (ГМ; `close-zone` ещё автор), `use-reaction`. Нажатие: PC-бросок — локально у игрока (`rollSave`; результат ГМ получит из созданного saving-throw-сообщения); остальное — `callGM(...)`.

### reactions.mjs
```js
export function init()    // Hooks: createChatMessage (вызывается из use.onCreateMessage), pf2e.startTurn (сброс траты реакции)
export async function onAttackMessage(message)                      // context.type === "attack-roll" (+ "spell-attack-roll"), context.target.actor
export function recalcWithBonus(message, bonus) -> { before:0..3, after:0..3, changes:boolean }   // §3.D', чистая
export async function useReaction(hintMessageId)             // ГМ (сокет): пересчёт, карточка черты, пометка
export function reactionAvailable(actor) -> boolean          // учитывает флаг только в текущем раунде боя
```

### sheet.mjs
```js
export function init()   // Hooks.on("renderItemSheetPF2e", (app, $html, data) => ...)   — AppV1, §6
async function injectTab(app, $html, data)
```

### main.mjs (K0, целиком)
```js
import { setSocket, MOD } from "./util.mjs";
Hooks.once("socketlib.ready", () => {                         // на верхнем уровне скрипта: socketlib.ready вызывается внутри init socketlib (socketlib.js:18–20)
  const s = socketlib.registerModule(MOD); setSocket(s);
  for (const [name, fn] of Object.entries(HANDLERS)) s.register(name, fn);        // HANDLERS — объект заглушек K0 с полным списком имён §5
});
Hooks.once("init", () => { settings.init(); compat.init(); zone.init(); use.init(); chat.init(); reactions.init(); sheet.init(); });
Hooks.once("ready", async () => {
  warnPrototypes();                                           // активен pf2e-autoflow-proto-* -> ui.notifications.warn(L("protoWarning")) (+ пункт в README)
  await rules.ready(); await chat.ready(); compat.ready();
  if (game.user.isActiveGM) { await zone.reconcileZones(); await use.resumePending({ maxAgeMinutes: S.get("resumeMinutes") }); }
});
game.modules.get(MOD).api = { attachZone, sweepZone, closeZone, expireZones, resolveRule, runUse, runRegion, runChallenge, recordResult, applyByDegree, runMacros, automationsCovers, onAttackMessage, useReaction, recalcWithBonus };   // для харнесса, K1/K3/K5-критериев и pf2e-vision
```
Публичные хуки для pf2e-vision (`pf2e-automato.zoneEnter/zoneExit`) вызываются из `createItem/deleteItem` (§2 zone), не из `main`.

## 3. Хуки и порядок событий по сценариям

Обозначения: **A** = клиент автора (игрок или ГМ), **GM** = клиент активного ГМа (`game.user.isActiveGM`; все обработчики **GM** начинаются с `guardActiveGM`), **ALL** = все клиенты.
Режимы (§4): `auto` / `button` / `off`.

### 3.A Общий вход: распознавание использования (`preCreateChatMessage`, **A**, синхронно)
1. `userId === game.user.id` иначе выход. Пропуск: `message.flags.pf2e.context?.type` в {`self-effect`, `attack-roll`, `damage-roll`, `saving-throw`, `skill-check`, `flat-check`…} кроме `spell-cast`;
   предмет с `system.selfEffect` (делает система, `pf2e:54140`); сообщение уже содержит `flags[MOD]`.
2. Определить `kind`:
   - `consume` (origin без `rollOptions`, тип предмета consumable) -> `"use"`;
   - `origin.rollOptions` содержит `origin:action:slug:cast-a-spell` (константа `Dt`, `pf2e:94`; ставится только при настоящем касте, `pf2e:53337`) -> `"use"`;
   - карточка **действия/черты** без `selfEffect` (`pf2e:54143`) -> `"use"` (любая карточка);
   - карточка предмета (`toMessage`, `pf2e:45409+`): consumable/equipment/spell без каста — `"card"` (исполняет **только** то, что связано с регионом из неё, см. п. 6).
3. `rule = resolveRule({origin, item: message.item})` (`ChatMessagePF2e#item`, `pf2e:29380`; для расходника — `fromUuidSync(origin.uuid)` жив; нет предмета — только `bySource` по `origin.sourceId`). Нет правила — выход.
4. `compat.shouldYield(rule, {slug, sourceUuid})` -> снимок **всё равно пишется** с `state.yielded:"pf2e-automations"` (автор пишет его сам — реестр построен на каждом клиенте, мировая настройка читается всеми); исполнения нет, блок показывает «Выполняет pf2e-automations».
5. Снимок (§1.4): `targets` из `game.user.targets`, `dc` (число, если `rule.challenge.dc.value`, либо СЛ заклинателя `message.item?.spellcasting?.statistic?.withRollOptions({item}).dc.value`, `pf2e:53350`), копия `rule`, `confidence`, `src`, `createdAt`.
   `message.updateSource({"flags.pf2e-automato.use": snapshot})`.
6. **Расходник с областью** (`pf2e:51063–51081`: consume-сообщение — это просто строка «использовал X», `@Template` в нём нет): если `rule.onUse.targets === "area"` и `kind:"use"` пришёл из `consume`, то consume-снимок **не** ждёт исполнения (флаг `state.awaitingRegion:true` для блока, не попадает в `resumePending`),
   а акт использования для зоны/испытания по области — **создание региона из карточки** (снимок карточки `kind:"card"` с тем же правилом, `region.flags.pf2e.messageId`): `runRegion` исполняет зону/испытание **независимо от `kind` сообщения-источника региона**.
   Для всех остальных частей правила (`apply`, `macros onUse`, испытание `targets:"selected"`) источник — только `kind:"use"`.

### 3.B Сценарий 1 — зона (дымовая шашка), автор = игрок или ГМ
1. **A**: «Использовать» -> `consume` создаёт сообщение (3.A) и удаляет расходник. Игрок (или тот же ГМ) жмёт `@Template` в карточке — `InlineRollLinks#r` -> `canvas.regions.placeRegion(...)` (`pf2e:28787`, регион: `flags.pf2e={areaShape, messageId: <карточка>, origin: getOriginData()}`);
   либо кнопка области заклинания -> `placeRegionFromItem` (`pf2e:3379`, плюс `origin.slug/name/traits`, `ownership`).
   `core/canvas/layers/regions.mjs:688` `placeRegion`: при **паузе игры игрок регион не создаст** (null) — в README (§7.U-13).
2. **A**, `preCreateRegion(region, data, options, userId)`: `messageId = data.flags.pf2e.messageId` -> `game.messages.get(id)?.flags[MOD].use` ИЛИ `resolveRule({origin: data.flags.pf2e.origin})`;
   `rule.onUse.zone && modeOf("zone") !== "off" && !state.yielded` -> `region.updateSource({"flags.pf2e-toolbelt.targetHelper.skip": true})` (флаги игрок писать может). Поведения здесь **не** добавляем (игрок не может, §0.1).
3. **ALL**: ядро создаёт регион; `RegionDocument._onCreateOperation` (`core/documents/region.mjs:2349`): активный ГМ запускает `#updateTokens` (запись `token._regions`), токены шлют `tokenEnter` (без нашего поведения — игнор).
4. **GM**, `createRegion(region, options, userId)` -> `runRegion(region, message)`: снимок по `region.flags.pf2e.messageId` (`region.message`, `pf2e:20866`); нет сообщения — каскад `resolveRule` по `origin`. **Последний регион задаёт всё**: если у сообщения уже есть `state.zone.regionUuid` другого региона — предыдущая зона закрывается (`closeZone`) до создания новой.
   Режим `zone`:
   - `auto`: `zone.attachZone(region, rule, origin)` — `createEmbeddedDocuments("RegionBehavior", [{type:"pf2e-automato.zone", name, system:{condition, expiresAt: worldTime+seconds, roundsLeft: rounds, originUuid, originActor, messageId}}])`;
     затем **`sweepZone(region)`** (`token.testInsideRegion(region)`, `core/documents/token.mjs:3236`, pf2e-версия `pf2e:28166`) -> `hold(token)`. `hidden`-регион: `sweepZone` только снимает (§2 zone);
   - `button`: пишем `state.zone={status:"pending", regionUuid}`, в блоке кнопка «Создать зону» (ГМ) -> `createZone` -> тот же `attachZone`;
   - `off`: ничего. `confidence:"low"` (зона из разметки) — всегда `button` (§3.G).
   Запись: `message.update({"flags.pf2e-automato.use.state.zone": {regionUuid, status:"active"}})` — сроки лежат только в поведении региона.
5. `hold(token)` (**GM**, `queue("actor:"+uuid)`): `findByKey(actor, "zone:"+region.uuid)` есть — выход; иначе `applyCondition(actor, spec, meta{key:"zone:<region.uuid>"})`; затем макросы `zoneEnter`. Публичный хук `pf2e-automato.zoneEnter` срабатывает на **всех** клиентах из `createItem` созданного состояния (§2 zone).
6. Токен вышел/вошёл: ядро шлёт `tokenExit`/`tokenEnter` **всем** клиентам (`core/documents/token.mjs:2830–2850`); статические обработчики зоны у не-ГМов ничего не делают, у активного ГМа -> `release/hold`.
7. Конец зоны:
   - `updateWorldTime`/`updateCombat` у ГМа -> `expireZones()` -> `deleteRegionOnce(region)` -> ядро шлёт `tokenExit` (`core/documents/region.mjs:2470–2490`) -> `release`;
   - кнопка «Закрыть зону» -> `callGM("closeZone", regionUuid)` -> `deleteRegionOnce` (уже удалён — тихо `ok`);
   - ГМ удалил регион руками (или Toolbelt) -> то же;
   - **страховка**: `deleteRegion` (**GM**) -> `purgeZoneState(region.uuid)` (§2).
8. Нет ГМа: игрок ставит регион — события не обрабатываются. Когда ГМ входит (`ready`/`userConnected`) -> `reconcileZones()` (§3.H): **только** регионы, у которых уже есть наше поведение (sweep), и истёкшие (удалить); новые поведения создаются лишь из снимков моложе `resumeMinutes` и **только если `modeOf("zone")==="auto"`**.

Игрок-инициатор не пишет в мир ничего, кроме региона/сообщения (его права) — состояния ставит ГМ. Сообщения/регион без правила — модуль не вмешивается.

### 3.C Сценарий 2 — «Огненное дыхание» (область + испытание Реакции basic)
1. **A** (чаще ГМ за NPC): каст заклинания NPC -> `ChatMessagePF2e` с `origin` (с `castRank`) и `casting`; `context.type:"spell-cast"` только при `system.defense` (`pf2e:53350`). 3.A -> `kind:"use"`, `rule` (каталог или вывод из `defense.save`), `dc` = СЛ заклинания.
2. Кнопка области -> `placeRegionFromItem` -> **A** `preCreateRegion`: у правила `zone:null` -> `skip` **не** ставим (Template Helper на обычных областях — как раньше).
3. **GM**, `createRegion` -> `runRegion`: `targets:"area"`, `challenge` есть:
   - собрать цели **сразу**, пока регион жив: токены сцены с `token.testInsideRegion(region)` (не `region.tokens` — он заполняется позже); автор исключается по `excludeSelf` (по умолчанию emanation — да, burst/cone/line — нет);
   - **последний регион сообщения задаёт набор целей**: `state.area = {regionUuid, keys}` заменяется; результаты целей, которых нет в новом наборе и которые ещё **не применены**, отбрасываются (`state.challenge.results[key]` удаляются); применённые остаются. Удаление региона Toolbelt'ом после «Target» цели **не** сбрасывает (на `deleteRegion` цели не трогаем);
   - затем `saves.runChallenge(message)`.
4. `runChallenge` (**GM**, `queue("msg:"+id)`), режим `challenge`: `auto` — NPC-цели (`!actor.hasPlayerOwner`): `rollSave` на клиенте ГМа с `skipDialog:true`, `messageMode` из настройки; PC-цели — только кнопка «Бросить»; `button` — все цели кнопкой; `off` — только список.
   Бросок передаёт `extraRollOptions:["pf2e-automato:<messageId>:<tokenKey>"]` (маркер) и, если предмет жив, `item`+`origin` (как делает pf2e для инлайн-проверки, `pf2e:28692–28770`).
5. PC-цель: клиент игрока (владелец), «Бросить» -> локальный `rollSave` (без `skipDialog`) -> pf2e создаёт обычное `saving-throw`-сообщение. Отдельного сокета результата **нет** — результат приходит по п. 6.
6. **Приём результата (любой источник)**: **GM**, `createChatMessage` с `context.type === "saving-throw"` -> `saves.acceptSavingThrow(message)`: сопоставление (1) по маркеру в `context.options` (`pf2e-automato:<msg>:<tokenKey>`), иначе (2) по `flags.pf2e.origin.uuid === use.item.uuid` и токену/актёру броска среди целей незакрытого испытания (свежайшее сообщение, не старше `resumeMinutes`).
   Это покрывает нашу кнопку, бросок Toolbelt Target Helper и инлайн-`@Check` в карточке. Степень — `message.rolls[0].degreeOfSuccess` (`pf2e:19316`).
   **Перебросы** (hero point и т.п.): pf2e удаляет старое сообщение и создаёт новое с `context.isReroll` (`pf2e:19670–19679`); опции (в т.ч. маркер) сохраняются — новый результат **перезаписывает** прежний, пока он не применён; если уже применён — `changedAfterApply:true`, блок помечает «результат изменён после применения», ГМу шёпот; состояния сами не откатываются (ГМ жмёт «Отменить»/«Применить»).
7. `byDegree` пуст (basic без состояний) -> блок показывает множитель урона и **ничего не применяет**. Если `byDegree` заполнен — режим `apply` (по умолчанию `button`): ГМ жмёт «Применить»/«Применить всё» -> `callGM("applyByDegree")` -> `apply.applyOps` (+ `onDegree`-макросы; когда у всех есть результат — `afterChallenge`).
8. Нет ГМа: бросков/применений нет; блок «Ожидает ГМа»; `resumePending()` — §3.H.

### 3.D Сценарий 3 — Frightful Presence с frightened по степеням («уступить pf2e-automations»)
- Цепочка как 3.C (`targets:"selected"` -> цели из снимка `game.user.targets`, без региона). Пока `pf2e-automations` активен и покрывает предмет (slug **или** `_stats.compendiumSource`) и `yield !== false` — снимок пишется с `state.yielded`, исполнения нет.
- `yield:false` или настройка `yieldToAutomations=false`: выполняется как 3.C со `byDegree` (`policy:"max"`). **Двойное применение**: pf2e-automations ловит `saving-throw` с `item:slug:...` и на наш бросок (`rules/config.json:8387–8434`) — блок и вкладка показывают предупреждение
  «Группа “<имя>” в pf2e-automations тоже сработает на этот бросок; отключите её или не снимайте уступку» (`compat.automationsGroups`). Модуль двойное применение **не предотвращает**.
- Применение к цели — `applyCondition(tokenDoc.actor, ...)` на клиенте ГМа (права игрока не нужны).

### 3.D' Сценарий 4 — реакция «Ловкое уклонение» (постфактум)
1. Игрок/NPC атакует: pf2e создаёт `attack-roll`-сообщение (`context.type:"attack-roll"`, `context.target.{actor,token}`, `context.dc.value`, `context.outcome`, `pf2e:19448–19480`; `rolls[0].degreeOfSuccess`, `pf2e:19316`).
2. **GM**, `onCreateMessage` -> `reactions.onAttackMessage`: актёр цели -> предметы актёра, чей `sourceOf`/slug есть в `rules.onAttackedIndex()` (или флаг `rule.onAttacked` на предмете).
   Условия: режим `reaction` ≠ off; реакция доступна (`reactionAvailable`: флаг `reactionSpent = {combat, round}` **действует только если** `game.combat?.id === combat` и `game.combat.round === round`; вне боя флаг не ставится и не проверяется — «навсегда» не залипает);
   атака попала по КБ и `+bonus` меняет итог (`reaction.onlyWhenChanges`, по умолчанию true).
   **Переброс атаки** (`context.isReroll`): новую подсказку **не** создаём — обновляем существующую для той же пары атакующий/цель (пересчёт `before/after`, `attack` -> новое сообщение); если она уже `used` — только пометка.
3. ГМ создаёт **шёпот** `ChatMessage.create({whisper:[owners + GMs], flags:{pf2e-automato:{reaction:{attack: messageId, actor, item, before, after, used:false}}}})`; текст/кнопка — в `renderChatMessageHTML`. На актёре ничего не создаётся (висящего бонуса нет).
4. «Использовать» (владелец актёра или ГМ) -> `callGM("useReaction", hintId)`: `recalcWithBonus(attackMessage, +bonus)` -> новый исход этой атаки в том же шёпоте; `reaction.used=true`; затем
   - если активен `pf2e-auto-action-tracker` (`game.modules.get("pf2e-auto-action-tracker")?.active`) — **отправить карточку черты** `item.toMessage()` (трекер сам спишет реакцию по карточке; точный механизм — §7.U-20);
   - собственный флаг `reactionSpent` ставится **только в бою** и служит лишь фильтром подсказок текущего раунда. Макросы `onReaction`.
   Идемпотентность: при `used:true` — возврат без изменений.
5. `pf2e.startTurn` (`pf2e:26725`) -> **GM** снимает `reactionSpent` у актёра этого комбатанта.
   Пересчёт: `delta = degreeFromTotal(total, dc+bonus, die) - degreeFromTotal(total, dc, die)`; `after = clamp(degreeOfSuccess + delta, 0, 3)`.
6. Нет ГМа: подсказка не создаётся. Принято.

### 3.E Эффекты без области (расходник/черта на себя) — режим `effect`
**GM**, `runUse(messageId)` для `kind:"use"` с `onUse.apply` и `confidence:"high"`: `auto` -> сразу `applyEffect` на `use.actor` (`to:"self"`) / на цели снимка (`to:"target"`); `button` -> кнопка «Применить» в блоке;
ключ `"<messageId>:<targetKey|self>:<n>"` + `hasEffect` (§1.4). Затем макросы `onUse`. `confidence:"low"` — §3.G.

### 3.F Интеграция Toolbelt Target Helper (если `game.toolbelt.getToolSetting("targetHelper","enabled")` и `useToolbeltTargetHelper`)
- Цели: в `runChallenge` вместо снимка берём `game.toolbelt.api.targetHelper.getMessageTargets(message)` (TokenDocument[], dedupe по `troop`/актёру), когда они там есть; если Toolbelt «ведёт испытания» — **его цели и есть цели испытания**.
- Результаты: **не бросаем сами за PC**; **не разбираем `saveVariants`**: любые `saving-throw`-сообщения принимаются общим путём 3.C-6 (бросок через Toolbelt создаёт такие сообщения с origin-предметом). NPC-цели при включённом Toolbelt тоже бросает Toolbelt (по его кнопке) — наш авто-бросок отключается (`runChallenge` ничего не бросает, блок «Испытания выполняет Toolbelt»), если его настройка `checks` включена у ГМа.
- На зонах Template Helper не показываем (флаг `skip`, §3.B-2); на обычных областях он работает как раньше, а наш `createRegion` берёт цели `testInsideRegion` независимо (и затем, если Toolbelt прислал свои цели, — его набор побеждает как более поздний источник).

### 3.G Распознанное из разметки: low-кнопка «Применить (распознано)»
`confidence:"low"` (§1.3: action/feat с эффектом без `selfEffect`, зона из `@Template`+состояния): **GM**, `runUse`/`runRegion` не исполняют, а пишут `state.derived.pending:[stepKey]`; блок показывает ГМу (и автору) кнопку «Применить (распознано)» с кратким описанием шага
(«эффект X на себя», «зона: concealed»). Нажатие -> `callGM("applyDerived", messageId, stepKey)` -> тот же `applyEffect`/`attachZone`, `meta.source:"derived"`, идемпотентно по `stepKey` и `hasEffect`; перенос `pending -> applied`. Режим вида `off` скрывает кнопку.
Правило не сохраняется в предмет автоматически (чтобы разметка не «закреплялась»); ГМ может сохранить его вкладкой (§6).

### 3.H Дозапуск и давность (`resumePending`, `reconcileZones`)
- `resumePending({maxAgeMinutes})` (GM: `ready`, `userConnected`): перебирает последние 100 сообщений мира с `flags[MOD].use`, `kind:"use"`, `state.yielded == null`, незавершённые (`runUse` не отметил `done`), **моложе `resumeMinutes`** (по `use.createdAt`; по умолчанию 30). Старые остаются в блоке с «Ожидает ГМа» и кнопкой **«Дозапустить»** (`resume` -> `callGM("resumeUse", messageId)`).
- Каждый шаг уважает режим вида: `modeOf(kind)==="button"` -> кнопка, не авто; `off` -> ничего.
- `reconcileZones()`: (a) регионы с нашим поведением -> `sweepZone`; (b) истёкшие -> `deleteRegionOnce`; (c) регионы со снимком, где ждали зону (`state.zone.status` отсутствует, снимок моложе окна) — `attachZone` **только** при `modeOf("zone")==="auto"`.
- Всё идемпотентно (`meta.key`, `state.*.applied/done`).

## 4. Настройки (`settings.mjs`, K0)

Префикс i18n `PF2E_AUTOMATO.settings.<key>.name/hint`. Все — `game.settings.register("pf2e-automato", key, {...})`.

| key | scope | type | default | choices / примечание |
|---|---|---|---|---|
| `mode.zone` | world | String | `"auto"` | auto \| button \| off — зоны |
| `mode.effect` | world | String | `"auto"` | auto \| button \| off — эффекты на себя/союзников |
| `mode.challenge` | world | String | `"auto"` | auto \| button \| off — испытания: auto = NPC за ГМа сразу, PC кнопкой (решение пользователя) |
| `mode.apply` | world | String | `"button"` | auto \| button \| off — состояния врагам по степеням (кнопка «Применить» ГМу) |
| `mode.reaction` | world | String | `"auto"` | auto (подсказка шёпотом) \| off |
| `mode.macro` | world | String | `"auto"` | auto \| off — макросы правил (§1.1) |
| `yieldToAutomations` | world | Boolean | `true` | уступать `pf2e-automations`; переопределяется `rule.yield` |
| `useToolbeltTargetHelper` | world | Boolean | `true` | при включённом Target Helper не бросать самим (§3.F) |
| `challenge.messageMode` | world | String | `"gm"` | public \| gm — видимость бросков NPC |
| `reaction.onlyWhenChanges` | world | Boolean | `true` | подсказка реакции только если бонус меняет исход |
| `resumeMinutes` | world | Number | `30` | давность дозапуска (§3.H), 1–1440 |
| `catalog` | world | Object | `{bySource:{}, bySlug:{}}` | `config:false`, мировой каталог правил |
| `debug` | client | Boolean | `false` | логирование |

Параметры `mode.*` — один `Select`, регистрируются циклом. Меню не нужно. `onChange` `yieldToAutomations` -> `compat` перестраивает реестр. Настройки pf2e-automations/Toolbelt модуль только **читает**.

## 5. Сокеты (socketlib 1.1.4)

`socket = socketlib.registerModule("pf2e-automato")` в `Hooks.once("socketlib.ready")` на верхнем уровне `main.mjs`; экземпляр хранится в `util.mjs` (`setSocket`, `callGM`) — нет цикла импортов.
**Все мутации идут к активному ГМу**: `callGM(name, ...args)` = `socket.executeAsUser(name, game.users.activeGM.id, ...args)` (`socketlib.js:100–110`; если активный ГМ — сам вызывающий, выполняется локально).
`executeAsGM` **не используем**: он выполняет обработчик локально на любом ГМ-клиенте (`socketlib.js:88–90`) — это дало бы двух исполнителей. Каждый обработчик начинается с `guardActiveGM()`; при отказе возвращает `{ok:false, reason:"not-active-gm"}`, `callGM` повторяет вызов один раз.
Нет активного ГМа -> `callGM` один раз показывает `ui.notifications.warn` и возвращает `{ok:false, reason:"no-gm"}`.
Обработчики — обычные `function` (не стрелки), чтобы читать `this.socketdata.userId` (`socketlib.js:191, 251`) для проверки прав отправителя.

| имя | вызывает | действие | идемпотентность / проверки |
|---|---|---|---|
| `rollSaveFor(messageId, tokenKey)` | кнопка ГМа / владельца NPC-цели | `saves.runChallenge(message,{only})` | если результат есть — ничего |
| `applyByDegree(messageId, tokenKey\|"all")` | «Применить/Применить всё» | `apply.applyOps` по `byDegree` (+`onDegree`-макросы) | `meta.key` + `state.challenge.applied[tokenKey]`; повтор = skipped |
| `undoApplied(messageId, tokenKey\|"all")` | «Отменить» | `apply.undoOps` | удаляет только записанное в `ops` и существующее |
| `applyUse(messageId, targetKey?)` | кнопка `mode.effect=button` | `apply.applyEffect/Condition` из `onUse.apply` | ключ `"<msg>:<target>:<n>"` + `hasEffect` |
| `applyDerived(messageId, stepKey)` | «Применить (распознано)» | §3.G | `state.derived.applied` + `hasEffect` |
| `createZone(messageId, regionUuid)` | «Создать зону» (`mode.zone=button`) | `zone.attachZone` + `sweepZone` | если поведение нашего типа уже есть — только `sweepZone` |
| `closeZone(regionUuid)` | «Закрыть зону» | `deleteRegionOnce` | нет региона = ok |
| `resumeUse(messageId)` | «Дозапустить» | `use.runUse` + область | идемпотентно по `state` |
| `setDC(messageId, value)` | «Ввести СЛ» (ГМ) | пишет `use.dc` | перезапись допустима до первого результата |
| `useReaction(hintMessageId)` | кнопка реакции | `reactions.useReaction` | `reaction.used` уже true -> возврат |
| `saveCatalogRule(key, rule\|null)` | вкладка (только ГМ-инициатор) | `rules.saveWorldRule` | перезапись по ключу; `validateRule` |

Результат PC-броска отдельного сокета **не** имеет: приходит из `createChatMessage` (§3.C-6). **K0 создаёт `HANDLERS` со всеми этими именами и сигнатурами** (тела — заглушки, реализуют владельцы кусков).

## 6. Вкладка «Автоматизация» в листе предмета

**Проверено: `ItemSheetPF2e extends foundry.appv1.sheets.ItemSheet` (`pf2e:50024`, `static _warnedAppV1 = true`) — AppV1/jQuery.** Шаблон `systems/pf2e/templates/items/sheet.hbs`:
навигация `<nav class="sheet-tabs"><div class="tabs" data-tab-container="primary"><a class="list-row" data-tab="…">`, тело `<div class="sheet-body"><section class="tab <name>" data-tab="<name>">`.
Опции `tabs: [{navSelector:".tabs", contentSelector:".sheet-body", initial:"description"}, …]` (`pf2e:50033–50041`).

**Встраивание без lib-wrapper** — хук `renderItemSheetPF2e` (AppV1 вызывает `render<ИмяКласса>` по цепочке наследования, `core/appv1/api/application-v1.mjs:459, 493–498`; имена классов в `pf2e.mjs` сохранены: `ItemSheetPF2e`, `ConsumableSheetPF2e`…):
1. Только если `game.user.isGM`; тип предмета ∈ {action, feat, spell, consumable, equipment, weapon, armor, shield, effect?…} — разрешаем всем кроме `condition/effect/ancestry/…` (список в `sheet.mjs`).
2. `$html.find("nav.sheet-tabs .tabs").append('<a class="list-row" data-tab="automato">Автоматизация</a>')`; `$html.find(".sheet-body").append(await renderTemplate("modules/pf2e-automato/templates/sheet-tab.hbs", ctx))`
   (контейнер `<section class="tab automato" data-tab="automato">`).
3. **Переключение вкладок уже работает без доп. кода**: контроллер `Tabs` ищет вкладки динамически и повешен делегированием на `nav` (`core/applications/ux/tabs.mjs:103–120, 165–171`). Проблема одна: при повторном рендере `bind` вызывается **до** нашего хука и, не найдя
   `automato`, сбрасывает активную вкладку на первую. Решение: запоминать `app._afTab = true` в обработчике клика по нашей вкладке и после вставки вызывать `app._tabs[0].activate("automato")`, если она была активной до рендера (не запрашивать `triggerCallback`).
4. Внутри вкладки (Handlebars, `ctx` строится `sheet.mjs`):
   - «Распознано»: источник правила (`flag/world/catalog/markup`), slug (+ каскад: чем получен), `confidence`, разобранные `@Check/@Template/@UUID` (`deriveFromMarkup`), подсказка `inflicts:`;
   - бейдж «Выполняет pf2e-automations» (по `compat.automationsGroups`) + переключатель «Уступать» (`auto/yes/no` -> `rule.yield`). **При `yield:false` (или выключенной настройке) и активной покрывающей группе — красное предупреждение «двойное применение: отключите группу “<имя>” в pf2e-automations»** (§3.D);
   - форма правила: блок «Область/цели» (`targets`, `excludeSelf`), «Зона» (состояние/эффект, секунды, раунды), «Испытание» (statistic, СЛ тип/значение, basic, по степеням — 4 строки со списком Apply: состояние+значение / эффект UUID / заметка), «Реакция» (бонус КБ), «Макросы» (список `{макрос, фаза, степень}`);
   - кнопки: «Сохранить в предмет» (`item.setFlag(MOD,"rule", rule)`), «Сбросить» (`unsetFlag`), «Для всех с этим источником» / «Для всех с этим slug» (`rules.saveWorldRule({source}|{slug}, rule)`; единственный путь для заблокированных компендиев), «Принять распознанное» (копирует выведенное правило, в т.ч. `low`, в флаг — для закрепления/правки);
   - вкладка — **только просмотр/правка**; исполнение распознанного (в т.ч. low) идёт кнопками в чате (§3.G), не через вкладку (на тысячи предметов вкладка не масштабируется).
5. Запись только через собственные кнопки; поля формы **без атрибута `name`**, чтобы `FormDataExtended` листа не отправил их в `item.update` (`_updateObject` листа pf2e игнорирует чужие поля, но не рисковать). Данные собирает `sheet.mjs` из DOM, валидирует `validateRule`, ошибки — под полем.
6. Предмет в заблокированном компендии: `item.isOwner` false/`pack.locked` — форма `disabled`, активны только «Для всех…» и просмотр распознанного. После `setFlag` лист перерисуется AppV1 (`updateItem`), хук вставит вкладку снова.
7. Игрокам вкладку не показываем (правила — зона ответственности ГМа). Флаг `rule` на предмете игрока меняет только ГМ.

## 7. Точное API: где в исходниках, что не подтверждено

### 7.A Подтверждено статически (файл:строка / grep-маркер)

**Ядро v14.366 (`core/` = `E:/Foundry VTT v14.366/app/resources/app/client/`)**
- `RegionBehaviorType._createEventsField`, `static events`, `_handleRegionEvent`, `get region`: `core/data/region-behaviors/base.mjs:29, 63, 111`; диспетчеризация: `core/documents/region-behavior.mjs:100–112` (static `events` И `system.events.has(name)` -> `system._handleRegionEvent`).
- `REGION_EVENTS` (`tokenEnter/tokenExit/tokenTurnStart`…): `common/constants.mjs:2009+`.
- Регион: `_onCreateOperation` (`core/documents/region.mjs:2349`, активный ГМ -> `#updateTokens` `:2309`), `_onDeleteOperation` (`:2470`, tokenExit для `region.tokens`), `_handleEvent` (`:2553`, `@internal` — **не оборачиваем**), `_onCreateDescendantDocuments` (`:2567`, enter для `this.tokens` при добавлении поведения), `_onUpdateDescendantDocuments` (`:2606`, disable -> exit).
- `TokenDocument#testInsideRegion` (`core/documents/token.mjs:3236`), `_identifyRegions` (`:2210`), enter/exit при движении (`:2818–2850`); pf2e-переопределение `testInsideRegion` (`pf2e:28166`).
- `Scene#updateTokenRegions` (`core/documents/scene.mjs:551`) — публичный, как страховка вручную, **в плане не используется** (свой свип).
- `EmbeddedCollectionField#_updateDiff/_updateElement` создаёт записи при `updateSource({behaviors:[…]})` (`common/data/fields.mjs:3062, 3110–3150`) — для регионов, создаваемых ГМом, допустимо, но план не опирается (§0.1).
- Права: `common/documents/region.mjs:112` (`#canCreate`), `region-behavior.mjs:70` (создавать поведение может только ГМ), `constants.mjs:1375` (`REGION_CREATE` по умолчанию у PLAYER).
- `canvas.regions.placeRegion` (`core/canvas/layers/regions.mjs:688`; `null` при паузе для не-ГМ, `:~690` описание).
- `User#isActiveGM` (`core/documents/user.mjs:86`), `game.users.activeGM`; `canvas.tokens.setTargets` (`core/canvas/layers/tokens.mjs:341`).
- `renderChatMessageHTML(message, html:HTMLElement, context)` (`core/documents/chat-message.mjs:407, 449`; `hooks.mjs:1387`).
- AppV1: `_callHooks("render", html, data)` (`core/appv1/api/application-v1.mjs:459`), `_callHooks` цепочка `:493`, `Tabs.bind/activate/_onClickNav` (`core/applications/ux/tabs.mjs:103, 128, 165`).
- `getTemplate/renderTemplate/loadTemplates` (`core/applications/handlebars.mjs:30, 102, 80`); `TextEditor.enrichHTML` (`core/applications/ux/text-editor.mjs:123`).
- Бой: хук `combatRound` (локальный, до `update`) и `updateCombat`; `getTimeDelta`, `CONFIG.time.roundTime` (`combat.mjs:222–258`, `config.mjs:1993–1999`); pf2e выставляет `roundTime = 6` (`pf2e:116922`).
- socketlib: `executeAsGM` (`modules/socketlib/src/socketlib.js:87`), `socketlib.ready` внутри `init` (`:18–20`), `this.socketdata.userId` (`:191, 251`), отбор получателя `activeGM?.isSelf` (`:227`).

**pf2e 8.6.1 (`pf2e:` = `pf2e.mjs` строка)**
- `ItemPF2e#getOriginData` `pf2e:45537` (`{actor, uuid, type, rollOptions}`), `SpellPF2e#getOriginData` `:53487` (+`castRank, variant`), `ItemPF2e#toMessage` `:45409+` (флаги `origin: getOriginData()` `:45426`).
- Расход: `ConsumablePF2e#consume` `:51042` (origin = `{sourceId, uuid, type}` `:51064`; сообщение без await `:51079`; удаление `:51085`).
- Действия: `createSelfEffectMessage`-путь `pf2e:54105–54160` (`flags.pf2e.context={type:"self-effect"}` `:54140`; иначе `origin` `:54143`).
- Заклинание: `SpellPF2e#toMessage` `:53328+`, `context.type:"spell-cast"` только с `system.defense` `:53350`; константа «настоящий каст» `Dt = "origin:action:slug:cast-a-spell"` `:94`, `:53337`.
- Регионы: `placeRegionFromItem` `:3379` (origin с `name/slug/traits`, `ownership`); inline `@Template` -> `InlineRollLinks#r` `:28787` (origin только `getOriginData()`, `messageId = message.id`); `RegionDocumentPF2e` `:20865` (`message`, `isEffectArea`, `getCoverage`, `flags.pf2e.areaShape`); кнопка «убрать область» `spell-template-clear` `:29157`; `place-area-template` `:29238`.
- ChatMessagePF2e `:29339`: `item` `:~29380`, `target`, `_attack`, `speakerActor`. Контекст броска `attack-roll`: `origin/target {actor,token}` как UUID, `dc{label,scope,slug,value}`, `outcome`, `options` — `pf2e:19448–19500`; `CheckRoll#degreeOfSuccess` `:19316`; `Statistic.check.roll` `:15031` (параметры `dc, origin, item, token, target, extraRollOptions, traits, createMessage, messageMode, skipDialog, label/title, callback`; для `saving-throw` `origin` — актёр-источник, `pf2e:15040–15110`).
- Инлайн-проверка `@Check`: разбор параметров `#a` `:18895` (`type`, `dc`, `basic` (флаг), `against|defense`, `traits`, `options`, `showDC`, `adjustment`, `rollerRole`), DOM-атрибуты `data-pf2-check/dc/traits/roll-options`, `data-against`, `data-roller-role` (`:18970`), `basic` -> roll option `damaging-effect` (`:18903`); `getCheckDC` `:19061`; клик-обработчик, как pf2e бросает спасбросок цели: `getStatistic(type,{item})` + `roll({dc, origin, item, extraRollOptions, traits})` (`:28692–28770`).
- Состояния: `actor.getCondition/hasCondition/decreaseCondition/increaseCondition` `:33485–33520`, `ConditionManager.getCondition`/`updateConditionValue` `:33518`, `:48905`, `ConditionPF2e` `:49084` (`isLocked`, `appliedBy`).
- Применение эффекта системой (шаблон для `applyEffect`): `pf2e:55960–55995` (`system.context.origin/target`, `traits`).
- `pf2e.startTurn` `:26725`, `pf2e.endTurn` `:26745`; `DegreeOfSuccess` (не экспортируется) `:340–379`.
- `ItemSheetPF2e` `:50024` (AppV1, `defaultOptions` `:50030–50050`), шаблон `templates/items/sheet.hbs`.
- `game.pf2e.system.sluggify`, `game.pf2e.ConditionManager` (экспорт блока `game.pf2e`, `pf2e:116130+`).

**pf2e-toolbelt 3.59.1** (маркеры grep в `scripts/main.js`): `TargetHelperTool` (`key "targetHelper"`, `settingsSchema {enabled, skipDice, targets, checks, small, expend, template, …}`);
`game.toolbelt.getToolSetting(tool, key)`; `api.targetHelper.getMessageTargets(message)` / `setMessageFlagTargets(...)`; `createRegion` хук (`#l`: `r.id!==i` || `!e.isEffectArea` || `getFlag(e,"skip")` -> return);
флаги `flags["pf2e-toolbelt"].targetHelper = {type, targets[uuid], saveVariants{id:{basic,dc,saves{...},statistic}}, applied, …}`.

**pf2e-automations**: `game.settings.get("pf2e-automations","rulesV3")` (`src/index.js`: `u="pf2e-automations", H="rulesV3"`, `xe()`), формат группы — `rules/config.json` (`uuid, group, name, source[], isActive, baseRules/complexRules/handlerRules[{triggerType, predicate[]}]`).

**Дополнительно подтверждено при доработке (ревью)**
- Карта состояний `ConditionManager.conditions` строится по slug **и** uuid: `pf2e:48889–48891` (`[[t.slug,t],[t.uuid,t]]`) -> синхронный `conditions.get(uuid)?.slug`.
- Переброс: `pf2e:19664–19682` — старое сообщение удаляется (`e.delete({render:false})`), создаётся новое с `flags.pf2e` прежнего контекста (`isReroll`, `pf2e:19600–19602` хуки `pf2e.preReroll/reroll`).
- Сообщение броска сохраняет `origin: item?.getOriginData()` (`pf2e:19495`) и `context.options` (включая `extraRollOptions` броска, `pf2e:15130–15145`) — на этом держится приём результата по маркеру/origin (§3.C-6).
- Скрытый регион: `RegionDocument#_handleEvent` возвращается при `this.hidden` (`core/documents/region.mjs:2555`); при смене `hidden` ядро шлёт enter/exit поведениям напрямую (`:2395–2440`); добавление поведения скрытому региону событий не даёт (`:2569`).
- `pf2e-auto-action-tracker` 0.19.2: считает действия/реакции по chat-сообщениям (`createChatMessage` в `main.js`), реакцию списывает карточка использования (точный триггер — §7.U-20).
- `game.users.activeGM` и `executeAsUser` — `socketlib.js:87–110`.

### 7.U Не удалось подтвердить статически — проверить вживую (`J` = блокирует часть плана)

1. **J** Игрок создаёт регион (без поведений) при `REGION_CREATE` по умолчанию; затем ГМ добавляет поведение + свип: нет дубля состояний/гонок, `tokenEnter` ядра и наш свип не создают второй `concealed` (идемпотентность по `meta.key`).
2. **J** Что за сообщения реально создаёт кнопка «Использовать» дымовой шашки: карточка (`toMessage`) + `consume`-сообщение, или одно? Есть ли к моменту `preCreateChatMessage` у расходника живой предмет (`fromUuidSync(origin.uuid)`)? От этого зависит `useKindOf` (§3.A-2, 6).
3. Содержимое описания `smoke-ball-lesser` (паки pf2e — сжатый LevelDB, grep не работает): есть ли `@Template[burst|distance:10]` и ссылка на `concealed`; slug «Дымовой завесы» агентов (искать по `flags.babele.originalName`/`system.slug` живьём).
4. Сообщение заклинания `breathe-fire` у NPC (`embeddedSpell` / `casting.id`): работает ли `message.item.spellcasting.statistic.dc.value` и есть ли `system.defense.save`; сработает ли `Dt` в `origin.rollOptions` у NPC-каста.
5. **J** `statistic.check.roll({origin, item, dc, extraRollOptions, createMessage, messageMode, skipDialog})`: возвращает ли `CheckRoll` с `degreeOfSuccess`; корректность для несвязанного токена; попадает ли маркер `pf2e-automato:<msg>:<key>` в `context.options` итогового сообщения **и сохраняется ли он при переброске**.
6. Рендер блока в `renderChatMessageHTML` с синхронной подстановкой из кэшированного `getTemplate`: влияет ли на автопрокрутку чата; обновление блока после `message.update`.
7. **J** Toolbelt Target Helper: создаёт ли его бросок обычное `saving-throw`-сообщение с `origin` предмета и токеном цели (на этом держится приём результатов, §3.F); порядок срабатывания двух `preCreateChatMessage` (наш и Toolbelt); сохраняются ли `targets` Toolbelt после нашего `updateSource`. (Разбор `saveVariants` отменён.)
8. Реестр pf2e-automations: содержит ли `rulesV3` в рантайме все группы (в т.ч. из `rules/config.json`); корректно ли находятся покрытия `frightful-presence` (slug из `source[]` и предикатов) и `bravos-brew-*` (UUID `source[]` против `_stats.compendiumSource`).
9. Вкладка листа: срабатывает ли `renderItemSheetPF2e` для всех подтипов листов; `_tabs[0].activate("automato")` после ре-рендера; `item.setFlag` на предмете мира и актёра.
10. Дубли состояний: при двух зонах `concealed` на одном токене выход из одной не снимает вторую; `conditions.bySlug` показывает обе.
11. `updateCombat` с `options.direction` на клиенте ГМа; счётчик раундов и `worldTime` отрицательный (Simple Calendar) — истечение «что раньше».
12. Пересчёт реакции: нат.20/нат.1 + `dosAdjustments`, MAP; `context.dc.value` у атак по КБ; для заклинательных атак `context.type:"spell-attack-roll"`.
13. Игрок при паузе игры не может поставить регион (`placeRegion` -> null) — задокументировать, не обходить.
14. Несколько файлов `languages` на один `lang` в `module.json` — иначе склеить в один `lang/ru.json` на K7.
15. (снято — slug состояний берётся из `ConditionManager.conditions`, проверка сводится к п. 18.)
16. `userConnected` как триггер смены активного ГМа (у остальных клиентов хук приходит с `connected`; уже ли обновлён `isActiveGM`).
17. Правка сообщения заклинания (`spell-variant` перезаписывает флаги, `pf2e:29165–29190`): наш снимок сохранится (merge), но может устареть при смене варианта — допустимо?
18. **J** Разметка **русских** описаний (Babele) для блоков степеней (`<strong>Критический успех</strong>` и т.п.) и меток ссылок `@UUID[...]{Испуган 2}`: снять с живых предметов кампании (K8) и уточнить `rules/labels.json`; `ConditionManager.conditions.get(uuid)` для UUID `Compendium.pf2e.conditionitems.Item.*` в русских описаниях (UUID те же).
19. `Macro#execute(scope)` в v14: передача именованных переменных (`scope`) и доступность `speaker/actor/token/character` по умолчанию; поведение при `MACRO_SCRIPT` у ГМа; макрос типа chat.
20. Списывает ли `pf2e-auto-action-tracker` реакцию по карточке `item.toMessage()` черты (по какому признаку: `flags.pf2e.origin`, стоимость действия предмета, режим) и не списывает ли он её повторно при нашем втором сообщении.
21. `createItem`/`deleteItem` на синтетическом актёре несвязанного токена приходят на все клиенты ровно один раз (хуки vision, §2 zone); `item.actor.getActiveTokens` для скрытых/вне сцены.
22. Приём `saving-throw` по origin-предмету (без маркера): корректен ли для инлайн-`@Check` в карточке (origin = предмет карточки, `pf2e:28692–28770`) и для NPC-токена без привязки (сравнение по `token.id`, не по актёру).

## 8. Разбиение на куски (файлы не пересекаются)

Порядок: **K0 -> (K1..K6, K8 параллельно) -> K7**. Исполнитель каждого куска владеет **только** перечисленными файлами. Язык строк — `lang/{ru,en}/<кусок>.json` (если §7.U-14 не подтвердится, на K7 склеить в `lang/ru.json`/`en.json`).
**K0 создаёт ВСЕ файлы модуля**: рабочие `util/settings/compat/rules/apply/main`, а `zone/use/saves/macros/chat/reactions/sheet` — заглушки с **полными сигнатурами из §2** (тела `throw new Error("not implemented: <имя>")`, кроме `init/ready` — no-op) и объект `HANDLERS` в `main.mjs` со **всеми именами сокет-обработчиков §5**.
Так K1..K6 вызывают друг друга по контракту без ожидания, а `socket` берут из `util.mjs` (`callGM`), не из `main`.

| Кусок | Файлы (владелец) | Зависит от | Критерий готовности |
|---|---|---|---|
| **K0 Контракт** | `module.json`, `scripts/main.mjs`, `scripts/util.mjs`, `scripts/settings.mjs`, `scripts/compat.mjs` (с готовым `automationsCovers/automationsGroups/shouldYield`), `scripts/rules.mjs`, `scripts/apply.mjs`, заглушки `zone/use/saves/macros/chat/reactions/sheet.mjs`, `rules/catalog.json` (примеры §1.6), `rules/labels.json`, `tests/rules.test.mjs`, `README.md` (пункт про прототипы), `templates/` и `styles/` — пустые файлы-заготовки | — | `node --test tests/` зелёный (validate, slugOf/sourceOf, deriveFromMarkup на фикстурах: блок степеней с `Испуган 2`, consumable с эффектом, action с эффектом = low); модуль грузится в Foundry без ошибок; `api.automationsCovers({slug:"frightful-presence"})` и `({sourceUuid:<брага>})` = true в этом мире; `applyCondition`: frightened 1 -> 2 (`raised`), 2 при значении 1 (`skipped`); `applyEffect`+`hasEffect` дедупит; `undoOps` откатывает; `callGM` отклоняется не-активным ГМом (проверка вторым ГМ-клиентом — ручная) |
| **K1 Зоны** | `scripts/zone.mjs`, `styles/zone.css`, `lang/*/zone.json` | K0 | **Через `api.*` без K2**: `api.attachZone(region, rule, origin)` на тестовом регионе, созданном скриптом: токен внутри при создании получил `concealed` (свой `meta.key`), вышел -> снят, вошёл -> есть; `hidden`-регион -> снято/возвращено; `api.expireZones()` при `expiresAt<worldTime`, `closeZone`, ручное удаление региона снимают; двойной `expireZones` не даёт ошибку «does not exist»; перезагрузка страницы; `reconcileZones` без дублей; 2 зоны подряд; `createItem/deleteItem` вызывают `pf2e-automato.zoneEnter/Exit` один раз на клиент; в конфиге поведения нет редактируемых `events` |
| **K2 Конвейер** | `scripts/use.mjs`, `lang/*/use.json` | K0 | Юнит (node, фикстуры): `useKindOf`, сборка снимка, расходник с областью (`awaitingRegion`), «последний регион задаёт цели»; живьём (сообщения создаются скриптом): снимок пишется автором, `state.yielded` при покрытии, `resumePending` не берёт сообщения старше окна и уважает `button`/`off`; полные цепочки с зонами/испытаниями — K7 |
| **K3 Испытания + макросы** | `scripts/saves.mjs`, `scripts/macros.mjs`, `lang/*/saves.json` | K0 | **Через `api.*` на сообщении-фикстуре с готовым `flags.pf2e-automato.use`**: `api.runChallenge(message)` — NPC бросает у ГМа с `skipDialog` и маркером; `api.recordResult` повторно игнорируется / перезаписывается переброс до применения / `changedAfterApply` после; приём `saving-throw` созданного скриптом сообщения (по маркеру и по origin); `degreeFromTotal` юнит (нат.20/1, ±10); `resolveDC` (value/spell/expr/markup/against); `api.applyByDegree` идемпотентен (frightened по степеням); `api.runMacros` на 6 фазах: ошибка макроса не прерывает, повтор не вызывает макрос второй раз, без `MACRO_SCRIPT` — предупреждение |
| **K4 Чат** | `scripts/chat.mjs`, `templates/chat-block.hbs`, `styles/chat.css`, `lang/*/chat.json` | K0 | `buildViewModel` — юнит на фикстурах §1.4 (роли ГМ/владелец/прочие, режимы, `yielded`, low-кнопки, предупреждение `yield:false`, «Ожидает ГМа»/«Дозапустить», `changedAfterApply`); живьём: блок рендерится из флагов, кнопки вызывают `callGM` с правильными именами (заглушки K0 отвечают) |
| **K5 Реакции** | `scripts/reactions.mjs`, `lang/*/reactions.json` | K0 | `recalcWithBonus` юнит (до/после, нат.20); **через `api.*` на созданном скриптом `attack-roll`-сообщении**: `api.onAttackMessage` создаёт шёпот только при смене исхода; повторное сообщение-переброс обновляет, а не дублирует; `api.useReaction` пересчитывает **эту** атаку, при активном auto-action-tracker отправляет `item.toMessage()`, флаг `reactionSpent` ставится только в бою и не залипает вне боя; `pf2e.startTurn` сбрасывает |
| **K6 Вкладка + харнесс** | `scripts/sheet.mjs`, `templates/sheet-tab.hbs`, `styles/sheet.css`, `tests/af-harness.js`, `lang/*/sheet.json`, `lang/*/settings.json` | K0 | Вкладка у ГМа в листах action/feat/spell/consumable/equipment: показывает распознанное (+`confidence`), предупреждение `yield:false` при покрытии, сохраняет `rule` флагом и в мировой каталог (`source`/`slug`), переживает ре-рендер, макросы редактируются; харнесс (§9) исполняется (сценарии, чьи кнопки ещё заглушки, помечены `skipped`) |
| **K7 Интеграция** | **точечные правки в любых файлах** (каждая — отдельным пунктом отчёта: файл, строки, причина; без рефакторингов и переименований публичных сигнатур), `module.json`, `lang/*.json`, `README.md` | K1–K6, K8 | Полный харнесс (§9) зелёный: 4 сценария + yield + макросы + идемпотентность + переставленный регион + расходник с областью; ручной чек-лист §9-16 (игрок на втором клиенте, второй ГМ, отсутствие ГМа, Toolbelt, переброс); i18n ru+en без пропусков (скрипт сверки ключей) |
| **K8 Инвентаризация сущностей кампании** | `rules/catalog.campaign.json` (подключается загрузчиком `rules.loadCatalog` вместе с `catalog.json`), `rules/labels.json` (допустимо дополнять после K0), `inventory-report.md` (вне модуля, в `D:/ClaudeFun/pf2e-automato/`) | K0 (рабочий `deriveFromMarkup`), список от Руководителя | См. §11: для каждой из ~29 сущностей — «выводится (high/low) / нужен каталог / не автоматизируется (почему)»; все «нужен каталог» имеют запись в `catalog.campaign.json`, проходящую `validateRule`; найдена и зафиксирована разметка русских блоков степеней (§7.U-18) |

Правила сборки: без npm, без сборщиков; `node --test` для чистых функций (`rules`, `util.degreeFromTotal`, `chat.buildViewModel`, `reactions.recalcWithBonus`, `use.useKindOf`) — остальное только живьём.

## 9. Тестовый харнесс: исправить `…/scratchpad/af-harness.js` (-> положить как `module/tests/af-harness.js`)

Файл исполняется как async-функция в консоли клиента ГМа. Что менять, по шагам:

1. **Идентификатор модуля.** Строка 4: `m.id.startsWith("pf2e-autoflow-proto")` -> `m.id === "pf2e-automato"`; вывести версию, `game.modules.get("pf2e-automato").api`, предупреждение «активны прототипы» если есть `pf2e-autoflow-proto-*` (прогон при активных прототипах недействителен).
2. **Состояния читать у `token.actor`.** `conds(a)` (стр. 10) вызывается с мировыми актёрами `w1, w2, pyro` (стр. 39–43, 78) — у несвязанных NPC-токенов состояния живут на синтетическом актёре. Заменить на `conds(tokOf(tW1).actor)` и т.п.;
   метка «наше» = `flags["pf2e-automato"]?.meta` (вывести `meta.key`). Для Лиарэль (linked character) `liarel` допустим.
3. **Создание регионов обоими реальными путями** (стр. 37, 50): интерактивный `placeRegion` не автоматизировать, но данные повторить точно и создавать через `scene.createEmbeddedDocuments("Region")` (срабатывают `preCreateRegion/createRegion`):
   - путь A (inline `@Template`, `pf2e:28795`): `{name, shapes, color, highlightMode:"coverage", displayMeasurements:true, visibility:ALWAYS, flags:{pf2e:{areaShape, messageId: <карточка>, origin: item.getOriginData()}}}`;
   - путь B (`placeRegionFromItem`, `pf2e:3379`): то же + `ownership:{[game.user.id]:OWNER}` и `origin:{name, slug: item.slug, traits, ...item.getOriginData()}`.
   Прогнать сценарий 1 по обоим (два региона последовательно), сценарий 2 — по B (конус, `areaShape:"cone"`).
4. **Убрать слепые `wait()`**: `waitFor(fn, {timeout, label})` (опрос 100 мс) — для флага `use` на сообщении, появления/исчезновения состояния. Короткие паузы остаются только под перемещение токена (ждать изменения `token.regions`).
5. **Нажимать только кнопки модуля** (стр. 70–76): селектор `.pf2e-automato button[data-action]`; **не** нажимать кнопки карточек pf2e (consume на карточке шашки даёт `Item … does not exist`, `test-results.md`). Список нажатых — по `data-action`.
6. **Игроков не трогать.** Все актёры — временные; `liarel` создаётся с `ownership:{default:0}`; перед стартом отпечаток `game.actors.filter(a=>a.hasPlayerOwner).map(a=>[a.id,a._stats.modifiedTime])`, после уборки сравнить -> `playersUntouched`.
7. **Сценарий 3 (брага) + yield**: `brew.consume()` -> проверка: ровно один `effect-bravos-brew`, **без** нашего `meta`, снимок с `state.yielded:"pf2e-automations"` (уступили). **Дедуп при `yield:false` харнесс НЕ обещает и не проверяет** (гонка с pf2e-automations не устраняется): для `yield:false` проверяется только, что в блоке/во вкладке есть **предупреждение** о двойном применении (`compat.automationsGroups` непусто). Настройку вернуть в `finally`.
8. **Сценарий «Frightful Presence»**: предмет со slug `frightful-presence` (или временная копия) -> снимок есть, `state.yielded` выставлен, исполнения нет. Отдельный прогон с `rule.yield=false` **на временной копии, чей slug не покрыт pf2e-automations** (иначе двойное применение): frightened по степеням, повторное «Применить» ничего не меняет.
9. **Сценарий 2**: после создания конуса ждать `use.state.area.keys` (оба бойца), `state.challenge.results` для NPC-целей без нажатий; для PC-цели — результат только после `roll-save` **и появления saving-throw-сообщения** (приём по маркеру); проверка множителя в блоке.
10. **Сценарий 4**: атака `strike.variants[0].roll({event: new MouseEvent("click",{shiftKey:true})})` оставить; цели `canvas.tokens.setTargets([tL.id])`; проверка: шёпот с флагом `reaction`, после кнопки `reaction.used=true`; вне боя `reactionSpent` **не** ставится; на Лиарэль **нет** висящего эффекта.
11. **Истечение зоны без правки мирового времени**: не вызывать `game.time.advance` (меняет время реального мира), а выставить `behavior.update({"system.expiresAt": game.time.worldTime - 1})` и вызвать `api.expireZones()` (дважды подряд — второй раз без ошибок); состояния сняты, регион удалён.
12. **Идемпотентность**: повторно `api.runUse(msgId)`, дважды «Применить», дважды `sweepZone` -> число документов не растёт.
13. **Ошибки**: помимо `window.onerror/unhandledrejection` перехватывать `console.error` (ошибки обработчиков регионов доходят только туда, `core/documents/region.mjs:2557`), фильтровать `pf2e-automato`; `TokenMagic is not defined` (Automated Animations) — игнорировать.
14. **Уборка.** Стр. 90: `game.scenes.getName("Test Scne")` — захардкоженное имя с опечаткой; заменить на `const prev = game.scenes.viewed` до создания тестовой сцены и `await prev?.view()` в `finally`.
    Закрытие диалога Toolbelt (стр. 86) оставить, селектор проверить; удалять созданные сообщения, актёров, макросы, сцену; вернуть настройки.
15. **Отчёт**: таблица `{scenario, check, expected, actual, pass}` и итог `passed/failed/skipped`; `report.steps` — диагностика.
16. **Не покрывается харнессом** (ручной чек-лист в README K7): клиент **игрока** (создаёт регион, PC-бросок), **переброс** (hero point) до/после применения, **два ГМа** (мутация только у активного), отсутствие ГМа и давность дозапуска, перезагрузка страницы посреди зоны, пауза игры, Toolbelt Target Helper включён, `pf2e-auto-action-tracker` и карточка реакции.
17. **Новые сценарии**: (a) **переставленный шаблон** — два региона с одним `messageId`: цели второго заменяют первые, неприменённые результаты вне набора отброшены, первая зона закрыта; (b) **расходник с областью** — consume-снимок + регион из карточки исполняет зону/испытание ровно один раз;
    (c) **макросы** — временные мировые макросы (создать и удалить), пишущие в `globalThis.__afMacroLog`: фазы `onUse/afterChallenge/onDegree`, макрос с `throw` не ломает конвейер; (d) **low-кнопка** — предмет-копия action с эффектом: исполнения нет, после «Применить (распознано)» эффект ровно один;
    (e) **вне давности** — снимок с `createdAt` старше окна не дозапускается автоматически, кнопка «Дозапустить» работает.

## 10. Изменения после ревью (какой дефект чем закрыт)

| # | Дефект ревью | Чем закрыт (раздел) |
|---|---|---|
| 1 | Вывод из разметки не разбирал блоки степеней, значения, slug синхронно | §1.3: блоки `<strong>МЕТКА</strong>` (en/ru, `rules/labels.json`), значение из подписи ссылки, slug через `ConditionManager.conditions.get(uuid)`; эффект заклинания на цели `to:"target"`; action/feat без `selfEffect` = `low`; low -> кнопка ГМу в чате (§3.G); русская разметка снимается в K8 (§7.U-18) |
| 2 | Два ГМа, очередь не сериализатор | §2 util (`callGM` = `executeAsUser(activeGM)`, `guardActiveGM`, настоящий `queue`), §5: `executeAsGM` не используется, обработчики отклоняют не-активного ГМа |
| 3 | Двойное применение с pf2e-automations; `source[]` — UUID | §1.6(3), §2 compat (индекс по slug **и** UUID против `_stats.compendiumSource`, `automationsGroups`), §3.D и §6 (предупреждение при `yield:false`), §9-7 (дедуп не обещаем) |
| 4 | Давность дозапуска, режим `button` для зон | §3.H, §3.B-8, настройка `resumeMinutes`, кнопка «Дозапустить», `reconcileZones` уважает `modeOf` |
| 5 | Переставленный шаблон | §3.C-3, §3.B-4: последний регион задаёт цели, неприменённые результаты вне набора отбрасываются, прежняя зона закрывается; удаление региона Toolbelt цели не сбрасывает |
| 6 | Toolbelt: разбор `saveVariants` | §3.C-6, §3.F: приём любого `saving-throw` (маркер в roll options либо origin-предмет + токен цели); цели Toolbelt — цели испытания; `saveVariants` не разбираем; `reportSave` удалён |
| 7 | Расходник с областью | §3.A-6, §3.B: консьюм-снимок не ждёт, регион из карточки = акт использования; `awaitingRegion` |
| 8 | Параллельность кусков | §8: settings/compat в K0, заглушки всех сигнатур и `HANDLERS` в K0, `socket` в `util.mjs`, критерии K1/K3/K5 через `api.*`, K7 с правом точечных правок |
| 9 | Схема: отложенное в v2, каталог по источнику | §1.1 «Отложено в v2», зарезервированы `onTurn`/`Zone.events`, «N раундов» через обёртку-эффект; §1.2: `bySource` приоритетнее `bySlug` |
| 10 | Синхронный резолв slug состояния и шаг 4 каскада | §1.3, §1.5: `ConditionManager.conditions.get(uuid)`; шаг `fromUuidSync(sourceId).system.slug` удалён, вместо него `bySource` |
| 11 | Перебросы | §3.C-6, §1.4 (`changedAfterApply`), roll-options-маркер; принимаются до применения, после — «результат изменён» |
| 12 | Реакции (залипание флага, auto-action-tracker, дубли на переброс) | §3.D': флаг только в бою и только текущий раунд, `item.toMessage()` при активном трекере, обновление подсказки при `isReroll`; §7.U-20 |
| 13 | Противоречия контракта | `dc:{expr:"markup"}` описан (§1.1); `state.zone.status` содержит `pending`, сроки только в поведении (§1.4); `state.yielded` пишет автор, снимок при уступке (§3.A-4); одна формула `hasEffect` (§1.4); сроки/счётчик раундов — один источник (§2 zone) |
| 14 | Зона: `events`, `hidden`, двойной delete | §2 zone: `static events`, `sweepZone` учитывает `hidden` (+ `updateRegion`), `deleteRegionOnce` |
| 15 | Хуки vision | §2 zone: из `createItem`/`deleteItem` состояния с `meta.key` `zone:`; из `main` убраны |
| 16 | Прототипы | §2 main (`warnPrototypes` на `ready`), README, §9-1 |
| — | Решение пользователя: автовывод | §1.3 (high по режиму, low кнопкой в чате), §3.G, §6 |
| — | Решение пользователя: макросы в v1 | §1.1 (`macros`, фазы, `scope`, права `MACRO_SCRIPT`, ошибки не ломают конвейер, идемпотентность), §2 `macros.mjs`, §4 `mode.macro`, пример §1.6(5), K3 |
| — | Раздел 10 ревью, п.2–7, 9–10, 12, 13 | §3.B-4 (поведение у ГМа), `own copy` (§2 apply), §3.A (consume/каст/любая карточка действия), `challenge.messageMode=gm`, `excludeSelf` (emanation исключает автора), `reaction.onlyWhenChanges`, §3.H, перебросы принимаются, K8 (29 сущностей), vision-хуки из документов |

## 11. K8 — инвентаризация сущностей кампании (что нужно получить и в каком формате)

**Список строит Руководитель по живому миру** (через `game.actors`/временный скрипт в консоли ГМа; **LevelDB-паки не копируем и не читаем напрямую**). Исходные ~29 сущностей (по оценке покрытия): Боевая медицина, Щит, Вымысел, Запрещающая защита, Возможность для атаки, Гоблинское увиливание, Масло, Свет, Оплетающая лоза, Свирепость, Старая выучка, Ловкое уклонение, Двойной финт, Грязный приём, Финт, Танец клинков, Скользящая защита, Гипнотический приказ, Дымовая завеса, Отвести глаза, Вкрадчивое слово, Блок щитом, Устрашающий удар, Блестящее сияние, Сбрасывание … (остальные — по живым актёрам: 4 PC — Варрис, Лиарэль, Муссария, Шен-Ли; NPC — Львиные Клинки, гоблины, звери).

**Формат входных данных** (один JSON-файл, массив; выгружает Руководитель скриптом по токенам/актёрам, без изменения мира):
```json
{ "name": "Ловкое уклонение", "originalName": "Nimble Dodge", "slug": "nimble-dodge", "type": "feat|action|spell|consumable|equipment|weapon|...",
  "itemUuid": "Actor.xxx.Item.yyy", "sourceUuid": "Compendium.pf2e.feats-srd.Item.zzz | null",
  "carrier": { "kind": "pc|npc", "actorName": "Лиарэль", "linked": true },
  "actionType": "action|reaction|passive|free", "actionCost": 1, "traits": ["..."],
  "hasSelfEffect": false, "hasArea": false, "defenseSave": { "statistic": "reflex", "basic": true } | null,
  "description": "<сырой system.description.value (рус.)>", "descriptionEn": "<оригинал из pf2e-пака, если доступен через game.packs.getDocument(sourceUuid), иначе null>",
  "rules": [ /* system.rules кратко: key + slug, для понимания, что уже делает система */ ] }
```
**Выход K8**: `inventory-report.md` — таблица `сущность -> {выводится: high/low/нет, что именно (byDegree/эффект/зона/реакция), нужен каталог (причина), не автоматизируется (почему, напр. passive/aura у pf2e)}`;
записи для всех «нужен каталог» в `rules/catalog.campaign.json` (ключи `bySource`, запасной `bySlug`), валидные по `validateRule`; фактические фрагменты русской разметки блоков степеней (для `rules/labels.json`, §7.U-18); список сущностей, где нужен макрос (если будет).
Критерий: каждая строка списка имеет решение; `node --test` K0 прогоняет `catalog.campaign.json` через `validateRule` без ошибок; на 3–4 выбранных сущностях живьём проверен путь «разметка -> блок чата».

## 12. Спорные места (только новое после ревью; видимое пользователю)

1. **Повторная установка шаблона заменяет предыдущую.** Второй регион того же использования закрывает прежнюю зону и подменяет набор целей (неприменённые результаты вне нового набора отбрасываются). Если предмет по задумке создаёт несколько областей — потребуется поле правила (в v1 нет).
2. **`yield:false` ведёт к двойному применению** при активной группе pf2e-automations: модуль только предупреждает во вкладке и в блоке, не блокирует. Альтернатива — запретить `yield:false` для покрытых предметов; выбрано «предупредить».
3. **Макросы выполняются от имени активного ГМа с его правами**: любой мировой макрос, указанный в правиле, будет запущен (в т.ч. script). Правила правит только ГМ, но стоит знать; при отсутствии `MACRO_SCRIPT` фаза пропускается с предупреждением. Режим `mode.macro=off` отключает всё.
4. **Низкая уверенность (`low`) всегда кнопкой, даже при `auto`.** Это решение пользователя; нюанс: у action/feat без `selfEffect` это почти всегда будет кнопка в чате — ГМ жмёт её сам.
5. **Давность дозапуска 30 минут** (настройка): всё, что игроки сделали без ГМа дольше, не применяется само — только по кнопке «Дозапустить».
6. **Перебросы принимаются до применения**; после применения состояние само не меняется, ГМ видит пометку «результат изменён» и сам решает («Отменить»/«Применить»).
7. **Реакция при включённом `pf2e-auto-action-tracker`**: по «Использовать» в чат уйдёт карточка черты (чтобы трекер списал реакцию) — лишнее сообщение в чате; без трекера карточки нет. Механизм списания проверяется живьём (§7.U-20).
8. **Эманации не затрагивают автора по умолчанию**, burst/cone/line — затрагивают (переопределяется `excludeSelf` в правиле).
9. **Русская разметка блоков степеней** разбирается по таблице меток (`rules/labels.json`); предметы с нестандартной вёрсткой остаются в «нужен каталог» (K8), а не угадываются.
