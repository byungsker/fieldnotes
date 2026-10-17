import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  buildDailyRecordBody,
  calculateAgeFromBirthday,
  calculateAgeOnDate,
  firstLocalImageReference,
  localImageReferences,
  normalizeRecordDate,
  openOrCreateDailyRecord,
  parseSafeBabyFrontmatter,
  pngFallbackReference,
  readBabySourceSettings,
} from "../../src/pages/workspace/model/baby-records.ts";
import { BabiesDataview } from "../../src/pages/workspace/ui/BabiesDataview.tsx";
import { BabiesPreviewDocumentsContext } from "../../src/pages/workspace/ui/BabiesPreviewContext.ts";

void React;

test("parses the simple frontmatter structures used by local baby records and schedules", () => {
  const fixture = [
    "---",
    "type: daily",
    "date: 2026-10-14",
    "age_days: 42",
    "age_str: 6 weeks",
    "milestones:",
    "  - 'Child A: smiles at a toy'",
    "  - child: Child B",
    "    milestone: rolls over",
    "goals: [more naps, outside time]",
    "rules:",
    "  start: 07:30",
    "  quiet: true",
    "schedule:",
    "  - time: 08:15",
    "    label: Morning nap",
    "    type: nap",
    "    duration: 90 minutes",
    "---",
    "# This body is not frontmatter",
  ].join("\n");
  const parsed = parseSafeBabyFrontmatter(fixture);

  assert.equal(parsed.type, "daily");
  assert.equal(parsed.date, "2026-10-14");
  assert.equal(parsed.age_days, 42);
  assert.deepEqual(parsed.milestones, [
    "Child A: smiles at a toy",
    { child: "Child B", milestone: "rolls over" },
  ]);
  assert.deepEqual(parsed.goals, ["more naps", "outside time"]);
  assert.deepEqual(parsed.rules, { start: "07:30", quiet: true });
  assert.deepEqual(parsed.schedule, [{ time: "08:15", label: "Morning nap", type: "nap", duration: "90 minutes" }]);
  assert.equal("This body is not frontmatter" in parsed, false);
});

test("does not treat fenced script-like content as frontmatter", () => {
  const parsed = parseSafeBabyFrontmatter("---\ntype: daily\n---\n```dataviewjs\nthrow new Error('must stay inert')\n```");
  assert.deepEqual(parsed, { type: "daily" });
});

test("derives age from local calendar dates", () => {
  assert.deepEqual(calculateAgeOnDate("2025-10-14", "2025-10-12", 42), {
    totalDays: 44,
    months: 1,
    dayOfMonth: 14,
    text: "1개월 14일",
  });
  assert.equal(calculateAgeOnDate("2025-08-31", "2025-09-01", 1), null);
  assert.equal(calculateAgeOnDate("2025-02-30", "2025-09-01", 1), null);
});

test("uses the static birthday and template from a baby source without executing its code", () => {
  const dollar = String.fromCharCode(36);
  const tick = String.fromCharCode(96);
  const template = "# " + dollar + "{dateStr}\nAge " + dollar + "{age.str} (" + dollar + "{months} months, " + dollar + "{days + 1} days; " + dollar + "{age.totalDays + 1} total)";
  const source = [
    "const BIRTHDAY = new Date(2025, 9, 12);",
    "const GIRL_SHORT = 'Child A';",
    "const GIRL_NAME = 'Child A Full';",
    "const BOY_SHORT = 'Child B';",
    "const BOY_NAME = 'Child B Full';",
    "titleEl.textContent = 'Child diary';",
    "app.vault.getAbstractFileByPath('images/hero.jpg');",
    "note.innerHTML = 'Nap note.<br><strong>Watch cues</strong>';",
    "function buildFileContent(dateStr, age) { return " + tick + template + tick + "; }",
    "throw new Error('this code remains inert');",
  ].join("\n");
  const settings = readBabySourceSettings(source);

  assert.equal(settings.birthday, "2025-10-12");
  assert.equal(settings.photoPath, "images/hero.jpg");
  assert.equal(settings.dashboardTitle, "Child diary");
  assert.equal(settings.girlLabel, "Child A");
  assert.equal(settings.boyLabel, "Child B");
  assert.equal(settings.scheduleAdvice, "Nap note.\nWatch cues");

  const exactAge = calculateAgeFromBirthday("2025-10-14", settings.birthday ?? "");
  const estimatedAge = calculateAgeOnDate("2025-10-14", "2025-10-12", 42);
  assert.equal(exactAge?.totalDays, 3);
  assert.equal((estimatedAge?.totalDays ?? 0) - (exactAge?.totalDays ?? 0), 41);
  assert.equal(
    buildDailyRecordBody("2025-10-14", exactAge, source),
    "# 2025-10-14\nAge 0개월 3일 (0 months, 3 days; 3 total)",
  );
});

