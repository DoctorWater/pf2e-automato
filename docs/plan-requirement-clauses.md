# План: новые клаузы требований (группа G аудита)

Правила — `CLAUDE.md` §1.1, §1.3–1.5, §3.4, §4.4. Основа: `scratchpad/manual/list.csv`, группа 2, 1667 док. (оценка G). Статус: ТОЛЬКО ПЛАН, код не тронут.
Числа ниже — с прототипа разбора (`scratchpad/plan/proto2.mjs`, `stages.mjs`, `split.mjs`, `resid.mjs`) на этих 1667 документах, а не оценка. «Полный разбор» = разобраны все клаузы текста; «частичный» = в каждой ветке «or» разобран хотя бы один атом «and» (см. решение 2). «PC» = документы без актёра (общие действия, черты, заклинания); «NPC» = бестиарий.

## 0. Главный вывод

- Прототип разбирает целиком **545 из 1667 (33%)**, но **рантаймом проверяемо лишь ~290 (17%)**: у NPC нет данных о снаряжении (`system.hands` нет, оружия-предметов нет, Удары — `melee`), а часть клауз (труп, видимость, вода) брать нельзя (§3).
- Хвост длинный: из 409 нераспознанных «wield/hold/wear» док. почти все — названные предметы («your warmask», «a khakkhara», «Aldori dueling sword»), «loaded», «в руке X и …». Универсальная грамматика недостижима, поэтому берём только общие формы.
- Каждая клауза ниже даёт ≥30 док. (порог примитива) либо вырождена в 5–10 строк.

## 1. Что pf2e уже делает сам (§1.3, grep `pf2e.mjs`)

- Требования «Requirements» pf2e не проверяет вообще (поле `requirements` — только текст; `.requirements` в 45340 — Token Mark). Дублировать нечего, отключать нечего.
- pf2e даёт **данные**, на которые опираемся: `actor.hasCondition(slug)` и опции `self:condition:<slug>[:<n>]` (46117), `self:effect:<slug>` (46117; для Ярости pf2e сам использует `self:effect:rage`, 13289), `self:armored` и `self:shield:raised` (34641), `hands-free:<n>` (35598), `actor.wornArmor`/`heldShield`, `item.isHeld`/`handsHeld`/`isEquipped`, `actor.isAllyOf/isEnemyOf/alliance` (32817–32838), `token.canFlank` (27709), `Encumbered` как предмет-состояние при включённой настройке (14230).
- Чего нет: приём «в стойке X» (проверяем как `damaged.mjs`: `self:effect:stance-<slug>` и др.), счётчик «инициатива брошена» (берём `combatant.initiative`), «рядом с существом».

## 2. Форма и общий каркас

Оверлей: клауза — по-прежнему элемент `any`; новое — клауза-группа `{k:"all", of:[атом…]}` (AND внутри ветки «or»). Атомы:

| k | поля | пример текста |
|---|---|---|
| `cond` | `slug`, `not`, `n?` | «You aren't Fatigued», «You are Frightened» |
| `stance` | `slug` | «You are in Dragon Stance» |
| `rage` | `not` | «not Fatigued or raging» → `all[cond not fatigued, rage not]`, «isn't … or raging» — отрицание списка = все «not» |
| `gear` | `what: weapon\|armor\|shield\|tool`, `q:{melee,ranged,hands,group,cat,raised}` | «wielding a two-handed melee weapon», «wearing medium or heavy armor», «unarmored», «shield raised» |
| `combat` | `rolled: true\|false` / `first` | «Initiative has not yet been rolled», «has rolled initiative» |
| `num` | `of: hp\|thp\|focus`, `op`, `n` или `frac` | «has 20 HP or fewer», «below half HP», «temporary Hit Points», «has at least 1 Focus Point» |
| `near` | `of: enemy\|creature\|living`, `cond?:[слаги]`, `d: adjacent\|reach\|<фт>` | «adjacent to at least one enemy», «a Grabbed, Paralyzed … creature is within reach» |
| `hand`, `holds` | существующие | расширяем лишь подлежащее/формулировку (45–60 док., по сути Е) |

Трёхзначная логика (как `clauseState`): `true/false/null`. `all`: любой false → false; все true → true; иначе null. Блок — только если все ветки `any` false (как `reqFails`).
Совместимость: `reqSig`, `bySource/bySlug`, `mech.req` (выключатель всего требования), `workshop/mechanisms.mjs` (сводка зовёт `needText` по клаузе) не меняются; `needText` для `all` склеивает атомы «и».

