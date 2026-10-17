import { randomUUID } from "node:crypto";
import type { ChangeRecord } from "../types.js";
import type { KnowledgeDatabase } from "./context.js";
import { insertChange, publishSafely } from "./changes.js";

export function seedDatabase(database: KnowledgeDatabase, seedDemo: boolean): void {
  const seeded = database.db.prepare("SELECT value FROM app_meta WHERE key = 'initial_seed'").get();
  if (seeded) return;

  if (!seedDemo) {
    database.db.prepare("INSERT INTO app_meta (key, value) VALUES ('initial_seed', 'skipped')").run();
    return;
  }

  const samples = [
    {
      title: "Welcome to Fieldnotes",
      body: "# A quiet place for your ideas\n\nThis is a small demo notebook. Write in Markdown, connect thoughts with `[[wikilinks]]`, and let every saved note stay on this Mac.\n\n## A few ways to begin\n\n- Capture a thought before it slips away\n- Link a note with `[[Reading list]]`\n- Search across titles and full text\n\n> Your real vault is not imported. These notes are examples you can edit or delete.",
    },
    {
      title: "Reading list",
      body: "# Reading list\n\nA running shelf for things worth returning to.\n\n## Next up\n\n- Write down one idea from the next book or article\n- Add a link from a related note with `[[Welcome to Fieldnotes]]`\n\nKeep this list light enough to use.",
    },
    {
      title: "Small experiments",
      body: "# Small experiments\n\nA place to record little questions and what happens when you test them.\n\n### This week\n\nTry leaving one useful sentence at the end of a work session. Future-you gets a gentler starting point.",
    },
  ];

  const changes: ChangeRecord[] = [];
  database.db.exec("BEGIN IMMEDIATE");
  try {
    for (const sample of samples) {
      const id = randomUUID();
      const timestamp = new Date().toISOString();
      database.db
        .prepare("INSERT INTO documents (id, title, body, created_at, updated_at, version) VALUES (?, ?, ?, ?, ?, 1)")
        .run(id, sample.title, sample.body, timestamp, timestamp);
      changes.push(insertChange(database.db, id, sample.title, "created", 1, timestamp));
    }
    database.db.prepare("INSERT INTO app_meta (key, value) VALUES ('initial_seed', 'demo')").run();
    database.db.exec("COMMIT");
  } catch (error) {
    database.db.exec("ROLLBACK");
    throw error;
  }
  for (const change of changes) publishSafely(database.changes, change);
}
