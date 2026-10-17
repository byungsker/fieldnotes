const DAY_MS = 24 * 60 * 60 * 1000;

export function formatDocumentDate(value: string, now = Date.now()): string {
  const date = new Date(value);
  const timestamp = date.getTime();
  if (!Number.isFinite(timestamp)) return "Unknown";

  const elapsed = now - timestamp;
  if (Math.abs(elapsed) >= DAY_MS) {
    return new Intl.DateTimeFormat("ko-KR", {
      year: "numeric",
      month: "long",
      day: "numeric",
      timeZone: "Asia/Seoul",
    }).format(date);
  }

  const minutes = Math.floor(Math.abs(elapsed) / 60_000);
  if (minutes < 1) return elapsed < 0 ? "in a moment" : "just now";
  if (minutes < 60) return elapsed < 0 ? `in ${minutes}m` : `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return elapsed < 0 ? `in ${hours}h` : `${hours}h ago`;
}
