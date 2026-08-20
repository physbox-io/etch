---
name: clipart
description: Draw, occlude, check and ship symbols for the Etch clip art gallery. Use when adding clip art, reworking a symbol that looks muddy or blobby, or deciding whether to author SVG by hand, trace a raster, or outline a font glyph.
---

# Making clip art for the gallery

A symbol here is not an icon on a screen. It is stroked on the canvas and
machined as-is, so every line you draw is a line the machine will cut. That one
fact decides most of what follows.

## The medium

- **Line art, never fill.** Outlines and interior detail lines. A "filled
  silhouette with a knocked-out hole" comes off a plotter as two confusing
  concentric outlines.
- **100-unit box.** `viewBox: '0 0 100 100'`. A few legacy entries use a
  24-unit box; do not add more. Consumers scale by the viewBox
  (`getClipArtScale`), so never assume a unit size.
- **Stay in the box.** `tests/clipArtLibrary.test.ts` fails anything more than
  0.5 units outside it — it has already caught a crescent whose outer arc
  reached x = −0.9. Leave a few units of margin.
- **Mind the real size.** The default placement is 36 mm, so one design unit is
  0.36 mm. Two lines closer than about a unit read as one line on material, and
  detail finer than that is not worth cutting.

## Depth is what most drafts get wrong

If two parts of a symbol overlap, the part behind **must** be clipped against
the part in front. Draw both outlines in full and you get a Celtic ring running
straight across the cross arms, lotus petals with no idea which is in front, and
a khanda whose swords cross its own chakkar — the whole set reads as a Rorschach
blot rather than an object.

Author the symbol as a stack of solid shapes, back to front, and let
`tools/clipart/occlude.ts` remove the hidden edges:

```ts
// scratch/draft.ts — run with: npx vite-node scratch/draft.ts
import { occlude, circle } from './tools/clipart/occlude';
import { renderContactSheet } from './tools/clipart/contactSheet';

const d = occlude([
  { parts: [circle(50, 32, 22)], holes: [circle(50, 32, 14)] },   // ring, behind
  { parts: ['M44 4 H56 V26 H86 V38 H56 V96 H44 V38 H14 V26 H44 Z'] }, // cross, in front
]);
renderContactSheet([{ id: 'celtic-cross', viewBox: '0 0 100 100', d }], 'draft.png');
```

Each entry is one shape: `parts` are unioned, `holes` are cut out, `lines` are
open detail strokes (a filament, wrapper pleats, rib lines) that get clipped by
whatever is in front of them too. Parts of the *same* object — a torii's posts
and beams, an ankh's loop, stem and bar — belong in one shape, so the union
removes their shared edges and it reads as one solid thing.

