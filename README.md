# Physbox Etch

A browser-based 2D vector studio for laser cutting and CNC milling. Draw or import artwork, set per-layer cut/etch/engrave parameters, preview the toolpath, and drive the machine directly over WebSerial — including touch-plate Z probing and bed levelling.

Part of the [Physbox](https://physbox.io) suite, alongside [Mesh](https://mesh.physbox.io) (3D physics &amp; fabrication) and [Process](https://process.physbox.io).

---

## 🌟 Key Features

* **Vector Design Tools** — Rectangles, circles, ellipses, polygons, stars, lines, freehand and full bezier node editing, all in real millimetres on a bed-accurate canvas.
* **Text & Font Vectorization** — Google Fonts picker with on-demand TTF download; text is converted to outlines automatically so it can actually be machined, and un-vectorized text is reported rather than silently dropped from the job.
* **Engrave Fill (Hatch)** — Scanline fill with per-element angle and spacing, so solid glyphs and logos engrave as filled marks rather than outline drawings.
* **Mandala & Radial Symmetry** — Live sector mirroring and radial array generation.
* **SVG Import / Export** — Paths are flattened to real geometry, stroke colours become layers, and unit assumptions and skipped content are reported after every import.
* **Toolpath Generation** — GRBL dialect, laser (M3/M5 power) or CNC (Z depth over multiple passes) mode, inner-contour-first ordering, and per-layer speed, power, depth and pass count. The program is streamed to the machine from the Run panel; it is not offered as a file, so a job can never drift out of step with the document and machine setup it was planned for. Documents leave the app as SVG or Etch JSON.
* **Machine Control & Work Origin** — Jog pad (0.1/1/10 mm steps) with cancellable jogs, `G10 L20` XY zeroing, touch-plate Z probing that refuses to set a datum when the probe never makes contact, low-power job framing, and a GRBL terminal. GRBL 1.1 / FluidNC / grblHAL over WebSerial.
* **Bed Levelling** — 3×3 or finer probing over the job's bounds, bilinearly interpolated and applied to CNC G-code so cut depth follows a bed or board that is not flat.
* **Clip Art & Templates** — Built-in symbol library and starter documents, plus local save/load of your own.
* **In-App Reference Guide** — Explainers for every fabrication setting, deep-linked from the panels they describe.

---

## 🚀 Getting Started

```bash
npm install
npm run dev          # dev server on port 5176
npm test             # unit tests for the geometry, toolpath and levelling code
npm run build        # type-check and produce dist/
```

Open [http://localhost:5176](http://localhost:5176).

WebSerial machine control requires a Chromium-based browser (Chrome, Edge, Opera) and a GRBL-compatible controller.

### Account sign-in

Everything in the app works signed out, entirely in the browser. Signing in adds cloud sync of machine settings, copilot keys and saved presets, plus remote telemetry.

Sign-in uses Google Identity Services, and **needs no setup for a normal checkout** — the OAuth client id is committed in `src/utils/googleAuth.ts`. There is no `.env` to create; `.env` and `.env.*` are gitignored precisely so nothing that *is* secret gets committed by habit.

The id is public by construction: Vite substitutes it into the shipped bundle, so it is readable by anyone who loads the page. It identifies the application rather than authenticating it. What actually constrains it is the authorised-origins list on the Google side, plus the API verifying the audience of every credential it receives.

**It is baked in at build time, not read at runtime.** Setting `VITE_GOOGLE_CLIENT_ID` on the `etch` Cloud Run service does nothing at all — that service is nginx serving static files, and by then the value is already compiled into the JavaScript. Changing client id means editing the constant and rebuilding.

| Where | Value | Set in |
| --- | --- | --- |
| Frontend | `DEFAULT_GOOGLE_CLIENT_ID` | `src/utils/googleAuth.ts` (committed) — override for a local build with `VITE_GOOGLE_CLIENT_ID` |
| API | `GOOGLE_CLIENT_ID` | Cloud Run env var on the `api` service — see that repo's README |

**These two must be identical.** If they drift, every sign-in fails as a wrong-audience error, which reads as a generic `401 Invalid Google credential` and tells you nothing about the real cause.

Changing the client id, or adding a new origin (each origin is matched exactly — `https://etch.physbox.io` does not cover `https://etch-…run.app`), is done under *Authorised JavaScript origins* in the [Google Cloud console](https://console.cloud.google.com/apis/credentials). The client type must be **Web application**, and *Authorized redirect URIs* stays empty — Identity Services hands the token to a JavaScript callback and never redirects.

> **Note:** copilot API keys entered in Settings are synced to your PhysBox account so they carry across browsers. They are stored on the server as well as in localStorage.

---

## 🎯 Setting Up a Machine

The full walkthrough lives in the app under **Reference Guide → Fabrication → Machine Setup &amp; Zeroing**. In short:

1. **Home** (`$H`) so machine coordinates mean something.
2. **Jog** the tool over the corner of your stock that should be X0 Y0, then **Set XY Zero Here** (writes the G54 work offset, which survives a re-home).
3. **Probe Z Zero** against a touch plate. A probe that never makes contact does *not* set a datum — it says so instead, because zeroing on a missed probe tells the machine the stock surface is wherever the tool ran to.
4. **Frame Job** to check the job fits the stock, and for routing **Probe Bed Heightmap** so cut depth follows the real surface.

---

## 🤖 AI &amp; MCP Bridge

The Sparkles panel drives the app's generators from a written instruction, entirely client-side.

In development the Vite server also exposes a WebSocket MCP bridge at `/mcp`, letting an external agent read the document, import SVG, add elements, load presets and generate G-code (`etch_get_state`, `etch_set_svg`, `etch_export_svg`, `etch_list_presets`, `etch_load_preset`, `etch_add_element`, `etch_generate_gcode`). The hosted build is static and has no bridge.

---

## 🚢 Deployment

Deployed as a static build behind nginx, in the same shape as the other Physbox apps:

```bash
docker build -t physbox-etch .
docker run -p 8080:8080 physbox-etch
```

The image builds the app with Node 20 and serves `dist/` from `nginx:stable-alpine`, with `nginx.conf` installed as an envsubst template so `$PORT` is honoured. SPA routing falls back to `index.html`.

Note: COOP/COEP headers are deliberately **not** set. Etch loads fonts from Google Fonts, `api.fontsource.org` and `cdn.jsdelivr.net`, none of which send `Cross-Origin-Resource-Policy` — `require-corp` would break the font picker and text vectorization.

---

## 📜 License

Distributed under the **Creative Commons Attribution-NonCommercial 4.0 International (CC BY-NC 4.0)** License. Free for personal, academic, educational and non-commercial research use with attribution; commercial licensing requires prior authorization. See [LICENSE](LICENSE).
