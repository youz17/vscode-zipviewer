import * as vscode from "vscode";
import * as fs from "fs";
import { ZipArchiveManager } from "./zipArchiveManager";
import { ArchiveAdapter } from "./archiveAdapter";
import { log } from "./log";

export class ZipManagerRegistry implements vscode.Disposable {
  private managers = new Map<string, ArchiveAdapter>();
  private watchers = new Map<string, vscode.FileSystemWatcher>();
  private flushTimers = new Map<string, NodeJS.Timeout>();
  private flushLocks = new Set<string>();
  private selfWriteKeys = new Set<string>();
  private _onDidRequestReload = new vscode.EventEmitter<string>();
  readonly onDidRequestReload = this._onDidRequestReload.event;

  private static DEBOUNCE_MS = 300;
  private static WRITE_RETRIES = 5;
  private static RETRY_DELAY_MS = 200;

  private normalizeKey(archivePath: string): string {
    return archivePath.replace(/\\/g, "/").toLowerCase();
  }

  async open(archivePath: string): Promise<ArchiveAdapter> {
    const key = this.normalizeKey(archivePath);
    const existing = this.managers.get(key);
    if (existing) {
      log(`open: already loaded [${key}]`);
      return existing;
    }

    log(`open: reading [${archivePath}]`);
    const data = await fs.promises.readFile(archivePath);
    log(`open: read ${data.length} bytes, parsing ZIP`);
    const manager = new ZipArchiveManager();
    await manager.parse(new Uint8Array(data));
    this.managers.set(key, manager);

    this.watchExternalChanges(archivePath, key);
    log(`open: done [${key}]`);

    return manager;
  }

  get(archivePath: string): ArchiveAdapter | undefined {
    return this.managers.get(this.normalizeKey(archivePath));
  }

  has(archivePath: string): boolean {
    return this.managers.has(this.normalizeKey(archivePath));
  }

  async close(archivePath: string): Promise<void> {
    const key = this.normalizeKey(archivePath);
    const manager = this.managers.get(key);
    if (!manager) return;

    if (manager.isDirty()) {
      const answer = await vscode.window.showWarningMessage(
        `Archive "${archivePath}" has unsaved changes. Save before closing?`,
        "Save",
        "Discard"
      );
      if (answer === "Save") {
        await this.flushToDisk(archivePath);
      }
    }

    this.clearFlushTimer(key);
    this.watchers.get(key)?.dispose();
    this.watchers.delete(key);
    this.managers.delete(key);
    log(`close: [${key}]`);
  }

  scheduleFlush(archivePath: string): void {
    const key = this.normalizeKey(archivePath);
    this.clearFlushTimer(key);
    const timer = setTimeout(async () => {
      this.flushTimers.delete(key);
      await this.flushToDisk(archivePath);
    }, ZipManagerRegistry.DEBOUNCE_MS);
    this.flushTimers.set(key, timer);
    log(`scheduleFlush: scheduled [${key}]`);
  }

  async flushToDisk(archivePath: string): Promise<void> {
    const key = this.normalizeKey(archivePath);
    const manager = this.managers.get(key);
    if (!manager || !manager.isDirty()) {
      log(`flushToDisk: skip (not dirty) [${key}]`);
      return;
    }

    if (this.flushLocks.has(key)) {
      log(`flushToDisk: skip (already flushing) [${key}]`);
      return;
    }
    this.flushLocks.add(key);

    log(`flushToDisk: start [${archivePath}]`);

    // Dispose watcher to release file handles on Windows
    this.selfWriteKeys.add(key);
    const watcher = this.watchers.get(key);
    if (watcher) {
      watcher.dispose();
      this.watchers.delete(key);
      log(`flushToDisk: watcher disposed`);
    }

    try {
      const buffer = await manager.toBuffer();
      log(`flushToDisk: generated ${buffer.length} bytes, writing...`);

      await this.writeWithRetry(archivePath, buffer);
      log(`flushToDisk: write succeeded`);
    } catch (err: any) {
      log(`flushToDisk: FAILED: ${err.message}`);
      vscode.window.showErrorMessage(
        `Failed to save archive: ${err.message}`
      );
    } finally {
      this.watchExternalChanges(archivePath, key);
      setTimeout(() => this.selfWriteKeys.delete(key), 500);
      this.flushLocks.delete(key);
    }
  }

