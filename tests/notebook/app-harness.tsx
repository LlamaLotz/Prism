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
// Vault filesystem fixtures for the sidebar's note/folder actions. Two notes
// share a title across folders so move-collision handling is exercisable.
let vaultFiles = [
  { path: '/vault/Research/Field notes.md', relativePath: 'Research/Field notes.md', name: 'Field notes.md', title: 'Field notes', updatedAt: 1 },
  { path: '/vault/Drafts/Field notes.md', relativePath: 'Drafts/Field notes.md', name: 'Field notes.md', title: 'Field notes', updatedAt: 1 },
  { path: '/vault/Loose.md', relativePath: 'Loose.md', name: 'Loose.md', title: 'Loose', updatedAt: 1 },
];
let vaultFolders = ['Research', 'Drafts'];
if (query.has('empty')) { vaultFiles = []; vaultFolders = []; }
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
    liquidGlassOpacity: 0.93,
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

// ?unconfigured models a fresh install: no provider, endpoint or model was ever
// chosen, so the assistant must present "None" instead of a hidden default.
if (query.has('unconfigured')) {
  settings.omniRoute.provider = '';
  settings.omniRoute.apiKey = '';
  settings.omniRoute.baseUrl = '';
  settings.omniRoute.model = '';
  if (settings.models) settings.models.providers = [];
}
if (query.has('gemini')) {
  settings.omniRoute.provider = 'google';
  settings.omniRoute.apiKey = 'fixture-only-key';
  settings.omniRoute.baseUrl = 'https://generativelanguage.googleapis.com/v1beta/openai/';
  settings.omniRoute.model = 'gemini-2.5-flash';
}

const noteContents: Record<string,string> = {};
const documentId = 'a'.repeat(64);
let annotationFile = JSON.parse(localStorage.getItem('fixture-annotations') || 'null') || { version: 1, documentId, revision: 0, entries: [] };

// ---- Offline structure command fixtures ---------------------------------
// These mocks mirror the contract shapes closely enough to exercise the real
// UI without a bundled model. Query flags:
//   ?structure-model=ready|missing|invalid|unavailable  (default missing)
//   ?structure-error=status|inspect|format|plan
//   ?structure-error-code=EXACT_PREFIX
const structureModelState = query.get('structure-model') || 'missing';
const structureErrorTarget = query.get('structure-error');
const structureErrorCode = query.get('structure-error-code');

function failStructureCommand(target: string, fallbackCode: string) {
  if (structureErrorTarget === target) {
    throw new Error(`${structureErrorCode || fallbackCode}: fixture ${target} failure`);
  }
}

