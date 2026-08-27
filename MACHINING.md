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
| `MAX_CUTTING_FEED_MM_MIN = 4000` | `feeds.ts` | Not a cutter limit — a hobby-gantry one. Belt drives lose steps and round corners before the tool is in trouble. Raised from 2500 because it was binding on the commonest job (ply + two-flute 1/8"), and the code responds to a clamped feed by *lowering RPM* to hold chipload, which cut at 15,600 RPM where the material wanted 18,000. | **Judgement** |
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
