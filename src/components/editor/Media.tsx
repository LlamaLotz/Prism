import { useEffect, useRef, useState } from "react";
import { research, openPdf, type ResearchAsset } from "../../services/research";
export function Media({
  target,
  notePath,
  alt = "",
}: {
  target: string;
  notePath: string;
  alt?: string;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const [visible, setVisible] = useState(false),
    [allowed, setAllowed] = useState(false);
  const [asset, setAsset] = useState<ResearchAsset | null>(null),
    [error, setError] = useState("");
  const remote = /^https?:\/\//i.test(target);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "300px" },
    );
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setAsset(null);
    setError("");
    setAllowed(false);
    if (remote || !visible) return;
    let alive = true,
      loaded: ResearchAsset | null = null;
    void research
      .asset(notePath, target.split(/[?#]/, 1)[0])
      .then((a) => {
        loaded = a;
        if (alive) setAsset(a);
        else void research.close(a.handle);
      })
      .catch((e) => {
        if (alive) setError(String(e));
      });
    return () => {
      alive = false;
      if (loaded) void research.close(loaded.handle);
    };
  }, [target, notePath, visible, remote]);
  const src = remote
    ? allowed
      ? target
      : ""
    : asset
      ? research.url(asset.handle) +
        (target.includes("#") ? "#" + target.split("#").slice(1).join("#") : "")
      : "";
  const type =
    asset?.mime ??
    (/\.(mp4|webm)(?:[?#]|$)/i.test(target)
      ? "video/"
      : /\.(mp3|wav|ogg|m4a)(?:[?#]|$)/i.test(target)
        ? "audio/"
        : /\.pdf(?:[?#]|$)/i.test(target)
          ? "application/pdf"
          : "image/");
  return (
    <span ref={root} className="note-media">
      {error ? (
        <span role="alert">
          Attachment unavailable: {alt || target}. {error}
        </span>
      ) : remote && !allowed ? (
        <button onClick={() => setAllowed(true)}>
          Load remote media: {alt || target}
        </button>
      ) : type === "application/pdf" ? (
        asset ? (
          <button
            onClick={() =>
              openPdf({
                attachmentHandle: asset.handle,
                page: Number(/#page=(\d+)/i.exec(target)?.[1]) || undefined,
              })
            }
          >
            Open PDF · {alt || asset.name}
          </button>
        ) : remote ? (
          <a href={target} target="_blank" rel="noreferrer">
            Open PDF externally
          </a>
        ) : (
          <span>Loading PDF…</span>
        )
      ) : !src ? (
        <span>Loading {alt || "attachment"}…</span>
      ) : type.startsWith("audio/") ? (
        <audio
          controls
          preload="metadata"
          src={src}
          aria-label={alt || "Audio attachment"}
        />
      ) : type.startsWith("video/") ? (
        <video
          controls
          preload="metadata"
          src={src}
          aria-label={alt || "Video attachment"}
        />
      ) : (
        <img
          loading="lazy"
          src={src}
          alt={alt}
          onError={() => setError("Unable to display image")}
        />
      )}
    </span>
  );
}
