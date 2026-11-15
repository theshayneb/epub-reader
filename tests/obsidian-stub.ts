export function normalizePath(path: string): string {
  const output: string[] = [];
  for (const part of path.replace(/\\/g, "/").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") output.pop();
    else output.push(part);
  }
  return output.join("/");
}

export class TAbstractFile {
  path = "";
  name = "";
  parent: TFolder | null = null;
}

export class TFile extends TAbstractFile {
  extension = "";
  basename = "";
}

export class TFolder extends TAbstractFile {
  children: TAbstractFile[] = [];
}

export function requestUrl(): Promise<never> {
  return Promise.reject(new Error("requestUrl is not available in tests"));
}

/** Minimal stand-ins so modules that define Obsidian modals (note-layout.ts) can be imported in tests. */
export class App {}

export class Modal {
  constructor(readonly app: App) {}
  open(): void {}
  close(): void {}
}

export class Setting {
  constructor(readonly containerEl: unknown) {}
}

export function setIcon(): void {}
