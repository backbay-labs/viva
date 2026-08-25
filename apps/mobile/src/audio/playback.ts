import type { VivaAgentAudioOutput } from "@/agent/shared-web";
import {
  createVivaAudioPlaybackSink,
  type VivaAudioContextLike,
  type VivaAudioPlaybackSink,
} from "@/agent/shared-web";
import { createMobilePlaybackContextFactory } from "@/audio/playback-context";

export type MobilePlaybackDrainInput = {
  acknowledgeAudio: (consumed: readonly VivaAgentAudioOutput[]) => void;
  audio: readonly VivaAgentAudioOutput[];
  cancellations: readonly string[];
  handledCancel: number;
};

export type MobilePlaybackSession = {
  close: () => Promise<void>;
  drain: (input: MobilePlaybackDrainInput) => number;
  getOutputLevel: () => number;
  isActive: () => boolean;
  resetForGeneration: () => void;
  unlock: () => Promise<void>;
};

export function createMobilePlaybackSession(
  options: {
    contextFactory?: () => VivaAudioContextLike;
    onSpeakingChange?: (speaking: boolean) => void;
  } = {},
): MobilePlaybackSession {
  let active = false;
  const sink: VivaAudioPlaybackSink = createVivaAudioPlaybackSink({
    contextFactory: options.contextFactory ?? createMobilePlaybackContextFactory(),
    onStateChange: (state) => {
      active = state.responding || state.speaking;
      options.onSpeakingChange?.(active);
    },
  });

  return {
    close: () => sink.close(),
    drain(input) {
      // Cancellations must be applied before enqueueing new frames. A response
      // can be cancelled while its already-buffered audio is still in flight;
      // the shared sink records that response ID and rejects stale frames.
      for (const responseId of input.cancellations.slice(input.handledCancel)) {
        sink.cancel(responseId);
      }

      for (const output of input.audio) {
        sink.enqueue(output);
      }

      // Acknowledge the exact objects consumed by this drain. The controller
      // removes by identity, which keeps a concurrent cancellation from
      // dropping a frame belonging to a different response.
      if (input.audio.length > 0) {
        input.acknowledgeAudio(input.audio);
      }

      return input.cancellations.length;
    },
    getOutputLevel: () => sink.getOutputLevel(),
    isActive: () => active,
    resetForGeneration: () => {
      sink.resetForGeneration();
    },
    unlock: async () => {
      await sink.unlock();
    },
  };
}
