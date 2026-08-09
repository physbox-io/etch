import React from 'react';
import { Info, X } from 'lucide-react';
import { useStore } from '../store/useStore';
import { DOCS_TABS, type DocsTabId } from '../docs/docsContent';

/**
 * Small (i) affordance that deep-links a panel to its explainer. Anywhere a
 * setting has a consequence on the machine, this is cheaper than a paragraph
 * of help text in the sidebar.
 */
export const DocsInfoButton: React.FC<{ tab: DocsTabId; className?: string; size?: string }> = ({
  tab,
  className = '',
  size = 'w-3.5 h-3.5',
}) => {
  const openDocs = useStore((s) => s.openDocs);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        openDocs(tab);
      }}
      title="Click for documentation"
      className={`text-slate-400 hover:text-amber-500 transition-colors cursor-pointer shrink-0 ${className}`}
    >
      <Info className={size} />
    </button>
  );
};

const H = ({ children }: { children: React.ReactNode }) => (
  <h3 className="font-bold text-slate-800 dark:text-slate-100 text-lg">{children}</h3>
);

const P = ({ children }: { children: React.ReactNode }) => (
  <p className="text-xs text-slate-600 dark:text-slate-400 leading-relaxed">{children}</p>
);

const Card = ({ children }: { children: React.ReactNode }) => (
  <div className="bg-slate-50 dark:bg-slate-800/60 border border-slate-200/70 dark:border-slate-700/60 rounded-xl p-4 flex flex-col gap-3">
    {children}
  </div>
);

const Step = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="text-xs [&:not(:first-child)]:border-t [&:not(:first-child)]:border-slate-200 dark:[&:not(:first-child)]:border-slate-700/60 [&:not(:first-child)]:pt-3">
    <strong className="text-slate-700 dark:text-slate-200">{title}</strong>
    <p className="text-slate-500 dark:text-slate-400 mt-1 leading-relaxed">{children}</p>
  </div>
);

const Warn = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <div className="bg-amber-50 dark:bg-amber-950/40 border border-amber-200/70 dark:border-amber-800/60 rounded-xl p-4 flex flex-col gap-2.5">
    <strong className="text-amber-800 dark:text-amber-300 font-semibold text-xs">{title}</strong>
    <p className="text-amber-700/90 dark:text-amber-400/90 text-xs leading-relaxed">{children}</p>
  </div>
);

