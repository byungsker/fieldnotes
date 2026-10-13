import assert from "node:assert/strict";
import { appendFileSync, closeSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { createApp } from "../server/api.js";
import { closeDatabase, createDocument, createFolder, openDatabase } from "../server/database.js";
import { readDescriptorBounded, VaultStorageError } from "../server/vault.js";
import {
  extractLocalImageReferences,
  fetchPublicTmdbPoster,
  isAllowedTmdbPosterUrl,
  MAX_VISUALIZATION_IMAGE_BYTES,
  validateLocalImage,
} from "../server/visualization-assets.js";

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "fieldnotes-view-assets-"));
const database = openDatabase(path.join(temporaryRoot, "data"), { seedDemo: false, vaultDir: path.join(temporaryRoot, "data", "vault") });
const moviesFolder = createFolder(database, "movies", null);
const recordsFolder = createFolder(database, "records", moviesFolder.id);
createFolder(database, "attachments", moviesFolder.id);
const posterBytes = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
let servedPosterBytes = posterBytes;
const localBytes = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=", "base64");
const localPath = path.join(database.vault!.rootDir, "movies", "attachments", "synthetic-cover.png");
writeFileSync(localPath, localBytes);
const localNote = createDocument(database, "Synthetic local poster", "---\nkind: fixture\n---\n\n![[../attachments/synthetic-cover.png]]", recordsFolder.id);
const publicPosterUrl = "https://image.tmdb.org/t/p/w500/synthetic-poster.jpg";
const publicNote = createDocument(database, "Synthetic public poster", `---\nposter: ${publicPosterUrl}\n---\nSynthetic fixture.`, recordsFolder.id);
const unsafeNote = createDocument(database, "Synthetic unsafe poster", "---\nposter: https://image.tmdb.org.evil.example/t/p/w500/nope.jpg\n---\nSynthetic fixture.", recordsFolder.id);
const fencedNote = createDocument(database, "Synthetic fenced image example", "```markdown\n![[../attachments/synthetic-cover.png]]\n```", recordsFolder.id);
let posterRequests = 0;
let receivedPosterRequest: { url: string; init: RequestInit } | undefined;
const app = createApp(database, undefined, {
  posterImageFetch: async (url, init) => {
    posterRequests += 1;
    receivedPosterRequest = { url: url.href, init };
    return new Response(servedPosterBytes, { status: 200, headers: { "content-type": "image/jpeg", "content-length": String(servedPosterBytes.byteLength) } });
  },
});
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

test("public poster validation accepts only credential-free TMDb image references", () => {
  assert.equal(isAllowedTmdbPosterUrl(publicPosterUrl), true);
  for (const value of [
    "http://image.tmdb.org/t/p/w500/example.jpg",
    "https://image.tmdb.org.evil.example/t/p/w500/example.jpg",
    "https://user@image.tmdb.org/t/p/w500/example.jpg",
    "https://image.tmdb.org:444/t/p/w500/example.jpg",
    "https://image.tmdb.org/t/p/w500/example.jpg?token=secret",
    "https://image.tmdb.org/t/p/w500/../private.jpg",
  ]) assert.equal(isAllowedTmdbPosterUrl(value), false);
});

