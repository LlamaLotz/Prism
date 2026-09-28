/** Conservative, local-only hint: it never grants tool permissions. */
export function needsAgent(prompt: string): boolean {
  const text = prompt.trim();
  try {
    const value = JSON.parse(text);
    if (typeof value?.tool === 'string' && value.input !== undefined) return true;
  } catch { /* Natural-language prompt. */ }
  if (/^(?:["'`>]|how\b|why\b|what\b|explain\b|describe\b|show me how\b)/i.test(text)) return false;
  return /^(?:(?:please|can you|could you|would you)\s+)*(?:create|edit|update|change|rename|move|delete|remove|add|format|read|search|find|open)\b[\s\S]{0,200}\b(?:note|notes|folder|folders|vault|tag|tags|wikilink|wikilinks|backlinks|file|files)\b/i.test(text);
}
