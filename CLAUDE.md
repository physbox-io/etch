# Physbox Etch

Browser CAD/CAM for a hobby laser cutter or CNC router. You draw vectors on a
piece of stock, assign them to layers that carry cutting parameters, and the app
plans a toolpath and streams G-code to a GRBL controller over Web Serial.

React 19 + TypeScript + Vite + Tailwind 4, zustand for state. No backend for the
core app — everything runs in the tab.

```
npm run dev      # vite, plus the MCP bridge websocket (see below)
npm run build    # tsc -b && vite build
npm test         # vitest run
npm run lint     # eslint
```

`npm run lint` currently reports ~55 pre-existing errors on a clean tree. Check
the count before and after your change rather than trying to reach zero.

Every number that decides what happens to material — a feed, a depth of cut, a
laser power, a peck depth, a tolerance — is registered in **`MACHINING.md`**,
with what it is, why, and how well it is sourced. Adding a machining constant
means adding a row there: a magic number that reaches material with no line in
that table is exactly what it exists to prevent. It is also the honest list of
what this app has *not* validated against cut material.

## The one thing to understand first: coordinate spaces

There are three, and confusing them is the source of the worst class of bug here
— the kind that only shows up on real material.

1. **Document space** — millimetres, SVG convention, **Y increases downward**
   from the top-left of the stock. Every element's `x`/`y`, every path `d`, the
   canvas, and the toolpath planner all live here.
2. **Machine space** — millimetres, GRBL work coordinates, **Y increases away
   from the operator** from a front-left origin. Only G-code and things sent to
   the controller live here.
3. **Screen space** — the canvas SVG is document space scaled by a viewBox and
   then CSS-transformed by `pan`/`zoom`.

`src/utils/machineCoords.ts` is the only legal border crossing. `doc.origin`
(`'top-left' | 'center' | 'bottom-left'`) decides the mapping. **Everything the
machine is told must go through `docToMachine` / `boundsToMachine`** — toolpaths,
framing bounds, probe grids — or those things disagree with each other on the
bed. `machineToDoc` is the inverse, and exists for putting the controller's
reported position back on the drawing during a job.

Symmetric geometry survives a Y-flip unnoticed. Text does not, which is how the
original bug was found. If you are debugging "the job came out mirrored" or "the
job came out in the wrong place", start here.

For screen↔document, read the live CTM (`EtchCanvas.tsx`). Do not assume the
viewBox maps linearly onto the element's bounding rect — `preserveAspectRatio`
letterboxes it and the pan/zoom transform sits on top.

### Stock size and geometry are independent

`setDocumentSize` deliberately does **not** rescale or move geometry: the drawing
is in millimetres against real material, and silently scaling a 40 mm hole
because the board got wider would be wrong on a machine.

The consequence is that shrinking the stock leaves art outside it. Three things
guard this and all must keep working:

- `EtchCanvas` sizes its viewBox to the **union of the stock and all visible
  content**, so off-stock geometry pulls the view out to include itself. An SVG
  root clips to its viewBox; sizing it to the stock alone makes the canvas lie
  about what is in the document.
- `isOutsideStock` / `bedBoxOfAll` (`src/utils/geom.ts`) flag strays, drawn as
  red dashed boxes on the canvas and emitted as a note by `planToolpath`.
- `clipToStock.ts` trims the *planned path* — not the drawing — to the stock
  rectangle at the end of `planToolpath`, so the tool only ever travels where
  there is material. The drawing is untouched, the elements are still there, and
  the plan says how many paths were shortened or left out entirely.

It trims and says so; it never silently drops. The unit is the path, not the
element, because one traced image is a single compound path and "skip the
elements that are off the stock" would throw the whole picture away. See
`tests/clipToStock.test.ts` and `tests/offStock.test.ts`.

Note that **every shipped preset is 300×200 mm**, so any hardcoded position like
`150, 100` is "the centre of the bed" only by coincidence and is off the material
on anything smaller. Derive placement from `document.width/height`.

## State

`src/store/useStore.ts` — one zustand store holding a single `EtchDocument` plus
UI state. There is no per-document undo stack; `history` is an array of whole
document snapshots with `historyIndex`.

The convention that matters:

- **`transient: true`** on `updateElement` / `setStockThickness` / `updateLayer`
  writes the document *without* pushing history. Use it for anything that fires
  per frame of a drag or per keystroke in a number field, then call
  `commitHistory()` on mouse-up or blur. Otherwise one drag buries the undo stack
  under hundreds of entries, and typing "12.5" leaves undo standing at `1`.
