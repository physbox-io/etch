import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDarkClass, readDarkMode, setSuiteParameterPusher } from '@physbox-io/ui';
import './index.css';
import App from './App.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { useStore } from './store/useStore';
import { guardUnsavedWork } from './utils/unsavedWork';
import { syncCloudParameters } from './utils/apiClient';
import { watchForInterruptedJob } from './utils/jobRestore';
import { webSerialManager } from './utils/webSerialManager';
import { rereferenceGrid } from './utils/bedLeveler';

guardUnsavedWork(useStore.getState);
// Before the first paint, so a dark page does not flash light while it loads.
applyDarkClass(readDarkMode('etch_dark_mode'));
setSuiteParameterPusher((p) => void syncCloudParameters('global', p));
watchForInterruptedJob();
// Whenever work Z0 is recorded, automatically re-reference any stored bed
// heightmap to the new Z datum so the user never has to re-probe the bed.
webSerialManager.onZDatumRecorded((xy) => {
  if (!xy) return;
  const { bedProbeGrid, setBedProbeGrid } = useStore.getState();
  if (bedProbeGrid && !bedProbeGrid.simulated) {
    setBedProbeGrid({ ...rereferenceGrid(bedProbeGrid, xy.x, xy.y), referencedTo: 'z-datum' });
  }
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
