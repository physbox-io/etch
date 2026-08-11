# Repository Guide for AI Agents — Physbox Etch

## Project Overview
Physbox Etch (`etch`) is a web-based 2D Laser Cutting and CNC Milling Studio built with React 18, Vite, TypeScript, Zustand, and Canvas/SVG rendering.

- **Main Store**: `src/store/useStore.ts`
- **Primary Canvas**: `src/components/EtchCanvas.tsx`
- **Text Vectorization Engine**: `src/utils/textVectorizer.ts`
- **Preset Document Templates**: `src/presets/presetEtchings.ts`
- **Type Definitions**: `src/types/etch.ts` and `src/types/fonts.d.ts`

---

## Technical Deep-Dives & Key Learnings

### 1. Text Vectorization & `opentype.js` Pitfalls
Browser `<text>` elements cannot be converted directly into laser/CNC toolpaths; text must be converted into vector outline path data (`outlineD`).

When working with `textVectorizer.ts` and `opentype.js`, be aware of the following critical edge cases:

#### A. Number Packing Bug in `opentype.js` (`toPathData`)
* **Symptom**: Text renders partially then halts mid-character, leaving the rest of the string blank.
* **Root Cause**: `opentype.js` checks `v < 0` to decide if a space separator is needed before `floatToString(v)`. Baseline calculation (`font.ascender * scale`) produces tiny negative float coordinates near zero (e.g. `-1.776e-15`). `opentype.js` omits the space separator because `-1.776e-15 < 0` is true, but then formats the number to `"0"`. Without a minus sign or space, the previous coordinate and `"0"` merge (e.g. `L 2.25 0` becomes `L2.25000`), breaking the SVG path parser.
* **Rule**: Always pass `p.commands` through `sanitizePathCommands()`, which clamps coordinates within `0.00005` of zero to `0`.

#### B. Missing `Z` (ClosePath) Commands in TrueType Contours
* **Symptom**: Text outlines appear with visible gaps at the start/end of glyph strokes when rendered as unfilled paths (`fill="none" stroke="..."`).
* **Root Cause**: TrueType font contours implicitly close, but `opentype.js` `glyph.getPath()` converts contours to `M ... L ... L` without appending `Z` commands. SVG stroke engines leave a gap between the last point and the starting `M` point if `Z` is omitted.
* **Rule**: `sanitizePathCommands()` must track contour boundaries and automatically inject `{ type: 'Z' }` before any new `M` command and at the end of the command list.

#### C. Unhandled GSUB Lookups & `NaN` Coordinates
* **Symptom**: Certain fonts (e.g., *Press Start 2P*, *Pacifico*) produce invalid SVG path strings containing `NaN`.
* **Root Cause**: `font.getPath()` runs GSUB lookup tables that `opentype.js` does not fully support, returning `NaN` coordinates without throwing an exception.
* **Rule**: Validate generated path data with `isPathDataValid()` before using `font.getPath()`. If invalid or containing `NaN`, fall back to `layoutGlyphs()` (per-glyph layout).

---

## Build & Environment Commands

When making changes in this repository:

```bash
# Clean build check (TypeScript + Vite)
wsl -d Ubuntu-20.04 bash -c "cd /home/boab/etch && npm run build"
```

If updating `opentype.js` path handling, remember to update ambient type declarations in `src/types/fonts.d.ts` if adding properties to `OTPath`.
