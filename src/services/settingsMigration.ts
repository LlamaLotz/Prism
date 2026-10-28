import type { AppSettings, OmniRouteConfig } from '../types';

export const LEGACY_GEMINI_MODEL = 'gemma-4-31b-it';
export const DEFAULT_GEMINI_MODEL = 'gemini-3.8-flash';
const GOOGLE_API = 'https://generativelanguage.googleapis.com';

function isGoogleHosted(config: OmniRouteConfig): boolean {
  const baseUrl = typeof config.baseUrl === 'string' ? config.baseUrl : '';
  return config.provider === 'google'
    && baseUrl.trim().toLowerCase().startsWith(GOOGLE_API);
}

/**
 * Rewrites the retired Google default model in settings files written before
 * Google stopped serving it. Only the hosted Gemini endpoint is touched, so a
 * local or proxy endpoint that legitimately serves Gemma is left alone.
 */
export function migrateLegacyGoogleModel(settings: AppSettings): {
  settings: AppSettings;
  changed: boolean;
} {
  let changed = false;
  const migrateConfig = (config: OmniRouteConfig): OmniRouteConfig => {
    if (!isGoogleHosted(config) || config.model !== LEGACY_GEMINI_MODEL) return config;
    changed = true;
    return { ...config, model: DEFAULT_GEMINI_MODEL };
  };

  const omniRoute = migrateConfig(settings.omniRoute);
  const originalProviders = settings.models?.providers;
  let providers = originalProviders;
  if (originalProviders) {
    const migratedProviders = originalProviders.map(profile => {
      const config = migrateConfig(profile.config);
      const name = isGoogleHosted(profile.config) && profile.name.includes(LEGACY_GEMINI_MODEL)
        ? profile.name.replaceAll(LEGACY_GEMINI_MODEL, DEFAULT_GEMINI_MODEL)
        : profile.name;
      if (config === profile.config && name === profile.name) return profile;
      if (name !== profile.name) changed = true;
      return { ...profile, name, config };
    });
    if (migratedProviders.some((profile, index) => profile !== originalProviders[index])) {
      providers = migratedProviders;
    }
  }

  if (omniRoute === settings.omniRoute && providers === originalProviders) {
    return { settings, changed: false };
  }
  return {
    settings: {
      ...settings,
      omniRoute,
      ...(settings.models
        ? { models: { ...settings.models, ...(providers ? { providers } : {}) } }
        : {}),
    },
    changed,
  };
}
