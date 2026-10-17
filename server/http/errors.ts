import type { ErrorRequestHandler, Response } from "express";
import { BookmarkMetadataFetchError, UnsafeBookmarkUrlError } from "../bookmarks/metadata.js";
import {
  DuplicateFolderNameError,
  FolderCycleError,
  FolderNotEmptyError,
  MissingDocumentError,
  MissingFolderError,
  VersionConflictError,
} from "../storage/database.js";
import { VaultStorageError } from "../storage/vault.js";
import { VisualizationQueryError } from "../visualization/query.js";
import { VisualizationAssetError } from "../visualization/assets.js";
import { MovieSearchProviderError } from "../visualization/movie-search.js";
import { ViewQueryLimitError } from "../view-query-limits.js";
import { RequestValidationError } from "./validation.js";

export function sendError(response: Response, status: number, code: string, message: string, extra = {}): void {
  response.status(status).json({ error: code, message, ...extra });
}

export const errors: ErrorRequestHandler = (error, _request, response, next) => {
  if (response.headersSent) {
    next(error);
    return;
  }
  if (error instanceof RequestValidationError) {
    sendError(response, 400, "invalid_request", error.message);
    return;
  }
  if (error instanceof VisualizationQueryError) {
    sendError(response, error.status, "invalid_view_query", error.message);
    return;
  }
  if (error instanceof VisualizationAssetError) {
    sendError(response, error.status, error.code, error.message);
    return;
  }
  if (error instanceof ViewQueryLimitError) {
    sendError(response, 413, "invalid_view_query", error.message);
    return;
  }
  if (error instanceof UnsafeBookmarkUrlError) {
    sendError(response, 400, "invalid_bookmark_url", error.message);
    return;
  }
  if (error instanceof BookmarkMetadataFetchError) {
    sendError(response, 502, "bookmark_metadata_unavailable", error.message);
    return;
  }
  if (error instanceof MovieSearchProviderError) {
    sendError(response, 502, "movie_search_failed", error.message);
    return;
  }
  if (error instanceof VersionConflictError) {
    sendError(response, 409, "version_conflict", error.message, {
      currentVersion: error.currentVersion,
      ...(error.currentHash ? { currentHash: error.currentHash } : {}),
    });
    return;
  }
  if (error instanceof VaultStorageError) {
    sendError(response, error.status, error.code, error.message);
    return;
  }
  if (error instanceof MissingDocumentError) {
    sendError(response, 404, "not_found", error.message);
    return;
  }
  if (error instanceof MissingFolderError) {
    sendError(response, 404, "not_found", error.message);
    return;
  }
  if (error instanceof FolderNotEmptyError) {
    sendError(response, 409, "folder_not_empty", error.message);
    return;
  }
  if (error instanceof FolderCycleError) {
    sendError(response, 409, "folder_cycle", error.message);
    return;
  }
  if (error instanceof DuplicateFolderNameError) {
    sendError(response, 409, "duplicate_folder", error.message);
    return;
  }
  const bodyError = error as { type?: string; status?: number; message?: string };
  if (bodyError.type === "entity.too.large") {
    sendError(response, 413, "payload_too_large", "Request body is too large.");
    return;
  }
  if (bodyError.status === 400) {
    sendError(response, 400, "invalid_json", "Request body must be valid JSON.");
    return;
  }
  console.error("Request failed:", error);
  sendError(response, 500, "internal_error", "The local service could not complete this request.");
};
