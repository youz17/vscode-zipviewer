import JSZip = require("jszip");
import { ArchiveAdapter, ArchiveEntry } from "./archiveAdapter";

export class ZipArchiveManager implements ArchiveAdapter {
  private zip!: InstanceType<typeof JSZip>;
  private dirty = false;

  async parse(data: Uint8Array): Promise<void> {
    this.zip = await JSZip.loadAsync(data);
    this.dirty = false;
  }

  listEntries(): ArchiveEntry[] {
    const entries: ArchiveEntry[] = [];
    this.zip.forEach((relativePath, file) => {
      entries.push({
        path: relativePath,
        isDirectory: file.dir,
        size: file.dir ? 0 : (file as any)._data?.uncompressedSize ?? 0,
        lastModified: file.date?.getTime() ?? Date.now(),
      });
    });
    return entries;
  }

  async readEntry(path: string): Promise<Uint8Array> {
    const file = this.zip.file(path);
    if (!file) {
      throw new Error(`Entry not found: ${path}`);
    }
    return file.async("uint8array");
  }

  writeEntry(path: string, data: Uint8Array): void {
    this.zip.file(path, data);
    this.dirty = true;
  }

  deleteEntry(path: string): void {
    const entry = this.zip.file(path);
    if (entry) {
      this.zip.remove(path);
      this.dirty = true;
      return;
    }
    // If it's a directory, remove it and all children
    const folder = this.zip.folder(path);
    if (folder) {
      this.zip.remove(path);
      this.dirty = true;
      return;
    }
    throw new Error(`Entry not found: ${path}`);
  }

  renameEntry(oldPath: string, newPath: string): void {
    const file = this.zip.file(oldPath);
    if (file) {
      const content = (file as any)._data;
      this.zip.remove(oldPath);
      if (content) {
        this.zip.file(newPath, content, { compression: "DEFLATE" });
      } else {
        this.zip.file(newPath, "");
      }
      this.dirty = true;
      return;
    }

    // Directory rename: move all children
    const prefix = oldPath.endsWith("/") ? oldPath : oldPath + "/";
    const newPrefix = newPath.endsWith("/") ? newPath : newPath + "/";
    const filesToMove: { path: string; file: JSZip.JSZipObject }[] = [];

    this.zip.forEach((p, f) => {
      if (p === prefix || p.startsWith(prefix)) {
        filesToMove.push({ path: p, file: f });
      }
    });

    if (filesToMove.length === 0) {
      throw new Error(`Entry not found: ${oldPath}`);
    }

    for (const { path, file } of filesToMove) {
      const relativeTail = path.slice(prefix.length);
      const dest = newPrefix + relativeTail;
      if (file.dir) {
        this.zip.folder(dest);
      } else {
        const data = (file as any)._data;
        if (data) {
          this.zip.file(dest, data, { compression: "DEFLATE" });
        } else {
          this.zip.file(dest, "");
        }
      }
      this.zip.remove(path);
    }
    this.dirty = true;
  }

  createDirectory(path: string): void {
    const dirPath = path.endsWith("/") ? path : path + "/";
    this.zip.folder(dirPath);
    this.dirty = true;
  }

  async toBuffer(): Promise<Uint8Array> {
    const buf = await this.zip.generateAsync({
      type: "uint8array",
      compression: "DEFLATE",
      compressionOptions: { level: 6 },
    });
    this.dirty = false;
    return buf;
  }

  isDirty(): boolean {
    return this.dirty;
  }
}
