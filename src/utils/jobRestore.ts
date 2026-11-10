/**
 * Puts back a job the last page left unfinished, and brings up Make to offer it.
 *
 * The machine writes every job down as it runs (`attachCheckpoint` in
 * `webSerialManager`). A reload, a sleep or a closed laptop used to lose the
 * program, and with it the Run From that picks a half-cut piece back up. Asked
 * on load and whenever the tab comes back to the front — the laptop on the bench
 * with twenty tabs open is the ordinary way back to a stopped job. Cheap when
 * there is nothing to find, and a no-op once a job is restored.
 */

import { useStore } from '../store/useStore';
import { webSerialManager } from './webSerialManager';

export async function restoreInterruptedJob(): Promise<void> {
  const found = await webSerialManager.restoreInterruptedJob();
  // Make holds the Run From panel that offers it.
  if (found) useStore.setState({ isGCodeModalOpen: true });
}

/** Looks now, and again each time the tab is brought back. */
export function watchForInterruptedJob(): void {
  void restoreInterruptedJob();
  const onBack = () => {
    if (document.visibilityState === 'visible') void restoreInterruptedJob();
  };
  document.addEventListener('visibilitychange', onBack);
  window.addEventListener('focus', onBack);
}
