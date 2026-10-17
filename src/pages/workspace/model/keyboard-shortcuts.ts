type KeyboardShortcutEvent = Pick<KeyboardEvent, "metaKey" | "ctrlKey" | "shiftKey" | "key" | "code">;

export function isSidebarToggleShortcut(event: KeyboardShortcutEvent): boolean {
  return (event.metaKey || event.ctrlKey) && event.shiftKey &&
    (event.key === "|" || event.code === "Backslash");
}
