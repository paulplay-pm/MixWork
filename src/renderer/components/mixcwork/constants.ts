export const CoworkUiEvent = {
  OpenShareOptions: 'mixcwork:open-share-options',
  SelectSubagent: 'mixcwork:select-subagent',
  FocusInput: 'mixcwork:focus-input',
  ShortcutSearch: 'mixcwork:shortcut:search',
  ShortcutConversationSearch: 'mixcwork:shortcut:conversation-search',
  ShortcutNewSession: 'mixcwork:shortcut:new-session',
  ShortcutStopSession: 'mixcwork:shortcut:stop-session',
  ShortcutToggleArtifacts: 'mixcwork:shortcut:toggle-artifacts',
  ShortcutSwitchAgent: 'mixcwork:shortcut:switch-agent',
  ShortcutShowCurrentAgentTasks: 'mixcwork:shortcut:show-current-agent-tasks',
  ShortcutCollapseCurrentAgentTasks: 'mixcwork:shortcut:collapse-current-agent-tasks',
  ShortcutOpenAgentTaskSlot: 'mixcwork:shortcut:open-agent-task-slot',
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
