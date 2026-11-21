import { useEffect, useState } from 'react';
import { appLogger } from '../../services/appLogger';
import { probeWebGpu } from './capability';

export type OpticalGlassStatus = {
  /** True only when the optical engine is requested and WebGPU is usable. */
  active: boolean;
  /** True while the adapter probe is in flight. */
  checking: boolean;
  /** Why optical glass is unavailable; null when active or not requested. */
  reason: string | null;
};

const INACTIVE: OpticalGlassStatus = { active: false, checking: false, reason: null };

/**
 * Decides whether a component may mount the WebGPU optical engine.
 *
 * Stable CSS glass remains the default and the permanent fallback. The probe
 * runs only when the user selected Liquid Gloss + Optical, so Industrial and
 * stable users never pay for the check.
 */
export function useOpticalGlass(
  themeStyle: 'industrial' | 'gloss' | undefined,
  glassEngine: 'stable' | 'optical' | undefined,
): OpticalGlassStatus {
  const wanted = themeStyle === 'gloss' && glassEngine === 'optical';
  const [status, setStatus] = useState<OpticalGlassStatus>(
    wanted ? { active: false, checking: true, reason: null } : INACTIVE,
  );

  useEffect(() => {
    let cancelled = false;
    if (!wanted) {
      setStatus(INACTIVE);
      return;
    }

    setStatus({ active: false, checking: true, reason: null });
    void probeWebGpu().then(result => {
      if (cancelled) return;
      if (result.ok) {
        setStatus({ active: true, checking: false, reason: null });
      } else {
        appLogger.info(`Optical glass unavailable: ${result.reason}`);
        setStatus({ active: false, checking: false, reason: result.reason });
      }
    });

    return () => {
      cancelled = true;
    };
  }, [wanted]);

  return status;
}
