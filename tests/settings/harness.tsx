import React, { useState, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { SettingsPage } from '../../src/components/SettingsPage';
import { DEFAULT_SETTINGS } from '../../src/defaultSettings';
import { AppSettings, SettingsApplyError } from '../../src/types';
import { applyAccentColor } from '../../src/utils/accentColor';
import '../../src/index.css';

const query = new URLSearchParams(location.search);
document.documentElement.className = `theme-${query.get('theme') || 'industrial'} mode-${query.get('mode') || 'dark'}`;

const fixture = { calls: [] as AppSettings[], resolve: (_: AppSettings) => {}, reject: (_: Error) => {} };
Object.assign(window, { settingsFixture: fixture });
function Harness() {
  const [open, setOpen] = useState(true);
  const [settings, setSettings] = useState(DEFAULT_SETTINGS);
  useEffect(() => {
    const accent = query.get('accent');
    if (accent) applyAccentColor(accent);
  }, []);
  return <>
    <button onClick={() => setOpen(true)}>Open settings</button>
    <SettingsPage isOpen={open} settings={settings} onClose={() => setOpen(false)} onSave={async draft => {
      fixture.calls.push(draft);
      const result = await new Promise<AppSettings>((resolve, reject) => {
        fixture.resolve = resolve;
        fixture.reject = reject;
      });
      setSettings(result);
      return result;
    }} />
  </>;
}
Object.assign(window, { SettingsApplyError });
createRoot(document.getElementById('root')!).render(<Harness />);
