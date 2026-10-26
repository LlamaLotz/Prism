import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import type { PdfRequest } from "../../services/research";
import { useDialog } from "../DialogProvider";

// Register the open listener with the app shell. Only the renderer (and PDF.js)
// loads lazily, so requests made while its chunk is loading remain in state.
const PdfReader = lazy(() =>
  import("./PdfReader").then(module => ({ default: module.PdfReader })),
);

export function PdfWorkspace({
  vaultPath,
  notePath,
}: {
  vaultPath: string;
  notePath?: string;
}) {
  const [request, setRequest] = useState<(PdfRequest & { key: number }) | null>(
    null,
  );
  const dirty = useRef(false);
  const discardDraft = useRef<() => void>(() => {});
  const [confirming, setConfirming] = useState(false);
  const dirtyChanged = useCallback((value: boolean) => {
    dirty.current = value;
  }, []);
  const registerDiscard = useCallback((fn: () => void) => {
    discardDraft.current = fn;
  }, []);
  const { confirm } = useDialog();
  const allowDiscard = async () => {
    if (!dirty.current) return true;
    const discard = discardDraft.current;
    setConfirming(true);
    try {
      if (
        !(await confirm("Discard unsaved PDF annotations?", {
          title: "Unsaved annotations",
        }))
      )
        return false;
      discard();
      dirty.current = false;
      return true;
    } finally {
      setConfirming(false);
    }
  };
  useEffect(() => {
    const open = async (e: Event) => {
      if (!(await allowDiscard())) return;
      setRequest({ ...(e as CustomEvent).detail, key: Date.now() });
    };
    window.addEventListener("prism-open-pdf", open);
    return () => window.removeEventListener("prism-open-pdf", open);
  }, [confirm]);
  useEffect(() => {
    setRequest(null);
    dirty.current = false;
  }, [vaultPath]);
  if (!request) return null;
  return (
    <Suspense
      fallback={
        <section className="pdf-reader" data-region="pdf" aria-label="PDF reader">
          <p role="status">Opening PDF…</p>
        </section>
      }
    >
      <PdfReader
        blocked={confirming}
        registerDiscard={registerDiscard}
        vaultPath={vaultPath}
        key={request.key}
        request={request}
        notePath={notePath}
        dirtyChanged={dirtyChanged}
        close={async () => {
          if (await allowDiscard()) setRequest(null);
        }}
      />
    </Suspense>
  );
}