function headingText(text: string) {
  return text.trim().replace(/^#{1,6}\s*/, '').replace(/\s*#+\s*$/, '').trim();
}

function fixtureStructureInspect(request: any) {
  failStructureCommand('inspect', 'LIMIT');
  const title = String(request?.title ?? 'Note');
  const content = String(request?.content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const lines = content.split('\n');
  const blocks: any[] = [];
  let inFence = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      const marker = trimmed[0];
      const start = i;
      inFence = true;
      i++;
      while (i < lines.length) {
        if (lines[i].trimStart().startsWith(marker.repeat(3))) {
          inFence = false;
          break;
        }
        i++;
      }
      blocks.push({
        id: `b${blocks.length}`,
        kind: 'code',
        level: null,
        text: lines.slice(start, Math.min(i + 1, lines.length)).join('\n'),
        startLine: start + 1,
        endLine: Math.min(i + 1, lines.length),
      });
      continue;
    }
    if (inFence) continue;

    const heading = line.match(/^(#{1,6})\s+/);
    if (heading) {
      blocks.push({
        id: `b${blocks.length}`,
        kind: 'heading',
        level: heading[1].length,
        text: line,
        startLine: i + 1,
        endLine: i + 1,
      });
      continue;
    }

    const start = i;
    i++;
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,6})\s+/.test(lines[i]) &&
      !lines[i].trimStart().startsWith('```') &&
      !lines[i].trimStart().startsWith('~~~')
    ) {
      i++;
    }
    i--;
    blocks.push({
      id: `b${blocks.length}`,
      kind: 'paragraph',
      level: null,
      text: lines.slice(start, i + 1).join('\n'),
      startLine: start + 1,
      endLine: i + 1,
    });
  }

  const limit = Number(request?.maxBlocks ?? 5000);
  if (blocks.length > limit) {
    throw new Error(`LIMIT: structure inspection found ${blocks.length} blocks (limit ${limit})`);
  }

  const outline: any[] = [];
  const stack: any[] = [];
  for (const block of blocks) {
    for (const node of stack) node.endBlock = block.id;
    if (block.kind !== 'heading') continue;
    const node = {
      id: block.id,
      title: headingText(block.text) || 'Untitled heading',
      level: block.level,
      startBlock: block.id,
      endBlock: block.id,
      children: [] as any[],
    };
    while (stack.length > 0 && stack[stack.length - 1].level >= node.level) stack.pop();
    if (stack.length > 0) stack[stack.length - 1].children.push(node);
    else outline.push(node);
    stack.push(node);
  }

  const counts: Record<number, number> = {};
  for (const block of blocks) {
    if (block.kind === 'heading') counts[block.level] = (counts[block.level] ?? 0) + 1;
  }
  const splitOptions: any[] = [];
  for (let level = 1; level <= 6; level++) {
    const count = counts[level] ?? 0;
    if (count === 0) continue;
    splitOptions.push({
      mode: 'headings',
      level,
      sections: count,
      label: `Heading ${level} · ${count} section${count === 1 ? '' : 's'}`,
    });
  }
  const paragraphBlocks = blocks.filter((block) => block.kind !== 'heading').length;
  const chunks = blocks.length > 0 ? Math.max(1, Math.ceil(paragraphBlocks / 2)) : 0;
  if (chunks > 0) {
    splitOptions.push({
      mode: 'paragraph',
      level: null,
      sections: chunks,
      label: `Paragraph chunks · ${chunks} section${chunks === 1 ? '' : 's'}`,
    });
  }
  splitOptions.push({ mode: 'topics', level: null, sections: 0, label: 'Topics · local model' });

  const warnings: string[] = [];
  if (Object.keys(counts).length === 0) {
    warnings.push('No headings found; topic analysis or paragraph chunks are required.');
  }
  if (blocks.length === 0) warnings.push('The note has no content blocks.');

  return { title, blocks, outline, splitOptions, warnings };
}

