//@ts-nocheck

import { MinHeap } from "../MinHeap";
import Path, { type ComputeCallback, type PassableCallback, type Options } from "./path";

interface Item {
  x: number;
  y: number;
  g: number;
  h: number;
  prev: Item | null;
}

/* Stride used to fold the heuristic `h` into the heap key so the open-set
 * ordering exactly matches the old sorted-array: primary by f = g + h, then by
 * h (lower h first), then by insertion order (the heap's timestamp tie-break).
 * `f` increases in steps of >= 0.5 (topology 6), so a large multiplier keeps the
 * f-component dominant over any realistic h. */
const H_STRIDE = 1 << 20;

/* Stride used to derive a collision-free numeric cell key from (x, y) when no
 * explicit map width is supplied. Cells are assumed non-negative and below this
 * bound (matching upstream map sizes); an explicit `width` in Options is exact. */
const KEY_STRIDE = 1 << 16;

/**
 * @class Simplified A* algorithm: all edges have a value of 1
 * @augments ROT.Path
 * @see ROT.Path
 */
export default class AStar extends Path {
  _open: MinHeap<Item>;
  _done: Map<number, Item>;
  _fromX!: number;
  _fromY!: number;
  _keyStride: number;

  constructor(
    toX: number,
    toY: number,
    passableCallback: PassableCallback,
    options: Partial<Options> = {},
  ) {
    super(toX, toY, passableCallback, options);

    this._open = new MinHeap<Item>();
    this._done = new Map();
    /* prefer an explicit map width for exact, collision-free cell keys */
    this._keyStride =
      this._options.width && this._options.width > 0 ? this._options.width : KEY_STRIDE;
  }

  _key(x: number, y: number) {
    return y * this._keyStride + x;
  }

  /**
   * Compute a path from a given point
   * @see ROT.Path#compute
   */
  compute(fromX: number, fromY: number, callback: ComputeCallback) {
    this._open = new MinHeap<Item>();
    this._done = new Map();
    this._fromX = fromX;
    this._fromY = fromY;
    this._add(this._toX, this._toY, null);

    while (this._open.len()) {
      let item = this._open.pop().value as Item;
      let id = this._key(item.x, item.y);
      if (this._done.has(id)) {
        continue;
      }
      this._done.set(id, item);
      if (item.x == fromX && item.y == fromY) {
        break;
      }

      let neighbors = this._getNeighbors(item.x, item.y);

      for (let i = 0; i < neighbors.length; i++) {
        let neighbor = neighbors[i];
        let x = neighbor[0];
        let y = neighbor[1];
        if (this._done.has(this._key(x, y))) {
          continue;
        }
        this._add(x, y, item);
      }
    }

    let item: Item | null = this._done.get(this._key(fromX, fromY)) ?? null;
    if (!item) {
      return;
    }

    while (item) {
      callback(item.x, item.y);
      item = item.prev;
    }
  }

  _add(x: number, y: number, prev: Item | null) {
    let h = this._distance(x, y);
    let obj: Item = {
      x: x,
      y: y,
      prev: prev,
      g: prev ? prev.g + 1 : 0,
      h: h,
    };

    /* insert into priority queue; key folds f (primary) and h (secondary) so the
     * pop order matches the old sorted-array (f asc, then h asc, then FIFO). */
    let f = obj.g + obj.h;
    this._open.push(obj, f * H_STRIDE + h);
  }

  _distance(x: number, y: number) {
    switch (this._options.topology) {
      case 4:
        return Math.abs(x - this._fromX) + Math.abs(y - this._fromY);

      case 6: {
        let dx = Math.abs(x - this._fromX);
        let dy = Math.abs(y - this._fromY);
        return dy + Math.max(0, (dx - dy) / 2);
      }

      case 8:
        return Math.max(Math.abs(x - this._fromX), Math.abs(y - this._fromY));

      default:
        throw new Error("Illegal topology " + String(this._options.topology));
    }
  }
}
