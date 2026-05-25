import * as vscode from "vscode";
import { ZipManagerRegistry } from "./zipManagerRegistry";
import { ZipFileSystemProvider } from "./zipFileSystemProvider";
import {
  makeZipUri,
  archiveDisplayName,
  isSupportedExtension,
  ZIP_SCHEME_ID,
} from "./utils";
import { log, getLog } from "./log";

let registry: ZipManagerRegistry;

export function activate(context: vscode.ExtensionContext): void {
  log("activate: Zip Viewer starting");
  registry = new ZipManagerRegistry();
  const provider = new ZipFileSystemProvider(registry);

  context.subscriptions.push(getLog());

  context.subscriptions.push(
    vscode.workspace.registerFileSystemProvider(ZIP_SCHEME_ID, provider, {
      isCaseSensitive: true,
      isReadonly: false,
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zipviewer.openArchive", async (fileUri?: vscode.Uri) => {
      if (!fileUri) {
        const picked = await vscode.window.showOpenDialog({
          canSelectMany: false,
          filters: {
            "Archives": ["zip", "docx", "pptx", "xlsx"],
          },
          title: "Open Archive",
        });
        if (!picked || picked.length === 0) return;
        fileUri = picked[0];
      }

      const archivePath = fileUri.fsPath;

      if (!isSupportedExtension(archivePath)) {
        vscode.window.showErrorMessage(
          `Unsupported file type. Configure additional extensions in settings.`
        );
        return;
      }

      try {
        await registry.open(archivePath);
      } catch (err: any) {
        vscode.window.showErrorMessage(
          `Failed to open archive: ${err.message}. The file may not be a valid ZIP format.`
        );
        return;
      }

      const rootUri = makeZipUri(archivePath);
      const displayName = archiveDisplayName(archivePath);

      // Check if already mounted
      const existing = vscode.workspace.workspaceFolders?.find(
        (f) => f.uri.scheme === ZIP_SCHEME_ID && f.uri.toString() === rootUri.toString()
      );
      if (existing) {
        vscode.window.showInformationMessage(`Archive "${displayName}" is already open.`);
        return;
      }

      const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
      vscode.workspace.updateWorkspaceFolders(folderCount, 0, {
        uri: rootUri,
        name: `📦 ${displayName}`,
      });
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zipviewer.saveAll", async () => {
      const openArchives = registry.listOpenArchives();
      if (openArchives.length === 0) {
        vscode.window.showInformationMessage("No archives are currently open.");
        return;
      }

      await vscode.workspace.saveAll(false);

      for (const archivePath of openArchives) {
        await registry.flushToDisk(archivePath);
      }

      vscode.window.showInformationMessage("All archive changes saved.");
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("zipviewer.closeArchive", async () => {
      const openArchives = registry.listOpenArchives();
      if (openArchives.length === 0) {
        vscode.window.showInformationMessage("No archives are currently open.");
        return;
      }

      const items = openArchives.map((p) => ({
        label: archiveDisplayName(p),
        description: p,
        archivePath: p,
      }));

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Select an archive to close",
      });
      if (!picked) return;

      await registry.close(picked.archivePath);

      const rootUri = makeZipUri(picked.archivePath);
      const folders = vscode.workspace.workspaceFolders;
      if (folders) {
        const idx = folders.findIndex(
          (f) => f.uri.scheme === ZIP_SCHEME_ID && f.uri.toString() === rootUri.toString()
        );
        if (idx !== -1) {
          vscode.workspace.updateWorkspaceFolders(idx, 1);
        }
      }
    })
  );

  context.subscriptions.push(registry);
}

export function deactivate(): void {
  registry?.dispose();
}
