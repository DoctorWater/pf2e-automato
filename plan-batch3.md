# План пачки 3 (b03-attack-check) — подготовка внесена (не закоммичена), пилот 15 проверен

Снимок `tools/out/triage.json` (21:06): в b03 223 manual (P1 122, P2 83, P4 18). coverage.md говорит 231/123 — расхождение из-за незакоммиченных правок. Вход P1 собран (`haiku-input.mjs b03-attack-check --p 1`): 4 файла, 121 документ (Boomerang Shot уже принят). Копия входов лежит в scratchpad `b03in/`.
Скрипт стёр `tools/out/haiku` — b02-файлы восстановлены из копии.

## Группы P1 (оценка по тексту и меткам, ±5)
| Группа | Размер | Способ |
|---|---|---|
| Атака заклинанием (`check` spell-attack + `roll:"system"`): состояние/штраф/толчок по степеням | ~26 спеллов | промпт (правило есть: пример + строка в rules of thumb) |
| Спелл без ответа в правиле: только урон (Spiritual Armament, Biting Words, Fire Ray, Rend Magic…) | ~8 | null; кандидаты в отсев |
| Навык/лор/Восприятие автора против КС цели -> состояние по степеням (+иммунитет): Grim Swagger, Disturbing Knowledge, Evangelize, Flower Street Infamy, Perplex, Fabricate Truth, Bestial Snarling, Divine Disharmony, Reveal Machinations, Peony's Flourish, Mythic Containment, DYKWIA | ~14 | промпт, правило есть (примеры 5, 28) |
| Манёвры Athletics/Acrobatics/Performance против защиты с падением, подтягиванием, Шагом: Log Roll, Lassoing Lash, Leading Dance, Riptide, Explosive Death Drop, Death from Above, Whirling Knockdown, Daring Act, Vexing Tumble, Barreling Charge | ~12 | частично промпт (prone), остальное unsure (forced-movement-other, trample) |
| Проверка после Удара (Unseat, Reel 'Em In, Dazzling Bullet, Devastating Duelist) | ~4 | долг: `strike-gate` для check (порог не набран) |
| Импульс/deviant-атака (Magnetic Pinions, Whirling Grindstone, Elemental Artillery, Molten Wire, Rotten Slurry, Ghostly Grasp) | 6 | `check.statistic` не знает impulse/deviant (CHECK_STATS в validate.mjs); долг, примитив не нужен (<30) |
| Только флэт-проверка / тайный лор / информация / воскрешение / контрсила (Anchor Stance, Flashforge, Augury, Glean Lore, Resuscitate, Cursebreaker…) | ~35 | ОТСЕВ в triage: если все `@Check` — flat или secret, а условий/эффектов нет; counteract — отдельный ключ |
| Спеллы с навыковой проверкой-приложением к террейну (Pillar of Water, Sliding Blocks, Pillars of Sand, Steel Fortifications, Wind Jump, Flashy Disappearance) | ~6 | отсев (terrain/climb DC) |
| Удар + добавка (Dispelling Slice, Exsanguinate, Magical Onslaught, Lesson of Mutual Gambits, Ruthless Orator) | ~5 | unsure (`passive-hit-trigger`, `mods-target`) |

P2 (83): ~23 flat-only, ~23 «навык против защиты» (в основном NPC-способности вампиров, Grab/Drink Blood), снаряжение. P4 (18): кампейн, отсеять.

## Внесено (2026-10-27)
- Промпт: `check.statistic` массивом, `check.immunity` в схеме CHECK, off-guard «to your attacks» = обычный off-guard, persistent на крит. попадании по рангу, штраф Скорости по степеням, примеры 30-32 (Grim Swagger, Scorching Blast, Snowball — из документов пачки). Формула в примере 31 — `1d6+(2*(@item.rank-1))`: резолвер считает только группы в скобках, `(@item.rank-1)*2` валидатор не принимает.
- Словарь: ключи `impulse-attack`, `spell-attack-save` (rules/mechanisms.json + промпт). impulse/deviant в `check.statistic` НЕ расширяем — долг.
- Сторож checkAnswer: spell-attack против fortitude/reflex/will (defense или against) — ошибка, ответ unsure `spell-attack-save`; тест в model-errors.
- Триаж: `skip: flat-secret-check` **для всех пачек** (по разбору Критика: признак не должен зависеть от пачки), если все @Check flat или traits:secret без defense:/against:, нет defense в шапке и нет ссылок/@Cond на состояния; drafts-accepted не трогает. Текстовые сторожа: механика (бонус, штраф, сопротивление, урон, лечение, ОЗ, Скорость, КБ), недуг (`Stage 1/2`, спасбросок), сдвиг исхода атаки, ворота flat-проверки перед сотворением/концентрацией/речью/телепортацией/нацеливанием (долг `flat-check-gate`). Итог — 19 документов по всем пачкам. Среди 31 есть спорные (Moisture Bath, Silence Heresy, Resilient Physiology, Vexing Vapor — есть эффект кроме flat), но выражаемой автоматизации у них нет.

## Результат пилота (pilot3.json в scratchpad, 15 документов, `check-answer.mjs`)
accepted 8, null 1 (Anchor Stance), unsure 6, ошибок чекера 0; догадки unsure с правилом (3) проходят чекер.
- Принято: Grim Swagger, Divine Disharmony, Scorching Blast, Camel Spit, Moonbeam, Snowball, Log Roll, Disturbing Knowledge. Часть — дословные копии примеров 30-32 (проверяют только копирование, не понимание).
- Unsure: Drink Blood (`temp-hp`), Murderous Vine (`spell-attack-save`), Rotten Slurry (`impulse-attack`), Devastating Duelist (`strike-gate`), Glacial Skewer, Peony's Flourish.
- Где промпт неоднозначен: (1) Glacial Skewer — состояние «если толкнули в препятствие» в тексте результата: нет ключа (взят `mods-conditional`; возможно, `event-trigger` или отдельный); (2) Peony's Flourish — «dazzled, пока оглушён» (взят `condition-link`); (3) Drink Blood — «автоуспех при других состояниях» не выражается, модуль всё равно бросает проверку; (4) расходящиеся ответы на «Attempt X or Y» без Will/defense в @Check (Grim Swagger: defense берётся из «Will DCs» текста, не из разметки).

## Риски
- Закоммиченные b03-принятые 22 записи (в основном конвертер активаций) — новые ответы не должны их перетирать.
- Атаки заклинанием: рантайм берёт степень из броска pf2e; для сложных (условный иммобилайз, толчок) нужен unsure.

## Порядок волн
**Статус (2026-10-27): P1 (116) и P2 (81) пройдены Sonnet, Критик по каждому, приняты — b03 6,6% → ~30%. Промпт дополнен по разборам (группы A–E, Create a Diversion, push 5, check-auto-unless, пример 31 → Live Wire). Входы и пилот — во временной папке сессии, в репозиторий не входят. Осталось: P4 (18), выборка 50 по ROADMAP §10, живые проверки (Propelled Leap, Diadem of Divine Radiance, воскрешение, руна Immovable), кандидат-примитив `check.when` (46–51 документ).**

1. Подготовка — сделана.
2. Пилот 15 — пройден.
3. Волны P1, P2 — пройдены.
4. P4 — после.
