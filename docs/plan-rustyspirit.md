# План: герои мира RustySpirit (Дракончик — кинетик огня 1, Марена — ведьма Горечи 1, фамильяр Еся)

Статус: **реализовано 2026-11-06 (P1–P4), живой прогон `tests/live/rustyspirit.js` 10/10 в мире RustySpirit.** WF11: эффекты под Поддержанием (`duration.sustained` и обёртки `meta.sustainOf`) — не кандидаты. `ruleFor`: контекст предмета — только у заклинаний, и берётся только правило с `roll:"system"`. Аура гаснет и при `unconscious` (сделано). Опора: `docs/plan-familiar.md`, `docs/plan-sustain.md`, `scripts/apply.mjs` (`extendEffect` ~294, `choose` ~603, `createTimed` ~88), `scripts/events.mjs` (`eventOfMessage` 30, `strikeCardFor` 51), `scripts/use.mjs` (`useKindOf` 33), `scripts/zone.mjs` (`attachZone`, триггеры), `rules/catalog.json`.
Снимок героев: актёры мира `rustyspirit` (LevelDB), предметы прогнаны через `resolveRule` со всеми каталогами.

## 0. Инвентаризация (итог)

| Герой / предмет | Сейчас | Решение |
|---|---|---|
| Марена: Evil Eye, Grim Tendrils, Phase Familiar, Figment | каталог | проверить вживую на копии (P5) |
| Марена: Slashing Gust | нет записи; крит → 1d4 продолжительного кровотечения есть только инлайн-кнопкой, в `system.damage` его нет | **P4**: запись |
| Марена: Dream May, Pet, Pickpocket, Telekinetic Projectile, Ghost Sound, Prestidigitation, Summon Undead, City of Sin, оружие | RE системы / нечего автоматизировать | — |
| Еся: Familiar of Ongoing Misery (WF11) | нет записи; был SOURCE-BLOCKED | **P1**. Блокер снят: английский текст Player Core в паке `familiar-abilities` (`mu9OL8v4rmr9311e`): «prolonging **one** negative condition of your choice … only once to a given case of a condition … only conditions with a timed duration». Русское «всех состояний» — ошибка перевода |
| Еся: Augury, Amphibious, Speech | нечего автоматизировать | — |
| Дракончик: все overflow-импульсы (Scorching Column) | аура не гаснет: pf2e пишет правило только в описании | **P2** |
| Дракончик: Scorching Column | разметка high: область + базовый Рефлекс против КС кинетика | **P3**: опасная местность |
| Дракончик: Flying Flame | разметка high: выбранные цели + базовый Рефлекс | ок |
| Дракончик: Eternal Torch | каталог: эффект на себя | ок, проверить (P5) |
| Дракончик: Channel Elements | `selfEffect` Effect: Kinetic Aura — система | ок |
| Дракончик: Elemental Blast, House Drake, Covet Hoard, Big Sharp Teeth | RE системы | — |
| Дракончик: Wings (без урона от падения) | урон от падения pf2e не считает | нечего |

Долг (не в этом плане): Dream May — снижение drained/doomed на 2 при отдыхе; поддержание Scorching Column не продлевает зону (см. P3).

## P1. WF11 Familiar of Ongoing Misery — выбор состояния с конечным сроком и продление

Запись (`rules/catalog.json`, bySource `Compendium.pf2e.familiar-abilities.Item.mu9OL8v4rmr9311e`):
```json
{"v":1,"label":"Familiar of Ongoing Misery","onEvent":[{"on":["spell-cast","spell-sustain"],"side":"familiar","when":["origin:item:trait:hex"],
 "apply":[{"choose":{"from":"creatures","range":15}},
          {"choose":{"from":"conditions"}},
          {"to":"chosen","extendEffect":{"chosen":true,"rounds":1}}]}]}
```
Новое:
1. **`choose.from:"conditions"`** — только после шага выбора существа; кандидаты — эффекты на `picks.actor` с конечным сроком (`duration.unit` из `ROUNDS_IN`, `value >= 0`), которые **выдали негативное состояние**: у актёра есть condition с `grantedBy?.id === effect.id` (так выглядят и обёртка `createTimed` модуля, и системные эффекты с GrantItem). Позитивные не берём: `quickened`, `concealed`, `hidden`, `invisible`, `undetected`, `unnoticed`, `observed`. Не берём уже продлённые этим механизмом (флаг из п.2). Подпись: имена состояний (со значением) + остаток срока. Кандидат один — без окна; нет кандидатов — молча (способность фамильяра). Значение выбора — uuid эффекта.
2. **`extendEffect.chosen:true`** — продлить эффект, выбранный шагом `from:"conditions"`, на `rounds`; ставит флаг `flags.<MOD>.prolonged = true` («один раз на экземпляр»), откат снимает флаг и возвращает срок (как сейчас `bumped`). Валидатор: ровно одно из `slug` / `cast` / `chosen`; `chosen` — только при наличии предыдущего `choose.from:"conditions"` в том же списке.
3. Подсказка листа/чата (`sheet.mjs`, `chat.mjs`) для нового вида — минимально, по образцу `cast`.

