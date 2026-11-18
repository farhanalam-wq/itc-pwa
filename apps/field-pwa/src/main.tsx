import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/hanken-grotesk';
import './styles.css';

function FieldShell() {
  return (
    <main className="shell">
      <p className="eyebrow">ITC FIELD SOURCE</p>
      <h1>Field capture</h1>
      <p>This workspace is scaffolded. Recording, offline storage, and sync are planned in the implementation roadmap.</p>
      <span className="state">Implementation phase 0 · scaffold</span>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <FieldShell />
  </StrictMode>
);
