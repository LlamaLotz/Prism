import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings } from '../types';
import './runtime.css';

type ModelSettings = NonNullable<AppSettings['models']>;
const FEATURES = { CHAT: 'Chat', SUMMARIZE: 'Summarize', TAG: 'Tag', CLASSIFY: 'Classify' };

export function AIRoutingSettings({ draft, setDraft }: {
  draft: AppSettings;
  setDraft: Dispatch<SetStateAction<AppSettings>>;
}) {
  const update = (change: (current: ModelSettings) => Partial<ModelSettings>) => setDraft(previous => {
    const current: ModelSettings = { privacy: 'ask_before_cloud', idleSeconds: 300, routes: {}, ...previous.models };
    return { ...previous, models: { ...current, ...change(current) } };
  });
  const saveProvider = () => setDraft(previous => ({
    ...previous,
    models: {
      privacy: 'ask_before_cloud', idleSeconds: 300, routes: {}, ...previous.models,
      providers: [...(previous.models?.providers ?? []), {
        id: crypto.randomUUID(), name: `${previous.omniRoute.provider}: ${previous.omniRoute.model}`,
        config: { ...previous.omniRoute }, capabilities: ['generation'],
      }],
    },
  }));
  return <section className="runtime-settings">
    <h3>Privacy &amp; model runtime</h3>
    <label>External content processing
      <select value={draft.models?.privacy ?? 'ask_before_cloud'} onChange={e => update(() => ({ privacy: e.target.value as ModelSettings['privacy'] }))}>
        <option value="strict_local">Strict Local</option>
        <option value="ask_before_cloud">Ask Before Cloud</option>
        <option value="hybrid">Hybrid — explicit task routes only</option>
        <option value="cloud_allowed">Cloud Allowed</option>
      </select>
    </label>
    <label>Unload idle embedding model after (seconds)
      <input type="number" min={30} value={draft.models?.idleSeconds ?? 300} onChange={e => update(() => ({ idleSeconds: Math.max(30, Number(e.target.value) || 300) }))} />
    </label>
    <button type="button" className="runtime-button" disabled={!draft.omniRoute.model || !draft.omniRoute.baseUrl} onClick={saveProvider}>Save current provider for feature routing</button>
    <div className="runtime-routes">
      <h3>Provider by feature</h3>
      <p>Each feature uses its selected saved provider, or inherits the current Co-Pilot provider.</p>
      {Object.entries(FEATURES).map(([task, label]) => <label key={task}>{label}
        <select aria-label={label} value={draft.models?.routes[task] ?? ''} onChange={e => {
          const providerId = e.target.value;
          update(current => {
            const routes = { ...current.routes };
            if (providerId) routes[task] = providerId; else delete routes[task];
            return { routes };
          });
        }}>
          <option value="">Inherit: {draft.omniRoute.provider || 'No provider'} · {draft.omniRoute.model || 'No model selected'}</option>
          {draft.models?.providers?.map(provider => <option key={provider.id} value={provider.id}>{provider.name} · {provider.config.model}</option>)}
        </select>
      </label>)}
    </div>
    <div className="runtime-local">
      <p><strong>Embeddings:</strong> built-in local</p>
      <p><strong>Formatting:</strong> deterministic local</p>
      <p><strong>Notebook generation and speech:</strong> configured in Notebook settings</p>
    </div>
    <p className="mt-3">Privacy applies to Prism AI and the managed Notebook gateway. A localhost provider may forward to cloud; selecting it does not verify local execution or bypass approval.</p>
  </section>;
}