test("finds only safe local raster images outside code blocks", () => {
  const tick = String.fromCharCode(96);
  assert.equal(firstLocalImageReference("A moment: ![[photos/day.jpg|width=400]]"), "photos/day.jpg");
  assert.equal(firstLocalImageReference("![Moment](photos/day.webp)"), "photos/day.webp");
  assert.deepEqual(localImageReferences("![Moment](<photos/day with spaces.webp>)"), ["photos/day with spaces.webp"]);
  assert.deepEqual(localImageReferences("![[../assets/cover.png]]", "reading/note.md"), ["assets/cover.png"]);
  assert.deepEqual(localImageReferences("![[../../outside/cover.png]]", "reading/note.md"), []);
  assert.equal(firstLocalImageReference(tick + "![[photos/inline.png]]" + tick), null);
  assert.equal(firstLocalImageReference(tick + tick + tick + "md\n![[photos/fenced.png]]\n" + tick + tick + tick), null);
  assert.equal(firstLocalImageReference("![[https://example.test/photo.jpg]]"), null);
  assert.equal(firstLocalImageReference("![[../outside/photo.jpg]]"), null);
});

test("uses a local PNG sibling when a static hero source has a JPEG suffix", () => {
  assert.equal(pngFallbackReference("images/hero.jpg"), "images/hero.png");
  assert.equal(pngFallbackReference("images/hero.jpeg"), "images/hero.png");
  assert.equal(pngFallbackReference("images/hero.png"), null);
});

test("normalizes Dataview date values to a validated ISO calendar day", () => {
  assert.equal(normalizeRecordDate("2025-10-14T23:45:00+09:00"), "2025-10-14");
  assert.equal(normalizeRecordDate("2025-02-30"), "");
});

