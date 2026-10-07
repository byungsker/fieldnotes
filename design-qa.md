# Mobile document redesign QA

## References and captures

- Reference images: `../.private-materialized-screenshots/IMG_5691.png` and `../.private-materialized-screenshots/IMG_5692.png` (each 942 × 2048 px). They were materialized through the Library workflow, viewed, and kept outside the repository.
- Synthetic implementation captures: `../.private-materialized-screenshots/fieldnotes-mobile-synthetic-390x844.png` and `../.private-materialized-screenshots/fieldnotes-mobile-synthetic-scroll-390x844.png` (390 × 844 px).
- Final side-by-side comparisons: `../.private-materialized-screenshots/notion-fieldnotes-comparison-780x844.png` and `../.private-materialized-screenshots/notion-scroll-fieldnotes-comparison-780x844.png` (780 × 844 px). The reference images were scaled to 390 px wide and center-cropped by 4 px vertically for an exact 390 × 844 comparison pane.
- Browser: isolated headless Chrome, mobile emulation, CSS viewport 390 × 844, device scale factor 1. Synthetic Fieldnotes data and a temporary SQLite database under `/tmp` were used. No source library data or note bodies were imported.

## Result

**passed** — no actionable P0, P1, or P2 visual defects remain in the reviewed mobile document screens.

The top-of-document comparison matches the reference's compact pinned title context, large heading, icon-led property rows, muted labels, thin divider, dark surface, and comfortable body spacing. The scrolled comparison keeps the title and action bar pinned while the note body scrolls. Fieldnotes uses its own status, folder, version, save, write, preview, and delete controls; these preserve the app's existing functions while following the reference's compact document hierarchy. Desktop continues to use the existing non-Stackflow workspace.

## Reviewed surfaces

- **Typography:** Mobile title is approximately 34 px; body is 17 px with about 29 px line height. Labels and dates stay subordinate and legible.
- **Spacing and layout:** Property labels align with values, the metadata divider clearly separates the body, the title/action toolbar stays pinned during document scroll, and the 390 px viewport has no horizontal overflow.
- **Colors and tokens:** The default dark surface and muted text follow the existing theme. The reference and implementation use a similar near-black canvas, soft white body text, and low-contrast secondary labels. Light mode continues to use existing theme tokens.
- **Images and assets:** The document view uses the existing Lucide icon package. No new image asset or dependency was added.
- **Content and copy:** The preview and edit views were populated with a synthetic Korean note covering paragraphs, a heading, bullets, a wikilink, and a callout. App-specific labels remain unchanged.

## Interaction and runtime checks

- Preview opens by default; Write and Preview controls switch modes.
- `⌘E` switches to Write and back to Preview.
- The mobile folder context remains visible under the document title.
- A 1280 × 900 viewport renders the existing desktop workspace directly, without the mobile Stackflow shell.
- The isolated browser reported zero console messages for the app URL and zero runtime exceptions.
- Chrome emulation was used. A physical iPhone and Safari were not available for verification.

## Iteration notes

The first review found the folder context hidden by a generic mobile rule; the document-specific rule was corrected and the view captured again. The initial synthetic note did not scroll far enough to compare the compact pinned header, so it was extended with generic synthetic paragraphs and recaptured. The final top and scrolled comparison images above were reviewed together at equal viewport dimensions.

## 2026-10-07 search, properties, and panel QA

- Four additional Library reference screenshots were materialized through the private Library workflow and viewed. They showed the duplicate search clear affordance, the visible `Search: …` query tag, frontmatter text leaking into excerpts, and the mobile note property/toolbar layout. The source images remain outside this repository.
- QA ran in a fresh Chrome profile against an isolated loopback Vite/API pair and a temporary synthetic SQLite database under `/tmp`; it did not open or write the production database. The synthetic note included Korean, English, punctuation, raw HTML text, and YAML frontmatter.
- The desktop Notes list collapsed independently from the folder sidebar, expanded editor width from 882 px to 1212 px, survived reload, and reopened through an accessible control. The folder sidebar remained collapsed when reopening the note list.
- Browser search tests found and highlighted Korean, English, and punctuation literally; the query tag was absent; the custom clear button cleared search and keyboard insertion still edited the input. The single visible clear affordance was captured; temporarily hiding the custom button left no native X visible.
- Folder filtering returned only the synthetic note in its selected folder. Search snippets centered a mid-body match and omitted YAML fields. The raw note body including frontmatter remained unchanged.
- Desktop and mobile note views shared Status, Created, Folder, Updated, and Version properties. Mobile screenshots were reviewed at 320, 360, and 390 px; note and list views had no horizontal page overflow. Write, Preview, Save, and Delete targets measured 44 × 44 px at 390 px; Write/Preview/Save labels were visually hidden while accessible names remained. The toolbar stayed sticky at top 0 and the document editor had 36 px top padding.
- Date unit tests cover 23 h 59 min versus exactly 24 h, Korean calendar formatting across UTC midnight, and invalid timestamps. Lint, typecheck, and the isolated integration suite passed (35 tests). The visual browser was Chrome emulation; physical iPhone Safari was not tested.

Synthetic captures are kept outside Git under `/tmp/fieldnotes-qa-*`; no reference or user-data images were added to the repository.
