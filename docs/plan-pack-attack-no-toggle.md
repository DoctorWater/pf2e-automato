# План: «Стайный» (Pack Attack) без переключателя

Правило: CLAUDE.md §1.5 (условие вычисляется — переключателя нет). Решение пользователя: встроенную автоматику pf2e отключаем, если мешает; на токен HUD лишних переключателей быть не должно. Только план, код не тронут (`impulse-gate.mjs`, `events.mjs` правит другой исполнитель).

Что вычислялось по источникам (pf2e 8.4.1, копия паков в scratchpad, `pf2e.mjs` в `Data/systems/pf2e`):

## 1. Как pf2e считает урон «Стайного»

- Предмет (73 NPC в бестиариях + feat `feats-srd` Pack Attack; всего 76 документов с `pack-attack` в правилах) несёт два правила:
  - `RollOption {option:"pack-attack", toggleable:true, domain:"damage"}` (у 6 документов домена нет — `all`);
  - `DamageDice {selector:"strike-damage" (у двух волков `jaws-damage`), predicate:["pack-attack"], diceNumber/dieSize: 1d4…4d6, category:"precision" у 6}`.
- Переключатель — только решение «включить опцию»: `RollOption.beforePrepareData` (`pf2e.mjs:44530`) кладёт в `actor.rollOptions[domain][option]` и в `actor.synthetics.toggles[domain][option]` (из последнего строят строки на листе и в TAH).
- `DamageDice` — отложенная функция в `synthetics.damageDice[selector]` (`43546`); предикат проверяется в момент броска по набору опций броска `r.test` (`43519`). Набор собирает `createDamageRollFunctions` (`20566`): `options = new Set([...baseOptions, ...c.options])`, цель = `(c.target ?? game.user.targets.first()).document`. Дальше `RollContext.resolve` (`14698`) добавляет опции актёра `getRollOptions(domains)` и цели.
- Итог: добавить в бросок урона литерал `pack-attack` достаточно — dice, критудвоение, precision, разбивка в карточке считает сам pf2e. Своих кубов модуль не бросает.

## 2. Точка подстановки (самая узкая)

Публичный параметр `options` у `strike.damage()` / `strike.critical()` (его уже используют `strikes.mjs` `rollStrike`). Все пути урона Удара идут через эти две функции: лист, кнопка карточки pf2e, наша «Урон», TAH, Toolbelt. Статической точки (как `game.pf2e.Check.roll` для атаки) у урона нет: `WeaponDamage`/`DamageContext` в `game.pf2e` не выставлены, `DamagePF2e.roll` вызывается уже с готовой формулой. Поэтому:

- **Обёртка подготовки актёра** (libWrapper, `MIXED`/`WRAPPER`, как в `melee-reach.mjs`): `CONFIG.Actor.documentClasses.npc.prototype.prepareDerivedData` и `...character...` (`system.actions` создаётся там: `pf2e.mjs:35410` NPC; проверить пробой место у PC). После `super` у актёра с «вычисляемой» опцией (§4) оборачиваем `damage` и `critical` каждого Удара из `system.actions` и их `altUsages`:
  `async (c = {}) => orig({ ...c, options: [...(c.options ?? []), ...computed(actor, c)] })`.
- `computed` берёт цель так же, как pf2e: `(c.target ?? game.user.targets.first())?.document`, токен атакующего — как `pickSource` из `melee-reach.mjs` (токен актёра, иначе единственный выделенный), считает `alliesInReach` (она уже написана в правке `events.mjs`; **перенести в новый файл `scripts/builtin/computed-options.mjs`**, чтобы не конфликтовать с правкой `events.mjs`, `events.mjs` импортирует оттуда). Порог: `n >= min` -> опция `pack-attack`.
- Считает ровно в момент броска урона, на клиенте, который бросает (гонки с ГМом нет, очередь событий не участвует). Цели нет / другая сцена / вне сцены -> опция не добавляется (недобор, а не «остался старый переключатель»).
- Обёртки живут, пока жив подготовленный актёр (на каждом prepare создаются заново), поэтому отката не нужно; при выключенном модуле `libWrapper` ничего не регистрирует.
- Оговорка: `getFormula` (предпросмотр формулы на листе) идёт тем же путём — получит опцию по текущей цели; для листа это верно (формула по выбранной цели).

## 3. Переключатель на листе и в HUD

Выбор: **нейтрализовать правило `RollOption` предмета в рантайме**, а не скрывать и не оставлять.

