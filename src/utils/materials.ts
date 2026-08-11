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

export type MaterialId =
  | 'mdf'
  | 'plywood'
  | 'softwood'
  | 'hardwood'
  | 'acrylic'
  | 'aluminium';

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
  /** One line for the operator, shown next to the picker. */
  note: string;
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
  },
  {
    id: 'plywood',
    name: 'Plywood',
    chiploadAt3mm: 0.08,
    rpmAt3mm: 18000,
    stepdownRatio: 0.8,
    note: 'Glue lines are harder than the plies. Steady feed matters more than speed.',
  },
  {
    id: 'softwood',
    name: 'Softwood (pine, cedar)',
    chiploadAt3mm: 0.1,
    rpmAt3mm: 18000,
    stepdownRatio: 1.0,
    note: 'Forgiving. Resin can pack the flutes on deep cuts, so it still likes a brisk feed.',
  },
  {
    id: 'hardwood',
    name: 'Hardwood (oak, maple)',
    chiploadAt3mm: 0.07,
    rpmAt3mm: 16000,
    stepdownRatio: 0.5,
    note: 'Grabs on deep passes and burns if the feed is too slow. Half-diameter steps.',
  },
  {
    id: 'acrylic',
    name: 'Acrylic',
    chiploadAt3mm: 0.08,
    rpmAt3mm: 14000,
    stepdownRatio: 0.5,
    note: 'Melts and re-welds behind the cutter if fed too slowly. Lower RPM, keep moving.',
  },
  {
    id: 'aluminium',
    name: 'Aluminium',
    chiploadAt3mm: 0.025,
    rpmAt3mm: 12000,
    stepdownRatio: 0.15,
    note: 'Shallow steps only, and it needs lubricant. A hobby router is at its limit here.',
  },
];

/** The material assumed when a document does not say. */
export const DEFAULT_MATERIAL: MaterialId = 'plywood';

/** Stock thickness in mm assumed when a document does not say. */
export const DEFAULT_STOCK_THICKNESS_MM = 6;

export function materialCatalog(): MaterialProfile[] {
  return MATERIALS;
}

export function findMaterial(id: MaterialId | undefined): MaterialProfile {
  return MATERIALS.find((m) => m.id === id) ?? MATERIALS.find((m) => m.id === DEFAULT_MATERIAL)!;
}