test("local image extraction resolves only explicit relative raster references", () => {
  assert.deepEqual(extractLocalImageReferences("![[../attachments/synthetic-cover.png]]", "movies/records/fixture.md"), [
    "movies/attachments/synthetic-cover.png",
  ]);
  assert.deepEqual(extractLocalImageReferences("![[../../.fieldnotes/state.json]]", "movies/records/fixture.md"), []);
  assert.deepEqual(extractLocalImageReferences("![remote](https://example.invalid/image.svg)", "movies/records/fixture.md"), []);
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

test("local images require an allowed extension, matching raster bytes, and the size cap", () => {
  const image = validateLocalImage(localBytes, "cover.png");
  assert.equal(image.contentType, "image/png");
  assert.throws(() => validateLocalImage(localBytes, "cover.jpg"), /verified JPEG/u);
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

test("public poster fetch is credential-free, redirect-free, and byte-bounded", async () => {
  let request: { url: string; init: RequestInit } | undefined;
  const image = await fetchPublicTmdbPoster(publicPosterUrl, async (url, init) => {
    request = { url: url.href, init };
    return new Response(posterBytes, { status: 200, headers: { "content-type": "image/jpeg" } });
  });
  assert.equal(image.contentType, "image/jpeg");
  assert.deepEqual(image.bytes, posterBytes);
  assert.equal(request?.url, publicPosterUrl);
  assert.equal(request?.init.redirect, "manual");
  assert.deepEqual(request?.init.headers, { Accept: "image/jpeg, image/png, image/webp" });
  assert.equal(await fetchPublicTmdbPoster(publicPosterUrl, async () => new Response("redirect", { status: 302, headers: { location: "https://example.invalid/" } })).then(() => false, () => true), true);
  await assert.rejects(fetchPublicTmdbPoster("https://image.tmdb.org.evil.example/t/p/w500/nope.jpg", async () => {
    throw new Error("must not fetch invalid host");
  }), /approved public image/u);
});

test("view asset API serves referenced local images and validated public posters from synthetic notes only", async () => {
  const queryResponse = await fetch(`${baseUrl}/api/views/query`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query: { folderId: recordsFolder.id, limit: 20 } }),
  });
  assert.equal(queryResponse.status, 200);
  const query = await queryResponse.json() as { notes: Array<{ id: string; assetPaths?: string[] }> };
  assert.deepEqual(query.notes.find((note) => note.id === localNote.id)?.assetPaths, ["movies/attachments/synthetic-cover.png"]);
  assert.equal(query.notes.find((note) => note.id === fencedNote.id)?.assetPaths, undefined);

  const localUrl = `${baseUrl}/api/views/assets/${localNote.id}?asset=${encodeURIComponent("movies/attachments/synthetic-cover.png")}&v=${localNote.contentHash}`;
  const localResponse = await fetch(localUrl);
  assert.equal(localResponse.status, 200, await localResponse.clone().text());
  assert.equal(localResponse.headers.get("content-type"), "image/png");
  assert.deepEqual(Buffer.from(await localResponse.arrayBuffer()), localBytes);
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

  const posterResponse = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`);
  assert.equal(posterResponse.status, 200);
  assert.equal(posterResponse.headers.get("content-type"), "image/jpeg");
  assert.deepEqual(Buffer.from(await posterResponse.arrayBuffer()), posterBytes);
  const initialEtag = posterResponse.headers.get("etag");
  assert.ok(initialEtag);
  const entityTagList = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`, {
    headers: { "If-None-Match": `"other,opaque", W/${initialEtag}` },
  });
  assert.equal(entityTagList.status, 304);
  const wildcard = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`, {
    headers: { "If-None-Match": "*" },
  });
  assert.equal(wildcard.status, 304);
  const quotedWildcard = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`, {
    headers: { "If-None-Match": '"*"' },
  });
  assert.equal(quotedWildcard.status, 200);
  const malformedTag = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`, {
    headers: { "If-None-Match": `prefix${initialEtag}suffix` },
  });
  assert.equal(malformedTag.status, 200);
  const malformedList = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`, {
    headers: { "If-None-Match": `${initialEtag}, malformed` },
  });
  assert.equal(malformedList.status, 200);
  servedPosterBytes = Buffer.from([0xff, 0xd8, 0xff, 0x01, 0x02, 0xff, 0xd9]);
  const refreshedPoster = await fetch(`${baseUrl}/api/views/assets/${publicNote.id}?field=poster&v=${publicNote.contentHash}`, {
    headers: { "If-None-Match": initialEtag },
  });
  assert.equal(refreshedPoster.status, 200);
  assert.notEqual(refreshedPoster.headers.get("etag"), initialEtag);
  assert.deepEqual(Buffer.from(await refreshedPoster.arrayBuffer()), servedPosterBytes);
  assert.equal(posterRequests, 7);
  assert.equal(receivedPosterRequest?.url, publicPosterUrl);
  assert.equal(receivedPosterRequest?.init.headers && "Authorization" in (receivedPosterRequest.init.headers as Record<string, string>), false);

  const unsafeResponse = await fetch(`${baseUrl}/api/views/assets/${unsafeNote.id}?field=poster&v=${unsafeNote.contentHash}`);
  assert.equal(unsafeResponse.status, 404);
  assert.equal(posterRequests, 7);
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
