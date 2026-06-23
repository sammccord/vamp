import Scheduler from "./scheduler";

/**
 * @class Action-based scheduler
 * @augments ROT.Scheduler
 */
export default class Action<T = any> extends Scheduler<T> {
  _defaultDuration: number;
  _duration: number;

  constructor() {
    super();
    this._defaultDuration = 1; /* for newly added */
    this._duration = this._defaultDuration; /* for this._current */
  }

  /**
   * @param {object} item
   * @param {bool} repeat
   * @param {number} [time=1]
   * @see ROT.Scheduler#add
   */
  add(item: T, repeat: boolean, time?: number) {
    this._queue.add(item, time !== undefined ? time : this._defaultDuration);
    return super.add(item, repeat);
  }

  clear() {
    this._duration = this._defaultDuration;
    return super.clear();
  }

  remove(item: T) {
    if (item == this._current) {
      this._duration = this._defaultDuration;
    }
    return super.remove(item);
  }

  /**
   * @see ROT.Scheduler#next
   */
  next() {
    if (this._current !== null && this._repeat.indexOf(this._current) != -1) {
      /* _duration is always a number (default 1, or whatever setDuration stored);
       * honor a legitimate 0-cost duration instead of coercing it to the default. */
      this._queue.add(this._current, this._duration);
      this._duration = this._defaultDuration;
    }
    return super.next();
  }

  /**
   * Set duration for the active item
   */
  setDuration(time: number) {
    if (this._current) {
      this._duration = time;
    }
    return this;
  }
}
