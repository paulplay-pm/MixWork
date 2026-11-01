/**
 * Token Contract — defines all semantic variables a theme must provide.
 *
 * Naming: --mixwork-{category}-{name}
 * Convention: shadcn/ui background/foreground pairing + Radix 12-step gray scale
 *
 * Every theme (ThemeDefinition.tokens) must supply a value for each key.
 */
export const TOKEN_CONTRACT = {
  // ── Brand ──
  'primary':            '--mixwork-primary',
  'primary-foreground': '--mixwork-primary-foreground',
  'primary-hover':      '--mixwork-primary-hover',
  'primary-muted':      '--mixwork-primary-muted',

  // ── Accent ──
  'accent':             '--mixwork-accent',
  'accent-foreground':  '--mixwork-accent-foreground',

  // ── Surface / Background ──
  'background':         '--mixwork-background',
  'foreground':         '--mixwork-foreground',
  'surface':            '--mixwork-surface',
  'surface-foreground': '--mixwork-surface-foreground',
  'surface-raised':     '--mixwork-surface-raised',
  'surface-overlay':    '--mixwork-surface-overlay',

  // ── Chat bubbles ──
  'chat-user':              '--mixwork-chat-user',
  'chat-user-foreground':   '--mixwork-chat-user-foreground',
  'chat-bot':               '--mixwork-chat-bot',
  'chat-bot-foreground':    '--mixwork-chat-bot-foreground',

  // ── Text hierarchy ──
  'text-primary':       '--mixwork-text-primary',
  'text-secondary':     '--mixwork-text-secondary',
  'text-muted':         '--mixwork-text-muted',

  // ── Borders ──
  'border':             '--mixwork-border',
  'border-subtle':      '--mixwork-border-subtle',
  'input-border':       '--mixwork-input-border',

  // ── Scrollbar ──
  'scroll-thumb':       '--mixwork-scroll-thumb',
  'scroll-thumb-hover': '--mixwork-scroll-thumb-hover',

  // ── Decorative gradients ──
  'gradient-1':         '--mixwork-gradient-1',
  'gradient-2':         '--mixwork-gradient-2',

  // ── Status ──
  'destructive':            '--mixwork-destructive',
  'destructive-foreground': '--mixwork-destructive-foreground',
  'success':                '--mixwork-success',
  'warning':                '--mixwork-warning',

  // ── Gray scale 11 steps (gray-1=lightest → gray-11=darkest, all themes) ──
  'gray-1':  '--mixwork-gray-1',
  'gray-2':  '--mixwork-gray-2',
  'gray-3':  '--mixwork-gray-3',
  'gray-4':  '--mixwork-gray-4',
  'gray-5':  '--mixwork-gray-5',
  'gray-6':  '--mixwork-gray-6',
  'gray-7':  '--mixwork-gray-7',
  'gray-8':  '--mixwork-gray-8',
  'gray-9':  '--mixwork-gray-9',
  'gray-10': '--mixwork-gray-10',
  'gray-11': '--mixwork-gray-11',

  // ── Radius ──
  'radius':  '--mixwork-radius',
} as const;

export type TokenName = keyof typeof TOKEN_CONTRACT;
export type CSSVarName = (typeof TOKEN_CONTRACT)[TokenName];

/** All token keys as an array */
export const TOKEN_NAMES = Object.keys(TOKEN_CONTRACT) as TokenName[];
