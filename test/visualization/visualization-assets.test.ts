import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../../server/api.js";
import { closeDatabase, createDocument, createFolder, openDatabase } from "../../server/storage/database.js";
import { readDescriptorBounded, VaultStorageError } from "../../server/storage/vault.js";
import {
  extractLocalImageReferences,
  MAX_VISUALIZATION_IMAGE_BYTES,
  validateLocalImage,
} from "../../server/visualization/assets.js";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-view-assets-"));
const database = openDatabase(path.join(temporaryRoot, "data"), { seedDemo: false, vaultDir: path.join(temporaryRoot, "data", "vault") });
const moviesFolder = createFolder(database, "movies", null);
const recordsFolder = createFolder(database, "records", moviesFolder.id);
createFolder(database, "attachments", moviesFolder.id);
const localBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");
const localPath = path.join(database.vault!.rootDir, "movies", "attachments", "synthetic-cover.png");
writeFileSync(localPath, localBytes);
const localNote = createDocument(database, "Synthetic local poster", "---\nkind: fixture\n---\n\n![[../attachments/synthetic-cover.png]]", recordsFolder.id);
const misnamedLocalPath = path.join(database.vault!.rootDir, "movies", "attachments", "synthetic-misnamed-cover.jpg");
writeFileSync(misnamedLocalPath, localBytes);
const misnamedLocalNote = createDocument(database, "Synthetic PNG with JPG extension", "---\nkind: fixture\n---\n\n![[../attachments/synthetic-misnamed-cover.jpg]]", recordsFolder.id);
const publicPosterUrl = "https://image.tmdb.org/t/p/w500/synthetic-poster.jpg";
const publicNote = createDocument(database, "Synthetic public poster", `---\nposter: ${publicPosterUrl}\n---\nSynthetic fixture.`, recordsFolder.id);
const fencedNote = createDocument(database, "Synthetic fenced image example", "```markdown\n![[../attachments/synthetic-cover.png]]\n```", recordsFolder.id);
const app = createApp(database);
const server = app.listen(0, "127.0.0.1");
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  closeDatabase(database);
  rmSync(temporaryRoot, { recursive: true, force: true });
});

test("local image extraction resolves only explicit relative raster references", () => {
  assert.deepEqual(extractLocalImageReferences("![[../attachments/synthetic-cover.png]]", "movies/records/fixture.md"), [
    "movies/attachments/synthetic-cover.png",
  ]);
  assert.deepEqual(extractLocalImageReferences("![[../../.fieldnotes/state.json]]", "movies/records/fixture.md"), []);
  assert.deepEqual(extractLocalImageReferences("![remote](https://example.invalid/image.svg)", "movies/records/fixture.md"), []);
  assert.deepEqual(extractLocalImageReferences("![encoded](<../attachments/day%20with%20spaces.webp>)", "movies/records/fixture.md"), [
    "movies/attachments/day with spaces.webp",
  ]);
  assert.deepEqual(extractLocalImageReferences("![malformed](<../attachments/day%2 with spaces.webp>)", "movies/records/fixture.md"), []);
});

test("local image extraction ignores fenced code using delimiter-aware boundaries", () => {
  const markdown = [
    "![[../attachments/before.png]]",
    "```md",
    "![[../attachments/fenced-wiki.png]]",
    "```label",
    "![still-fenced](../attachments/fenced-markdown.jpg)",
    "```",
    "![[../attachments/after.png]]",
    "````ts",
    "![long-fenced](../attachments/long-fenced.webp)",
    "```",
    "![[../attachments/still-long-fenced.png]]",
    "  ````",
    "~~~text",
    "![[../attachments/tilde-fenced.png]]",
    "```",
    "~~~",
    "![final](../attachments/final.webp)",
  ].join("\n");
  assert.deepEqual(extractLocalImageReferences(markdown, "movies/records/fixture.md"), [
    "movies/attachments/before.png",
    "movies/attachments/after.png",
    "movies/attachments/final.webp",
  ]);
});

test("local images require an allowed extension, verified raster bytes, and the size cap", () => {
  const image = validateLocalImage(localBytes, "cover.png");
  assert.equal(image.contentType, "image/png");
  assert.equal(validateLocalImage(localBytes, "cover.jpg").contentType, "image/png");
  assert.equal(validateLocalImage(Buffer.from([0xff, 0xd8, 0xff]), "cover.png").contentType, "image/jpeg");
  assert.throws(() => validateLocalImage(Buffer.from("not an image"), "cover.png"), /verified JPEG/u);
  assert.throws(() => validateLocalImage(localBytes, "cover.gif"), /verified JPEG/u);
  assert.throws(() => validateLocalImage(Buffer.alloc(MAX_VISUALIZATION_IMAGE_BYTES + 1), "cover.png"), /1 MB/u);
});

test("bounded descriptor reads stop at the limit plus one byte if the open file grows", () => {
  const growingPath = path.join(temporaryRoot, "growing-synthetic-file.bin");
  writeFileSync(growingPath, "AB");
  const descriptor = openSync(growingPath, "r");
  let appended = false;
  let requestedBytes = 0;
  try {
    const result = readDescriptorBounded(descriptor, 3, (fd, buffer, offset, length, position) => {
      requestedBytes += length;
      if (!appended) {
        appendFileSync(growingPath, "CDEFGHIJKLMNOPQRSTUVWXYZ");
        appended = true;
      }
      return readSync(fd, buffer, offset, length, position);
    });
    assert.equal(result.exceededLimit, true);
    assert.equal(result.bytes.toString(), "ABC");
    assert.equal(requestedBytes, 4);
  } finally {
    closeSync(descriptor);
  }
});

