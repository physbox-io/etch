/**
 * What the stock is made of, and what that means for how hard you can cut it.
 *
 * Feed, speed and depth of cut are not free choices — they follow from the
 * material, the cutter and the spindle, and getting them wrong is how bits
 * break. Until this file existed the app had no idea what was clamped to the
 * bed, so it could not have an opinion: it emitted whatever feed the user typed
 * and whatever depth-per-pass fell out of the pass count, including a single
 * full-depth pass through 18 mm of oak.
 *
 * The numbers here are conservative shop defaults, chosen so that the wrong
 * answer costs a slower job rather than a snapped cutter. They are deliberately
 * not exposed as a table of sliders: picking "Hardwood" is a thing a beginner
 * can do correctly, and picking a chipload is not.
 */

import type { MachineKind } from './tooling';

export type MaterialId =
  | 'mdf'
  | 'plywood'
  | 'softwood'
  | 'hardwood'
  | 'acrylic'
  | 'aluminium'
  | 'glass'
  | 'stone'
  | 'ceramic'
  | 'film';

export interface MaterialProfile {
  id: MaterialId;
  name: string;
  /**
   * Chip thickness per tooth, in mm, for a 3.175 mm (1/8") cutter.
   *
   * This is the quantity that actually keeps a cutter alive. Too small and the
   * flutes rub instead of cutting, which heats the tool and work-hardens or
   * melts them together; too large and the cutter is levered sideways until it
   * snaps. Feed rate is derived from it rather than being a number the user
   * guesses.
   */
  chiploadAt3mm: number;
  /**
   * Spindle speed, in RPM, for a 3.175 mm cutter. Scaled down for wider tools
   * by `deriveFeeds`, because a wider cutter reaches the same surface speed at
   * fewer revolutions.
   */
  rpmAt3mm: number;
  /**
   * The deepest single pass, as a multiple of cutter diameter.
   *
   * A slot cut at full width engages the whole cutter, so this is the limiting
   * case rather than the typical one. Soft, crumbly material clears chips well
   * and takes a full diameter; hardwood grabs, and metal does not forgive.
   */
  stepdownRatio: number;
  /** One line for the operator on a router, shown next to the picker. */
  note: string;
  /** What this stock does under a beam, which is a different subject entirely. */
  laser: LaserMaterial;
  /**
   * Set on stock a hobby router cannot cut through — only mark the surface of.
   *
   * Glass, stone and tile do not chip like wood; they fracture. The tooling that
   * works on them is abrasive rather than fluted, it removes material a tenth of
   * a millimetre at a time, and asking it to part a 10 mm slab means an hour of
   * grinding that ends in a cracked workpiece. The feeds below are therefore for
   * engraving, and a `cut` layer in one of these earns a warning rather than a
   * silently derived pass plan that reads as if the app thought it would work.
   */
  surfaceOnly?: boolean;
}

/**
 * How a material answers a beam.
 *
 * The router model asks "how thick a chip may this cutter lift", and none of
 * that means anything here: a laser has no flutes, no depth of cut and no
 * sideways load. What decides a laser job is *dose* — how much energy lands on
 * each millimetre of the line — and dose is what these numbers are in. Speed
 * and power are then two ways of spending the same joules, which is why the
 * derivation can trade one for the other when a machine runs out of either.
 *
 * The doses are quoted for a CO2 tube, because that is the machine the numbers
 * were gathered on and stating a single figure "for lasers" would be a lie
 * about a 5 W diode.
 */
