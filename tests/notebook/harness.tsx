// Test-only browser harness. No production code contains a mock backend.
import React, { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { NotebookPage } from '../../src/components/notebook/NotebookPage';
import { DialogProvider } from '../../src/components/DialogProvider';
import { ChatLibraryProvider } from '../../src/services/chatLibrary';
import type { ChatLibrarySession, ChatLibraryMessage } from '../../src/services/knowledge';
import { TitleBar } from '../../src/components/TitleBar';
import { LiquidGlass } from '../../src/components/LiquidGlass';
import type { AppPage, AppSettings } from '../../src/types';
import '../../src/index.css';

let workspace = '';
const notebook = { id: 'notebook:research', name: 'Learning how we learn', description: 'Memory, attention, and the science of studying.', archived: false, source_count: 2, note_count: 1, created: '', updated: '' };
let rows = [notebook];
const notes = [{ id: 'note:summary', title: 'Research summary', content: 'Spacing practice improves long-term retention. [source:memory]', note_type: 'human', created: '', updated: '' }];
const messages = [{ id: 'human:1', type: 'human', content: 'What helps us remember what we study?' }, { id: 'ai:1', type: 'ai', content: 'Retrieval practice and spaced repetition work together. Return to a topic over several days, and test what you can recall before reviewing. [source:memory]\n\n- Space your sessions\n- Ask yourself questions\n- Connect new ideas to familiar ones' }];
const sources = [{ id: 'source:memory', title: 'The science of memory', full_text: 'Retrieval practice strengthens memory.', status: 'completed', embedded: true, insights_count: 1 }, { id: 'source:attention', title: 'Attention and learning', full_text: 'Focused attention supports encoding.', status: 'completed', embedded: true, insights_count: 0 }];
const calls: { command: string; args: Record<string, any> }[] = [];
const chats = new Map<string, ChatLibrarySession[]>();
const transcripts = new Map<string, ChatLibraryMessage[]>();
Object.assign(window, { fixtureCalls: calls });
Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener: () => {} } });
Object.defineProperty(window, '__TAURI_INTERNALS__', { value: {
  metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
  transformCallback: () => 1, unregisterCallback: () => {},
  invoke: async (command: string, args: Record<string, any> = {}) => {
    calls.push({ command, args });
    if (command.startsWith('plugin:')) return command.endsWith('is_maximized') ? false : null;
    if (command === 'notebook_start') { workspace = args.vaultPath; return { state: 'ready', workspaceId: workspace, vaultPath: workspace }; }
    if (command === 'notebook_stop') { workspace = ''; return null; }
    if (command === 'notebook_status') return { state: 'ready', workspaceId: workspace };
    // Shared chat commands are scoped by the active vault, not workspaceId arguments.
    if (command === 'list_chat_sessions') return structuredClone(chats.get(workspace) ?? []);
    if (command === 'link_notebook_session') {
      const rows = chats.get(workspace) ?? [];
      let row = rows.find(r => r.notebookSessionId === args.notebookSessionId);
      if (!row) {
        row = { id: `${workspace}:chat:${args.notebookSessionId}`, title: args.title, origin: 'notebook', notebookSessionId: args.notebookSessionId, notebookId: args.notebookId, sourceId: args.sourceId, model: args.model, createdAt: 0, updatedAt: 0, messageCount: 0 };
        rows.push(row);
        chats.set(workspace, rows);
      } else Object.assign(row, { title: args.title, notebookId: args.notebookId, sourceId: args.sourceId, model: args.model });
      return structuredClone(row);
    }
    if (command === 'get_chat_messages') return structuredClone(transcripts.get(args.sessionId) ?? []);
    if (command === 'replace_chat_transcript') {
      const messages = args.messages.map(([role, content, metadata]: [ChatLibraryMessage['role'], string, string | null], i: number) => ({ id: `${args.sessionId}:${i}`, sessionId: args.sessionId, role, content, metadata, createdAt: i }));
      transcripts.set(args.sessionId, messages);
      const row = (chats.get(workspace) ?? []).find(r => r.id === args.sessionId);
      if (row) row.messageCount = messages.length;
      return messages.length;
    }
    if (args.workspaceId !== workspace) throw new Error('Wrong vault');
    if (command === 'notebook_export') return `${args.title}.md`;
    if (command === 'notebook_read_vault_note') return '# Vault note\nA selected snapshot.';
    if (command === 'notebook_add_source') return { id: 'source:import', full_text: args.fields.content };
    if (command !== 'notebook_request') throw new Error(`Unexpected command ${command}`);
    const path = args.path.split('?')[0]; const method = args.method;
    if (path === '/api/notebooks') {
      if (method === 'POST') { const n = { ...notebook, ...args.body, id: `notebook:n${rows.length}` }; rows.push(n); return n; }
      return workspace === '/vault-b' ? [] : rows;
    }
    if (path === '/api/models') return [{ id: 'model:chat', name: 'Research model', type: 'language', provider: 'openai' }];
    if (path === '/api/models/defaults') return { default_chat_model: 'model:chat' };
    if (path === '/api/sources') return sources;
    if (path.endsWith('/insights')) return [{ id: 'source_insight:one', source_id: 'source:memory', insight_type: 'Summary', content: 'Learning improves when practice is spaced.' }];
    if (path.startsWith('/api/sources/source:')) return sources.find(s => path.endsWith(s.id));
    if (path === '/api/notes') return notes;
    if (path.startsWith('/api/notes/note:')) { if (method === 'PUT') Object.assign(notes[0], args.body); return notes[0]; }
    if (path === '/api/chat/sessions') return [{ id: 'chat_session:first', title: 'Remembering what matters', message_count: 2 }];
    if (path.startsWith('/api/chat/sessions/')) return { id: 'chat_session:first', title: 'Remembering what matters', messages };
    if (path === '/api/chat/context') return { context: {}, token_count: 10, char_count: 40 };
    if (path === '/api/chat/execute') { messages.push({ id: 'ai:2', type: 'ai', content: 'A fresh answer for your research.' }); return { messages }; }
    if (path === '/api/transformations') return [{ id: 'transformation:summary', name: 'summary', title: 'Summarize', description: 'Find the essential ideas.', prompt: 'Summarize the source.', apply_default: false }];
    if (path === '/api/providers') return [{ name: 'openai', display_name: 'OpenAI', modalities: ['language'] }];
    if (path === '/api/settings') return {};
    if (path === '/api/capabilities') return { docling_available: false };
    if (['/api/credentials', '/api/podcasts/episodes', '/api/episode-profiles', '/api/speaker-profiles', '/api/commands/jobs'].includes(path)) return [];
    if (path === '/api/search') return { results: [{ id: 'source:memory', title: 'The science of memory', content: 'Retrieval practice.' }], total_count: 1, search_type: 'text' };
    throw new Error(`Unexpected route ${method} ${path}`);
  },
} });