- **View settings write straight to the document with no history entry** — grid
  size, snap, document size. Editing them should not be undoable.
- **`setDocument` resets history entirely.** It is for loading a preset or an
  imported file. Do not use it for an edit — several bugs have come from a
  feature calling it and making itself un-undoable.

Presets are module-level objects; `loadPreset` clones them, or every later edit
would be an edit of the preset itself. `sanitizeDoc` runs on every entry point
(preset load, JSON import, MCP) to repair documents written by older builds.

## Geometry

`src/utils/geom.ts` is the shared truth about where a shape is. The SVG render
transform, the selection overlay and the G-code exporter all go through it, which
is what stops a rotated shape drifting away from its own selection box.

- `getLocalBBox(el)` — the element's own untransformed space. Memoised in
  `bboxCache`, keyed by id with the identity fields compared **individually**.
  Do not "tidy" that into a single concatenated key string: it is called per
  element on every render and every mouse move, and building
  `` `${el.id}:${el.d}:…` `` copies the whole path — megabytes, for a traced
  image — on cache hits too.
- `getBedBBox(el)` — the above run through translate/scale/rotate into document
  millimetres. This is usually the one you want.
- `bedBoxOfAll(els)` — union box, shared by the selection overlay and the canvas
  viewBox so the two cannot disagree about where content is.

## Editing geometry

`src/utils/booleanOps.ts` — union / subtract / intersect / exclude, in the
sidebar when two or more elements are selected. It samples elements through
`elementContours.ts`, the same bed-space sampler the toolpath planner uses, so a
combined shape is exactly what would have been cut; the result is a plain `path`
with the transform baked in, because a union of a rotated rect and an unrotated
circle has no single rotation to inherit. The first-selected element is the key
object (as in `centerSelected`), and it is the one `subtract` cuts into.

Two fill rules, and both are load-bearing: even-odd *within* an element, so a
traced glyph's counter stays a hole, then non-zero *between* elements, or two
overlapping squares would "union" to a square with a hole in the overlap.

`src/utils/beautify.ts` — the "Make Pretty" button, next to the boolean ops in
the sidebar. It regularises a hand-drawn selection in four passes, and the order
is load-bearing:

1. Recognise each outline as the primitive it was trying to be — circle,
   ellipse, rectangle, regular polygon, straight line, spiral — or smooth it.
2. Make lines that were meant to be parallel parallel, and square them to the
   grid when they are nearly there.
3. Find the shapes that are *the same shape* — at any size, angle or handedness
   — unify them onto one outline, and check the group for an arrangement (a ring
   about a common centre, an even row, a mirror axis) to snap onto exactly.
4. Line up whatever is left: centre a shape in the shape drawn around it, and
   bring near-equal edges and centres onto one line.

`beautifyElements(selection, context)` takes the rest of the drawing as
`context`: never modified, but read, so that selecting two lines of text and
pressing the button centres them in the border they sit inside. Nobody selects
the border to do that, and without it the button looked like it did nothing.

Nothing in it knows about any particular kind of drawing. Everything is
"shapes"; the flowers and keychains in the comments are the failures the rules
were set from, not cases the code tests for.

- It never adds or removes an element. Every element comes back with its own id,
  layer and place in z-order, which is what makes it one undo with the selection
  intact.
- Shapes are compared by a **radial descriptor** — the distance from the
  centroid at 64 equal angles, divided by the shape's own RMS radius — so
  matching is scale- and rotation-free by construction and a mirror needs no
  axis to be guessed. Every measurement is taken from an outline re-spaced
  evenly along its own length (`resampleByArc`); measuring the points as they
  arrive makes a five-point rectangle "smaller" than an ellipse inside it.
- A near-symmetrical shape matches itself at several angles. The group picks the
  reading that makes it *a group* (`consensusTurns`), preferring one handedness
  throughout — letting each shape choose for itself left a ring whose members
  each leaned a different way while every individual choice was defensible.
- A group's outline is smoothed **once**, normalised, and then transformed per
  member — cubic control points transform affinely. Smoothing each rotated copy
  separately gave copies that were each a slightly different shape, which is the
  one thing the pass exists to prevent.
- Closure is judged against the stroke's own length, generously: a hand rarely
  comes back exactly to where it set off, and a shape counted as open has no
  interior to describe and so cannot be matched to anything. A hand that goes
  *past* the start instead leaves a tail across the top, and `closeAtCrossing`
  cuts both ends where they cross — the two ends only, so a figure of eight
  survives.
