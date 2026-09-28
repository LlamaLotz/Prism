import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { knowledge, type AgentToolResponse } from '../services/knowledge';
import { requestServiceRecovery } from '../services/modelRecovery';

export function AIEnhancements({ path, content, onChanged }: { path: string; content: string; onChanged: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [proposal, setProposal] = useState<AgentToolResponse | null>(null);
  const [operation, setOperation] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const generation = useRef(0);
  const pending = useRef<string | null>(null);
  useEffect(() => {
    generation.current++;
    setProposal(null);
    if (pending.current) void knowledge.agentApprove(pending.current, false).catch(() => {});
    pending.current = null;
  }, [path, content]);
  useEffect(() => () => {
    generation.current++;
    if (pending.current) void knowledge.agentApprove(pending.current, false).catch(() => {});
  }, []);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); previous?.focus(); };
  }, [open]);
  const generate = async (task: string) => {
    if (busy) return;
    const revision = generation.current;
    setBusy(true); setError(''); setProposal(null);
    try {
      if (pending.current) await knowledge.agentApprove(pending.current, false);
      pending.current = null;
      const request = () => invoke<AgentToolResponse>('prepare_ai_enhancement', { task, path, expectedContent: content });
      let result: AgentToolResponse;
      try { result = await request(); }
      catch (error) {
        if (!String(error).includes('SERVICE_UNAVAILABLE:') || !await requestServiceRecovery(task) || revision !== generation.current) throw error;
        result = await request();
      }
      if (revision !== generation.current) {
        if (result.approvalId) await knowledge.agentApprove(result.approvalId, false);
        throw new Error('CONFLICT: Note changed. Generate a fresh preview.');
      }
      pending.current = result.approvalId; setProposal(result);
    } catch (error) { setError(String(error)); }
    finally { setBusy(false); }
  };
  const close = () => {
    generation.current++; setOpen(false); setProposal(null);
    if (pending.current) void knowledge.agentApprove(pending.current, false).catch(() => {});
    pending.current = null;
  };
  return <>
    <button className="runtime-button" onClick={() => setOpen(true)}>AI tools</button>
    <dialog ref={dialog} className="runtime-dialog runtime-surface document-dialog" aria-labelledby="enhancement-title" onCancel={close}>
      <h2 id="enhancement-title">Optional AI enhancements</h2>
      <p>Save your note first. Each action uses its selected provider and privacy policy. Review the proposed changes before applying them. AI scan adds suggested tags and a category tag.</p>
      {content.length > 40_000 && <p>Whole-note AI is unavailable at this size. Select a section of 40,000 characters or fewer in the editor first. Standard local tools remain available.</p>}
      <div className="runtime-actions">
        <button className="runtime-button" disabled={busy || content.length > 40_000} title="Select a section of 40,000 characters or fewer to enable AI." onClick={() => void generate('LINK_SUGGEST')}>AI link suggestions</button>
        <button className="runtime-button" disabled={busy || content.length > 40_000} title="Select a section of 40,000 characters or fewer to enable AI." onClick={() => void generate('FORMAT')}>AI formatting</button>
        <button className="runtime-button" disabled={busy || content.length > 40_000} title="Select a section of 40,000 characters or fewer to enable AI." onClick={() => void generate('AI_SCAN')}>AI scan</button>
      </div>
      {busy && <p role="status">Preparing… Privacy approval may be waiting in Jobs.</p>}
      {error && <p className="runtime-error" role="alert">{error}</p>}
      {proposal && <><h3>Review changes</h3><pre>{proposal.preview}</pre></>}
      <div className="runtime-actions">
        <button autoFocus className="runtime-button" onClick={close}>Close</button>
        {proposal?.approvalId && <button className="runtime-button runtime-primary" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { const result = await knowledge.agentApprove(proposal.approvalId!, true); pending.current = null; setProposal(null); setOperation(result.result?.operationId ?? null); await onChanged(); }
          catch (error) { setError(String(error)); setProposal(null); }
          finally { setBusy(false); }
        }}>Approve changes</button>}
        {operation && <button className="runtime-button" disabled={busy} onClick={async () => {
          setBusy(true); setError('');
          try { await knowledge.agentUndoOperation(operation); setOperation(null); await onChanged(); }
          catch (error) { setError(String(error)); }
          finally { setBusy(false); }
        }}>Undo AI changes</button>}
      </div>
    </dialog>
  </>;
}
