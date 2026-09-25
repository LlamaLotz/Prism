import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import {
  knowledge,
  type ChatLibraryMessage,
  type ChatLibrarySession,
  type ChatOrigin,
} from './knowledge';

/**
 * Unified chat library: Co-Pilot + Notebook conversation history in one
 * vault-scoped list, backed by the Rust chat_sessions/chat_messages tables.
 * Co-Pilot turns persist here directly; Notebook sessions appear as linked
 * entries (origin 'notebook') and cross-open imports their transcript.
 *
 * Shape follows src/services/ingestionStore.ts (Context + hook, explicit
 * refresh after mutations — the list query is cheap and keeps updated_at
 * ordering correct).
 */
interface ChatLibrary {
  sessions: ChatLibrarySession[];
  search: string;
  setSearch: (s: string) => void;
  originFilter: ChatOrigin | null;
  setOriginFilter: (o: ChatOrigin | null) => void;
  loading: boolean;
  refresh: () => Promise<void>;
  create: (title: string, origin: ChatOrigin) => Promise<ChatLibrarySession>;
  rename: (id: string, title: string) => Promise<void>;
  remove: (id: string) => Promise<void>;
  loadMessages: (sessionId: string) => Promise<ChatLibraryMessage[]>;
  /** Mirror-sync a transcript (Notebook backend -> store). Replaces. */
  syncTranscript: (
    sessionId: string,
    messages: Array<{ role: 'user' | 'assistant'; content: string; metadata?: string | null }>,
  ) => Promise<number>;
  append: (
    sessionId: string,
    role: 'user' | 'assistant',
    content: string,
    metadata?: string | null,
  ) => Promise<ChatLibraryMessage>;
  linkNotebook: (
    notebookSessionId: string,
    title: string,
    notebookId?: string | null,
    sourceId?: string | null,
    model?: string | null,
  ) => Promise<ChatLibrarySession>;
  unlinkNotebook: (notebookSessionId: string) => Promise<void>;
}

const ChatLibraryContext = createContext<ChatLibrary | null>(null);

export const ChatLibraryProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const [sessions, setSessions] = useState<ChatLibrarySession[]>([]);
  const [search, setSearch] = useState('');
  const [originFilter, setOriginFilter] = useState<ChatOrigin | null>(null);
  const [loading, setLoading] = useState(false);
  // Search input debounces into the query actually sent to Rust.
  const [query, setQuery] = useState('');
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(search.trim()), 250);
    return () => window.clearTimeout(t);
  }, [search]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const rows = await knowledge.listChats(query || null, originFilter, 100);
      setSessions(rows);
    } catch (e) {
      console.error('Chat library refresh failed:', e);
    } finally {
      setLoading(false);
    }
  }, [query, originFilter]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const create = useCallback(
    async (title: string, origin: ChatOrigin) => {
      const row = await knowledge.createChat(title, origin);
      await refresh();
      return row;
    },
    [refresh],
  );

  const rename = useCallback(
    async (id: string, title: string) => {
      await knowledge.renameChat(id, title);
      await refresh();
    },
    [refresh],
  );

  const remove = useCallback(
    async (id: string) => {
      await knowledge.deleteChat(id);
      await refresh();
    },
    [refresh],
  );

  const loadMessages = useCallback((sessionId: string) => {
    return knowledge.chatMessages(sessionId, 500, 0);
  }, []);

  const syncTranscript = useCallback(
    async (
      sessionId: string,
      messages: Array<{ role: 'user' | 'assistant'; content: string; metadata?: string | null }>,
    ) => {
      const count = await knowledge.replaceTranscript(sessionId, messages.slice(-200));
      await refresh();
      return count;
    },
    [refresh],
  );

  const append = useCallback(
    async (
      sessionId: string,
      role: 'user' | 'assistant',
      content: string,
      metadata?: string | null,
    ) => {
      const row = await knowledge.appendChat(sessionId, role, content, metadata);
      await refresh();
      return row;
    },
    [refresh],
  );

  const linkNotebook = useCallback(
    async (
      notebookSessionId: string,
      title: string,
      notebookId?: string | null,
      sourceId?: string | null,
      model?: string | null,
    ) => {
      const row = await knowledge.linkNotebookChat(
        notebookSessionId,
        title,
        notebookId,
        sourceId,
        model,
      );
      await refresh();
      return row;
    },
    [refresh],
  );

  const unlinkNotebook = useCallback(
    async (notebookSessionId: string) => {
      await knowledge.unlinkNotebookChat(notebookSessionId);
      await refresh();
    },
    [refresh],
  );

  const value = useMemo<ChatLibrary>(
    () => ({
      sessions,
      search,
      setSearch,
      originFilter,
      setOriginFilter,
      loading,
      refresh,
      create,
      rename,
      remove,
      loadMessages,
      syncTranscript,
      append,
      linkNotebook,
      unlinkNotebook,
    }),
    [
      sessions,
      search,
      originFilter,
      loading,
      refresh,
      create,
      rename,
      remove,
      loadMessages,
      syncTranscript,
      append,
      linkNotebook,
      unlinkNotebook,
    ],
  );

  return (
    <ChatLibraryContext.Provider value={value}>
      {children}
    </ChatLibraryContext.Provider>
  );
};

export function useChatLibrary(): ChatLibrary {
  const ctx = useContext(ChatLibraryContext);
  if (!ctx) throw new Error('useChatLibrary must be used inside ChatLibraryProvider');
  return ctx;
}
