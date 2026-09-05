import { describe, it, expect } from 'vitest';
import {
  parseGrblSettings,
  motionProfileFromSettings,
  accelAlong,
  maxRateAlong,
  cuttingFeedCeiling,
  describeMotionProfile,
  DEFAULT_MOTION_PROFILE,
} from '../src/utils/motionProfile';
import { deriveFeeds, MAX_CUTTING_FEED_MM_MIN } from '../src/utils/feeds';
import { buildTimeline } from '../src/utils/toolpathTimeline';
import { planToolpath } from '../src/utils/gcodeExporter';
import { clearGeomBBoxCache } from '../src/utils/geom';
import { DEFAULT_CNC_TOOLS } from '../src/utils/tooling';
import type { EtchDocument, EtchElement } from '../src/types/etch';

/**
 * What the machine on the other end of the cable can actually do.
 *
 * Everything here used to be a constant: 500 mm/s², a 0.01 mm junction
 * deviation, and a 4000 mm/min feed ceiling. GRBL reports all three, and the
 * difference between reading them and inventing them is the difference between
 * an estimate and a guess — and, for the feed ceiling, between a machine
 * running at its own speed and one held to a number in a file.
 */

/** A realistic `$$` dump, with the noise a live connection puts in it. */
const DUMP = `
ok
<Idle|MPos:0.000,0.000,0.000|FS:0,0>
$11=0.040
$20=1
$22=1
$30=24000
$31=8000
$110=8000.000
$111=8000.000
$112=1500.000
$120=900.000
$121=900.000
$122=250.000
$130=400.000
$131=400.000
$132=80.000
ok
`.split('\n');

describe('parseGrblSettings', () => {
  it('picks the settings out of a live connection and ignores the rest', () => {
    const s = parseGrblSettings(DUMP);
    expect(s.get(11)).toBe(0.04);
    expect(s.get(120)).toBe(900);
    expect(s.size).toBe(14);
  });

  it('comes back empty for a board that answered nothing', () => {
    expect(parseGrblSettings(['ok', '<Idle|MPos:0,0,0>']).size).toBe(0);
  });
});

describe('motionProfileFromSettings', () => {
  it('reads the machine and says that is where it came from', () => {
    const p = motionProfileFromSettings(parseGrblSettings(DUMP));
    expect(p.source).toBe('machine');
    expect(p.accel).toEqual({ x: 900, y: 900, z: 250 });
    expect(p.maxRate).toEqual({ x: 8000, y: 8000, z: 1500 });
    expect(p.junctionDeviation).toBe(0.04);
    expect(p.spindle).toEqual({ min: 8000, max: 24000 });
    expect(p.travel).toEqual({ x: 400, y: 400, z: 80 });
    expect(p.homingEnabled).toBe(true);
    expect(p.softLimits).toBe(true);
  });

  it('falls back per field rather than throwing the lot away', () => {
    // A controller that renumbers or omits Y still has a perfectly good X.
    const p = motionProfileFromSettings(parseGrblSettings(['$120=900', '$110=8000']));
    expect(p.accel).toEqual({ x: 900, y: 900, z: DEFAULT_MOTION_PROFILE.accel.z });
    expect(p.junctionDeviation).toBe(DEFAULT_MOTION_PROFILE.junctionDeviation);
    expect(p.source).toBe('machine');
  });

  it('will not claim to have read a machine that reported no motion figures', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$30=24000']));
    expect(p.source).toBe('assumed');
    // The spindle it *did* report is still kept: half an answer is not none.
    expect(p.spindle).toEqual({ min: 0, max: 24000 });
  });

  it('treats a zero as absent, because no axis has no acceleration', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$120=0', '$11=0', '$110=8000']));
    expect(p.accel.x).toBe(DEFAULT_MOTION_PROFILE.accel.x);
    expect(p.junctionDeviation).toBe(DEFAULT_MOTION_PROFILE.junctionDeviation);
  });

  it('keeps travel all-or-nothing, so half an envelope never rejects a job', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$130=400', '$120=900', '$110=8000']));
    expect(p.travel).toBeNull();
  });
});

describe('per-axis limits', () => {
  const p = motionProfileFromSettings(parseGrblSettings(DUMP));

  it('gives a pure X move all of X', () => {
    expect(accelAlong(p, 1, 0, 0)).toBeCloseTo(900, 6);
    expect(maxRateAlong(p, 1, 0, 0)).toBeCloseTo(8000, 6);
  });

  it('governs a plunge by Z alone', () => {
    expect(accelAlong(p, 0, 0, -1)).toBeCloseTo(250, 6);
    expect(maxRateAlong(p, 0, 0, -1)).toBeCloseTo(1500, 6);
  });

  it('drags a move with any Z in it down to what Z can manage', () => {
    // The retract-and-traverse between hatch lines, which a job is made of.
    expect(maxRateAlong(p, 10, 0, 10)).toBeLessThan(8000);
  });
});

