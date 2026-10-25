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
             "zone": {"duration": {"seconds": 60}, "triggers": [ {"on": "enter"|"turn-start"|"turn-end", "per": "round"|"turn"?, "challenge": CHALLENGE} ], "follow": false?, "enterBy": "path"?, "onCarrierGone": "stay"?} | null,   // only with targets "area": a cloud/wall/emanation that makes a creature save when it enters, starts or ends its turn in it ("Any creature that ends its turn in the cloud must attempt a Fortitude save"); the save at creation stays in "challenge". An emanation follows its caster by itself — add "follow": false only if the text says it stays in place, "enterBy": "path" only if creatures the emanation sweeps past while the caster moves also count as entering, "onCarrierGone": "stay" only if the text says it persists when the caster is gone
             "check": CHECK | null },           // the USER rolls a check against the target's defense (never both challenge and check)
  "onEvent": [ {"on": "enter"|"turn-start"|"turn-end", "side": "near", "range": 30, "per": "round"|"turn"?, "challenge": CHALLENGE} ],   // AURA of the item's owner (a monster ability, feat or gear: "creatures that enter or end their turn within 30 feet must attempt a save"); use INSTEAD of onUse; "range" = feet from the owner, "per" = "once per round/turn" limit; "enter" = a creature (or the owner) moves into the aura
  "onAttacked": { "trigger": "attack-on-self", "bonus": {"stat": "ac", "type": "circumstance", "value": 2} },  // reaction giving an AC bonus when attacked; use INSTEAD of onUse
  // Entry shape: {id?, label?, per?, requires?, note?} + EXACTLY ONE of "spell" | "choices" | "onUse", or the pair "spell"+"onUse" (a cast plus an extra of the item). Without "spell" and "choices" "label" is required, and so is an explicit latin slug "id" (counters are keyed by it). "attack"/"counteract"/"rank" only with "spell".
  //   "onUse": same grammar as the root onUse, used INSTEAD of the root onUse — the activation's OWN steps (a root onUse stays null for such an item); inside it a challenge.dc is either {"value": N} or OMITTED (then the entry's "dc" is used, else the item-level DC); never {"against"}, {"source"}, {"expr"} or a bare number.
  //   "choices": 2-6 options [{"id": "face1", "label": "...", "spell": "..."?, "onUse": {...}?, "rank"?, "dc"?}] ("X or Y" activations: the user picks one when pressing); each option has spell or onUse, an option without spell needs "label" and an explicit "id"; no nested choices; ids unique.
  //   "rank": 1-10 (only with "spell"), or {"half": "actor"|"item", "min": 1} = max(min, floor(level/2)) of the actor / the item. "dc": number | {"level": "high"} | {"against": "class-spell"} (the DC of the actor's best spellcasting entry).
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
              "persistent": {"formula": "2d6", "damageType": "fire"}
              "move": {"mode": "push"|"pull", "distance": 10, "from": "point"?}      // forced movement of the TARGET ("to":"target" only): push = straight away from the user, pull = straight toward the user (stops adjacent); distance in feet, multiple of 5. Different distance per degree = a separate move step in each degree. "up to N feet" = N. Away from / toward the user by default. "from": "point" = away from / toward the CENTRE of the area (burst, "pushed away from the centre of the burst") and ONLY with targets "area"; with targets "area" every move MUST have "from": "point". Not inside zone triggers or onEvent. A cone/line/wall area has no centre: the tool then pushes from the user.
            }
            + "duration" (optional; REQUIRED when the step is effect.mods): {"value": 1, "unit": "rounds"|"minutes"|"hours"|"days", "expiry": "turn-start"|"turn-end", "of": "origin"|"target"} on a condition step
              ("expiry" turn-end/turn-start = ends at the end/start of a turn; "of" = whose turn: "origin" (the user, default) or "target" (the affected creature: "until the end of ITS next turn");
               use value 0 + expiry turn-end for "until the end of this turn")
            + optional "who": "ally"|"enemy"   // apply to this step's target only if it is an ally / an enemy of the user (use when one cast hits both allies and enemies differently)
            + the step kind "affliction" ("to":"target" only, never together with repeat/escape/duration): {"stage": 1, "def": {"name": "Spider Venom", "kind": "poison"|"disease"|"curse", "save": {"statistic": "fortitude", "dc": 22}, "maxDuration": {"value": 6, "unit": "rounds"} | null, "onset": {"value": 1, "unit": "hours"} | null, "virulent": false,
              "stages": [{"duration": {"value": 1, "unit": "rounds"} | null, "damage": [{"formula": "1d10", "damageType": "poison"}], "persistent": {"formula": "1d6", "damageType": "bleed"} | null, "conditions": [{"slug": "sickened", "value": 1}], "mods": [effect.mods blocks] | null, "text": "what you could not express, in English"}]}}
              // a poison/disease/curse with "Stage 1 … Stage 2 …": ONE def with all stages, written identically in two steps: failure -> "stage": 1, criticalFailure -> "stage": 2. A stage with no duration is final ("dead"). "as stage 2" = copy that stage. Anything not expressible stays in "text". Rules text outside the stages that you cannot express (cannot be removed, story effects) goes into def."note" (a short English string, optional). save.dc is omitted only when the text has no number.
            + optional "repeat": {"on": "turn-start"|"turn-end", "end": ["success","criticalSuccess"]} on a condition/effect step of the target INSIDE a challenge byDegree: "at the end of each of its turns it can attempt another save to end it" (the save and DC are those of the challenge; "end" = the degrees that end it)
