import {
  ArmingGate,
  createMachineHandlers,
  describeMachine,
  type ArmingState,
  type MachineControl,
  requireNumber,
} from '@physbox-io/machining';
import { webSerialManager } from './webSerialManager';
import { fetchMachineDevices } from './apiClient';
import { generateGCode } from './gcodeExporter';
import { readGuidePower } from './machineSettings';
import { boundsToMachine } from './machineCoords';
import { hasJobZAxis, machineKind } from './tooling';
import { jobContextFor } from './jobContext';
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

/**
 * The stock outline in **machine** coordinates, which is what a framing lap
 * traces and a probe grid covers.
 *
 * Through `boundsToMachine` like every other thing the machine is told. This
 * used to hand back the document rectangle as it stood, which is only the same
 * numbers when the origin is a corner: on a `center` origin the job runs from
 * −w/2 to +w/2, and the lap went round a rectangle a quarter of the way off it.
 */
function jobBounds(): { minX: number; minY: number; maxX: number; maxY: number } | null {
  const doc = current.document;
  if (!doc) return null;
  return boundsToMachine(doc, { minX: 0, minY: 0, maxX: doc.width, maxY: doc.height });
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

  /*
   * The machine kind decides which safety checks the stream applies — a router
   * refuses to start without a trusted Z datum, a laser has none to check — and
   * it defaults to laser. Left out, an agent's router job streamed straight past
   * the Z check the Run button would have stopped it at. The job context is what
   * the archive files the run under, as it is for the button.
   */
  const started = await webSerialManager.runProgram(gcode, {
    machine: machineKind(doc),
    job: jobContextFor(doc),
  });
  if (!started.started) throw new Error(started.message);

  const lines = gcode.split('\n').filter(l => l.trim()).length;
  return { summary: `${started.message} ${lines} lines streaming.` };
}

/**
 * What a command's arguments are before anybody has looked at them.
 *
 * `unknown` rather than `any`: these arrive as JSON over the bridge, from an
 * agent that may be a different version of a different app, so every field is a
 * claim rather than a fact. The handlers below narrow what they read, which is
 * the point — a `power` that arrived as the string "80" is a malformed request
 * and is refused, rather than being handed to the machine or quietly swapped
 * for a default the caller did not ask for.
 */
type McpArgs = Record<string, unknown>;

/**
 * A number from an argument, or the fallback when it was not sent.
 *
 * Anything else is refused by name. This used to fall back silently on a bad
 * value, which is right for an argument nobody sent and wrong for one somebody
 * got wrong: `shimThicknessMm: "0.1"` quietly became 0, and work Z0 then landed
 * one paper-thickness low with every cut in the job that much deeper. The
 * refusal happens before anything moves, which is what makes it free.
 */
function num(args: McpArgs, name: string, fallback: number): number {
  return requireNumber(args, name, { default: fallback })!;
}

/** Etch's full machine command set, keyed by the bridge command names. */
export function createEtchMachineHandlers(): Record<
  string,
  (args: McpArgs) => Promise<unknown>
> {
  const machine: MachineControl = webSerialManager;

  const shared = createMachineHandlers({
    machine,
    gate: machineArming,
    options: {
      runJob: runCurrentDocument,
      jobBounds,
      /*
       * On a laser the guide beam is lit for the lap, which is the point of it:
       * the operator is watching where the outline falls on the material, and a
       * frame they cannot see answers nothing.
       *
       * On a router the same lap is the *spindle* turning at the guide power's
       * S word, wherever Z happens to be — and `laserMode` defaults to on, so
       * that is what an agent framing a router job got. A router frames lifted
       * to safe Z with the spindle off, which is the shared path.
       */
      frameJob: async (bounds, args) => {
        const doc = current.document;
        // With no document to say which machine this is, the beam stays off: an
        // unlit lap on a laser is a lap nobody can see, but a lit one on a
        // router is a spinning cutter.
        const laser = !!doc && !hasJobZAxis(machineKind(doc));
        return webSerialManager.frameJob(bounds, {
          laserMode: laser,
          guidePower: num(args, 'guidePower', readGuidePower()),
          safeZ: num(args, 'safeZMm', 5),
        });
      },
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
    MACHINE_ZERO_Z: async (args: McpArgs) => {
      machineArming.requireArmed('zero_z');
      const shim = num(args, 'shimThicknessMm', 0);
      machineArming.noteAgentCommand('zero_z', `shim=${shim}`);
      const result = await webSerialManager.zeroZHere(shim);
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
    MACHINE_GUIDE_SPOT: async (args: McpArgs) => {
      machineArming.requireArmed('guide_spot');
      const on = args.on !== false;
      /*
       * The guide spot is `M3` at a low S word. On a laser that is a dot of
       * light; on a router it is the spindle starting, at whatever speed that S
       * word maps to, with the cutter wherever it was left — possibly sitting
       * on the stock. Off is always allowed: it is `M5`, and stopping a spindle
       * is never the wrong thing to have done.
       */
      if (on && current.document && hasJobZAxis(machineKind(current.document))) {
        throw new Error(
          'The guide spot is for a laser: on this router it would start the spindle. To see where ' +
            'the tool is, jog it and read the position, or frame the job with the spindle off.'
        );
      }
      machineArming.noteAgentCommand('guide_spot', on ? 'on' : 'off');
      if (on) await webSerialManager.guideSpotOn(num(args, 'power', readGuidePower()));
      else await webSerialManager.guideSpotOff();
      return { ...describeMachine(machine, machineArming), guideSpot: on };
    },

    /**
     * Probes a grid across the bed, for levelling a CNC job against stock that
     * is not flat. Meaningless on a laser, which has no Z to compensate.
     */
    MACHINE_PROBE_SURFACE: async (args: McpArgs) => {
      machineArming.requireArmed('probe_surface');
      machineArming.noteAgentCommand('probe_surface');

      const bounds =
        args.bounds && typeof args.bounds === 'object'
          ? (args.bounds as ReturnType<typeof jobBounds>)
          : jobBounds();
      if (!bounds) throw new Error('There is nothing to probe: pass bounds, or open a document.');

      const grid = await webSerialManager.probeGrid(
        bounds,
        num(args, 'cols', 3),
        num(args, 'rows', 3)
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
