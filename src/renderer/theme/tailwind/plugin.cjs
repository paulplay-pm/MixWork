/**
 * Tailwind CSS v3 plugin — bridges --mixwork-* CSS variables into Tailwind utility classes.
 *
 * Usage in tailwind.config.js:
 *   plugins: [require('./src/renderer/theme/tailwind/plugin.cjs')]
 *
 * Provides: bg-background, text-foreground, bg-primary, border-border, etc.
 * Also provides legacy claude.* aliases for backward compatibility.
 *
 * Colors are wrapped in color-mix() with the <alpha-value> placeholder so that
 * Tailwind opacity modifiers (e.g. text-foreground/90, bg-surface-raised/30)
 * generate working CSS. Without this, var()-based colors silently drop any
 * class that uses an opacity modifier.
 */
const plugin = require('tailwindcss/plugin');

const withAlpha = (variable) =>
  `color-mix(in srgb, var(${variable}) calc(<alpha-value> * 100%), transparent)`;

module.exports = plugin(function () {
  // The plugin itself is a no-op; we only extend the theme below.
}, {
  theme: {
    extend: {
      colors: {
        // === Semantic theme colors (driven by CSS variables) ===
        background:    withAlpha('--mixwork-background'),
        foreground:    withAlpha('--mixwork-foreground'),
        primary: {
          DEFAULT:     withAlpha('--mixwork-primary'),
          foreground:  withAlpha('--mixwork-primary-foreground'),
          hover:       withAlpha('--mixwork-primary-hover'),
          muted:       withAlpha('--mixwork-primary-muted'),
          dark:        withAlpha('--mixwork-primary-hover'),  // backward compat alias
        },
        accent: {
          DEFAULT:     withAlpha('--mixwork-accent'),
          foreground:  withAlpha('--mixwork-accent-foreground'),
        },
        surface: {
          DEFAULT:     withAlpha('--mixwork-surface'),
          foreground:  withAlpha('--mixwork-surface-foreground'),
          raised:      withAlpha('--mixwork-surface-raised'),
          overlay:     withAlpha('--mixwork-surface-overlay'),
          inset:       withAlpha('--mixwork-surface-raised'),  // alias
        },
        border: {
          DEFAULT:     withAlpha('--mixwork-border'),
          subtle:      withAlpha('--mixwork-border-subtle'),
          input:       withAlpha('--mixwork-input-border'),
        },
        muted:         withAlpha('--mixwork-text-muted'),
        destructive: {
          DEFAULT:     withAlpha('--mixwork-destructive'),
          foreground:  withAlpha('--mixwork-destructive-foreground'),
        },
        success:       withAlpha('--mixwork-success'),
        warning:       withAlpha('--mixwork-warning'),

        // === Legacy claude.* aliases (map to --mixwork-* for backward compat) ===
        claude: {
          bg:                withAlpha('--mixwork-background'),
          surface:           withAlpha('--mixwork-surface'),
          surfaceHover:      withAlpha('--mixwork-surface-raised'),
          surfaceMuted:      withAlpha('--mixwork-surface-raised'),
          surfaceInset:      withAlpha('--mixwork-surface-raised'),
          border:            withAlpha('--mixwork-border'),
          borderLight:       withAlpha('--mixwork-border-subtle'),
          text:              withAlpha('--mixwork-text-primary'),
          textSecondary:     withAlpha('--mixwork-text-secondary'),
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            withAlpha('--mixwork-background'),
          darkSurface:       withAlpha('--mixwork-surface'),
          darkSurfaceHover:  withAlpha('--mixwork-surface-raised'),
          darkSurfaceMuted:  withAlpha('--mixwork-surface-raised'),
          darkSurfaceInset:  withAlpha('--mixwork-surface-raised'),
          darkBorder:        withAlpha('--mixwork-border'),
          darkBorderLight:   withAlpha('--mixwork-border-subtle'),
          darkText:          withAlpha('--mixwork-text-primary'),
          darkTextSecondary: withAlpha('--mixwork-text-secondary'),
          // Accent
          accent:            withAlpha('--mixwork-primary'),
          accentHover:       withAlpha('--mixwork-primary-hover'),
          accentLight:       withAlpha('--mixwork-primary'),
          accentMuted:       withAlpha('--mixwork-primary-muted'),
        },
        secondary: {
          DEFAULT: withAlpha('--mixwork-text-secondary'),
          dark:    withAlpha('--mixwork-border'),
        },
      },
      borderRadius: {
        theme: 'var(--mixwork-radius)',
      },
    },
  },
});
