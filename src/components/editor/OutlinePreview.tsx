import React from 'react';
import { countOutlineEntries, type OutlineEntry } from '../../utils/structurePreview';

const MAX_RENDERED_HEADINGS = 120;

function takeOutline(
  entries: OutlineEntry[],
  remaining: number
): { items: OutlineEntry[]; remaining: number } {
  const items: OutlineEntry[] = [];
  for (const entry of entries) {
    if (remaining <= 0) break;
    remaining -= 1;
    const child = takeOutline(entry.children, remaining);
    remaining = child.remaining;
    items.push({ ...entry, children: child.items });
  }
  return { items, remaining };
}

const OutlineList: React.FC<{ entries: OutlineEntry[]; depth: number }> = ({ entries, depth }) => (
  <ul className="structure-outline__list" data-depth={depth}>
    {entries.map((entry, index) => (
      <li key={`${entry.level}-${entry.title}-${index}`} className="structure-outline__item">
        <span className="structure-outline__level" aria-hidden="true">
          H{entry.level}
        </span>
        <span>{entry.title}</span>
        {entry.children.length > 0 && <OutlineList entries={entry.children} depth={depth + 1} />}
      </li>
    ))}
  </ul>
);

interface OutlinePreviewProps {
  label: string;
  entries: OutlineEntry[];
  emptyText?: string;
}

export const OutlinePreview: React.FC<OutlinePreviewProps> = ({
  label,
  entries,
  emptyText = 'No headings found.',
}) => {
  const total = countOutlineEntries(entries);
  const { items } = takeOutline(entries, MAX_RENDERED_HEADINGS);
  const omitted = total - countOutlineEntries(items);

  return (
    <section className="structure-outline" aria-label={`${label} outline`}>
      <div className="structure-outline__heading">
        <h3>{label}</h3>
        <span>
          {total} {total === 1 ? 'heading' : 'headings'}
        </span>
      </div>
      {total === 0 ? (
        <p className="structure-muted">{emptyText}</p>
      ) : (
        <>
          <OutlineList entries={items} depth={0} />
          {omitted > 0 && (
            <p className="structure-muted">
              … and {omitted} more {omitted === 1 ? 'heading' : 'headings'}.
            </p>
          )}
        </>
      )}
    </section>
  );
};
