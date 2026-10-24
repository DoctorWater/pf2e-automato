# affliction: стадии недугов — яды, болезни, проклятия (план, код не написан)

Решение: **pf2e стадий не ведёт — ведёт модуль.** Одна форма «определение недуга + шаг `affliction`» поверх существующего: `challenge.byDegree` вешает стадию, носитель — свой документ (как у `repeat`), интервал стадии — тот же ход-хук, что у `runRepeats`, эффекты стадии — готовые `applyCondition`/`dealDamage`. Нового: определение `onUse.affliction`, шаг `affliction`, носитель-эффект со счётчиком стадий, часы стадии.

## 1. Что встречается (счёт по `tools/out/items.json` + `triage.json`; копии NPC схлопнуты по slug+имени)

Признак: `Stage 1` и `Stage 2` в `descEn` плюс (`Saving Throw`|`Maximum Duration`|`Onset`|трейт poison/disease/curse). Открыто (не pf2e/catalog/pa-port): **~560 уникальных документов**, с копиями NPC больше.

| пачка | документов | что это |
|---|---|---|
| 8 расходники (`b08`) | 135 | яды-consumable: «Activate 2; Saving Throw; Maximum Duration 6 rounds; Stage 1…3 (1 round)» |
| 9 NPC (`b09`) | 375 | способности: Ghoul Fever, Graveknight's Curse, яды жал/укусов |
| 1 долг (`b01`) | 41 (в drafts-accepted с меткой — 26) | заклинания (Purple Worm Sting, Goblin Pox), глоссарий семейств, 9 оружий/снаряжения |
| 6 / 4 / прочее | 4 / 3 / 4 | |

Трейты (уникальные): poison 381, disease 123, curse 41, **virulent 30**; с `Onset` 110, с `Maximum Duration` 398, с `Saving Throw` 539; без явной длительности стадии «(1 round)» — единицы (стадия без срока = конечная: «dies», «dead and rises»).

