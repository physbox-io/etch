# Machining decisions and where they come from

Every number in this app that decides what happens to material — a feed, a
spindle speed, a depth of cut, a laser power, a peck depth, a tolerance — is a
claim about the physical world. This document is the register of those claims:
what the value is, where it lives, why it is what it is, and **how well it is
sourced**.

It exists because the code comments explain *reasoning* but rarely *provenance*,
and those are different things. "Shallow enough that the cutter is shaving
forwards rather than drilling" tells you why a 3° ramp is sane; it does not tell
you whether 3° came from a manufacturer's data sheet, from a machining
reference, or from someone's judgement. When a hobbyist snaps a cutter, the
difference matters.

## How to read the source column

| Grade | Meaning |
|---|---|
| **Derived** | Follows from arithmetic or physics. Not a matter of opinion — check the formula, not a source. |
| **Documented** | Comes from a controller/library specification we can point at. |
| **Published** | Matches published industry guidance, cited below. Our value is chosen conservatively within that guidance rather than copied from a specific row of a specific table. |
| **Judgement** | Chosen by us as a conservative default. Defensible, uncited, and **unverified against material**. |

Anything marked **Judgement** is a candidate for being wrong. The honest test for
most of them is the material test grid (preset dropdown → Generators), which is
precisely a tool for replacing our estimate with your measurement.

**When adding a machining constant, add a row here.** A magic number that
reaches material without a line in this table is the thing this document exists
to prevent.

---

## 1. CNC: feeds, speeds and chip load

`src/utils/feeds.ts`, `src/utils/materials.ts`

| Value | Where | Basis | Source |
|---|---|---|---|
| `feed = rpm × flutes × chipload` | `deriveFeeds` | The definition of chip load: each flute takes one bite per revolution. | **Derived** |
| Chipload scales with tool diameter from the 3.175 mm reference | `deriveFeeds`, `chiploadAt3mm` | A wider cutter is stiffer and takes a bigger bite; a narrower one deflects. | **Published** — chip-load tables are published per diameter and material class by router-tool manufacturers (Onsrud, Amana, Vortex). Our scaling is a smooth interpolation of that shape, not a copy of a table. |
| Chipload 0.07–0.10 mm at 1/8" in wood/MDF/ply | `materials.ts` | The mid of the published hobby range for 1/8" two-flute in wood. Erring low costs a slower job; erring high snaps the cutter. | **Published** (range), **Judgement** (exact value) |
| Chipload 0.025 mm at 1/8" in aluminium | `materials.ts` | Non-ferrous on a hobby router is a light-cut, high-RPM job. | **Judgement** |
| RPM 12,000–18,000 at 1/8", falling with diameter | `materials.ts`, `deriveFeeds` | Surface speed is `π × D × rpm`; holding it constant means a wider tool turns slower. | **Derived** (the scaling), **Judgement** (the reference RPM) |
| Cutting feed ceiling = the slower of `$110` and `$111` | `cuttingFeedCeiling`, `deriveFeeds` | What the gantry will track is a property of the machine, and GRBL reports it. The slower of the two axes, because a feed handed to a toolpath has to be holdable in whatever direction the path goes. | **Documented** — GRBL v1.1 settings (`gnea/grbl` wiki). |
| `MAX_CUTTING_FEED_MM_MIN = 4000` — now a fallback only | `feeds.ts` | The shape of a small belt gantry, used when no machine has answered `$$`. It was a blanket cap, and capping a capable machine cost more than the feed: `deriveFeeds` answers a clamped feed by turning the spindle *down* to hold chipload, so the job lost feed and RPM together. Raising the constant was never the fix. | **Judgement** (the fallback figure), **Derived** (that it must not bind on a machine that has reported better) |
| Acceleration and per-axis rapids from `$120`–`$122` / `$110`–`$112` | `motionProfile.ts` | A stock GRBL ships 10 mm/s², a tuned belt gantry runs 200–800, a ballscrew mill several thousand — a factor of fifty, landing directly on the time estimate. A move is limited by whichever axis runs out first, so a plunge is governed by Z alone and a diagonal by each axis's limit over its share. | **Documented** — GRBL v1.1 settings; **Derived** — the per-axis combination. |
| Junction deviation from `$11` | `motionProfile.ts`, `toolpathTimeline.ts` | Corner speed goes as `sqrt(accel × deviation)`, and on a traced outline every vertex is a corner — so this governs the job more than the feed does. GRBL's own centripetal rule, with the machine's own number rather than the 0.01 assumed before. | **Documented** — GRBL's planner uses exactly this rule with this setting. |
| Overscan run-up length measured against the machine's acceleration | `overscanFor` | A run-up is the distance to reach feed, which is a fact about the gantry. Sized from one assumed figure it is either too short on a soft machine — the burnt fill border is still there — or too long on a stiff one, which is travel outside the work for nothing. | **Derived** |
| A stored profile is per machine, with no account-wide fallback | `readMotionProfile` | Two machines on one account do not share an acceleration. A kerf copied from another machine is at least a kerf; an acceleration copied from one is a claim about hardware that is not present, so the assumed profile — which says `source: 'assumed'` — is the honest answer instead. | **Derived** |
| `BLOCKS_PER_SECOND = 450` | `toolpathTimeline.ts` | The floor under a move's time. Past this the machine waits for its next instruction rather than for its axes, which is what actually governs a dense engrave. A conservative figure for GRBL over 115200 baud. | **Judgement** |
| `MIN_CUTTING_FEED_MM_MIN = 60` | `feeds.ts` | Below this the flutes rub rather than cut: heat, burning, work-hardening. | **Judgement** |
| `PLUNGE_FEED_FRACTION = 0.3` | `feeds.ts` | Downward is where a cutter clears chips worst and resists bending least. Commonly quoted as ¼–⅓ of the cutting feed. | **Published** (range), **Judgement** (0.3) |

## 2. CNC: depth, entry and pockets

