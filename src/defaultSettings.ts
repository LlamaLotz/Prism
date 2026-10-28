import type { AppSettings } from './types';

/** Minimum shell opacity that still keeps body text readable over bright wallpapers. */
export const MIN_LIQUID_GLASS_OPACITY = 0.5;
/** The text-bearing Gloss surfaces never go below this alpha (keeps muted text >= 4.5:1). */
export const MIN_LIQUID_GLASS_PANEL_OPACITY = 0.7;

export const DEFAULT_SETTINGS: AppSettings = {
  vaultPath: '',
  ingestionScript: 'python "/Users/Shiver/Documents/Prism/Extractor Final/master_extractor.py" --vault {vault_path}',
  ingestionEngine: 'python',
  omniRoute: {
    provider: '', // none — user picks a provider in Settings
    apiKey: '',
    // Nothing is preconfigured: the assistant stays unconfigured ("None")
    // until the user picks a provider, which supplies its own endpoint.
    baseUrl: '',
    model: '',
    temperature: 0.7,
    injectUserProfile: false,
    userProfile: '',
  },
  appearance: {
    themeStyle: 'industrial',
    themeMode: 'dark',
    startupView: 'editor',
    defaultGraphMode: '2d',
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
  models: {
    privacy: 'ask_before_cloud',
    idleSeconds: 300,
    routes: {},
    requestTimeoutMode: 'until_failure',
    requestTimeoutSeconds: 180,
  },
  editor: {
    defaultMode: 'live',
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

