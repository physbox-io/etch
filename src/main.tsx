import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { applyDarkClass, readDarkMode, setSuiteParameterPusher } from '@physbox-io/ui';
import './index.css';
import App from './App.tsx';
import { AppErrorBoundary } from './components/AppErrorBoundary';
import { useStore } from './store/useStore';
import { guardUnsavedWork } from './utils/unsavedWork';
import { syncCloudParameters } from './utils/apiClient';

guardUnsavedWork(useStore.getState);
// Before the first paint, so a dark page does not flash light while it loads.
applyDarkClass(readDarkMode('etch_dark_mode'));
setSuiteParameterPusher((p) => void syncCloudParameters('global', p));

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AppErrorBoundary>
      <App />
    </AppErrorBoundary>
  </StrictMode>
);
