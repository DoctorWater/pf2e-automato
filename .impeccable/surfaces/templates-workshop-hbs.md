---
version: 1
slug: "templates-workshop-hbs"
primary_target: "templates/workshop.hbs"
related_targets: []
---

# Мастерская (workshop window)

Scope: GM-only Foundry window, three modes (Автоматизация, Эффект, Предмет). Visitor mode: Operate.
Audience/job: GM authoring automation, effects and custom items between or during sessions, next to the map.
Constraints: fits 900–1100 px wide; native pf2e look; ru/en; frequent edits must take seconds.
Status: interactive mockup on a Design canvas; implementation not started.

## Direction contract

THESIS: The rule is a pipeline you read top to bottom like a stat block; every step is a one-line sentence until you touch it. Refuses the MIDI-style wall of always-open fields and the next/next wizard for editing.

OWN-WORLD: pf2e item sheet vocabulary: parchment ground #f8f4f1, maroon #5e0000 for primary action and active tab, gold trait border #d8c384, divider #baa991, alternate brown #786452 for labels; Eczar/Georgia headings, Roboto Condensed small-caps labels, Roboto body; degree colors from pf2e (green, blue, orange, red) darkened for contrast.

STORY: GM opens an item, sees in one sentence what it does, nudges a value on a chip, watches the dry-run odds change, saves.

FIRST VIEWPORT: dark Foundry window header; sheet header with item name and trait tags; mode tabs; left 2/3 pipeline cards (collapsed sentences, Бросок and Исход open, 4 degree columns with condition chips carrying inline −/+); right 1/3 «Что произойдёт» with per-token degree-odds bars; footer with maroon «Сохранить в предмет».

FORM: extension of the pf2e sheet world (no concept roll: structure pinned in conversation); signature interaction = inline value stepper on chips + live odds bars. Seed key: none (extension).

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