| Value | Where | Basis | Source |
|---|---|---|---|
| `stepdownRatio` 0.5–1.0 × diameter | `materials.ts` | Depth per pass as a multiple of cutter diameter, for a **full-width slot** — the limiting case, not the typical one. Soft material clears chips and takes ~1×D; hardwood grabs; metal takes far less. | **Published** (1×D slotting rule of thumb in soft material), **Judgement** (per-material values) |
| Finish allowance = 5% of cutter diameter, clamped 0.1–0.3 mm | `finishAllowanceFor` | A cutter in a deep cut is a cantilever: it deflects away from the wall under load and springs back where the load eases, so a single pass leaves a wall neither straight nor square. Roughing wide and returning with almost nothing in front of the tool is the standard answer. Too little and the finishing lap rubs; too much and it is a second roughing pass with a roughing pass's deflection. | **Published** (leaving a finish allowance is standard practice), **Judgement** (5%, and the clamp) |
| Finishing applied only when the cut takes more than one depth pass | `finishAllowanceFor` | In stock thin enough to go through in one, the tool is barely loaded and barely deflects. A second lap round every part would be time spent for a difference nobody can measure. | **Judgement** |
| `FINISH_STEP_MULTIPLE = 2`, `FINISH_AXIAL_DIAMETERS = 3` | `gcodeExporter.ts` | The finishing lap is radially almost nothing, so cutting load is not what bounds it — how much of the flute ends up buried in the wall is. Allowed twice the roughing step, and never more than three diameters. **The roughing stepdown is unchanged**: this is a second, lighter cut with its own limit, not a relaxation of the rule that stops a cutter being driven through 18 mm of ply in one bite. | **Judgement** |
| Tabs go on the finishing pass, not the roughing pass | `gcodeExporter.ts` | Nothing comes free until the finishing lap takes the last of the wall. A tab on the roughing pass is a lump the finishing pass then cuts away. | **Derived** |
| All roughing before any finishing | `toolpathMoves.ts` (visit grouping) | A wall trued and then roughed alongside is exactly the deflection the finishing pass exists to remove. It is also the pass that frees the part. | **Derived** |
| Lead-in/out radius = half the cutter diameter | `leadRadiusFor` | Big enough to be a real curve rather than a corner, small enough to fit the waste beside most parts. It scales with the tool because what it has to clear is the tool. | **Judgement** |
| Lead arcs are cut at depth, entered by rapid descent, not by ramping | `toolpathMoves.ts` | A lead exists only on a finishing lap, which follows a roughing pass that ran a full tool-width wide of the same line — so the arc lies inside a slot already cut to full depth. The tool descends into an existing pocket, which is why this does not breach the "never plunge into material" rule. | **Derived** |
| A lead is skipped whenever any of its points falls in kept material | `planLead` | Kept-ness is even-odd across the layer, so the inside of a hole is waste and a hole's lead correctly swings inward. A neighbouring part half a lead radius away gets no lead rather than a squeezed one. | **Derived** |
| `MIN_STEPDOWN_MM = 0.15` | `feeds.ts` | Below this the pass count explodes for no benefit. | **Judgement** |
| `RAMP_ANGLE_DEG = 3` | `feeds.ts` | A ramped entry shaves forward instead of drilling. Bits break on entry more than anywhere else. Published ramp guidance for end mills in wood is commonly 2–5°. | **Published** (range), **Judgement** (3°) |
| Pocket stepover = tool stepover for flat-bottomed tools; fine pitch otherwise | `defaultPitch`, `tooling.ts` | A flat end mill leaves a flat floor, so passes closer than its stepover re-cut ground already at depth. A ball nose or V-bit leaves scallops, and pitch sets scallop height — no free coarsening. | **Derived** |
| Pockets cleared with contour-parallel rings, innermost first | `pocketOffset.ts` | Constant tool engagement. A zig-zag drives the cutter into the wall at full width and reverses, twice per line — engagement swings between one stepover and a full slot, which is the chatter and the short tool life. Innermost-first leaves the wall pass last, so the pass anyone sees is the final one. | **Published** — contour-parallel (offset) pocketing versus zig-zag is standard CAM practice; the engagement argument is the standard reason for it. |
| Every closed path cut in the direction that climb-mills | `orientForClimb`, `orientSetForClimb` | The tooth should enter at full chip thickness and leave at nothing, so the heat goes out with the chip instead of into the tool. Conventional milling starts every tooth at zero thickness, and a tooth that rubs before it bites is how aluminium welds itself to the flutes. For a right-hand cutter turning clockwise that means the material on the tool's right: clockwise around a part, anti-clockwise around a hole or an outward-clearing ring. | **Published** — climb-versus-conventional and the two hand rules are standard practice. The historical case for conventional is backlash in acme leadscrews, which no machine this app targets has. |
| Which side is material decided by nesting parity, not by winding | `orientSetForClimb` | Clipper is free to return either winding, so winding says nothing about which side the part is on. Parity is the same test `planLead` uses to decide which side is waste, and for the same reason. | **Derived** |
| Direction chosen in the machine's frame, not the drawing's | `originFlipsY` | Paths are planned in document space with Y down and mirrored on the way into G-code for every origin but `bottom-left`. A mirror reverses handedness, so a rule applied to the raw numbers climb-mills half the documents and conventional-mills the other half — and the preview, drawn in document space, looks identical for both. | **Derived** |
| Feed scaled up below half-diameter engagement | `feedForEngagement` | Radial chip thinning: at engagement `a` on radius `r` the chip is `sqrt(1 − (1 − a/r)²)` of the feed per tooth, so a ring taking a stepover makes thinner chips than the recipe was calculated for, and a chip thinner than the edge radius is rubbed rather than cut. The chiploads in `materials.ts` are slotting figures, so a slot is the reference and this is only ever a boost. | **Published** (the chip-thinning formula is standard), **Judgement** (the 1.6 cap, reached at about a tenth of the diameter) |
| Stepdown increased below full engagement, capped at 1.5 × diameter | `stepdownForEngagement` | A narrower bite means proportionally more path to walk, so trading width for depth is only a win because side load falls off faster than engagement does — hence the 1.5 power. The cap is not a force limit but a flute-length one: this knows nothing about how far a given tool hangs out of its collet. Skipped for tools that are not flat-bottomed, whose cutting width *is* their depth. | **Judgement** (the exponent and the cap), **Published** (that a lighter radial cut permits a deeper axial one) |
| Adaptive feed and depth yield to any figure the operator typed | `adaptiveRingCutting` | A speed, stepdown or pass count that was set by hand was set against a measurement this app has not made. | **Derived** |
| A ring is treated as a slot unless something it encloses was cut first | `engagementOf` | The engagement claim is only true where the previous ring has opened the way. A pocket with an island in it closes round the island from two sides and each lobe has an innermost ring of its own — assuming only the first ring slots would feed a real slot at a light cut's rate, which is how a cutter is snapped. | **Derived** |
| Each ring offset from the original boundary, not from the previous ring | `pocketOffset.ts` | Offsetting an offset accumulates arc-approximation error; twenty rings in, the stepover has drifted and the floor shows ridges where passes stopped overlapping. | **Derived** |

