export const CoworkUiEvent = {
  OpenShareOptions: 'mixwork:open-share-options',
  SelectSubagent: 'mixwork:select-subagent',
  FocusInput: 'mixwork:focus-input',
  ShortcutSearch: 'mixwork:shortcut:search',
  ShortcutConversationSearch: 'mixwork:shortcut:conversation-search',
  ShortcutNewSession: 'mixwork:shortcut:new-session',
  ShortcutStopSession: 'mixwork:shortcut:stop-session',
  ShortcutToggleArtifacts: 'mixwork:shortcut:toggle-artifacts',
  ShortcutSwitchAgent: 'mixwork:shortcut:switch-agent',
  ShortcutShowCurrentAgentTasks: 'mixwork:shortcut:show-current-agent-tasks',
  ShortcutCollapseCurrentAgentTasks: 'mixwork:shortcut:collapse-current-agent-tasks',
  ShortcutOpenAgentTaskSlot: 'mixwork:shortcut:open-agent-task-slot',
} as const;

export type CoworkUiEvent = typeof CoworkUiEvent[keyof typeof CoworkUiEvent];

export const CoworkTaskSearchRequestSource = {
  SidebarHeader: 'sidebar_header',
  WindowsTitleBar: 'windows_title_bar',
  KeyboardShortcut: 'keyboard_shortcut',
  UiEvent: 'ui_event',
} as const;

export type CoworkTaskSearchRequestSource =
  typeof CoworkTaskSearchRequestSource[keyof typeof CoworkTaskSearchRequestSource];

export interface CoworkTaskSearchRequestEventDetail {
  source?: CoworkTaskSearchRequestSource;
}

export const CoworkShortcutDirection = {
  Previous: 'previous',
  Next: 'next',
} as const;

export type CoworkShortcutDirection =
  typeof CoworkShortcutDirection[keyof typeof CoworkShortcutDirection];

export interface CoworkOpenShareOptionsEventDetail {
  sessionId: string;
}

export type CoworkSwitchAgentEventDetail = {
  direction: CoworkShortcutDirection;
};

export type CoworkOpenAgentTaskSlotEventDetail = {
  slot: number;
};
