import {
  ArmingGate,
  createMachineHandlers,
  describeMachine,
  type ArmingState,
  type MachineControl,
} from '@physbox-io/machining';
import { webSerialManager } from './webSerialManager';
import { fetchMachineDevices } from './apiClient';
import { generateGCode } from './gcodeExporter';
import { readGuidePower } from './machineSettings';
import type { EtchDocument } from '../types/etch';

// ---------------------------------------------------------------------------
// Driving Etch's machine from MCP
// ---------------------------------------------------------------------------
//
// The command set and the arming gate are shared with Volt and Mesh. What is
// here is the part that is Etch's: cutting the document that is open, and the
// fact that most of the machines this app drives are lasers.
//
// That last point changes more than it looks. A laser has no Z in its toolpath,
// so there is no datum to get wrong and no probe cycle before a job — the
// zeroing that matters is XY, and the guide beam is how the operator sees where
// that is. Framing lights the beam for the same reason.

/**
 * The gate. One per tab, because there is one machine.
 *
 * Disarming cancels whatever the agent had running. A window closed while a job
 * is cutting has to stop the job — otherwise "stop letting Claude move this"
 * would be a button that changes nothing until the next command, which is the
 * opposite of what someone reaching for it wants.
 */
export const machineArming = new ArmingGate({
  onDisarm: () => {
    if (webSerialManager.isRunning() || webSerialManager.isJobPaused()) {
      void webSerialManager.cancelJob();
    }
  },
});

/** What the UI banner watches. */
export function subscribeToArming(listener: (state: ArmingState) => void): () => void {
  return machineArming.subscribe(listener);
}

/**
 * The document and tool rack, as the bridge last saw them.
 *
 * The handlers are built once and live as long as the tab, while the document
 * is store state that changes under them. The bridge points this at whatever it
 * is answering about, so a job is always of what is on screen — and at the rack
 * the operator is actually looking at, since an MCP-driven cut must not quietly
 * fall back to the stock tools they edited away from.
 */
let current: { document: EtchDocument | null; cncTools: unknown } = {
  document: null,
  cncTools: undefined,
};

export function setCurrentDocument(document: EtchDocument, cncTools: unknown): void {
  current = { document, cncTools };
}

/** The stock outline, which is what a framing lap traces. */
function jobBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const doc = current.document;
  if (!doc) return null;
  return { minX: 0, minY: 0, maxX: doc.width, maxY: doc.height };
}

/**
 * Cuts the document that is open.
 *
 * The G-code is generated from the same rack and settings the UI is showing,
 * for the same reason the export tool does it: a program cut with different
 * parameters than the operator is looking at is the worst kind of surprise.
 */
async function runCurrentDocument(args: Record<string, unknown>): Promise<{ summary: string }> {
  const doc = current.document;
  if (!doc) throw new Error('There is no document open to cut.');

  const gcode = generateGCode(doc, {
    customCncTools: current.cncTools,
    ...((args.options as object) ?? {}),
  } as Parameters<typeof generateGCode>[1]);

  if (!gcode || !gcode.trim()) {
    throw new Error(
      'The document produced no toolpath. Check that its layers have operations assigned and ' +
        'that any geometry is on the stock.'
    );
  }

  const started = webSerialManager.startJob(gcode);
  if (!started.started) throw new Error(started.message);

  const lines = gcode.split('\n').filter(l => l.trim()).length;
  return { summary: `${started.message} ${lines} lines streaming.` };
}

/** Etch's full machine command set, keyed by the bridge command names. */
export function createEtchMachineHandlers(): Record<
  string,
  (args: Record<string, any>) => Promise<unknown>
