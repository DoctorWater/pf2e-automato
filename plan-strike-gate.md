# strike-gate: испытание/шаги по исходу Удара этого использования (реализовано)

Решение: не новый примитив, а одно поле записи `onEvent`: **`afterUse: true`**. Всё остальное (двойник сообщения, карточка испытания, иммунитет, журнал, откат при перебросе) уже есть в `scripts/events.mjs`.

## 1. Связь Удара с использованием (лента чата)

Карточка черты (Headshot, Dazing Blow) и бросок атаки в pf2e — два несвязанных сообщения; опции `action:<slug>` в броске у таких черт не бывает. Выбрана лента — `events.strikeCardFor` (чистая, `scripts/events.mjs`), без меток, очередей и постоянных состояний:
- идём назад (до 50 сообщений) по сообщениям **того же актёра: `flags.pf2e.origin.actor`** (uuid с токеном), не `speaker.actor` (общий у несвязанных копий NPC);
- карточка (`useKindOf==="use"`) **с тем же slug**, что у носителя (`carrierSlug`: action и feat одного slug схлопываются в `eventItems`) — связь есть;
- **обрыв:** бросок того же вида (`eventOfMessage`) или карточка другого предмета. Отсюда «одна карточка = один Удар»: второй Удар и Удар после промаха не по этому использованию, Удар без карточки ничего не запускает;
- давность: в бою карточка не раньше начала текущего хода актёра (`turnStarts` — Map в памяти ГМа, пишется из `pf2e.startTurn`, не состояние мира), вне боя / нет данных — не старше 10 минут (`AFTER_USE_MS`);
- проверка стоит в `runEvent` **после** `when` (`m.entry.afterUse && !linkedCard(...)`); `matchEntries` не менялся.
Обобщено: `afterUse` допустим для `attack-roll`, `skill-check`, `saving-throw`, `damage-roll` при `side:"self"` (`EVENT_AFTER_USE`, `rules.mjs`); `spell-cast` — пачка 7 («следующее сотворение»).
«Это Удар» — явно в `when`: `self:action:slug:strike` (есть у Ударов персонажа и NPC; `action:strike` только у персонажа, pf2e.mjs:20349/35808).
NPC-способность без нажатой карточки (бьют прямо из листа) — ничего. Текст про конкретный Удар NPC (`attackEffects`) — это `catalog.onhit.json`, не strike-gate.

## 2. Форма

```json
{"v":1,"onEvent":[{"on":"attack-roll","side":"self","afterUse":true,
  "when":["self:action:slug:strike",{"or":["outcome:success","outcome:criticalSuccess"]}],
  "challenge":{"statistic":"fortitude","dc":{"against":"fighter"},"byDegree":{"success":[{"condition":{"slug":"stunned","value":1}}],"failure":[{"condition":{"slug":"stunned","value":2}}],"criticalFailure":[{"condition":{"slug":"stunned","value":3}}]}}}]}
```
Dazing Blow (реальный текст: «If the Strike hits … @Check[fortitude|against:fighter]», Stunned 1/2/3). Headshot — то же с `when:["self:action:slug:strike","outcome:criticalSuccess"]` и «умирает» на провале (условие «били ту же цель оружием за минуту» не выражается — остаётся заметкой). Исход и «если нанёс урон»: второе приравнено к «попал».

## 3. Вывод, инструменты, форма