## 3. CNC: drilling

| Value | Where | Basis | Source |
|---|---|---|---|
| No canned cycles — pecks emitted as explicit plunges and retracts | `toolpathMoves.ts` | **GRBL 1.1 implements no canned cycles.** `G81`/`G83` are errors on it. Emitting the moves also means the preview can draw the peck and the estimate can time it. | **Documented** — GRBL v1.1 supported G-code list (`gnea/grbl` wiki). |
| A hole within 10% of the cutter's diameter is drilled, not milled | `DRILLABLE_TOLERANCE`, `gcodeExporter.ts` | Milling it is arithmetically impossible (offsetting a contour inward past its own radius leaves nothing). The hole comes out at the *cutter's* size, so the tolerance is a tolerance on the finished part. | **Derived** (impossibility), **Judgement** (10%) |
| Only a contour *enclosed by another* is drilled | `gcodeExporter.ts` | A lone small circle is a disc to cut out, and the tool goes round the outside of it. Drilling it destroys the part. | **Derived** |
| Peck depth = the layer's own milling stepdowns | `toolpathMoves.ts` | Those already account for tool and material, so drilling inherits them rather than inventing a second rule. | **Derived** (from §2) |
| `PECK_CLEARANCE_MM = 2` above the work between pecks | `toolpathMoves.ts` | The retract exists to let chips out of the flutes. Lifting only to the top of the hole carries them back down. | **Judgement** |

## 4. CNC: kerf, tabs and cut side

| Value | Where | Basis | Source |
|---|---|---|---|
| Cutter radius compensation applied by default | `contourOffset.ts` | Driving the cutter's centre down the line makes every part a tool-width undersized and every hole a tool-width oversized. | **Derived** |
| `TAB_WIDTH_MM = 6`, `TAB_HEIGHT_MM = 1.2`, `TAB_SPACING_MM = 60` | `gcodeExporter.ts` | Wide enough to hold a part against a cutter, thin enough to snap by hand. | **Judgement** |
| `MAX_TAB_DEPTH_FRACTION = 0.6` | `gcodeExporter.ts` | A tab taller than this is not a tab. | **Judgement** |
| `THROUGH_CUT_OVERCUT_MM = 0.3` | `materials.ts` | Cutting to exactly the stock thickness leaves a skin, because the stock is never exactly its nominal thickness and the bed is never exactly flat. | **Judgement** |
| Climb milling by default; closed paths never reversed | `contourOffset.ts`, `optimizeTravel` | Direction *is* climb versus conventional. Reordering may not silently change the cut. | **Published** (climb preferred for finish on most hobby routers in wood) |

## 5. Laser: the dose model

`src/utils/feeds.ts` (`deriveLaserFeeds`), `materials.ts` (`LaserMaterial`)

This is the least-sourced part of the app and the most worth calibrating.

| Value | Where | Basis | Source |
|---|---|---|---|
| Speed derived by holding **energy per unit length/area** constant | `deriveLaserFeeds` | `watts ÷ dose = mm/s`. Marking depth follows delivered energy; power and speed are two ways to spend the same budget. | **Derived** (the arithmetic) |
| `etchDoseJPerMm`, `fillDoseJPerMm2`, `cutDoseJPerMm2` per material | `materials.ts` | The per-material energy budgets the whole laser model rests on. | **Judgement** — these are our estimates. No published table was used. |
| `diodeFactor` (≈1.2 for wood) | `materials.ts` | A diode's shorter wavelength and poorer beam quality do not deliver the same useful energy per watt as a CO₂ tube. | **Judgement** |
| `maxPowerFraction` | `materials.ts` | Some materials mark better below full power than at it. | **Judgement** |
| `MAX_LASER_SPEED_MM_MIN = 12000`, `MIN = 120` | `feeds.ts` | Gantry limits, not optical ones. | **Judgement** |
| `FILL_LINE_WIDTH_MM = 0.2` | `feeds.ts` | The effective beam width a fill line deposits energy over. | **Judgement** |

**If you calibrate one thing in this app, calibrate these.** Cut a material test
grid, read the cell you like, and the numbers in §5 can be corrected against it.

## 6. Laser: emission and overscan

| Value | Where | Basis | Source |
|---|---|---|---|
| `M3` (constant power) for lines, `M4` (dynamic power) for shaded images | `gcodeExporter.ts` | Under `M3` the beam holds its power through acceleration, so thousands of short moves dwell and burn dark at the ends. `M4` scales power with actual velocity. | **Documented** — GRBL 1.1 laser mode: `M4` varies power with speed; `$32=1` applies `S` changes without stopping motion. |
| Overscan run-up = `v² / 2a` | `overscanFor`, `toolpathMoves.ts` | The distance to reach cutting feed under the assumed acceleration. Shorter and the beam lights during the ramp; longer is time spent in the dark. | **Derived** |
| Overscan is **laser-only** | `overscanFor` | On a laser the beam is dark outside the shape. On a router the cutter is at depth, so a run-up would mill a groove through material meant to survive. | **Derived** |
| Run-up emitted as `G1` at `S0`, never `G0`+`M5` | `toolpathMoves.ts` | A spindle state change syncs GRBL's planner — the machine would stop dead at the end of every scanline. Riding `S0` changes power without stopping. | **Documented** (GRBL laser mode) |
| Run-up clamped to the stock | `clampToStock` | A fill at the bed edge would otherwise be given a run-up past it, and the job dies on a soft-limit alarm. | **Derived** |
| Cuts offset by **half the kerf**, to the waste side | `resolveLayerCutting`, `contourOffset.ts` | A beam removes material either side of where it is pointed, so a part cut on its outline finishes a kerf under and its holes a kerf over. Same correction as a router's cutter radius, at a tenth of the size. Scored and engraved layers stay on the line (`cutSide: 'on'`). | **Derived** |
| `DEFAULT_LASER_KERF_MM = 0.1` | `machineSettings.ts` | A focused diode's slot in thin stock, and a fair start for a small tube. It is not a constant — it widens with thicker stock, a defocused head and a slower pass — so it is a setting, and the UI says to measure it from a test cut. | **Judgement** — the default only. The number in use should be measured. |
| Kerf stored per machine, keyed on `$I` | `machineSettings.ts`, `webSerialManager.ts` | A 5 W diode and a 40 W tube do not burn the same slot, and one account can have both. GRBL's `$I` carries a build-info string the owner can write with `$I=`, which is the only stable identity a controller offers; unnamed, it falls back to version and options, which identify the model but not the individual machine. | **Documented** (GRBL 1.1 `$I` / `$I=`) |

