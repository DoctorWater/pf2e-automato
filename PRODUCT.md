# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users
Game Masters running Pathfinder 2e in Foundry VTT v14 with the pf2e system. Only the GM uses the authoring UI; players see the results (chat blocks, applied conditions, reaction prompts). First user is the author's own campaign (TheGreatRoute, Russian-speaking table); the module is intended for public release to other GMs.

## Product Purpose
PF2e AuTOMATO automates what happens when an item, spell or action is used: zones (regions with live state), target saving throws, conditions and effects applied by degree of success, reaction prompts, phase macros. Success: a GM turns a custom or existing item into working automation without writing JSON or macros, and trusts what it will do before running it at the table.

## Positioning
Rules are a declarative JSON contract (use → targets → roll → per-degree outcomes → zone/macros) with markup recognition from item descriptions and a read-only dry run on selected tokens. Works without pf2e-automations and yields to it where it already covers an item.

## Operating Context
Used between and during sessions inside the Foundry window next to the map; authoring windows must fit roughly 900–1100 px wide. Works alongside the native pf2e item and effect sheets, which remain the place for fine edits; drag-and-drop of conditions, effects and macros from compendia is the expected way to reference documents.

## Capabilities and Constraints
- Existing: item-sheet tab "Автоматизация" (flag on item / world catalog by source or slug), recognition from description markup (low confidence = manual apply), dry run report.
- Planned: "Мастерская" window with three modes — effect builder (blocks → pf2e Rule Elements), custom item wizard (base from compendium → general fields → what it does → automation), automation editor as a card pipeline with 4-column degree outcomes and a live dry run.
- GM only. Spells creation is out of scope for now (copy an existing spell instead).
- Bilingual ru/en; every string goes through lang files.

## Brand Commitments
Must look like a native part of the pf2e system UI, not a separate product skin.

## Product Principles
- Frequent edits take seconds: changing one value never requires walking through steps again.
- Show the result before saving: a readable summary and a dry run accompany every edit.
- Never duplicate what pf2e sheets already do; build the fast path and hand off to the native sheet.
- No wall of fields: reveal detail only for the step being edited.