- `deriveFromMarkup` не менялся (strikeGate в рантайме по-прежнему не исполняется). Перевод `onUse.challenge`+strikeGate → `onEvent afterUse` — одна чистая функция `gateToEvent` в `tools/strike-gate.mjs` (только feat/action; `when` по тексту: предложение с испытанием о критическом попадании → только крит, иначе попадание). Вызывается из `validate.normalizeRule` (ответы моделей) и CLI `node tools/strike-gate.mjs [--write]` для принятых черновиков.
- `validate.checkAnswer`: `onEvent` на attack-roll/damage-roll без `afterUse` на тексте strike-gate — ошибка (иначе срабатывало бы на каждом попадании). `stepsOf`/`semanticErrors` теперь смотрят и в `onEvent`.
- `withMarkupHead` и ограждение тёзок (`rules.mjs`) обходят **все** записи `onEvent` с `dc.expr:"markup"` (`markupChallenges`).
- Форма: `sheet.mjs` (`blankEvent`/`evForm`/`evRule`), «Мастерская» (`workshop/app.mjs`, `automation.mjs`), lang `au.ev.afterUse*`, ошибка `ev.afterUse`. Промпты: Strike-first — обычный `onUse.challenge`, `onEvent` не писать.
- Черновики: в `drafts-accepted` 16 записей strike-gate (всего ~120, 104 с `rule:null`: 34 b01, 70 b09 — повторный прогон моделями после реализации). 14 с `onUse`: **12 переводятся** (`node tools/strike-gate.mjs` — список, `--write` — запись; reason «needs-primitive: strike-gate» → confidence `model`; «missing: strike-gate, X» — правило переводится, статус остаётся долгом), 2 пропущены (Dreamcrusher, Tidal Crossbow — оружие, его активация — карточка kind `card`, не `use`).

## 4. Известные ограничения

- Переброс **не последнего** Удара теряет связь (в ленте после него уже другой бросок). Если нужно: `onDeleteMessage` кладёт id карточки в `stash`, `isReroll` берёт её оттуда.
- Нажатая и не использованная карточка в бою живёт до конца хода, вне боя — 10 минут.
- «Если нанёс урон» = «попал» (полный иммунитет цели даст ложное испытание). Условия-предпосылки («били эту цель за минуту») — заметка.
- Несколько Ударов за использование (Double Slice, Flurry) — вне рамок.

## 5. Подпачка «боеприпасы и бомбы» (не в этой работе)

«When damaged by this ammunition/bomb» — карточки нет, связь по опциям оружия, исход — урон (`damage-taken`, `side:"origin"`, `when:["origin:item:slug:<slug>","damage-taken:hp"]`). Риски (Критик): (1) последняя бомба/стрела исчезает до урона — носитель пропадает из `eventItems`, нужен поиск правила по каталогу по опции; (2) разбрызгивание (splash) — урон нескольким целям без отдельного Удара; (3) тики persistent damage дают `damage-taken` и ложные срабатывания — нужен фильтр по источнику сообщения; (4) попадают ли `ammo:*` в `context.options` / `origin.rollOptions` — проверить вживую. Пока `gateToEvent` такие типы (consumable/weapon) не трогает.

## 6. Живая проверка (персонаж с Dazing Blow, цель — NPC, бой запущен)

1. Взять противника в захват, нажать карточку «Dazing Blow», сделать Удар (попал) → у цели ровно одна карточка Fortitude-испытания; второй Удар — карточки нет.
2. Карточка → Удар промахнулся → карточки нет; следующий Удар без новой карточки — тоже нет.
3. Карточка → следующий ход (карточка до хода) → Удар → ничего. Вне боя — то же через 10+ минут.
4. Два токена-копии одного NPC (общий actor id, у каждой — «Stunning Strike»): карточка у копии A, Удар копии B → ничего; Удар копии A → карточка испытания.
5. Headshot: попадание после карточки — ничего, крит — испытание.
Консоль (проверка связи у ГМа): `game.messages.contents.slice(-6).map(m => [m.flags.pf2e?.origin?.actor, m.flags.pf2e?.context?.type, m.flags.pf2e?.context?.options?.includes("self:action:slug:strike")])`. Не держать вкладку ГМа под Gamemaster-игроком (память «вкладка ГМа двоит исполнение»).

## 7. Открытые вопросы

Слот «сотворение» (`spell-cast`) и навыки (`skill-check` после «Trip/Grapple»-подобных карточек) — в пачке 7 на той же функции; удалять ли метку ограничений переброса; нужен ли `type` в `tools/check-answer.mjs` (сейчас без типа конвертер не срабатывает).
