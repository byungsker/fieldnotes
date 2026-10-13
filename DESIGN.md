# Fieldnotes Design System

## 1. Atmosphere & Identity

Fieldnotes is a quiet, local-first writing workspace. The editor should feel steady and legible, with muted surfaces and small, explicit controls. Trust decisions stay visible beside the exact script they apply to; action feedback stays close to the view that caused it.

## 2. Color

| Role | Token | Value | Usage |
|---|---|---:|---|
| Main ink | `--ink` | `#28322e` | App text |
| Muted ink | `--muted` | `#8b918d` | Supporting text |
| Main surface | `--surface` | `#ffffff` | App and editor surfaces |
| Canvas | `--canvas` | `#f7f7f5` | Workspace background |
| Divider | `--line` | `#e7e9e5` | App separators |
| App accent | `--accent` | `#4e765d` | Primary Fieldnotes actions |
| Soft accent | `--accent-soft` | `#eaf1ea` | Selected and supporting states |
| Warm surface | `--warm` | `#f3efea` | Existing warm workspace surface |

The reusable Markdown editor keeps its own established tokens: `--mle-ink: #172033`, `--mle-muted: #667085`, `--mle-border: #d8dee8`, `--mle-surface: #fff`, `--mle-soft: #f6f8fb`, and `--mle-accent: #385d9d`. New editor controls use these tokens.

## 3. Typography

- App: `Avenir Next`, `Apple SD Gothic Neo`, platform sans-serif fallbacks.
- Editor controls inherit the surrounding font; source code uses the existing system monospace stack.
- Preserve the current editor's compact labels and readable body sizes. New explanatory copy must remain at least 14px outside dense metadata.

## 4. Spacing & Layout

- Use a 4px spacing rhythm for new layout values.
- Fieldnotes view blocks remain full-width within the Markdown column, with 12px padding and natural document flow.
- Tables scroll horizontally on narrow screens. Forms wrap and controls remain touch-friendly at the existing 38px mobile minimum.
- The desktop folder tree keeps its own bounded scroll region. Folder creation opens a centered native modal above that shell so the tree remains visible behind the backdrop. The mobile variant stays centered inside the visual viewport.
- The Vault settings dialog has a fixed header and actions around one bounded, independently scrolling server-directory list.

## 5. Components

- **View block:** `.mle-fieldnotes-view-block`, a soft editor surface with a compact heading, status, and content.
- **Trust review:** `.mle-fieldnotes-view-trust` and `.mle-fieldnotes-view-review`; review the exact source before enabling that source fingerprint.
- **Action feedback:** existing `[role="status"]` and `[role="alert"]` messages stay adjacent to the block.
- **Controls:** inherit editor color and typography, use the existing border and surface tokens, and retain visible keyboard focus.
- **Folder creation dialog:** reuse the native `ActionDialog`, centered on desktop and mobile; its backdrop leaves the folder tree visible, and Escape, Cancel, Close, and browser Back share the same cancel path.
- **Recent activity disclosure:** one semantic button controls a `role="region"`; it starts collapsed on every workspace and reveals activity only after a deliberate toggle.
- **Vault settings:** show the absolute path reported by the server. Browse only existing, non-symlink folders under the server Mac's `Documents` directory; verify the target before saving it for the next restart. A path change never moves or deletes files.

## 6. Interaction

- Script trust is scoped to one note, block position, and exact source digest. Source edits require review again.
- A write begins only from a trusted DOM click, submit, or change event and is validated by the host before the API call.
- Create, edit, trash, restore, open-note, and search actions report completion or failure in the originating view.
- Keep actions available by keyboard and touch; no hover-only behavior.
- Folder creation uses a native modal dialog so focus is contained and restored on close. Escape and browser Back cancel without creating a folder.
- Recent Activity is collapsed by default and exposes its state with `aria-expanded` and `aria-controls`.
- A vault target is only saved after server-side validation; the current server path stays active until restart, with no automatic content migration.

## 7. Motion

- Preserve existing application transitions. New trust and CRUD controls use immediate state changes without decorative animation.
- Respect `prefers-reduced-motion` if a future view transition is introduced.

## 8. Accessibility & Accepted Constraints

- Every input has a visible label or an accessible name; controls use semantic button and form elements.
- Status and error text use live regions. Focus remains visible for keyboard users.
- Path verification results and selection errors use live regions. Directory rows have names and explicit button labels; the current absolute server path wraps instead of forcing horizontal page overflow.
- Custom scripts run in an opaque-origin sandbox. The host exposes note metadata and a narrow action bridge, never cookies, host DOM, or arbitrary file access.
- The sandbox intentionally omits remote images, network APIs, external navigation, and arbitrary HTML attributes.
