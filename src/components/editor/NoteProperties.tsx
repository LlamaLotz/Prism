import { useEffect, useMemo, useState } from "react";
import { propertyKeys, readProperties, type PropertyKey } from "./properties";
export function NoteProperties({
  content,
  change,
  source,
}: {
  content: string;
  change: (key: PropertyKey, value: string | string[]) => void;
  source: () => void;
}) {
  const parsed = useMemo(() => readProperties(content), [content]);
  return (
    <details className="note-properties">
      <summary>Properties</summary>
      {parsed.error ? (
        <p role="alert">
          {parsed.error} <button onClick={source}>Edit in Source</button>
        </p>
      ) : (
        <div className="note-properties-fields">
          {propertyKeys.map((key) => (
            <PropertyField
              key={key}
              name={key}
              value={parsed.values[key]}
              commit={(value) => change(key, value)}
            />
          ))}
        </div>
      )}
    </details>
  );
}
function PropertyField({
  name,
  value,
  commit,
}: {
  name: PropertyKey;
  value: string | string[];
  commit: (v: string | string[]) => void;
}) {
  const display = Array.isArray(value) ? value.join("\n") : value;
  const [draft, setDraft] = useState(display);
  useEffect(() => setDraft(display), [display]);
  const save = () => {
    if (draft !== display)
      commit(
        Array.isArray(value)
          ? [
              ...new Set(
                draft
                  .split("\n")
                  .map((v) => v.trim())
                  .filter(Boolean),
              ),
            ]
          : draft.trim(),
      );
  };
  return (
    <label>
      {name === "source" ? "Source URL" : name[0].toUpperCase() + name.slice(1)}
      {Array.isArray(value) ? (
        <textarea
          aria-label={name === "tags" ? "Tags" : "Aliases"}
          placeholder="One per line"
          rows={2}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
        />
      ) : (
        <input
          list={name === "status" ? "note-status-values" : undefined}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
          }}
        />
      )}
      {name === "status" && (
        <datalist id="note-status-values">
          <option value="Draft" />
          <option value="In progress" />
          <option value="Complete" />
        </datalist>
      )}
    </label>
  );
}
