/**
 * Token Contract — defines all semantic variables a theme must provide.
 *
 * Naming: --mixcwork-{category}-{name}
 * Convention: shadcn/ui background/foreground pairing + Radix 12-step gray scale
 *
 * Every theme (ThemeDefinition.tokens) must supply a value for each key.
 */
export const TOKEN_CONTRACT = {
  // ── Brand ──
  'primary':            '--mixcwork-primary',
  'primary-foreground': '--mixcwork-primary-foreground',
  'primary-hover':      '--mixcwork-primary-hover',
  'primary-muted':      '--mixcwork-primary-muted',

  // ── Accent ──
  'accent':             '--mixcwork-accent',
  'accent-foreground':  '--mixcwork-accent-foreground',

  // ── Surface / Background ──
  'background':         '--mixcwork-background',
  'foreground':         '--mixcwork-foreground',
  'surface':            '--mixcwork-surface',
  'surface-foreground': '--mixcwork-surface-foreground',
  'surface-raised':     '--mixcwork-surface-raised',
  'surface-overlay':    '--mixcwork-surface-overlay',

  // ── Chat bubbles ──
  'chat-user':              '--mixcwork-chat-user',
  'chat-user-foreground':   '--mixcwork-chat-user-foreground',
  'chat-bot':               '--mixcwork-chat-bot',
  'chat-bot-foreground':    '--mixcwork-chat-bot-foreground',

  // ── Text hierarchy ──
  'text-primary':       '--mixcwork-text-primary',
  'text-secondary':     '--mixcwork-text-secondary',
  'text-muted':         '--mixcwork-text-muted',

  // ── Borders ──
  'border':             '--mixcwork-border',
  'border-subtle':      '--mixcwork-border-subtle',
  'input-border':       '--mixcwork-input-border',

  // ── Scrollbar ──
  'scroll-thumb':       '--mixcwork-scroll-thumb',
  'scroll-thumb-hover': '--mixcwork-scroll-thumb-hover',

  // ── Decorative gradients ──
  'gradient-1':         '--mixcwork-gradient-1',
  'gradient-2':         '--mixcwork-gradient-2',

  // ── Status ──
  'destructive':            '--mixcwork-destructive',
  'destructive-foreground': '--mixcwork-destructive-foreground',
  'success':                '--mixcwork-success',
  'warning':                '--mixcwork-warning',

  // ── Gray scale 11 steps (gray-1=lightest → gray-11=darkest, all themes) ──
  'gray-1':  '--mixcwork-gray-1',
  'gray-2':  '--mixcwork-gray-2',
  'gray-3':  '--mixcwork-gray-3',
  'gray-4':  '--mixcwork-gray-4',
  'gray-5':  '--mixcwork-gray-5',
  'gray-6':  '--mixcwork-gray-6',
  'gray-7':  '--mixcwork-gray-7',
  'gray-8':  '--mixcwork-gray-8',
  'gray-9':  '--mixcwork-gray-9',
  'gray-10': '--mixcwork-gray-10',
  'gray-11': '--mixcwork-gray-11',

  // ── Radius ──
  'radius':  '--mixcwork-radius',
} as const;

export type TokenName = keyof typeof TOKEN_CONTRACT;
export type CSSVarName = (typeof TOKEN_CONTRACT)[TokenName];

/** All token keys as an array */
export const TOKEN_NAMES = Object.keys(TOKEN_CONTRACT) as TokenName[];