## 3. Клаузы: по этапам

### Этап 1 — состояние: `cond`, `stance`, `rage` (125 док. полных: PC 68, NPC 57)
- **Грамматика** (en): `SUBJ (is|are|'re|isn't|aren't) [not] [already] COND[ N]` с перечислением «, or / and»; `SUBJ (has|have|hasn't|doesn't have) [the] COND [condition]`; `SUBJ is in [a|the|Mastered|Greater] X Stance`; «isn't Fatigued or raging/already in a rage». COND — только те, что pf2e хранит **как предметы-состояния**: fatigued, frightened, encumbered, wounded, dying, prone, grabbed, restrained, quickened, sickened, slowed, stunned, stupefied, enfeebled, clumsy, drained, doomed, paralyzed, unconscious, fleeing, immobilized, confused, fascinated, petrified, blinded, dazzled, deafened. Примеры (`list.csv`): «You aren't Fatigued or raging» (3+2+3 док.), «You are not encumbered» (2+1), «You are in Gorilla Stance», «You're in either claw stance or talon stance».
- **Данные:** `actor.hasCondition(slug)` / значение состояния; Ярость — `self:effect:rage`; стойка — `requireOptions("stance:"+slug)` из `damaged.mjs` (повторное использование, не новый код). Неизвестная стойка (slug нет в списке стоек `items.json`, как `knownRequire`) — записи нет.
- **Неизвестность:** актёр NPC + `stance`/`effect` — `null` (ГМ стойку не ведёт эффектом; ложный блок). NPC + `cond` — проверяем (ГМ вешает состояния на токен). Отсутствие эффекта у PC — `false` только если `knownRequire` истинно.
- **Предупреждение** (`builtin.limit.needCond`, `needCondNot`, `needStance`, `needRage…`): «вы {не }в состоянии «{cond}»» — имя из `CONFIG.PF2E.conditionTypes` (перевод pf2ru уже в системе); стойка — `item.name` с листа по slug, иначе без имени: «нужна стойка (см. описание)». Название стойки из lang не придумываем (§2.1).
- **Ложные блоки:** (а) видимостные состояния (Hidden, Undetected, Invisible, Concealed, Off-Guard, Observed) — в pf2e это отношение к наблюдателю, предмета-состояния у большинства нет (Off-Guard от фланкинга — не предмет): **не берём** (17 док. «vis» + ~32 в других формулировках, всего 49 док.); (б) «in a frenzy» (26 док., у NPC эффекта нет) — не разбираем; (в) Quickened/Slowed из `effect` — это состояние, но эффект-обёртка работает так же — ок; (г) Encumbered при выключенной настройке pf2e состояния нет — `false` на «not encumbered» ложно не блокирует (условие «не» истинно), а «are encumbered» не встречается.
- **Подгруппа не брать:** `effect` — «under the effects of X / benefiting from X» (17 док.: PC 12, NPC 5): slug эффекта из названия ненадёжен («Effect: Twin Parry», «spell-effect-…»); порог примитива не достигнут. Долг до списка slug эффектов из паков.

