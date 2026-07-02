//@ts-nocheck

import * as Color from "./color";
import FOV from "./fov/fov";

type LightColor = [number, number, number];

/** Callback to retrieve cell reflectivity (0..1) */
interface ReflectivityCallback {
  (x: number, y: number): number;
}

/** Will be called for every lit cell */
interface LightingCallback {
  (x: number, y: number, color: LightColor): void;
}

const STRIDE = 1 << 16;

type LightingMap = Map<number, LightColor>;
type NumberMap = Map<number, number>;

interface Options {
  /** Number of passes. 1 equals to simple FOV of all light sources, >1 means a *highly simplified* radiosity-like algorithm. Default = 1 */
  passes: number;
  /** Cells with emissivity > threshold will be treated as light source in the next pass. Default = 100 */
  emissionThreshold: number;
  /** Max light range, default = 10 */
  range: number;
}

/**
 * Lighting computation, based on a traditional FOV for multiple light sources and multiple passes.
 */
export default class Lighting {
  private _reflectivityCallback: ReflectivityCallback;
  private _options!: Options;
  private _fov!: FOV;
  private _lights: LightingMap;
  private _reflectivityCache: NumberMap;
  private _fovCache: Map<number, NumberMap>;

  constructor(reflectivityCallback: ReflectivityCallback, options: Partial<Options> = {}) {
    this._reflectivityCallback = reflectivityCallback;
    this._options = {} as Options;
    options = Object.assign(
      {
        passes: 1,
        emissionThreshold: 100,
        range: 10,
      },
      options,
    );

    this._lights = new Map();
    this._reflectivityCache = new Map();
    this._fovCache = new Map();

    this.setOptions(options);
  }

  /**
   * Adjust options at runtime
   */
  setOptions(options: Partial<Options>) {
    Object.assign(this._options, options);
    if (options && options.range) {
      this.reset();
    }
    return this;
  }

  /**
   * Set the used Field-Of-View algo
   */
  setFOV(fov: FOV) {
    this._fov = fov;
    this._fovCache = new Map();
    return this;
  }

  /**
   * Set (or remove) a light source
   */
  setLight(x: number, y: number, color: null | string | LightColor) {
    let key = y * STRIDE + x;

    if (color) {
      this._lights.set(
        key,
        typeof color == "string" ? (Color.fromString(color) as LightColor) : color,
      );
    } else {
      this._lights.delete(key);
    }
    return this;
  }

  /**
   * Remove all light sources
   */
  clearLights() {
    this._lights = new Map();
  }

  /**
   * Reset the pre-computed topology values. Call whenever the underlying map changes its light-passability.
   */
  reset() {
    this._reflectivityCache = new Map();
    this._fovCache = new Map();

    return this;
  }

  /**
   * Compute the lighting
   */
  compute(lightingCallback: LightingCallback) {
    let doneCells: NumberMap = new Map();
    let emittingCells: LightingMap = new Map();
    let litCells: LightingMap = new Map();

    for (let [key, light] of this._lights) {
      /* prepare emitters for first pass */
      let emitting: LightColor = [0, 0, 0];
      emittingCells.set(key, emitting);
      Color.add_(emitting, light);
    }

    for (let i = 0; i < this._options.passes; i++) {
      /* main loop */
      this._emitLight(emittingCells, litCells, doneCells);
      if (i + 1 == this._options.passes) {
        continue;
      } /* not for the last pass */
      emittingCells = this._computeEmitters(litCells, doneCells);
    }

    for (let [litKey, color] of litCells) {
      /* let the user know what and how is lit */
      let x = litKey % STRIDE;
      let y = (litKey - x) / STRIDE;
      lightingCallback(x, y, color);
    }

    return this;
  }

  /**
   * Compute one iteration from all emitting cells
   * @param emittingCells These emit light
   * @param litCells Add projected light to these
   * @param doneCells These already emitted, forbid them from further calculations
   */
  private _emitLight(emittingCells: LightingMap, litCells: LightingMap, doneCells: NumberMap) {
    for (let [key, color] of emittingCells) {
      let x = key % STRIDE;
      let y = (key - x) / STRIDE;
      this._emitLightFromCell(x, y, color, litCells);
      doneCells.set(key, 1);
    }
    return this;
  }

  /**
   * Prepare a list of emitters for next pass
   */
  private _computeEmitters(litCells: LightingMap, doneCells: NumberMap) {
    let result: LightingMap = new Map();

    for (let [key, color] of litCells) {
      if (doneCells.has(key)) {
        continue;
      } /* already emitted */

      let reflectivity;
      if (this._reflectivityCache.has(key)) {
        reflectivity = this._reflectivityCache.get(key);
      } else {
        let x = key % STRIDE;
        let y = (key - x) / STRIDE;
        reflectivity = this._reflectivityCallback(x, y);
        this._reflectivityCache.set(key, reflectivity);
      }

      if (reflectivity == 0) {
        continue;
      } /* will not reflect at all */

      /* compute emission color */
      let emission: LightColor = [0, 0, 0];
      let intensity = 0;
      for (let i = 0; i < 3; i++) {
        let part = Math.round(color[i] * reflectivity);
        emission[i] = part;
        intensity += part;
      }
      if (intensity > this._options.emissionThreshold) {
        result.set(key, emission);
      }
    }

    return result;
  }

  /**
   * Compute one iteration from one cell
   */
  private _emitLightFromCell(x: number, y: number, color: LightColor, litCells: LightingMap) {
    let key = y * STRIDE + x;
    let fov: NumberMap;
    if (this._fovCache.has(key)) {
      fov = this._fovCache.get(key);
    } else {
      fov = this._updateFOV(x, y);
    }

    for (let [fovKey, formFactor] of fov) {
      let result: LightColor;
      if (litCells.has(fovKey)) {
        /* already lit */
        result = litCells.get(fovKey);
      } else {
        /* newly lit */
        result = [0, 0, 0];
        litCells.set(fovKey, result);
      }

      for (let i = 0; i < 3; i++) {
        result[i] += Math.round(color[i] * formFactor);
      } /* add light color */
    }

    return this;
  }

  /**
   * Compute FOV ("form factor") for a potential light source at [x,y]
   */
  private _updateFOV(x: number, y: number) {
    let key1 = y * STRIDE + x;
    let cache: NumberMap = new Map();
    this._fovCache.set(key1, cache);
    let range = this._options.range;
    function cb(x: number, y: number, r: number, vis: number) {
      let key2 = y * STRIDE + x;
      let formFactor = vis * (1 - r / range);
      if (formFactor == 0) {
        return;
      }
      cache.set(key2, formFactor);
    }
    this._fov.compute(x, y, range, cb.bind(this));

    return cache;
  }
}
