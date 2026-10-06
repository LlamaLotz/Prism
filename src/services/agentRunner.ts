import { knowledge, type AgentToolResponse } from './knowledge';
export type AgentMessage = { role: 'system' | 'user' | 'assistant'; content: string };
export function extractToolCalls(text: string): Array<{ tool: string; input: unknown }> {
  const calls: Array<{ tool: string; input: unknown }> = [];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) {
    try { const parsed = JSON.parse(match[1]); for (const item of Array.isArray(parsed) ? parsed : [parsed]) if (typeof item?.tool === 'string' && item.input !== undefined) calls.push(item); } catch { /* A prose code block is not a tool call. */ }
  }
  return calls;
}
/** Shared bounded tool loop. Every await is followed by a cancellation check before dispatch. */
export async function runAgentTurn({ messages, complete, post, approval, onTool, check = () => {} }: {
  messages: AgentMessage[]; complete: (messages: AgentMessage[]) => Promise<string>;
  post: (text: string, progress?: boolean) => void | Promise<void>; approval: (response: AgentToolResponse) => void | Promise<void>;
  check?: () => void; onTool?:(name:string)=>void;
}) {
  const work = [...messages];
  const call = async (tool: string, input: unknown) => { check(); onTool?.(tool); const result = await knowledge.agentCall(tool, input); check(); return result; };
  let manual: { tool: string; input: unknown } | null = null;
  try { const value = JSON.parse(work.at(-1)?.content || ''); if (typeof value.tool === 'string' && value.input !== undefined) manual = value; } catch { /* Natural-language request. */ }
  if (manual) {
    const result = await call(manual.tool, manual.input);
    if (result.requiresApproval && result.approvalId) await approval(result);
    else await post(`Tool \`${result.tool}\` result:\n\n\`\`\`json\n${JSON.stringify(result.result ?? result.error, null, 2)}\n\`\`\``);
    return;
  }
  for (let round = 0; round < 5; round++) {
    check(); const text = await complete(work); check();
    work.push({ role: 'assistant', content: text });
    const calls = extractToolCalls(text);
    if (!calls.length) { await post(text); return; }
    await post(`Agent: calling ${calls.map(c => `\`${c.tool}\``).join(', ')}…`, true);
    for (const request of calls) {
      let result: AgentToolResponse;
      try { result = await call(request.tool, request.input); }
      catch (error) { check(); work.push({ role: 'user', content: `Tool ${request.tool} failed: ${String(error)}. Adjust the call or explain the problem.` }); continue; }
      if (result.requiresApproval && result.approvalId) {
        await approval(result);
        work.push({ role: 'user', content: `Tool ${result.tool} prepared approval ${result.approvalId}. Stop calling tools and summarize the proposed change. It has not been applied.` });
        try { check(); const summary = await complete(work); check(); if (!extractToolCalls(summary).length) await post(summary); } catch (error) { check(); /* The persisted preview is sufficient if the summary fails. */ }
        return;
      }
      const json = JSON.stringify(result.result ?? result.error ?? null, null, 2);
      work.push({ role: 'user', content: `Tool ${result.tool} result:\n${json.slice(0, 6000)}${json.length > 6000 ? '\n...[tool result truncated]' : ''}\nContinue or answer the user.` });
    }
  }
  check(); await post('Agent reached its step limit. Review prepared previews, or ask me to continue.');
}
