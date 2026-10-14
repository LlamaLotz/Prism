import React from 'react';
import { Link2, ScanSearch, FileSearch, X } from 'lucide-react';

interface LinkerToolbarProps {
  pendingCount: number;
  isScanning: boolean;
  isReady: boolean;
  isPanelOpen: boolean;
  onScan: () => void;
  onToggleLinks: () => void;
}

export const LinkerToolbar: React.FC<LinkerToolbarProps> = ({
  pendingCount,
  isScanning,
  isReady,
  isPanelOpen,
  onScan,
  onToggleLinks,
}) => {
  return (
    <div className="flex items-center gap-1.5">
      <button
        onClick={onScan}
        disabled={isScanning || !isReady}
        aria-pressed={false}
        title={isReady ? 'Scan this note for unlinked mentions' : 'Select a vault first'}
        className="editor-btn"
      >
        <ScanSearch className="w-3.5 h-3.5" />
        {isScanning ? 'Scanning...' : 'Scan'}
      </button>

      {/* Review button doubles as the links-panel toggle. It only shows while
          there is something to review — once every suggestion is approved or
          dismissed it disappears. */}
      {pendingCount > 0 && (
        <button
          onClick={onToggleLinks}
          aria-pressed={isPanelOpen}
          title={
            isPanelOpen
              ? `Close the links panel (${pendingCount} suggestion${pendingCount === 1 ? '' : 's'})`
              : `Open the links panel (${pendingCount} suggestion${pendingCount === 1 ? '' : 's'})`
          }
          className="editor-btn"
        >
          {isPanelOpen ? <X className="w-3.5 h-3.5" /> : <FileSearch className="w-3.5 h-3.5" />}
          {isPanelOpen ? 'Close Links' : 'Review'}
          <span className="editor-badge">
            {pendingCount}
          </span>
        </button>
      )}

      <Link2 className="w-3.5 h-3.5 text-slate-600" />
    </div>
  );
};