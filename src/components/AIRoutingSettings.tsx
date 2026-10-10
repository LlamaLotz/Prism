import { API_PROVIDERS } from '../services/apiProviders';
import type { Dispatch, SetStateAction } from 'react';
import type { AppSettings } from '../types';
import './runtime.css';

type ModelSettings = NonNullable<AppSettings['models']>;
const FEATURES = { CHAT: 'Chat', SUMMARIZE: 'Summarize', TAG: 'Tag', CLASSIFY: 'Classify', LINK_SUGGEST: 'Link suggestions', FORMAT: 'AI formatting', AI_SCAN: 'AI scan' };

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
    <h3>Saved providers and models</h3>
    <p>Save several connections, then choose a model separately in each conversation.</p>
    <button type="button" className="runtime-button" onClick={saveProvider}>Add current provider and model</button>
    {(draft.models?.providers??[]).map(profile=><fieldset key={profile.id} className="runtime-local"><legend>{profile.name}</legend>
      <label>Profile name<input value={profile.name} onChange={e=>update(current=>({providers:current.providers?.map(p=>p.id===profile.id?{...p,name:e.target.value}:p)}))}/></label>
      <label>Provider<select value={profile.config.provider} onChange={e=>{const selected=API_PROVIDERS.find(p=>p.id===e.target.value);update(current=>({providers:current.providers?.map(p=>p.id===profile.id?{...p,config:{...p.config,provider:e.target.value,baseUrl:selected?.baseUrl??'',apiKey:'',credentialRef:undefined}}:p)}));}}>{API_PROVIDERS.map(p=><option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
      {(['model','baseUrl','apiKey'] as const).map(field=><label key={field}>{field==='model'?'Model':field==='baseUrl'?'API address':'API key'}<input type={field==='apiKey'?'password':'text'} autoComplete="off" value={profile.config[field]} placeholder={field==='apiKey'&&profile.config.credentialRef?'Saved securely — enter to replace':undefined} onChange={e=>update(current=>({providers:current.providers?.map(p=>p.id===profile.id?{...p,config:{...p.config,[field]:e.target.value}}:p)}))}/></label>)}
      <button type="button" className="runtime-button" onClick={()=>update(current=>({routes:{...current.routes,CHAT:profile.id}}))} disabled={draft.models?.routes.CHAT===profile.id}>{draft.models?.routes.CHAT===profile.id?'Default for new chats':'Use for new chats'}</button>
      <button type="button" className="runtime-button" onClick={()=>update(current=>({providers:current.providers?.filter(p=>p.id!==profile.id),routes:Object.fromEntries(Object.entries(current.routes).filter(([,id])=>id!==profile.id))}))}>Remove profile</button>
    </fieldset>)}
    <details>
      <summary className="cursor-pointer">Advanced AI settings{Object.values(draft.models?.routes ?? {}).some(Boolean) && <span className="ml-2 text-xs">Custom routing active</span>}</summary>
      <label>Unload idle embedding model after (seconds)
        <input type="number" min={30} value={draft.models?.idleSeconds ?? 300} onChange={e => update(() => ({ idleSeconds: Math.max(30, Number(e.target.value) || 300) }))} />
      </label>

      <div className="runtime-routes">
        <h3>Provider by feature</h3>
        <p>Each feature uses its selected saved provider, or inherits the current AI assistant provider.</p>
        {Object.entries(FEATURES).map(([task, label]) => <label key={task}>{label}
          <select aria-label={label} value={draft.models?.routes?.[task] ?? ''} onChange={e => {
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
    </details>
    <div className="runtime-local">
      <p><strong>Embeddings:</strong> built-in local</p>
      <p><strong>Standard formatting:</strong> deterministic local; optional AI formatting uses its selected provider</p>
      <p><strong>Notebook generation:</strong> uses the configured generation provider</p>
    </div>
    <p className="mt-3">Privacy applies to Prism AI. A localhost provider may forward to cloud; selecting it does not verify local execution or bypass approval.</p>
  </section>;
}