### Bridges, and what stays attached (`bridges.ts`, `sheetPieces.ts`)

A laser cannot hold a part with tabs — a tab is material left at the bottom of a
cut, and a beam goes through or it does not — so the only way to keep a piece
attached is to leave part of the line unburnt. Off by default: a part dropping
onto the honeycomb is the ordinary outcome of a laser cut.

| Value | Where | Basis | Source |
|---|---|---|---|
| Bridge width = `thickness / 3`, clamped to 0.8–2.5 mm | `bridges.ts` | What a bridge must hold scales with thickness; what makes it usable is that a blade goes through it in one stroke, which is why the top of the range is a bound rather than a formula. 1 mm at the shipped 3 mm ply. | **Judgement** |
| `BRIDGE_SPACING_MM = 60`, `MIN_BRIDGES = 3` | `bridges.ts` | The same figures as the holding tabs, for the same reasons: not busywork on a big outline, three points rather than a hinge on a small one. | **Judgement** (mirrors the tab rule) |
| Fall-out lattice pitch 0.4 mm | `sheetPieces.ts` | Half the narrowest bridge worth leaving, so a bridge is never lost to rounding and reported as a piece that drops. Error is half a cell — far below anything here can cut. | **Derived** (from the bridge minimum) |
| A piece is ≥ 1 mm² **and** ≥ 3 cells across | `sheetPieces.ts` | Area alone does not separate a piece from an artefact: a 3 mm registration plug is 7 mm² and really does drop out, while the strip between two contours half a millimetre apart can be long enough to beat any area bar. What artefacts share is being one or two cells thick. | **Derived** (from the pitch) |

### Editing snaps (`geom.ts`)

These change the drawing rather than the toolpath, but they change it silently,
so they are registered on the same terms as `beautify.ts`'s tolerances.

| Value | Where | Basis | Source |
|---|---|---|---|
| `ROTATION_STICKY_DEG = 4` | `geom.ts` | Almost every rotation is reaching for square — a part squared to the stock, a label turned to read up the side. 89.4° is indistinguishable on screen and wrong on the material, where the part stops lining up with the sheet or with the piece it mates to. Four degrees is wider than a hand's error at any usable zoom and narrow enough that a deliberate 85° is still reachable by aiming; Alt is a hard bypass. | **Judgement** |
| Resize snaps the *dragged handle* to the grid, not the pointer delta | `snapHandleDelta`, `geom.ts` | Rounding the delta only lands on the grid if the shape already started there, which is the one case where snapping was not needed. Snapping the handle means a box dragged out on a 10 mm grid is a whole number of squares — which is what makes two parts drawn on the same grid fit each other. | **Derived** |

### Join into one piece (`joinPieces.ts`)

Editing values, like Make Pretty's: they change the drawing at the operator's
request. Registered because what they decide is how much metal holds a letter
onto a pendant.

| Value | Where | Basis | Source |
|---|---|---|---|
| Bridges chosen by minimum spanning tree over closest-point gaps | `spanningBridges` | The fewest bridges (pieces − 1) and the least added material that make everything one piece. A left-to-right chain bridges an i's dot to the next letter; the tree finds its stem because that is nearest. | **Derived** |
| Bridge width = `0.85 ×` the thinner piece's mean stroke (`2 × area / perimeter`) | `BRIDGE_STROKE_FRACTION` | A bridge as heavy as the lettering reads as part of it. The mean stroke is exact for a strip of constant width and slightly heavy for a thick-and-thin script, hence a little under 1. | **Derived** (the stroke measure), **Judgement** (0.85) |
| `MIN_BRIDGE_MM = 1` | `joinPieces.ts` | The bridge is all that holds a letter on. Under a millimetre of 1.5 mm aluminium bends when a pendant catches, and a laser kerf takes a tenth or two off each side. | **Judgement** — unverified against material |
| Fillet radius `0.6 ×` bridge width, applied per junction only | `FILLET_FRACTION`, `filletAt` | Rounds the bar into the stroke so it reads as drawn, not repaired; also leaves no inside corner tighter than the radius for a router to fail to reach. Local, because a closing of the whole word fused neighbouring letters and filled their inside corners. | **Judgement** |
| New holes under `4 × width²` filled | `joinElements` | A pocket the bar closed off between two near-touching strokes: not a feature anyone drew, and narrower than any cutter that would have to clear it. Holes the drawing had are never filled. | **Judgement** |

### Packing parts onto stock (`packParts.ts`)

| Value | Where | Basis | Source |
|---|---|---|---|
| `PART_CLEARANCE_MM = 2` | `packParts.ts` | What is left standing between two packed parts once both kerfs are taken out. Two jobs: it is more than the positioning error of a belt-driven hobby gantry, so parts nested this close cannot cut into each other; and it leaves a rib of material rather than a hairline, so the sheet is still one piece while the rest of the job runs. | **Judgement** |
| Gap between parts = kerf + clearance (laser) | `partGapMm`, `packParts.ts` | The beam takes half its slot from each side of the line, so the kerf is spent once between two parts. | **Derived** (from `readLaserKerf`) |
| Gap between parts = cutter diameter + clearance (router) | `partGapMm`, `packParts.ts` | A cut runs a radius outside the part and the tool sweeps a radius wider again. At less than one whole diameter between two parts, the cutter going round one machines into its neighbour. | **Derived** (from the tool) |

## 7. Geometry tolerances

These are a **shared budget**, not per-module choices. Flattening and arc fitting
are meant to total under 0.05 mm from the drawn shape.