test("view asset API serves only explicitly referenced local images and rejects remote metadata", async () => {
  const queryResponse = await fetch(`${baseUrl}/api/views/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { folderId: recordsFolder.id, limit: 20 } }),
  });
  assert.equal(queryResponse.status, 200);
  const query = await queryResponse.json() as { notes: Array<{ id: string; assetPaths?: string[] }> };
  assert.deepEqual(query.notes.find((note) => note.id === localNote.id)?.assetPaths, ["movies/attachments/synthetic-cover.png"]);
  assert.deepEqual(query.notes.find((note) => note.id === misnamedLocalNote.id)?.assetPaths, ["movies/attachments/synthetic-misnamed-cover.jpg"]);
  assert.equal(query.notes.find((note) => note.id === fencedNote.id)?.assetPaths, undefined);

  const localUrl = `${baseUrl}/api/views/assets/${localNote.id}?asset=${encodeURIComponent("movies/attachments/synthetic-cover.png")}&v=${localNote.contentHash}`;
  const localResponse = await fetch(localUrl);
  assert.equal(localResponse.status, 200, await localResponse.clone().text());
  assert.equal(localResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await localResponse.arrayBuffer()), localBytes);

  const misnamedLocalUrl = `${baseUrl}/api/views/assets/${misnamedLocalNote.id}?asset=${encodeURIComponent("movies/attachments/synthetic-misnamed-cover.jpg")}&v=${misnamedLocalNote.contentHash}`;
  const misnamedLocalResponse = await fetch(misnamedLocalUrl);
  assert.equal(misnamedLocalResponse.status, 200, await misnamedLocalResponse.clone().text());
  assert.equal(misnamedLocalResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await misnamedLocalResponse.arrayBuffer()), localBytes);

  const initialLocalEtag = localResponse.headers.get("etag");
  assert.ok(initialLocalEtag);
  const updatedLocalBytes = Buffer.concat([localBytes, Buffer.from([1])]);
  writeFileSync(localPath, updatedLocalBytes);
  const refreshedLocal = await fetch(localUrl, { headers: { "If-None-Match": initialLocalEtag } });
  assert.equal(refreshedLocal.status, 200);
  assert.notEqual(refreshedLocal.headers.get("etag"), initialLocalEtag);
  assert.deepEqual(Buffer.from(await refreshedLocal.arrayBuffer()), updatedLocalBytes);

  const fencedReference = `${baseUrl}/api/views/assets/${fencedNote.id}?asset=${encodeURIComponent("movies/attachments/synthetic-cover.png")}&v=${fencedNote.contentHash}`;
  assert.equal((await fetch(fencedReference)).status, 404);

  const currentEtag = refreshedLocal.headers.get("etag");
  assert.ok(currentEtag);
  for (const [header, status] of [
    [`"other,opaque", W/${currentEtag}`, 304],
    ["*", 304],
    ['"*"', 200],
    [`prefix${currentEtag}suffix`, 200],
    [`${currentEtag}, malformed`, 200],
  ] as const) {
    const response = await fetch(localUrl, { headers: { "If-None-Match": header } });
    assert.equal(response.status, status, header);
  }
  appendFileSync(localPath, Buffer.from([2]));
  const changedAgain = await fetch(localUrl, { headers: { "If-None-Match": currentEtag } });
  assert.equal(changedAgain.status, 200);
  assert.notEqual(changedAgain.headers.get("etag"), currentEtag);

  assert.equal((await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`)).status, 400);
  assert.equal((await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?asset=${encodeURIComponent(publicPosterUrl)}&v=${publicNote.contentHash}`)).status, 404);
  assert.equal((await fetch(localUrl.replace(localNote.contentHash, "0".repeat(64)))).status, 409);
  assert.equal((await fetch(localUrl.replace(`&v=${localNote.contentHash}`, ""))).status, 400);
  const unreferencedResponse = await fetch(`${baseUrl}/api/views/assets/${localNote.id}?asset=${encodeURIComponent("movies/attachments/other.png")}&v=${localNote.contentHash}`);
  assert.equal(unreferencedResponse.status, 404);
});

test("asset reads reject parent-directory symlinks into another directory", () => {
  const outside = path.join(temporaryRoot, "outside-synthetic-assets");
  const linkedDirectory = path.join(database.vault!.rootDir, "movies", "records", "linked-assets");
  mkdirSync(outside);
  writeFileSync(path.join(outside, "cover.png"), localBytes);
  symlinkSync(outside, linkedDirectory, "dir");
  try {
    assert.throws(
      () => database.vault!.readAsset("movies/records/linked-assets/cover.png", MAX_VISUALIZATION_IMAGE_BYTES),
      (error: unknown) => error instanceof VaultStorageError && error.code === "vault_symlink",
    );
  } finally {
    unlinkSync(linkedDirectory);
  }
});