export interface LaserMaterial {
  /**
   * The same one-line note as `note`, for a machine with no flutes.
   *
   * Hardwood is the difficult one to machine and the best one to engrave; glass
   * cannot be routed at all and is one of the nicest things to mark. A single
   * note cannot say both, and showing the routing advice on a laser job would be
   * worse than showing none — it describes forces that are not acting.
   */
  note: string;
  /**
   * Why the beam will not mark this stock as it is, when that is the case.
   *
   * Not a matter of dialling the power up: clear glass and clear acrylic pass a
   * diode beam straight through, and a tile glaze mostly just crazes. Each needs
   * something done to the surface first, and the failure looks identical to a
   * job that simply ran
   * at too low a power — which is how an afternoon goes into re-running it.
   */
  warning?: string;
  /**
   * Energy to score or engrave the surface, in joules per mm of travel.
   *
   * The whole of what an engrave costs: a 40 W tube at half power moving at
   * 40 mm/s puts 0.5 J into every millimetre it crosses, and whether that
   * millimetre ends up marked, charred or untouched is this number.
   */
  etchDoseJPerMm: number;
  /**
   * Energy to blacken a solid area, in joules per mm² of surface.
   *
   * The companion to `etchDoseJPerMm` and not a restatement of it: a scored
   * line is one pass over a strip about as wide as the beam, and a fill is a
   * surface covered by many, so the quantity that decides how dark a fill comes
   * out is per-area rather than per-mm-of-travel. Quoting it that way is what
   * lets `deriveLaserFeeds` turn hatch pitch into speed, so that changing the
   * pitch changes the resolution of a fill and not its exposure.
   *
   * Roughly `etchDoseJPerMm ÷ 0.2` — the pitch these were previously run at —
   * trimmed by a fifth, which is where measured diode settings for a solid fill
   * actually sit. A score wants to be seen from across the room; a fill only
   * has to be even.
   */
  fillDoseJPerMm2: number;
  /**
   * Energy to cut clean through, in joules per mm of travel *per mm of
   * thickness* — so 6 mm stock costs six times what 1 mm does.
   *
   * Null where a beam does not part the material at all: glass and tile crack
   * rather than separate, and metal is not going anywhere on a hobby machine.
   * Null is not "we did not measure it", it is "do not offer this".
   */
  cutDoseJPerMm2: number | null;
  /**
   * The highest useful fraction of the tube, 0–1.
   *
   * Almost always 1: more power is more speed and the job is over sooner. Glass
   * is the exception that makes the field necessary — past about a quarter power
   * the surface stops frosting and starts chipping out, and the fix is a slower
   * pass at low power rather than the same job harder.
   */
  maxPowerFraction: number;
  /**
   * How many times the CO2 dose a blue diode needs on this material.
   *
   * Wavelength is not a detail here. Diode light is absorbed *better* than CO2
   * by dark organics, which is why the factors below sit near 1 for wood despite
   * the enormous difference in tube power — and not at all by anything clear or
   * shiny. Null means a diode cannot do this material at any speed, and the
   * derivation refuses rather than printing a number that will waste an evening.
   */
  diodeFactor: number | null;
}

/**
 * Cut depth added past the stock thickness on a through-cut, in mm.
 *
 * A cut that stops exactly at nominal thickness does not go through: stock is
 * never quite flat, the spoilboard is never quite level, and the last few
 * hundredths hold on as a fringe of fuzz that has to be knifed off. Grazing the
 * spoilboard is the accepted cost of parts that actually release.
 */
export const THROUGH_CUT_OVERCUT_MM = 0.3;

