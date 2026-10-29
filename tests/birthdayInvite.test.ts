import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'fs';
import ClipperLib from 'clipper-lib';
import { useStore } from '../src/store/useStore';
import { planToolpath } from '../src/utils/gcodeExporter';
import { deriveLaserFeeds } from '../src/utils/feeds';
import { findMaterial } from '../src/utils/materials';
import { DEFAULT_LASER_SOURCE } from '../src/utils/machineSettings';
import { resolveElementOf } from '../src/utils/booleanOps';
import { piecesOf } from '../src/utils/joinPieces';
import { birthdayInviteDoc, generateLaceCutD, INVITE_STOCK_MM } from '../src/presets/birthdayInvite';
import { INVITE_LACE_D } from '../src/presets/birthdayInviteLace';
import type { EtchElement } from '../src/types/etch';

const LACE_FILE = 'src/presets/birthdayInviteLace.ts';

const asPath = (d: string): EtchElement => ({
  id: 'lace', name: 'lace', type: 'path', layerId: 'cut', x: 0, y: 0, d,
  rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2, strokeColor: '#000', fillColor: 'none', visible: true, locked: false,
});

describe('birthday invite: the lace', () => {
  it('is what the generator makes', { timeout: 60000 }, () => {
    const fresh = generateLaceCutD();
    if (process.env.ETCH_BAKE_LACE) {
      const src = readFileSync(LACE_FILE, 'utf8');
      writeFileSync(LACE_FILE, src.replace(/export const INVITE_LACE_D =\n {2}".*";/s, `export const INVITE_LACE_D =\n  ${JSON.stringify(fresh)};`));
      return;
    }
    // A stored copy that has drifted from its generator is a preset nobody can
    // reproduce or change. See the file's own comment for how to rewrite it.
    expect(INVITE_LACE_D).toBe(fresh);
  });

  it('leaves the card in one piece — nothing falls out', () => {
    const holes = resolveElementOf(asPath(INVITE_LACE_D));
    const card = [[
      { X: 5000, Y: 5000 }, { X: (INVITE_STOCK_MM - 5) * 1000, Y: 5000 },
      { X: (INVITE_STOCK_MM - 5) * 1000, Y: (INVITE_STOCK_MM - 5) * 1000 }, { X: 5000, Y: (INVITE_STOCK_MM - 5) * 1000 },
    ]];
    const c = new ClipperLib.Clipper();
    c.AddPaths(card, ClipperLib.PolyType.ptSubject, true);
    c.AddPaths(holes, ClipperLib.PolyType.ptClip, true);
    const paper: ClipperLib.Paths = [];
    c.Execute(ClipperLib.ClipType.ctDifference, paper, ClipperLib.PolyFillType.pftNonZero, ClipperLib.PolyFillType.pftNonZero);
    expect(piecesOf(paper)).toHaveLength(1);
  });

  it('is lace: many narrow openings, none of them a gap', { timeout: 20000 }, () => {
    // Simplified to 10 µm first: the check is about millimetres, and offsetting
    // every vertex of a few hundred finely-sampled holes is most of its time.
    const holes = ClipperLib.Clipper.CleanPolygons(resolveElementOf(asPath(INVITE_LACE_D)), 10);
    expect(holes.length).toBeGreaterThan(100);
    /*
     * Width, not area: an opening in lace may wind a long way between the
     * vines and still read as lace, but one wider than this anywhere along it
     * is a gap in the pattern — the first attempts had a band as wide as the
     * frame. Shrunk by half the allowed width, every hole must vanish.
     */
    const co = new ClipperLib.ClipperOffset();
    co.AddPaths(holes, ClipperLib.JoinType.jtSquare, ClipperLib.EndType.etClosedPolygon);
    const shrunk: ClipperLib.Paths = [];
    co.Execute(shrunk, -3.5 * 1000);
    expect(shrunk.filter((p) => Math.abs(ClipperLib.Clipper.Area(p)) > 1e5)).toEqual([]);
  });
});

describe('birthday invite: the job', () => {
  it('opens as two sheets of the same card, front first', () => {
    useStore.getState().loadPreset('birthday-lace-invite');
    const s = useStore.getState();
    expect(s.tabs).toHaveLength(2);
    expect(s.document.name).toContain('Pink');
    expect(s.document.material).toBe('cardstock');
    expect(s.document.sheets).toBeUndefined();
  });

  it('cuts both sheets to the same outline in the same place', () => {
    const front = birthdayInviteDoc();
    const back = front.sheets![0];
    const outline = (d: typeof front) => d.elements.find((e) => e.name === 'Card Outline');
    const { id: _a, ...f } = outline(front)!;
    const { id: _b, ...b } = outline(back)!;
    expect(f).toEqual(b);
    expect(back.width).toBe(front.width);
  });

  it('plans the front, lace and all', { timeout: 20000 }, () => {
    const plan = planToolpath(birthdayInviteDoc());
    const cuts = plan.segments.filter((s) => s.layerId === 'cut');
    expect(cuts.length).toBeGreaterThan(100);
    expect(plan.skipped.filter((s) => !/text|font/i.test(s))).toEqual([]);
  });

  it('derives a card speed, not a plywood one', () => {
    const doc = birthdayInviteDoc();
    const card = deriveLaserFeeds(findMaterial('cardstock'), 'cut', DEFAULT_LASER_SOURCE, doc.stockThickness!);
    const ply = deriveLaserFeeds(findMaterial('plywood'), 'cut', DEFAULT_LASER_SOURCE, 3);
    expect(card).not.toBeNull();
    expect(card!.speed).toBeGreaterThan(ply!.speed * 5);
  });
});