function fixturePreviewFormat(request: any) {
  failStructureCommand('format', 'LIMIT');
  const content = String(request?.content ?? '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const title = String(request?.title ?? '').trim() || 'Note';
  const frontmatterMatch = content.match(/^---\n[\s\S]*?\n---\n+/);
  const frontmatter = frontmatterMatch?.[0] ?? '';
  const body = content.slice(frontmatter.length);
  const out: string[] = [];
  let inFence = false;

  for (const rawLine of body.split('\n')) {
    const line = rawLine.replace(/[ \t]+$/, '');
    const trimmed = line.trimStart();
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (inFence) {
      out.push(line);
      continue;
    }
    const match = line.match(/^(#{1,6})[ \t]*(.*?)[ \t]*#*[ \t]*$/);
    if (!match) {
      out.push(line);
      continue;
    }
    const text = match[2].trim();
    if (match[1].length === 1 && text.toLowerCase() === title.toLowerCase()) continue;
    const level = match[1].length === 1 ? 2 : match[1].length;
    out.push(`${'#'.repeat(level)}${text ? ` ${text}` : ''}`);
  }

  const normalizedBody = out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  const formatted = `${frontmatter}# ${title}\n${normalizedBody ? `\n${normalizedBody}\n` : ''}`;
  return {
    content: formatted,
    changed: formatted !== content,
    outline: fixtureStructureInspect({ title, content: formatted }).outline,
    warnings: [],
  };
}

function fixtureParagraphStarts(blocks: any[], targetChars: number) {
  const starts = [0];
  let chars = 0;
  for (let i = 0; i < blocks.length; i++) {
    const length = blocks[i].text.length;
    if (i > 0 && chars + length > targetChars) {
      starts.push(i);
      chars = 0;
    }
    chars += length + 2;
  }
  if (starts.length === 1 && blocks.length > 1) starts.push(Math.floor(blocks.length / 2));
  return starts;
}

function fixturePlanSplit(request: any) {
  failStructureCommand('plan', 'INVALID_OUTPUT');
  const title = String(request?.title ?? 'Note');
  const content = String(request?.content ?? '');
  const inspection = fixtureStructureInspect({ title, content });
  const blocks = inspection.blocks;
  if (blocks.length === 0) throw new Error('INVALID_INPUT: the note has no content');

  const requestedMode = String(request?.mode ?? 'auto');
  const targetChars = Number(request?.targetChars ?? 6000);
  const headingsAt = (level: number) =>
    blocks.map((block, index) => (block.kind === 'heading' && block.level === level ? index : -1)).filter((index) => index >= 0);
  const usableHeadingLevel = [2, 1, 3, 4, 5, 6].find((level) => headingsAt(level).length >= 2) ?? null;

  let mode = requestedMode;
  let level: number | null = null;
  let starts: number[] = [];
  let modelUsed = false;
  const warnings: string[] = [];

  if (requestedMode === 'headings') {
    level = Number(request?.level ?? 0);
    starts = headingsAt(level);
    if (starts.length < 2) {
      throw new Error(`INVALID_INPUT: found ${starts.length} H${level} sections; need at least two`);
    }
  } else if (requestedMode === 'topics') {
    if (usableHeadingLevel) {
      mode = 'topics';
      level = usableHeadingLevel;
      starts = headingsAt(level);
      warnings.push('Usable headings found; using the deterministic heading split instead of the local model.');
    } else if (structureModelState !== 'ready') {
      throw new Error('MODEL_UNAVAILABLE: fixture structure model is not staged');
    } else {
      mode = 'topics';
      level = 2;
      starts = fixtureParagraphStarts(blocks, targetChars);
      modelUsed = true;
      warnings.push('Local model proposed section boundaries; review the preview before applying.');
    }
  } else if (requestedMode === 'paragraph') {
    mode = 'paragraph';
    starts = fixtureParagraphStarts(blocks, targetChars);
  } else {
    if (usableHeadingLevel) {
      mode = 'auto';
      level = usableHeadingLevel;
      starts = headingsAt(level);
    } else {
      mode = 'paragraph';
      starts = fixtureParagraphStarts(blocks, targetChars);
    }
  }

  if (starts.length < 2) {
    throw new Error('INVALID_INPUT: not enough content blocks to split');
  }

  const existingFileNames = new Set(
    (request?.existingPaths ?? []).map((path: string) =>
      (path.split(/[\\/]/).pop() ?? '').toLowerCase()
    )
  );
  const used = new Set<string>();
  const sections = starts.map((start, index) => {
    const end = index + 1 < starts.length ? starts[index + 1] - 1 : blocks.length - 1;
    const first = blocks[start];
    const sectionTitle =
      first.kind === 'heading' ? headingText(first.text) || `Section ${index + 1}` : `Section ${index + 1}`;
    let fileName =
      sectionTitle
        .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 80) || 'Section';
    let candidate = fileName;
    let n = 2;
    while (used.has(candidate.toLowerCase()) || existingFileNames.has(`${candidate}.md`.toLowerCase())) {
      candidate = `${fileName}-${n++}`;
    }
    fileName = candidate;
    used.add(fileName.toLowerCase());

    const bodyBlocks = blocks.slice(start + (first.kind === 'heading' ? 1 : 0), end + 1);
    const sectionBody = bodyBlocks.map((block) => block.text).join('\n\n');
    return {
      title: sectionTitle,
      fileName,
      content: `# ${sectionTitle}\n\n> Part of [[${title}]] · Section ${index + 1} of ${starts.length}\n\n${sectionBody}\n`,
      startBlock: blocks[start].id,
      endBlock: blocks[end].id,
    };
  });

  const intro = blocks
    .slice(0, starts[0])
    .map((block) => block.text)
    .join('\n\n');
  const parentContent = `${intro ? `${intro}\n\n` : ''}## Sections\n\n${sections
    .map((section) => `- [[${section.title}]]`)
    .join('\n')}\n`;
  const plan = {
    mode,
    level,
    modelUsed,
    parentContent,
    sections,
    warnings,
    stats: {
      blocks: blocks.length,
      sections: sections.length,
      modelMs: modelUsed ? 123 : 0,
    },
  };
  (window as any).fixtureStructurePlan = plan;
  return plan;
}

Object.assign(window, { fixtureCalls: calls, fixtureSettings: settings, fixtureNoteContents: noteContents });
Object.defineProperty(window, '__TAURI_EVENT_PLUGIN_INTERNALS__', { value: { unregisterListener: () => {} } });
Object.defineProperty(window, '__TAURI_INTERNALS__', {
  value: {
    metadata: { currentWindow: { label: 'main' }, currentWebview: { label: 'main' } },
    convertFileSrc: (handle: string) => handle === 'fixture-image' ? '/tests/fixtures/research.png' : '/tests/fixtures/research.pdf',
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (command: string, args: any = {}) => {
      calls.push({ command, args });
      if (command.startsWith('plugin:')) return command.endsWith('is_maximized') ? false : null;
      switch (command) {
        case 'research_asset': return { handle: 'fixture-image', name: 'research.png', mime: 'image/png', size: 68, documentId: null };
        case 'research_open_pdf': return { handle: 'fixture-pdf', name: 'research.pdf', mime: 'application/pdf', size: (await (await fetch('/tests/fixtures/research.pdf')).arrayBuffer()).byteLength, documentId };
        case 'research_read': return (await (await fetch('/tests/fixtures/research.pdf')).arrayBuffer()).slice(args.offset, args.offset + args.length);
        case 'research_annotations': return structuredClone(annotationFile);
        case 'research_save_annotations': {
          if ((window as any).fixtureDelayAnnotationSave) await new Promise<void>(resolve => { (window as any).fixtureFinishAnnotationSave = resolve; });
          if ((window as any).fixtureAnnotationConflict) throw new Error('CONFLICT: Annotations changed');
          if (args.expectedRevision !== annotationFile.revision) throw new Error('CONFLICT');
          annotationFile = { ...annotationFile, revision: annotationFile.revision + 1, entries: structuredClone(args.entries) };
          localStorage.setItem('fixture-annotations', JSON.stringify(annotationFile));
          return structuredClone(annotationFile);
        }
        case 'write_file': if (query.has('research')) noteContents[args.filePath] = args.content; return null;
        case 'get_structure_model_status': {
          if (structureErrorTarget === 'status') {
            throw new Error(`${structureErrorCode || 'MODEL_INVALID'}: fixture status failure`);
          }
          return {
            state: structureModelState,
            model: 'LFM2.5-1.2B-Instruct-Q4_K_M',
            modelPath:
              structureModelState === 'missing'
                ? null
                : '/fixtures/models/LFM2.5-1.2B-Instruct-Q4_K_M.gguf',
            memoryLimitMb: 2048,
            contextTokens: 8192,
            threads: 2,
            message:
              structureModelState === 'ready'
                ? 'Local structure model is ready.'
                : structureModelState === 'missing'
                  ? 'Bundled structure model is missing at /fixtures/models/LFM2.5-1.2B-Instruct-Q4_K_M.gguf'
                  : structureModelState === 'invalid'
                    ? 'Bundled structure model failed its checksum; reinstall Prism.'
                    : 'llama.cpp runtime is missing at /fixtures/bin/llama-cli',
          };
        }
        case 'inspect_note_structure': return fixtureStructureInspect(args.request);
        case 'preview_note_format': return fixturePreviewFormat(args.request);
        case 'plan_note_split': return fixturePlanSplit(args.request);
        case 'get_runtime_config': return structuredClone(settings);
        case 'save_runtime_config':
          if (query.has('settings-save-error')) throw new Error('Disk unavailable');
          return { settings: structuredClone(args.config), runtimeWarning: query.has('runtime-warning') ? 'ONNX dependency unavailable (Windows error 126)' : null };
        case 'purge_expired_history': return null;
        case 'index_vault': return { files: structuredClone(vaultFiles), folders: [...vaultFolders] };
        case 'create_file': return `/vault/${args.relativePath}`;
        case 'read_note_chunk': {
          const note = vaultFiles.find(file => file.path === args.path);
          const text = noteContents[args.path] ?? `# ${note?.title ?? 'Note'}\n\nA fixture note for workspace layout and resizing.\n`;
          return { text, revision: 'fixture-1', nextOffset: null, bytes: new TextEncoder().encode(text).length };
        }
        case 'get_vault_dictionary':
        case 'get_denied_links':
        case 'get_backlinks_for_note':
        case 'get_incoming_backlinks':
        case 'scan_unlinked_mentions':
        case 'find_semantic_related_notes':
        case 'find_block_related_notes': return [];
        case 'rename_file': return null;
        case 'get_graph': return { nodes: [{ id: '/vault/A/Note.md', title: 'Note', exists: true }, { id: '/vault/Loose.md', title: 'Loose', exists: true }], links: [{ source: '/vault/A/Note.md', target: '/vault/Loose.md' }] };
        // Full vault paths exercise withTopics' suffix resolution against the
        // vault-relative ids produced by noteGraph.
        case 'get_topic_groups': return [
          ['research', [['/vault/A/Note.md', 'Note'], ['/vault/Loose.md', 'Loose']]],
          ['loose', [['/vault/Loose.md', 'Loose']]],
        ];
        // Agent surface: enabling Agent mounts AgentReview, which reads these.
        case 'agent_list_tools': return [{ name: 'read_note', description: 'Read a note', requiresApproval: false }];
        case 'agent_list_pending':
        case 'agent_list_operations': return [];
        case 'get_ingestion_engine_status': return { engine: 'rust', rustAvailable: true };
        case 'model_service_status': return { state: 'ready', command: '', message: 'Ready' };
        case 'study_chat': return true;
        case 'agent_list_tools': return [{ name: 'read_note', description: 'Read a note', requiresApproval: false }];
        case 'study_request': {
          const payload = args.payload ?? {};
          switch (args.action) {
            case 'collections': return structuredClone(collections);
            case 'artifacts': return structuredClone(artifacts.filter(a => !payload.collectionId || a.collectionId === payload.collectionId));
            case 'sources': return sources.filter(s => collections.find(c => c.id === payload.collectionId)?.sourceIds.includes(s.id));
            case 'notes': return { items: sources, nextOffset: null };
            case 'chat': return { session: null, collectionId: payload.collectionId ?? null, managed: true, messages: [] };
            case 'newChat': return { id: crypto.randomUUID(), title: 'New conversation', origin: 'copilot', collectionId: payload.collectionId ?? null, messageCount: 0 };
            case 'setChatProvider':
              if (typeof payload.providerId !== 'string') throw new Error('Missing providerId; select Default model or a saved provider.');
              return true;
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
