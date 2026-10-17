export const STATE_FILE = "state.json";

export const STATE_FORMAT = "fieldnotes-vault";

export const STATE_VERSION = 2;

export const TEMP_PREFIX = ".fieldnotes-tmp-";

export const MAX_VAULT_FILE_BYTES = 5_000_000;

export const MAX_VAULT_ASSET_BYTES = 25_000_000;

export const LOCAL_RASTER_EXTENSIONS = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
