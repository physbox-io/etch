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
  selection: (
    <div className="flex flex-col gap-4">
      <H>🖱️ Selecting &amp; Moving</H>
      <P>
        With the <strong>Select</strong> tool, a shape is grabbed where it is actually drawn — its
        outline, or its fill if it has one. Shapes here are usually bare outlines, so the empty
        middle of a rectangle belongs to whatever is inside it, not to the rectangle. That is what
        lets you click a label sitting on a frame and get the label.
      </P>
      <Card>
        <Step title="Overlapping shapes: the smallest one wins">
          When several shapes are under the pointer, the click takes the one with the smallest
          footprint — the thing you almost always meant, and the same choice every time. Draw order
          only breaks ties between shapes of equal size.
        </Step>
        <Step title="Alt-click to reach what is underneath">
          <strong>Alt</strong>-click steps down through everything under the pointer, one shape per
          click, and wraps back to the top. Nothing is ever unreachable, however it is stacked.
        </Step>
        <Step title="Box-select">
          Drag across empty canvas to pull a rubber band; releasing selects everything it touches,
          enclosed or not. Hold <strong>Shift</strong> while dragging to add the band's catch to what
          is already selected.
        </Step>
        <Step title="Building a selection by hand">
          <strong>Shift</strong>-click adds a shape, and removes it again if it is already in.{' '}
          <strong>Ctrl/Cmd+A</strong> takes everything, and clicking empty canvas clears.
        </Step>
        <Step title="Moving">
          Dragging any selected shape moves the whole selection together. Once something is
          selected you can also grab it from anywhere inside its box, which is how you drag an
          outline-only shape without aiming at its stroke. With snapping on, the group lands on the
          grid as one, keeping the shapes' spacing exact.
        </Step>
        <Step title="Resize and rotate">
          The corner knob and the stem above the box appear for a single selection only, and act on
          the shape's own centre — shown by the crosshair in the middle of the box. Hold{' '}
          <strong>Shift</strong> while rotating for 15° steps. There is no group resize: each shape
          keeps its own geometry, which is what keeps a drawing dimensionally honest.
        </Step>
      </Card>
      <P>
        Locked shapes and shapes on hidden layers stay out of the way — they can neither be dragged
        nor caught by a box-select.
      </P>
    </div>
  ),

  workspace: (
    <div className="flex flex-col gap-4">
      <H>🖥️ Stock, Layers &amp; Units</H>
      <P>
        The canvas is the piece of material you are cutting, drawn 1:1 in millimetres. Set its size
        with the <strong>Stock</strong> boxes in the status bar, at the bottom left, and make it the
        real size of what is clamped down: it is the rectangle framing traces, the area the bed is
        probed over, and — through the work origin — what X0 Y0 is measured from. Documents start at
        300 × 200 mm; after that it is yours to set.
      </P>
      <P>
        Geometry outside the rectangle still draws, so you can see that it does not fit. Nothing
        stops it being cut, though — the app does not know your machine's travel, so a move past the
        edge of the stock is a cut into the spoilboard, a clamp, or thin air. Check it with Frame Job
        before you run anything.
      </P>
      <Card>
        <Step title="Layers carry the cut settings">
          Cut depth and the tool live on the layer, not the shape. Everything on the same layer is
          machined with the same settings, in one block of G-code, so group by operation —
          through-cuts on one layer, score lines on another.
        </Step>
        <Step title="Most of it is worked out for you">
          Pick the material in the status bar — and its thickness, on a router — and Etch derives the
          rest. On a router that is the feed rate, spindle speed and depth per pass, from the
          material and the cutter you chose. On a laser it is the speed, power and pass count, from
          the material and the tube: energy per millimetre of travel is what decides whether a line
          is marked, charred or untouched, so that is what the table holds and what the derivation
          keeps constant. You are asked for neither a chipload nor a power percentage, because nobody
          should have to guess one. On a laser, pick your machine from the list beside the target —
          60% of a 40 W CO2 tube and 60% of a 5 W diode are not the same job, and that choice is what
          makes a percentage mean something. The layer panel shows what it all settled on, and the
          Advanced disclosure underneath overrides any of it.
        </Step>
        <Step title="Operations">
          <strong>Cut</strong> follows the outline at full depth, <strong>Etch</strong> scores it at
          reduced power, and <strong>Fill</strong> hatches the interior. A shape can override its
          layer's treatment with the Machining control in the properties sidebar.
        </Step>
        <Step title="Origin and snapping">
          The canvas is drawn the way SVG is, with Y increasing <em>downward</em> from the top of the
          bed. A machine's work coordinates run the other way — Y increases away from you from the
          front-left corner. <strong>Work Origin</strong> in the Run panel is what converts between
          the two, and a wrong setting mirrors the whole job about the X axis. Symmetric shapes
          survive that unnoticed; engraved text comes out backwards, which is the symptom to watch
          for. Snap-to-grid quantizes new geometry to the grid pitch, which keeps joints and slots
          meeting exactly.
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
          out of the toolpath. The Run panel says so and offers to convert; it does not silently
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
          Depth is reached in as many passes as the cutter can stand — a 1/8" end mill takes about
          2.5 mm at a time in ply, so 18 mm is eight passes whatever the layer says. The tool never
          drops straight into the work: it ramps in at a shallow angle along the path, or helixes
          down if the contour is closed, because a bit that snaps almost always snaps on entry.
          Depth is measured from work Z0, which is why Z zeroing has to be right before anything
          else matters.
        </Step>
        <Step title="Cutter offset and tabs">
          A through-cut runs half a cutter <em>outside</em> the line, and its holes half a cutter
          inside, so the part comes out the size you drew it rather than a tool-width smaller.
          Closed cuts also get holding tabs — short bridges of material left at the bottom of the
          cut so the part is not loose under a spinning bit on the last pass. Snap or pare them off
          afterwards. Both are per-layer settings if you want them off.
        </Step>
        <Step title="What runs first">
          Order is by operation, not by where a layer sits in the list: shading and fills, then
          etching, then cuts. A through-cut releases the part from the stock, so anything engraved after it is
          engraved on a piece free to shift. Within one operation the layer order stands, and
          interior holes are cut before the outline containing them for the same reason.
        </Step>
        <Step title="Engraving a photograph">
          A Shade layer machines an imported image as tone rather than as a shape: the picture is
          swept line by line, and how dark it is at each point decides how hard the beam fires — or,
          on a router, how deep the cutter goes. The layer's power and depth are what black comes
          out at, and every lighter grey is a proportion of it, so the way to lighten a whole
          engraving is to turn the layer down rather than to edit the picture. Import one with the
          Photo Tone (or Carved Relief) mode in the image dialog; the pixels stay in the document,
          so size, sweep pitch and depth are all still adjustable afterwards. On a router, a relief
          wants a ball nose — a flat cutter leaves each sweep as a terrace.
        </Step>
        <Step title="Reading the preview">
          The Run panel draws the real toolpath: cutting moves in their layer colours, rapids as
          faint dashed lines, and an estimate of cutting distance and time. Long dashed lines
          criss-crossing the job mean the tool is spending its time travelling — usually a sign of
          geometry split across layers that could share one.
        </Step>
      </Card>
      <Card>
        <Step title="One tool per layer">
          Each layer carries a tool number. Layers that share one are machined together; where the
          number changes the program stops, switches everything off, retracts, and waits for you to
          swap the tool and press Resume. A job whose layers all use one tool never stops.
        </Step>
        <Step title="Which tool for what">
          Flat end mills cut and clear pockets — the wider the bit, the faster and the coarser, and
          nothing survives detail finer than the bit is wide. V-bits engrave: line width comes from
          depth, so they hold the sharp corners a round cutter rounds off. Ball noses give smooth
          engraved floors but a ragged edge on a through-cut. The layer inspector describes each one
          and warns about the pairings it knows are wrong — a 6 mm cutter on an etch layer, or a
          1.5 mm cutter asked to go 12 mm deep. None of this applies to a laser: it has one head,
          whatever came with it, and no tool to choose.
        </Step>
        <Step title="How multi-tool jobs are ordered">
          Still fills, then etching, then cuts — tool changes are cheap and a part cut loose early is
          not, so nothing is ever hoisted across an operation to save a swap. Within fills and
          etching the tool already in the spindle goes first, so two V-bit layers either side of an
          end-milled one cost one change rather than two. Within cutting, holes keep their place
          ahead of the outline that contains them even when the two use different tools.
        </Step>
        <Step title="Re-zero Z after every change">
          A new tool is a new length, so work Z0 moves with it. On a multi-tool job the program also
          pauses before the first cut, so you can confirm what is actually in the collet — the
          spindle does not start until you resume.
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
          switches the spindle or laser off, retracts 5 mm and waits. A banner says what it is
          waiting for, with a shortcut straight to the machine controls — touch off Z on the new
          tool there and hit <strong>Resume Job</strong> in the same panel. The work origin panel
          will tell you if you have not re-zeroed since the job stopped.
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
          red ⏹ button cancels a jog in flight. Then press <strong>Set XY Zero</strong>, and{' '}
          <strong>Go To Zero</strong> to confirm it landed where you meant.
        </Step>
        <Step title="2️⃣ On a laser, sight with the guide spot">
          There is nothing to sight down on a laser — the head is a box, and the red pointer diode
          some machines carry is mounted off to one side of the actual beam, so zeroing to the
          pointer puts every job out by that offset, the same amount in the same direction every
          time. Press <strong>Guide Spot</strong> to fire the real beam at pointer power, put scrap
          under the head, and jog the <em>dot</em> onto the corner of your stock before zeroing.
          Raise the percentage beside the button until the dot is visible — it is a percentage of
          your controller's own full scale (<code>$30</code>), and the S word it works out to is
          shown next to it. Etch turns laser mode (<code>$32</code>) off while the spot is lit and
          back on the moment it goes out, because GRBL only energises the beam during a feed move
          and a pointer is a head standing still. If your dot still only appears while the head is
          moving — some controllers gate the laser on motion below anything <code>$32</code> reaches
          — tick <strong>Jiggle to stay lit</strong>, which traces a 0.1 mm cross around the spot to
          keep it firing. The cross returns to its own centre, so the point you are sighting does
          not creep. The spot switches itself off after two minutes, and whenever a job starts. Wear
          your glasses: it is a low power, not a safe one.
        </Step>
        <Step title="3️⃣ Zero Z with the touch plate">
          Clip the probe lead to the tool, sit the plate on the stock's top face, park the tool a few
          mm above it, enter your plate's real thickness, and press <strong>Probe Z Zero</strong>.
          The tool descends slowly until the circuit closes, then work Z0 is set at the stock
          surface. <strong>Remove the plate before cutting.</strong>
        </Step>
        <Step title="3️⃣ …or zero Z by hand (the paper trick)">
          No touch plate, or stock that will not conduct? Open{' '}
          <strong>No touch plate? Zero Z by hand</strong>, lay a sheet of paper on the stock, and jog
          Z down in 0.1 mm steps until the paper just drags under the tool. Press{' '}
          <strong>Set Z Zero Here</strong> and the shim thickness (0.1 mm for copier paper) is added
          back, so Z0 lands on the stock rather than on the paper. It is as accurate as your feel for
          the drag — good to a few hundredths in practice, and it works on wood, acrylic and painted
          stock where a plate has nothing to conduct to.
        </Step>
        <Step title="4️⃣ Frame, then cut">
          Framing traces the job's bounding box so you can check it fits the stock — at low laser
          power on a laser, and retracted with the spindle off on a router, which is sitting on the
          surface it was just zeroed against. For routing, Probe Bed then measures a grid across the
          job so cut depth follows a board that is not flat.
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
        grblHAL. The plate thickness field defaults to 13 mm and is remembered between sessions;
        measure your own plate and set it once, before the first cut. Work Z0 lands exactly that far
        below the plate's top face, so a value left at someone else's plate is a cut too deep by the
        difference — the one number here that is wrong silently.
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
        <Step title="Automatic mode — unattended, needs a conductive job">
          The machine drives itself to every point and probes it (a <code>G38.2</code> move down
          onto the surface), lifting to a 5 mm clearance between points. Nothing is asked of you
          while it runs. Because the tool moves and you do not, the probe circuit has to be live
          everywhere on the job: clip on the tool, other lead on the workpiece. Bare metal or a
          copper-clad PCB is the case this is for.
        </Step>
        <Step title="Assisted mode — any material">
          The machine parks over each point and waits. Slide a touch plate under the tool and{' '}
          <strong>Probe here</strong>, or jog Z down until the tool just kisses the surface and{' '}
          <strong>Use current Z</strong> — the jog pad stays live while a point is pending, and the
          captured position is taken once motion has settled. Wood, acrylic, painted stock: nothing
          has to conduct. <strong>Skip</strong> records a point flat, <strong>Stop</strong> ends the
          grid.
        </Step>
        <Step title="Plate thickness does not enter into the heightmap">
          Heights here are differences, so a plate of constant thickness under every point cancels
          out — as does the tool sitting on the surface in the hand-wound method. What matters is
          that you use the <em>same</em> method at every point of one grid. The thickness box beside{' '}
          <strong>Probe Z Zero</strong> is a different thing entirely: it is the depth of work Z0
          below whatever you touched off on.
        </Step>
        <Step title="Milling a PCB: set the plate thickness to 0">
          Touching Z off directly on the copper with a plate thickness still set (it defaults to 13
          mm and is remembered per machine, not per document) tells the controller the surface is 13
          mm higher than it is, and the first plunge goes through the board into the spoilboard. Zero
          on bare copper means thickness <code>0</code>. Touch off somewhere on the board itself,
          too — the map is anchored to the datum point, so a datum on a fixture beside the job is a
          datum the grid cannot resolve against.
        </Step>
        <Step title="How many points">
          The two boxes are the point counts across X and along Y. They default to the job's aspect
          ratio so the spacing is about the same on both axes — a 400 × 100 mm board suggests 9 × 3,
          not 3 × 3 — and either can be set by hand between 2 and 10. <em>auto</em> returns to the
          suggestion. Every point costs a probing cycle, so 3 × 3 catches tilt, and 5 × 5 or more is
          for a dish or a twist.
        </Step>
        <Step title="Zero Z first">
          The map is a correction, so it has to read zero where the depth is already right — the
          point you touched off Z at. That is what it is anchored to, which means Z has to be zeroed
          before the bed is probed. Probe it first and the map is anchored to an arbitrary corner of
          the grid instead, and the whole job is cut deep or shallow by the height difference
          between the two. The panel says so in amber when that has happened; re-probe after
          zeroing.
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

  license: (
    <div className="flex flex-col gap-4">
      <H>⚖️ License &amp; Terms</H>
      <P>
        PhysBox Etch is distributed under the <strong>PhysBox Permissive Public License (PPPL-1.0)</strong>.
        Commercial use of generated G-code, toolpaths, and engraved goods is fully permitted with attribution.
      </P>
      <div className="bg-slate-100 dark:bg-slate-950 p-3.5 rounded-xl border border-slate-200 dark:border-slate-800 text-[11px] font-mono text-slate-700 dark:text-slate-300 whitespace-pre-wrap leading-relaxed max-h-[50vh] overflow-y-auto">
{`PhysBox Permissive Public License (PPPL-1.0)
Copyright (c) 2026 PhysBox Contributors and Authors. All Rights Reserved.

1. PERMISSION AND SCOPE
Permission is granted to access, execute, and use the Software for personal, educational, research, and commercial purposes, including the generation, export, and commercial utilization of output artifacts (such as toolpaths, G-code, and laser/engraver instructions).

2. PERMITTED COMMERCIAL USE OF OUTPUTS
You are fully permitted to design, manufacture, sell, and monetize any physical workpieces, laser-cut materials, or etched parts produced using the Software.

3. ATTRIBUTION & RESTRICTIONS ON SOFTWARE FORKING
(a) Attribution: The copyright notice and license must be retained in all copies or substantial portions of the Software.
(b) No Standalone Forking or Hosted Service Redistribution: You may NOT redistribute, sublicense, re-brand, or host the Software source as a competing standalone service or software fork without explicit prior written authorization.
(c) Brand Protection: The names "PhysBox", "Etch", "Volt", "Mesh", "Flux", or the names of their contributors may not be used to endorse or promote third-party products without specific prior written permission.

4. STRICT DISCLAIMER OF LIABILITY & PHYSICAL MACHINERY WARNING
THE SOFTWARE, LASER/CNC TOOLPATH CALCULATORS, AND MACHINE CONTROLLERS ARE PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND. IN NO EVENT SHALL THE AUTHORS BE LIABLE FOR ANY CNC/LASER DAMAGE, TOOL BREAKAGE, FIRE, FUMES, WORKPIECE LOSS, BUSINESS INTERRUPTION, OR BODILY INJURY RESULTING FROM OPERATION OF MACHINERY. OPERATORS ASSUME SOLE RESPONSIBILITY FOR LASER SAFETY, EYE PROTECTION, CLAMPING, AND MACHINE LIMITS.`}
      </div>
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
