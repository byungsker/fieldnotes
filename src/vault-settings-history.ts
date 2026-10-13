type MutableRef<T> = { current: T };

type VaultSettingsHistory = Pick<History, "state" | "pushState">;

export function pushVaultSettingsHistoryEntry(
  history: VaultSettingsHistory,
  entryRef: MutableRef<boolean>,
  currentUrl: string,
): void {
  if (entryRef.current) return;

  const currentState = history.state;
  const base = typeof currentState === "object" && currentState !== null && !Array.isArray(currentState)
    ? currentState as Record<string, unknown>
    : {};
  history.pushState({ ...base, fieldnotesVaultSettings: true }, "", currentUrl);
  entryRef.current = true;
}
