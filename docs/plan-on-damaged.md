# План: реакции «would take damage» (onDamaged), v2

v1 разобран Критиком; v2 учитывает замечания: удержание урона вместо отказа «урон уже применён», изменение урона в обёртке `applyDamage` (любой путь нанесения), предикат вместо перечисления `from`, «только против триггерного урона», без двойной карточки.

## Задача

Группа ~60 предметов pf2e с триггером «… would take damage» (`tools/out/items.json`, `descEn`, строка `Trigger`; выгрузка — scratchpad `g2.txt`). Сейчас подсказки реакций есть только у `onAttacked` (`scripts/reactions.mjs`) и Блока щитом (`scripts/builtin/shield-block.mjs`). Нужен общий механизм: карточка урона → шёпот владельцу реакции и ГМу с кнопкой (название с листа) → нанесение урона по этой цели ждёт решения → ответ исполняется, урон применяется с учётом ответа любым путём (pf2e, toolbelt, basic-damage).

## Схема `onDamaged`

Ветка правила; совместима с `onUse` (ответ-эффект — это `onUse.apply`), несовместима с `onAttacked`.

```json
"onDamaged": {
  "who": "self" | "familiar" | "ally",   // ally: союзник в range фт от владельца; withSelf — «вы или союзник»
  "range": 30, "withSelf": false,
  "when": <предикат pf2e по опциям карточки урона>,   // тип урона (damage:type:fire), источник (attack, strike, spell), crit, enemy — predicate.mjs testPredicate
  "requires": <как у requirementOf cast.mjs:97>,       // поднятый щит, стойка, предмет в руке
  "damage": null | { "reduce": "<формула>" } | { "halve": true } | { "redirect": "self", "part": "all"|"half" },
  "triggerOnly": false,     // эффекты ответа (onUse.apply) снимаются после триггерного урона
  "cost": null | { "hp": "<формула>" },   // Life Block: владелец теряет ОЗ
  "notify": ["owner","gm"]
}
```

Формулы — `resolveFormula` (rank, level). `eidolon`, `lethal`, «назначенный рыцарь/ward/хозяин трэлла» — `skip` с причиной. Блок щитом и его копии (Swift Block Cabochon и т. п.) — `skip` «builtin shield-block» (иначе две подсказки на одну реакцию).

## Подсказка (ГМ, карточка урона)

1. Карточка `damage-roll`, урон > 0, не лечение, не удержана (`hold.mjs isHeld`).
2. Цели: `damageTargets`, а у урона по спасброску — цели карточки испытания (`linkOf(dmg).card` → `challengeTargets`, basic-damage.mjs).
3. Кандидаты: `self` — цель; `familiar` — хозяин (`familiar.system.master.id`, familiar.mjs); `ally` — `alliesIn(withSelf)` (apply.mjs:362).
4. Фильтры: `reactionAvailable`, `when` по опциям карточки (если типов урона в опциях нет — добавить `damage:type:<t>` из `roll.instances`), `requires`, ресурс (фокус у фокус-заклинаний, ячейка, `system.frequency`, заряды), урон по цели не применён.
5. Шёпот только `notify` (как `reactions.mjs:183`, не `whisper()` всем). Флаг `flags[MOD].damaged = { message, token, actor, item, state: "pending"|"used"|"skipped" }`. Кнопки: «<Название предмета>» и «Без реакции».
6. Окно реакции: тот же `reaction.showWindow`, но разбор по виду подсказки (`reaction` атаки или `damaged`), свой текст и свой путь `callGM`.

## Удержание урона

Подписчик `apply-hook.mjs` (единственная обёртка `Actor#applyDamage`): если у актёра-цели есть подсказка `damaged` в состоянии `pending` — нанесение ждёт её решения (смена состояния сообщения, `updateChatMessage`), с таймаутом (решение «без реакции»). Пока ждёт — уведомление «урон ждёт решения о реакции». Так проигрыш гонки исключён для любого пути нанесения, включая auto basic-damage.