Структура текста (регулярная, разбирается детерминированным конвертером):
- шапка: `Saving Throw @Check[fortitude|dc:22]` (у NPC иногда `dc:` пустой — СЛ из текста), `Onset 1 hour`, `Maximum Duration 6 rounds`;
- `Stage N <эффекты> (<срок>)`, эффекты: `@Damage[1d10[poison]]`, `@UUID[…conditionitems…]{Sickened 2}`, `persistent bleed`, «as stage 2», «carrier with no ill effect», «dead / dies / rises as…»;
- старт по испытанию карточки: провал — стадия 1, крит. провал — стадия 2 (в тексте спелла: «afflicted … at stage 1 / stage 2»);
- интервал: срок стадии (`1 round`, `1 day`) → спасбросок по СЛ недуга: успех −1, крит. успех −2, провал +1, крит. провал +2; стадия 0 — излечен; `Maximum Duration` — конец; virulent (30): для −1 нужны два успеха подряд, крит. успех снижает лишь на 1; повторное воздействие того же недуга — новый спасбросок цели, провал повышает стадию (не создаёт второй недуг);
- «чистая» разметка: **72% строк стадий** (1280/1780) — только урон + состояния; **54% документов** целиком. Остальное — повествование («–10-foot status penalty to Speeds», «can't remove armor», «gains no benefit from healing», «rises as a ghoul»): **сюжетное не автоматизируем** — остаётся текстом стадии в карточке/описании эффекта; автоматизируем побочное (состояние, урон). Модификаторы-штрафы (`–10 ft Speeds`) — только если ложатся в `effect.mods` (inline-effect.mjs), иначе текст.

## 2. Что уже делает pf2e (проверено по `Data/systems/pf2e/pf2e.mjs`, 8.6.1)

- Тип предмета `affliction` **есть в схеме** (`template.json:211`, lang), класс `AfflictionPF2e` (`pf2e.mjs:48920`) с `stage/onset/stages[{conditions,damage,duration}]/save{type,value}`, `increase/decrease`, `rollRecovery`, `handleStageChange` (снимает старые linked-состояния, вешает новые, шлёт урон стадии), трейт virulent описан в lang.
- **Но конструктор безусловно бросает** `Affliction items are not available in production builds` (`:48922`) — в боевой сборке создать предмет нельзя; в паках 0 `effect` с «venom/poison/fever» в названии; яды — текстовые `consumable` без RuleElements (`ruleKeys: []`). `rollRecovery` в любом случае не знает крит. (±2) и virulent; бросок на конце интервала pf2e сам не запускает.
- Вывод: **«только вешать аффликцию» не получается** (нечего вешать). Берём у pf2e только модель и готовые куски: бейдж-счётчик стадии на `effect` (`system.badge`), состояния через `ConditionManager`, `DamagePF2e`/`dealDamage`, `grantedBy`/каскад снятия. Если когда-нибудь pf2e включит тип — носитель меняется на нём, схема правила остаётся (проверка при каждом обновлении pf2e: `new Item({type:"affliction"})` не бросает).

## 3. Форма в схеме (`plan.md` §1.1)

Определение — одно на правило, `onUse.affliction`; шаг — ссылка со стадией. Недугов на предмет больше одного — долг (`manual`).
```json
{"onUse":{"challenge":{"statistic":"fortitude","dc":{"value":22},"traits":["poison"],
   "byDegree":{"failure":[{"to":"target","affliction":{"stage":1}}],"criticalFailure":[{"to":"target","affliction":{"stage":2}}]}},
  "affliction":{"name":"Spider Venom","save":{"statistic":"fortitude","dc":22},"maxDuration":{"value":6,"unit":"rounds"},"onset":null,"virulent":false,
   "stages":[{"duration":{"value":1,"unit":"round"},"damage":[{"formula":"1d10","damageType":"poison"}],"conditions":[{"slug":"sickened","value":1}]},
             {"duration":{"value":1,"unit":"round"},"damage":[{"formula":"1d12","damageType":"poison"}],"conditions":[{"slug":"clumsy","value":1},{"slug":"sickened","value":2}]}],
   "text":["","…"]}}}
```
- `stages[i]`: `duration` (последняя без срока = конечная), `damage[]` (как шаг `damage`), `conditions[]` (как `condition` без `duration`), `text` — непонятая часть для показа. `save.dc` — число/`against` как у `challenge.dc` (снимок в носитель). Шаг `affliction:{stage}` — `to:"target"`, `stage` 1..N, по умолчанию 1; допустим в `onUse.apply` и в `byDegree`; повторное воздействие — тот же шаг на цели с живым носителем того же автора+предмета (`sameCarrier`, `repeat.mjs`): стадия растёт на `stage`, второго носителя нет.
- **Вывод из разметки:** `tools/affliction.mjs` по образцу `strike-gate.mjs` — парсер блока «Saving Throw…Stage N» → `affliction` + `challenge.byDegree`; низкая уверенность → `unsure` + `text`. В `deriveFromMarkup` (`rules.mjs`): детектор `afflictionStages(html)` → правило `low` «не вешается автоматически» (как `triggerSave`), чтобы сотни `markup-high` не тащили ложный «простой спасбросок».
- `rules.mjs`: `vAffliction`/`vApply` (шаг `affliction` ∈ `STEP_KINDS`, не вместе с `repeat/escape`), `tools/validate.mjs` — `stepsOf/semanticErrors` смотрят в `onUse.affliction`, ответ без `affliction` на тексте со `Stage N` — ошибка; `tools/prompts/draft-rule.md:63` — убрать «never null / unsure», дать пример выше и запрет на «простое испытание + condition».
- Мастерская/`sheet.mjs`: строка шага «Недуг: стадия N», редактор определения (список стадий: срок, урон, состояния; Мастер предмета создаёт недуг из текста); lang `affl.*`, ошибки `affliction.*`; README «Недуги»; `DENY` в `sheet.mjs:12` не трогать (это тип предмета pf2e, не наш).

## 4. Рантайм

- **Носитель:** pf2e `effect` (как `applyInlineEffect`/`effectSource`), `meta.affliction = {stage, dc, statistic, traits, def (снимок стадий), streak, nextAt, left, endsAt}`, бейдж-счётчик = стадия. Свой документ: в чужой `meta` не пишем; `sameCarrier` решает повтор. Снятие носителя каскадом убирает состояния стадии (`removeByKey(actor, "affl:<ключ>")`, как у `escape`). Иммунитет цели к трейту (`immuneToTraits`, `apply.mjs:445`) — до создания; `challenge.immunity` по успеху — как есть.
- **Смена стадии** (`setStage(actor, carrier, n)`): снять состояния прежней стадии → применить `conditions` новой через `applyCondition` (ключ `affl:<ключ>:<n>`, без срока, `max`-политика: уже есть выше — `skipped`, не чужое) → `dealDamage` урона стадии → карточка в чат с текстом стадии. `n ≤ 0` — удалить носитель; `n` за последней стадией — остаться на ней; `maxDuration` вышел — удалить. Идемпотентность — ключ `evId:uuid:affliction` как у `runRepeats`.
- **Часы стадии:** срок в раундах — счётчик `left` на конце хода цели (`pf2e.endTurn` → новый `runAfflictions(on, evId, actor)` рядом с `runRepeats`, `events.mjs:243`; та же защита от повторов `fired/remember`); срок в минутах и дольше, а также раунды вне боя (раунд = 6 с) — `nextAt` в мировом времени, проверка по `updateWorldTime` на активном ГМе (прецедент `zone.mjs:379`) и при `ready`/смене лидера. `Onset` — стадия 0 «в инкубации» (бейдж «Начало», без эффектов), затем стадия 1; `maxDuration` — `endsAt`.
- **Бросок:** тот же `hostChallenge` + `repeatChallenge`-образная карточка (`rollerRole:"target"`): бросает цель — PC кнопкой из карточки, NPC (в т.ч. несвязанный токен) — ГМ автоматом; отличие от `repeat` — степени не «снимают», а двигают стадию: крит. успех −2 (virulent −1), успех −1 (virulent: нужно `streak` 2), провал +1, крит. провал +2. Новый внутренний шаг `stageDelta` (как `removeKey`, `rules.mjs:89`) в `byDegree` карточки; всё остальное (СЛ-снимок в `meta`, автор мог пропасть → `owner:null`, актёр-снимок, откат через журнал) — переиспользуется.
- **Старт:** `challenge.byDegree` на карточке использования — штатно; несвязанные NPC-цели читаются с актёра токена, как у `repeat`. Яды-расходники пачки 8 — «Activate 2 / Strike with coated weapon»: шаг `affliction` вешается из `onEvent.afterUse` (уже есть) — этот план даёт только сам недуг, не нанесение яда на оружие.
- Не делаем: лечение недуга внешним эффектом («counteract»: Neutralize Poison, Remove Disease) — отдельным шагом позже (`removeEffect` по носителю уже работает на пересечении по slug); распространение болезни между существами; кумулятивные «−1 СЛ».

## 5. Тесты

- node (`tests/affliction.test.mjs`): `stageDelta(degree, virulent, streak)` (все 4 степени, virulent, крит. успех); `setStage` границы (0, максимум, `maxDuration`); парсер `tools/affliction.mjs` на 12 реальных текстах (Spider Venom, Giant Centipede Venom, Purple Worm Venom, Ghoul Fever, Graveknight's Curse, Goblin Pox, Blightburn, текст «as stage 2», «dead»); `vAffliction` валидное/ошибки; `ruleToForm↔formToRule`; `sameCarrier` для повторного воздействия; часы: `left`/`nextAt` (раунды в бою/вне, `Onset`); `afflictionStages(html)` положительные/отрицательные (Frightful Aura — не недуг).
- живое `tests/live/affliction.js` (копия структуры `repeat-save.js`: `window.__afAffliction = {only, skip, cleanOnly}`, d20 подменой, сцена/актёры «AF тест»): `start` — яд-расходник на NPC, провал → стадия 1 и состояние/урон, крит. провал → стадия 2; `tick` — конец хода цели, успех → стадия 0, носитель снят вместе с состоянием; `fail-up` — провал повышает, `max` держится на последней; `virulent` — два успеха; `again` — повторное воздействие повышает стадию без второго носителя; `onset` — «Начало» без эффектов, ход мирового времени; `unlinked` — две копии NPC не мешают; `author-gone` — автор удалён, интервал идёт.

## 6. Открытые вопросы к пользователю

1. **Когда считается шаг раундового интервала:** конец хода цели (проще, как `repeat` и постоянный урон) или инициатива автора недуга (как задумано в коде pf2e, `start.initiative`)? Рекомендую конец хода цели.
2. **Шаг пачки 8 до или после пачки 9:** примитив самодостаточен; порядок только влияет на то, что идёт первым в живой проверке (NPC-способности — 375 против 135 ядов).
3. Часть стадий («штраф к Скорости −10») без `effect.mods` остаётся текстом — устроит ли, или делать для них отдельный generic-модификатор в стадии (удвоит объём работ в Мастерской)?
