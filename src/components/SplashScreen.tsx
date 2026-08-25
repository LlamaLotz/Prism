import { useEffect, useRef, useState } from 'react';
import { getAppIcon, getSplashLoader, getSplashVideo } from '../services/appIcon';
import whiteLogo from '../assets/logos/White.svg';

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
 * Startup splash overlay. Shows the static white logo while the app boots and
 * the first-run semantic backfill runs, then swaps in the color-matched
 * animated loader before fading out and calling `onFinish`.
 *
 * The loader prefers the H.264 mp4 (hardware-decoded, so it plays off the main
 * thread and stays smooth) and falls back to the animated WebP if the video
 * can't load or play. Both are preloaded/warmed during the static phase.
 */
export function SplashScreen({ isLoading, playVideo, onFinish, logo, accentColor = '#38BDF8' }: SplashScreenProps) {
  const [fade, setFade] = useState(false);
  const [fontsReady, setFontsReady] = useState(false);
  const [preloaded, setPreloaded] = useState(false);
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

  useEffect(() => {
    if (!isLoading) {
      setFade(true);
      const timer = setTimeout(onFinish, 400);
      return () => clearTimeout(timer);
    }
  }, [isLoading, onFinish]);

  const loaderVideo = getSplashVideo(logo);
  const loaderAnimation = getSplashLoader(logo);
  const useVideo = !videoFailed && !!loaderVideo;

  // Preload the WebP fallback during boot so it's ready if the video fails.
  useEffect(() => {
    if (!loaderAnimation || preloaded) return;
    const img = new Image();
    img.src = loaderAnimation;
    img.onload = () => setPreloaded(true);
    img.onerror = () => setPreloaded(true);
  }, [loaderAnimation, preloaded]);

  // Detect when the mp4 is buffered enough to play, or that it failed so we
  // can drop back to the WebP. Uses native listeners + a readyState check
  // (React synthetic media events can miss events fired during mount).
  useEffect(() => {
    if (!loaderVideo || videoFailed) return;
    const video = videoRef.current;
    if (!video) return;

    const markReady = () => setVideoReady(true);
    const onError = () => {
      setVideoFailed(true);
      setVideoReady(true);
    };
    if (video.readyState >= 2) {
      markReady();
      return;
    }
    video.addEventListener('loadeddata', markReady);
    video.addEventListener('canplaythrough', markReady);
    video.addEventListener('error', onError);
    return () => {
      video.removeEventListener('loadeddata', markReady);
      video.removeEventListener('canplaythrough', markReady);
      video.removeEventListener('error', onError);
    };
  }, [loaderVideo, videoFailed]);

  // React renders `muted` as an attribute but doesn't always set the DOM
  // property on mount, which can silently block muted-autoplay in WKWebView.
  // Set it imperatively so the mp4 is guaranteed to start buffering/playing
  // during the static phase instead of showing black.
  useEffect(() => {
    if (!useVideo) return;
    const video = videoRef.current;
    if (!video) return;
    video.muted = true;
    if (video.paused) video.play().catch(() => {});
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

  const showMedia = playVideo && (useVideo ? videoReady : preloaded);

  return (
    <div
      className={`splash-screen-container fixed inset-0 z-[100] flex flex-col items-center justify-center bg-black rounded-none transition-opacity duration-[400ms] ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div className="splash-in flex flex-col items-center justify-center gap-7 px-8 rounded-none">
        <div className="relative w-80 h-80 splash-logo mx-auto rounded-none">
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
          {!useVideo && loaderAnimation && (
            <img
              src={loaderAnimation}
              alt="Prism Logo"
              className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
                showMedia ? 'opacity-100' : 'opacity-0'
              }`}
            />
          )}
          <img
            src={loaderVideo || loaderAnimation ? whiteLogo : getAppIcon(logo)}
            alt="Prism Logo"
            className={`absolute inset-0 w-full h-full object-contain transition-opacity duration-300 ${
              showMedia ? 'opacity-0' : 'opacity-100'
            }`}
          />
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
            Prism1
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
