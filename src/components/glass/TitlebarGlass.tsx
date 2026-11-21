import { GlassScene, GlassContent, GlassSurface } from '@glass-sdk/liquid-glass';
import '@glass-sdk/liquid-glass/styles.css';
import { appLogger } from '../../services/appLogger';
import { usePrefersReducedMotion } from '../../utils/usePrefersReducedMotion';
import { SCENE_LIMITS, TITLEBAR_GLASS } from './glassTokens';

type BackgroundEnvironment = 'none' | 'solar-system' | 'stars' | 'clouds';

interface TitlebarGlassProps {
  appearance: 'dark' | 'light';
  backgroundEnvironment: BackgroundEnvironment;
}

/**
 * A bounded optical-glass backdrop for the title bar only.
 *
 * It is rendered behind the existing titlebar content as a separate layer, so
 * menu positioning, drag regions, window controls and the app tree are not
 * remounted or clipped. The stable CSS titlebar remains the fallback.
 */
export function TitlebarGlass({ appearance, backgroundEnvironment }: TitlebarGlassProps) {
  const reducedMotion = usePrefersReducedMotion();
  const backgroundClass = backgroundEnvironment === 'solar-system'
    ? 'prism-bg-solar'
    : `prism-bg-${backgroundEnvironment}`;

  return (
    <div className="optical-titlebar-backdrop" aria-hidden="true">
      <GlassScene
        className="optical-titlebar-scene"
        material="clear"
        appearance={appearance}
        motion={reducedMotion ? 'reduced' : 'full'}
        maxSurfaces={SCENE_LIMITS.titlebar}
        onDiagnostic={diagnostic => {
          if (diagnostic) appLogger.info(`Optical titlebar: ${JSON.stringify(diagnostic)}`);
        }}
      >
        <GlassContent className="optical-titlebar-content">
          {backgroundEnvironment === 'none' ? (
            <div className="optical-titlebar-ambient" />
          ) : (
            <div
              className={`prism-bg-environment ${backgroundClass}`}
              style={{
                position: 'absolute',
                top: 0,
                left: 0,
                width: '100vw',
                height: '100vh',
              }}
            />
          )}
        </GlassContent>
        <GlassSurface
          className="optical-titlebar-glass"
          {...TITLEBAR_GLASS}
          motion={reducedMotion ? 'reduced' : 'full'}
        />
      </GlassScene>
    </div>
  );
}
