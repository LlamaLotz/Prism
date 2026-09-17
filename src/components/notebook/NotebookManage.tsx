import React, { useEffect, useRef, useState } from 'react';
import { NotebookClient, recordId } from '../../services/notebook';
import type { OmniRouteConfig } from '../../types';
import type { CredentialResponse, ProviderInfoResponse, ModelResponse, DefaultModelsResponse, TransformationResponse, TransformationExecuteResponse, EpisodeProfileResponse, SpeakerProfileResponse, PodcastEpisodeResponse, DiscoverModelsResponse, SettingsResponse, CapabilitiesResponse } from '../../types/notebook-api';
import { useDialog } from '../DialogProvider';
import { Button, Field, NotebookMarkdown } from './NotebookPage';

type Row = Record<string, unknown>;
type Option = { value: string; label: string };
type Input = { key: string; label: string; type?: 'text' | 'area' | 'number' | 'boolean' | 'password'; options?: Option[]; required?: boolean };
const options = (items: { id: string; name: string }[]) => items.map(i => ({ value: i.id, label: i.name }));
const modelTypes = ['language', 'embedding', 'speech_to_text', 'text_to_speech'];

function EntityForm({ title, fields, initial, onSave, onCancel, children }: { title: string; fields: Input[]; initial: Row; onSave: (value: Row) => Promise<void>; onCancel: () => void; children?: React.ReactNode }) {
  const [value, setValue] = useState(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  return <form className="nb-card nb-stack" onSubmit={async e => { e.preventDefault(); setSaving(true); setError(''); try { await onSave(value); onCancel(); } catch (e) { setError(String(e)); } finally { setSaving(false); } }}>
    <h3 className="font-semibold">{title}</h3>{error && <p role="alert" className="nb-error">{error}</p>}
    <div className="nb-form">{fields.map(f => <Field key={f.key} label={f.label}>{f.options
      ? <select className="nb-input" required={f.required} value={String(value[f.key] ?? '')} onChange={e => setValue(v => ({ ...v, [f.key]: e.target.value || null }))}><option value="">Select…</option>{f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
      : f.type === 'boolean' ? <input type="checkbox" checked={Boolean(value[f.key])} onChange={e => setValue(v => ({ ...v, [f.key]: e.target.checked }))}/>
      : f.type === 'area' ? <textarea className="nb-input" rows={5} required={f.required} value={String(value[f.key] ?? '')} onChange={e => setValue(v => ({ ...v, [f.key]: e.target.value }))}/>
      : <input className="nb-input" autoComplete={f.type === 'password' ? 'new-password' : 'off'} type={f.type || 'text'} required={f.required} value={String(value[f.key] ?? '')} onChange={e => setValue(v => ({ ...v, [f.key]: f.type === 'number' ? (e.target.value ? Number(e.target.value) : null) : e.target.value }))}/>}</Field>)}</div>{children}
    <div className="nb-tabs"><Button type="submit" className="primary" disabled={saving}>Save</Button><Button disabled={saving} onClick={onCancel}>Cancel</Button></div>
  </form>;
}

export function NotebookManage({ section, client, notebookId, config, onExport, onReference, onRestart }: {
  section: 'transformations' | 'podcasts' | 'settings'; client: NotebookClient; notebookId: string | null; config: OmniRouteConfig;
  onExport: (title: string, text: string) => Promise<void>; onReference: (id: string) => void; onRestart: () => Promise<void>;
}) {
  const dialogs = useDialog();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState(section === 'settings' ? 'providers' : section === 'podcasts' ? 'episodes' : 'transformations');
  const [credentials, setCredentials] = useState<CredentialResponse[]>([]);
  const [providers, setProviders] = useState<ProviderInfoResponse[]>([]);
  const [models, setModels] = useState<ModelResponse[]>([]);
  const [defaults, setDefaults] = useState<DefaultModelsResponse>({});
  const [transforms, setTransforms] = useState<TransformationResponse[]>([]);
  const [episodes, setEpisodes] = useState<PodcastEpisodeResponse[]>([]);
  const [speakers, setSpeakers] = useState<SpeakerProfileResponse[]>([]);
  const [profiles, setProfiles] = useState<EpisodeProfileResponse[]>([]);
  const [processing, setProcessing] = useState<SettingsResponse>({});
  const [capabilities, setCapabilities] = useState<CapabilitiesResponse | null>(null);
  const [jobs, setJobs] = useState<Row[]>([]);
  const [editing, setEditing] = useState<{ kind: string; row: Row } | null>(null);
  const [speakerDraft, setSpeakerDraft] = useState<Row[]>([]);
  const [discovered, setDiscovered] = useState<DiscoverModelsResponse | null>(null);
  const [selectedModels, setSelectedModels] = useState<Record<string, string>>({});
  const [input, setInput] = useState('');
  const [output, setOutput] = useState('');
  const [transform, setTransform] = useState('');
  const [episodeProfile, setEpisodeProfile] = useState('');
  const [speakerProfile, setSpeakerProfile] = useState('');
  const [episodeName, setEpisodeName] = useState('');
  const [briefing, setBriefing] = useState('');
  const [audio, setAudio] = useState<{ id: string; url: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => () => { if (audio) URL.revokeObjectURL(audio.url); }, [audio]);
  const run = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); } catch (e) { if (alive.current) setError(String(e)); } finally { if (alive.current) setBusy(false); } };
  const refresh = async () => {
    const requests = [
      client.request<CredentialResponse[]>('/credentials').then(setCredentials), client.request<ProviderInfoResponse[]>('/providers').then(setProviders),
      client.request<ModelResponse[]>('/models').then(setModels), client.request<DefaultModelsResponse>('/models/defaults').then(setDefaults),
      client.request<TransformationResponse[]>('/transformations').then(setTransforms), client.request<PodcastEpisodeResponse[]>('/podcasts/episodes').then(setEpisodes),
      client.request<SpeakerProfileResponse[]>('/speaker-profiles').then(setSpeakers), client.request<EpisodeProfileResponse[]>('/episode-profiles').then(setProfiles),
      client.request<SettingsResponse>('/settings').then(setProcessing), client.request<CapabilitiesResponse>('/capabilities').then(setCapabilities),
      client.request<Row[]>('/commands/jobs?limit=100').then(setJobs),
    ];
    const results = await Promise.allSettled(requests);
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failures.length) throw new Error(failures.map(r => String(r.reason)).join('\n'));
  };
  useEffect(() => { void run(refresh); }, [client]);
  useEffect(() => {
    if (!['episodes', 'jobs'].includes(tab)) return;
    const timer = setInterval(() => {
      if (busy) return;
      const request = tab === 'episodes' ? client.request<PodcastEpisodeResponse[]>('/podcasts/episodes').then(setEpisodes) : client.request<Row[]>('/commands/jobs?limit=100').then(setJobs);
      request.catch(e => { if (alive.current) setError(String(e)); });
    }, 5000);
    return () => clearInterval(timer);
  }, [tab, busy]);
  const deleteRow = (path: string, name: string) => void run(async () => { if (!(await dialogs.confirm(`Delete ${name}? This cannot be undone.`, { danger: true, confirmLabel: 'Delete' }))) return; await client.request(path, 'DELETE'); await refresh(); });
  const saveEntity = async (row: Row) => {
    if (!editing) return;
    const endpoint = { credential: '/credentials', model: '/models', transformation: '/transformations', speaker: '/speaker-profiles', profile: '/episode-profiles' }[editing.kind];
    if (!endpoint) throw new Error('Unsupported editor');
    const payload = { ...row };
    const id = payload.id as string | undefined;
    // Send only editable fields; never echo response-only credential metadata.
    const fields = formFields(editing.kind).map(f => f.key);
    const body: Row = Object.fromEntries(fields.filter(k => payload[k] !== undefined).map(k => [k, payload[k]]));
    if (editing.kind === 'credential') {
      if (id && !body.api_key) delete body.api_key;
      body.modalities = providers.find(p => p.name === body.provider)?.modalities ?? editing.row.modalities ?? ['language'];
      if (id) delete body.provider;
      for (const key of Object.keys(body)) if (body[key] === '') body[key] = null;
    }
    if (editing.kind === 'speaker') {
      if (!speakerDraft.length || speakerDraft.length > 4) throw new Error('Add between one and four speakers.');
      body.speakers = speakerDraft;
    }
    await client.request(`${endpoint}${id ? `/${recordId(id)}` : ''}`, id ? 'PUT' : 'POST', body);
    await refresh();
  };
  const modelOptions = (type: string) => options(models.filter(m => m.type === type));
  function formFields(kind: string): Input[] {
    const name: Input = { key: 'name', label: 'Name', required: true };
    const description: Input = { key: 'description', label: 'Description', type: 'area' };
    if (kind === 'credential') return [name, { key: 'provider', label: 'Provider', required: true, options: providers.map(p => ({ value: p.name, label: p.display_name })) }, { key: 'api_key', label: 'API key (leave blank to keep the saved key)', type: 'password' }, { key: 'base_url', label: 'Custom base URL (optional)' }, { key: 'endpoint', label: 'Azure endpoint (optional)' }, { key: 'api_version', label: 'Azure API version (optional)' }, { key: 'endpoint_llm', label: 'Chat endpoint override (optional)' }, { key: 'endpoint_embedding', label: 'Embedding endpoint override (optional)' }, { key: 'endpoint_stt', label: 'Speech-to-text endpoint override (optional)' }, { key: 'endpoint_tts', label: 'Text-to-speech endpoint override (optional)' }, { key: 'project', label: 'Vertex project (optional)' }, { key: 'location', label: 'Vertex location (optional)' }, { key: 'credentials_path', label: 'Vertex credentials file path (optional)' }, { key: 'num_ctx', label: 'Ollama context window (optional)', type: 'number' }];
    if (kind === 'model') return [name, { key: 'provider', label: 'Provider', required: true, options: providers.map(p => ({ value: p.name, label: p.display_name })) }, { key: 'type', label: 'Model role', required: true, options: modelTypes.map(t => ({ value: t, label: t.replaceAll('_', ' ') })) }, { key: 'credential', label: 'Credential', required: true, options: options(credentials) }];
    if (kind === 'transformation') return [name, { key: 'title', label: 'Display title', required: true }, description, { key: 'prompt', label: 'Instructions', type: 'area', required: true }, { key: 'apply_default', label: 'Run automatically on new sources', type: 'boolean' }, { key: 'model_id', label: 'Model override', options: modelOptions('language') }];
    if (kind === 'speaker') return [name, description, { key: 'voice_model', label: 'Speech model', required: true, options: modelOptions('text_to_speech') }];
    return [name, description, { key: 'speaker_config', label: 'Speaker profile', required: true, options: options(speakers) }, { key: 'outline_llm', label: 'Outline model', options: modelOptions('language') }, { key: 'transcript_llm', label: 'Transcript model', options: modelOptions('language') }, { key: 'language', label: 'Language code (for example en)' }, { key: 'default_briefing', label: 'Episode instructions', required: true, type: 'area' }, { key: 'num_segments', label: 'Segments', type: 'number' }, { key: 'max_tokens', label: 'Maximum output tokens', type: 'number' }];
  }
  const edit = (kind: string, row: Row = {}) => { setEditing({ kind, row }); if (kind === 'speaker') setSpeakerDraft((row.speakers as Row[] | undefined) ?? [{ name: 'Host', voice_id: 'alloy', backstory: '', personality: '' }]); };
  const tabs = section === 'settings' ? ['providers', 'models', 'defaults', 'processing', 'jobs'] : section === 'podcasts' ? ['episodes', 'speakers', 'profiles'] : ['transformations'];
  return <div className="nb-scroll nb-stack flex-1">
    <div className="nb-toolbar"><div className="nb-tabs flex-1">{tabs.map(t => <Button key={t} aria-pressed={tab === t} onClick={() => { setEditing(null); setTab(t); }}>{t[0].toUpperCase() + t.slice(1)}</Button>)}</div><Button disabled={busy} onClick={() => void run(refresh)}>Refresh</Button></div>
    {error && <div className="nb-error" role="alert">{error}<Button onClick={() => setError('')}>Dismiss</Button></div>}
    {notice && <div className="nb-muted" role="status">{notice}</div>}
    {editing && <EntityForm key={`${editing.kind}:${editing.row.id ?? 'new'}`} title={`${editing.row.id ? 'Edit' : 'Add'} ${editing.kind}`} fields={formFields(editing.kind)} initial={editing.row} onSave={saveEntity} onCancel={() => setEditing(null)}>
      {editing.kind === 'speaker' && <div className="nb-stack">{speakerDraft.map((speaker, i) => <div key={i} className="nb-card nb-form">{['name', 'voice_id', 'backstory', 'personality'].map(key => <Field key={key} label={key.replaceAll('_', ' ')}><input className="nb-input" required={key === 'name' || key === 'voice_id'} value={String(speaker[key] ?? '')} onChange={e => setSpeakerDraft(rows => rows.map((r, j) => i === j ? { ...r, [key]: e.target.value } : r))}/></Field>)}<Button onClick={() => setSpeakerDraft(rows => rows.filter((_, j) => i !== j))}>Remove speaker</Button></div>)}<Button disabled={speakerDraft.length >= 4} onClick={() => setSpeakerDraft(rows => [...rows, { name: '', voice_id: '', backstory: '', personality: '' }])}>Add speaker</Button></div>}
    </EntityForm>}
    {tab === 'providers' && <>
      <div className="nb-toolbar"><p className="nb-muted flex-1">Credentials are encrypted in this vault. Models can use different providers for chat, embeddings, and audio.</p><Button disabled={busy} onClick={() => edit('credential')}>Add provider</Button>
        {config.provider && credentials.length === 0 && <Button disabled={busy} onClick={() => void run(async () => {
          const supported = providers.some(p => p.name === config.provider);
          const provider = supported ? config.provider : 'openai_compatible';
          if (!supported && !(await dialogs.confirm('Import this custom endpoint as an OpenAI-compatible provider? It must support that protocol.', { title: 'Import Co-Pilot settings', confirmLabel: 'Import' }))) return;
          const credential = await client.request<CredentialResponse>('/credentials', 'POST', { name: 'Prism Co-Pilot', provider, api_key: config.apiKey || null, base_url: config.baseUrl || null, modalities: ['language'] });
          const model = await client.request<ModelResponse>('/models', 'POST', { name: config.model, provider, type: 'language', credential: credential.id });
          await client.request('/models/defaults', 'PUT', { ...defaults, default_chat_model: model.id, default_transformation_model: model.id });
          setNotice('Co-Pilot provider imported. Configure embedding and speech models for search and podcasts.'); await refresh();
        })}>Import Co-Pilot settings</Button>}
      </div>
      {credentials.map(c => <article key={c.id} className="nb-card nb-stack"><h3 className="font-semibold">{c.name} <span className="nb-muted">{c.provider}</span></h3><p className="nb-muted">{c.model_count} models · {c.has_api_key ? 'Key saved' : 'No API key'}</p>{c.decryption_error && <p className="nb-error">{c.decryption_error}</p>}<div className="nb-tabs"><Button onClick={() => edit('credential', { ...c })}>Edit</Button><Button disabled={busy} onClick={() => void run(async () => { const r = await client.request<{ success: boolean; message: string }>(`/credentials/${recordId(c.id)}/test`, 'POST'); if (!r.success) throw new Error(r.message); setNotice(r.message); })}>Test connection</Button><Button disabled={busy} onClick={() => void run(async () => { setSelectedModels({}); setDiscovered(await client.request<DiscoverModelsResponse>(`/credentials/${recordId(c.id)}/discover`, 'POST')); })}>Discover models</Button><Button disabled={busy} onClick={() => deleteRow(`/credentials/${recordId(c.id)}`, `${c.name} and its registered models`)}>Delete</Button></div></article>)}
      {discovered && <div className="nb-card nb-stack"><h3>Choose models to register</h3>{discovered.discovered.map(m => <div key={m.name} className="nb-toolbar"><span className="flex-1 text-sm">{m.name}</span><select className="nb-input w-auto" aria-label={`Role for ${m.name}`} value={selectedModels[m.name] ?? ''} onChange={e => setSelectedModels(s => ({ ...s, [m.name]: e.target.value }))}><option value="">Skip</option>{modelTypes.map(t => <option key={t} value={t}>{t.replaceAll('_', ' ')}</option>)}</select></div>)}<Button disabled={busy || !Object.values(selectedModels).some(Boolean)} onClick={() => void run(async () => { await client.request(`/credentials/${recordId(discovered.credential_id)}/register-models`, 'POST', { models: Object.entries(selectedModels).filter(([, type]) => type).map(([name, model_type]) => ({ name, provider: discovered.provider, model_type })) }); setDiscovered(null); await refresh(); })}>Register selected models</Button></div>}
    </>}
    {tab === 'models' && <><Button onClick={() => edit('model')}>Register a model manually</Button>{models.map(m => <div key={m.id} className="nb-card nb-toolbar"><span className="flex-1">{m.name} <span className="nb-muted">{m.provider} · {m.type.replaceAll('_', ' ')}</span></span><Button onClick={() => deleteRow(`/models/${recordId(m.id)}`, m.name)}>Delete</Button></div>)}</>}
    {tab === 'defaults' && <div className="nb-card nb-stack"><h3>Default models</h3>{[['default_chat_model', 'Chat', 'language'], ['default_transformation_model', 'Transformations', 'language'], ['large_context_model', 'Large context', 'language'], ['default_embedding_model', 'Embeddings', 'embedding'], ['default_text_to_speech_model', 'Text to speech', 'text_to_speech'], ['default_speech_to_text_model', 'Speech to text', 'speech_to_text'], ['default_tools_model', 'Tools', 'language']].map(([key, label, type]) => <Field key={key} label={label}><select className="nb-input" value={defaults[key as keyof DefaultModelsResponse] ?? ''} onChange={e => setDefaults(d => ({ ...d, [key]: e.target.value || null }))}><option value="">Not configured</option>{modelOptions(type).map(o => <option value={o.value} key={o.value}>{o.label}</option>)}</select></Field>)}<Button disabled={busy} onClick={() => void run(async () => { await client.request('/models/defaults', 'PUT', defaults); setNotice('Default models saved. Rebuild embeddings if you changed the embedding model.'); })}>Save defaults</Button></div>}
    {tab === 'processing' && <div className="nb-card nb-stack"><h3>Content processing</h3><p className="nb-muted">Optional extraction engines are shown only when available in this installation.</p><Field label="Document engine"><select className="nb-input" value={processing.default_content_processing_engine_doc ?? 'auto'} onChange={e => setProcessing(p => ({ ...p, default_content_processing_engine_doc: e.target.value }))}><option value="auto">Automatic</option><option value="simple">Standard</option>{capabilities?.docling_available && <option value="docling">Docling</option>}</select></Field><Field label="Automatically embed new content"><select className="nb-input" value={processing.default_embedding_option ?? 'ask'} onChange={e => setProcessing(p => ({ ...p, default_embedding_option: e.target.value }))}><option value="ask">Ask</option><option value="always">Always</option><option value="never">Never</option></select></Field><Button disabled={busy} onClick={() => void run(async () => { await client.request('/settings', 'PUT', processing); setNotice('Processing preferences saved.'); })}>Save preferences</Button><hr className="border-slate-800"/><h3>Embeddings</h3><p className="nb-muted">Rebuild after changing embedding models. Progress appears under Jobs.</p><div className="nb-tabs">{['existing', 'all'].map(mode => <Button key={mode} disabled={busy} onClick={() => void run(async () => { if (!(await dialogs.confirm(`Rebuild embeddings for ${mode === 'all' ? 'all content' : 'previously embedded content'}? This uses your embedding provider.`, { confirmLabel: 'Rebuild' }))) return; const r = await client.request<{ message: string }>('/embeddings/rebuild', 'POST', { mode, include_sources: true, include_notes: true, include_insights: true }); setNotice(r.message); })}>Rebuild {mode}</Button>)}</div></div>}
    {tab === 'jobs' && <><div className="nb-toolbar"><p className="nb-muted flex-1">Queued, running, completed, and failed background work. Retry failed sources or podcasts from their own panels.</p><Button disabled={busy} onClick={() => void onRestart()}>Restart Notebook</Button></div>{jobs.map((j, i) => <div className="nb-card nb-stack" key={String(j.id ?? i)}><h3>{String(j.command ?? j.command_name ?? 'Background job')}</h3><p className="nb-muted">{String(j.status ?? '')}</p>{j.error ? <p className="nb-error">{String(j.error)}</p> : null}{['running', 'queued', 'pending'].includes(String(j.status)) && <Button onClick={() => void run(async () => { await client.request(`/commands/jobs/${recordId(String(j.id))}`, 'DELETE'); await refresh(); })}>Cancel job</Button>}</div>)}</>}
    {tab === 'transformations' && <>
      <div className="nb-toolbar"><p className="nb-muted flex-1">Reusable instructions for summaries, questions, outlines, and more.</p><Button onClick={() => edit('transformation', { name: '', title: '', description: '', prompt: '', apply_default: false })}>New transformation</Button></div>
      <div className="nb-card nb-stack"><Field label="Transformation"><select className="nb-input" value={transform} onChange={e => setTransform(e.target.value)}><option value="">Select…</option>{transforms.map(t => <option key={t.id} value={t.id}>{t.title}</option>)}</select></Field><Field label="Text to transform"><textarea className="nb-input" rows={6} value={input} onChange={e => setInput(e.target.value)}/></Field><Button disabled={busy || !transform || !input.trim()} onClick={() => void run(async () => { const r = await client.request<TransformationExecuteResponse>('/transformations/execute', 'POST', { transformation_id: transform, input_text: input }); setOutput(r.output); })}>Run transformation</Button>{output && <><NotebookMarkdown text={output} onReference={onReference}/><div className="nb-tabs"><Button onClick={() => void run(() => onExport('Transformation', output))}>Save to vault</Button>{notebookId && <Button onClick={() => void run(async () => { await client.request('/notes', 'POST', { title: 'Transformation', content: output, note_type: 'ai', notebook_id: notebookId }); setNotice('Saved to notebook.'); })}>Save as note</Button>}</div></>}</div>
      {transforms.map(t => <article key={t.id} className="nb-card nb-stack"><h3 className="font-semibold">{t.title}</h3><p className="nb-muted">{t.description}</p><details><summary>Instructions</summary><p className="nb-message whitespace-pre-wrap">{t.prompt}</p></details><div className="nb-tabs"><Button onClick={() => edit('transformation', { ...t })}>Edit</Button><Button onClick={() => deleteRow(`/transformations/${recordId(t.id)}`, t.title)}>Delete</Button></div></article>)}
    </>}
    {tab === 'episodes' && <>
      <div className="nb-card nb-stack"><h3 className="font-semibold">Create a podcast</h3><p className="nb-muted">{notebookId ? 'Uses the sources and notes in your selected notebook.' : 'Enter source material below or open a notebook first.'}</p><div className="nb-form"><Field label="Episode name"><input className="nb-input" value={episodeName} onChange={e => setEpisodeName(e.target.value)}/></Field><Field label="Episode profile"><select className="nb-input" value={episodeProfile} onChange={e => setEpisodeProfile(e.target.value)}><option value="">Select…</option>{profiles.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}</select></Field><Field label="Speaker profile"><select className="nb-input" value={speakerProfile} onChange={e => setSpeakerProfile(e.target.value)}><option value="">Select…</option>{speakers.map(p => <option key={p.id} value={p.name}>{p.name}</option>)}</select></Field><Field label="Additional instructions"><textarea className="nb-input" value={briefing} onChange={e => setBriefing(e.target.value)}/></Field>{!notebookId && <Field label="Source material"><textarea className="nb-input" rows={5} value={input} onChange={e => setInput(e.target.value)}/></Field>}</div><Button disabled={busy || !episodeName.trim() || !episodeProfile || !speakerProfile || (!notebookId && !input.trim())} className="primary" onClick={() => void run(async () => { const r = await client.request<{ message: string }>('/podcasts/generate', 'POST', { episode_name: episodeName, episode_profile: episodeProfile, speaker_profile: speakerProfile, notebook_id: notebookId, content: notebookId ? null : input, briefing_suffix: briefing || null }); setNotice(r.message); await refresh(); })}>Generate podcast</Button></div>
      {episodes.map(e => <article key={e.id} className="nb-card nb-stack"><h3 className="font-semibold">{e.name}</h3><p className="nb-muted">{e.job_status ?? 'Ready'}</p>{e.error_message && <p className="nb-error">{e.error_message}</p>}<div className="nb-tabs">{(e.audio_file || e.audio_url) && <><Button disabled={busy} onClick={() => void run(async () => { const blob = await client.media(`/podcasts/episodes/${recordId(e.id)}/audio`, 'audio/mpeg'); setAudio({ id: e.id, url: URL.createObjectURL(blob) }); })}>Play</Button><Button disabled={busy} onClick={() => void run(async () => { await client.download(`/podcasts/episodes/${recordId(e.id)}/audio`, `${e.name}.mp3`); })}>Download audio</Button></>}<Button disabled={busy} onClick={() => void run(async () => { await client.request(`/podcasts/episodes/${recordId(e.id)}/retry`, 'POST'); await refresh(); })}>Retry</Button><Button onClick={() => deleteRow(`/podcasts/episodes/${recordId(e.id)}`, e.name)}>Delete</Button></div>{audio?.id === e.id && <audio controls autoPlay src={audio.url} className="w-full"/>}{e.transcript && <details><summary>Transcript</summary><Transcript value={e.transcript}/></details>}</article>)}
    </>}
    {tab === 'speakers' && <><Button onClick={() => edit('speaker')}>New speaker profile</Button>{speakers.map(s => <article key={s.id} className="nb-card nb-stack"><h3 className="font-semibold">{s.name}</h3><p className="nb-muted">{s.description}</p><p className="text-sm">{s.speakers.map(v => String(v.name)).join(', ')}</p><div className="nb-tabs"><Button onClick={() => edit('speaker', { ...s })}>Edit</Button><Button onClick={() => deleteRow(`/speaker-profiles/${recordId(s.id)}`, s.name)}>Delete</Button></div></article>)}</>}
    {tab === 'profiles' && <><Button onClick={() => edit('profile', { num_segments: 5, language: 'en', default_briefing: '' })}>New episode profile</Button>{profiles.map(p => <article key={p.id} className="nb-card nb-stack"><h3 className="font-semibold">{p.name}</h3><p className="nb-muted">{p.description}</p><p className="text-sm">{p.default_briefing}</p><div className="nb-tabs"><Button onClick={() => edit('profile', { ...p })}>Edit</Button><Button onClick={() => deleteRow(`/episode-profiles/${recordId(p.id)}`, p.name)}>Delete</Button></div></article>)}</>}
  </div>;
}

function Transcript({ value }: { value: Record<string, unknown> }) {
  const lines = Object.values(value).find(Array.isArray) as Row[] | undefined;
  return lines ? <div className="nb-stack">{lines.map((line, i) => <p key={i} className="nb-message"><strong>{String(line.speaker ?? '')}</strong> {String(line.dialogue ?? line.text ?? line.content ?? '')}</p>)}</div> : <p className="nb-muted">Transcript is not available in a readable format.</p>;
}