- A spiral is checked for before anything else, because it is neither open in
  the way a stroke is nor closed in the way an outline is, and every other test
  reads it as a bad version of something else — including the closure test,
  which would otherwise join the two ends of a three-turn spiral. The radius is
  fitted against the unwrapped angle, both steady-per-turn and multiplying-per-
  turn, and the centre is searched for rather than assumed: a spiral's centroid
  sits well outside its eye, pulled there by the outer turns.
- Smoothing **blurs along the curve**; it does not decimate. Douglas–Peucker is
  a decimator — it keeps the points that stick out furthest — so fitting through
  what it leaves gives long flat runs meeting at visible angles. `smoothPolyline`
  resamples evenly and runs a Gaussian along the arc instead.
- Everything emitted is then fitted at `IDEAL_FIT_TOLERANCE_MM` rather than at
  the wobble tolerance. Two different questions — how much of the drawing is
  hand, and how faithfully to reproduce what is left — and answering both with
  one number is what made the second answer badly: `fitCubics` calls any run
  flat within its tolerance a straight line, and at 3 mm that is a sixteen
  millimetre stretch of a gentle arc.
- Lines get their own pass for the same reason — no interior, no descriptor —
  and because a line's direction lives in `x2`/`y2` rather than in `rotation`.
- Every tolerance scales off the drawing rather than being a figure in
  millimetres, and they are editing tolerances: they are outside the 0.05 mm
  machining budget below, and registered separately in `MACHINING.md`.
- The guard tests in `tests/beautify.test.ts` matter as much as the positive
  ones. A scatter must stay a scatter, a key-ring hole must stay off-centre, an
  alignment must never create an overlap, and text and images are moved but
  never re-shaped.

## Toolpath and G-code

`src/utils/gcodeExporter.ts` is the big one. The pipeline:

```
planToolpath(doc, opts)   → { segments, skipped, notes }   -- document space
  planMoves(segments)     → { moves, toolChanges, notes }  -- toolpathMoves.ts
    generateGCode(...)    → string                         -- converts to machine space, once, on the way out
```

Moves are planned in **document space** so the preview can draw them exactly as
the canvas does; `docToMachine` is applied once during emission. Keep it that
way — a preview that does its own conversion will drift from the file.

- `skipped` is geometry that could not be cut. `notes` is everything the planner
  had to compromise on, plus warnings (score-line risk, unmarkable material,
  off-stock geometry). Both surface in the G-code header comments and in the
  preview panel. Prefer adding a note over failing silently.
- Layers carry `operation: 'cut' | 'etch' | 'fill' | 'shade'`, and elements carry
  `machining: 'outline' | 'filled'`. `fill`/`filled` routes through
  `hatchFill.ts`; cut side and kerf compensation through `contourOffset.ts`
  (Clipper); `shade` through `rasterImage.ts` (below). Shading sorts with the
  fills — it is surface work, and must happen before anything releases the part.
  For feeds it *is* a fill: `feedsOperation()` maps it, rather than adding a
  fourth column to the material tables that would have to be kept in step.
- Feeds/power are **derived, not stored**: `feeds.ts` has `deriveFeeds` (CNC) and
  `deriveLaserFeeds` + `laserRefusal` (laser), from the material, the stock
  thickness, and the machine. A file opened on a different machine derives that
  machine's numbers rather than inheriting the author's.
- Path data is flattened by `pathFlatten.ts` to a **chord tolerance**, not a
  fixed step count: a curve gets the segments its own size and curvature need.
  A fixed count was both wasteful on small curves and inaccurate on large ones,
  and it is what turned a traced outline into tens of thousands of 0.025 mm
  moves — short enough that a controller runs out of blocks to process before
  the axes reach the feed rate. Anything that *generates* paths must still
  simplify before handing them over; `simplifyPolyline` in the same file is the
  shared Ramer–Douglas–Peucker used by the tracer and the arc fitter alike.
- **Tolerances are a shared budget, not a per-module choice.** Flattening
  (0.02 mm) and arc fitting (0.02 mm, half of which it spends collapsing
  straight runs) are meant to total under 0.05 mm away from the drawn shape.
  A third stage that picks its own generous figure spends the budget a fourth
  time and the drift starts showing up on fitted joints. The image tracer's
  simplification is the one deliberately outside it — it is a fidelity choice
  about a photograph, and it is a slider under Advanced in the import dialog.
