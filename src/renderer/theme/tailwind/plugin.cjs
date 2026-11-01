/**
 * Tailwind CSS v3 plugin — bridges --mixcwork-* CSS variables into Tailwind utility classes.
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
        background:    withAlpha('--mixcwork-background'),
        foreground:    withAlpha('--mixcwork-foreground'),
        primary: {
          DEFAULT:     withAlpha('--mixcwork-primary'),
          foreground:  withAlpha('--mixcwork-primary-foreground'),
          hover:       withAlpha('--mixcwork-primary-hover'),
          muted:       withAlpha('--mixcwork-primary-muted'),
          dark:        withAlpha('--mixcwork-primary-hover'),  // backward compat alias
        },
        accent: {
          DEFAULT:     withAlpha('--mixcwork-accent'),
          foreground:  withAlpha('--mixcwork-accent-foreground'),
        },
        surface: {
          DEFAULT:     withAlpha('--mixcwork-surface'),
          foreground:  withAlpha('--mixcwork-surface-foreground'),
          raised:      withAlpha('--mixcwork-surface-raised'),
          overlay:     withAlpha('--mixcwork-surface-overlay'),
          inset:       withAlpha('--mixcwork-surface-raised'),  // alias
        },
        border: {
          DEFAULT:     withAlpha('--mixcwork-border'),
          subtle:      withAlpha('--mixcwork-border-subtle'),
          input:       withAlpha('--mixcwork-input-border'),
        },
        muted:         withAlpha('--mixcwork-text-muted'),
        destructive: {
          DEFAULT:     withAlpha('--mixcwork-destructive'),
          foreground:  withAlpha('--mixcwork-destructive-foreground'),
        },
        success:       withAlpha('--mixcwork-success'),
        warning:       withAlpha('--mixcwork-warning'),

        // === Legacy claude.* aliases (map to --mixcwork-* for backward compat) ===
        claude: {
          bg:                withAlpha('--mixcwork-background'),
          surface:           withAlpha('--mixcwork-surface'),
          surfaceHover:      withAlpha('--mixcwork-surface-raised'),
          surfaceMuted:      withAlpha('--mixcwork-surface-raised'),
          surfaceInset:      withAlpha('--mixcwork-surface-raised'),
          border:            withAlpha('--mixcwork-border'),
          borderLight:       withAlpha('--mixcwork-border-subtle'),
          text:              withAlpha('--mixcwork-text-primary'),
          textSecondary:     withAlpha('--mixcwork-text-secondary'),
          // dark.* aliases point to the same vars — theme handles light/dark
          darkBg:            withAlpha('--mixcwork-background'),
          darkSurface:       withAlpha('--mixcwork-surface'),
          darkSurfaceHover:  withAlpha('--mixcwork-surface-raised'),
          darkSurfaceMuted:  withAlpha('--mixcwork-surface-raised'),
          darkSurfaceInset:  withAlpha('--mixcwork-surface-raised'),
          darkBorder:        withAlpha('--mixcwork-border'),
          darkBorderLight:   withAlpha('--mixcwork-border-subtle'),
          darkText:          withAlpha('--mixcwork-text-primary'),
          darkTextSecondary: withAlpha('--mixcwork-text-secondary'),
          // Accent
          accent:            withAlpha('--mixcwork-primary'),
          accentHover:       withAlpha('--mixcwork-primary-hover'),
          accentLight:       withAlpha('--mixcwork-primary'),
          accentMuted:       withAlpha('--mixcwork-primary-muted'),
        },
        secondary: {
          DEFAULT: withAlpha('--mixcwork-text-secondary'),
          dark:    withAlpha('--mixcwork-border'),
        },
      },
      borderRadius: {
        theme: 'var(--mixcwork-radius)',
      },
    },
  },
});
