# cover-bypass: «Удар игнорирует / ослабляет укрытие цели (и скрытность)»

## ИТОГОВОЕ РЕШЕНИЕ (2026-10-26): вариант «пак», кубик `cover` НЕ делаем

Ревью Критика + живая проба в Foundry v14 / pf2e 8.6.1: механизм — **готовые эффекты в паке модуля**, правило — обычный шаг `{"to":"self","effect":{"uuid":<форма>}}` до Удара (нового кубика схемы, Мастерской, `effect.mods` не требуется; разделы ниже про кубик `cover`, §3/§5/§6 — историческое обоснование, не план работ).

- Пять проводников (`tools/cover-bypass.mjs`, `COVER_FORMS`; пак `Compendium.pf2e-automato.effects.Item.<id>`): `all` `pAfCoverAll00001` (любое), `L` `pAfCoverL0000001` (меньшее), `LS` `pAfCoverLS000001` (меньшее+обычное), `LSG` `pAfCoverLSG00001` (LS, большое → обычное), `step` `pAfCoverStep0001` (на ступень ниже). Устройство: на атакующем `EphemeralEffect` (селекторы `strike-attack-roll`, `spell-attack-roll`, предикат `target:cover-level:*`; у большого `or` с `greater-prone`) на эффект-поправку + носитель `FlatModifier attack-roll untyped 0 removeAfterRoll:"if-enabled"` со slug `af-cover-bypass-<форма>` (уникальный: `StatisticModifier` дедуплицирует по slug; untyped — circumstance мог бы проиграть по наложению и `if-enabled` не снял бы эффект). Бонусов к атаке в проводниках нет (у таких документов в pf2e свои переключатели).
- Поправки (клон цели): `E0` `pAfCoverFixE0001` (`suppress`), `E1` `pAfCoverFixE1001` (`downgrade 1`), `E2` `pAfCoverFixE2001` (`downgrade 2`). В каждой по два `AdjustModifier ac`: slug `cover` и `укрытие` (slug модификатора = `sluggify(имя эффекта)`, в русском переводе other-effects — `укрытие`). `slug:null` не годится: поправка с null цепляется ко ВСЕМ модификаторам КБ (`extractModifierAdjustments`, pf2e:39313), а предикат по модификатору (`getRollOptions`) тоже строится из slug.
- Скрытность pf2e не бросает — только текст в описании; не автоматизируется.
- Валидатор: `tools/validate.mjs` пропускает uuid этих пяти эффектов без ссылки в тексте и без записи в `refs`. Промпт `tools/prompts/draft-rule.md`: правило и таблица «форма → uuid»; сомнительное — `unsure`, ключ `cover-bypass-conditional`. Словарь `rules/mechanisms.json`: `cover-bypass` (примитив есть), `cover-bypass-conditional` (долг). Юнит: `tests/cover-bypass.test.mjs`. Живой сценарий: `tests/live/cover-bypass.js` (формы × укрытия lesser/standard/greater, снятие после броска).
- Шаг `effect` разрешён в `activate[].onUse` оружия/боеприпаса (`vActOnUse` → `vOnUse`, тот же словарь шагов; валидатор прогоняет `semanticErrors` по `activateUses`) — Golden-Cased ×3, Spiritsight, Ghosthand's, Arcing закрываются активацией.
- **Проверено вживую (проба Руководителя):** снятие обычного укрытия (КБ 21 → 19), большое → обычное (23 → 21), работает у NPC-атакующего ближним Ударом, после броска эффект удаляется. **Не прогнано вживую:** `tests/live/cover-bypass.js` целиком (пак с новыми документами не пересобран, пока мир Foundry держит базу), slug `укрытие` в русском мире, атака заклинанием, lesser, step/L/LS.
- **Долг:** пассивы предметов без карточки (Ghost Ammunition, Wild Winds Stance, Perfect Aim, I See You, Hawk's Eye, Transdimensional Tentacles); укрытие «от конкретного существа» (Penetrating Shot/Fire/Projectile, Piercing Shot, Full Bore, Starlit Span); Удар союзника (Redirecting Shot); щит `raised-shield` (Unerring, Phasing Trine — отдельный модификатор, второй `AdjustModifier` в поправке); Twisting Reach («два Удара» — проводник одноразовый, без снятия потребует отдельной формы); скрытность.

---

Историческое обоснование (до решения «пак»). Решение тогда: **не новый примитив шага, а новый кубик `cover` в уже существующем `effect.mods`** (inline-эффект на авторе, `plan-modifier-effect.md`). Рантайм — штатная зацепка pf2e: `EphemeralEffect` атакующего + `AdjustModifier` на модификаторе укрытия цели (так pf2e сам автоматизирует Alchemist Goggles). Цель не трогаем вообще: ни правки её эффекта, ни гонок, ни отката, ни прав. Снятие после Удара — штатный `removeAfterRoll` pf2e, событий модуля не нужно.

pf2e 8.6.1: `pf2e.mjs` в scratchpad (`.../scratchpad/Data/systems/pf2e/pf2e.mjs`); ниже «pf2e:N» — строка этого файла.

## 1. Факты pf2e (проверено по исходникам)

1. **Укрытие — эффект на цели.** «Effect: Cover» (`other-effects` `I9lfZUiCwMiGogVi`): ChoiceSet уровня (`lesser`+1 / `standard`+2 / `greater`+4 / `greater-prone`+4), RollOption `self:cover-level:<уровень>`, FlatModifier `ac` circumstance без предиката про атакующего (только `item:ranged` для prone). Slug модификатора = `cover`: у FlatModifier slug = `sluggify(label)`, label = имя эффекта без префикса «Effect: » (`reduceItemName`, pf2e:3278, `getReducedLabel` pf2e:31754).
2. **КБ цели при Ударе считается на «контекстном клоне» цели.** `RollContext.#e("target")` (pf2e:14800-14836) берёт эфемерные эффекты атакующего (`extractEphemeralEffects`, pf2e:14806) и делает `target.getContextualClone(options, ephemeral)` (pf2e:14824; сам клон — pf2e:32870: исходные предметы + эфемерные + флаг `rollOptions.all`). `CheckContext.resolve` (pf2e:14865-14880) берёт `dc` из `getStatistic("ac").dc` **этого клона**; DC считается при подготовке клона, до броска. Переброс (hero point) DC не пересчитывает: берёт сохранённый `context` из сообщения (`rerollFromMessage`, pf2e:19572-19584).
3. **Штатная зацепка есть.** `EphemeralEffect` RE на атакующем (pf2e:43576-43637): `affects:"target"`, `selectors` — домены броска, `uuid` — эффект/состояние, `predicate` проверяется по опциям броска **и самой цели с префиксом `target:`** (`extractEphemeralEffects`, pf2e:39334-39348: `s.getSelfRollOptions(e)`; `getSelfRollOptions` pf2e:32858). Предмет копируется в клон; ChoiceSet и GrantItem в нём запрещены. На клоне его `AdjustModifier` (pf2e:40190-40270) кладёт поправку в `synthetics.modifierAdjustments["ac"]`; модификатору КБ она цепляется по slug (`extractModifiers`, pf2e:39309-39313). `Modifier.applyAdjustments` (pf2e:39543): `suppress` → `ignored=true` (модификатор выпадает из суммы и из разбивки), иначе режим по `getNewValue` (pf2e:40160): `downgrade` = `min(текущее, value)`, `override`, `upgrade`. Стек считается уже после поправок (`calculateTotal`, pf2e:39660-39666).
4. **pf2e сам так делает.** `Alchemist Goggles` (`equipment-srd` `7JVgLiNTAs4clEW8`, 3 уровня): `{"key":"EphemeralEffect","predicate":["target:cover-level:lesser"],"selectors":"alchemical-bomb-base-attack-roll","uuid":"Compendium.pf2e.equipment-effects.Item.SZWxyXOTZtGvZbN7"}`; этот эффект (`equipment-effects`) — один RE: `{"key":"AdjustModifier","selector":"ac","slug":"cover","suppress":true}`. Выгрузка `system.rules` 26 предметов группы: RE на укрытие только у Goggles (×3); у Starlit Span — `Note`, у Incorporeal Shot / Arcing Hand Crossbow — не про укрытие (тоггл/+бонус), у остальных `rules: []`. То есть pf2e не покрывает почти ничего, но механизм стоит готовый.
5. **Снятие после Удара — штатно.** После броска Удара pf2e вызывает `afterRoll` у всех не-ignored RE атакующего (Удар персонажа — pf2e:20477, NPC/заклинание — pf2e:36027, проверки — pf2e:15167). `FlatModifier` с `removeAfterRoll: "if-enabled"` (pf2e:43839) удаляет свой эффект, если его модификатор реально попал в этот бросок (`check.modifiers` с `enabled`); бросает и удаляет владелец эффекта — прав ГМа не нужно.
6. **Скрытность: pf2e её не автоматизирует.** У «Concealed» `rules: []` (pf2e:47105-47140); плоская проверка СЛ 5 — только ссылка `@Check[flat|showDC:all|dc:5]` в тексте состояния, бросает игрок/ГМ вручную. В коде Удара/`CheckContext` проверки скрытности/невидимости нет (поиск `condition:concealed`/`condition:hidden`/`flat`: только описания и броски `flat-check` восстановления/постоянного урона). Модуль её тоже не бросает (`scripts/checks.mjs:37` — лишь бросок по ссылке `@Check flat`). Значит «игнорирует скрытность» = **автоматизировать нечего**: пропускать штатно нечего. Остаётся текст в карточке («плоская проверка не нужна»).
7. Домены Удара: `ranged-attack-roll`, `strike-attack-roll`, `attack-roll`, `attack`… (`getStrikeAttackDomains`, pf2e:20257-20275); у атаки заклинанием — `spell-attack-roll` и `attack-roll` (pf2e:28889, 38769). Селектор `attack-roll` покрывает оба вида.
8. Щит: модификатор поднятого щита — slug `raised-shield`, circumstance (pf2e:15245-15256), его тоже можно подавить `AdjustModifier` (нужно 2 предметам, §6).

## 2. Варианты рантайма

| | Суть | Риски | Вердикт |
|---|---|---|---|
| **A. EphemeralEffect + AdjustModifier на клоне цели** | на авторе эффект с RE `EphemeralEffect` (по уровню цели) → эффект-поправка (`suppress`/`downgrade`) | единственная цена — 3 крошечных эффекта в паке модуля; нужна живая проверка H1-H6 (§7); цель не меняется → нет гонок/отката/прав; параллельные Удары по той же цели независимы (поправка живёт только в клоне конкретного броска) | **рекомендую** |
| B. Понизить ChoiceSet укрытия у цели на время броска и вернуть | `update` эффекта цели → бросок → обратно | правка чужого актёра (игроку нельзя, нужен ГМ/сокет); гонка: параллельные Удары других по той же цели видят чужое укрытие; сбой между «понизили» и «вернули» оставляет цель с неверным укрытием навсегда; ждать обновления КБ до броска; откат по журналу | отвергнуть |
| C. Обёртка `Statistic.dc`/`CheckContext.resolve` (libWrapper) | подменять DC в расчёте | ломается при обновлении pf2e (минифицированные имена); глобальный побочный эффект; обходит разбивку | отвергнуть |
| D. Штраф/бонус на бросок атаки равный бонусу укрытия | `FlatModifier` +N circumstance | не стыкуется с circumstance-бонусами Удара (Sentry's Aim +1, Hunter's Aim +2 — тип один, действует больший); КБ в карточке не меняется; для greater→standard нужен предикат по уровню цели, который всё равно только в зацепке A | отвергнуть |

## 3. Схема правила

Новый кубик `effect.mods`, ровно как `bonus`/`weak`/`forbid` (`scripts/inline-effect.mjs`, `MOD_KINDS`, `normalizeMods`; в шаге `rules.mjs:189-195`):

```json
{"to":"self","effect":{"mods":[
   {"bonus":{"target":"attack-roll","type":"circumstance","value":1}},
   {"cover":{"lesser":"none","standard":"none","greater":"standard","concealed":true}}]},
 "duration":{"value":0,"unit":"rounds","expiry":"turn-end"}}
```
(Sentry's Aim: «+1 circumstance, игнорирует скрытность, меньшее и обычное укрытие, большее → обычное».) Это `onUse.apply` записи использования или `activate[].onUse.apply` предмета (оружие/боеприпас/расходник) — те же шаги, новых событий `onEvent` не нужно.

`cover` — словарь «исходный уровень → результат», ключи необязательны (нет ключа = без изменений; хотя бы один обязателен):
- ключ `lesser` | `standard` | `greater`; значение: `"none"` | `"lesser"` | `"standard"`, строго ниже ключа (`greater: standard`, `standard: lesser|none`, `lesser: none`);
- `concealed: true` — **только текст** (автотекст кубика, описание эффекта, карточка); в рантайме ничего не делает (факт 6);
- `once: false` — не снимать после первого броска (два Удара подряд — Twisting Reach); по умолчанию `true` (снять).

Все 6 форм текста выражаются без новых слов: «ignores all cover» = три `none`; «all except greater» = `lesser`,`standard` → `none`; «lesser and standard, greater→standard» = `none`,`none`,`standard`; «reduce by one step» = `none`/`lesser`/`standard`; «ignores lesser» = только `lesser`.

**Генерация RE** (`rulesOf` в `scripts/workshop/effect.mjs`, ядро чистое; `rulesOfMods` проставляет slug `af-<i>`):
- на каждый ключ — `{"key":"EphemeralEffect","affects":"target","selectors":["attack-roll"],"adjustName":false,"uuid":<док>,"predicate":["target:cover-level:<ключ>"]}`; для `greater` предикат `{"or":["target:cover-level:greater","target:cover-level:greater-prone"]}`; `<док>` по значению: `none` → «обход: нет», `lesser` → «не выше меньшего», `standard` → «не выше обычного»;
- при `once` — носитель снятия: `{"key":"FlatModifier","selector":"attack-roll","type":"untyped","value":0,"removeAfterRoll":"if-enabled"}` (значок «+0» в разбивке — известная цена; у эффектов, где уже есть бонус к Удару, он нужен всё равно, потому что снимает именно носитель, а не бонус).

**Три документа в `packs/_source/effects/`** (сборка `tools/build-packs.mjs`, uuid `Compendium.pf2e-automato.effects.Item.<id>`, id фиксированные 16 символов): `cover-bypass-none` — `AdjustModifier ac slug cover suppress:true`; `cover-bypass-lesser` — `mode:"downgrade", value:1`; `cover-bypass-standard` — `mode:"downgrade", value:2`. Без `predicate` у `AdjustModifier`: выбор уровня уже сделан предикатом `EphemeralEffect`. Свой док вместо `SZWxyXOTZtGvZbN7` — чтобы не зависеть от id внутри pf2e.

**Валидатор** (`normalizeMods` + шаг в `rules.mjs`): `cover` — только в `effect.mods` шага с `to:"self"` (ошибка `effect.cover`); не допускается в стадиях недуга (`mods` стадии идёт через тот же `normalizeMods`: параметр «кубики стадии» без `cover`); словарь ключей/значений как выше, не более одного `cover` в списке; срок обязателен (уже требуется для mods) — для «этого Удара» ставить `{value:0,unit:"rounds",expiry:"turn-end"}` (конец хода автора; без Удара эффект сгорит вместе с ходом).

**Мастерская / лист** (`ruleToForm`/`formToRule`, `scripts/sheet.mjs:58-59, 120-122`): `effect.mods` лежит в `row.text` как JSON — **`sheet.mjs` не меняется** (круговой тест, §5). Правки в Мастерской: `automation.mjs:166-195` (`MOD_ADD` + `cover`, `MOD_DEFAULT.cover = {lesser:"none",standard:"none"}`, `modParts`/`modSet` для вложенных полей), `app.mjs:144-154` (строка кубика: три селекта lesser/standard/greater = «—/нет/меньшее/обычное» и флажки «скрытность», «снять после Удара»; в `modsField` стадии недуга — без `cover`), lang ru/en: `workshop.au.mod.cover`, `workshop.text.cover` («Удар: игнорирует меньшее и обычное укрытие; большее → обычное; скрытность»), ошибка `effect.cover`. Автотекст идёт в карточку/описание через `textOfMods` (`chat.mjs:122`, `apply.mjs:57`) сам.

**Промпт** (`tools/prompts/draft-rule.md`, рядом со строкой 61 про `mods`): блок `{"cover":{…}}`, шесть форм → словарь выше, `concealed:true` если текст называет скрытность, `once:false` для «N Ударов»; НЕ использовать, когда: укрытие «от конкретного существа» («lesser cover the other target provides»), пассив предмета/стойки/боеприпаса (нет карточки), область/спасбросок, Удар союзника, укрытие «от препятствий меньше 10 футов» — `unsure: true`, заметка `cover-bypass-conditional`. `tools/validate.mjs` (`checkAnswer`): `cover` в ответе без слова cover/concealed в тексте — ошибка (ложное покрытие); текст «ignores … cover» без `cover` у предмета-Удара — предупреждение «проверить».

**Словарь механизмов** (`rules/mechanisms.json`): новый `cover-bypass`, `"primitive": "effect.mods cover (plan-cover-bypass.md)"`, `aliases`: `ignor\w*[^.]{0,40}(?:concealment|concealed|cover)`, `Strike ignoring concealment and cover`, `concealment negation on target`, `cover bypass`. Поправить у уже стоящих в долге 13 записей (`b02` — Final Shot, Hunter's Aim, Targeting Shot, Incorporeal/Phase/Homing/Shooting Star, Unerring, Focused, Incredible, Hell-Lancer, Wild Winds…) метки на `cover-bypass`; при пересчёте долга примитив «есть» → «к проходу».

## 4. Охват (регулярка пользователя, `tools/out/html.json`)

Сырой html даёт 45 попаданий; `@UUID[…]` ломает `[^.]` (точки в «Compendium.pf2e»), с вычищенными ссылками — **62 записи** (предметы + встроенные в NPC), разобраны вручную:

| Класс | Число | Что |
|---|---|---|
| **закрывается кубиком** | **31** | один названный/«следующий» Удар: 13 черт, 2 заклинания, 6 NPC-действий — карточка `use`; 10 оружие/боеприпас/снаряжение/расходник — активация (`activate[].onUse`) |
| pf2e уже умеет | 4 | Alchemist Goggles ×3 + NPC-копия (текстом) — ничего не делать |
| пассив предмета/стойки/NPC | 7 | Ghost Ammunition, Wild Winds Stance ×2, Perfect Aim, I See You, Hawk's Eye, Transdimensional Tentacles — нет карточки, правило должно жить в `rules` предмета pf2e; остаётся долгом |
| укрытие «от конкретной цели/существа» | 8 | Penetrating Shot ×2, Penetrating Fire, Piercing Shot, Full Bore, Redirecting Shot (Удар союзника), Starlit Span (укрытие от союзников), Penetrating Projectile — pf2e укрытие по источнику не различает; «игнорировать меньшее вообще» завышает; остаётся долгом / заметкой |
| вне темы | 12 | область, зрение, ложные («Overlooked Mastermind»: «ignorance»), Cursed Domain, Stone-Hewing Spit… |

Из 38 «Ударных + пассивных»: формы — «весь» 23 (20 + 3 «игнорирует модификаторы от укрытия»), только меньшее 5, меньшее+обычное 3, меньшее+обычное и большее→обычное 4, «на ступень ниже» 2, «всё, кроме большего» 1. Упоминают скрытность 18 из 31 закрываемых. Прочие части текста остаются долгом/заметкой (урон Hell-Lancer, след Shooting Star, щит Phasing Trine/Unerring: их `raised-shield` — отдельный модификатор, v1 его не трогает).

Порог ROADMAP §7 (~30) проходит впритык: 31 закрываемый, 38 с пассивами. Решение пользователя — механизм под группу, поэтому делаем.

Таблица для прогона (проверочный оракул модели и сверка; `L`=lesser, `S`=standard, `G`=greater; `all`=L,S,G → none; `LS`=L,S → none; `LS+G>S`=L,S none, G standard; `step`=L none, S lesser, G standard; `c`=concealed):
- feat: Bullseye `LS+G>S c` +1 circ; Final Shot Knows the Way `all c`; Hunter's Aim `L c` +2 circ; Targeting Shot `all c`; Pattern Flight `all`; Incorporeal Shot `all c`; Wind-Tossed Spell `all c` (атака заклинанием); Unerring Runic Attraction `all c`; Focused Shot `all c`; Incredible Ricochet `all c`; Hell-Lancer Shot `L c`; Phase Bullet `all c`; Homing Shot `all c`.
- spell: Shooting Star `step c`; Boomerang Shot `LS c`.
- оружие/боеприпас/…: Spiritsight Crossbow `all`; Guiding Star `LS+G>S`; Guiding Starknife `LS`; Arcing Hand Crossbow `all` +1 circ; Ghosthand's Comet `all`; Golden-Cased Bullet Standard `L`, Greater `LS`, Major `all`; Wind-up Wings (Homing) `step c`; Phasing Trine `all`.
- NPC: Twisting Reach `all` `once:false`; Veering Miss `all`; Ricochet Throw `all` (условие «второе использование» — заметка); Targeting Shot `all c`; Sentry's Aim ×2 `LS+G>S c` +1 circ.

## 5. Тесты

Юнит (`node --test`):
- `tests/inline-effect.test.mjs`: `normalizeMods` принимает все 6 форм (таблица §4 как данные), отвергает: `greater:"greater"`, `lesser:"lesser"`, пустой `cover:{}`, два `cover`, `once:"no"`, чужие ключи, `cover` в стадии недуга; `rulesOfMods` — ровно столько `EphemeralEffect`, сколько ключей, предикат `or` у `greater`, ровно один носитель `removeAfterRoll:"if-enabled"` (и ни одного при `once:false`), slug'и уникальны; `textOfMods` на ru/en.
- `tests/cover-bypass.test.mjs`: правило Sentry's Aim проходит `validateRule`/`normalizeRule`; `cover` с `to:"target"` — ошибка; круговой `ruleToForm`→`formToRule` не теряет `cover`; дерево `rules/catalog*.json`: все записи с `cover` валидны.
- Пак: тест на `packs/_source/effects` — три документа, у каждого один `AdjustModifier` со `slug:"cover"`.

Живой сценарий `tests/live/cover-bypass.js` (формат `tests/live/inline-effect.js`: вкладка ГМа, `AF тест:`-актёры, `s.variants[0].roll({event})`, читаем `flags.pf2e.context.dc.value` и `modifiers` из сообщения):
1. База: цель с Effect: Cover (standard, как `hud.mjs` `setCover`) — КБ цели X, Удар без эффекта даёт `dc = X`.
2. Sentry's Aim (`applyInlineEffect`/карточка): Удар → `dc = X−2` (standard → none), в разбивке «Cover» выключен; эффект автора снят после броска (`removeAfterRoll`); второй Удар — `dc = X` (одноразовость).
3. Цель с greater: `dc = X−2` (4→2); с lesser: `dc = X−1`; `greater-prone` по дальнему Удару — то же, что greater.
4. «all except greater»: greater остаётся `X`; «step»: standard → lesser (−1).
5. Параллель: два автора, у одного эффект; `Promise.all` двух Ударов по той же цели → у первого `dc` ниже, у второго обычный; эффект Cover цели не менялся (id, `rulesSelections`, `_source` без правок).
6. NPC-атакующий (`melee`), атака заклинанием (`spell-attack-roll`) — тот же результат (H3).
7. `once:false`: два Удара подряд оба с обходом; эффект исчез по концу хода.
8. Откат карточки (`undoOps`) снимает эффект; переброс (hero point) не меняет `dc`.
9. Игрок-владелец (если есть второй пользователь) — Удар без ГМ-правок цели.
Добавить в `tests/live/suite.js`.

## 6. Шаги

0. **Проба (до кода, 1 час):** одноразовый скрипт в консоли ГМа: два мировых Item-эффекта (`Item.<id>` вместо пака), атакующий с `EphemeralEffect`+`FlatModifier removeAfterRoll:"if-enabled"` value 0, цель с Cover; прочитать `dc` в сообщении. Проверяет H1-H6 (§7). Провалился H1 — план не идёт (запасной вариант B неприятен, §2), решаем с пользователем.
1. Пак: три эффекта + `build-packs`, константы uuid в `effect.mjs`.
2. Ядро: кубик `cover` (`inline-effect.mjs`, `effect.mjs` `rulesOf`/`textOf`), валидатор шага (`rules.mjs`), юнит-тесты §5.
3. Мастерская (`automation.mjs`, `app.mjs`, lang) + круговой тест листа.
4. Промпт, `tools/validate.mjs`, `rules/mechanisms.json`; долг 13 записей → метка `cover-bypass`.
5. Данные: 31 запись по таблице §4 — модельным проходом по пулу механизма (`tools/debt-pool.mjs`), сверка с таблицей как оракулом; вывод из разметки без модели ненадёжен (~50 % ошибок), поэтому не регуляркой. Каталог: `catalog.json` `bySlug["sentrys-aim"]` сейчас — заметка («вручную»), заменить правилом с кубиком (убрать текст «вручную»). Оружие/боеприпасы — `activate[].onUse` (проверить в `plan-activate.md`/`cast.mjs`, что шаг `effect.mods` разрешён в записи активации).
6. Живой прогон §5 (по одному, вкладка ГМа).
7. Отчёт/`coverage.md`/`ROADMAP.md` (не в этой работе).

## 7. Что проверить вживую до кода (допущения)

- **H1** `EphemeralEffect` с uuid из пака модуля (не pf2e) и предикатом `target:cover-level:*` срабатывает, `AdjustModifier slug:"cover"` подавляет модификатор на клоне (прецедент Goggles, но не проверено у нас).
- **H2** `downgrade` на модификаторе `bonus 4` даёт 2 (greater → standard), а на `bonus 1` — 1.
- **H3** селектор `attack-roll` срабатывает у NPC-`melee` и у атаки заклинанием.
- **H4** КБ в карточке и в `flags.pf2e.context.dc` уже сниженный; разбивка показывает «Cover» выключенным.
- **H5** носитель `FlatModifier value:0 removeAfterRoll:"if-enabled"` попадает в `check.modifiers` (нулевой модификатор не отбрасывается) и снимает эффект после Удара и после атаки заклинанием (путь pf2e:36027 вызывает `afterRoll`). Если нет — запас: `removeAfterRoll:true` на «+1»-модификаторе (где он есть) либо событие `onEvent attack-roll afterUse` + `removeEffect` (как `plan-strike-gate.md`; цена — связь «карточка → Удар» только для `use`, у оружия/боеприпасов её нет).
- **H6** игрок-владелец без ГМа получает тот же результат (клон строится на его клиенте).

## 8. Ограничения и риски

- **Гонки нет по построению**: правок цели нет; поправка живёт в клоне одного броска. Откат при сбое — штатный откат создания эффекта автора (`undoOps`, op `created`); если Удар не сделан — эффект сгорит с концом хода/срока.
- «Ближайший» Удар: эффект действует на **любой** бросок атаки автора, пока жив (включая Удар по реакции между карточкой и Ударом); снимается первым же. Для Redirecting Shot (Удар союзника) — не подходит (эффект на авторе, бросает союзник).
- Укрытие «от конкретного существа», пассивы, щит (`raised-shield`) — не в v1 (§4). Расширение на щит — второй `AdjustModifier slug:"raised-shield"` в `cover-bypass-none`, но он не «укрытие» по тексту (Unerring, Phasing Trine) — отдельным ключом `shield: "none"`, если понадобится.
- Скрытность не автоматизируется ни pf2e, ни модулем; кубик лишь пишет текст. Если когда-нибудь модуль начнёт бросать плоскую проверку при Ударе по скрытой цели, `concealed:true` становится опцией-условием пропуска (`self:`-опция на эффекте автора) — сейчас YAGNI.
- Порог ~30 пройден с небольшим запасом; если сбор покажет <30 реально закрываемых — по правилу §7 делать всё равно (решение пользователя: механизм под группу), но это один кубик и три документа, а не новый шаг.