- **On a router, a cut is two passes and a pocket is rings.** `pocketOffset.ts`
  clears an area with contour-parallel rings, innermost first, because a zig-zag
  drives the cutter into the wall at full width twice per line — the engagement
  swings between a stepover and a full slot, which is chatter and a short tool
  life. A laser keeps hatch lines: it has no side load, and the scan *is* the
  picture. A through-cut is roughed wide of the line and finished with one light
  lap at it (`finishAllowanceFor`), because a loaded cutter deflects and springs
  back; the finishing lap carries the tabs, since it is the pass that frees the
  part, and it curves onto the wall along a tangent arc in waste (`planLead`)
  rather than driving straight at it and leaving a dwell mark. A round hole
  within a tenth of the cutter's own diameter is **drilled** — pecked as
  explicit plunges and retracts, because GRBL implements no canned cycles — and
  only when it is enclosed by another contour, since a lone small circle is a
  disc to cut out and drilling it would destroy the part. All four are derived,
  not asked: see `MACHINING.md`.
- `dedupeOverlaps.ts` cuts a line two shapes share **once**. A doubled laser
  line burns through thin ply where the rest of the outline does not, and a
  doubled router pass drops the cutter full depth into a slot that is already
  air. On by default (`removeOverlaps`), and deliberately blind to fills,
  shading, tabbed cuts and anything on another layer — in each of those the
  repetition either is the job or is a decision the planner cannot make.
