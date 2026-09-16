import {
  CloudTransport as SharedCloudTransport,
  WebSerialTransport,
  type GrblTransport,
} from '@physbox-io/machining';
import { machineSocketUrl, submitMachineJob } from './apiClient';

/**
 * GRBL byte transports.
 *
 * Now `@physbox-io/machining`, shared with Mesh and Volt — all three had their
 * own copy of this file. The version in the package started as this one, so
 * nothing about the USB path has changed; what came back the other way is
 * Mesh's fix for a dead read pipe, which used to be swallowed here and left a
 * job sitting at line one looking like it was running.
 *
 * The only thing that stays local is where the cloud transport gets its
 * credentials: the package has no business reaching into this app's auth
 * storage, so it takes them as an argument and this supplies them.
 */
export { WebSerialTransport };
export type { GrblTransport };

/** The Tekno Box transport, wired to this app's API client. */
export class CloudTransport extends SharedCloudTransport {
  constructor(deviceId: string, baudRate = 115200) {
    super(deviceId, { machineSocketUrl, submitMachineJob }, baudRate);
  }
}