| Value | Where | Basis | Source |
|---|---|---|---|
| Chord tolerance 0.02 mm (flattening) | `pathFlatten.ts` | Below what any machine here positions to. | **Judgement** |
| Arc fitting tolerance 0.02 mm | `arcFitting.ts` | Half spent collapsing straight runs. | **Judgement** |
| `CLIPPER_SCALE = 1000` (1 µm quantum) | `contourOffset.ts` | Three orders finer than any machine here positions to, and G-code is emitted to three decimals anyway. | **Derived** |
| `MIN_FEATURE_MM = 0.05` (boolean sliver removal) | `booleanOps.ts` | Equal to the tolerance budget above: a feature thinner than the app's own geometric error is indistinguishable from it, and nothing here can cut it. | **Derived** (from the budget) |
| `OVERLAP_TOLERANCE_MM = 0.05` | `dedupeOverlaps.ts` | Above the 0.02 mm chord tolerance so two copies of one curve land on the same key; below anything a hobby machine positions to. | **Derived** |
| `SPLINE_FIT_TOLERANCE_MM = 0.005` (DXF import) | `dxfImport.ts` | A DXF SPLINE is an exact curve the CAD tool defined, not a hand's wobble to be smoothed: the importer is re-describing it, so its own error must disappear inside the 0.05 mm budget the flattener and arc fitter share rather than claim a share of it. A tenth of the budget leaves the imported curve indistinguishable from a drawn one. | **Derived** (from the budget) |

### Make Pretty (`beautify.ts`)

These are **editing** tolerances and deliberately sit outside the budget above.
They apply to the drawing, at the operator's request, before the planner ever
sees it — the same category as the image tracer's simplification, which is also
a fidelity choice rather than a machining one. They are listed here because the
drawing is what reaches material, and because a value that decides a hole is
"really" a circle is a value someone should be able to argue with.

Every one is a fraction of something the drawing itself supplies. Hand wobble
scales with what is being drawn, so an absolute figure in millimetres is wrong
at one end of the range or the other.

| Value | Where | Basis | Source |
|---|---|---|---|
| `WOBBLE_FRACTION = 0.025` of a shape's bbox diagonal | `beautify.ts` | ~1 mm on a 30 mm shape, which is an unsteady mouse line at normal zoom. Clamped to 0.1–3 mm. | **Judgement** |
| `POLYGON_FIT_MARGIN = 0.35` | `beautify.ts` | The simplifier *guarantees* its output is within tolerance, so "within tolerance" is no evidence of corners. A shape with real straight sides fits them to its own wobble, a fraction of the tolerance. Set from the failure: an ellipse claimed as a ten-gon. | **Derived** (from what RDP guarantees), **Judgement** (0.35) |
| `CIRCLE_RMS_FRACTION = 0.09` of the fitted radius | `beautify.ts` | An **RMS**, not the furthest point: a drawn circle is lumpy the whole way round and usually has one flat worse than the rest. Judging it by its single worst point meant next to nothing anyone drew came back a circle. | **Judgement** |
| `CIRCLE_MAX_FRACTION = 0.25` | `beautify.ts` | The worst point still has a veto, so one spike cannot be averaged into acceptability. | **Judgement** |
| `CIRCLE_ASPECT = 1.2`, `ELLIPSE_RMS_FRACTION = 0.07` | `beautify.ts` | What separates a circle drawn badly from an oval drawn deliberately. Deliberately generous: a round shape drawn freehand is wider than it is tall as often as not, and a circle is what was meant. Having the second reading is what makes the loose circle test safe. | **Judgement** |
| `CLOSE_GAP_FRACTION = 0.15` of the stroke's own **length** | `beautify.ts` | Did the hand come back round to where it set off? Against length, not the bounding box, so a long thin shape and a round one are asked the same question. A half circle's ends are two thirds of its length apart and stay open, as does anything missing more than about a sixth of itself. Judging closure at the wobble tolerance left almost every drawn outline "open", which excluded it from shape matching entirely. | **Derived** (from the geometry of an open arc), **Judgement** (0.08) |
| Tail trim: first/last step > 3× the median step **and** turning > 40° | `beautify.ts` | Both conditions, never length alone, or the deliberate long first stroke of an L would go. Set from the fluid pencil's old grid-snapped end points, which left a tick of up to half a grid square. | **Derived** (from the failure), **Judgement** |
| Overshoot cut: crossings searched in the first and last quarter of a stroke | `beautify.ts` | A hand drawing a circle comes round and keeps going, leaving a tail. Cutting both ends at the crossing closes it exactly. Bounded to the two ends so a shape that genuinely crosses itself in the middle — a figure of eight — is left alone. | **Derived** |
| `SPIRAL_MIN_TURNS = 1.4`, `SPIRAL_RMS_FRACTION = 0.08` of the mean radius | `beautify.ts` | Below 1.4 turns a stroke is an arc, not a spiral, and the fit would have almost nothing to go on. The same figure is what stops a multi-turn stroke being called a closed outline: its two ends are near each other because it wound, not because it met. | **Judgement** |
| `IDEAL_FIT_TOLERANCE_MM = 0.05` | `beautify.ts` | The *only* absolute figure here, and it applies to a curve this module computed rather than one a hand drew. There is no wobble in a fitted spiral to throw away, so it is reproduced to the app's own geometry budget instead of to the wobble tolerance — which on a large spiral is 3 mm. | **Derived** (from the geometry budget) |
| `SHAPE_MATCH_TOL = 0.14` (normalised RMS of two shape descriptors) | `beautify.ts` | Looser and one shape matches an unrelated one; tighter and two copies drawn by the same unsteady hand fail to match each other. | **Judgement** |
| `SIZE_EQ_TOL = 0.06`, `MAX_SIZE_CLUSTER_SPREAD = 0.25` | `beautify.ts` | Sorted sizes are cut where consecutive ones differ by more than the first; the second stops that chaining from walking a deliberately graduated series into one size. | **Judgement** |
| `NICE_RATIOS`, `RATIO_SNAP_TOL = 0.05` | `beautify.ts` | A deliberately smaller copy within 5% of a half, third or quarter was meant to be that fraction. Anything else keeps the size it was drawn at. | **Judgement** |
| `ANGLE_TOL_DEG = 7`, `ORTHO_SNAP_DEG = 4` | `beautify.ts` | What a hand misses a right angle, an even spacing or a parallel by, and no more. | **Judgement** |
| `ARRANGE_FRACTION = 0.07` of the arrangement's span | `beautify.ts` | Whether a ring of shapes is a ring depends on how big the ring is, not on millimetres. Clamped to 0.1–6 mm. | **Judgement** |
| `UNIFY_DRIFT_LIMIT = 0.3` | `beautify.ts` | The rebuilt outline may not sit further than this from the one drawn, or the alignment search got it wrong and the shape is refused rather than shipped. | **Judgement** |
| Ring fold search: `count`…`2 × count`, capped at 12; exactly `count` when `count === 3` | `beautify.ts` | At most half the ring may be missing, or the lattice fits anything. Any three points lie on a circle exactly, so with three shapes the spacing is the only evidence — they are a ring at 120° or they are a scatter. | **Derived** |
| Mirror pairs must be congruent to `SIZE_EQ_TOL`, and not concentric | `beautify.ts` | A reflection is the same size as what it reflects. Without it, three boxes of different widths stacked down a page — a left-aligned list — read as a mirrored pair plus a stray. | **Derived** |
| `FRAME_CENTRE_FRACTION = 0.15` of the enclosing shape's width or height | `beautify.ts` | Against the frame, not against the room the shape has to move in: a small hole 35 mm off centre has used up nearly all its room and by that reading looks as "nearly centred" as a line of text 9 mm out. Against the frame the two are 43% and 11%, which is the distinction wanted. Below about an eighth a wide line of text in a narrow border cannot be off by enough to be caught; above about a quarter the hole starts to look reachable. | **Judgement** |
| `FRAME_CONTAIN_FRACTION = 0.9` | `beautify.ts` | How much of a shape must be inside another before that one counts as its frame. Not all of it: a line of text nearly as wide as its border and pushed to one side pokes a hair past the edge, and that is precisely the drawing that wants fixing. | **Derived** (from the failure) |
| `SMOOTH_BLUR_TOLERANCES = 2` | `beautify.ts` | Smoothing blurs along the curve rather than decimating it. A Gaussian of σ pulls a curve of radius R inward by about σ²/2R, so two tolerances of blur costs about half a millimetre of a 3 mm tolerance on a 50 mm curve — well inside what it is allowed to spend. Decimation instead kept the drawing's worst excursions as corners. | **Derived** (σ²/2R), **Judgement** (2) |
| Smoothed outlines are fitted at `IDEAL_FIT_TOLERANCE_MM`, not at the wobble tolerance | `beautify.ts` | `fitCubics` emits a straight line for any run flat within the tolerance it is given. At 3 mm, a 16 mm stretch of a 67 mm arc counts as flat and comes back a chord — and a chord meeting a curve is a visible corner. The blur has already dealt with the wobble; spending accuracy here buys nothing but kinks. | **Derived** |
| Spiral lead-in: retried at 15% trimmed from either end | `beautify.ts` | A spiral is nearly always drawn with a tail where the pen arrived or left. It runs almost straight out from the shape, so the radius grows while the angle barely advances — the one thing a spiral never does — and it fails the whole fit. The full stroke is tried first, so the tail is only given up when it has to be. | **Derived** |
| `ALIGN_FRACTION = 0.06` of the median sibling box diagonal, capped at 8 mm | `beautify.ts` | Mutual alignment is only ever between siblings — shapes inside the same shape — because otherwise a 6 mm hole gets its edge lined up with the 82 mm border it sits in. | **Judgement** |
| A shared **centre** needs 2 shapes, a shared **edge** needs 3 | `beautify.ts` | Two shapes on a common centre line is a layout. Two shapes with a common edge is very often a coincidence. Missing an alignment is a much smaller failure here than inventing one. | **Judgement** |
| No alignment may create an overlap that did not exist | `beautify.ts` | Both lines of a stacked title are within tolerance of the middle of the tag; centring both vertically would put one on top of the other. | **Derived** |

