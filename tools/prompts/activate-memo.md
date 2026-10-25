BATCH `activate`: every item below is a gear / weapon / NPC activation that the earlier tool could NOT express. Use the `activate` forms of the schema (they override the "unsure" lines for lists and half-level ranks in the main prompt). Each item carries `REASON` (why the tool gave up) and sometimes `CURRENT` (an existing partial rule; keep what is right, finish the rest).
- ONE `activate` entry per "Activate" block in the text, in text order; the rule has NO root `onUse`. Count the Activate blocks and the entries: they must match.
- "You cast @UUID[spells-srd]{X}" plus an extra effect of the item (a bonus, an effect, an immunity, a condition the spell does not give) -> `spell` + `onUse` in ONE entry (the `onUse` holds ONLY the extra). The text's own @Check DC for the spell -> `dc`; do not repeat the spell's own save in `onUse`.
- Activation without a spell -> entry with `onUse`, `label` (the activation name) and a latin slug `id`. Its challenge `dc` is `{"value":N}` or omitted (then the entry `dc` is used).
- "X or Y" / "choose one" (several modes or spells in one Activate) -> `choices` (2-6 options, each `spell` or `onUse`, ids unique); modes with different Frequency are separate entries instead.
- Half-level rank ("rank is half your level, rounded down", "its rank is half the item's level"; the schema always rounds DOWN — "rounded up" -> `unsure`, "missing: rank rounded up") -> `rank: {"half": "actor"|"item", "min": 1}`; "your spell DC" of a caster -> `dc: {"against": "class-spell"}`.
- A linked item effect that the text grants only under a condition ("if you're wearing X", "if you are in Y form") is NOT unconditional: use `choices` (with / without the condition) or mark `unsure` with "missing: conditional effect".
- Frequency per entry from its own "Frequency" block only. A shared frequency, charges, or a text you still cannot express -> `unsure: true`, `note` "missing: <what>"; never invent steps, never drop an activation silently.
- Several steps of a mode that the schema lacks (damage, healing, teleport) -> a Russian `note` step, as in the main prompt.

Examples (answer rule only):

A. Cast plus an extra of the item: "Activate—Ward (manipulate). Frequency once per day. Effect: You cast @UUID[Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6]{Charm}, and you also gain @UUID[Compendium.pf2e.equipment-effects.Item.aaaaaaaaaaaaaaaa]{Effect: Ward}."
```json
{"v":1,"label":"Ward Charm","activate":[{"spell":"Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6","per":{"value":1,"unit":"days"},"onUse":{"targets":"self","apply":[{"to":"self","effect":{"uuid":"Compendium.pf2e.equipment-effects.Item.aaaaaaaaaaaaaaaa"}}]}}]}
```
B. Half-level rank and the caster's DC: "Activate—Harrow Card. Effect: You cast @UUID[Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6]{Charm}; its rank is half your level (minimum 1) and it uses your spellcasting DC."
```json
{"v":1,"label":"Harrow Card","activate":[{"spell":"Compendium.pf2e.spells-srd.Item.vLA0q0WOK2YPuJs6","rank":{"half":"actor","min":1},"dc":{"against":"class-spell"}}]}
```
C. Own steps, no spell: "Activate—Flash (manipulate). Frequency once per hour. Effect: Each creature in a 10-foot emanation attempts a DC 24 Fortitude save. Failure: dazzled for 1 round."
```json
{"v":1,"label":"Flash Lamp","activate":[{"id":"flash","label":"Flash","per":{"value":1,"unit":"hours"},"onUse":{"targets":"area","challenge":{"statistic":"fortitude","dc":{"value":24},"basic":false,"byDegree":{"failure":[{"to":"target","condition":{"slug":"dazzled"},"duration":{"value":1,"unit":"rounds"}}]}}}}]}
```
