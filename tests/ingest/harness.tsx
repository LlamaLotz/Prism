import React from 'react';
import { createRoot } from 'react-dom/client';
import { IngestModal } from '../../src/components/IngestModal';
import { DialogProvider } from '../../src/components/DialogProvider';
import '../../src/index.css';
const fixture = { calls: [] as unknown[][] };
Object.assign(window, { ingestFixture: fixture });
createRoot(document.getElementById('root')!).render(<DialogProvider><IngestModal isOpen onClose={() => {}} onIngest={(...args) => fixture.calls.push(args)} /></DialogProvider>);
