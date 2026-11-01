import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { LiquidGlassLogo } from './liquid-glass-logo';
import { liquidGlassLogoDefaults } from './liquid-glass-logo-renderer';
import { getSplashLogo } from '../services/appIcon';
import { usePrefersReducedMotion } from '../utils/usePrefersReducedMotion';
import { APP_VERSION } from '../version';
import './SplashScreen.css';

interface SplashScreenProps {
  /** True while the app + vault are still booting; flips false when ready. */
  isLoading: boolean;
  /** Called after the fade-out completes so the parent can unmount this. */
  onFinish: () => void;
  /** Custom app icon id from the rainbow logo registry (falls back to /logo.png). */
  logo?: string;
}

// The renderer reports when its logo-only sequence settles (1.8 s) via a data
// attribute. This backstop only covers a renderer that never paints at all;
// slow frames no longer cut the entrance short.
const RENDERER_BACKSTOP_MS = 6000;

const {
  logoSize: LOGO_SIZE,
  logoScale: LOGO_SCALE,
  finalLogoScale: FINAL_LOGO_SCALE,
} = liquidGlassLogoDefaults;

interface SplashLogoShineProps {
  frameRef: RefObject<HTMLDivElement | null>;
  logoSrc: string;
  active: boolean;
}

/**
 * A specular sweep over the resting logo. The artwork doubles as a CSS mask,
 * so the highlight is clipped to its own alpha and stays aligned with the
 * canvas at any window size.
 */
function SplashLogoShine({ frameRef, logoSrc, active }: SplashLogoShineProps) {
  const [size, setSize] = useState(0);

  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const rect = frame.getBoundingClientRect();
      // Mirrors fit() in liquid-glass-logo-renderer: the logo always occupies
      // one plate edge, scaled down only when the frame is too small.
      const fit = Math.min(
        1,
        rect.width / (LOGO_SIZE * 1.9),
        rect.height / (LOGO_SIZE * 1.5),
      );
      setSize(LOGO_SIZE * fit * LOGO_SCALE * FINAL_LOGO_SCALE);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(frame);
    return () => observer.disconnect();
  }, [frameRef]);

  if (size <= 0) return null;
  const mask = `url(${JSON.stringify(logoSrc)})`;
  return (
    <div
      className="splash-logo-shine"
      data-active={active ? 'true' : 'false'}
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        maskImage: mask,
        WebkitMaskImage: mask,
      }}
    />
  );
}

/**
 * Startup splash overlay. Plays the Liquid Glass logo entrance immediately,
 * then holds the original logo on black and sweeps a shine across it until the
 * app finishes booting. Reduced-motion users get the resting logo only.
 *
 * The ReactDrops component is used as shipped: the sphere-to-tile entrance,
 * wavelength refraction, chromatic edges, measured fitting and image fallback
 * all come from its own renderer/shader.
 */
export function SplashScreen({ isLoading, onFinish, logo }: SplashScreenProps) {
  const [fade, setFade] = useState(false);
  const [introDone, setIntroDone] = useState(false);
  const [fallback, setFallback] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const logoHostRef = useRef<HTMLDivElement | null>(null);
  const prefersReducedMotion = usePrefersReducedMotion();
  const logoSrc = getSplashLogo(logo);
  const onFinishRef = useRef(onFinish);
  useEffect(() => { onFinishRef.current = onFinish; }, [onFinish]);

  useEffect(() => {
    document.documentElement.classList.add('splash-mode');
    document.body.classList.add('splash-mode');

    return () => {
      document.documentElement.classList.remove('splash-mode');
      document.body.classList.remove('splash-mode');
    };
  }, []);

  // Start the settle wait on the renderer's own progress: the intro finishes
  // when the sequence clock reaches its end, not after a fixed wall-clock
  // delay. A slow renderer plays the entrance in real time instead of having
  // the splash fade out halfway through it.
  useEffect(() => {
    const host = logoHostRef.current;
    if (!host) return;
    let finished = false;

    const finish = () => {
      if (finished) return;
      finished = true;
      setIntroDone(true);
    };

    const check = () => {
      if (host.querySelector('.liquid-glass-logo-fallback')) {
        // No WebGL: the component's own image fallback is already the final
        // logo, so there is no entrance to wait for (or shine over).
        setFallback(true);
        finish();
        return true;
      }
      if (host.querySelector('.liquid-glass-logo[data-liquid-glass-intro-complete]')) {
        finish();
        return true;
      }
      if (
        prefersReducedMotion &&
        host.querySelector('.liquid-glass-logo[data-liquid-glass-ready]')
      ) {
        finish();
        return true;
      }
      return false;
    };

    check();
    const observer = new MutationObserver(() => {
      if (check()) observer.disconnect();
    });
    observer.observe(host, { attributes: true, childList: true, subtree: true });
    const backstop = setTimeout(finish, RENDERER_BACKSTOP_MS);

    return () => {
      observer.disconnect();
      clearTimeout(backstop);
    };
  }, [prefersReducedMotion]);

  // Dismiss only after the entrance is complete. If boot finished earlier the
  // intro still plays out; if it takes longer, the shine bridges the wait.
  useEffect(() => {
    if (!introDone || isLoading) return;
    const hold = prefersReducedMotion ? 80 : 250;
    const fadeTimer = setTimeout(() => setFade(true), hold);
    const finishTimer = setTimeout(() => onFinishRef.current(), hold + 300);
    return () => {
      clearTimeout(fadeTimer);
      clearTimeout(finishTimer);
    };
  }, [introDone, isLoading, prefersReducedMotion]);

  // Arm the shine only if boot is still running once the entrance finishes.
  // If boot won the race, the splash dismisses without ever mounting it; once
  // armed it stays mounted so the highlight can fade out as the splash leaves.
  const [shineArmed, setShineArmed] = useState(false);
  useEffect(() => {
    if (introDone && isLoading) setShineArmed(true);
  }, [introDone, isLoading]);
  const showShine = shineArmed && !prefersReducedMotion && !fallback;

  return (
    <div
      className={`splash-screen-container fixed inset-0 z-[100] flex items-center justify-center bg-black transition-opacity duration-300 ease-out ${
        fade ? 'opacity-0 pointer-events-none' : 'opacity-100'
      }`}
    >
      <div ref={frameRef} className="relative w-[min(90vw,48rem)]">
        <div ref={logoHostRef}>
          {/* The 32-band spectral shader is fill-rate bound. 1.5x still gives
              the splash more pixels than the logo texture holds, while keeping
              the entrance smooth on software-rendered or low-end Windows GPUs. */}
          <LiquidGlassLogo
            logo={logoSrc}
            ending="logo"
            theme="dark"
            background="#000000"
            logoColor="original"
            depth={2.9}
            height={480}
            maxDpr={1.5}
            style={{ maxHeight: 'calc(100vh - 6rem)' }}
            aria-label="Prism"
          />
        </div>
        {showShine && (
          <SplashLogoShine
            frameRef={frameRef}
            logoSrc={logoSrc}
            active={isLoading}
          />
        )}
      </div>
      <div className="splash-version" aria-label={`Prism version ${APP_VERSION}`}>
        v{APP_VERSION}
      </div>
    </div>
  );
}
