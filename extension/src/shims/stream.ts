/**
 * Tiny browser shim for Node's `stream` module, used only by word-extractor's
 * OLE sector reader. It implements the subset that `StorageStream` needs:
 * a `Readable` base class with `_read()`/`push()` and `data`/`end`/`error`
 * listeners. Reads are strictly serialized: a second `_read()` must not run
 * before the previous sector promise resolves, otherwise the sector cursor
 * interleaves and the piece table is corrupted.
 */

type Listener = (...args: unknown[]) => void;

export class Readable {
  private readonly listeners = new Map<string, Listener[]>();
  private started = false;
  private ended = false;
  private pushedInRead = false;

  on(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (list) list.push(listener);
    else this.listeners.set(event, [listener]);

    if (event === 'data') this.start();
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapped: Listener = (...args) => {
      this.off(event, wrapped);
      listener(...args);
    };
    return this.on(event, wrapped);
  }

  off(event: string, listener: Listener): this {
    const list = this.listeners.get(event);
    if (!list) return this;
    const index = list.indexOf(listener);
    if (index >= 0) list.splice(index, 1);
    return this;
  }

  removeListener(event: string, listener: Listener): this {
    return this.off(event, listener);
  }

  emit(event: string, ...args: unknown[]): boolean {
    const list = this.listeners.get(event);
    if (!list || list.length === 0) return false;
    for (const listener of [...list]) listener(...args);
    return true;
  }

  push(chunk: unknown): boolean {
    if (chunk === null) {
      this.ended = true;
      this.emit('end');
      return false;
    }
    this.pushedInRead = true;
    this.emit('data', chunk);
    return true;
  }

  private start(): void {
    if (this.started) return;
    this.started = true;
    // All three listeners (data/error/end) are registered synchronously by
    // the caller before the first microtask runs.
    queueMicrotask(() => {
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    while (!this.ended) {
      this.pushedInRead = false;
      try {
        const result = (this as unknown as { _read?: () => unknown })._read?.();
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          await (result as Promise<unknown>);
        }
      } catch (error) {
        this.ended = true;
        this.emit('error', error);
        return;
      }

      // A custom _read that neither pushes nor ends would spin forever.
      if (!this.pushedInRead && !this.ended) {
        this.ended = true;
        this.emit('error', new Error('Readable: _read() made no progress'));
        return;
      }
    }
  }
}

export default { Readable };
