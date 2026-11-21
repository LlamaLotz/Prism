# Optical Liquid Glass — titlebar pilot

Status: **feature-flagged beta**, stable CSS remains the default and permanent
fallback.

## What changed

- Added the optional WebGPU engine from `@glass-sdk/liquid-glass` 0.0.2 and its
  `@base-ui/react` peer.
- Added `appearance.glassEngine` with `stable` (default) and `optical` values.
  Existing settings migrate to `stable`.
- Added a WebGPU capability probe that checks secure context, `navigator.gpu`,
  and adapter availability before the optical engine is mounted.
- Added a bounded optical backdrop behind the existing titlebar. The titlebar
  content, menus, drag region, keyboard handling, focus restoration and window
  controls are unchanged and stay above the glass.
- The optical engine is lazy-loaded: Industrial and stable Gloss sessions keep
  the existing initial bundle.
- The optical path is currently **titlebar only**. Notes, PDFs, the editor,
  graph, notebook, settings forms and the splash logo remain solid.
- Desktop native window effects are not part of this pilot. The library
  refracts in-page DOM, not the OS desktop.

## Activation

The optical backdrop mounts only when all of these are true:

1. `themeStyle === 'gloss'` (Liquid Gloss).
2. `glassEngine === 'optical'`.
3. The page is a secure context.
4. `navigator.gpu` exists and `requestAdapter()` returns an adapter.

If any check fails, the stable CSS titlebar is used and the reason is written to
the app log. The probe result is not persisted; it is re-evaluated on launch.

## Surface rules

| Surface | Treatment |
|---|---|
| Titlebar chrome | Optical, clear material, capsule radius, low refraction |
| Titlebar menus | Kept as existing DOM above the glass; not clipped |
| Editor / PDF / code | Solid |
| Notes, graph, notebook | Solid |
| Settings forms | Solid |
| Splash logo | Existing custom WebGL shader, untouched |

The design rule is deliberate: glass belongs to chrome and transient surfaces,
not reading surfaces.

## Performance and fallback

- The optical engine and its styles are split into a lazy chunk.
- `maxSurfaces` is 2 for the titlebar scene.
- The scene is bounded to the titlebar height; it does not wrap the app tree, so
  the app is not remounted and menus cannot be clipped by the scene.
- System reduced-motion is mapped to the library's `reduced` motion level.
- `titlebar-ambient` supplies an opaque in-app backdrop when the user selected
  no background environment, so the glass has content to refract.
- Headless Chromium usually has no usable WebGPU adapter; tests force the
  fallback by removing `navigator.gpu`.

## Impeccable check

The Impeccable detector was run over the changed files. It reported only
pre-existing typography choices (`Inter`, `Instrument Serif`) and no new
anti-patterns from this pilot. Rendered contrast suites pass for both themes and
both modes.

## Known limitations

- The optical path could not be visually exercised in headless Chromium. It must
  be checked in the real Tauri webviews: macOS WKWebView and Windows WebView2.
- `@glass-sdk/liquid-glass` is 0.0.2; keep it behind the wrapper so it can be
  upgraded or removed.
- Portaled menus (`NavigationMenu`, `ModelPicker`, `ContextMenu`) are not part of
  the optical scene yet.
- The app panels still use the stable CSS material. Converting the sidebar and
  AI panel to optical is a separate step and should be gated on real-device
  measurements.
- Native desktop backdrop glass (macOS vibrancy / Windows acrylic) is separate
  work.

## Verification

```sh
npx tsc --noEmit
npm run build-frontend
npx playwright test tests/glass --workers=1
npx playwright test tests/notebook/app.spec.ts --workers=1
npx playwright test tests/settings/contrast.spec.ts tests/notebook/contrast.spec.ts --workers=1
```

All of the above passed on Linux. The optical path itself still needs a real
macOS/Windows run.
