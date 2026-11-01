import { getCurrentWindow } from '@tauri-apps/api/window';
import { Image as TauriImage } from '@tauri-apps/api/image';
// Dark-mode logos (visible on dark backgrounds).
import blueAC from '../assets/logos/Blue AC.svg';
import bwAC from '../assets/logos/BW AC.svg';
import greyAC from '../assets/logos/Grey AC.svg';
import whiteAC from '../assets/logos/White AC.svg';
import blue from '../assets/logos/Blue.svg';
import grey from '../assets/logos/Grey.svg';
import white from '../assets/logos/White.svg';
// Light-mode logos (visible on light backgrounds).
// Each id maps to its light counterpart in Logo's/Light Mode/Transparent.
import blueACLight from '../assets/logos/light/Blue AC.svg';
import bwACLight from '../assets/logos/light/BW AC.svg';
import greyACLight from '../assets/logos/light/Grey AC.svg';
import whiteACLight from '../assets/logos/light/White AC.svg';
import blueLight from '../assets/logos/light/Blue.svg';
import greyLight from '../assets/logos/light/Grey.svg';
import whiteLight from '../assets/logos/light/White.svg';
// Raster copies of the dark-mode logos, used only by the startup splash. WebKit
// drops an SVG's embedded <image> layers when the file is drawn into a canvas,
// so the splash cannot use the SVG variants even though <img> can.
import blueACSplash from '../assets/logos/splash/blue-ac.png';
import greyACSplash from '../assets/logos/splash/grey-ac.png';
import whiteACSplash from '../assets/logos/splash/white-ac.png';
import blueSplash from '../assets/logos/splash/blue.png';
import greySplash from '../assets/logos/splash/grey.png';
import whiteSplash from '../assets/logos/splash/white.png';
import bwACSplash from '../assets/logos/splash/bw-ac.png';

/**
 * The Prism logos the user can pick from as the app icon (SVG, transparent
 * backgrounds). The rainbow set uses the AC variants; a separate no-rainbow
 * set and a monochrome (black & white) set are grouped under their own labels
 * in the settings UI. `appIcon` in settings stores the option `id`;
 * getAppIcon() resolves it.
 */
export interface AppIconOption {
  id: string;
  label: string;
  url: string;
}

export interface AppIconGroup {
  id: string;
  label: string;
  icons: AppIconOption[];
}

export const APP_ICON_GROUPS: AppIconGroup[] = [
  {
    id: 'rainbow',
    label: 'With Rainbow',
    icons: [
      { id: 'blue-ac', label: 'Blue', url: blueAC },
      { id: 'grey-ac', label: 'Grey', url: greyAC },
      { id: 'white-ac', label: 'White', url: whiteAC },
    ],
  },
  {
    id: 'no-rainbow',
    label: 'No Rainbow',
    icons: [
      { id: 'blue', label: 'Blue', url: blue },
      { id: 'grey', label: 'Grey', url: grey },
      { id: 'white', label: 'White', url: white },
    ],
  },
  {
    id: 'monochrome',
    label: 'Monochrome',
    icons: [{ id: 'bw-ac', label: 'Black & White', url: bwAC }],
  },
];

/** Flat lookup list (used by the settings UI). */
export const APP_ICONS: AppIconOption[] = APP_ICON_GROUPS.flatMap((g) => g.icons);

/** Dark-mode icon URLs (visible on dark backgrounds). */
const DARK_ICON_MAP: Record<string, string> = {
  'blue-ac': blueAC,
  'grey-ac': greyAC,
  'white-ac': whiteAC,
  'bw-ac': bwAC,
  blue,
  grey,
  white,
};

/** Light-mode icon URLs (visible on light backgrounds).
 *  Each id maps to the corresponding Logo's/Light Mode/Transparent variant. */
const LIGHT_ICON_MAP: Record<string, string> = {
  'blue-ac': blueACLight,
  'grey-ac': greyACLight,
  'white-ac': whiteACLight,
  'bw-ac': bwACLight,
  blue: blueLight,
  grey: greyLight,
  white: whiteLight,
};

/**
 * Dark-mode raster variants for the startup splash. Every entry is a PNG so
 * WebKit never has to rasterize an SVG with embedded <image> layers through a
 * canvas: it drops those layers, which left the splash showing only the prism
 * outline in its CSS shine instead of the artwork itself.
 */
const SPLASH_ICON_MAP: Record<string, string> = {
  'blue-ac': blueACSplash,
  'grey-ac': greyACSplash,
  'white-ac': whiteACSplash,
  'bw-ac': bwACSplash,
  blue: blueSplash,
  grey: greySplash,
  white: whiteSplash,
};

/**
 * Resolves a stored app-icon id to its asset URL, selecting the appropriate
 * dark-mode or light-mode variant based on `themeMode`.
 *
 * Falls back to /logo.png for empty ids, and keeps legacy data-URL uploads
 * working. Each logo id maps to a dedicated light variant from
 * Logo's/Light Mode/Transparent so the icon always reads clearly on the
 * background colour scheme.
 */
export function getAppIcon(id?: string, themeMode?: 'dark' | 'light'): string {
  if (!id) return '/logo.png';
  if (id.startsWith('data:')) return id;
  const map = themeMode === 'light' ? LIGHT_ICON_MAP : DARK_ICON_MAP;
  return map[id] ?? DARK_ICON_MAP[id] ?? '/logo.png';
}

/**
 * Resolves the startup splash logo from the stored app-icon id.
 *
 * The splash is always black, so it always uses the dark-mode variant even when
 * the app itself is in light mode. Every known icon maps to a raster PNG: the
 * splash draws the artwork into a canvas before uploading it as a WebGL
 * texture, and WebKit drops the embedded raster layers of these SVGs when they
 * are rasterized that way — leaving only the vector strokes. The PNG copies
 * carry the same artwork and decode everywhere. Data-URL uploads pass through
 * untouched.
 */
export function getSplashLogo(id?: string): string {
  if (!id) return '/logo.png';
  if (id.startsWith('data:')) return id;
  return SPLASH_ICON_MAP[id] ?? '/logo.png';
}

/**
 * Rasterizes any resolvable icon URL (SVG, PNG, data URL, bundled asset) to
 * RGBA PNG bytes by drawing it through a canvas at a fixed size.
 */
async function rasterizeToPng(url: string, size = 256): Promise<Uint8Array> {
  const img = new window.Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error(`Failed to load icon: ${url}`));
    img.src = url;
  });
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D context unavailable');
  ctx.clearRect(0, 0, size, size);
  ctx.drawImage(img, 0, 0, size, size);
  const blob = await new Promise<Blob>((resolve) =>
    canvas.toBlob((b) => resolve(b as Blob), 'image/png')
  );
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Applies the chosen logo as the OS window icon (taskbar on Windows, window
 * icon on macOS/Linux). Falls back silently if the runtime icon can't be set
 * (e.g. bundled builds with a locked window icon).
 */
export async function applyWindowIcon(
  id?: string,
  themeMode?: 'dark' | 'light',
): Promise<void> {
  try {
    const url = getAppIcon(id, themeMode);
    const png = await rasterizeToPng(url);
    const icon = await TauriImage.fromBytes(png);
    await getCurrentWindow().setIcon(icon);
  } catch (err) {
    console.error('applyWindowIcon failed:', err);
  }
}
