export interface ArchiveEntry {
  path: string;
  isDirectory: boolean;
  size: number;
  lastModified: number;
}

export interface ArchiveAdapter {
  parse(data: Uint8Array): Promise<void>;
  listEntries(): ArchiveEntry[];
  readEntry(path: string): Promise<Uint8Array>;
  writeEntry(path: string, data: Uint8Array): void;
  deleteEntry(path: string): void;
  renameEntry(oldPath: string, newPath: string): void;
  createDirectory(path: string): void;
  toBuffer(): Promise<Uint8Array>;
  isDirty(): boolean;
}
