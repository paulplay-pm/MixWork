import type { JSX } from 'react';

/** Member avatar: the surname's first character on a stable tint.
 *
 * Shared by the member table and the drawer so the same person is the same
 * colour in both. Deterministic from `seed` (the user id) rather than
 * positional: React keys change, and a member's tint that shifted when the
 * sort flipped would read as a different person.
 *
 * NOTE: the brief asks for a "role-coloured" circle, but the usage payloads
 * carry no role field — `/admin/usage/users` returns user_id, username,
 * display_name, department_name, total_tokens and last_used_at only, and the
 * detail endpoint adds nothing else. Joining the role catalog would cost a
 * request per row. The tint is therefore derived from the id: visually the
 * same idea (each member has their own colour), without a claim the data does
 * not support. */
const TINTS = ['#3b82f6', '#0f766e', '#b45309', '#7c3aed', '#dc2626', '#0ea5e9', '#16a34a', '#db2777'];

/** The leading character of the display name, falling back to the username.
 *  `Array.from` so a name starting with an astral character (an emoji, a rare
 *  CJK glyph) is not cut in half into a lone surrogate. */
export function memberInitial(displayName: string | null, username: string): string {
  const src = displayName?.trim() || username;
  return Array.from(src)[0]?.toUpperCase() ?? '?';
}

/** Stable tint for a user id. */
function tintFor(userId: string): string {
  let h = 0;
  for (let i = 0; i < userId.length; i += 1) h = (h * 31 + userId.charCodeAt(i)) >>> 0;
  return TINTS[h % TINTS.length];
}

interface Props {
  userId: string;
  displayName: string | null;
  username: string;
  /** px; the drawer uses a larger one. */
  size?: number;
}

export function MemberAvatar({ userId, displayName, username, size = 28 }: Props): JSX.Element {
  return (
    <span
      aria-hidden
      className="flex shrink-0 items-center justify-center rounded-full font-semibold text-white"
      style={{ width: size, height: size, background: tintFor(userId), fontSize: size / 2 }}
    >
      {memberInitial(displayName, username)}
    </span>
  );
}