## Нажатие (через `callGM`, `queue` по паре «урон + цель»)

1. Перепроверка: карточка жива, реакция и ресурс есть, состояние `pending`.
2. Использование предмета один раз: заклинание — сотворение, иначе `toMessage`; в `unchecked` (impulse-gate.mjs:90); цели использования — защищаемый токен (подмена целей на время вызова, образец `castTargets` builtin/variable-cast.mjs:98). `onUse.apply` — штатно. У предметов с `system.selfEffect` — проверить, что эффект ложится на защищаемого.
3. `spendReaction(actor, null)` — только флаг (карточка уже есть, второй `toMessage` не нужен).
4. `damage`/`triggerOnly`/`cost` записываются в подсказку; состояние → `used`; ждущее нанесение продолжается.
5. Подписчик `apply-hook` при продолжении: `reduce`/`halve` — `opts.damage.alter`; `redirect` — через `damage-link` (`distribute`, `settle` у ГМа); `after` — снять эффекты ответа (`triggerOnly`), списать `cost`.
6. «Без реакции» → `skipped`, нанесение продолжается как есть.

## Вне объёма (оговорка)

- Урон без карточки (зоны, опасная местность, продолжительный урон, перенос `damage-link`) подсказку не даёт.
- Мастерская (редактор `onDamaged`), перенос Блока щитом.
- Понижение крита (Abjure Harm, Mist Evasion), телепорт/шаг — только заметка.

## Каталог группы

После механизма: правила `onDamaged` по `descEn`; несхемные — `skip` с причиной. Phase Familiar — первым: `who: familiar`, `triggerOnly: true` (вместо ручного `onEvent damage-taken`).

## Реализация (отклонения от схемы v2)

Код — `scripts/builtin/damaged.mjs`; тесты — `tests/on-damaged.test.mjs`.

