You REVIEW machine rules for a Foundry module. First read `tools/prompts/draft-rule.md`: its answer format, rule schema, rules of thumb and examples apply here unchanged. Do NOT read any other files.

# Task
Each item has the rules text and a `DRAFT:` line, a rule derived from the text by regular expressions. About half of these drafts are wrong. Compare the draft with the WHOLE text, degree by degree, and answer the CORRECT rule in the same format (`{uuid, rule|null, unsure, note}`).
- The draft is fully correct: return it unchanged, note `"draft ok"`.
- The draft is wrong but the correct rule fits the schema: return the corrected rule and name the fix in `note` (e.g. `"fix: duration on both conditions"`).
- The text needs something the schema cannot express: `unsure: true`, `rule: null`, note `"missing: <what>"`. Do NOT return a partial rule that applies the wrong thing.
- Nothing to automate (see draft-rule.md for when `null` is allowed): `rule: null`.

**The draft may use valid fields that draft-rule.md does not show** (`effect.replace`, `when`, `rollOption`, `removeCondition`, `excludeSelf`, `policy`, `choice`…). Keep every field you do not recognise exactly as it is; change only what the checklist says is wrong.

**Reactions and free actions with a `Trigger`:** the player uses the item exactly when the trigger happens, so the rule describes what the `Effect` does at that moment. A trigger line alone is NOT a reason for `unsure`. Be `unsure` only when the effect waits for ANOTHER later event ("the next time…", "until the end of the encounter, whenever…").

# Checklist: known draft errors (check each one)
1. **Recipient.** "You are stunned/frightened…" means the user (`to: "self"`), not the target. "Each enemy / non-allied creature" means `who: "enemy"` on every target step.
2. **Duration on every condition.** "Blinded and deafened for 1 minute" means both get the duration. "For the spell's duration" means the item's `dur`. A condition the text limits but the draft leaves without a duration is a wrong draft. Conditions that end by themselves (frightened, sickened, stunned N, prone, drained, doomed, wounded) take no duration unless the text gives one.
3. **"While X" / "until it is no longer X" / "for as long as"** on a condition: `unsure`, `"missing: condition tied to another condition"`.
4. **Sequence.** "Stunned 3; when it recovers, it is confused" / "then slowed": only the first part happens now. The second part is `unsure`, `"missing: sequence"`. Never apply both at once.
5. **Delayed or repeated save.** The degree blocks belong to a save made later ("the next time it sleeps", "when a creature enters / steps on / attempts to take", "another save with the following effects", aura, start of turn): `unsure`, `"missing: triggered save"`.
6. **Strike first.** "Make a Strike; if it hits / damages / on a critical hit, the target attempts a save", ammunition or bombs whose save happens "when damaged by" the projectile: `unsure`, `"missing: strike-gate"`.
7. **Permanent.** "Permanently" or "the conditions are permanent": no duration on that degree. Never inherit "1 minute" from another degree.
8. **Every degree.** Each degree block in the text that applies a condition or effect must have its steps. Also check conditions outside the blocks ("a creature that fails its save also falls prone") and an effect link in a separate paragraph right after a block.
9. **Several modes.** Two sets of degree blocks for different modes or choices ("Fireworks … Smoke …"): `unsure`, `"missing: mode choice"`.
10. **Numbers.** Condition values and durations must match the text exactly ("one minute" written in words counts). A value on a condition that has none ("Dazzled 1"), or one degree without a duration while its neighbours have one: `unsure`, `"missing: unclear duration"`.
11. **What the effect does** (the `EFFECTS:` line, when given). An effect whose duration is none/unlimited, used for something the text limits ("against the triggering attack", "on that check", "until the end of your turn"), stays forever: `unsure`, `"missing: effect too long"`. Do not add a condition step that the step's effect already grants (`grants frightened`), or it applies twice. An effect `has ChoiceSet` placed in `apply` when the text grants it only on a successful roll: `unsure`.
12. **Next action.** "If the next action / spell / Strike you use…": `unsure`, `"missing: next-cast"`.
13. **Familiar or companion abilities** ("your familiar…, you gain"): the user is the familiar, so `to: "self"` is wrong: `unsure`, `"missing: master recipient"`.
14. **Heightened.** "Heightened (7th) the target is stunned 2 instead": add a separate step with `"rank": {"min": 7}` (and `"max"` on the lower step). Bonuses that appear only at higher ranks are never a reason for `null`.
15. **Self in the area.** In an emanation the user is excluded by default. "Including you / the grandmaster themself": `"excludeSelf": false` in `onUse`.
16. **DC.** Do not change `dc` unless an `@Check` in the text contradicts it. `"against": "<class slug>"` (kineticist, commander…) is valid; keep it.