Негатив: бессрочное состояние (frightened без обёртки) — не кандидат; эффект уже продлён — не кандидат; позитивное — не кандидат; закрытое окно — ничего; законное снятие состояния не блокируем (срок только продлевается).
Порог: 1 документ, ниже ~30 — решение пользователя 2026-11-06 «делать».

## P2. Overflow гасит кинетическую ауру — событие `action-use`

Группа: 48 документов с чертой `overflow` (`tools/out/items.json`), выше порога.
1. **`EVENT_ON` += `"action-use"`**: `eventOfMessage` отдаёт его для карточки использования `action`/`feat` (`useKindOf === "use"`, `origin.type` ∈ action/feat). Расходники и заклинания — не это событие.
2. Запись на классовой черте Kinetic Aura (`Compendium.pf2e.classfeatures.Item.f0BF2210l9k66cso`, есть у каждого кинетика):
```json
{"v":1,"label":"Kinetic Aura","onEvent":[{"on":"action-use","side":"self","when":["origin:item:trait:overflow"],"apply":[{"to":"self","removeEffect":{"slug":"effect-kinetic-aura"}}]}]}
```
**Подводные камни:** аудит всех потребителей `eventOfMessage` (`strikeCardFor`, afterUse/strike-gate, `matchEntries`, журнал событий, реакции): раньше для карточек action/feat было `null`, теперь событие — ничего не должно сработать «по ошибке» (например, strike-gate обрывает связь на «броске того же вида»). Проверить, что `origin:item:trait:overflow` есть в опциях карточки feat (`flags.pf2e.origin.rollOptions`). Дедуп — штатный (`fired`, один ГМ).

## P3. Scorching Column — опасная местность

Запись bySource `Compendium.pf2e.feats-srd.Item.XqtJVBwnxBsSo9Py`: голова как у разметки (`targets:"area"`, базовый Рефлекс, `dc:{against:"kineticist"}`, `options:["area-effect"]`) + `zone.triggers:[{on:"enter", apply:[{to:"target", damage:{formula:"2*floor((@actor.level-1)/3)+1", damageType:"fire"}}]}]`.
Срок зоны: «до конца вашего следующего хода, Поддержание до 1 минуты» — продление зоны Поддержанием не умеем (`plan-sustain.md` §3). Решение: **зона без срока, закрывает ГМ/игрок** (как прочие ручные зоны) + `note` автору «зона живёт, пока импульс поддерживается; закройте её, когда перестанете». Проверить, что `@actor.level` считается в формуле урона триггера зоны; иначе — `@item.level`-эквивалент. «Каждую клетку» упрощаем до «вход в зону» (`ponytail:` в заметке плана, не в коде).

## P4. Slashing Gust — продолжительное кровотечение при крите

Запись bySource `Compendium.pf2e.spells-srd.Item.1Yoipc5jNcMehtEW` по образцу Blood Feast (`catalog.model.json`): `check:{statistic:"spell-attack", vs:{defense:"ac"}, roll:"system", byDegree:{criticalSuccess:[{to:"target", persistent:{formula:"(@item.rank)d4", damageType:"bleed"}}]}}`, `targets:"selected"` (1–2 цели, у каждой свой бросок).

## P5. Живой прогон (мир RustySpirit, копии «AF тест: …»)

`tests/live/rustyspirit.js`, по образцу `tests/live/level1-*.js`: P1 (Марена-копия + фамильяр-копия, Evil Eye → у цели sickened с обёрткой срока? нет — Evil Eye без срока; взять состояние со сроком, напр. обёртку `frightened` через `applyCondition` с duration, затем cast hex → выбор → +1 раунд; повтор — уже не кандидат), P2 (копия Дракончика: Channel Elements → эффект ауры; Scorching Column → эффекта нет), P3 (вход токена в зону → 1 огнём), P4 (подкрученный крит → продолжительное кровотечение 1d4), регресс: Evil Eye, Grim Tendrils, Eternal Torch, Figment. Тестовая сцена создаётся и удаляется сценарием (в мире нет сцен).
**В мире модуль выключен** — до прогона пользователь включает `socketlib`, `lib-wrapper`, `pf2e-automato`.

