import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BookmarkMetadataFetchError,
  fetchBookmarkMetadata,
  isPublicIpAddress,
  resolvePublicHttpsTarget,
  UnsafeBookmarkUrlError,
} from "../server/bookmark-metadata.js";

test("bookmark URL validation rejects local, private, unsupported, and credentialed targets", async () => {
  for (const address of ["127.0.0.1", "10.0.0.4", "192.168.1.8", "169.254.1.1", "::1", "fc00::1", "fe80::1", "2001:db8::1", "2001:0::1", "2002:0808:0808::1", "::ffff:127.0.0.1"]) {
    assert.equal(isPublicIpAddress(address), false, address);
  }
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "2001:4860:4860::8888"]) {
    assert.equal(isPublicIpAddress(address), true, address);
  }
  for (const url of [
    "http://example.com/",
    "https://localhost/",
    "https://service.local/",
    "https://127.0.0.1/",
    "https://[::1]/",
    "https://user:pass@example.com/",
    "https://example.com:8443/",
  ]) {
    await assert.rejects(resolvePublicHttpsTarget(url), UnsafeBookmarkUrlError, url);
  }
  await assert.rejects(
    resolvePublicHttpsTarget("https://mixed.example/", async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ]),
    UnsafeBookmarkUrlError,
  );
});

test("bookmark redirects are revalidated before any request to the next target", async () => {
  const requested: string[] = [];
  await assert.rejects(fetchBookmarkMetadata("https://public.example/", {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async (target) => {
      requested.push(target.url.href);
      return { status: 302, location: "https://127.0.0.1/private", contentType: "text/html", body: "" };
    },
  }), UnsafeBookmarkUrlError);
  assert.deepEqual(requested, ["https://public.example/"]);
});

test("bookmark metadata is plain text and metadata fetch rejects non-HTML responses", async () => {
  const metadata = await fetchBookmarkMetadata("https://public.example/path", {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async () => ({
      status: 200,
      location: undefined,
      contentType: "text/html; charset=utf-8",
      body: `<html><head><meta property="og:title" content="&lt;script&gt;Safe &amp; Sound&lt;/script&gt;"><meta name="description" content="A description"><meta property="og:image" content="https://cdn.example/image.png"><meta property="og:site_name" content="Example"></head><body></body></html>`,
    }),
  });
  assert.deepEqual(metadata, {
    title: "Safe & Sound",
    description: "A description",
    image: "https://cdn.example/image.png",
    siteName: "Example",
    url: "https://public.example/path",
  });

  await assert.rejects(fetchBookmarkMetadata("https://public.example/", {
    resolve: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async () => ({ status: 200, location: undefined, contentType: "image/svg+xml", body: "<svg/>" }),
  }), BookmarkMetadataFetchError);
});