test("daily record template carries age metadata and the entry outline", () => {
  const age = calculateAgeOnDate("2025-10-14", "2025-10-12", 42);
  const body = buildDailyRecordBody("2025-10-14", age);
  assert.match(body, /date: 2025-10-14/);
  assert.match(body, /age_days: 44/);
  assert.match(body, /age_str: "1개월 14일"/);
  assert.match(body, /## Child 1/);
  assert.match(body, /## Child 2/);
  assert.match(body, /## Next goals \/ growth/);
});

test("creates a personalized note through an in-memory adapter and opens existing notes", async () => {
  const dollar = String.fromCharCode(36);
  const tick = String.fromCharCode(96);
  const template = "---\ndate: " + dollar + "{dateStr}\nage_days: " + dollar + "{age.totalDays + 1}\nage_str: " + dollar + "{age.str}\n---\n# " + dollar + "{age.str}";
  const source = [
    "const BIRTHDAY = new Date(2025, 9, 12);",
    "function buildFileContent(dateStr, age) { return " + tick + template + tick + "; }",
  ].join("\n");
  const records = [{
    document: { id: "existing-record", title: "Existing record", filePath: "babies/records/2025-10-12.md", body: "" },
    date: "2025-10-12",
    ageDays: 42,
    ageText: "estimated",
    highlight: "",
    milestones: [],
    goals: [],
  }];
  const created: Array<{ title: string; body: string; folderId: string }> = [];
  const opened: string[] = [];
  const adapters = {
    async createPreviewDocument(input: { title: string; body: string; folderId: string }) {
      created.push(input);
      return { id: "new-record", title: input.title, filePath: "babies/records/new-record.md", body: input.body };
    },
  };
  const context = { recordsFolderId: "fake-records-folder", onOpenDocument: (id: string) => opened.push(id) };

  await openOrCreateDailyRecord("2025-10-14", records, context, adapters, source);
  assert.equal(created.length, 1);
  assert.equal(created[0]?.folderId, "fake-records-folder");
  assert.match(created[0]?.body ?? "", /date: 2025-10-14/);
  assert.match(created[0]?.body ?? "", /age_days: 3/);
  assert.match(created[0]?.body ?? "", /age_str: 0개월 3일/);
  assert.deepEqual(opened, ["new-record"]);

  await openOrCreateDailyRecord("2025-10-12", records, context, adapters, source);
  assert.equal(created.length, 1);
  assert.deepEqual(opened, ["new-record", "existing-record"]);
});

test("renders the supported dashboard, milestone, schedule, and daily action views from fake notes", () => {
  const extraRecords = Array.from({ length: 5 }, (_, index) => ({
    id: "00000000-0000-4000-8000-00000000002" + index,
    title: "Fake daily record " + index,
    filePath: "babies/records/fake-record-" + index + ".md",
    body: "---\ndate: 2026-10-" + String(13 - index).padStart(2, "0") + "\nage_days: " + (41 - index) + "\nhighlight: Fake highlight " + index + "\nmilestones:\n  - 'Child A: Fake milestone " + index + "'\n---\n",
  }));
  const documents = [
    {
      id: "00000000-0000-4000-8000-000000000010",
      title: "Fake daily record",
      filePath: "babies/records/fake-record.md",
      body: "---\ndate: 2026-10-14T23:45:00+09:00\nage_days: 42\nage_str: Fake age\nhighlight: Fake highlight\nmilestones:\n  - 'Child A:Fake milestone'\n  - 'A: Fake alias'\n  - 'Child B: Other fake milestone'\ngoals:\n  - Fake goal\n---\n![[photos/fake.jpg]]\n",
    },
    {
      id: "00000000-0000-4000-8000-000000000011",
      title: "Fake schedule",
      filePath: "babies/schedule/2025-09-stage.md",
      body: "---\nstage: Fake stage\nupdated: 2026-10-14\nrules:\n  start: 07:30\nschedule:\n  - time: 08:15\n    label: Fake morning nap\n    type: nap\n    duration: 90 minutes\n---\n",
    },
    ...extraRecords,
    {
      id: "00000000-0000-4000-8000-000000000012",
      title: "Newest fake schedule",
      filePath: "babies/schedule/2026-10-stage.md",
      body: "---\nstage: Newest stage\nupdated: 2026-10-14\nschedule:\n  - time: 08:15\n    label: Newest morning nap\n    type: sleep\n    duration: 90 minutes\n---\n",
    },
  ];
  const renderView = (source: string, documentPath: string, adapters?: { resolveVaultAsset?: (documentId: string, source: string) => string }, documentId?: string) => renderToStaticMarkup(React.createElement(
    BabiesPreviewDocumentsContext.Provider,
    { value: { documents, loading: false, error: false } },
    React.createElement(BabiesDataview, { source, context: { documentPath, documentId }, adapters }),
  ));

  const assetAdapter = { resolveVaultAsset: (documentId: string, source: string) => "/api/assets/image?documentId=" + documentId + "&source=" + encodeURIComponent(source) };
  const dashboardSource = [
    "dv.pages('babies/records'); age_days milestones; app.vault.create('babies/records/today.md')",
    "const BIRTHDAY = new Date(2025, 1, 2);",
    "const GIRL_SHORT = 'Child A'; const GIRL_NAME = 'Child A Full';",
    "const BOY_SHORT = 'Child B'; const BOY_NAME = 'Child B Full';",
    "titleEl.textContent = 'Child diary';",
    "app.vault.getAbstractFileByPath('images/hero.jpg');",
  ].join("\n");
  const dashboard = renderView(dashboardSource, "babies/dashboard.md", assetAdapter, "fake-dashboard");
  assert.match(dashboard, /Child diary/);
  assert.match(dashboard, /babies-view-hero-photo/);
  assert.match(dashboard, /source=images%2Fhero.jpg/);
  assert.match(dashboard, /babies-calendar-photo/);
  assert.match(dashboard, /source=photos%2Ffake.jpg/);
  assert.match(dashboard, /Fake highlight/);
  assert.match(dashboard, /Fake goal/);
  assert.match(dashboard, /aria-label="Previous month"/);
  assert.match(dashboard, /aria-label="Next month"/);
  assert.match(dashboard, /create record/);
  assert.match(dashboard, /Show all records/);
  assert.match(dashboard, /Show all milestones/);

  const timelineSource = "dv.pages('babies/records'); milestones\nconst GIRL_SHORT = 'Child A'; const GIRL_NAME = 'Child A Full';\nconst BOY_SHORT = 'Child B'; const BOY_NAME = 'Child B Full';";
  const timeline = renderView(timelineSource, "babies/milestones.md");
  assert.match(timeline, /Fake milestone/);
  assert.match(timeline, /babies-view-child-stats/);
  assert.match(timeline, /Child A/);
  assert.match(timeline, /data-child-kind="girl"/);
  assert.match(timeline, /data-child-kind="boy"/);
  assert.match(timeline, /<option value="Child A">Child A<\/option>/);
  assert.doesNotMatch(timeline, /<option value="A">A<\/option>/);

  const schedule = renderView("dv.pages('babies/schedule'); schedule\nnote.innerHTML = 'First note.<br><strong>Second line</strong>'; ", "babies/dashboard.md");
  assert.match(schedule, /Newest stage/);
  assert.match(schedule, /Newest morning nap/);
  assert.doesNotMatch(schedule, /Fake morning nap/);
  assert.match(schedule, /1h30m/);
  assert.match(schedule, /babies-schedule-advice/);
  assert.match(schedule, /First note.\nSecond line/);
  assert.match(schedule, /Care notes">First note\.\nSecond line<\/aside>/);

  const daily = renderView("app.vault.create('babies/records/today.md'); age_days: 42; milestones: []", "babies/dashboard.md");
  assert.match(daily, /Today’s diary/);
  assert.match(daily, /Write today’s record/);
});
