# CSS Warnings: skill-validation-v1

> Compatibility notes and polyfill requirements.

## Observations

- **`gap` in flexbox**: Used for metric card spacing. Supported in all modern browsers but requires fallback margin for Safari < 14.1.
- **`backdrop-filter: blur()`**: Used on header for frosted-glass effect. Not supported in Firefox < 103. Consider providing a solid background fallback.
- **CSS `color-mix()`**: Not used — all colors are pre-resolved hex values.
- **Container queries**: Not used — layout uses fixed breakpoints only.

## Recommendations

- Add `-webkit-backdrop-filter` vendor prefix alongside `backdrop-filter` in the header section.
- For flexbox gap fallback, use `margin-bottom` on children with a negative margin on the container.
