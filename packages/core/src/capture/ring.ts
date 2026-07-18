// A bounded FIFO buffer — the last `max` items. All the continuous capture streams (console, network,
// actions) are rings so memory stays flat no matter how long a page stays open.
export class Ring<T> {
  private buf: T[] = []
  constructor(private max: number) {}
  push(x: T): void {
    this.buf.push(x)
    if (this.buf.length > this.max) this.buf.splice(0, this.buf.length - this.max)
  }
  all(): T[] {
    return this.buf.slice()
  }
  get size(): number {
    return this.buf.length
  }
  clear(): void {
    this.buf = []
  }
}
