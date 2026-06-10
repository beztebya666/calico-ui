import React from 'react';
import ReactDOM from 'react-dom/client';
import { App, AppErrorBoundary } from './App';
import { isDemo, installDemo } from './lib/demo';
import { DemoBanner } from './components/DemoBanner';
import './styles/index.css';

// Demo build: swap in the in-browser mock backend before anything fetches.
if (isDemo()) installDemo();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <AppErrorBoundary>
      <App />
      {isDemo() && <DemoBanner />}
    </AppErrorBoundary>
  </React.StrictMode>,
);
