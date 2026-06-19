/**
 * Client-side voice amplitude — the signal that lets the manuscript "breathe with
 * the voice". Pure, dependency-free, and rate-independent: RMS over a buffer of
 * float samples, an exponential smoother to kill strobing, and a gain curve that
 * maps the small RMS of speech onto a 0..1 bloom level.
 *
 * This is a CLIENT-ONLY signal — it never crosses the WebSocket (the agent emits
 * meaning; the page owns presence).
 */

export type VoiceLevelOptions = {
  /** RMS at/below which the level reads as silence. */
  noiseFloor?: number;
  /** RMS at/above which the level saturates to 1. */
  ceiling?: number;
};

export type VoiceLevelMeterOptions = VoiceLevelOptions & {
  /** Exponential smoothing factor in [0,1]; higher reacts faster. */
  coefficient?: number;
};

export type VoiceLevelMeter = {
  push: (samples: ArrayLike<number>) => number;
  pushRms: (rms: number) => number;
  get: () => number;
  reset: () => void;
};

const DEFAULT_NOISE_FLOOR = 0.02;
const DEFAULT_CEILING = 0.2;
const DEFAULT_COEFFICIENT = 0.25;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

export function computeRms(samples: ArrayLike<number>): number {
  const length = samples.length;
  if (length === 0) return 0;
  let sumOfSquares = 0;
  for (let index = 0; index < length; index += 1) {
    const sample = samples[index];
    if (!Number.isFinite(sample)) continue;
    sumOfSquares += sample * sample;
  }
  return Math.sqrt(sumOfSquares / length);
}

export function smoothLevel(previous: number, next: number, coefficient: number): number {
  const factor = clamp01(coefficient);
  return previous + (next - previous) * factor;
}

export function voiceLevelFromRms(rms: number, options: VoiceLevelOptions = {}): number {
  const noiseFloor = options.noiseFloor ?? DEFAULT_NOISE_FLOOR;
  const ceiling = options.ceiling ?? DEFAULT_CEILING;
  if (!Number.isFinite(rms) || ceiling <= noiseFloor) return 0;
  return clamp01((rms - noiseFloor) / (ceiling - noiseFloor));
}

export function createVoiceLevelMeter(options: VoiceLevelMeterOptions = {}): VoiceLevelMeter {
  const coefficient = options.coefficient ?? DEFAULT_COEFFICIENT;
  let level = 0;
  function pushTargetRms(rms: number): number {
    const target = voiceLevelFromRms(rms, options);
    level = smoothLevel(level, target, coefficient);
    return level;
  }
  return {
    push(samples) {
      return pushTargetRms(computeRms(samples));
    },
    pushRms(rms) {
      return pushTargetRms(rms);
    },
    get() {
      return level;
    },
    reset() {
      level = 0;
    },
  };
}