const MATERIALS: MaterialProfile[] = [
  {
    id: 'mdf',
    name: 'MDF',
    chiploadAt3mm: 0.1,
    rpmAt3mm: 18000,
    stepdownRatio: 1.0,
    note: 'Cuts easily and clears chips well. Abrasive — it blunts cutters faster than wood.',
    laser: {
      note: 'Engraves evenly and dark, with no grain to fight. The charred edge wipes off; the smoke needs extraction.',
      etchDoseJPerMm: 0.25,
      fillDoseJPerMm2: 1.0,
      cutDoseJPerMm2: 1.5,
      maxPowerFraction: 1,
      diodeFactor: 1.2,
    },
  },
  {
    id: 'plywood',
    name: 'Plywood',
    chiploadAt3mm: 0.08,
    rpmAt3mm: 18000,
    stepdownRatio: 0.8,
    note: 'Glue lines are harder than the plies. Steady feed matters more than speed.',
    laser: {
      note: 'Fine for line work. Glue lines take the beam differently, so a large fill can band where a ply changes.',
      etchDoseJPerMm: 0.25,
      fillDoseJPerMm2: 1.0,
      // Glue resists the beam more than the plies do, so ply costs a little more
      // per millimetre than the solid wood it is made of.
      cutDoseJPerMm2: 1.4,
      maxPowerFraction: 1,
      diodeFactor: 1.2,
    },
  },
  {
    id: 'softwood',
    name: 'Softwood (pine, cedar)',
    chiploadAt3mm: 0.1,
    rpmAt3mm: 18000,
    stepdownRatio: 1.0,
    note: 'Forgiving. Resin can pack the flutes on deep cuts, so it still likes a brisk feed.',
    laser: {
      note: 'High contrast for little power. Soft early grain burns deeper than the hard bands, so a photo fill comes out striped.',
      etchDoseJPerMm: 0.2,
      fillDoseJPerMm2: 0.8,
      cutDoseJPerMm2: 1.2,
      maxPowerFraction: 1,
      diodeFactor: 1.1,
    },
  },
  {
    id: 'hardwood',
    name: 'Hardwood (oak, maple)',
    chiploadAt3mm: 0.07,
    rpmAt3mm: 16000,
    stepdownRatio: 0.5,
    note: 'Grabs on deep passes and burns if the feed is too slow. Half-diameter steps.',
    laser: {
      note: 'The best wood here for detail and photo fills — dense, even grain and a clean dark mark.',
      etchDoseJPerMm: 0.3,
      fillDoseJPerMm2: 1.2,
      cutDoseJPerMm2: 1.8,
      maxPowerFraction: 1,
      diodeFactor: 1.2,
    },
  },
  {
    id: 'acrylic',
    name: 'Acrylic',
    chiploadAt3mm: 0.08,
    rpmAt3mm: 14000,
    stepdownRatio: 0.5,
    note: 'Melts and re-welds behind the cutter if fed too slowly. Lower RPM, keep moving.',
    laser: {
      note: 'Cast acrylic frosts white and engraves beautifully; extruded goes shallow and patchy. Leave the masking on for cuts.',
      warning:
        'Clear acrylic is transparent to a blue diode — the beam passes through and marks whatever is under it. ' +
        'A CO2 engraves it as it is; a diode needs the stock tinted, painted or masked.',
      etchDoseJPerMm: 0.3,
      fillDoseJPerMm2: 1.2,
      // Acrylic vaporises rather than charring, so it parts for less energy than
      // wood of the same thickness and leaves a polished edge doing it.
      cutDoseJPerMm2: 1.0,
      maxPowerFraction: 1,
      // Dark cast acrylic takes a diode well; the clear stock most people have
      // does not, which is what the warning is for.
      diodeFactor: 1.5,
    },
  },
  {
    id: 'film',
    name: 'Plastic film (stencil stock)',
    // A router cannot hold film at all, so these exist only because every
    // profile has them. See the note.
    chiploadAt3mm: 0.02,
    rpmAt3mm: 16000,
    stepdownRatio: 0.5,
    note:
      'Not routable. A tenth of a millimetre of film cannot be clamped flat enough for a cutter ' +
      'to shear it — it lifts into the tool and tears. This is laser stock.',
    laser: {
      note:
        'Black polyester (PET/Mylar) at 0.1-0.15mm, or a printed single-layer shim. Cuts fast and ' +
        'clean with air assist; the whole sheet is through in one pass, so watch for it lifting.',
      warning:
        'Only dark film cuts on a diode. Clear PET and Mylar require a CO2 laser. ' +
        'Do not laser cut vinyl or PVC film; use polyester, Mylar, or dark polymer film with ducted extraction.',
      // By analogy with acrylic: the same order of polymer, vaporising rather
      // than charring. Thin stock means the derived speed will hit the
      // machine's ceiling long before the dose runs out, which is the right
      // failure — it means "as fast as the gantry goes".
      etchDoseJPerMm: 0.2,
      fillDoseJPerMm2: 0.8,
      cutDoseJPerMm2: 1.0,
      maxPowerFraction: 1,
      // Better than acrylic's 1.5: the point of black film is that it absorbs
      // blue, which is the wavelength a diode has.
      diodeFactor: 1.1,
    },
  },
  {
    id: 'aluminium',
    name: 'Aluminium',
    chiploadAt3mm: 0.025,
    rpmAt3mm: 12000,
    stepdownRatio: 0.15,
    note: 'Shallow steps only, and it needs lubricant. A hobby router is at its limit here.',
    laser: {
      note: 'Ablates the anodised layer to expose the metal under it, so the mark is white and permanent. Bare mill-finish stock needs a marking spray instead.',
      /**
       * No warning, and no diode refusal.
       *
       * This entry used to model bare mill-finish stock: `diodeFactor: null`
       * refused diode jobs outright and the warning told everyone to go and buy
       * CerMark. Almost nobody puts raw aluminium under a hobby laser — they put
       * anodised stock under it, which is the standard thing to mark and takes a
       * diode perfectly well. Refusing the common case to warn about the rare one
       * is the wrong way round.
       */
      /**
       * Ablating an anodised layer is a surface job, not the heat-sinked fusing
       * of a compound onto bare metal that the old 6.0 described.
       *
       * The first correction to that only went as far as 1.2, on the reasoning
       * that the substrate still pulls heat away far faster than any of the
       * woods do. That reasoning is about bulk conduction, and it is the wrong
       * model for what is happening: the anodic layer is a few tens of microns
       * of porous oxide, and removing it is a threshold process that is over
       * before the metal underneath has taken the heat anywhere. The aluminium
       * heatsink is why this stock cannot be engraved *deep* — it is not why it
       * would cost more energy to mark.
       *
       * 1.2 put a 10 W diode at 357 mm/min and a 40 W tube at 2,000, against a
       * material that in practice is one of the quickest things there is to
       * mark. These figures put them at about 1,200 and 6,900, which is where
       * measured settings for anodised stock actually sit. It is the largest
       * single correction in this table and it was found the way these things
       * are always found — a job that should have been minutes quoting 41.
       */
      etchDoseJPerMm: 0.35,
      fillDoseJPerMm2: 1.8,
      cutDoseJPerMm2: null,
      maxPowerFraction: 1,
      // Blue is absorbed well by the dye in a dark anodised finish; a silver or
      // clear finish takes noticeably more, which is what the margin here is.
      diodeFactor: 1.4,
    },
  },
  /**
   * The brittle three.
   *
   * Their chiploads are an order of magnitude below wood's, which is the honest
   * description of what a diamond burr does: it grinds a surface away rather
   * than lifting chips off it, and a "chip" of 0.008 mm is a scratch. Feeding
   * them like a soft material does not cut faster, it chips the edge out ahead
   * of the tool and, in glass, splits the sheet. The stepdown ratios are set so
   * that a 1/8" tool takes roughly a tenth to a third of a millimetre per pass —
   * about what these materials give up before they start fracturing.
   */
  {
    id: 'glass',
    name: 'Glass',
    chiploadAt3mm: 0.008,
    rpmAt3mm: 16000,
    // 0.16 mm a pass with a 1/8" tool — the floor this app will emit anyway.
    stepdownRatio: 0.05,
    surfaceOnly: true,
    note: 'Frosted surface engraving only, with a diamond burr and water. Dry, deep or fast, it cracks.',
    laser: {
      note:
        'The beam micro-fractures the surface white rather than cutting in, so depth means nothing and power means chipping. ' +
        'Low power, high speed, defocused slightly, with wet paper or dish soap over the area for an even frost.',
      warning:
        'A blue diode passes straight through clear glass and does nothing to it. A CO2 frosts it directly; ' +
        'a diode only marks glass that has been painted or coated first.',
      etchDoseJPerMm: 0.25,
      fillDoseJPerMm2: 1.0,
      cutDoseJPerMm2: null,
      /**
       * The one material here that is not run flat out.
       *
       * Frosting is thermal shock doing exactly as much damage as intended.
       * More power does not frost harder, it takes chips out of the surface, so
       * the power is held down and the dose is met by slowing the head instead.
       */
      maxPowerFraction: 0.25,
      diodeFactor: null,
    },
  },
  {
    id: 'stone',
    name: 'Stone (slate, marble)',
    chiploadAt3mm: 0.02,
    rpmAt3mm: 14000,
    stepdownRatio: 0.1,
    surfaceOnly: true,
    note: 'Slate engraves cleanly; marble is softer and chips at the edges. Diamond tooling, and expect dust.',
    laser: {
      note:
        'Slate is about the easiest thing there is to engrave: no coating, no masking, and it marks pale grey at modest power. ' +
        'Marble is patchier — the mark follows the mineral rather than the artwork.',
      etchDoseJPerMm: 0.5,
      fillDoseJPerMm2: 2.0,
      cutDoseJPerMm2: null,
      maxPowerFraction: 1,
      diodeFactor: 1.3,
    },
  },
  {
    id: 'ceramic',
    name: 'Ceramic tile',
    chiploadAt3mm: 0.012,
    rpmAt3mm: 14000,
    stepdownRatio: 0.07,
    surfaceOnly: true,
    note: 'The glaze is the hard part and it spalls. Score it in shallow passes; never enter mid-glaze at speed.',
    laser: {
      note: 'Unglazed terracotta darkens directly. Glazed tile is done the other way round: coat it, fuse the coating, wash off the rest.',
      warning:
        'A bare glaze mostly crazes rather than marks, and what does appear rubs off. The reliable route is a coat of white ' +
        'titanium-dioxide paint fused by the beam — the "white tile" method — then wash the unfused paint away.',
      // Fusing titanium dioxide into a glaze is a firing, not a scorch — it
      // wants roughly four times what it takes to darken wood.
      etchDoseJPerMm: 1.0,
      fillDoseJPerMm2: 4.0,
      cutDoseJPerMm2: null,
      maxPowerFraction: 1,
      diodeFactor: 1.5,
    },
  },
];

/** The material assumed when a document does not say. */
export const DEFAULT_MATERIAL: MaterialId = 'plywood';

/** Stock thickness in mm assumed when a document does not say. */
export const DEFAULT_STOCK_THICKNESS_MM = 6;

export function materialCatalog(): MaterialProfile[] {
  return MATERIALS;
}

/**
 * The line to put in front of the operator, for the machine they are on.
 *
 * Callers ask for this rather than reaching for `note`, because `note` is the
 * routing advice and on a laser job it is advice about forces that are not
 * acting — a warning about chip clearance, next to a machine with no flutes.
 */
export function materialNote(material: MaterialProfile, machine: MachineKind): string {
  return machine === 'laser' ? material.laser.note : material.note;
}

export function findMaterial(id: MaterialId | undefined): MaterialProfile {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS.find((m) => m.id === DEFAULT_MATERIAL)!;
}
