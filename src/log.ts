import * as vscode from "vscode";

let channel: vscode.OutputChannel | undefined;

export function getLog(): vscode.OutputChannel {
  if (!channel) {
    channel = vscode.window.createOutputChannel("Zip Viewer");
  }
  return channel;
}

export function log(msg: string): void {
  const ts = new Date().toISOString().slice(11, 23);
  getLog().appendLine(`[${ts}] ${msg}`);
}
