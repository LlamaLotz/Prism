import type { AppSettings } from './types';

export const DEFAULT_SETTINGS: AppSettings = {
  notebook: { embedByDefault: false, sourcePanelWidth: 260, notesPanelWidth: 260 },
  vaultPath: '',
  ingestionScript: 'python "/Users/Shiver/Documents/Prism/Extractor Final/master_extractor.py" --vault {vault_path}',
  omniRoute: {
    provider: '', // none — user picks a provider in Settings
    apiKey: '',
    baseUrl: 'https://api.omniroute.ai/v1',
    model: 'gpt-4o',
    temperature: 0.7,
    injectUserProfile: false,
    userProfile: '',
  },
  appearance: {
    themeStyle: 'industrial',
    themeMode: 'dark',
    startupView: 'graph',
    defaultGraphMode: '3d',
    backgroundPattern: 'grid',
    aiPanelOpenOnStart: false,
    sidebarCollapsedOnStart: false,
    linkHubVisibleByDefault: true,
    linkHubDefaultHeight: 220,
    labelQuality: 'high',
    autoRotateOnLoad: false,
    autoRotateSpeed: 0.67,
    accentColor: '#38BDF8',
    hoverGlowColor: '#38BDF8',
    graphNodeColor: '#38BDF8',
    appIcon: '',
    sidebarStatusText: '{time}',
    liquidGlassOpacity: 0.93,
    backgroundEnvironment: 'none',
  },
  editor: {
    autosaveDebounceMs: 800,
    fullRenderLineThreshold: 8000,
    findDebounceMs: 1000,
  },
  linking: {
    autoLinkOnSave: true,
    similarityThreshold: 0.7,
    embedDebounceMs: 4000,
    backfillOnVaultOpen: true,
    embeddingThreads: 1,
    embeddingBatchSize: 16,
    persistNodePositions: true,
  },
  system: {
    watchVault: true,
    syncH1OnStartup: true,
    versionRetentionDays: 0,
  },
};

