// Decides when the extension may start competing with the page's own video player for
// bandwidth, CPU and GPU. Kept separate from the DOM so it can be tested directly.
(function (root) {
  /**
   * @param {object} state  { readyState, paused, hasPlayed, bufferedAhead (seconds), adShowing }
   * @param {number} minBuffer  seconds of runway the player should have before we start
   *
   * A player is settled once it is past its cold start AND has a real buffer ahead of the
   * playhead. `paused` on its own is NOT enough: a player that has not started yet is also
   * paused, and that is the single worst moment to load a model or open a second stream --
   * it is what makes YouTube offer its "Experiencing interruptions?" prompt.
   */
  function playerSettled(state, minBuffer) {
    if (!state || state.adShowing) return false;
    // HAVE_FUTURE_DATA. Below this the player is still starting up.
    if (!(state.readyState >= 3)) return false;
    const ahead = Number.isFinite(state.bufferedAhead) ? state.bufferedAhead : 0;
    if (state.paused) {
      // Loaded but never started: whoever presses play is about to make the player fetch hard,
      // so this is not a steady state either. The caller's timeout covers a page left alone.
      if (!state.hasPlayed) return false;
      // Paused mid-watch: the player is not racing to fill a buffer, so less runway is enough.
      return ahead >= minBuffer / 2;
    }
    return ahead >= minBuffer;
  }
  const SILENT_PEAK = 1e-4;

  /**
   * True when the engine holds the page's audio but is emitting nothing, so the listener is
   * sitting in silence. Silence is always worse than the untouched original, so this is the
   * cue to hand the audio back.
   * @param {object} info  a level report from the playback worklet
   * @param {boolean} takeover  whether we currently hold the page's audio
   */
  function outputIsSilent(info, takeover) {
    if (!info || !takeover) return false;
    if (!info.playing || !info.hasBuffers) return false;
    return info.outPeak < SILENT_PEAK;
  }

  /**
   * Which side went quiet: the audio we read from the stores, or something after the mix.
   * The worklet reports both peaks precisely so these can be told apart.
   */
  function silenceCause(info) {
    return info && info.srcPeak >= SILENT_PEAK ? 'after-mix' : 'source';
  }

  /**
   * What silence read from the stores means. `mixPeak` and `instPeak` are the peak levels (0..1)
   * over the processed blocks around the listener.
   *   mix-silent  the mixture itself is silent there: true silence, or a gap that had to be filled
   *   inst-zero   the mixture has audio and the instrumental is exactly nothing: a failed inference
   *               stored as if finished (a GPU short of memory can fail without a word)
   *   inst-quiet  the instrumental is merely quiet: a real passage of vocals alone, for which
   *               silence is the right output and the page's audio would be the wrong one
   */
  function storeSilence(peaks) {
    if (!peaks) return 'mix-silent';
    // with per-block counts (green blocks, and those whose instrumental is exactly nothing where it
    // cannot be): an empty instrumental is told apart even when a few blocks around it are fine
    if (Number.isFinite(peaks.green) && Number.isFinite(peaks.zeroSuspect)) {
      if (peaks.green > 0 && peaks.zeroSuspect * 2 >= peaks.green) return 'inst-zero';
      return peaks.mixPeak >= SILENT_PEAK ? 'inst-quiet' : 'mix-silent';
    }
    if (!(peaks.mixPeak >= SILENT_PEAK)) return 'mix-silent';
    if (peaks.instPeak === 0) return 'inst-zero';
    return 'inst-quiet';
  }

  root.VRX = root.VRX || {};
  root.VRX.gate = { playerSettled, outputIsSilent, silenceCause, storeSilence, SILENT_PEAK };
})(typeof globalThis !== 'undefined' ? globalThis : self);
