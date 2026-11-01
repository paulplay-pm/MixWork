/**
 * Keyboard flow of the enterprise login form.
 *
 * Enter advances through the form instead of submitting it from every
 * field: in the username field it moves focus to the password field, and in
 * the password field it submits — so a half-typed username can never fire a
 * login request the user never meant to make.
 *
 * The org field keeps its own Enter behavior (submit); it is a context
 * picker, not a step in the credential flow.
 */

/** The subset of a keyboard event this module needs — keeps it testable
 *  without a DOM. */
export interface LoginEnterEvent {
  key: string;
  preventDefault: () => void;
}

export interface LoginEnterDeps {
  /** A login request is already in flight — Enter is ignored. */
  busy: boolean;
  /** Move focus into the password field. */
  focusPassword: () => void;
  /** Run the login. */
  submit: () => void;
}

/**
 * Enter in the username field: advance to the password field.
 *
 * Returns true when the event was handled (and `preventDefault` was called),
 * false when the caller should leave the event alone.
 */
export const handleUsernameEnter = (
  event: LoginEnterEvent,
  deps: LoginEnterDeps,
): boolean => {
  if (event.key !== 'Enter' || deps.busy) return false;
  event.preventDefault();
  deps.focusPassword();
  return true;
};

/** Enter in the password field: submit the login. */
export const handlePasswordEnter = (
  event: LoginEnterEvent,
  deps: LoginEnterDeps,
): boolean => {
  if (event.key !== 'Enter' || deps.busy) return false;
  event.preventDefault();
  deps.submit();
  return true;
};

/**
 * The value the password box must be left with once focus has landed in it.
 *
 * Returns the value to set when the box should be cleared, and null when it
 * must be left alone. Chromium's password manager decides by itself which
 * fields make up a login pair and fills the field it pairs as soon as that
 * field gains focus — writing straight into the DOM, where React never sees
 * it. When it gets the pairing wrong (this form has no <form> element), the
 * username lands in the password box and the admin ends up typing their
 * password on top of text they never put there. The box only ever holds what
 * was typed into it, so a value matching the username is not a password.
 *
 * Clearing on EVERY handoff would be simpler and wrong: an admin who goes back
 * to fix the username would find the password they already typed gone.
 */
export const passwordValueAfterHandoff = (
  fieldValue: string,
  username: string,
): string | null => {
  if (!fieldValue) return null;
  if (!username) return null;
  return fieldValue === username ? '' : null;
};
