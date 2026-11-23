/**
 * Capture-phase file queue (M3b).
 *
 * The upload hook matches `POST /backend-api/files` metadata
 * (`file_name` + `file_size`) to a File the user just selected/dropped/pasted.
 * Listeners run in the capture phase on `window`, never call `preventDefault`
 * and never mutate the File. Entries expire after five minutes; at most 20 are
 * kept (spec §4.2).
 */

export interface CapturedFile {
  file: File;
  name: string;
  size: number;
  lastModified: number;
  ts: number;
}

export interface CapturedFileQueueOptions {
  maxFiles?: number;
  ttlMs?: number;
  now?: () => number;
}

const DEFAULT_MAX_FILES = 20;
const DEFAULT_TTL_MS = 5 * 60_000;

function isFile(value: unknown): value is File {
  if (typeof value !== 'object' || value === null) return false;
  return (
    'name' in value &&
    typeof value.name === 'string' &&
    'size' in value &&
    typeof value.size === 'number' &&
    'arrayBuffer' in value &&
    typeof value.arrayBuffer === 'function'
  );
}

export class CapturedFileQueue {
  private readonly items: CapturedFile[] = [];
  private readonly maxFiles: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(options: CapturedFileQueueOptions = {}) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.now = options.now ?? (() => Date.now());
  }

  get size(): number {
    this.purge();
    return this.items.length;
  }

  add(file: File): void {
    if (!isFile(file)) return;
    this.purge();

    this.items.push({
      file,
      name: file.name,
      size: file.size,
      lastModified: typeof file.lastModified === 'number' ? file.lastModified : 0,
      ts: this.now(),
    });

    while (this.items.length > this.maxFiles) this.items.shift();
  }

  addAll(files: ArrayLike<File> | null | undefined): void {
    if (!files) return;
    for (const file of Array.from(files)) {
      if (isFile(file)) this.add(file);
    }
  }

  /** Oldest exact `name`+`size` match, removed from the queue (FIFO). */
  take(name: string, size: number): CapturedFile | undefined {
    this.purge();
    const index = this.items.findIndex((item) => item.name === name && item.size === size);
    if (index === -1) return undefined;
    return this.items.splice(index, 1)[0];
  }

  clear(): void {
    this.items.length = 0;
  }

  private purge(): void {
    const cutoff = this.now() - this.ttlMs;
    while (this.items.length > 0 && (this.items[0]?.ts ?? 0) < cutoff) {
      this.items.shift();
    }
  }
}

function filesFromEvent(event: Event): ArrayLike<File> | null | undefined {
  if (event.type === 'drop') {
    return (event as DragEvent).dataTransfer?.files;
  }
  if (event.type === 'paste') {
    return (event as ClipboardEvent).clipboardData?.files;
  }
  return undefined;
}

function inputFromEvent(event: Event): HTMLInputElement | undefined {
  const path = event.composedPath();
  for (const node of path) {
    if (node instanceof HTMLInputElement) return node;
  }
  return event.target instanceof HTMLInputElement ? event.target : undefined;
}

/**
 * Installs capture-phase listeners. Returns a cleanup function; never throws
 * into page code.
 */
export function installFileCapture(
  queue: CapturedFileQueue,
  target: Window = window,
  shouldCapture: () => boolean = () => true,
): () => void {
  const onChange = (event: Event): void => {
    try {
      if (!shouldCapture()) return;
      const input = inputFromEvent(event);
      if (input?.type !== 'file') return;
      queue.addAll(input.files);
    } catch {
      // A capture failure must not break the page.
    }
  };

  const onDropOrPaste = (event: Event): void => {
    try {
      if (!shouldCapture()) return;
      const files = filesFromEvent(event);
      if (files) queue.addAll(files);
    } catch {
      // A capture failure must not break the page.
    }
  };

  target.addEventListener('change', onChange, true);
  target.addEventListener('drop', onDropOrPaste, true);
  target.addEventListener('paste', onDropOrPaste, true);

  return () => {
    target.removeEventListener('change', onChange, true);
    target.removeEventListener('drop', onDropOrPaste, true);
    target.removeEventListener('paste', onDropOrPaste, true);
  };
}