describe('cuttingFeedCeiling', () => {
  it('is the slower of X and Y, because a path goes in every direction', () => {
    const p = motionProfileFromSettings(parseGrblSettings(['$110=8000', '$111=5000', '$120=900']));
    expect(cuttingFeedCeiling(p)).toBe(5000);
  });

  it('is the fallback gantry figure when nothing has been read', () => {
    expect(cuttingFeedCeiling(DEFAULT_MOTION_PROFILE)).toBe(MAX_CUTTING_FEED_MM_MIN);
  });
});

describe('feeds follow the machine, not a constant', () => {
  const tool = DEFAULT_CNC_TOOLS[0];
  const spindle = { min: 8000, max: 24000 };
  const machine = (maxRate: number) =>
    motionProfileFromSettings(
      parseGrblSettings([`$110=${maxRate}`, `$111=${maxRate}`, '$120=900'])
    );

  it('lets a fast gantry have the feed its chipload asks for', () => {
    const quick = deriveFeeds(tool, 'plywood', spindle, machine(12000))!;
    const slow = deriveFeeds(tool, 'plywood', spindle, machine(1200))!;
    expect(quick.feed).toBeGreaterThan(slow.feed);
    expect(slow.feed).toBeLessThanOrEqual(1200);
  });

  it('gives that machine its RPM back too, which the ceiling was also costing', () => {
    /*
     * Chipload is feed per revolution, so a clamped feed is answered by turning
     * the spindle *down* to keep the chip the right thickness. A ceiling below
     * what the gantry can hold therefore took the spindle speed with it — the
     * cap cost more than it looked like it cost, which is why replacing it with
     * a bigger constant was never the fix.
     */
    const quick = deriveFeeds(tool, 'plywood', spindle, machine(12000))!;
    const slow = deriveFeeds(tool, 'plywood', spindle, machine(1200))!;
    expect(quick.rpm).toBeGreaterThan(slow.rpm);
  });

  it('says so, rather than quietly cutting slower than the drawing implies', () => {
    // A spindle that will turn slowly enough to hold chipload at the gantry's
    // ceiling, so the note is about the gantry rather than about the spindle.
    const slow = deriveFeeds(tool, 'plywood', { min: 5000, max: 24000 }, machine(1200))!;
    expect(slow.notes.join(' ')).toContain('1200 mm/min');
    expect(slow.feed).toBeLessThanOrEqual(1200);
  });
});

function tracedDoc(): EtchDocument {
  // A circle: flattened to many short segments, so every point is a corner and
  // the job is governed by how much speed survives one.
  return {
    id: 'd', name: 'Traced', width: 200, height: 150, gridSize: 10, snapToGrid: false,
    machine: 'laser', material: 'plywood', stockThickness: 3, origin: 'top-left',
    layers: [{
      id: 'cut', name: 'Cut', color: '#f00', operation: 'cut', tool: 1,
      visible: true, locked: false, speed: 3000, power: 80, passes: 1, zDepth: 3,
    }],
    elements: [{
      id: 'c', name: 'Circle', type: 'circle', layerId: 'cut', x: 40, y: 40, w: 80, h: 80,
      rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, strokeWidth: 0.2,
      visible: true, locked: false,
    } as EtchElement],
  } as EtchDocument;
}

describe('the estimate answers to the machine', () => {
  const timelineFor = (motion?: ReturnType<typeof motionProfileFromSettings>) => {
    clearGeomBBoxCache();
    const { segments } = planToolpath(tracedDoc(), { laserMode: true });
    return buildTimeline(segments, { travelSpeed: 3000, laserMode: true, motion });
  };

  it('is quicker on a machine that accelerates harder', () => {
    const stiff = motionProfileFromSettings(parseGrblSettings(['$120=2000', '$121=2000', '$110=10000', '$111=10000']));
    const soft = motionProfileFromSettings(parseGrblSettings(['$120=80', '$121=80', '$110=3000', '$111=3000']));
    expect(timelineFor(stiff).minutes).toBeLessThan(timelineFor(soft).minutes);
  });

  it('is quicker when the operator has loosened $11, which is the free speed-up', () => {
    const base = ['$120=500', '$121=500', '$110=6000', '$111=6000'];
    const tight = motionProfileFromSettings(parseGrblSettings([...base, '$11=0.010']));
    const slack = motionProfileFromSettings(parseGrblSettings([...base, '$11=0.050']));
    expect(timelineFor(slack).minutes).toBeLessThan(timelineFor(tight).minutes);
  });
});

describe('describeMotionProfile', () => {
  it('offers an instruction when nothing is plugged in', () => {
    expect(describeMotionProfile(DEFAULT_MOTION_PROFILE, false)).toContain('connect the machine');
  });

  it('does not tell someone to connect a machine that is already connected', () => {
    const line = describeMotionProfile(DEFAULT_MOTION_PROFILE, true);
    expect(line).not.toContain('connect the machine');
    expect(line).toContain('$$');
  });

  it('names $11 when the figures came off the machine', () => {
    const line = describeMotionProfile(motionProfileFromSettings(parseGrblSettings(DUMP)), true);
    expect(line).toContain('$11=0.04');
  });
});
