import { MinHeap } from "./MinHeap";

export default class EventQueue<T = any> {
  _time: number;
  _events: MinHeap<T>;

  /**
   * @class Generic event queue: stores events and retrieves them based on their time
   */
  constructor() {
    this._time = 0;
    this._events = new MinHeap();
  }

  /**
   * @returns {number} Elapsed time
   */
  getTime() {
    return this._time;
  }

  /**
   * Clear all scheduled events
   */
  clear() {
    this._events = new MinHeap();
    return this;
  }

  /**
   * @param {?} event
   * @param {number} time - Delay relative to the current queue time.
   *
   * Stored internally as an absolute timestamp (`_time + time`) so advancing
   * the clock in {@link get} is O(1) instead of rekeying the whole heap.
   */
  add(event: T, time: number) {
    this._events.push(event, this._time + time);
  }

  /**
   * Locates the nearest event, advances time if necessary. Returns that event and removes it from the queue.
   * @returns {? || null} The event previously added by addEvent, null if no event available
   */
  get() {
    if (!this._events.len()) {
      return null;
    }

    const { key: time, value: event } = this._events.pop();
    if (time > this._time) {
      /* advance */
      this._time = time;
    }

    return event;
  }

  /**
   * Get the time remaining until the given event fires
   * @param {?} event
   * @returns {number} time
   */
  getEventTime(event: T) {
    const r = this._events.find(event);
    if (r) {
      return r.key - this._time;
    }
    return undefined;
  }

  /**
   * Remove an event from the queue
   * @param {?} event
   * @returns {bool} success?
   */
  remove(event: T) {
    return this._events.remove(event);
  }
}