- Откуда берётся строка: и лист NPC/PC (`pf2e.mjs:17275`, `synthetics.toggles`, placement `actions`), и Token Action HUD pf2e (`#I()` читает те же `actor.synthetics.toggles`, фильтр `enabled`) — один источник. Ядро pf2e в HUD переключателей не выводит. Включённые в мире RustySpirit (`core.moduleConfiguration`): `token-action-hud-core` + `token-action-hud-pf2e`; `pf2e-hud` в мире нет. CSS-хак не нужен и вреден: убрав запись из `synthetics.toggles`, исчезает везде (лист, TAH, будущие HUD).
- Способ: обёртка `ItemPF2e#prepareRuleElements` (`pf2e.mjs:33107` — актёр потом фильтрует `!e.ignored`, `33114`; `14238` вызывает те же правила). После `super` у правил `RollOption` с `toggleable` и `option` из реестра «вычисляемых» ставим `rule.ignored = true`. Правило выпадает из `actor.rules`: нет записи в `toggles`, нет устаревшей опции в `rollOptions`, `beforeRoll`/`afterRoll` не вызываются. `DamageDice` с предикатом не трогаем — он нужен pf2e.
- Это **тот же общий механизм**, что §5.2 `docs/plan-turn-movement.md` (Take Wing и ещё 7 фитов: `ignored = true` на собственных `RollOption`/`BaseSpeed`). Делать одним модулем: `scripts/builtin/neutralize-rules.mjs`, функция `neutralize(item)` с реестром `{ match(rule, item) -> bool }`; Стайный добавляет запись «RollOption toggleable, option ∈ COMPUTED_OPTIONS», полёт — свою. Первым делается механизм (пункт 0 плана полёта), потом обе записи. Обёртка ставится один раз, реестр общий.
- Обратимость: данные мира и предметов не меняются (не пишем в `system.rules`), `ignored` живёт в памяти до следующего prepare. Модуль выключен или обёртка не встала -> pf2e возвращает свой переключатель и работает как раньше.
- Двойной урон (§3.5) невозможен: даже если опция придёт и от переключателя (старый мир с `value:true` в данных предмета, модуль выключили/включили) и от модуля, предикат `pack-attack` булев, опции лежат в `Set` — кубы бросаются один раз. Опасность другая — старое «включено» без условия: нейтрализация правила её снимает. Кнопки pf2e (`toggleRollOption`) у нейтрализованного правила нет (`rules.find` его не найдёт, возвращает `null`).
- Если `DamageDice` предмета когда-либо будет добавлять и модуль своим уроном — так не делаем. Решение: **не заменять урон модулем**, только опция (надёжнее: формула, крит, precision, резисты — pf2e).

## 4. Общность и размер группы

Скрипт по паку (`tog.cjs` в scratchpad, 4166 документов с toggleable `RollOption`, 1876 разных опций):

| условие | документов | вывод |
|---|---|---|
| союзник в досягаемости цели (`pack-attack`; Superior Pack Attack, Coordinated Assault, Phantom Wolf, Pack Attack-черта) | **76** (порог 2: ~72; порог 1: 3) | выше порога ~30 -> механизм окупается |
| Convergent Tactics («ally с convergent tactics рядом с целью») | 3 | мелочь, свой признак у союзника |
| Tag Team (secret society, off-guard от фланга) | 1 | мелочь |
| Gang Up (союзник рядом с **самим** NPC) | 1 | мелочь |
| состояние цели (off-guard, тип существа), пробы по `descEn` | 2–5 по каждому | не набирается |
| баннеры (Banner of …, ~15–40), Hunt Prey, `first-attack`, `power-attack`, `finisher`, `spellshape` | десятки | **не вычисляется**: решение игрока, выбор цели/подопции, предмет носит состояние — переключатель остаётся |

Вывод: **механизм «опция броска, вычисляемая модулем» окупается только на семье Стайного (76)**. Остальные кандидаты — единицы; формат каталога под них не вводим (порог примитива). Реализация — маленький реестр в коде (`COMPUTED = { "pack-attack": { kind: "alliesInReach", min: 2 } }` + таблица порога 1 по источнику). Новое условие потом добавляется строкой в реестр и функцией условия, без пересмотра обёрток. Каталогом `rules/catalog.json` не ведём: правила pf2e в предметах уже есть, каталог дублировал бы их.

**Порог на предмет.** «Не менее двух» — по умолчанию. «Не менее одного» (Phantom Wolf из season-of-ghosts, Superior Pack Attack Лазлунн из age-of-ashes, Coordinated Assault Bellator Mortus из blood-lords) — таблица по `compendiumSource`/`sourceId` (3 UUID: `...season-of-ghosts-bestiary.Actor.R805QpID53EycZ5E.Item.ca6itFjnu2oqsgQt`, `...age-of-ashes-bestiary.Actor.9oNwQuwKGUuG9G9g.Item.tHzRquAwQcwKEsgJ`, `...blood-lords-bestiary.Actor.nzY0BPNKt4NF1Nhq.Item.jeVTUAjLCW0Tbgfl`). Если у актёра несколько предметов с этой опцией — берём минимальный порог. У Phantom Wolf slug тот же `pack-attack`, различить можно только по источнику (риск, см. ниже).

