import { useCallback, useState } from 'react';

import type { SectionDraft } from './ModelTypeSection';

export interface ProviderCardDrafts {
  /** The card's display name. */
  label: string;
  /** The vendor id (slug). Only a card that does not exist yet can change it:
   * it picks the default Base URL and is part of the qualified model id. */
  slug: string;
  /** The per-section drafts, keyed by the section's provider key id (or, for
   * a tab that is not configured yet, by the placeholder key `draft-<tab>`). */
  sections: Record<string, SectionDraft>;
}

export interface UseProviderCardDrafts {
  drafts: ProviderCardDrafts;
  /** Replace the whole draft (used when the selection changes). */
  reset: (draft: Partial<ProviderCardDrafts>) => void;
  setLabel: (label: string) => void;
  setSlug: (slug: string) => void;
  setSectionDraft: (key: string, draft: SectionDraft) => void;
  /** Merge a patch into one section's draft, when the server has already
   * applied the change (a protocol switch) and a save in the refetch window
   * must not resend the pre-change value. A section with no draft yet is left
   * alone: nothing has been pushed up for it. */
  patchSectionDraft: (key: string, patch: Partial<SectionDraft>) => void;
}

const EMPTY: ProviderCardDrafts = { label: '', slug: '', sections: {} };

/**
 * The in-progress edits of ONE selected card.
 *
 * The card pushes its name and each section's field values up as the admin
 * types; the page's single save button reads this state instead of the stored
 * rows, so a save always carries the admin's in-progress edits.
 */
export function useProviderCardDrafts(initial?: Partial<ProviderCardDrafts>): UseProviderCardDrafts {
  const [drafts, setDrafts] = useState<ProviderCardDrafts>({ ...EMPTY, ...initial });

  const reset = useCallback((next: Partial<ProviderCardDrafts>) => {
    setDrafts({ ...EMPTY, ...next });
  }, []);

  const setLabel = useCallback((label: string) => {
    setDrafts((prev) => ({ ...prev, label }));
  }, []);

  const setSlug = useCallback((slug: string) => {
    setDrafts((prev) => ({ ...prev, slug }));
  }, []);

  // Merge, not replace: each section owns its own entry.
  const setSectionDraft = useCallback((key: string, draft: SectionDraft) => {
    setDrafts((prev) => {
      const cur = prev.sections[key];
      if (
        cur
        && cur.baseUrl === draft.baseUrl
        && cur.codingPlan === draft.codingPlan
        && cur.apiKey === draft.apiKey
        && cur.protocol === draft.protocol
      ) {
        return prev;
      }
      return { ...prev, sections: { ...prev.sections, [key]: draft } };
    });
  }, []);

  const patchSectionDraft = useCallback((key: string, patch: Partial<SectionDraft>) => {
    setDrafts((prev) => {
      const cur = prev.sections[key];
      if (!cur) return prev;
      return { ...prev, sections: { ...prev.sections, [key]: { ...cur, ...patch } } };
    });
  }, []);

  return { drafts, reset, setLabel, setSlug, setSectionDraft, patchSectionDraft };
}