### Image cutout (`imageProcessor.ts`)

Also editing tolerances, and also outside the budget: they decide where a
photograph's subject *ends*, and that boundary is then cut. A figure wrong here
does not drift a joint; it cuts through a shoulder or leaves the studio wall on.
Every one is in source pixels of a picture capped at 300 px on its long side,
so on a 100 mm import a pixel is a third of a millimetre.

| Value | Where | Basis | Source |
|---|---|---|---|
| Backdrop is the **median** of the border pixels | `applyCutout` | Most of a portrait's edge is backdrop; the shoulders that reach the bottom are the minority a median ignores where a mean would be pulled toward them. Overridable to white or black for a cluttered edge. | **Judgement** |
| `'any'` backdrop: per-channel median colour of the border, distance = largest channel difference | `colorDistanceFromBorder` | Measured before the picture is flattened to grey, or a green wall and a grey shirt are one tone. Largest channel rather than Euclidean so the tolerance keeps the meaning it has in grey. Less certain than white or black by construction, and offered as such. | **Judgement** |
| Backdrop extent is a **flood fill from the edge**, not a threshold | `applyCutout` | Set from the failure it prevents: a white shirt on a white wall thresholded as backdrop, cutting a hole through the chest. Only backdrop that touches the frame is backdrop. | **Derived** |
| `CUTOUT_TOLERANCE_MAD_FACTOR = 4` × the border's median absolute deviation | `applyCutout` | How unevenly the backdrop was lit is how far a backdrop pixel may stray. MAD rather than standard deviation for the same reason as the median above. | **Judgement** |
| `CUTOUT_TOLERANCE_MIN = 12`, `CUTOUT_TOLERANCE_MAX = 96` (of 255) | `applyCutout` | The floor admits JPEG ringing along a hard edge on a flat digital white, whose spread is zero; the picture is averaged down to 300 px first, which halves that ringing. Was 24, and at 24 the sky seen through a tinted sunglass lens counted as sky — the lens came out as a hole with a cut line round it. The ceiling stops a badly lit wall from being allowed to swallow a face. Overridable. | **Judgement**, floor set from a failure |
| Necks narrower than 2 × `cutoutSmoothPx` are sealed before the tidy | `sealNecks` | Black sunglass lens against a black backdrop, two levels apart by tone, joined to it through a one-pixel break in a bright frame. No tolerance can separate them; shape can — a plain backdrop has no pockets reached through threads. The backdrop is shrunk, re-flooded from the border, and grown back only into what the first fill reached. Same radius as the tidy pass: one decision about what "narrower than this" means. | **Derived** (from the failure), **Judgement** (sharing the radius) |
| `CUTOUT_ISLAND_FRACTION = 0.01` of the largest island | `dropIslands` | A fleck the fill went round becomes its own closed cut a millimetre across. Set from the same portrait: five such loops inside one lens. Two people in one frame are each far above it. | **Judgement** |
| `cutoutSmoothPx = 2` — radius of the open-then-close on the mask | `applyCutout`, `DEFAULT_IMAGE_OPTIONS` | A hair or a JPEG fringe one pixel wide traces as a spike a laser will cut, and a spike that narrow is a whisker of ply that breaks off. Open first, so a speck is gone before the close could glue it to a neighbour. Disc kernel, not box: a box leaves square corners on the cut line. Under Advanced. | **Judgement** |
| Neighbours outside the frame are skipped in the morphology | `morph` | Reading them as backdrop stripped a kernel's width off every edge of every picture — shoulders came back floating above the bottom of the frame. | **Derived** (from the failure) |