const params = new URLSearchParams(location.search);
document.documentElement.className = `theme-${params.get('theme') || 'industrial'} mode-${params.get('mode') || 'dark'}`;
function Harness() {
  const [page, setPage] = useState<AppPage>('notebook');
  const [vault, setVault] = useState('/vault-a');
  const settings = { notebook: { sourcePanelWidth: 270, notesPanelWidth: 270, embedByDefault: false }, omniRoute: { provider: '', apiKey: '', baseUrl: '', model: '', temperature: .7, injectUserProfile: false, userProfile: '' } } as AppSettings;
  return <div className="bg-base text-slate-100 h-screen flex flex-col">
    <TitleBar layout={page} onLayoutChange={setPage} onNewNote={() => {}} onNewFolder={() => {}} onOpenPrism={() => {}} onIngestContent={() => {}} onSettings={() => {}} onReload={() => {}} onToggleIngestionLogs={() => {}} onToggleSidebar={() => {}} sidebarVisible showAI={false} onToggleAI={() => {}}/>
    <div className="nb-toolbar"><button onClick={() => setVault(v => v === '/vault-a' ? '/vault-b' : '/vault-a')}>Switch test vault</button><span>{vault}</span></div>
    <LiquidGlass className="flex-1 min-h-0"><NotebookPage key={vault} active={page === 'notebook'} vaultPath={vault} vaultNotes={[{ path: '/vault-a/Study.md', relativePath: 'Study.md', title: 'Study', name: 'Study.md', updatedAt: 0 }]} settings={settings} onSelectVault={() => {}} onVaultExport={async () => {}}/>{page !== 'notebook' && <p>Other Prism page</p>}</LiquidGlass>
  </div>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><ChatLibraryProvider><DialogProvider><Harness/></DialogProvider></ChatLibraryProvider></StrictMode>);
