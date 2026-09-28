import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { recoveryEvent, type RecoveryRequest } from '../services/modelRecovery';
type Status = { state: string; command: string | null; message: string };
export function ModelServiceRecovery() {
  const [pending, setPending] = useState<RecoveryRequest | null>(null);
  const current = useRef<RecoveryRequest | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [checking, setChecking] = useState(false);
  const [copyError, setCopyError] = useState('');
  const dialog = useRef<HTMLDialogElement>(null);
  const check = async (request: RecoveryRequest) => {
    setChecking(true);
    try {
      const result = await invoke<Status>('model_service_status', { task: request.task });
      if (current.current === request) setStatus(result);
    } catch (error) { if (current.current === request) setStatus({ state: 'error', command: null, message: String(error) }); }
    finally { if (current.current === request) setChecking(false); }
  };
  const finish = (retry: boolean) => { const request = current.current; current.current = null; setPending(null); request?.finish(retry); };
  useEffect(() => {
    const receive = (event: Event) => {
      event.preventDefault();
      const request = (event as CustomEvent<RecoveryRequest>).detail;
      if (current.current) { request.finish(false); return; }
      current.current = request; setPending(request); setStatus(null); setCopyError(''); void check(request);
    };
    window.addEventListener(recoveryEvent, receive);
    return () => { window.removeEventListener(recoveryEvent, receive); current.current?.finish(false); current.current = null; };
  }, []);
  useEffect(() => {
    if (!pending) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, [pending]);
  return <dialog ref={dialog} className="runtime-dialog runtime-surface" aria-labelledby="service-title" onCancel={() => finish(false)}>
    <h2 id="service-title">AI service unavailable</h2>
    <p role="status">{checking ? 'Checking configured AI service…' : status?.message}</p>
    {status?.command && <pre className="select-text">{status.command}</pre>}
    {copyError && <p role="alert">{copyError}</p>}
    <div className="runtime-actions">
      <button autoFocus className="runtime-button" onClick={() => finish(false)}>Cancel</button>
      {status?.command && <button className="runtime-button" onClick={() => { void navigator.clipboard.writeText(status.command!).catch(() => setCopyError('Copy failed. Select and copy the command above.')); }}>Copy command</button>}
      <button className="runtime-button" disabled={checking} onClick={() => { if (pending) void check(pending); }}>Check again</button>
      {status?.state === 'ready' && !checking && <button className="runtime-button runtime-primary" onClick={() => finish(true)}>Retry request</button>}
    </div>
  </dialog>;
}
