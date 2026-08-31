import { useEffect, useRef, useState } from 'react';
import { getSplashVideo } from '../services/appIcon';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Flips true once boot + first-run backfill are done, to start the animation. */
  playVideo: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
  /** Custom app icon id from the rainbow logo registry (falls back to default). */
  logo?: string;
  /** User's accent color (#rrggbb) — mixed toward white for the title gradient. */
  accentColor?: string;
}

/**
 * Startup splash overlay. Shows the 3D animated loader while the app boots
 * and the first-run semantic backfill runs, then fades out and calls
 * `onFinish`.
 *
 * The loader uses the bundled H.264 MP4 (hardware-decoded, so it plays off
 * the main thread and stays smooth). If decoding fails, no alternate loader is
 * shown.
 */
export function SplashScreen({ isLoading, playVideo, onFinish, logo, accentColor = '#38BDF8' }: SplashScreenProps) {
  const [fade, setFade] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [videoFailed, setVideoFailed] = useState(false);
  const [videoReady, setVideoReady] = useState(false);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  // Wait for the Instrument Serif + Inter fonts to finish loading before
  // showing the gradient-clipped title text, so the glyphs render correctly
  // on the first paint instead of swapping in later.
  useEffect(() => {
    if ('fonts' in document) {
      document.fonts.ready.then(() => setFontsReady(true));
    } else {
      setFontsReady(true); // fallback for environments without the API
    }
  }, []);

  useEffect(() => {
    document.documentElement.classList.add('splash-mode');
    document.body.classList.add('splash-mode');

    return () => {
      document.documentElement.classList.remove('splash-mode');
      document.body.classList.remove('splash-mode');
    };
  }, []);

  const loaderVideo = getSplashVideo();
  const useVideo = !videoFailed;
  const mediaReady = useVideo ? videoReady : true;

  useEffect(() => {
    // Do not dismiss the splash until the loader has a frame ready to show.
    // This matters for the large 3D MP4, which can outlast App's boot timer.
    if (!isLoading && mediaReady) {
      setFade(true);
      const timer = setTimeout(onFinish, 400);
      return () => clearTimeout(timer);
    }
  }, [isLoading, mediaReady, onFinish]);

  // Detect when the 3D MP4 can render. Use several readiness events because
  // WebView2 can emit `loadedmetadata` before a React effect attaches listeners.
  useEffect(() => {
    if (!loaderVideo || videoFailed) return;
    const video = videoRef.current;
    if (!video) return;

    const markReady = () => setVideoReady(true);
    const onError = () => {
      setVideoFailed(true);
      setVideoReady(true);
    };
    if (video.error) {
      onError();
      return;
    }
    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
      markReady();
    }
    video.addEventListener('loadedmetadata', markReady);
    video.addEventListener('loadeddata', markReady);
    video.addEventListener('canplay', markReady);
    video.addEventListener('canplaythrough', markReady);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('loadedmetadata', markReady);
      video.removeEventListener('loadeddata', markReady);
      video.removeEventListener('canplay', markReady);
      video.removeEventListener('canplaythrough', markReady);
      video.removeEventListener('error', onError);
    };
  }, [loaderVideo, videoFailed]);

  // React renders `muted` as an attribute but doesn't always set the DOM
  // property on mount, which can silently block muted-autoplay in WKWebView.
  // Set it imperatively and retry after metadata arrives so the MP4 starts
  // buffering/playing even when autoplay was evaluated before the property was  // applied.
  useEffect(() => {
    if (!useVideo) return;
    const video = videoRef.current;
    if (!video) return;
    const start = () => {
      video.muted = true;
      if (video.paused) video.play().catch(() => {});
    };
    start();
    video.addEventListener('loadedmetadata', start);
    video.addEventListener('canplay', start);
    return () => {
      video.removeEventListener('loadedmetadata', start);
      video.removeEventListener('canplay', start);
    };
  }, [useVideo]);

  // Start the loader from frame 0 once boot is done and the media is ready.
  // The video already began buffering/decoding during the static phase (it is
  // muted + autoplay so WKWebView allows it to load), so this just resets it
  // to the start and reveals it.
  useEffect(() => {
    if (!playVideo || !videoReady) return;
    const video = videoRef.current;
    if (video && !videoFailed) {
      video.currentTime = 0;
      if (video.paused) video.play().catch(() => {});
    }
  }, [playVideo, videoReady, videoFailed]);

  const showMedia = useVideo && videoReady;

  return (
    <div
      className={`splash-screen-container fixed inset-0 z-[100] flex flex-col items-center justify-center bg-[#35383e] rounded-none transition-opacity duration-[400ms] ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="splash-in flex flex-col items-center justify-center gap-7 px-8 rounded-none">
        <div className="relative w-[min(90vw,48rem)] aspect-video splash-logo mx-auto rounded-none">
          {useVideo && (
            <video
              ref={videoRef}
              src={loaderVideo}
              muted
              loop
              playsInline
              autoPlay
              preload="auto"
              aria-label="Prism Logo"
              className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
                showMedia ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}
        </div>
        <div className="flex flex-col items-center text-center rounded-none">
          <h1
            className={`text-8xl font-serif italic font-normal tracking-wide splash-title transition-opacity duration-500 ${
              fontsReady ? 'opacity-100' : 'opacity-0'
            }`}
            style={{
              // Accent-tinted gradient (brightened with white so dark accents
              // stay readable on black). Engines without color-mix() drop this
              // and fall back to the ice-blue gradient in .splash-title.
              backgroundImage: `linear-gradient(to bottom, #ffffff 0%, color-mix(in srgb, ${accentColor} 60%, white) 100%)`,
            }}
          >
            Prism
          </h1>
          <p
            className={`text-sm text-white/60 font-sans tracking-wider mt-2 transition-opacity duration-500 ${
              fontsReady ? 'opacity-100' : 'opacity-0'
            }`}
          >
            by SDKid
          </p>
        </div>
      </div>
    </div>
  );
}