Two `clipper-lib` traps, both already handled inside the tool but worth knowing
if you touch it: an open subject path that never meets the clip is silently
**dropped** (it ate a cocktail glass's liquid line), and a closed ring handed to
the open-path clipper **loses its closing edge** unless the first point is
repeated at the end.

The cost is that occluded art is polylines, not curves — a couple of kilobytes
of path data per symbol instead of a few hundred bytes. Worth it wherever parts
overlap; skip it for a symbol drawn as separate strokes that never cross.

## Draw with primitives, not with freehand curves

The seasonal set shipped once as hand-typed beziers and looked, accurately, like
a child drew it: spindly stick limbs, corners that were each a slightly
different shape, tangency that never quite met. Icons read as *made* when their
parts are exact. `tools/clipart/occlude.ts` exports the primitives to build
from — `circle`, `ellipse`, `roundRect`, `capsule`, `arcBand`, `blade`,
`midrib` — and the redraw that fixed the set was almost entirely those:

- a **capsule** is what a bone, a limb, a hat brim or a stocking leg actually
  is: two ends and one thickness, tangent by construction.
- an **arcBand** is a rib, a handle, a hanger loop — constant thickness swept
  between two angles.
- **overlapping ellipses** make a pumpkin's ribs, and because they are occluded
  the ribs are real edges rather than lines drawn across a flat oval.
- a **blade** is a leaf; `spiked` gives holly, whose sharp tips must be joined
  by *concave curves* — straight lines between spikes read as a lightning bolt,
  which is what three attempts looked like before the bays became curves.

Two more habits that separate a drawn icon from a sketched one: build the
silhouette from a few large shapes rather than many small ones, and keep one
shape language across a set — the same corner radius, the same limb thickness,
the same berry size.

## Draw, trace, or outline a glyph?

- **Geometric or mechanical** (stars, gears, crosses, wheels) — author the path
  directly, and compute the coordinates rather than eyeballing them. Star
  points, polygon vertices and spoke angles are trigonometry; typed-in
  approximations look typed-in.
- **Organic or dense** (a tree, foliage, anything with dozens of branches) —
  **draw it as a filled raster and trace it** with the app's own
  `traceMarchingSquares`. Hand-authored curves for the tree of life produced
  something that read as an inkblot; a recursive raster traced at ~300 px, with
  a second RDP pass at ~0.55 units, produced the motif that shipped. Mark the
  result `detail: 'fine'` — see below.
- **A letterform** (ॐ, a monogram) — outline the real glyph with `opentype.js`
  from a system font rather than drawing it. Four hand-drawn attempts at Om were
  all obviously not the letter. Note the font's licence in the code comment.
- **Perfect circles stay as arcs.** Tracing or occluding a circle makes it
  wobble and costs more path data than the rest of the symbol. Compose the
  traced or occluded part with analytic arcs afterwards.

## Look at it before you ship it — at the size it will be seen

```
npm run clipart:preview                    # the whole library, large
npm run clipart:preview -- holly ghost     # named symbols
npm run clipart:preview -- --thumb         # at the gallery's 48 px, magnified
npm run clipart:preview -- --thumb --sw 1.4 holly   # try a stroke weight
```

Open the PNG and judge it: does the silhouette read as the thing, is the
negative space doing anything, is any line hairline-close to another. Expect two
or three rounds — Om took four, the santa hat two. Art that was never actually
looked at is how a crescent shipped outside its own viewBox.

**`--thumb` is the check that matters.** The gallery draws each symbol into 48
px, and a drawing whose gaps are 3 units apart has them 1.4 px apart there. The
seasonal set shipped once looking like ink blots in the gallery while being
perfectly clean at 200 px, because the swatch stroke was 1.5 units of a 24-unit
icon — 6.25 units on 100-unit art, wider than the gaps in the drawing. Swatch
weight now comes from `swatchStrokeWidth()` in screen pixels
(`SWATCH_STROKE_PX`), so it is the same hairline on every symbol regardless of
its box; if you change it, look at `--thumb` for the whole library, not one
symbol.

## Shipping checklist

- Geometry goes in `src/utils/clipArtPaths.ts`, metadata in `CLIP_ART_INDEX`
  (`src/utils/clipArtLibrary.ts`). **Both.** A symbol in one and not the other
  places, selects and machines as nothing; the library test asserts the two name
  exactly the same ids.
- A new category needs adding to the `ClipArtCategory` union *and*
  `CLIP_ART_CATEGORIES` — the latter is what the gallery iterates, so a symbol
  in an unlisted category is invisible.
- `detail: 'fine'` on traced art, whose outlines run within a unit or two of
  each other: it drops the swatch to the finest line the gallery draws, so the
  paired outlines stay two lines instead of merging into one fat one.
- The path table is code-split and loaded through `loadClipArt()` /
  `loadClipArtItem()`. Do not add a static import of `clipArtPaths` — that drags
  the whole gallery back into the main bundle.
- `npx tsc -b`, `npm test`, and check the lint count is unchanged (the tree has
  ~55 pre-existing errors).
