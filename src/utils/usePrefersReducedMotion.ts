import { useEffect, useState } from 'react';

const QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's reduced-motion preference for motion that lives outside
 * CSS (D3 transitions, canvas/WebGL camera moves, autoplay loops).
 *
 * The initial value is read synchronously so a graph does not start its
 * auto-rotate/transition pass for one frame before the preference is known.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return false;
    }
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia(QUERY);
    const onChange = () => setReduced(media.matches);
    onChange();

    if (typeof media.addEventListener === 'function') {
      media.addEventListener('change', onChange);
      return () => media.removeEventListener('change', onChange);
    }
    // WebKitGTK/older WKWebView.
    media.addListener(onChange);
    return () => media.removeListener(onChange);
  }, []);

  return reduced;
}
