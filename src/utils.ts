import * as vscode from "vscode";

const ZIP_SCHEME = "zip";

/**
 * Build a zip:// URI from an archive's disk path and an inner entry path.
 * Format: zip://<encoded-archive-path>/<entryPath>
 * Authority holds the archive disk path (percent-encoded), path holds the entry.
 */
export function makeZipUri(archivePath: string, entryPath: string = ""): vscode.Uri {
  const normalizedEntry = entryPath.replace(/\\/g, "/").replace(/^\//, "");
  return vscode.Uri.from({
    scheme: ZIP_SCHEME,
    authority: encodeArchivePath(archivePath),
    path: "/" + normalizedEntry,
  });
}

/**
 * Parse a zip:// URI back into { archivePath, entryPath }.
 */
export function parseZipUri(uri: vscode.Uri): { archivePath: string; entryPath: string } {
  const archivePath = decodeArchivePath(uri.authority);
  const entryPath = uri.path.replace(/^\//, "");
  return { archivePath, entryPath };
}

function encodeArchivePath(p: string): string {
  return Buffer.from(p.replace(/\\/g, "/"), "utf-8").toString("hex");
}

function decodeArchivePath(hex: string): string {
  return Buffer.from(hex, "hex").toString("utf-8");
}

/**
 * Get the workspace folder name shown in Explorer for a mounted archive.
 * e.g. "archive.zip" from "D:/files/archive.zip"
 */
export function archiveDisplayName(archivePath: string): string {
  const parts = archivePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || archivePath;
}

/**
 * Normalize an entry path: strip leading/trailing slashes.
 */
export function normalizeEntryPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * Get the parent directory of an entry path, or "" for root entries.
 */
export function entryParent(p: string): string {
  const norm = normalizeEntryPath(p);
  const lastSlash = norm.lastIndexOf("/");
  return lastSlash === -1 ? "" : norm.slice(0, lastSlash);
}

/**
 * Get the file/folder name from a full entry path.
 */
export function entryName(p: string): string {
  const norm = normalizeEntryPath(p);
  const lastSlash = norm.lastIndexOf("/");
  return lastSlash === -1 ? norm : norm.slice(lastSlash + 1);
}

export function isSupportedExtension(filePath: string): boolean {
  const builtIn = [".zip", ".docx", ".pptx", ".xlsx"];
  const config = vscode.workspace.getConfiguration("zipviewer");
  const additional: string[] = config.get("additionalExtensions", []);
  const all = [...builtIn, ...additional.map((e) => (e.startsWith(".") ? e : "." + e))];
  const ext = filePath.slice(filePath.lastIndexOf(".")).toLowerCase();
  return all.some((e) => e.toLowerCase() === ext);
}

export const ZIP_SCHEME_ID = ZIP_SCHEME;