- `travelOptimization` (0–3, in the export dialog's advanced options) shortens
  the hops between **etched** paths only. Cuts keep inner-before-outer order
  because an outline releases the part; hatch fills and shaded sweeps keep
  theirs because the order *is* the fill. Closed paths may be re-entered at
  their nearest point but are never reversed — direction is climb versus
  conventional on a router. See `tests/travelOptimize.test.ts`, which is mostly
  guards against a future "just reorder everything".

## Laser vs CNC

`document.machine` (`'laser' | 'cnc'`, **defaulting to laser**) decides a lot of
both behaviour and vocabulary. Use the helpers in `src/utils/tooling.ts` rather
than re-deriving it:

- `machineKind(doc)` — the accessor. Six components each had their own inline
  `(document.machine ?? 'laser') === 'laser'`, and the default had already
  drifted in `webSerialManager`, which made laser jobs narrate tool changes.
- `hasToolCatalog(machine)` / `toolCatalog(machine)` — a laser has an
  intentionally empty tool catalogue, which is how "this machine has no tools to
  change" is expressed. Laser jobs never emit `T` words or `M6` pauses.
- `hasJobZAxis(machine)` — the capability that gates most CNC-only UI: touch
  plates, bed heightmaps, safe-Z retracts, depth per pass, holding tabs. A laser
  focuses once by hand and its Z never moves during a job.
- `machineWords(machine)` — the noun table (`head`, `cutter`, `power`, `machine`,
  `intensity`) for prose. "Touch off Z" and "while the cutter is lifted to safe
  Z" are nonsense on a laser, and a beginner following instructions for a machine
  they do not own is exactly who this app is for.

`materialNote(material, machine)` in `materials.ts` is the older precedent for
machine-keyed prose. `MachineWorkOriginPanel` takes `showZProbe` and `machine`
props — **pass them**; it shipped for a long time with nothing passing
`showZProbe`, so its `= true` default won and laser users were shown a touch
plate.

`testGrid.ts` builds the grid of squares you cut on a scrap before the job: one
layer per cell carrying an explicit `speedOverride`/`powerOverride` (laser) or
`feedOverride`/`rpmOverride` (router), so the sweep goes past what `feeds.ts`
would have chosen — including the parts of the range it would refuse. It keeps
the stock and material of the document it was generated from, because a test cut
for the wrong material tests nothing. Reached from the preset dropdown under
Generators.

## Machine control

`src/utils/webSerialManager.ts` is a singleton talking GRBL 1.1 / FluidNC /
grblHAL over Web Serial (Chromium only). It owns the status poll, the job stream,
jogging, probing and the pause/resume protocol.

- Work origin is set with `G10 L20 P1`, not `G92` — a real work offset rather
  than a temporary shift, so it survives a reset.
- The operator's workflow is home → jog → zero XY → (CNC) touch off Z. Homing is
  the step beginners skip; without it machine coordinates are wherever the
  machine happened to be switched on.
- Feed, rapid and power can be trimmed **while the job runs** (`JobOverridePanel`),
  via GRBL's real-time override bytes. Those bytes are 0x90 and up, which is why
  the serial writer sends raw `Uint8Array`s rather than going through a
  `TextEncoderStream` — UTF-8 turns each of them into two bytes and the
  controller ignores the pair. The percentages shown come from the controller's
  own `Ov:` field, never from a tally of what was clicked.
- A job that pauses for a tool change needs Z re-zeroed against the *new* tool's
  length. `jobMachine` exists so the pause prompt can name what to reach for.

## The MCP bridge

`vite-plugin-mcp-bridge.ts` runs a websocket server in the dev server that
relays between "controller" clients and "browser" clients;
`src/hooks/useMCPBridge.ts` is the browser end, and the store is exposed as
`window.__ETCH_STORE__`. This is how an agent (or a browser-driven test) loads
presets, adds elements and reads the document. Dev only.

## Images and SVG import

- `svgImporter.ts` — `fitToBed(elements, bounds, bedW, bedH)` scales and centres
  imported artwork onto the stock. Reuse it; it is the strongest existing
  primitive for "make this fit".
- `imageProcessor.ts` — raster to vector. Downsamples to 300 px max, then traces
  with marching squares, halftone dots, or scanlines. Everything is synchronous
  on the main thread and there are no workers, so **anything here that is
  accidentally superlinear reads to the user as the app hanging**. The contour
  walker is edge-based (each lattice edge consumed once) specifically so it is
  linear and guaranteed to terminate; `tests/imageTrace.test.ts` guards both the
  loop counts and the runtime. Output is always one compound `path` element, and
  it is simplified with Douglas–Peucker before emission because a marching-
  squares outline is a per-pixel staircase.

  Brightness, contrast, gamma and invert are applied to the greyscale before any
  of the four modes see it. **Dithering** (Floyd–Steinberg, Jarvis, Stucki,
  ordered 8×8) is `shade`-only: it turns the picture into black-and-white dots
  fired at one power, which is the answer for a machine that cannot hold a
  steady low power — a diode laser marks the same at 8% and 12%, so a
  photograph's shadows collapse into one flat grey. A dithered picture *is* its
  dots, so the sweep pitch has to match the pixel size or the sweeps sample the
  dots at random; the dialog offers the matching pitch when it does not.

### Shaded images — tone, not shapes

The three modes above all decide at import that a pixel is either cut or not.
The fourth, `shade`, does not: it puts the processed greyscale into the document
as an `image` element (base64 bytes in `imageGray`, `imgW`/`imgH` the grid,
`w`/`h` the size on the material) and lets darkness reach the machine as
something that varies *along* a move.

- `rasterImage.ts` sweeps the pixels into `ShadeRun`s — serpentine lines at
  `hatchSpacing` pitch and `hatchAngle`, each carrying an intensity per point.
  Runs break where the picture goes white, and a held tone is carried until it
  actually changes, or a photograph's sky would emit one move per sample.
- `GCodeSegment.intensities` is what marks a segment as shading, parallel to
  `points`. `planMoves` branches on it: laser power becomes `seg.power ×
  intensity` per move, and a router's Z becomes `-zDepth × intensity`, clamped
  per pass to that pass's stepdown floor — which is what roughs a deep relief in
  stages instead of taking it in one bite.
- The emitter uses **M4, not M3**, for shaded moves, and rides `S` on the motion
  line. M3 holds power through the accelerations of thousands of short moves and
  burns the ends of every line dark; M4 scales it with actual speed.
- Anything that rewrites segment points must rewrite the intensities with them —
  `clipValuedPolylineToStock` exists because trimming the geometry alone would
  leave the right shape carrying the wrong photograph.

The element keeps the pixels rather than a baked toolpath specifically so pitch,
angle, depth and size stay editable after import. An image on a non-`shade`
layer is skipped with a note: "cut this photo out" and "engrave it as tone" are
different jobs and only one is ever meant.

Job time in `toolpathTimeline.ts` is a trapezoidal model with junction speeds
and a block-rate floor, not `distance / feed`. The naive figure says ten
thousand 0.03 mm moves take as long as one 300 mm move at the same feed, which
is wrong by several times on exactly the engraving jobs people most want a
number for. The constants at the top of that file are the shape of a small
belt-driven machine, not settings anyone has typed.

## House style

The comments in this codebase explain **why**, usually by naming the failure the
code prevents — often a real one that reached material. Match that. A comment
that restates the code is noise; a comment that says "this used to mirror the job
about the X axis" earns its place. Terse `// set x` comments are not the
convention here.

Tests live in `tests/` and are plain vitest, no DOM harness for most of them —
they exercise the utils directly. Geometry, feeds, toolpath and coordinate
conversion all have real coverage; components mostly do not.