> {
  const machine: MachineControl = webSerialManager;

  const shared = createMachineHandlers({
    machine,
    gate: machineArming,
    options: {
      runJob: runCurrentDocument,
      jobBounds,
      /*
       * The guide beam is lit for the lap, which is the point of it on a laser:
       * the operator is watching where the outline falls on the material, and a
       * frame they cannot see answers nothing.
       */
      frameJob: async (bounds, args) =>
        webSerialManager.frameJob(bounds, {
          guidePower: typeof args.guidePower === 'number' ? args.guidePower : readGuidePower(),
          safeZ: typeof args.safeZMm === 'number' ? args.safeZMm : 5,
        }),
      listDevices: async () => {
        const devices = await fetchMachineDevices();
        return devices.map(d => ({ id: d.deviceId, name: d.name, online: d.online }));
      },
    },
  });

  return {
    MACHINE_STATUS: shared.status,
    MACHINE_SETTINGS: shared.settings,
    MACHINE_LIST_DEVICES: shared.devices,
    MACHINE_ARM: shared.arm,
    MACHINE_DISARM: shared.disarm,
    MACHINE_CONNECT: shared.connect,
    MACHINE_DISCONNECT: shared.disconnect,
    MACHINE_JOG: shared.jog,
    MACHINE_HOME: shared.home,
    MACHINE_UNLOCK: shared.unlock,
    MACHINE_GOTO_ORIGIN: shared.goto_origin,
    MACHINE_ZERO_XY: shared.zero_xy,
    MACHINE_FRAME_JOB: shared.frame_job,
    MACHINE_TRIM: shared.trim,
    MACHINE_PAUSE: shared.pause,
    MACHINE_RESUME: shared.resume,
    MACHINE_CANCEL: shared.cancel,
    MACHINE_ESTOP: shared.estop,
    RUN_JOB: shared.run_job,

    /**
     * Sets work Z0 where the tool is standing, allowing for a shim.
     *
     * Etch's own, and deliberately not a probe: this app's CNC path touches off
     * by hand or on a shim of known thickness, and on a laser there is no Z in
     * the toolpath at all, so there is nothing to probe toward.
     */
    MACHINE_ZERO_Z: async (args: Record<string, any>) => {
      machineArming.requireArmed('zero_z');
      machineArming.noteAgentCommand('zero_z', `shim=${args.shimThicknessMm ?? 0}`);
      const result = await webSerialManager.zeroZHere(args.shimThicknessMm ?? 0);
      if (!result.success) throw new Error(result.message);
      return {
        ...describeMachine(machine, machineArming),
        message: result.message,
        machineZ: result.machineZ,
      };
    },

    /**
     * Lights the laser at pointer power, so the operator can see where the head
     * actually is.
     *
     * The one command here with no equivalent in the other two apps, and the
     * one an agent should reach for before asking someone to zero XY: "the dot
     * is on the corner of your material" is a question they can answer, and
     * "the DRO reads 12.4" is not.
     */
    MACHINE_GUIDE_SPOT: async (args: Record<string, any>) => {
      machineArming.requireArmed('guide_spot');
      const on = args.on !== false;
      machineArming.noteAgentCommand('guide_spot', on ? 'on' : 'off');
      if (on) await webSerialManager.guideSpotOn(args.power ?? readGuidePower());
      else await webSerialManager.guideSpotOff();
      return { ...describeMachine(machine, machineArming), guideSpot: on };
    },

    /**
     * Probes a grid across the bed, for levelling a CNC job against stock that
     * is not flat. Meaningless on a laser, which has no Z to compensate.
     */
    MACHINE_PROBE_SURFACE: async (args: Record<string, any>) => {
      machineArming.requireArmed('probe_surface');
      machineArming.noteAgentCommand('probe_surface');

      const bounds = args.bounds && typeof args.bounds === 'object' ? args.bounds : jobBounds();
      if (!bounds) throw new Error('There is nothing to probe: pass bounds, or open a document.');

      const grid = await webSerialManager.probeGrid(
        bounds,
        typeof args.cols === 'number' ? args.cols : 3,
        typeof args.rows === 'number' ? args.rows : 3
      );
      const zs = grid.points.flat().map((p: { z: number }) => p.z);
      return {
        ok: true,
        cols: grid.gridX,
        rows: grid.gridY,
        spanMm: Math.max(...zs) - Math.min(...zs),
        missed: grid.missed,
        referencedTo: grid.referencedTo,
      };
    },
  };
}
