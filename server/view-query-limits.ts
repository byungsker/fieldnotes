export const MAX_VIEW_TRASH_CANDIDATES = 100;
export const MAX_VIEW_TRASH_BYTES = 20_000_000;
export const VIEW_TRASH_LIMIT_MESSAGE = "The trash view would read more than 20 MB. Narrow the view or remove older trash entries.";

export class ViewQueryLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ViewQueryLimitError";
  }
}
