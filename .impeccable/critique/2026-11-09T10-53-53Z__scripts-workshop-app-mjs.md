---
target: Мастерская (workshop window)
total_score: 21
max_score: 40
na_heuristics: 
p0_count: 0
p1_count: 3
target_identity: "file:D:\\ClaudeFun\\pf2e-automato\\scripts\\workshop\\app.mjs"
target_fingerprint: "sha256:5a1c5965cb22e1e120c0671b5ef90845a79bf8e2c42a5fa45edcf364a624fe06"
target_path: "D:\\ClaudeFun\\pf2e-automato\\scripts\\workshop\\app.mjs"
timestamp: 2026-11-09T10-53-53Z
slug: scripts-workshop-app-mjs
---
# Critique: Мастерская (pf2e-automato), 2026-11-09
Method: dual-agent (A: design review по 9 живым скриншотам + исходникам · B: detect CLI + оверлей в живой вкладке Foundry)

Health 21/40 (Acceptable). 1:2 2:2 3:2 4:2 5:2 6:2 7:2 8:2 9:2 10:3.

Priority issues:
- [P1] «Принять распознанное» — бордовая основная кнопка при любом источнике кроме флага (app.mjs:832 canAccept), подпись неправдива для каталога, молча затирает черновик (app.mjs:364 без проверки dirty). Две основные кнопки на экране.
- [P1] Клавиатура: #redraw сбрасывает фокус после каждого клика; Esc не закрывает .ws-pick / .ws-menu; поиск в «Добавить» без автофокуса.
- [P1] Колонки степеней: заметки ломаются по слогам (workshop.css .ws-plate-n hyphens:auto, жёсткий repeat(4)); на 900 px хуже.
- [P2] «Бросок»: 9 полей сразу, слаги reflex/kineticist, «Значение СЛ» 64 px обрезает kineticist, предикаты/roll options без «Дополнительно».
- [P2] Тексты доверия: «Правило не записано в предмет» при действующем каталоге; английский label каталога в сводке «Когда» (automation.mjs:373, нарушает CLAUDE.md §2.2); «Spell Effect: Evil Eye (Floor)»; «Для всех с этим slug» без числа предметов и подтверждения; сырая формула 2*floor((ур.-1)/3)+1.

Detector: CLI 0 находок (14 hbs + 5 mjs). Браузер: плейсхолдеры 3.2–3.4:1, tight-leading .ws-note/.ws-sub (1.25), −/+ 22×28, × у черт 16×20, all-caps «Или скопировать основу из компендиума». Ложные: text-occlusion в закрытом details, nested-cards, clipped .ws-sr.

Minor: «Состояние: ?» в сводке эффекта; «Исход: ничего не применяется» при заполненном «Сразу»; «Одноразовый» 5 раз на шаге 1; дубли .ws-pill/.ws-ok в CSS; hex вне палитры (#a01818, #1d5a1d, #8c4a00, #54166e); корзина vs крестик; RULE ELEMENTS / Доп. roll options.

Questions: вкладки с тремя субъектами — вкладки ли это; шансы пробного запуска в заголовках колонок; нужна ли громкость «Сохранить в предмет» при работающем каталоге; место предикатов/roll options в быстром пути.
