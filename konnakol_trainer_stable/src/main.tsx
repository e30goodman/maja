import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import App from './App.tsx';
import './index.css';

declare global {
  interface WindowEventMap {
    pwaInstallable: Event;
  }
}

if (typeof window !== 'undefined') {
  window.addEventListener(
    'contextmenu',
    (e) => {
      e.preventDefault();
    },
    false,
  );

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    (window as Window & { deferredPwaPrompt?: Event }).deferredPwaPrompt = e;
    window.dispatchEvent(new Event('pwaInstallable'));
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {
        /* ignore registration errors in unsupported contexts */
      });
    });
  }
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