/** One body per tab id — a missing entry is a compile error, not a blank panel. */
const DOCS_BODIES: Record<DocsTabId, React.ReactNode> = {
  workspace: (
    <div className="flex flex-col gap-4">
      <H>🖥️ Bed, Layers &amp; Units</H>
      <P>
        The canvas is your machine's bed, drawn 1:1 in millimetres. Set its size to the real cutting
        area in the document panel — anything outside it will not be reachable, and the G-code will
        be refused or clipped by the controller rather than resized to fit.
      </P>
      <Card>
        <Step title="Layers carry the cut settings">
          Speed, power, pass count and Z depth live on the layer, not the shape. Everything on the
          same layer is machined with the same settings, in one block of G-code, so group by
          operation — through-cuts on one layer, score lines on another.
        </Step>
        <Step title="Operations">
          <strong>Cut</strong> follows the outline at full depth, <strong>Etch</strong> scores it at
          reduced power, and <strong>Fill</strong> hatches the interior. A shape can override its
          layer's treatment with the Machining control in the properties sidebar.
        </Step>
        <Step title="Origin and snapping">
          The document's origin setting decides where X0 Y0 sits on the bed, and it must match how
          you zero the machine — see Machine Setup &amp; Zeroing. Snap-to-grid quantizes new geometry
          to the grid pitch, which is what keeps joints and slots meeting exactly.
        </Step>
      </Card>
    </div>
  ),

  text: (
    <div className="flex flex-col gap-4">
      <H>🔤 Text &amp; Vectorizing</H>
      <P>
        A machine cannot cut a font. Text is stored as a string plus a font choice, and has to be
        converted to outlines before it appears in any toolpath — the app does this automatically a
        moment after you stop typing, and again whenever the font, size or weight changes.
      </P>
      <Card>
        <Step title="Why text can go missing from a job">
          If the font file could not be downloaded, the outlines do not exist and the text is left
          out of the G-code. The export dialog says so and offers to convert; it does not silently
          ship a file with a hole in it.
        </Step>
        <Step title="Fonts come from the network">
          The picker lists Google Fonts and fetches the TTF on demand. Offline, you get the built-in
          font list only. Convert text to outlines while you still have a connection if you are
          taking a document to a machine that has none.
        </Step>
        <Step title="Thin strokes and small text">
          Below about 6 mm cap height most fonts have strokes narrower than a router bit, and the
          toolpath will not fit inside them. Engrave (fill) rather than cut at those sizes.
        </Step>
      </Card>
    </div>
  ),

  fill: (
    <div className="flex flex-col gap-4">
      <H>🪡 Engrave Fill &amp; Hatch</H>
      <P>
        A filled shape is engraved by running parallel lines across its interior — a hatch. Outlines
        alone only score the edge, which on a solid glyph or logo reads as an outline drawing rather
        than a filled mark.
      </P>
      <Card>
        <Step title="Spacing is your beam or bit width">
          Set spacing to roughly the kerf: wider leaves visible stripes, narrower burns the same
          material twice and darkens or dishes it. 0.1–0.2 mm suits most diode lasers; for a router,
          use the cutter diameter.
        </Step>
        <Step title="Angle">
          45° hides the banding better than 0° or 90° on most material grain. Two passes at 45° and
          135° give a solid fill at the cost of doubling the time.
        </Step>
        <Step title="Outline with fill">
          Keeping the outline gives a crisp edge around the hatched area. Turn it off when the fill
          is meant to blend into surrounding engraving.
        </Step>
      </Card>
    </div>
  ),

  import: (
    <div className="flex flex-col gap-4">
      <H>📥 SVG Import</H>
      <P>
        Imported SVGs are converted to real geometry, not embedded — every path is flattened to
        polylines the exporter can machine, and stroke colours become layers so an existing
        cut/score colour convention survives the trip.
      </P>
      <Card>
        <Step title="Units are assumed, then reported">
          An SVG that declares no physical size is read at its user-unit scale and fitted to the
          bed. The import report tells you the resulting size in millimetres — check it before
          cutting, because a drawing that came out at 1/25 scale looks perfectly reasonable on
          screen.
        </Step>
        <Step title="What is skipped">
          Embedded images, filters, gradients and text nodes have no toolpath equivalent and are
          reported as skipped rather than dropped in silence. Convert text to paths in your drawing
          program first, or retype it here.
        </Step>
      </Card>
    </div>
  ),

  toolpaths: (
    <div className="flex flex-col gap-4">
      <H>🛠️ Toolpaths &amp; G-Code</H>
      <P>
        The exporter turns visible layers into GRBL-dialect G-code. It has two modes because the two
        machines differ in what the Z axis means: a laser stays at one height and modulates power,
        while a router plunges.
      </P>
      <Card>
        <Step title="Laser mode (M3 / M5)">
          Power rides on the motion lines as an S value scaled from the layer's power percentage.
          There is no Z motion at all, so bed levelling does not apply — focus is set by hand.
        </Step>
        <Step title="CNC mode">
          Each layer's Z depth is reached over its pass count, so a 6 mm cut at 3 passes takes 2 mm
          per pass. The tool retracts to clearance between contours. Depth is measured from work Z0,
          which is why Z zeroing has to be right before anything else matters.
        </Step>
        <Step title="Inner-first sorting">
          Interior holes are cut before the outline that contains them. Cut the outline first and
          the part comes free, after which the holes are cut in a piece that is no longer held down.
        </Step>
      </Card>
      <Card>
        <Step title="Running it">
          With a machine connected, <strong>Run on Machine</strong> in the G-code panel streams the
          program over USB, one line at a time, paced by the controller's own acknowledgements. The
          status bar keeps the progress, pause and stop controls visible with every panel closed —
          shutting a dialog does not stop a cutter.
        </Step>
        <Step title="Pauses that are meant to happen">
          A tool change (<code>M6</code>) or a programmed stop (<code>M0</code>) parks the tool,
          switches the spindle or laser off, retracts 5 mm and waits. Change the tool, re-zero Z if
          you changed its length, then press Resume.
        </Step>
        <Step title="When something goes wrong">
          If the controller refuses a line, the job stops rather than streaming the rest of the
          program into a machine that has lost the plot. Stop and E-STOP both reset the controller
          and kill spindle and laser output.
        </Step>
      </Card>
      <Warn title="⚠️ Preview is geometry, not a simulation">
        The preview shows the path the tool will follow. It does not model the kerf, the bit
        diameter, clamps, or whether the material is where you think it is. Frame the job on the
        machine before committing to it.
      </Warn>
    </div>
  ),

  zeroing: (
    <div className="flex flex-col gap-4">
      <H>🎯 Machine Setup &amp; Zeroing</H>
      <P>
        Before any laser or CNC job you have to tell the machine where the work actually is. The
        machine panel does this under <strong>Set Work Origin</strong>, which appears once a machine
        is connected over USB. The origin is the corner of your stock that the G-code treats as X0
        Y0 Z0 — get it wrong and the job cuts in the wrong place, or into the bed.
      </P>
      <Card>
        <Step title="1️⃣ Home first ($H)">
          Homing establishes machine coordinates against the limit switches. Everything below sets a
          <em> work</em> offset (G54) on top of that, so homing after zeroing keeps the origin — a
          soft reset does too.
        </Step>
        <Step title="2️⃣ Jog X/Y to the origin">
          Use the arrow pad to drive the tool over the point on your stock that should be X0 Y0.
          Steps are 0.1 / 1 / 10 mm — take the last approach at 0.1 mm and sight down the tool. The
          red ⏹ button cancels a jog in flight. Then press <strong>Set XY Zero Here</strong>, and{' '}
          <strong>Go To Zero</strong> to confirm it landed where you meant.
        </Step>
        <Step title="3️⃣ Zero Z with the touch plate">
          Clip the probe lead to the tool, sit the plate on the stock's top face, park the tool a few
          mm above it, enter your plate's real thickness, and press <strong>Probe Z Zero</strong>.
          The tool descends slowly until the circuit closes, then work Z0 is set at the stock
          surface. <strong>Remove the plate before cutting.</strong>
        </Step>
        <Step title="4️⃣ Frame, then cut">
          Framing traces the job's bounding box at low power so you can check it fits the stock. For
          routing, Probe Bed measures a grid across the job so cut depth follows a bed that is not
          flat.
        </Step>
      </Card>
      <Warn title="⚠️ If the probe misses">
        A probe that runs its full travel without touching — clip off, lead broken, plate not under
        the tool — <strong>does not set Z zero</strong>, and says so in red. That is deliberate:
        zeroing on a missed probe would tell the machine the stock surface is wherever the tool ran
        to, and the next cut would plunge that far past it. Fix the probe and run it again rather
        than starting the job.
      </Warn>
      <P>
        Requires a Chromium browser (WebSerial) and GRBL-compatible firmware — GRBL 1.1, FluidNC, or
        grblHAL. The plate thickness field defaults to 15 mm; set it to your own plate's measured
        thickness before the first cut.
      </P>
    </div>
  ),

  levelling: (
    <div className="flex flex-col gap-4">
      <H>📐 Bed Levelling</H>
      <P>
        No bed is flat and no board is straight. A 0.2 mm dish across 300 mm is enough to cut
        through a veneer at one end of a job and not scratch it at the other. Probing a grid across
        the job measures that surface, and the exported CNC toolpath is warped to follow it.
      </P>
      <Card>
        <Step title="Probing the grid">
          <strong>Probe Bed Heightmap</strong> in the machine panel walks a grid over the job's
          bounds, probing each point. 3×3 catches tilt; 5×5 or more catches a dish or a twist. Every
          point is measured against the first, so the map is a set of offsets and does not depend on
          where Z was zeroed.
        </Step>
        <Step title="How the correction is applied">
          Long cutting moves are subdivided and each point's Z is raised or lowered by the
          interpolated height beneath it, so the depth of cut follows the surface across the move
          rather than stepping at its end. Outside the probed area the correction holds at the edge
          value rather than extrapolating a slope that was never measured.
        </Step>
        <Step title="Laser jobs are not levelled">
          A laser toolpath has no Z, so there is nothing to warp. The heightmap is only applied to
          CNC-mode output.
        </Step>
        <Step title="With no machine connected">
          Probing without hardware returns a simulated tilt and dish so you can see what levelling
          does to the output. It is labelled as simulated everywhere it appears — never send a job
          levelled against a simulated map to a real machine.
        </Step>
      </Card>
      <Warn title="⚠️ Points that never make contact">
        If the probe misses at some points they are recorded flat and the count is reported. The
        levelling will be wrong there — a flat reading in the middle of a tilted map is a step in
        the toolpath. Re-probe rather than cutting through it.
      </Warn>
    </div>
  ),

  mcp: (
    <div className="flex flex-col gap-4">
      <H>🤖 AI &amp; MCP Bridge</H>
      <P>
        The Sparkles panel drives the same generators the toolbar does — radial symmetry, mandala
        rings, borders — from a written instruction, and works entirely in the browser.
      </P>
      <Card>
        <Step title="MCP bridge (development only)">
          Running the app from the dev server exposes a WebSocket bridge at <code>/mcp</code> that an
          external agent can drive: read the document, import an SVG, add elements, load a preset, or
          generate G-code. The hosted build has no bridge — there is no server behind it to run one.
        </Step>
        <Step title="Commands">
          <code>etch_get_state</code>, <code>etch_set_svg</code>, <code>etch_export_svg</code>,{' '}
          <code>etch_list_presets</code>, <code>etch_load_preset</code>, <code>etch_add_element</code>
          , <code>etch_generate_gcode</code>.
        </Step>
      </Card>
    </div>
  ),
};