## Тесты
Юнит: валидатор (`choose conditions`, `extendEffect.chosen`, `action-use`), подбор кандидатов P1 (чистая функция), `eventOfMessage` для карточки feat/action/spell/consumable, записи P1–P4 проходят `validateRule` и `buildCatalog`.

## v2 — правки по Критику (2026-11-06), перебивают текст выше

- **P1:**
  - выбор эффекта хранится отдельно: `picks.effect`, операция `{op:"chose", key, effect:uuid}`, ветка в `picksFromOps` (`apply.mjs`); проверка у фамильяра (`events.mjs`) обрывает запись и при пустом `picks.effect` после шага `from:"conditions"`;
  - шаг `creatures`, за которым идёт `conditions`, предлагает **только существ, у которых есть хотя бы один кандидат**: пусто — молчим, один эффект — без окна;
  - кандидаты: `!e.isExpired`, без обёртки «шок на срок» (`stunned` без значения);
  - валидатор: `conditions` идёт только после выбора существа и без `range`/`where`/`withSelf`/`of`; шаг `conditions` сам не считается выбором существа (`rules.mjs:362`); `extendEffect.chosen` — только `to:"chosen"`, ровно одно из `slug`/`cast`/`chosen`;
  - Мастерская: обратное преобразование в `sheet.mjs:69/132` (тест `tests/sheet.test.mjs` гоняет все правила `catalog.json` по кругу), текст в `workshop/automation.mjs:296`, `CHOOSE_FROM` в `workshop/automation.mjs:234`, ключи `apply.prompt.conditions` и `workshop.au.chs.conditions` в en/ru (существующие lang-файлы).
- **P2 — без нового события.** Встроенный обработчик по образцу `scripts/builtin/rage.mjs`:
  - на `createChatMessage` у активного ГМа: карточка использования (включая `self-effect`, как у Lava Leap) предмета с чертой `overflow` снимает у автора эффект `effect-kinetic-aura`;
  - то же при появлении `unconscious`;
  - работает и для NPC-кинетиков;
  - дубль сообщения, когда инлайн-проверку отправляют в чат, обработчик не должен считать вторым использованием — снять уже снятое безвредно.

  `EVENT_ON` не трогаем.
- **P3:**
  - формула `(2*floor((@actor.level-1)/3)+1)` целиком в скобках;
  - зона `duration:{rounds:2}` и заметка автору: при Поддержании ГМ продлевает зону (поле «Осталось раундов» поведения региона) или закрывает её; импульс повторно не используют.
- **P4 — корень:** `ruleFor` в `scripts/actions.mjs:~99` ищет правило броска `roll:"system"` только по slug, поэтому записи `bySource` недостижимы. Это касается 15 атак заклинанием из `catalog.model.json`, включая Blood Feast. Исправить поиск: передавать источник (uuid предмета или `compendiumSource` из origin сообщения). Если это невозможно — дублировать в `bySlug`. Запись Slashing Gust кладём в `bySource`.
- **Формат:** в `catalog.json` одна запись на строку.
- **Тесты:** `tests/events.test.mjs:139` не меняется, потому что событие не вводим.

## Дополнение 2026-11-06

- Ограничения импульсов (`scripts/builtin/impulse-gate.mjs`): импульс без кинетической ауры и второй импульс с переполнением за раунд (описание черты overflow: «per round») — карточки нет, предупреждение, Alt — обход. Атаку Стихийным взрывом без ауры pf2e блокирует сам. Пока эффект ауры не наложен кнопкой, ауру даёт свежая карточка «Проведение стихийной энергии» (Channel Elements) (10 последних сообщений).
- Кнопка «Урон» (`scripts/damage-button.mjs`): на карточке использования без системной кнопки урона — кнопка на каждую инлайн-формулу @Damage (одна — «Урон», несколько — «Урон: 1d8 огонь»), под блоком спасбросков модуля. Формулы, которые наносит само правило (шаги damage, триггеры зоны — у колонны урон опасной местности), кнопки не получают. Чистый продолжительный урон — кнопка «Наложить продолжительный урон»: состояние целям (испытания → снимка → нажавшего); если абзац помечен степенью («Провал …»), только целям с этим итогом, без итога — «ещё нет спасброска»; одна формула в нескольких абзацах — все их степени. Повтор не дублирует (ключ meta).
- Живая проверка: блок без ауры, проход после «Проведение стихийной энергии», кнопки и связь урона с карточкой, блок после переполнения, второй раз в раунде — блок, следующий раунд — можно.
