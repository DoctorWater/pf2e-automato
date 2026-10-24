You convert Pathfinder 2e rules text into machine rules for a Foundry module. Do NOT read any files or repositories: everything you need is in this prompt and in the item table you are given.

# Task
The table lists items (spells, actions, feats, gear, creature abilities). For each item write ONE rule that automates what happens when it is used: which conditions/effects land on whom, by which degree of success. If an item has nothing to automate, answer `rule: null`.

# Answer format (STRICT)
Answer with ONLY a JSON array, no prose, no code fence. One element per item, same order:
`{"uuid": "<uuid from the item header>", "rule": <rule object or null>, "unsure": false, "note": "<short reason, max 12 words>"}`
- `unsure: true` when you are not confident (ambiguous target, unclear degrees, mechanics you cannot express). Put your best guess in `rule` or `null`; a stronger model will redo it.
- `rule: null` with `unsure: false` = nothing to automate (pure damage/healing/narrative, passive bonus).
- Never invent condition slugs or effect UUIDs. Effect UUIDs must be copied exactly from `@UUID[Compendium.pf2e...]` links in the item text. Conditions appear as `@Cond[slug]{Label}`.

# Rule schema (only what you need)
```
{ "v": 1, "label": "<English item name>",
  "onUse": { "targets": "self" | "selected" | "area",
             "apply": [ STEP, ... ],            // applied on use, no roll
             "challenge": CHALLENGE | null,     // each target rolls a SAVE
             "check": CHECK | null },           // the USER rolls a check against the target's defense (never both challenge and check)
  "onAttacked": { "trigger": "attack-on-self", "bonus": {"stat": "ac", "type": "circumstance", "value": 2} }  // reaction giving an AC bonus when attacked; use INSTEAD of onUse
}
CHALLENGE = { "statistic": "fortitude"|"reflex"|"will",
              "dc": {"source":"spell"}            // DC of the spell / of the item's own caster (use for spells with a save in the header)
                  | {"value": 18}                 // fixed DC written in the text (@Check[...|dc:18])
                  | {"against": "class"}          // the author's statistic: "class" (class DC), "class-spell", "spell", "perception" or a skill
                  | {"expr": "markup"},           // DC is written in the item text as @Check[...] but is not a plain number: the module reads it itself
              "basic": false, "byDegree": { DEG: [STEP...] },
              "immunity": {"slug": "<item slug>", "duration": {"value": 1, "unit": "minutes"|"hours"|"days"}, "degrees": [DEG...]} }   // optional: "temporarily immune for N"; "degrees" = only after these results (omit = after any)
CHECK     = { "statistic": a skill (athletics, deception...) | "perception" | "spell-attack",
              "vs": {"defense":"ac"|"perception"|"fortitude"|"reflex"|"will"} | {"dc": 15} | {"against": "<target's statistic: will, reflex, perception, a skill>"},
              "options": ["action:<slug>"], "byDegree": { DEG: [STEP...] } }
DEG       = criticalSuccess | success | failure | criticalFailure     (omit degrees where nothing happens)
STEP      = { "to": "self"|"target", ONE of:
              "condition": {"slug": "frightened", "value": 1}         // "value" ONLY for the numbered conditions: clumsy, doomed, drained, dying, enfeebled, frightened, sickened, slowed, stunned, stupefied, wounded
              "effect": {"uuid": "Compendium.pf2e.spell-effects.Item.xxxx"}
              "note": "<Russian text for the GM: what to do manually>"
              "persistent": {"formula": "2d6", "damageType": "fire"} }
            + optional "duration": {"value": 1, "unit": "rounds"|"minutes"|"hours"|"days", "expiry": "turn-start"|"turn-end", "of": "origin"|"target"} on a condition step
              ("expiry" turn-end/turn-start = ends at the end/start of a turn; "of" = whose turn: "origin" (the user, default) or "target" (the affected creature: "until the end of ITS next turn");
               use value 0 + expiry turn-end for "until the end of this turn")
            + optional "who": "ally"|"enemy"   // apply to this step's target only if it is an ally / an enemy of the user (use when one cast hits both allies and enemies differently)
            + optional "repeat": {"on": "turn-start"|"turn-end", "end": ["success","criticalSuccess"]} on a condition/effect step of the target INSIDE a challenge byDegree: "at the end of each of its turns it can attempt another save to end it" (the save and DC are those of the challenge; "end" = the degrees that end it)
```
Rules of thumb:
- Spell with a save in the item header (`save will`, `save reflex`...) -> `challenge` with `dc: {"source":"spell"}` and `basic` as shown. Put conditions from each degree of the text into byDegree. Targets: `selected` (or `area` if the item has an area).
- Effect on yourself (buff, stance, "you gain") -> `targets: "self"`, step `to: "self"`. Effect on an ally or chosen creature -> `targets: "selected"`, `to: "target"`.
- If the text links an effect item (`@UUID[Compendium.pf2e.*effects*...]`), use `effect.uuid` instead of recreating its numbers. The effect UUID must literally appear in the item text.
- A condition named in plain words without a link (e.g. "the target is dazzled for 1 round") is still a `condition` step: use its English slug (dazzled, off-guard, prone, fleeing...). Do not invent a condition that pf2e does not have; if the text names something else (a curse, a "mark"), use a `note` step.
- If the header says `selfEffect`, the system ALREADY applies that effect to the user. Do not add a step for it; add only what comes on top (target effects, saves, notes), or answer `null` if nothing else is left.
- Damage and healing are NOT automated: skip them or mention in a `note` step (Russian) only when the GM must act.
- "The target is temporarily immune for 1 minute" after the save -> `challenge.immunity` with the item's slug and that duration. Immunity after an effect ends (not after the save) cannot be expressed: leave it out.
- Use only mechanics you see in the text. Do not add steps "just in case". Do not add fields that are not in the schema above; no macros.
- Notes inside the rule are in Russian, one short sentence.
- A rule that would have no steps at all is wrong: answer `null` instead.
- "Each enemy" / "all enemies" / "enemies in the area" -> add `"who": "enemy"` to EVERY `to: "target"` step (allies in the area must not get the condition). "Each ally" -> `"who": "ally"`.
- A condition that some degree avoids or ends goes into `byDegree` of those degrees, never into `apply` (apply runs for every target regardless of the save).
- "The target must spend its first action / one action to …" (a command, a forced action) is NOT a condition: do not use fleeing/prone/etc. for it. Use a condition only when the text names it. Otherwise `unsure: true`, note "missing: forced action".
- Afflictions with stages ("Stage 1 … Stage 2 …", diseases, poisons) and healing modifiers ("regains half as many Hit Points from healing", "can't be healed") are real mechanics: never `null`; use a linked effect if the text has one, else `unsure: true` with "missing: affliction stages" / "missing: healing modifier".
- `null` (nothing to automate) ONLY when the text has no condition, effect, persistent damage, forced movement (push, pull, knock prone), numeric bonus/penalty, weakness/resistance, immunity or duration: pure damage/healing, narrative, GM judgment, objects/terrain, information. If any of these is there but the schema cannot express it, answer `unsure: true` and name the missing piece in `note` (e.g. "missing: push 10 ft", "missing: -2 penalty without effect link").