## 5. Что удалить / переделать (правка текущего незакоммиченного diff)

- `rules/catalog.json`: убрать обе записи `pack-attack@action` / `pack-attack@feat` (шаг `rollOption` для них не нужен).
- `scripts/apply.mjs`: `toggleDomain` удалить; `setRollOption` вернуть к прежнему виду (это отдельная фича Mighty Rage/Quick-Tempered, её мы не трогаем; правка `spec.domain = toggleDomain(...)` нужна была только Стайному). Строку README про `rollOption` вернуть как была.
- `scripts/events.mjs`: убрать `target:allies-in-reach:N` из `messageOptions` и параметры `targetToken`/`actorToken` (если на них больше никто не опирается) и README-абзац про него; `alliesInReach` перенести в `computed-options.mjs`.
- `tests/youre-next.test.mjs`: два теста `alliesInReach` переделать на импорт из `computed-options.mjs` (логика та же: живые союзники, без автора/цели/врагов, скрытые не считаются, досягаемость 10 фт), плюс случаи: порог 1 и 2, цели нет -> `[]`.
- README: абзац «Стайный» заменить на раздел «Вычисляемые опции броска» (реестр, где ставится, что переключатель нейтрализуется, ссылка на общий механизм нейтрализации).
- `lang`: строк нет (переключатель пропадает, предупреждений нет).

## 6. Тесты

Юнит (`node --test`):
- `computed(actor, c)`: опция есть при `n >= min`, нет при меньшем, нет без цели, цель из `c.target` приоритетнее `game.user.targets`.
- `neutralize`: правило `RollOption toggleable pack-attack` -> `ignored`, `DamageDice` и `RollOption` другого фита не тронуты, повторный вызов безопасен.
- Порог 1 по UUID Phantom Wolf, остальные 2.

Живой сценарий `tests/live/enemies.js`, `sc("pack-attack", …)` (прогон на копиях, после — убрать):
- убрать `on()` и проверки переключателя (`rollOptions.damage/all["pack-attack"]`), заменить на: `t.ok(!bySynth(A, "pack-attack"), "переключателя нет в synthetics.toggles")` один раз до раундов;
- урон бросается **сразу** после попадания, без `waitFor` (в этом и было состояние гонки); проверка кубов `d4` как сейчас (1 / 2 / 1);
- добавить раунд «урон по другой цели»: цель переключена между атакой и уроном — считается по цели урона (pf2e так же берёт цель);
- добавить Phantom Wolf (порог 1): один союзник у цели -> 2d4; нет союзников -> 1d4;
- проверка отката: убрать обёртку (`libWrapper.unregister`) -> `synthetics.toggles` снова содержит переключатель.
- Попутно проверить, что TAH не выводит строку (`actor.synthetics.toggles` без записи достаточно, TAH читает его же); лишняя проверка DOM не нужна.

## 7. Риски и вопросы

1. Обёртка `prepareDerivedData` на npc/character идёт на **каждую** подготовку каждого актёра: гейт — только актёры, у которых есть вычисляемое правило (`actor.itemTypes` + `rules`), иначе обход нулевой.
2. Место создания `system.actions` у PC (`prepareStrikes`?) пробой на живом pf2e; если `damage`/`critical` создаются лениво — обёртывать надо там.
3. Phantom Wolf отличим от обычного Стайного только по источнику предмета; мировая копия NPC без `compendiumSource` получит порог 2 (недоборозначение; ГМ — через Alt-обход не применимо, нужен ручной `RollOption`/эффект). Допустимо; другой вариант — таблица по `item.name` (хуже при переводе pf2ru).
4. Только квадратная сетка и отрисованная сцена (как `melee-reach.mjs`); цель на другой сцене — опции нет.
5. Союзник по `isAllyOf`, живой (HP > 0), не скрытый; невидимость/состояния («лежит», «не может действовать») pf2e для «досягаемости» не оговаривает — не учитываем (ГМ вправе не засчитать — решение ГМа, в отличие от переключателя возможности вручную нет). **Вопрос пользователю:** нужен ли ручной обход (Alt при клике «Урон» -> считать как два союзника / не считать)? В §1.5 обход Alt — образец для ограничений; для бонусов предлагаю не делать (YAGNI), пока не попросят.
6. Нейтрализация зависит от того, что актёр фильтрует `!e.ignored` после `item.prepareRuleElements` (`33114`) — проверить пробой при обновлении pf2e.
7. Порядок работ: (0) `neutralize-rules.mjs` + реестр (общий с планом полёта), (1) `computed-options.mjs` + обёртка strike, (2) чистка diff (§5), (3) тесты, живой прогон, Критик по диффу.
