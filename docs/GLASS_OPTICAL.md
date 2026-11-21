# Liquid Glass optical contract

This is the design contract for Prism's optional WebGPU glass. It follows the
Impeccable principle that glass is **chrome and transient surfaces**, not a
reading surface.

## Surface map

| Surface | Engine | Material | Radius | Refraction | Notes |
|---|---|---|---|---|---|
| Titlebar chrome | Optical (pilot) | `clear` | capsule | 14 | Backdrop behind the existing content |
| Titlebar menus | Stable DOM | — | — | — | Kept above the glass, not clipped |
| Vault sidebar | Stable CSS | `--material-panel-*` | 24px | — | Optical conversion is a later step |
| Workspace / editor | Solid | — | — | — | Reading surface |
| PDF / code | Solid | — | — | — | Reading surface |
| AI panel shell | Stable CSS | `--material-panel-*` | 24px | — | Later step |
| Graph / notebook | Solid | — | — | — | Canvas or dense reading |
| Command palette / dialogs | Stable CSS | `--material-popover-*` | 14px | — | Portaled menus are not in the scene yet |
| Splash wordmark | Existing shader | — | — | — | Preserve the custom WebGL logo |

## Material mapping

| Prism concept | Optical value |
|---|---|
| `appearance.themeMode` | `appearance="dark" \| "light"` |
| `themeStyle === 'gloss'` | optical eligible |
| `--material-chrome-radius` | `radius="capsule"` |
| `--material-panel-radius` | `radius={24}` when panels are converted |
| chrome | `material="clear"`, low refraction |
| panels | `material="regular"`, medium/high refraction |
| text | `--lg-foreground` / `--lg-material-foreground` |
| reduced motion | `motion="reduced"` |

## Rules

1. **Bounded scenes.** Every scene has an explicit height and clips its content.
2. **No reading-surface glass.** Editor, PDF, code and settings forms stay solid.
3. **Stable is permanent.** The CSS material path is not a temporary scaffold; it
   is the fallback for every unsupported device.
4. **Capability before mount.** Secure context, `navigator.gpu`, and a non-null
   adapter are required. Any failure logs a reason and renders CSS.
5. **Lazy engine.** The WebGPU library is split from the initial bundle.
6. **Scene-local popups.** Menus and dialogs that must refract must live inside
   the scene. Portals are out of scope until they have a scene container.
7. **Opaque content in Safari.** The scene content uses an opaque background so
   refraction is stable in WKWebView.
8. **No app remount.** The pilot's scene is a bounded backdrop layer behind the
   real titlebar, not a wrapper around the app tree.

## Performance budgets

- Titlebar scene: `maxSurfaces={2}`, height 36px.
- No optical scene on Industrial or stable Gloss.
- The initial bundle must not include the optical library.
- Measure resize, menu open/close and theme switching on macOS WKWebView and
  Windows WebView2 before expanding to panels.

## Accessibility

- Rendered contrast suites must pass in Industrial/Gloss and light/dark.
- Keyboard and focus behavior in the titlebar is unchanged.
- Reduced motion is mapped to the library's `reduced` level.
- Glass does not replace semantic HTML or accessible names.
