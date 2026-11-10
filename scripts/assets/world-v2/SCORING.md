# Prop acceptance standard

A prop is only finished when it reads as a real, used object in the first-person view of a horror
game, seen from 1.7 m eye height. Slapped-together shapes fail, however tidy.

Each prop gets `assets/world-v2/review/<asset>.jpg` (six views of the exported GLB) and
`<asset>.json` (automatic audit). Judges see only these, never the authoring code or earlier opinions.

## Automatic gates (any failure caps the overall score at 5)
- `floatingGroups` is 0, or every listed group is a deliberate hanging or wall-mounted part.
- Triangles within budget: hero building 45k, machine 15k, interactable small prop 8k, background small prop 2.5k.
- Stairs and ladders pass the walk-through tests in `tests/traversal.test.mjs`.

## Score each from 0 to 10; 10 is shipped indie-horror quality, 5 is a blockout
1. **Silhouette**: instantly recognisable from any angle, believable proportions.
2. **Construction**: parts join the way real parts join (bolts, notches, brackets, overlaps). No gaps, floating or unexplained intersections, no parts that hold nothing up.
3. **Scale**: doors, steps, rails and handles fit a 1.75 m person.
4. **Materials**: reads as the real material, not as patterns. No camouflage-like blotches, repeating stains or smeared texture.
5. **Wear story**: damage has a cause (rain, rust at joints, moss where water sits). Not uniform noise.
6. **Detail density**: enough small believable detail up close, without clutter.

**Overall** = (lowest category + mean of all six) / 2.
**Verdict** (from the QA skill): list each defect as Blocker, Major or Minor, then SHIP, SHIP WITH NOTES or NO-SHIP. Blockers are wrong scale, broken normals or badly exceeded budgets. Never ship on a sheet you have not looked at.
**Pass**: every category at least 7 and overall at least 8. Anything below loops back for refinement with concrete, located fixes.