### Paint bucket (`floodFill.ts`)

The fill tool works on a raster of the drawing, so its constants are the
resolution of that raster. The boundary it produces lies under a stroke and
under a hatch, which is the most forgiving geometry there is; these are still
listed because the region's edge is where the hatch stops.

| Value | Where | Basis | Source |
|---|---|---|---|
| `FILL_PITCH_MM = 0.05` (fine pass) | `floodFill.ts` | The traced boundary sits on the lattice, within half a cell of the line: 0.025 mm, inside the shared 0.05 mm budget in this section. | **Derived** (from the budget) |
| `FILL_COARSE_PITCH_MM = 0.25` (locating pass) | `floodFill.ts` | Only has to find the region's box and any leaks; a 300×200 sheet is under a million cells. The fine pass is then confined to the coarse answer, which is what makes the fine pass leak-proof without a second seal. | **Judgement** |
| `FILL_SEAL_GAP_MM = 0.3` | `floodFill.ts` | Half a stroke width on the shipped presets: two hand-drawn lines meant to meet leave a sliver of this order, the same failure the boolean ops report. Wider is a doorway someone drew. | **Judgement** |
| `FILL_MAX_CELLS = 16 000 000` | `floodFill.ts` | Past this the fine pitch is coarsened rather than the worker left grinding; the result says what pitch it used. | **Judgement** |

### Eraser (`eraseMask.ts`)

The eraser decides what is *not* machined, so its one number reaches material by
omission rather than by being cut at. It is a drawing tool: the stroke's width
is editable per stroke in the inspector, and this is only where a new one starts.

| Value | Where | Basis | Source |
|---|---|---|---|
| `DEFAULT_ERASER_WIDTH_MM = 2` | `eraseMask.ts` | Four times the 0.5 mm stroke every shipped preset draws with: narrower than the line it is aimed at needs a steadier hand than a mouse has, much wider cannot be aimed between two lines of text. | **Judgement** |
| `MIN_ERASER_WIDTH_MM = 0.05` | `eraseMask.ts` | The shared 0.05 mm geometry budget in this section: a band thinner than the app's own geometric error masks nothing anything could rely on. | **Derived** (from the budget) |

### Registration holes (`registration.ts`)

Pin holes for stacking sheets. Placed from the stock by a rule rather than drawn,
which is what makes the same numbers on six documents land on the same
millimetre — the entire point of them.

| Value | Where | Basis | Source |
|---|---|---|---|
| 3 mm pin, three holes in an L | `registration.ts` | A dowel, brass rod or drill shank people already have. Three holes in an L cannot be rotated or mirrored onto themselves, so a sheet fits the pins one way only; two on a diagonal still fit turned end for end, and the dialog says so. | **Judgement** |
| Pin widened to `1.5 x` the cut tool on a router | `defaultRegistration` | A hole narrower than the cutter offsets inside to nothing and is dropped — six sheets with no holes in them, found at the glue-up. Half as much again is a hole the tool can go round rather than a full-width plunge. | **Derived** |
| 5 mm inset, ≥ pin radius + 1 mm | `registration.ts` | Inside the 10 mm border a framed picture usually carries, with material left round the pin so the edge does not tear out. | **Judgement** |

## 8. Machine dynamics and time

| Value | Where | Basis | Source |
|---|---|---|---|
| `ASSUMED_ACCEL_MM_S2 = 500` | `toolpathMoves.ts` | The shape of a small belt-driven hobby machine. Used for both the time estimate and the overscan length. | **Judgement** |
| `JUNCTION_DEVIATION_MM = 0.01` | `toolpathTimeline.ts` | GRBL's own junction-deviation concept: a corner is taken at the speed an arc of that sagitta holds. | **Documented** (GRBL planner), **Judgement** (0.01 as the machine's setting) |
| `BLOCKS_PER_SECOND = 450` | `toolpathTimeline.ts` | The controller's planning throughput, which is what makes ten thousand 0.03 mm moves slower than their length suggests. | **Judgement** |

> **The way to remove three Judgement rows at once:** the app already sends `$$`
> on connect and never reads the reply. GRBL reports `$110`/`$111` (max rate) and
> `$120`/`$121` (acceleration) per axis. Reading them would replace the assumed
> acceleration, the assumed gantry speed caps and the junction deviation with the
> machine's own settings — making the time estimate and the overscan length true
> for the machine in the room rather than for a typical one.

## 9. Controller facts we rely on

All **Documented**, from the GRBL v1.1 documentation (`gnea/grbl` wiki):

- Real-time override bytes: feed `0x90`–`0x94`, rapid `0x95`–`0x97`, spindle
  `0x99`–`0x9D`. Acted on immediately, not queued. (`webSerialManager.ts`)
- Overrides are reported back in the status report's `Ov:` field.
- No canned cycles: `G81`/`G83` are unsupported.
- `G10 L20 P1` sets a work offset that survives a reset; `G92` does not.
- Laser mode (`$32=1`): `S` changes apply without a planner sync; `M4` scales
  power with velocity.
- Spindle *state* changes (`M3`/`M5`) do sync the planner — which is why the
  overscan path never toggles them mid-fill.
- `G38.2` stops only when the probe input closes, and alarms (ALARM:5) if the
  search runs out first; the status report lists `P` in `Pn:` while the input
  is closed. So the circuit is proved by hand (seen closed once, and open now)
  before any probe, and `ZERO_SEARCH_MM = 10` bounds what an unproved circuit
  could cost — the tool is parked a few mm above the plate, so 10 covers it.
  (`webSerialManager.ts`) **Judgement** on the 10.

