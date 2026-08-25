import { describe, expect, test } from "bun:test";
import {
  pcm16FrameByteLength,
  VIVA_AUDIO_SAMPLE_RATE_HZ,
  VIVA_PCM16_BYTES_PER_SAMPLE,
  type VivaAudioCaptureEndReason,
  type VivaAudioCaptureSampleFrame,
  type VivaAudioCaptureSource,
} from "@/agent/shared-web";
import {
  createMobileCaptureSession,
  MOBILE_CAPTURE_FRAME_BYTE_LENGTH,
  MOBILE_CAPTURE_MAX_TURN_FRAMES,
} from "@/audio/capture";

const FRAME_BYTE_LENGTH = pcm16FrameByteLength({ sampleRateHz: VIVA_AUDIO_SAMPLE_RATE_HZ });
const FRAME_SAMPLE_LENGTH = FRAME_BYTE_LENGTH / VIVA_PCM16_BYTES_PER_SAMPLE;

class FakeCaptureSource implements VivaAudioCaptureSource {
  readonly sampleRateHz = VIVA_AUDIO_SAMPLE_RATE_HZ;
  private callback:
    | ((samples: Float32Array, sampleRateHz: number, frame?: VivaAudioCaptureSampleFrame) => void)
    | null = null;
  private ended: ((reason: VivaAudioCaptureEndReason) => void) | null = null;
  stopCalls = 0;

  start(
    onSamples: (
      samples: Float32Array,
      sampleRateHz: number,
      frame?: VivaAudioCaptureSampleFrame,
    ) => void,
    options?: { onEnded?: (reason: VivaAudioCaptureEndReason) => void },
  ): void {
    this.callback = onSamples;
    this.ended = options?.onEnded ?? null;
  }

  stop(): void {
    this.stopCalls += 1;
    this.callback = null;
  }

  push(sampleValue = 0.5, rms = sampleValue, sampleRateHz = VIVA_AUDIO_SAMPLE_RATE_HZ): void {
    const samples = new Float32Array(FRAME_SAMPLE_LENGTH).fill(sampleValue);
    this.callback?.(samples, sampleRateHz, { rms, sampleRateHz, samples });
  }

  pushPartial(sampleCount: number, sampleValue = 0.5, rms = sampleValue): void {
    const samples = new Float32Array(sampleCount).fill(sampleValue);
    this.callback?.(samples, this.sampleRateHz, {
      rms,
      sampleRateHz: this.sampleRateHz,
      samples,
    });
  }

  end(reason: VivaAudioCaptureEndReason): void {
    this.callback = null;
    this.ended?.(reason);
  }
}

describe("createMobileCaptureSession", () => {
  test("keeps exact full PCM16 frames and a smoothed finite input level", async () => {
    const source = new FakeCaptureSource();
    const session = createMobileCaptureSession({
      meterOptions: { coefficient: 1, noiseFloor: 0, ceiling: 1 },
      source,
    });

    await session.start();
    source.push(0.5);
    source.push(0.25);

    expect(session.isActive()).toBe(true);
    expect(session.getFrames()).toHaveLength(2);
    expect(
      session.getFrames().every((frame) => frame.byteLength === MOBILE_CAPTURE_FRAME_BYTE_LENGTH),
    ).toBe(true);
    expect(Number.isFinite(session.getInputLevel())).toBe(true);
    expect(session.getInputLevel()).toBeCloseTo(0.25, 5);

    await session.stop();
    expect(session.isActive()).toBe(false);
    // Normal stop intentionally retains the full-frame ledger for the later
    // protocol-v5 turn owner.
    expect(session.getFrames()).toHaveLength(2);
  });

  test("enforces the learner-loop cap and retains at most the derived frame count", async () => {
    const source = new FakeCaptureSource();
    const session = createMobileCaptureSession({ source });

    await session.start();
    for (let index = 0; index < MOBILE_CAPTURE_MAX_TURN_FRAMES + 3; index += 1) {
      source.push(0.2);
    }

    expect(session.getFrames()).toHaveLength(MOBILE_CAPTURE_MAX_TURN_FRAMES);
    expect(session.isActive()).toBe(false);
    expect(source.stopCalls).toBe(1);
  });

  test("drops partial frames from the ledger while shared framing accumulates them", async () => {
    const source = new FakeCaptureSource();
    const session = createMobileCaptureSession({ source });

    await session.start();
    source.pushPartial(FRAME_SAMPLE_LENGTH - 1);
    source.pushPartial(1);

    expect(session.getFrames()).toHaveLength(1);
    expect(session.getFrames()[0]?.byteLength).toBe(FRAME_BYTE_LENGTH);
    await session.cancel();
  });

  test("clears the ledger and meter on cancel, reset, and teardown", async () => {
    const source = new FakeCaptureSource();
    const session = createMobileCaptureSession({
      meterOptions: { coefficient: 1, noiseFloor: 0, ceiling: 1 },
      source,
    });

    await session.start();
    source.push(0.75);
    expect(session.getFrames()).toHaveLength(1);
    expect(session.getInputLevel()).toBeGreaterThan(0);
    await session.cancel();
    expect(session.getFrames()).toHaveLength(0);
    expect(session.getInputLevel()).toBe(0);

    await session.start();
    source.push(0.5);
    await session.reset();
    expect(session.getFrames()).toHaveLength(0);
    expect(session.getInputLevel()).toBe(0);

    await session.start();
    source.push(0.5);
    await session.teardown();
    expect(session.getFrames()).toHaveLength(0);
    expect(session.getInputLevel()).toBe(0);
    expect(session.isActive()).toBe(false);
  });

  test("clears an abnormal source end and never exposes a transport callback", async () => {
    const source = new FakeCaptureSource();
    const ended: VivaAudioCaptureEndReason[] = [];
    const session = createMobileCaptureSession({
      onEnded: (reason) => ended.push(reason),
      source,
    });

    await session.start();
    source.push(0.5);
    source.end("processor_error");

    expect(ended).toEqual(["processor_error"]);
    expect(session.getFrames()).toHaveLength(0);
    expect(session.isActive()).toBe(false);
  });
});