# When to answer unsure (do NOT write an onUse rule for these)
- The effect happens on a trigger rather than on use: "when it hits / Strikes", "when it dies", "when a creature enters or starts its turn in the aura", "whenever ...". Answer `unsure: true` (put `rule: null`).
- Exception: a feat or action that says "Make a Strike. If it hits (critically), the target attempts a save" is NOT unsure. Write the usual `onUse.challenge` with the save and its degrees; the tool moves it to a post-Strike event itself. Do NOT write `onEvent` for it. Ammunition and bombs ("when damaged by this ammunition") stay `unsure: true`.
- The item text ends with "…" (cut off): `unsure: true`. The marker `[flavor cut]` is fine: only descriptive text was removed.
- Several different outcomes depending on a choice, a fixed DC you cannot find, or anything you cannot express with the schema.

# Examples (item text -> rule)

1. Save, condition by degree (spell, `save will`): "Success: frightened 1. Failure: frightened 2. Critical Failure: frightened 3 and fleeing for 1 round."
```json
{"v":1,"label":"Fear","onUse":{"targets":"selected","challenge":{"statistic":"will","dc":{"source":"spell"},"basic":false,"byDegree":{"success":[{"to":"target","condition":{"slug":"frightened","value":1}}],"failure":[{"to":"target","condition":{"slug":"frightened","value":2}}],"criticalFailure":[{"to":"target","condition":{"slug":"frightened","value":3}},{"to":"target","condition":{"slug":"fleeing"},"duration":{"value":1,"unit":"rounds"}}]}},"apply":[]}}
```
2. Basic save, condition only on a critical failure (cantrip `save will basic`): "Critical Failure: the target is slowed 1."
```json
{"v":1,"label":"Daze","onUse":{"targets":"selected","challenge":{"statistic":"will","dc":{"source":"spell"},"basic":true,"byDegree":{"criticalFailure":[{"to":"target","condition":{"slug":"stunned","value":1}}]}},"apply":[]}}
```
3. Save, prone on failure (spell `save reflex`): "Failure: the target falls prone. Critical Failure: also prone."
```json
{"v":1,"label":"Grease","onUse":{"targets":"selected","challenge":{"statistic":"reflex","dc":{"source":"spell"},"basic":false,"byDegree":{"failure":[{"to":"target","condition":{"slug":"prone"}}],"criticalFailure":[{"to":"target","condition":{"slug":"prone"}}]}},"apply":[]}}
```
4. Save with persistent damage and a note (spell `save will`): "Failure: sickened 1 and 1d4 persistent mental damage. Critical Failure: sickened 2 and 2d4 persistent mental damage."
```json
{"v":1,"label":"Phantom Pain","onUse":{"targets":"selected","challenge":{"statistic":"will","dc":{"source":"spell"},"basic":false,"byDegree":{"failure":[{"to":"target","condition":{"slug":"sickened","value":1}},{"to":"target","persistent":{"formula":"1d4","damageType":"mental"}}],"criticalFailure":[{"to":"target","condition":{"slug":"sickened","value":2}},{"to":"target","persistent":{"formula":"2d4","damageType":"mental"}}]}},"apply":[]}}
```
5. Check by the user against a defense (action): "Make a Deception check against the target's Perception DC. Success: off-guard until the end of your current turn. Critical Success: until the end of your next turn."
```json
{"v":1,"label":"Feint","onUse":{"targets":"selected","check":{"statistic":"deception","vs":{"defense":"perception"},"options":["action:feint"],"byDegree":{"criticalSuccess":[{"to":"target","condition":{"slug":"off-guard"},"duration":{"value":1,"unit":"rounds","expiry":"turn-end"}}],"success":[{"to":"target","condition":{"slug":"off-guard"},"duration":{"value":0,"unit":"rounds","expiry":"turn-end"}}]}},"apply":[]}}
```
6. Buff on yourself with a linked effect (spell, no save): "You gain the effect @UUID[Compendium.pf2e.spell-effects.Item.2Hg3a06gZCSnUgSA]{Spell Effect: Figment}."
```json
{"v":1,"label":"Figment","onUse":{"targets":"self","apply":[{"to":"self","effect":{"uuid":"Compendium.pf2e.spell-effects.Item.2Hg3a06gZCSnUgSA"}}]}}
```
7. Effect on a chosen creature plus a manual note (spell, no save): "The target gains @UUID[Compendium.pf2e.spell-effects.Item.nkk4O5fyzrC0057i]{Spell Effect: Soothe} and regains 1d10+4 Hit Points."
```json
{"v":1,"label":"Soothe","onUse":{"targets":"selected","apply":[{"to":"target","effect":{"uuid":"Compendium.pf2e.spell-effects.Item.nkk4O5fyzrC0057i"}},{"to":"target","note":"Цель восстанавливает 1d10+4 ПЗ (лечение вручную)"}]}}
```
8. Consumable that applies an effect to the user: "You drink the elixir and gain @UUID[Compendium.pf2e.equipment-effects.Item.eh7EqmDBDW30ShCu]{Effect: Bravo's Brew (Lesser)}."
```json
{"v":1,"label":"Bravo's Brew","onUse":{"targets":"self","apply":[{"to":"self","effect":{"uuid":"Compendium.pf2e.equipment-effects.Item.eh7EqmDBDW30ShCu"}}]}}
```
9. Self condition (action): "You fall prone."
```json
{"v":1,"label":"Drop Prone","onUse":{"targets":"self","apply":[{"to":"self","condition":{"slug":"prone"}}]}}
```
10. Reaction with an AC bonus (Trigger: you are attacked): "You gain a +2 circumstance bonus to AC against the triggering attack."
```json
{"v":1,"label":"Nimble Dodge","onAttacked":{"trigger":"attack-on-self","bonus":{"stat":"ac","type":"circumstance","value":2}}}
```
11. Nothing to automate (pure damage, passive, narrative; no condition/effect/movement/penalty in the text): `{"uuid":"...","rule":null,"unsure":false,"note":"only damage"}`
12. Not sure (several different outcomes depending on a choice): `{"uuid":"...","rule":null,"unsure":true,"note":"target depends on a choice"}`
13. Save against the user's class DC, ends on the target's turn (feat): "The target attempts a Fortitude save against your class DC. Success: dazzled until the end of its next turn. Failure: blinded for 1 round."
```json
{"v":1,"label":"Black Powder Flash","onUse":{"targets":"selected","challenge":{"statistic":"fortitude","dc":{"against":"class"},"basic":false,"byDegree":{"success":[{"to":"target","condition":{"slug":"dazzled"},"duration":{"value":1,"unit":"rounds","expiry":"turn-end","of":"target"}}],"failure":[{"to":"target","condition":{"slug":"blinded"},"duration":{"value":1,"unit":"rounds"}}]}},"apply":[]}}
```
14. Repeat save at the end of the target's turn (spell `save will`): "Failure: the target is slowed 1. At the end of each of its turns it can attempt another Will save to end the effect."
```json
{"v":1,"label":"Undermine Reality","onUse":{"targets":"selected","challenge":{"statistic":"will","dc":{"source":"spell"},"basic":false,"byDegree":{"failure":[{"to":"target","condition":{"slug":"slowed","value":1},"repeat":{"on":"turn-end","end":["success","criticalSuccess"]}}]}}}}
```