### Этап 2 — снаряжение PC: `gear` (PC 75 + 5 «hand» док. полных; NPC — null)
- **Грамматика:** `are|is [either] (wielding|holding) [a|an|your] [one-handed|two-handed|melee|ranged|piercing/slashing/bludgeoning|simple|martial] (weapon|firearm|crossbow|bow)`; «wielding two (one-handed) (melee) weapons[, each in a different hand]»; `(are|is) (wielding|holding) a (shield|buckler)`, «have your shield raised»; «unarmored», «wearing (light|medium|heavy)[ or …] armor [that doesn't have the broken condition]»; «holding [or wearing] (healer's tools|an alchemist's toolkit)». Примеры: «You are wielding a shield» (11), «You're wielding a two-handed firearm or two-handed crossbow», «You are unarmored», «You are holding healer's tools, or you are wearing them and have a hand free».
- **Данные:** `actor.itemTypes.weapon.filter(isHeld)`; `handsHeld`; `item.isMelee`, `group` (`firearm`, `crossbow`, `bow`), `damage.damageType`, `category`; `wornArmor.category`/`self:armored`; `heldShield`/`isEquipped` и `self:shield:raised`; инструменты — предмет по slug (`healers-tools`, `alchemists-toolkit`) held/worn. Пара оружия (две руки) — через `dual-wield.mjs` `isPair`/`isDual`, иначе Двойной взмах даст ложный блок.
- **Неизвестность:** актёр NPC (нет предметов-оружия: Удары — `melee`) — `null`, как `hand`; PC без единого оружия в списке предметов (мир без экипировки) — `null`, не `false`; чужой предмет без `carryType` — не считаем.
- **Предупреждение:** `needGear*`: «в руках нужно оружие: {kind}» (подписи типа — `CONFIG.PF2E.weaponGroups`, `weaponCategories`, `armorCategories`, `PF2E.WeaponTypeMelee`…), «нужен щит в руке», «нужна броня: {cat}», «нужно быть без доспеха».
- **Не брать:**
  - «loaded/unloaded/reload» — 61 док. (39 PC): состояние заряженности хранится по-разному (`system.expend`, патроны, репит); нужен отдельный живой разбор данных → этап 6 (опционально).
  - Названные предметы («your staff», «your warmask», «Aldori dueling sword», «a khakkhara») — основная масса из 409 нераспознанных; точность по слову/slug слабая, ложный блок вероятен.
  - NPC: ~125 док. полного разбора («wields two melee weapons», «manacles in hand») — данных нет, `null`; работают только в составе `all` (частичный разбор).
- **Ложные блоки:** игрок не выставил «в руке» на листе — но pf2e тогда не покажет и Удар; Двойной взмах (`dual` флаг модуля, `handsHeld 2` у пары); щит «в руке» vs буклер (носится на предплечье: `isEquipped`, не `handsHeld`); «free-hand»/attached оружие.

### Этап 3 — бой и числа: `combat`, `num` (NPC 48, PC 5 док.)
- **Грамматика:** «Initiative has not yet been rolled» (≈19 док., из них harrowkin 17), «X has rolled initiative» (19), «It's the first round of combat», «You're not in combat»; `has [at least|fewer than] N (Hit Points|HP) [or fewer]`, «below N Hit Points», «fewer than half … Hit Points», «Hit Points are at half your maximum or less», «has temporary Hit Points [from X]» (10), «has at least 1 (available) Focus Point» (3).
- **Данные:** `game.combats` бой актёра (`combatOf`, уже в `ctxOf`), `combatant.initiative != null`; `system.attributes.hp.{value,max,temp}`; `system.resources.focus.value`.
- **Неизвестность:** нет боя — `combat` дают `null` (ни «брошена», ни «не брошена»: ГМ мог проверять способность вне боя); актёр без hp — `null`; «temp from X» (источник) — берём только факт `temp > 0` (по имени эффекта не проверяем: разбор не принимаем, если указан источник и он не единственный путь — иначе запись не выпускаем).
- **Предупреждение:** `needCombat{Rolled,NotRolled,First}`; `needHp`: «ПЗ {cur}, нужно {op} {n}».
- **Ложные блоки:** «taken damage / took damage» (13 док., счётчик ПЗ за ход — данных нет) не разбирать; Stealth-инициатива («rolled Stealth for initiative») не разбирать (инициатива не хранит навык).
- **Порог:** `combat` — 21 док. при 3 уник. текстах (<30), `num` — ≈30; это ниже порога по уник. текстам, но строка «num» — 10 строк, а «combat» — 8. Решение в открытых вопросах.

### Этап 4 — окружение: `near`, расширение `holds` (NPC 77, PC 5; из них новое `near` 48)
- **Грамматика:** `are adjacent to (at least one|a|two or more) (enemy|foe|creature|living creature)`, «within reach of …», «A (Grabbed|Paralyzed|Restrained|Unconscious|… ) creature is within (its|X's) reach» (8 + 6 + 5 док.); `holds`: «has Grabbed a creature», «has a (Medium or smaller) creature Grabbed or Restrained», «A creature is Grabbed by …jaws» — по существующей клаузе (30 NPC + 4 PC док.). Уточнения («in its jaws», размер) по прежнему принципу — вне разбора.
- **Данные:** токен автора (`sceneOf(actor)` + единственный токен — как `melee-reach.mjs`), токены сцены, `token.distanceTo` (с `reach` — исключение диагонали pf2e), `actor.getReach()`, `actor.isEnemyOf(other)`; состояние чужого — `other.actor.hasCondition`.
- **Неизвестность:** сцена не определена, токенов автора >1 или нет, сетка не квадратная — `null`; `alliance === null` у автора на «enemy» — `null`. Токены `document.hidden` считаем присутствующими (ошибка в сторону пропуска).
- **Предупреждение:** `needNear`: «рядом (вплотную) должен быть {враг|существо}» / «в пределах досягаемости {cond} существо».
- **НЕ брать (с числами):**
  - Труп/«умер в последний час» — 71 док. (43 ун. NPC): токен трупа ГМ часто удаляет, срок «за час» не проверить; ложный блок почти гарантирован.
  - Вода/местность («in or adjacent to water», «standing on stone») — 51 док.: данных нет в сцене.
  - Видимость (Hidden/Invisible/…) — 49 док.; фланкинг — 7 док. (канфлэнкует лишь относительно цели: контекста цели в момент использования нет; `token.canFlank` можно подключить отдельно).
  - «within N feet of X» с именованной целью («hoard», «ley line», «Kerinza») — единичные; уникальные объекты мира.
- **Ложные блоки:** «adjacent to a creature» требует токена: GM использует способность без токенов на сцене → `null` при пустой сцене автора; «enemy» у союзных PC-призыва; высота (`elevation`) — `distanceTo` её учитывает, считаем так же.

### Этап 5 — оставшееся
- «hand» с разными подлежащими («has one hand free», «both hands free», «at least two free hands») — расширить `HAND` (E, 40+ док.), кроме того что для NPC ответ `null`: практическая польза только у PC (5 док.).
- «spell slot» (8 док.) — нет единого API ячеек (подготовленные/спонтанные/ранги) — не брать.
- «Frenzy» — 26 док., нет данных.

### Этап 6 (опционально) — `gear.loaded`: 39 PC-док. Сначала живой разбор: какие поля pf2e хранит для «заряжен» (`system.expend`, `ammo`, `chambered`, capacity-стволы), и только потом решать.

## 4. Итог по числам (1667 док. группы G)

| этап | клаузы | полный разбор PC / NPC | проверяемо рантаймом |
|---|---|---:|---:|
| 1 | cond, stance, rage | 68 / 57 | 68 / 45 (NPC `stance`/`effect` → null) |
| 2 | gear | 75 / 116 | 75 / 0 (NPC → null) |
| 3 | combat, num | 5 / 48 | 5 / 48 |
| 4 | near, holds+ | 5 / 77 | 5 / 77 |
| итого | | 155 / 301 (456; ≈27%) | ≈ 280 (≈17%) |
| + частичный разбор (AND с неразобранным атомом) | | +48 / +52 | +≈60 |

Не в охвате: корпус «N» (в `report.md`) — 1700+ док. другой природы (прошлое действие не-Удар, союзники/скакуны, цель, мир) — этим планом не затрагивается.

## 5. Решения

1. **Только разбор на оверлее** (`tools/use-limits.mjs`), не в рантайме: русские описания pf2ru недоступны английской регулярке — как и сейчас. Рантайм `clauseState` расширяется ветками по `k`, строка `req` в `LIMITS` остаётся одна; новые данные — ленивый `ctx.facts` (conds, options, held, hp, combat, near), чтобы `clauseState` оставалась чистой и тестируемой в node.
2. **«AND с неразобранной частью»** (частичный): в `or`-ветке неразобранный атом не может сделать клаузу истинной, только ложной, поэтому блок по разобранной части безопасен. Но это отступление от принципа «неразобранная клауза — записи нет». По умолчанию в плане НЕ включено: первый выпуск — только полный разбор; частичный — после замера ложных срабатываний (вопрос 1).
3. Предупреждение называет **только невыполненный атом** («что не так и что сделать»), а не весь текст требования.
4. Выключатель — прежний `mech.req` целиком. Выключатель по клаузе не делаем (§1.5: условия вычисляются, не переключаются).
5. Тексты: `builtin.limit.need*` в `lang/ru/builtin.json` и `lang/en/builtin.json`, подписи — из `CONFIG.PF2E.*` (conditionTypes, weaponGroups, armorCategories и т.д.); термины pf2ru. Названия предметов — с листа.
6. Обход: Alt; для своих бросков модуля (`unchecked`) требование не проверяется (§3.4) — ничего нового.
7. Проверка «не двойное»: клаузы только читают; пишущих эффектов нет — §3.5 не затрагивается.

## 6. Порядок работ

Одна-две клаузы за этап; перед каждым — юнит-тест, затем живой сценарий; после каждого — замер.
1. **Этап 1:** `cond`+`stance`+`rage`. Юнит: `tests/use-limits.test.mjs` (разбор: ≥20 фраз из `list.csv`, положительные и отрицательные, «or»/«and»), `tests/limit-text.test.mjs` (`clauseState` для `cond`/`stance`/`rage`, null у NPC-stance), `tests/impulse-gate.test.mjs` (needText). Живой: `tests/live/limits-requirements.js` по образцу `limits-recharge.js`: копия PC — «Rage»-подобное действие с `not fatigued`; стойка без/с эффектом; NPC с состоянием Fatigued.
2. **Этап 2:** `gear` (PC). Юнит: полный набор «оружие/щит/броня» на фикстурах актёров; Двойной взмах. Живой: копия PC без оружия → блок; с оружием в руке → проходит; щит без/с; NPC → пропуск.
3. **Этап 3:** `combat`+`num`. Живой: бой с брошенной/не брошенной инициативой, NPC с ПЗ ниже порога.
4. **Этап 4:** `near`+`holds`. Живой: два токена на копии сцены (рядом/вдали), союзный/вражеский, «Grabbed» на соседе.
5. **Этап 5/6** — по итогам замеров.

**Замер ложных срабатываний (после каждого этапа):** образец `scratchpad/eval/sample.mjs` — случайная выборка 50 документов, где клауза включилась; для каждой пары (текст, решение) **независимый проверяющий** (не автор разбора; Haiku после мелких правил ненадёжен — брать Sonnet) читает исходный английский текст и говорит: клауза передаёт смысл полностью? Критерий приёмки: ≥95% точно, любой «клауза строже текста» — исправление регэкспа или исключение формы; затем повторная выборка. Живой прогон — на «Тестовые копии (автоматизация)» в RustySpirit, мир чужой — своё убираем (§4.1–4.2).
Всей группой (§4.4): после каждого этапа прогнать все ветки `any/all` на трёх актёрах (PC, NPC связанный, NPC не связанный) и в каждом из состояний «данных нет» (нет боя, нет сцены, нет токена, нет предметов) — должно быть `null`.

## 7. Риски

- **Ложный блок на хвостах формулировок:** главный. Смягчение: строгий `^…$` разбор всего абзаца, только перечисленные формы, замер, независимый проверяющий.
- **Состояние на листе не ведётся** (игрок не ставит «в руке», не вешает состояния, ГМ не ведёт стойки NPC): `null` для NPC, для PC — только данные, на которые pf2e сам опирается (Удары, Raise a Shield).
- **Дубли uuid/бестиарий:** у NPC `uuid` только у представителя группы одинаковых текстов; охват по `bySlug` требует тип `action` и одинаковой подписи (`reqSig`). Новые клаузы наследуют этот предел — реальное покрытие NPC ниже таблицы (нужно досчитать по `buildLimits().report.covered`).
- **Рассинхрон с Мастерской:** `mechanisms.mjs` показывает сводку через `needText` и должен уметь `all`; незнакомая клауза в рантайме — `null`, не исключение.
- **Производительность:** токены/предметы считаются лениво и только когда запись `req` есть у использованного предмета.
- **Конфликт с другим Рабочим:** правки пойдут в `tools/use-limits.mjs`, `scripts/builtin/limit-text.mjs`, `impulse-gate.mjs`, `lang`; согласовать порядок слияния (вливать по одному).

## 8. Открытые вопросы к пользователю

1. Разрешить **частичный разбор** (AND с неразобранным атомом; блок по понятной части, ≈+100 док.)? Это отступление от принципа «неразобранная клауза — записи нет».
2. `combat` (21 док., 3 уник. текста) и `focus` (3) — делать, несмотря на порог ~30 док., или оставить долгом? (Дёшево: ~10 строк, но ниже порога.)
3. Нужен ли **этап по NPC-снаряжению** («manacles in hand», «two melee weapons») через ручную пометку в Мастерской (ГМ отмечает, что у NPC в руке), или NPC-снаряжение остаётся без проверки навсегда?
4. «Труп» (71 док.) и «видимость» (49 док.): окончательно НЕ автоматизируем (мой вывод — да) или ГМ готов получать блок с обходом Alt?
