//@ts-nocheck

import Path, { type ComputeCallback, type PassableCallback, type Options } from "./path";

interface Item {
  x: number;
  y: number;
  prev: Item | null;
}

/* Stride used to derive a collision-free numeric cell key from (x, y) when no
 * explicit map width is supplied. Cells are assumed non-negative and below this
 * bound (matching upstream map sizes); an explicit `width` in Options is exact. */
const KEY_STRIDE = 1 << 16;

/**
 * @class Simplified Dijkstra's algorithm: all edges have a value of 1
 * @augments ROT.Path
 * @see ROT.Path
 */
export default class Dijkstra extends Path {
  _computed: Map<number, Item>;
  _todo: Item[];
  _todoIndex: number;
  _keyStride: number;

  constructor(
    toX: number,
    toY: number,
    passableCallback: PassableCallback,
    options: Partial<Options>,
  ) {
    super(toX, toY, passableCallback, options);

    this._computed = new Map();
    this._todo = [];
    this._todoIndex = 0;
    /* prefer an explicit map width for exact, collision-free cell keys */
    this._keyStride =
      this._options.width && this._options.width > 0 ? this._options.width : KEY_STRIDE;
    this._add(toX, toY, null);
  }

  _key(x: number, y: number) {
    return y * this._keyStride + x;
  }

  /**
   * Compute a path from a given point
   * @see ROT.Path#compute
   */
  compute(fromX: number, fromY: number, callback: ComputeCallback) {
    let key = this._key(fromX, fromY);
    if (!this._computed.has(key)) {
      this._compute(fromX, fromY);
    }
    if (!this._computed.has(key)) {
      return;
    }

    let item: Item | null = this._computed.get(key);
    while (item) {
      callback(item.x, item.y);
      item = item.prev;
    }
  }

  /**
   * Compute a non-cached value
   */
  _compute(fromX: number, fromY: number) {
    while (this._todoIndex < this._todo.length) {
      let item = this._todo[this._todoIndex++];
      if (item.x == fromX && item.y == fromY) {
        return;
      }

      let neighbors = this._getNeighbors(item.x, item.y);

      for (let i = 0; i < neighbors.length; i++) {
        let neighbor = neighbors[i];
        let x = neighbor[0];
        let y = neighbor[1];
        if (this._computed.has(this._key(x, y))) {
          continue;
        } /* already done */
        this._add(x, y, item);
      }
    }
  }

  _add(x: number, y: number, prev: Item | null) {
    let obj = {
      x: x,
      y: y,
      prev: prev,
    };
    this._computed.set(this._key(x, y), obj);
    this._todo.push(obj);
  }
}
