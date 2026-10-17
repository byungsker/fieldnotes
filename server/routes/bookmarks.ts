import type { Express } from "express";
import { fetchBookmarkMetadata } from "../bookmarks/metadata.js";
import { RequestValidationError } from "../http/validation.js";

export function registerBookmarkRoutes(app: Express): void {
  app.get("/api/bookmarks/metadata", async (request, response) => {
    if (typeof request.query.url !== "string") throw new RequestValidationError("A single bookmark URL is required.");
    const metadata = await fetchBookmarkMetadata(request.query.url);
    response.json({ metadata });
  });
}
