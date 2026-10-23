import { FolderPicker } from './FolderPicker';
import React, { useEffect, useId, useRef, useState } from 'react';
import { X, File, Play, HelpCircle, AlertCircle } from 'lucide-react';
import { tauriAPI } from '../types';
import { useDialog } from './DialogProvider';

interface IngestModalProps {
  folders?: string[];
  initialFolder?: string;
  isOpen: boolean;
  onClose: () => void;
  onIngest: (type: 'url' | 'file', value: string, method?: 'yt-dlp' | 'whisper' | 'A' | 'O' | 'N', folder?: string) => void;
}

export const IngestModal: React.FC<IngestModalProps> = ({
  folders = [], initialFolder = '', isOpen,
  onClose,
  onIngest,
}) => {
  const [ingestType, setIngestType] = useState<'url' | 'file'>('url');
  const [urlValue, setUrlValue] = useState('');
  const [filePathValue, setFilePathValue] = useState('');
  const [ytMethod, setYtMethod] = useState<'yt-dlp' | 'whisper'>('yt-dlp');
  const [ocrMode, setOcrMode] = useState<'A' | 'O' | 'N'>('A');
  const { alert } = useDialog();

  const [folder,setFolder]=useState(initialFolder);
  useEffect(()=>{if(isOpen)setFolder(initialFolder);},[isOpen,initialFolder]);

  const [closing, setClosing] = useState(false);
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const urlInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const closeTimerRef = useRef<number | null>(null);
  const closingRef = useRef(false);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();
  const descriptionId = useId();

  const requestClose = () => {
    if (closingRef.current) return;
    closingRef.current = true;
    setClosing(true);
    closeTimerRef.current = window.setTimeout(() => {
      closingRef.current = false;
      setClosing(false);
      onClose();
    }, 120);
  };

  useEffect(() => {
    if (!isOpen) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    previousFocusRef.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!dialog.open) dialog.showModal();
    const focusTimer = window.setTimeout(() => {
      if (ingestType === 'url') urlInputRef.current?.focus();
      else fileInputRef.current?.focus();
    }, 30);
    return () => {
      window.clearTimeout(focusTimer);
      if (dialog.isConnected && dialog.open) dialog.close();
      if (previousFocusRef.current?.isConnected) previousFocusRef.current.focus();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen]);

  useEffect(() => () => {
    if (closeTimerRef.current) window.clearTimeout(closeTimerRef.current);
  }, []);

  if (!isOpen) return null;

  const handleBrowseFile = async () => {
    const selected = await tauriAPI.selectFile();
    if (selected) {
      setFilePathValue(selected);
    }
  };

  const handleStartIngest = async () => {
    if (ingestType === 'url') {
      const trimmed = urlValue.trim();
      if (!trimmed) {
        await alert('Please enter a valid URL.', { title: 'Missing URL' });
        return;
      }
      onIngest('url', trimmed, ytMethod, folder);
    } else {
      const trimmed = filePathValue.trim();
      if (!trimmed) {
        await alert('Please select a file to ingest.', { title: 'No file selected' });
        return;
      }
      onIngest('file', trimmed + '|' + ocrMode, undefined, folder);
    }
    // Clean fields on successful launch
    setUrlValue('');
    setFilePathValue('');
    requestClose();
  };

  return (
    <dialog
      ref={dialogRef}
      className="dialog-root backdrop-blur-sm"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      data-closing={closing}
      onCancel={(event) => {
        event.preventDefault();
        requestClose();
      }}
      onMouseDown={(event) => {
        if (event.button === 0 && event.target === event.currentTarget) requestClose();
      }}
    >
      <p id={descriptionId} className="sr-only">
        Import content from a web link or a local document or media file.
      </p>
      <div className="dialog-panel ingest-modal w-full max-w-lg bg-neutral-900 border border-neutral-800 rounded-xl shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-800">
          <h2 id={titleId} className="text-base font-bold text-neutral-100 flex items-center gap-2">
            <Play className="w-4.5 h-4.5 text-brand-400 fill-current" /> Import content
          </h2>
          <button
            type="button"
            onClick={requestClose}
            className="text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 p-1.5 rounded-lg transition-colors"
            aria-label="Close import dialog"
          >
            <X className="w-5 h-5" />
          </button>
        </div>
 
        {/* Content */}
        <div className="p-6 space-y-5">
          {/* Tab Selection */}
          <div className="flex bg-neutral-950 border border-neutral-800/80 rounded-lg p-1 shrink-0">
            <button
              onClick={() => setIngestType('url')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-md transition-all ${
                ingestType === 'url'
                  ? 'bg-neutral-800 text-brand-400 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <Play className="w-4 h-4 text-rose-500 fill-current" /> YouTube / Web Link
            </button>
            <button
              onClick={() => setIngestType('file')}
              className={`flex-1 flex items-center justify-center gap-1.5 py-2 text-xs font-semibold rounded-md transition-all ${
                ingestType === 'file'
                  ? 'bg-neutral-800 text-brand-400 shadow-sm'
                  : 'text-neutral-400 hover:text-neutral-200'
              }`}
            >
              <File className="w-4 h-4 text-emerald-400" /> Local Document / Media
            </button>
          </div>
 
           {/* Conditional Input Rendering */}

           {ingestType === 'url' ? (
             <div className="space-y-3">
               <div className="flex items-center justify-between">
                 <label className="text-xs font-medium text-neutral-400">YouTube URL(s)</label>
                 <div className="flex bg-neutral-950 border border-neutral-800 rounded-lg p-1 gap-1">
                   <button
                     onClick={() => setYtMethod('yt-dlp')}
                     className={`px-2 py-1 text-xs font-bold rounded transition-all ${
                       ytMethod === 'yt-dlp' ? 'bg-neutral-800 text-brand-400' : 'text-neutral-500 hover:text-neutral-300'
                     }`}
                   >
                     Captions
                   </button>
                   <button
                     onClick={() => setYtMethod('whisper')}
                     className={`px-2 py-1 text-xs font-bold rounded transition-all ${
                       ytMethod === 'whisper' ? 'bg-neutral-800 text-brand-400' : 'text-neutral-500 hover:text-neutral-300'
                     }`}
                   >
                     Whisper
                   </button>
                 </div>
               </div>
               <div className="text-xs text-neutral-500 mb-1">
                 Enter a YouTube link. Multiple URLs can be entered, separated by commas.
               </div>
               <input
                 ref={urlInputRef}
                 type="text"
                 aria-label="YouTube URL(s)"
                 value={urlValue}
                 onChange={(e) => setUrlValue(e.target.value)}
                 placeholder="https://www.youtube.com/watch?v=..."
                 className="w-full bg-neutral-950 border border-neutral-800 focus:border-brand-500 rounded-lg px-3 py-2 text-xs text-neutral-200 focus:outline-none"
               />
             </div>
           ) : (

            <div className="space-y-4">
              <label className="text-xs font-medium text-slate-400">Select File to Extract</label>
              <div className="text-xs text-slate-500 mb-1">
                Supported formats: PDFs, DOCX, XLSX, PPTX, MP3, WAV, MP4, MOV, PNG, JPG. Documents are layout-parsed via Docling; media is transcribed via Faster-Whisper.
              </div>
              
              <div className="flex gap-2">
                <input
                  ref={fileInputRef}
                  type="text"
                  aria-label="File to extract"
                  value={filePathValue}
                  onChange={(e) => setFilePathValue(e.target.value)}
                  placeholder="Click Browse to select file..."
                  className="flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-200 focus:outline-none"
                />
                <button
                  onClick={handleBrowseFile}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold px-3 py-2 rounded-lg transition-colors border border-slate-700 shrink-0"
                >
                  Browse File
                </button>
              </div>

              {/* OCR Mode Selection */}
              <div className="flex items-center justify-between mt-4">
                 <label className="text-xs font-medium text-neutral-400">OCR Parsing Mode</label>
                 <div className="flex bg-neutral-950 border border-neutral-800 rounded-lg p-1 gap-1">
                   {[
                     { label: 'Adaptive', value: 'A' },
                     { label: 'On', value: 'O' },
                     { label: 'Off', value: 'N' },
                   ].map((mode) => (
                     <button
                       key={mode.value}
                       onClick={() => setOcrMode(mode.value as 'A' | 'O' | 'N')}
                       className={`px-2 py-1 text-xs font-bold rounded transition-all ${
                         ocrMode === mode.value ? 'bg-neutral-800 text-brand-400' : 'text-neutral-500 hover:text-neutral-300'
                       }`}
                     >
                       {mode.label}
                     </button>
                   ))}
                 </div>
               </div>
            </div>
          )}

          <FolderPicker folders={folders} value={folder} onChange={setFolder}/>
          {/* Info Badge */}
           <div className="p-3 bg-neutral-950/50 border border-neutral-800 rounded-xl flex gap-2.5">
             <AlertCircle className="w-4 h-4 text-brand-400 shrink-0 mt-0.5" />
             <div className="text-xs text-neutral-400 leading-relaxed">
               <span className="font-semibold text-neutral-300 block mb-0.5">FOLDER SEGREGATION NOTICE:</span>
               Clean markdown notes will be output directly into your selected Prism notes vault. All intermediate metadata, raw transcribing tracks, and downloaded assets are safely kept in your isolated <code className="bg-neutral-900 text-brand-300 px-1 py-0.2 rounded font-mono">raw_service_files</code> directory.
             </div>
           </div>
         </div>
 
         {/* Footer */}
         <div className="ingest-modal-footer px-6 py-4 border-t border-neutral-800 bg-neutral-950/30 flex justify-end gap-3 shrink-0">
           <button
             type="button"
             onClick={requestClose}
             className="px-4 py-2 text-xs font-semibold text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 rounded-lg transition-colors"
           >
             Cancel
           </button>
           <button
             type="button"
             onClick={handleStartIngest}
             className="px-4 py-2 bg-gradient-to-r from-brand-500 to-brand-600 hover:from-brand-400 hover:to-brand-500 text-white text-xs font-bold rounded-lg flex items-center gap-1.5 shadow-md shadow-brand-500/10 hover:shadow-brand-500/20 transition-all border border-brand-400/20"
           >
             <Play className="w-3.5 h-3.5 fill-current" /> Start Ingestion
           </button>
         </div>
       </div>
    </dialog>
  );
};