  /**
   * Write buffer to file with retries to handle transient Windows file locks
   * (antivirus, search indexer, VSCode file watchers, etc.)
   */
  private async writeWithRetry(filePath: string, buffer: Uint8Array): Promise<void> {
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt < ZipManagerRegistry.WRITE_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          const delay = ZipManagerRegistry.RETRY_DELAY_MS * attempt;
          log(`writeWithRetry: attempt ${attempt + 1}, waiting ${delay}ms`);
          await new Promise((r) => setTimeout(r, delay));
        }
        await fs.promises.writeFile(filePath, buffer);
        return;
      } catch (err: any) {
        lastErr = err;
        const code = err.code as string;
        if (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES") {
          throw err;
        }
        log(`writeWithRetry: attempt ${attempt + 1} failed: ${code}`);
      }
    }

    // All retries exhausted — try writing to a .tmp file as fallback
    const tmpPath = filePath + ".tmp";
    log(`writeWithRetry: all retries failed, writing to ${tmpPath}`);
    try {
      await fs.promises.writeFile(tmpPath, buffer);
      vscode.window.showWarningMessage(
        `Could not write to the original file (locked). Changes saved to "${tmpPath}".`
      );
      return;
    } catch {
      // tmp write also failed
    }

    throw lastErr!;
  }

  async reload(archivePath: string): Promise<void> {
    const key = this.normalizeKey(archivePath);
    // Dispose old watcher to avoid duplicates
    const watcher = this.watchers.get(key);
    if (watcher) {
      watcher.dispose();
      this.watchers.delete(key);
    }
    this.managers.delete(key);
    await this.open(archivePath);
    log(`reload: done [${key}]`);
  }

  listOpenArchives(): string[] {
    return [...this.managers.keys()];
  }

  private watchExternalChanges(archivePath: string, key: string): void {
    // Avoid duplicate watchers
    const existing = this.watchers.get(key);
    if (existing) {
      existing.dispose();
    }

    const dirPath = archivePath.replace(/[/\\][^/\\]*$/, "");
    const fileName = archivePath.replace(/^.*[/\\]/, "");
    const pattern = new vscode.RelativePattern(dirPath, fileName);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidChange(async () => {
      if (this.selfWriteKeys.has(key)) {
        return;
      }
      const manager = this.managers.get(key);
      if (!manager) return;

      log(`watcher: external change detected [${key}]`);

      if (manager.isDirty()) {
        const answer = await vscode.window.showWarningMessage(
          "The archive has been modified externally. You have unsaved changes. Reload will discard them.",
          "Reload",
          "Ignore"
        );
        if (answer !== "Reload") return;
      } else {
        const answer = await vscode.window.showInformationMessage(
          "The archive has been modified externally. Reload?",
          "Reload",
          "Ignore"
        );
        if (answer !== "Reload") return;
      }

      await this.reload(archivePath);
      this._onDidRequestReload.fire(archivePath);
    });

    watcher.onDidDelete(async () => {
      log(`watcher: file deleted [${key}]`);
      vscode.window.showWarningMessage(
        `The archive "${archivePath}" has been deleted externally.`
      );
      this.managers.delete(key);
      watcher.dispose();
      this.watchers.delete(key);
    });

    this.watchers.set(key, watcher);
    log(`watcher: created for [${key}]`);
  }

  private clearFlushTimer(key: string): void {
    const existing = this.flushTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      this.flushTimers.delete(key);
    }
  }

  dispose(): void {
    for (const timer of this.flushTimers.values()) {
      clearTimeout(timer);
    }
    this.flushTimers.clear();
    for (const watcher of this.watchers.values()) {
      watcher.dispose();
    }
    this.watchers.clear();
    this.managers.clear();
    this._onDidRequestReload.dispose();
  }
}