## 10. Generated patterns

`src/utils/livingHinge.ts`, `src/utils/perforation.ts`

A living hinge is a mechanism, not a mark: these numbers decide whether a panel
folds or snaps, and none of them has been cut in anger yet.

| Value | Where | Basis | Source |
|---|---|---|---|
| `MIN_ROWS = 3` | `livingHinge.ts` | The bend is shared between the rows. With one or two, all of it lands on a handful of beams and they tear. | **Judgement** |
| `MIN_SLIT_KERF_MM = 0.15` | `livingHinge.ts` | A cut narrower than the beam or bit is not a cut. Fragments below this are dropped rather than emitted as dots. | **Derived** |
| Alternate rows offset half a period | `livingHinge.ts` | Rows in phase leave continuous uncut lines straight across the hinge, and it does not bend at all. | **Derived** |
| No slit within one beam width of the region edge | `livingHinge.ts` | A slit that reaches the edge is a split, and the panel tears along it on the first fold. | **Derived** |
| Minimum bend radius = 2W / π for a right angle | `livingHinge.ts` | The width across the hinge becomes the arc: a 90° bend of radius r consumes r·π/2 of it. | **Derived** |
| Hinge layer is `cutSide: 'on'`, `tabs: false` | `livingHinge.ts` | A slit is an open cut with no inside to offset towards; offsetting makes every beam a kerf wider on one side and narrower on the other. A tab across a slit is a beam that was meant to be cut. | **Derived** |
| Resize re-plans the field rather than scaling it | `generatedField.ts`, `livingHinge.ts`, `perforation.ts` | A hinge and a grille are a spacing rule over a region, not a shape. Scaled, the beam width and the pitch scale with the box, so the field no longer matches the spec it was generated from — and nothing on screen shows it. Dragging a corner changes how many slits or holes fit, never how big they are. | **Derived** |
| Hex lattice by default | `perforation.ts` | At one pitch a staggered lattice leaves a wider web than a square one for the same open area — the stronger panel for the same air. | **Derived** |
| Perforation layer is `cutSide: 'inside'` | `perforation.ts` | A closed shape with nothing enclosing it reads to the planner as a disc to be cut out, so the tool would be driven round the outside and every hole would come out a full tool-width oversize. | **Derived** |

The four ornament generators — guilloche, maze, animal print and vine
scrollwork — introduce no numbers of their own that reach material. They draw
onto a layer and that layer's speed, power and depth decide what happens, the
same as any other artwork. The one thing worth knowing is not a constant: an
animal print defaults to a **cut** layer, so the markings drop out of the panel.
That is what a cut-out coat is, and the dialog and the MCP tool both say it.

---

## Sources

- **Machinery's Handbook** (Industrial Press, 31st Edition) — standard milling
  speed and feed definitions (`feed = rpm × flutes × chipload`), surface speed
  relationships (`Vc = π × D × rpm / 1000`), and climb versus conventional
  milling dynamics.
- **Router and End Mill Tooling Guides**:
  - *Onsrud CNC Production Routing Guide* & *Amana Tool CNC Speed & Feed Charts* —
    published chip load per tooth by cutter diameter and material class for
    1/8" (3.175 mm) tools in wood, plywood, and MDF (0.003"–0.006" / 0.076–0.15 mm).
  - *Harvey Tool Speeds, Feeds & Ramping Guide* — chip loads for miniature end
    mills in non-ferrous materials (0.0005"–0.0012" / 0.013–0.030 mm in 6061
    aluminium on light CNCs) and entry ramp descent angle recommendations
    (1°–3° for end mills).
- **GRBL v1.1 Documentation and Wiki** — <https://github.com/gnea/grbl/wiki>
  (Sonny Jeon / gnea). Supported G-codes, non-support of canned drilling cycles
  (`G81`/`G83`), real-time override hex command codes (`0x90`–`0x9D`), work
  offsets (`G10 L20 P1`), and laser mode (`$32=1`, dynamic power `M4`, and
  non-syncing `S` power updates during `G1` motion).
- **Laser Materials Processing Fundamentals** (e.g. Steen & Mazumder, *Laser
  Material Processing*; *LIA Handbook of Laser Materials Processing*) — linear
  and areal energy density / fluence models (`J/mm` and `J/mm²`), constant
  velocity overscan kinematics (`d = v² / 2a`), and wavelength-dependent optical
  absorption (450 nm blue diode transparency in PMMA and silicate glass vs.
  10.6 µm CO₂ absorption; organic dye ablation in porous anodized aluminum).
- **CAM Pocketing Geometry and Tool Engagement** (Held, M., *On the Computational
  Geometry of Pocket Machining*, Springer) — contour-parallel offset pocketing
  versus zig-zag clearing for constant cutter engagement and perimeter wall
  finish passes.
- **Clipper / Clipper2** (Angus Johnson) — polygon clipping and offsetting using
  64-bit integer coordinate space (`CLIPPER_SCALE = 1000`, 1 µm quantum) for
  robust, non-drifting kerf compensation, booleans, and pocket rings.
- **Ramer–Douglas–Peucker Algorithm** (Ramer 1972, Douglas & Peucker 1973) —
  polyline simplification and chord tolerance reduction (`pathFlatten.ts`).
- **Marching Squares Algorithm** (Lorensen & Cline 1987, Maple 2003) — 2D
  isocontour extraction and raster boundary vectorization (`imageProcessor.ts`).
- **Dithering Kernels** — Floyd & Steinberg (1976), Jarvis, Judice & Ninke (1976),
  Stucki (1981), and Bayer (1973 ordered dither matrix) — standard published
  weights and integer divisors in `imageProcessor.ts`.

## What is not sourced at all

Stated plainly, because the alternative is implying otherwise:

1. **The entire laser dose model** (§5). Our estimates, no published basis.
2. **Machine dynamics** (§8). Assumed, and readable from the controller instead.
3. **Tab geometry** (§4). Judgement about what snaps by hand.
4. **Per-material chipload and stepdown values** (§1–2) — the *shape* is
   published, the specific figures are ours and chosen low.

None of these has been validated against cut material by this project. The
material test grid is the instrument for doing it; results belong back in this
file.
