import * as vscode from "vscode";
import { ZipManagerRegistry } from "./zipManagerRegistry";
import { parseZipUri, makeZipUri, normalizeEntryPath, entryParent, entryName, ZIP_SCHEME_ID } from "./utils";
import { log } from "./log";

export class ZipFileSystemProvider implements vscode.FileSystemProvider {
  private _onDidChangeFile = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this._onDidChangeFile.event;

  constructor(private registry: ZipManagerRegistry) {
    registry.onDidRequestReload(async (archivePath) => {
      log(`reload event: refreshing open documents for [${archivePath}]`);

      // Fire change events for the root
      const events: vscode.FileChangeEvent[] = [
        { type: vscode.FileChangeType.Changed, uri: makeZipUri(archivePath) },
      ];

      // Fire change events using exact URIs from open documents to guarantee match
      const archiveKey = archivePath.replace(/\\/g, "/").toLowerCase();
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== ZIP_SCHEME_ID) continue;
        try {
          const parsed = parseZipUri(doc.uri);
          if (parsed.archivePath.replace(/\\/g, "/").toLowerCase() === archiveKey) {
            events.push({ type: vscode.FileChangeType.Changed, uri: doc.uri });
            log(`reload event: queued change for ${doc.uri.toString()}`);
          }
        } catch {
          // ignore URIs we can't parse
        }
      }

      // Also fire for all entries from the new archive data
      const manager = registry.get(archivePath);
      if (manager) {
        for (const entry of manager.listEntries()) {
          if (!entry.isDirectory) {
            events.push({
              type: vscode.FileChangeType.Changed,
              uri: makeZipUri(archivePath, normalizeEntryPath(entry.path)),
            });
          }
        }
      }

      this._onDidChangeFile.fire(events);

      // Force-revert open editors that VSCode may have cached
      await new Promise((r) => setTimeout(r, 100));
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.scheme !== ZIP_SCHEME_ID || doc.isClosed) continue;
        try {
          const parsed = parseZipUri(doc.uri);
          if (parsed.archivePath.replace(/\\/g, "/").toLowerCase() === archiveKey) {
            const newContent = await this.readFile(doc.uri);
            const currentContent = doc.getText();
            const newText = Buffer.from(newContent).toString("utf-8");
            if (currentContent !== newText) {
              log(`reload event: content differs, reverting ${doc.uri.toString()}`);
              const edit = new vscode.WorkspaceEdit();
              const fullRange = new vscode.Range(
                doc.positionAt(0),
                doc.positionAt(currentContent.length)
              );
              edit.replace(doc.uri, fullRange, newText);
              await vscode.workspace.applyEdit(edit);
            }
          }
        } catch {
          // ignore errors for individual documents
        }
      }
    });
  }

  /**
   * Get or lazily open the manager for an archive path.
   * Handles the case where the extension host restarted but zip:// workspace folders persist.
   */
  private async ensureManager(archivePath: string) {
    let manager = this.registry.get(archivePath);
    if (!manager) {
      manager = await this.registry.open(archivePath);
    }
    return manager;
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => {});
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const { archivePath, entryPath } = parseZipUri(uri);
    let manager;
    try {
      manager = await this.ensureManager(archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    // Root of the archive
    if (!entryPath || entryPath === "") {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
    }

    const entries = manager.listEntries();
    const normalized = normalizeEntryPath(entryPath);

    // Try exact file match
    const fileEntry = entries.find(
      (e) => !e.isDirectory && normalizeEntryPath(e.path) === normalized
    );
    if (fileEntry) {
      return {
        type: vscode.FileType.File,
        ctime: 0,
        mtime: fileEntry.lastModified,
        size: fileEntry.size,
      };
    }

    // Try directory match
    const dirMatch = entries.find((e) => {
      const ePath = normalizeEntryPath(e.path);
      return e.isDirectory && ePath === normalized;
    });
    if (dirMatch) {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: dirMatch.lastModified,
        size: 0,
      };
    }

    // Implicit directory: entries exist under this path
    const prefix = normalized + "/";
    const hasChildren = entries.some((e) => normalizeEntryPath(e.path).startsWith(prefix));
    if (hasChildren) {
      return {
        type: vscode.FileType.Directory,
        ctime: 0,
        mtime: Date.now(),
        size: 0,
      };
    }

    throw vscode.FileSystemError.FileNotFound(uri);
  }

  async readDirectory(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const { archivePath, entryPath } = parseZipUri(uri);
    let manager;
    try {
      manager = await this.ensureManager(archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const entries = manager.listEntries();
    const parentDir = normalizeEntryPath(entryPath);
    const result = new Map<string, vscode.FileType>();

    for (const entry of entries) {
      const entryNorm = normalizeEntryPath(entry.path);
      if (!entryNorm) continue;

      const entryParentDir = entryParent(entryNorm);

      if (entryParentDir === parentDir) {
        const name = entryName(entryNorm);
        if (!name) continue;
        result.set(
          name,
          entry.isDirectory ? vscode.FileType.Directory : vscode.FileType.File
        );
      } else if (parentDir === "" || entryNorm.startsWith(parentDir + "/")) {
        // Handle implicit directories: entries nested deeper but no explicit dir entry
        const rest =
          parentDir === "" ? entryNorm : entryNorm.slice(parentDir.length + 1);
        const firstSegment = rest.split("/")[0];
        if (firstSegment && !result.has(firstSegment)) {
          // Check if this is an intermediate implicit directory
          const directChild = parentDir
            ? parentDir + "/" + firstSegment
            : firstSegment;
          const isExplicitEntry = entries.some(
            (e) => normalizeEntryPath(e.path) === directChild && !e.isDirectory
          );
          if (!isExplicitEntry) {
            result.set(firstSegment, vscode.FileType.Directory);
          }
        }
      }
    }

    return [...result.entries()];
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    const { archivePath, entryPath } = parseZipUri(uri);
    let manager;
    try {
      manager = await this.ensureManager(archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const normalized = normalizeEntryPath(entryPath);
    try {
      return await manager.readEntry(normalized);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
  }

  async writeFile(
    uri: vscode.Uri,
    content: Uint8Array,
    options: { create: boolean; overwrite: boolean }
  ): Promise<void> {
    const { archivePath, entryPath } = parseZipUri(uri);
    let manager;
    try {
      manager = await this.ensureManager(archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const normalized = normalizeEntryPath(entryPath);
    const entries = manager.listEntries();
    const exists = entries.some(
      (e) => !e.isDirectory && normalizeEntryPath(e.path) === normalized
    );

    if (!exists && !options.create) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    if (exists && !options.overwrite) {
      throw vscode.FileSystemError.FileExists(uri);
    }

    manager.writeEntry(normalized, content);

    this._onDidChangeFile.fire([
      { type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri },
    ]);

    this.registry.scheduleFlush(archivePath);
  }

  async delete(uri: vscode.Uri, options: { recursive: boolean }): Promise<void> {
    const { archivePath, entryPath } = parseZipUri(uri);
    let manager;
    try {
      manager = await this.ensureManager(archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const normalized = normalizeEntryPath(entryPath);
    try {
      manager.deleteEntry(normalized);
    } catch {
      // Also try with trailing slash for directories
      try {
        manager.deleteEntry(normalized + "/");
      } catch {
        throw vscode.FileSystemError.FileNotFound(uri);
      }
    }

    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
    this.registry.scheduleFlush(archivePath);
  }

  async rename(
    oldUri: vscode.Uri,
    newUri: vscode.Uri,
    options: { overwrite: boolean }
  ): Promise<void> {
    const oldParsed = parseZipUri(oldUri);
    const newParsed = parseZipUri(newUri);

    if (oldParsed.archivePath !== newParsed.archivePath) {
      throw new Error("Cannot move entries between different archives");
    }

    let manager;
    try {
      manager = await this.ensureManager(oldParsed.archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(oldUri);
    }

    const oldPath = normalizeEntryPath(oldParsed.entryPath);
    const newPath = normalizeEntryPath(newParsed.entryPath);

    manager.renameEntry(oldPath, newPath);

    this._onDidChangeFile.fire([
      { type: vscode.FileChangeType.Deleted, uri: oldUri },
      { type: vscode.FileChangeType.Created, uri: newUri },
    ]);

    this.registry.scheduleFlush(oldParsed.archivePath);
  }

  async createDirectory(uri: vscode.Uri): Promise<void> {
    const { archivePath, entryPath } = parseZipUri(uri);
    let manager;
    try {
      manager = await this.ensureManager(archivePath);
    } catch {
      throw vscode.FileSystemError.FileNotFound(uri);
    }

    const normalized = normalizeEntryPath(entryPath);
    manager.createDirectory(normalized);

    this._onDidChangeFile.fire([{ type: vscode.FileChangeType.Created, uri }]);
    this.registry.scheduleFlush(archivePath);
  }
}