- `requires`: слово как у активации (invested/equipped/held/none) **или** опция владельца вида `shield:raised` (проверяется как `self:shield:raised`, pf2e.mjs:34495) и `stance:<slug>` (эффект стойки: `self:effect:<slug>` / `spell-effect-<slug>` / `stance-<slug>`; slug стоек проверяется по черте stance в `tools/out/items.json` — формат slug эффекта стойки по живому pf2e не сверен).
- `withSelf` допускает `false` у любого `who`; `range` — только у `ally` (по умолчанию 30). `reduce`/`cost.hp` — формула без кубиков.
- Опции для `when` (`damageOptions`): опции карточки pf2e (`self:` → `origin:`) + `damage:type:<t>` из `roll.instances` + исход как у pf2e `check:outcome:critical-success` + `attack` (урон Удара) + `item:type:spell` и `area-damage` (заклинание с областью). Прежние `outcome:*`/`source:*` и голые `crit`/`spell` каталога заменены. Словарь `knownOption`/`knownRequire`; `tools/check-on-damaged-draft.mjs` и тест проверяют, что ни одно `when`/`requires` (черновик, `catalog.model.json`, `catalog.json`) не мёртвое.
- **Состояние на токене.** Удержание и решение — `flags[MOD].damagedHold.<id подсказки> = {message, state: pending|used, turn, rev, name, until, decision}` на документе токена цели (пишет ГМ при создании подсказки/решении, снимает решение/пропуск/срок/`settle`). Его видит любой клиент, наносящий урон: шёпот подсказки видят только адресаты (у владельца цели-автора урона шёпота нет). Решение дублируется в `flags[MOD].damaged.decision` подсказки. `until` (2 мин) — зависшее pending не держит урон навсегда.
- **Привязка к карточке.** Подписчик `applyDamage` определяет источник: метка basic-damage в `rollOptions` или клик pf2e (снимок `ctx.click`, взятый в начале `wrap` до ожидания — `shield-block` `markApplied`/`alreadyApplied` работают после удержания любой длины; клик toolbelt не перехватывается — его селектор неизвестен). Источник известен — применяются/ждут только записи этой карточки; неизвестен — только записи этого же хода (`turn`).
- **Срок подсказки.** `expired`: конец хода/раунда (`updateCombat` у ГМа), нанесение урона этой карточки по цели (`markApplied`, `basic-damage.run` — в т. ч. ×0 у успеха спасброска). Кнопки гаснут (`bind`), удержания нет. Таймаут удержания ждёт ответа `skipDamaged(id, true)`: ответ несёт состояние, поздний `used` применяется; ранний `timeout` (< 30 с с создания) ГМ отклоняет.
- Цели использования реакции — `useTargetOverride` (util.mjs, по uuid владельца), читает только `use.liveTargets`; `game.user.targets` ГМа не подменяется. Параллельные подсказки разных владельцев не мешают; один владелец — в очереди.
- `useDamaged`/`skipDamaged`/`expire` — одна очередь на владельца реакции (`damaged-owner:<actor>`): реакция тратится один раз, остальные подсказки владельца закрываются (`skipped`, hold снят).
- Эффект ответа (`fx`) — на защищаемого: `who:self` — шаги `to:self`, `familiar`/`ally` — `to:target`. В `auto` ждём, пока use.mjs положит эффект (3 с); не лёг (или режим `button`/`off`) — `applyEffect` теми же шагами, без дубля (`hasEffect`).
- Подсказка до триггера: у урона по спасброску — только после итога спасброска цели и при множителе > 0 (`basic-damage.onResult` → `damaged.onResult`); `familiar`/`ally` — владелец на сцене и расстояние ≤ min(`range` правила у ally, `itemRange` предмета); не измерить расстояние (нет холста) — не штрафуем, как `farFrom`.
- **Сопротивление.** `damage.resist: [{type, value}]` — временный эффект с Resistance RE в клоне актёра только на это нанесение; `type: "triggering"` раскрывается типами урона карточки из `when` правила. `reduce` — только «reduce the damage by N» (Negate Damage, Frill Block, Dig In). Клон: `refreshed` создаёт `getContextualClone(options, [эфемерные эффекты старого клона, эффекты сопротивления])` — `damage-received` и basic-damage `ephemeral` не теряются. Клон pf2e сделан до ожидания и не видит эффекта ответа, поэтому подписчик подменяет `this` (apply-hook: `actor`, `subscribe(fn, {first:true})`).
- **Откат pf2e.** Нанесение несёт отметку `pf2e-automato:damaged:<id>` в `rollOptions` (попадает в `context.options` damage-taken). Откат (`isReverted`, у ГМа — `onUpdate`) → `unsettle`: перенос и цена в ОЗ возвращаются, `done` сброшен, `rev+1`, запись на токене вернулась (повторное нанесение применит решение снова, прежняя ревизия клиентом уже учтена). Снятые `triggerOnly`-эффекты ответа не возвращаются (потолок).
- **Права.** `damagedAfter(id, total, ids)`: сумму переноса считает ГМ по `decision` (клиент шлёт итог урона, ограниченный броском карточки, и список решений, применённых вместе — остаток для `planOf`). «Пропустить» в окне реакции у ГМа только закрывает окно, у игрока-владельца — «Без реакции»; явная кнопка «Без реакции» в чате решает.
- `triggerOnly` снимает эффекты `onUse.apply` защищаемого после применения урона; ручной `onEvent damage-taken` у эффекта Phase Familiar удалён.
- Подсказки создаёт `basic-damage.onMessage` (после связи с карточкой испытания, до auto-нанесения) и `onResult` (итог спасброска).
- Потолок: сопоставление нанесения и подсказки при неизвестном источнике (клик toolbelt) — по токену и ходу; два урона по одной цели в один ход до решения делят запись. Живой прогон на копиях не делался (только юнит-тесты).
