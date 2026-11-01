import { describe, expect, test, vi } from 'vitest';

import { handlePasswordEnter, handleUsernameEnter, passwordValueAfterHandoff } from './loginEnterFlow';

const makeEvent = (key = 'Enter') => {
  const preventDefault = vi.fn();
  return { event: { key, preventDefault }, preventDefault };
};

const makeDeps = (busy = false) => ({
  busy,
  focusPassword: vi.fn(),
  submit: vi.fn(),
});

describe('loginEnterFlow', () => {
  test('Enter in the username field moves focus to the password field', () => {
    const { event, preventDefault } = makeEvent();
    const deps = makeDeps();

    const handled = handleUsernameEnter(event, deps);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.focusPassword).toHaveBeenCalledTimes(1);
    // Advancing must never fire a login request.
    expect(deps.submit).not.toHaveBeenCalled();
  });

  test('Enter in the password field submits', () => {
    const { event, preventDefault } = makeEvent();
    const deps = makeDeps();

    const handled = handlePasswordEnter(event, deps);

    expect(handled).toBe(true);
    expect(preventDefault).toHaveBeenCalledTimes(1);
    expect(deps.submit).toHaveBeenCalledTimes(1);
    expect(deps.focusPassword).not.toHaveBeenCalled();
  });

  test('a key other than Enter is left alone', () => {
    const { event, preventDefault } = makeEvent('a');
    const deps = makeDeps();

    expect(handleUsernameEnter(event, deps)).toBe(false);
    expect(handlePasswordEnter(event, deps)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(deps.focusPassword).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });

  test('Enter is ignored while a login request is in flight', () => {
    const { event, preventDefault } = makeEvent();
    const deps = makeDeps(true);

    expect(handleUsernameEnter(event, deps)).toBe(false);
    expect(handlePasswordEnter(event, deps)).toBe(false);
    expect(preventDefault).not.toHaveBeenCalled();
    expect(deps.focusPassword).not.toHaveBeenCalled();
    expect(deps.submit).not.toHaveBeenCalled();
  });
});

describe('passwordValueAfterHandoff', () => {
  test('the username the browser dropped into the password box is cleared', () => {
    // Chromium's password manager fills a password field the moment it gains
    // focus, writing straight into the DOM where React never sees it. Nothing
    // was typed there, so the handoff clears it.
    expect(passwordValueAfterHandoff('alice', 'alice')).toBe('');
  });

  test("a password the admin typed is left alone", () => {
    // Clearing on every handoff would eat a real password whenever the admin
    // goes back to fix the username.
    expect(passwordValueAfterHandoff('s3cret-pw', 'alice')).toBeNull();
  });

  test('an empty password box needs no change', () => {
    expect(passwordValueAfterHandoff('', 'alice')).toBeNull();
    expect(passwordValueAfterHandoff('', '')).toBeNull();
  });

  test('an empty username never matches, so typing a password first is safe', () => {
    expect(passwordValueAfterHandoff('alice', '')).toBeNull();
  });
});
