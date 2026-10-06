// Full-application composition fixture. Renders the real <App/> with the same
// provider stack as src/main.tsx against a mocked Tauri bridge, so Notebook and
// the AI sidebar are exercised as they actually ship (App applies the theme
// classes from settings, builds the model picker from the provider registry and
// mounts StudyWorkspace + AISidebar together). No production code is mocked.
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from '../../src/App';
import { ErrorBoundary } from '../../src/components/ErrorBoundary';
import { DialogProvider } from '../../src/components/DialogProvider';
import { IngestionProvider } from '../../src/services/ingestionStore';
import { ChatLibraryProvider } from '../../src/services/chatLibrary';
import type { AppSettings } from '../../src/types';
import '../../src/index.css';

const query = new URLSearchParams(location.search);
const calls: Array<{ command: string; args: any }> = [];

const sources = [
  { id: 's1', title: 'திருக்குறள் · Virtue and learning', path: 'Literature/திருக்குறள்.md', text: 'Selected Tamil source.', hash: 'h1', missing: false },
  { id: 's2', title: 'Testing fundamentals', path: 'Computer Science/Testing.md', text: 'Tests verify behavior.', hash: 'h2', missing: false },
];
let collections = [
  { id: 'c1', title: 'Learning across disciplines', sourceIds: ['s1', 's2'], revision: 1 },
  { id: 'c2', title: 'அறத்துப்பால் · A deliberately long notebook title for multilingual study', sourceIds: ['s1'], revision: 1 },
];
if (query.has('empty')) collections = [];
const artifacts = query.has('empty') ? [] : [{
  id: 'a1', collectionId: 'c1', kind: 'flashcards' as const, title: 'Thirukkural structure', version: 1,
  parentId: null, snapshotId: 'snap', created: 1700000000,
  body: { cards: [{ id: 'f1', front: 'What are the three main sections?', back: 'Virtue, wealth, and love.', sourceIds: ['s1'] }] },
}];
const snapshot = { id: 'snap', sources, context: sources.map(s => s.text).join('\n'), excerpts: false, created: 1 };

// Query drives the *settings* the app boots with, so the theme classes are
// applied by App's own effect rather than by the fixture.
const settings = {
  vaultPath: '/vault',
  appearance: {
    themeStyle: query.get('theme') || 'industrial',
    themeMode: query.get('mode') || 'dark',
    // 'notebook' composes the library; any other page composes the AI sidebar
    // (App hides the sidebar on the Notebook page, which owns its own chat).
    startupView: query.get('view') || 'notebook',
    aiPanelOpenOnStart: true,
    sidebarCollapsedOnStart: false,
  },
  linking: { backfillOnVaultOpen: false },
  system: { watchVault: false, syncH1OnStartup: false, versionRetentionDays: 0 },
  omniRoute: { provider: 'fixture', apiKey: 'fixture-key', baseUrl: 'https://fixture.example/v1', model: 'default-model', temperature: 0.7, injectUserProfile: false, userProfile: '' },
  models: {
    privacy: 'ask_before_cloud',
    idleSeconds: 300,
    routes: {},
    providers: [
      { id: 'm1', name: 'Fixture model', config: { provider: 'openai', baseUrl: 'https://fixture.example/v1', model: 'fixture-1' }, capabilities: ['generation'] },
      { id: 'm2', name: 'Other model', config: { provider: 'openai', baseUrl: 'https://fixture.example/v1', model: 'fixture-2' }, capabilities: ['generation'] },
    ],
  },
} as unknown as AppSettings;

Object.assign(window, { fixtureCalls: calls, fixtureSettings: settings });
Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener: () => {} } });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command: string, args: any = {}) => {
      calls.push({ command, args });
      if (command.startsWith('plugin:')) return command.endsWith('is_maximized') ? false : null;
      switch (command) {
        case 'get_runtime_config': return structuredClone(settings);
        case 'save_runtime_config': return { settings: structuredClone(args.config), runtimeWarning: null };
        case 'purge_expired_history': return null;
        case 'index_vault': return { files: [], folders: [] };
        case 'get_graph': return { nodes: [], links: [] };
        case 'get_ingestion_engine_status': return { engine: 'rust', rustAvailable: true };
        case 'model_service_status': return { state: 'ready', command: '', message: 'Ready' };
        case 'agent_list_tools': return [{ name: 'read_note', description: 'Read a note', requiresApproval: false }];
        case 'study_request': {
          const payload = args.payload ?? {};
          switch (args.action) {
            case 'collections': return structuredClone(collections);
            case 'artifacts': return structuredClone(artifacts.filter(a => !payload.collectionId || a.collectionId === payload.collectionId));
            case 'sources': return sources.filter(s => collections.find(c => c.id === payload.collectionId)?.sourceIds.includes(s.id));
            case 'notes': return { items: sources, nextOffset: null };
            case 'chat': return { session: null, collectionId: payload.collectionId ?? null, managed: true, messages: [] };
            default: return null;
          }
        }
        default:
          // Unknown commands stay benign so a composed smoke test reports what
          // the app actually reaches for instead of failing inside the bridge.
          if (command.startsWith('list_')) return [];
          return null;
      }
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <ErrorBoundary fallbackTitle="Application Error">
      <IngestionProvider>
        <ChatLibraryProvider>
          <DialogProvider>
            <App />
          </DialogProvider>
        </ChatLibraryProvider>
      </IngestionProvider>
    </ErrorBoundary>
  </StrictMode>
);