```
Rules of thumb:
- Spell with a save in the item header (`save will`, `save reflex`...) -> `challenge` with `dc: {"source":"spell"}` and `basic` as shown. Put conditions from each degree of the text into byDegree. Targets: `selected` (or `area` if the item has an area).
- Effect on yourself (buff, stance, "you gain") -> `targets: "self"`, step `to: "self"`. Effect on an ally or chosen creature -> `targets: "selected"`, `to: "target"`.
- If the text links an effect item (`@UUID[Compendium.pf2e.*effects*...]`), use `effect.uuid` instead of recreating its numbers. The effect UUID must literally appear in the item text.
- A numeric modifier, weakness/resistance or "can't use reactions" with NO linked effect ("-2 status penalty to Will saves for 1 round", "-10-foot status penalty to its Speeds", "weakness 5 to fire for 1 minute", "can't use reactions") -> `effect: {"mods": [...]}` with a REQUIRED finite `duration` (value + unit rounds/minutes/hours/days; `of` "origin"|"target" = whose turn counts "until the start of your next turn"). Blocks (1-4, one key each): `{"bonus":{"target","type","value"}}` (target: ac, saving-throw, fortitude, reflex, will, attack-roll, damage, perception, skill-check or one skill; type status|circumstance|item|untyped; value is signed: penalty negative), `{"speed":{"type","value"}}` (all Speeds), `{"resist":{"dmg","value","except"?}}`, `{"weak":{"dmg","value"}}`, `{"forbid":"reactions"}`. Name the exact save/skill ("Will" -> `will`, not `saving-throw`). Do NOT use it when the text links an effect (use `effect.uuid`), for conditional modifiers ("against undead", "while prone"), for "next attack only" bonuses, or without a stated duration: answer `unsure: true` instead. No `badge`, `replace`, `mark`, `choice` or `unlessEffect` with `mods`.
- A condition named in plain words without a link (e.g. "the target is dazzled for 1 round") is still a `condition` step: use its English slug (dazzled, off-guard, prone, fleeing...). Do not invent a condition that pf2e does not have; if the text names something else (a curse, a "mark"), use a `note` step.
- If the header says `selfEffect`, the system ALREADY applies that effect to the user. Do not add a step for it; add only what comes on top (target effects, saves, notes), or answer `null` if nothing else is left.
- Damage and healing are NOT automated: skip them or mention in a `note` step (Russian) only when the GM must act.
- "The target is temporarily immune for 1 minute" after the save -> `challenge.immunity` with the item's slug and that duration. Immunity after an effect ends (not after the save) cannot be expressed: leave it out.
- Gear activation "Activate … Effect: You cast @UUID[Compendium.pf2e.spells-srd...]{X}" with exactly ONE spell link -> an `activate` entry and nothing else (no `onUse`, not `null`). `spell` = that UUID copied exactly; `rank` only when the text says "4th-rank"; `dc` = the number in the `@Check[...|dc:N]` written with that sentence, else the item's "spell DC … is N" (that @Check is NOT an `onUse.challenge`: the spell's own rule rolls the save); no number in the text -> omit `dc`; `per` from "Frequency once per day" (`{"value":1,"unit":"days"}`; "twice per day" -> add `"uses":2`; "once per 10 minutes" -> value 10, unit minutes; frequency ONLY from a "Frequency" block — spellheart cantrips have none, so no `per`); the text's own duration for the cast spell ("you gain the effects of X for 1 minute" — a different duration than the spell's) -> `duration` `{"value":1,"unit":"minutes"}` on the entry (only with `spell`; do not repeat the spell's steps); immunity after the spell's own save ("a creature that succeeds is immune for 24 hours") -> `immunity` `{"slug":"<spell-slug>","label":"Dominate","duration":{"value":24,"unit":"hours"},"degrees":["success","criticalSuccess"]}` (only with `spell`); limits ("only to attack its allies") -> `note` (Russian); "rank is half your level" -> `rank: {"half":"actor"}`. Several separate activations -> several entries. "X or Y" spells in one activation -> `choices` (example 20); a long list of spells to choose from (staff charges) -> `unsure: true`, note `cast-activation`. A spell that an item casts as part of a bigger effect (not "You cast") stays a plain `note`.
- Use only mechanics you see in the text. Do not add steps "just in case". Do not add fields that are not in the schema above; no macros.
- Notes inside the rule are in Russian, one short sentence.
- A rule that would have no steps at all is wrong: answer `null` instead.
- "Each enemy" / "all enemies" / "enemies in the area" -> add `"who": "enemy"` to EVERY `to: "target"` step (allies in the area must not get the condition). "Each ally" -> `"who": "ally"`.
- A condition that some degree avoids or ends goes into `byDegree` of those degrees, never into `apply` (apply runs for every target regardless of the save).
- "The target must spend its first action / one action to …" (a command, a forced action) is NOT a condition: do not use fleeing/prone/etc. for it. Use a condition only when the text names it. Otherwise `unsure: true`, note `forced-action`.
- Afflictions with stages ("Stage 1 … Stage 2 …", diseases, poisons) and healing modifiers ("regains half as many Hit Points from healing", "can't be healed") are real mechanics: never `null`; healing modifiers alone ("regains half as many Hit Points from healing") are not expressible: `unsure: true` with note `healing-modifier`. Stages ("Stage 1 … Stage 2 …"): write the `affliction` step (example 17b) on failure and critical failure; never recreate stages with condition steps or a "simple challenge + condition". The tool builds the def from the text when you give only the challenge head, but give it yourself when you can.
- `null` (nothing to automate) ONLY when the text has no condition, effect, persistent damage, forced movement (push, pull, knock prone), numeric bonus/penalty, weakness/resistance, immunity or duration: pure damage/healing, narrative, GM judgment, objects/terrain, information. If any of these is there but the schema cannot express it, answer `unsure: true` and name the missing mechanism in `note` by its key (see "Naming what is missing", e.g. `teleport`, `degree-shift`). Push and pull of the target are NOT missing: use the "move" step. Teleport, "move the target to a square you choose" and "force it to Stride" stay unsure. Pushed/pulled away from or toward the centre of an area or burst: targets "area" + "move" with "from": "point".

# When to answer unsure (do NOT write an onUse rule for these)
- The effect happens on a trigger rather than on use: "when it hits / Strikes", "when it dies", "whenever ...". Answer `unsure: true` (put `rule: null`).
- Exception 1: an aura of the item's owner that makes OTHER creatures save when they enter it or start/end their turn in it ("an enemy that enters or ends its turn within 30 feet must attempt a Will save") is NOT unsure: write the `onEvent` entry with `side: "near"` (example 18). One entry per trigger: "enters or ends its turn" = two entries (`enter` and `turn-end`) with the same `per`.
- Exception 2: a feat or action that says "Make a Strike. If it hits (critically), the target attempts a save" is NOT unsure. Write the usual `onUse.challenge` with the save and its degrees; the tool moves it to a post-Strike event itself. Do NOT write `onEvent` for it. Ammunition and bombs ("when damaged by this ammunition") stay `unsure: true`.
- The item text ends with "…" (cut off): `unsure: true`. The marker `[flavor cut]` is fine: only descriptive text was removed.
- Several different outcomes depending on a choice, a fixed DC you cannot find, or anything you cannot express with the schema.

# Naming what is missing (mechanism keys)
When `unsure: true` because a mechanic cannot be expressed, write in `note` the canonical key of the missing mechanism (several keys separated by `, `), nothing else. If no key fits, write `new: <3-6 words>`. Pick the most specific key. Keys:
- `ammo-bomb`: effect of ammunition, a bomb or a rune on hit, on damage or by splash
- `passive-hit-trigger`: passive/reaction effect when a Strike hits, crits or deals damage (to or by the owner); NOT an action that makes a Strike (that is `strike-gate`)
- `strike-gate`: action "Make a Strike; if it hits, a save" that the schema still cannot express
- `weapon-next-strike`: weapon activation or effect applying to the next Strike, a curse or effect bound to a weapon
- `next-cast`: effect on the next spell cast ("if your next action is to cast")
- `push-by-hits`: push distance depends on the number of hits; `forced-movement-other`: forced movement that is not a push/pull by a distance (forced fall, lifting, toward an image, out of a line, to the nearest space); `push`: only if a plain push/pull still failed to fit
- `triggered-save`: save from an aura, entering an area, start or end of a turn that the schema still cannot express
- `reaction-trigger`: reaction or activation with a trigger condition and a response; `event-trigger`: effect on any other event (target dies, on sight, on casting, on a jump, an item taken)
- `repeat-save`: repeated save at the end of the target's turn that the schema cannot express
- `cast-activation`: gear activation that casts a spell
- `forced-action`: the target must take certain actions (command, control); `hostile-actions`: the target cannot take hostile actions against the source
- `mode-choice`: the user picks a mode/face/one of several activations that the schema cannot express
- `mods`: a numeric penalty/bonus or "can't use reactions" with no linked effect that still failed to fit
- `degree-shift`: the degree of success is shifted; `teleport`: teleportation; `trample`: Stride through creatures
- `condition-link`: a condition tied to another condition, or a sequence of conditions
- `duration-unclear`: the text does not give a duration; `effect-too-long`: an unlimited effect that is meant for one roll (bonus only against the triggering attack)
- `healing-modifier`: changed healing received
- `affliction-stages`, `affliction-stage-text`, `affliction-linger`, `affliction-duration`, `random-duration`, `hold`, `affliction-no-save`, `affliction-injury`: an affliction (stages, unparsed stage text, lingering after the last stage, duration or onset not a number, duration by a die roll, a condition that cannot be reduced until cured, no save, injury delivered by an NPC action or weapon activation)
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
14. Save for creatures that end their turn in a lingering cloud (consumable with an area, no save at creation, DC in the text): "Any creature that ends its turn in the cloud must succeed at a Fortitude save or be sickened 1. The cloud lasts 1 minute."
```json
{"v":1,"label":"Spun Cloud","onUse":{"targets":"area","zone":{"duration":{"seconds":60},"triggers":[{"on":"turn-end","challenge":{"statistic":"fortitude","dc":{"value":25},"traits":["olfactory","poison"],"basic":false,"byDegree":{"failure":[{"to":"target","condition":{"slug":"sickened","value":1}}],"criticalFailure":[{"to":"target","condition":{"slug":"sickened","value":2}}]}}}]},"apply":[]}}
```
15. Save with a push and prone (spell `save fortitude`): "Success: the target is pushed 5 feet. Failure: the target is pushed 10 feet and knocked prone. Critical Failure: pushed 20 feet and prone." Prone and push are two steps; push distance differs per degree:
```json
{"v":1,"label":"Gust","onUse":{"targets":"selected","challenge":{"statistic":"fortitude","dc":{"source":"spell"},"basic":false,"byDegree":{"success":[{"to":"target","move":{"mode":"push","distance":5}}],"failure":[{"to":"target","condition":{"slug":"prone"}},{"to":"target","move":{"mode":"push","distance":10}}],"criticalFailure":[{"to":"target","condition":{"slug":"prone"}},{"to":"target","move":{"mode":"push","distance":20}}]}}}}
```
16. Repeat save at the end of the target's turn (spell `save will`): "Failure: the target is slowed 1. At the end of each of its turns it can attempt another Will save to end the effect."
```json
{"v":1,"label":"Undermine Reality","onUse":{"targets":"selected","challenge":{"statistic":"will","dc":{"source":"spell"},"basic":false,"byDegree":{"failure":[{"to":"target","condition":{"slug":"slowed","value":1},"repeat":{"on":"turn-end","end":["success","criticalSuccess"]}}]}}}}
```
17. Numeric modifier with no linked effect (spell `save will`): "Failure: the target takes a -2 status penalty to Will saves for 1 round and can't use reactions."
```json
{"v":1,"label":"Example","onUse":{"targets":"selected","challenge":{"statistic":"will","dc":{"source":"spell"},"basic":false,"byDegree":{"failure":[{"to":"target","effect":{"mods":[{"bonus":{"target":"will","type":"status","value":-2}},{"forbid":"reactions"}]},"duration":{"value":1,"unit":"rounds","expiry":"turn-start","of":"origin"}}]}}}}
```
17b. Poison with stages (consumable or NPC ability, text "Saving Throw @Check[fortitude|dc:22] / Maximum Duration 6 rounds / Stage 1 1d10 poison damage and sickened 1 (1 round) / Stage 2 1d12 poison damage and clumsy 1 and sickened 2 (1 round)"). Never plain condition steps for stages; the def is the same in both degrees:
```json
{"v":1,"label":"Spider Venom","onUse":{"targets":"selected","challenge":{"statistic":"fortitude","dc":{"value":22},"basic":false,"byDegree":{"failure":[{"to":"target","affliction":{"stage":1,"def":{"name":"Spider Venom","kind":"poison","save":{"statistic":"fortitude","dc":22},"maxDuration":{"value":6,"unit":"rounds"},"stages":[{"duration":{"value":1,"unit":"rounds"},"damage":[{"formula":"1d10","damageType":"poison"}],"conditions":[{"slug":"sickened","value":1}]},{"duration":{"value":1,"unit":"rounds"},"damage":[{"formula":"1d12","damageType":"poison"}],"conditions":[{"slug":"clumsy","value":1},{"slug":"sickened","value":2}]}]}}}],"criticalFailure":[{"to":"target","affliction":{"stage":2,"def":{"name":"Spider Venom","kind":"poison","save":{"statistic":"fortitude","dc":22},"maxDuration":{"value":6,"unit":"rounds"},"stages":[{"duration":{"value":1,"unit":"rounds"},"damage":[{"formula":"1d10","damageType":"poison"}],"conditions":[{"slug":"sickened","value":1}]},{"duration":{"value":1,"unit":"rounds"},"damage":[{"formula":"1d12","damageType":"poison"}],"conditions":[{"slug":"clumsy","value":1},{"slug":"sickened","value":2}]}]}}}]}}}}
```
18. Aura of the owner (NPC ability, no save at use): "Frightful Aura (aura, emotion, fear, mental) 30 feet. An enemy that enters or ends its turn within the aura must attempt a DC 25 Will save. Success: temporarily immune to this aura for 1 minute. Failure: frightened 1. Critical failure: frightened 2." Two entries (enter and turn-end), one range, one per; "enemy" -> "who":"enemy" on every target step:
```json
{"v":1,"label":"Frightful Aura","onEvent":[{"on":"enter","side":"near","range":30,"per":"round","challenge":{"statistic":"will","dc":{"value":25},"basic":false,"immunity":{"slug":"frightful-aura","duration":{"value":1,"unit":"minutes"}},"byDegree":{"failure":[{"to":"target","who":"enemy","condition":{"slug":"frightened","value":1}}],"criticalFailure":[{"to":"target","who":"enemy","condition":{"slug":"frightened","value":2}}]}}},{"on":"turn-end","side":"near","range":30,"per":"round","challenge":{"statistic":"will","dc":{"value":25},"basic":false,"immunity":{"slug":"frightful-aura","duration":{"value":1,"unit":"minutes"}},"byDegree":{"failure":[{"to":"target","who":"enemy","condition":{"slug":"frightened","value":1}}],"criticalFailure":[{"to":"target","who":"enemy","condition":{"slug":"frightened","value":2}}]}}}]}
```

19. Gear activation that casts a spell (equipment): "Activate—Win Them Over (concentrate). Frequency once per hour. Effect: You cast a 4th-rank @UUID[Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6]{Charm} spell with a @Check[will|dc:38]." One `activate` entry; the @Check DC goes into `dc`, not into a challenge:
```json
{"v":1,"label":"Necklace of Allure","activate":[{"spell":"Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6","rank":4,"dc":38,"per":{"value":1,"unit":"hours"}}]}
```

20. Gear activation with its own steps and a choice (no spell): "Activate—Cube (manipulate). Frequency once per day. Effect: Choose one face. Face 1: you gain the @UUID[Compendium.pf2e.effects.Item.aaaaaaaaaaaaaaaa]{Effect: Face One}. Face 2: each creature in a 10-foot emanation attempts a DC 30 Fortitude save; on a failure it is sickened 1." One entry with `choices`; the second option's `dc` is omitted from the challenge, so it comes from the option's/entry's `dc` (here 30); `label` and `id` are explicit; a half-level rank is only for options that cast:
```json
{"v":1,"label":"Cube","activate":[{"id":"cube","label":"Cube","per":{"value":1,"unit":"days"},"choices":[{"id":"face1","label":"Face 1","onUse":{"targets":"self","apply":[{"to":"self","effect":{"uuid":"Compendium.pf2e.effects.Item.aaaaaaaaaaaaaaaa"}}]}},{"id":"face2","label":"Face 2","dc":30,"onUse":{"targets":"area","challenge":{"statistic":"fortitude","byDegree":{"failure":[{"to":"target","condition":{"slug":"sickened","value":1}}]}}}},{"id":"face3","spell":"Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6","rank":{"half":"item","min":1}}]}]}
```
