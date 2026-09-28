/**
 * Keyboard routing helper: when the event target lives inside a text field
 * (the always-editable card, an input, a textarea), shortcuts like
 * `1/2/3` or space must go to the text instead of the review actions.
 */
export function isTextEntryTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el || typeof el.closest !== "function") return false;
  return Boolean(el.closest('[contenteditable="true"], textarea, input, select'));
}