/** The app's Reference Guide. Grouped tabs on the left, one explainer on the right. */
export const DocsModal: React.FC = () => {
  const { isDocsOpen, docsTab, setDocsTab, closeDocs } = useStore();
  if (!isDocsOpen) return null;

  return (
    // Above the export and machine modals (z-50), which would otherwise paint
    // over the docs they just opened.
    <div className="fixed inset-0 bg-slate-950/60 backdrop-blur-sm z-[60] flex items-center justify-center p-4">
      <div className="bg-white dark:bg-slate-900 rounded-2xl border border-slate-100 dark:border-slate-800 shadow-2xl max-w-3xl w-full max-h-[85vh] flex flex-col overflow-hidden">
        <div className="px-6 py-4 border-b border-slate-200 dark:border-slate-800 flex items-center justify-between bg-slate-50 dark:bg-slate-900/80">
          <div className="flex items-center gap-2">
            <Info className="w-5 h-5 text-amber-500" />
            <h2 className="font-bold text-slate-800 dark:text-slate-100 text-base">
              Physbox Etch Reference Guide
            </h2>
          </div>
          <button
            onClick={closeDocs}
            className="p-1 rounded-lg hover:bg-slate-200 dark:hover:bg-slate-800 text-slate-400 hover:text-slate-600 dark:hover:text-slate-200 transition-colors cursor-pointer"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex flex-1 overflow-hidden min-h-0">
          <div className="w-52 bg-slate-50 dark:bg-slate-900/60 border-r border-slate-200 dark:border-slate-800 p-3 flex flex-col gap-1 shrink-0 overflow-y-auto">
            {DOCS_TABS.map(({ group, items }) => (
              <div key={group} className="flex flex-col gap-1 mb-1.5">
                <span className="px-1 pt-1.5 text-[9px] font-bold uppercase tracking-wider text-slate-400 dark:text-slate-500">
                  {group}
                </span>
                {items.map(({ id, label }) => (
                  <button
                    key={id}
                    onClick={() => setDocsTab(id)}
                    className={`px-3 py-1.5 text-left rounded-lg text-xs font-semibold transition-all cursor-pointer ${
                      docsTab === id
                        ? 'bg-amber-500 text-white shadow'
                        : 'text-slate-600 dark:text-slate-300 hover:bg-slate-200/70 dark:hover:bg-slate-800'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ))}
          </div>

          <div className="flex-1 p-6 overflow-y-auto">{DOCS_BODIES[docsTab]}</div>
        </div>
      </div>
    </div>
  );
};
