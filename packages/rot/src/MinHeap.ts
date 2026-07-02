//@ts-nocheck

export interface HeapWrapper<T> {
  key: number;
  timestamp: number;
  value: T;
}

export class MinHeap<T> {
  private heap: HeapWrapper<T>[];
  private timestamp: number;
  constructor() {
    this.heap = [];
    this.timestamp = 0;
  }
  lessThan(a: HeapWrapper<T>, b: HeapWrapper<T>) {
    return a.key == b.key ? a.timestamp < b.timestamp : a.key < b.key;
  }
  len() {
    return this.heap.length;
  }
  push(value: T, key: number) {
    this.timestamp += 1;
    const loc = this.len();
    this.heap.push({ value, timestamp: this.timestamp, key });
    this.updateUp(loc);
  }
  pop(): HeapWrapper<T> {
    if (this.len() == 0) {
      throw new Error("no element to pop");
    }
    const top = this.heap[0];
    if (this.len() > 1) {
      this.heap[0] = this.heap.pop() as HeapWrapper<T>;
      this.updateDown(0);
    } else {
      this.heap.pop();
    }
    return top;
  }
  find(v: T): HeapWrapper<T> | null {
    for (let i = 0; i < this.len(); i++) {
      if (v == this.heap[i].value) {
        return this.heap[i];
      }
    }
    return null;
  }
  remove(v: T) {
    // Find the FIRST matching element (stop on first hit so the index we act on
    // is the one we will overwrite; avoids the duplicate-value drop).
    let index = -1;
    for (let i = 0; i < this.len(); i++) {
      if (v == this.heap[i].value) {
        index = i;
        break;
      }
    }
    if (index < 0) {
      return false;
    }

    // Move the last element into the freed slot. If the removed element WAS the
    // last slot, popping it already removed it and there is nothing to re-place.
    const last = this.heap.pop() as HeapWrapper<T>;
    if (index < this.len()) {
      this.heap[index] = last;
      // The moved element may be out of order relative to its parent OR its
      // children. Sift both ways; at most one direction does any work.
      this.updateUp(index);
      this.updateDown(index);
    }

    return true;
  }
  private parentNode(x: number): number {
    return Math.floor((x - 1) / 2);
  }
  private leftChildNode(x: number): number {
    return 2 * x + 1;
  }
  private rightChildNode(x: number): number {
    return 2 * x + 2;
  }
  private existNode(x: number): boolean {
    return x >= 0 && x < this.heap.length;
  }
  private swap(x: number, y: number) {
    const t = this.heap[x];
    this.heap[x] = this.heap[y];
    this.heap[y] = t;
  }
  private updateUp(x: number) {
    if (x == 0) {
      return;
    }
    const parent = this.parentNode(x);
    if (this.existNode(parent) && this.lessThan(this.heap[x], this.heap[parent])) {
      this.swap(x, parent);
      this.updateUp(parent);
    }
  }
  private updateDown(x: number) {
    const l = this.leftChildNode(x);
    const r = this.rightChildNode(x);
    if (!this.existNode(l)) {
      return; /* no children → done */
    }
    // 3-way min inline: x vs the smaller of l / r. No array/bind allocation.
    let m = l;
    if (this.existNode(r) && this.lessThan(this.heap[r], this.heap[l])) {
      m = r;
    }
    if (this.lessThan(this.heap[m], this.heap[x])) {
      this.swap(x, m);
      this.updateDown(m);
    }
  }
}
