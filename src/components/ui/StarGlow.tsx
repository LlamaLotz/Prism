import { mixHex } from '../../utils/accentColor';
import StarBorder from './StarBorder';

const FALLBACK_ACCENT = '#38BDF8';

/** Reads the live accent token, which `applyAccentColor` overrides on :root. */
function currentAccent(): string {
  if (typeof document === 'undefined') return FALLBACK_ACCENT;
  const value = getComputedStyle(document.documentElement).getPropertyValue('--color-brand-500').trim();
  return /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value) ? value : FALLBACK_ACCENT;
}

/**
 * Accent-tinted StarBorder used for short-lived glows. The accent is adapted
 * per mode (darker on light surfaces, brighter on dark) so the bloom keeps its
 * contrast in theme-industrial and theme-gloss.
 */
export function StarGlow({ className = '' }: { className?: string }) {
  const light = typeof document !== 'undefined' && document.documentElement.classList.contains('mode-light');
  const accent = mixHex(currentAccent(), light ? '#000000' : '#ffffff', light ? 0.2 : 0.24);
  return <StarBorder
    as="div"
    className={`star-glow${className ? ` ${className}` : ''}`}
    theme={light ? 'light' : 'dark'}
    color={accent}
    trailColor={accent}
    backgroundColor="transparent"
    borderColor="transparent"
    textColor="transparent"
    hover="none"
    clickPulse={false}
    sparkle
    duration={1.6}
    glow={0.9}
    radius={10}
  />;
}

export default StarGlow;
