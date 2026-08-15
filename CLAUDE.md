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
- Path data is flattened by `pathFlatten.ts` at `CURVE_STEPS = 24` points per
  curve. Emitting a path with a million commands means 24 M points downstream, so
  anything that *generates* paths must simplify before handing them over.

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

## Machine control

`src/utils/webSerialManager.ts` is a singleton talking GRBL 1.1 / FluidNC /
grblHAL over Web Serial (Chromium only). It owns the status poll, the job stream,
jogging, probing and the pause/resume protocol.

- Work origin is set with `G10 L20 P1`, not `G92` — a real work offset rather
  than a temporary shift, so it survives a reset.
- The operator's workflow is home → jog → zero XY → (CNC) touch off Z. Homing is
  the step beginners skip; without it machine coordinates are wherever the
  machine happened to be switched on.
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

## House style

The comments in this codebase explain **why**, usually by naming the failure the
code prevents — often a real one that reached material. Match that. A comment
that restates the code is noise; a comment that says "this used to mirror the job
about the X axis" earns its place. Terse `// set x` comments are not the
convention here.

Tests live in `tests/` and are plain vitest, no DOM harness for most of them —
they exercise the utils directly. Geometry, feeds, toolpath and coordinate
conversion all have real coverage; components mostly do not.
