/*
 * Vocal Remover for YouTube — UI module (classic content script, no modules).
 *
 * Exposes exactly one global:
 *   globalThis.VRX_UI = { createPanel, createSeekbarOverlay, formatTime }
 *
 * Plain DOM only. Every class is prefixed "vrx-" so nothing collides with
 * YouTube's styles, and all text goes through textContent (never innerHTML).
 * setState()/update() are called several times per second, so element refs
 * are cached and the DOM is only touched when a value actually changed.
 */
(function () {
  'use strict';

  const SVG_NS = 'http://www.w3.org/2000/svg';
  const MINUS = '−';        // real minus sign, not a hyphen
  const TIMES = '×';        // multiplication sign for "3.2× realtime"
  const DOT = ' · ';        // " · " separator
  const SEMITONE_LIMIT = 7;

  const QUALITY_OPTIONS = [
    { id: 'balanced', label: 'Balanced (faster)' },
    { id: 'high', label: 'High (slower, 2 passes)' }
  ];

  // Words shown in the status pill per phase. 'processing' gets a percentage
  // appended and 'ready' becomes "From cache" when state.fromCache is set.
  const PHASE_LABELS = {
    off: 'Off',
    idle: 'Idle',
    starting: 'Starting',
    capturing: 'Fetching audio',
    decoding: 'Decoding',
    processing: 'Processing',
    ready: 'Ready',
    error: 'Error',
    unsupported: 'Unsupported'
  };

  /* ------------------------------------------------------------------ */
  /* Helpers                                                             */
  /* ------------------------------------------------------------------ */

  function isNum(v) {
    return typeof v === 'number' && isFinite(v);
  }

  function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
  }

  function pad2(n) {
    return n < 10 ? '0' + n : String(n);
  }

  /** Create an HTML element with an optional class list and text. */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  /** Create an SVG element with attributes. */
  function svg(tag, attrs) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const name in attrs) node.setAttribute(name, attrs[name]);
    return node;
  }

  /** Run an optional callback; a throwing handler must never break the UI. */
  function call(fn, arg) {
    if (typeof fn !== 'function') return;
    try {
      fn(arg);
    } catch (err) {
      console.error('[VRX UI] callback failed:', err);
    }
  }

  /** formatTime(65) → "1:05", formatTime(3725) → "1:02:05"; bad input → "0:00". */
  function formatTime(seconds) {
    const total = isNum(seconds) && seconds > 0 ? Math.floor(seconds) : 0;
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? h + ':' + pad2(m) + ':' + pad2(s) : m + ':' + pad2(s);
  }

  /**
   * Seconds covered by a [[start, end], ...] list, clipped to [0, duration]
   * (matching what the strip draws). Malformed entries are ignored.
   */
  function sumRanges(ranges, duration) {
    if (!Array.isArray(ranges)) return 0;
    let total = 0;
    for (let i = 0; i < ranges.length; i++) {
      const r = ranges[i];
      if (!r || !isNum(r[0]) || !isNum(r[1])) continue;
      const s = clamp(r[0], 0, duration);
      const e = clamp(r[1], 0, duration);
      if (e > s) total += e - s;
    }
    return total;
  }

  /** Whole-number percent of the video whose vocals are removed, or null. */
  function processedPercent(state) {
    const d = state.duration;
    if (!isNum(d) || d <= 0) return null;
    return clamp(Math.round((sumRanges(state.processed, d) / d) * 100), 0, 100);
  }

  /** Text for the status pill, e.g. "Processing 42%". */
  function pillText(state, phase, percent) {
    if (phase === 'processing') {
      return percent == null ? 'Processing' : 'Processing ' + percent + '%';
    }
    if (phase === 'ready' && state.fromCache) return 'From cache';
    return PHASE_LABELS[phase] || phase;
  }

  /** Right-hand status text, e.g. "WebGPU · 3.2× realtime". */
  function metaText(state) {
    let text = state.backend ? String(state.backend) : '';
    if (isNum(state.speed) && state.speed > 0) {
      const speed = state.speed >= 10 ? String(Math.round(state.speed)) : state.speed.toFixed(1);
      text += (text ? DOT : '') + speed + TIMES + ' realtime';
    }
    return text;
  }

  /* ------------------------------------------------------------------ */
  /* Range layer: [[start, end], ...] → absolutely positioned children    */
  /* ------------------------------------------------------------------ */

  /**
   * Renders time ranges as children of `parent` using left/width percentages.
   * Children are pooled and reused, and a child's style is only written when
   * its geometry changed. Ranges that touch (gap below 0.1 % of the duration,
   * i.e. sub-pixel) are merged so chunked input does not create many nodes.
   */
  function createRangeLayer(parent, className) {
    const slots = []; // { node, left, width, shown }

    function place(index, start, end, duration) {
      let slot = slots[index];
      if (!slot) {
        slot = { node: el('div', className), left: '', width: '', shown: true };
        parent.appendChild(slot.node);
        slots[index] = slot;
      }
      const left = ((start / duration) * 100).toFixed(3) + '%';
      const width = (((end - start) / duration) * 100).toFixed(3) + '%';
      if (slot.left !== left) {
        slot.node.style.left = left;
        slot.left = left;
      }
      if (slot.width !== width) {
        slot.node.style.width = width;
        slot.width = width;
      }
      if (!slot.shown) {
        slot.node.style.display = '';
        slot.shown = true;
      }
      return index + 1;
    }

    function update(ranges, duration) {
      let used = 0;
      if (Array.isArray(ranges) && isNum(duration) && duration > 0) {
        const eps = duration * 0.001;
        let open = false;
        let curStart = 0;
        let curEnd = 0;
        for (let i = 0; i < ranges.length; i++) {
          const r = ranges[i];
          if (!r || !isNum(r[0]) || !isNum(r[1])) continue;
          const s = clamp(r[0], 0, duration);
          const e = clamp(r[1], 0, duration);
          if (e <= s) continue;
          if (open && s <= curEnd + eps) {
            if (e > curEnd) curEnd = e; // extend the current run
            continue;
          }
          if (open) used = place(used, curStart, curEnd, duration);
          curStart = s;
          curEnd = e;
          open = true;
        }
        if (open) used = place(used, curStart, curEnd, duration);
      }
      // Hide pooled children that are not needed this time.
      for (let i = used; i < slots.length; i++) {
        const slot = slots[i];
        if (slot.shown) {
          slot.node.style.display = 'none';
          slot.shown = false;
        }
      }
    }

    return { update: update };
  }

  /* ------------------------------------------------------------------ */
  /* Icon: microphone with a slash (18 px, stroke = currentColor)         */
  /* ------------------------------------------------------------------ */

  function createIcon() {
    const node = svg('svg', {
      class: 'vrx-icon',
      viewBox: '0 0 24 24',
      width: '18',
      height: '18',
      'aria-hidden': 'true',
      focusable: 'false'
    });
    const g = svg('g', {
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round'
    });
    g.appendChild(svg('rect', { x: '9', y: '3', width: '6', height: '11', rx: '3' })); // capsule
    g.appendChild(svg('path', { d: 'M5 11a7 7 0 0 0 14 0' }));                        // cradle
    g.appendChild(svg('path', { d: 'M12 18v3M8 21h8' }));                              // stand + base
    g.appendChild(svg('path', { d: 'M4 4l16 16' }));                                   // slash
    node.appendChild(g);
    return node;
  }

  /* ------------------------------------------------------------------ */
  /* Control panel                                                       */
  /* ------------------------------------------------------------------ */

  function createPanel(options) {
    const opts = options || {};
    const on = opts.on || {};
    const models = Array.isArray(opts.models) ? opts.models : [];

    // What the controls currently show; kept so user actions can report
    // absolute values and so setSettings() can be partial.
    const current = { enabled: false, vocalLevel: 0, semitones: 0, modelId: '', quality: 'balanced' };
    let destroyed = false;
    let lastMount = opts.mount || null;

    /* ---- header: icon, title, status pill, power switch ---- */
    const root = el('div', 'vrx-panel vrx-disabled');
    root.setAttribute('data-phase', 'off');

    const header = el('div', 'vrx-header');
    const title = el('span', 'vrx-title', 'Vocal Remover');
    const pill = el('span', 'vrx-pill', 'Off');
    pill.setAttribute('data-phase', 'off');

    const toggle = el('button', 'vrx-switch');
    toggle.type = 'button';
    toggle.setAttribute('role', 'switch');
    toggle.setAttribute('aria-checked', 'false');
    toggle.setAttribute('aria-label', 'Vocal Remover');
    toggle.title = 'Turn Vocal Remover on or off';
    toggle.appendChild(el('span', 'vrx-switch-knob'));
    header.append(createIcon(), title, el('span', 'vrx-spacer'), pill, toggle);

    /* ---- progress strip: captured / decoded / processed + playhead ---- */
    const strip = el('div', 'vrx-strip');
    strip.setAttribute('role', 'progressbar');
    strip.setAttribute('aria-label', 'Vocal removal progress');
    strip.setAttribute('aria-valuemin', '0');
    strip.setAttribute('aria-valuemax', '100');
    strip.setAttribute('aria-valuenow', '0');
    const capturedLayer = createRangeLayer(strip, 'vrx-range vrx-captured');
    const decodedLayer = createRangeLayer(strip, 'vrx-range vrx-decoded');
    const processedLayer = createRangeLayer(strip, 'vrx-range vrx-processed');
    const playhead = el('div', 'vrx-playhead');
    playhead.style.display = 'none';
    strip.appendChild(playhead);

    /* ---- status line: message / detail, retry, backend · speed ---- */
    const status = el('div', 'vrx-status');
    const statusText = el('div', 'vrx-status-text');
    const message = el('div', 'vrx-message');
    const detail = el('div', 'vrx-detail');
    detail.hidden = true;
    statusText.append(message, detail);
    const retry = el('button', 'vrx-retry', 'Retry');
    retry.type = 'button';
    retry.hidden = true;
    retry.title = 'Try again';
    const meta = el('div', 'vrx-meta');
    status.append(statusText, retry, meta);

    /* ---- controls row ---- */
    const controls = el('div', 'vrx-controls');

    // Vocals slider (0 = vocals removed, 100 = original mix)
    const vocalsWrap = el('label', 'vrx-control vrx-vocals');
    const vocalsLabel = el('span', 'vrx-label vrx-vocals-label', 'Vocals');
    const slider = el('input', 'vrx-slider');
    slider.type = 'range';
    slider.min = '0';
    slider.max = '100';
    slider.step = '1';
    slider.value = '0';
    slider.title = 'How much of the original vocals to keep: 0% removes them, 100% is the original mix';
    vocalsWrap.append(vocalsLabel, slider);

    // Transpose stepper: [−] value [+] Reset
    const transposeWrap = el('div', 'vrx-control vrx-transpose');
    transposeWrap.setAttribute('role', 'group');
    transposeWrap.setAttribute('aria-label', 'Transpose');
    const stepper = el('div', 'vrx-stepper');
    const down = el('button', 'vrx-step vrx-step-down', MINUS);
    down.type = 'button';
    down.title = 'Down one semitone';
    down.setAttribute('aria-label', 'Transpose down one semitone');
    const value = el('span', 'vrx-value', '0');
    value.title = 'Pitch shift in semitones';
    value.setAttribute('aria-live', 'polite');
    const up = el('button', 'vrx-step vrx-step-up', '+');
    up.type = 'button';
    up.title = 'Up one semitone';
    up.setAttribute('aria-label', 'Transpose up one semitone');
    const reset = el('button', 'vrx-text-btn vrx-reset', 'Reset');
    reset.type = 'button';
    reset.title = 'Back to the original key';
    reset.hidden = true;
    stepper.append(down, value, up, reset);
    transposeWrap.append(el('span', 'vrx-label', 'Transpose'), stepper);

    // Model select
    const modelWrap = el('label', 'vrx-control vrx-model');
    const modelSelect = el('select', 'vrx-select vrx-model-select');
    modelSelect.title = 'AI model that separates the vocals from the instrumental. If a track sounds odd, try another one.';
    const modelIds = new Set();
    for (let i = 0; i < models.length; i++) {
      const m = models[i];
      if (!m || m.id == null) continue;
      const id = String(m.id);
      const option = el('option', null, m.label != null ? String(m.label) : id);
      option.value = id;
      option.title = option.textContent;
      modelSelect.appendChild(option);
      modelIds.add(id);
    }
    if (modelIds.size === 0) {
      const option = el('option', null, 'No models available');
      option.value = '';
      modelSelect.appendChild(option);
      modelSelect.disabled = true;
    }
    modelWrap.append(el('span', 'vrx-label', 'Model'), modelSelect);

    // Quality select
    const qualityWrap = el('label', 'vrx-control vrx-quality');
    const qualitySelect = el('select', 'vrx-select vrx-quality-select');
    qualitySelect.title = 'Balanced: one pass, faster. High: two passes with shifted windows, slower but cleaner.';
    for (let i = 0; i < QUALITY_OPTIONS.length; i++) {
      const option = el('option', null, QUALITY_OPTIONS[i].label);
      option.value = QUALITY_OPTIONS[i].id;
      qualitySelect.appendChild(option);
    }
    qualityWrap.append(el('span', 'vrx-label', 'Quality'), qualitySelect);

    const clearCache = el('button', 'vrx-text-btn vrx-clear-cache', 'Clear cache');
    clearCache.type = 'button';
    clearCache.title = 'Forget the processed audio kept for this session';

    controls.append(vocalsWrap, transposeWrap, modelWrap, qualityWrap, clearCache);
    root.append(header, strip, status, controls);

    /* ---- reflect settings (no callbacks) ---- */

    function applyEnabled(enabled) {
      current.enabled = !!enabled;
      toggle.setAttribute('aria-checked', current.enabled ? 'true' : 'false');
      root.classList.toggle('vrx-disabled', !current.enabled);
      controls.setAttribute('aria-disabled', current.enabled ? 'false' : 'true');
    }

    function applyVocalLevel(level) {
      const pct = clamp(Math.round(level * 100), 0, 100);
      current.vocalLevel = pct / 100;
      const str = String(pct);
      if (slider.value !== str) slider.value = str;
      slider.setAttribute('aria-valuetext', pct + '% of original vocals');
      vocalsLabel.textContent =
        pct === 0 ? 'Vocals 0% (removed)' :
        pct === 100 ? 'Vocals 100% (original)' :
        'Vocals ' + pct + '%';
    }

    function applySemitones(semitones) {
      const n = clamp(Math.round(semitones), -SEMITONE_LIMIT, SEMITONE_LIMIT);
      current.semitones = n;
      value.textContent = n > 0 ? '+' + n : n < 0 ? MINUS + (-n) : '0';
      down.disabled = n <= -SEMITONE_LIMIT;
      up.disabled = n >= SEMITONE_LIMIT;
      reset.hidden = n === 0;
    }

    function applyModel(id) {
      const wanted = String(id);
      if (!modelIds.has(wanted)) return; // unknown id: keep the current choice
      current.modelId = wanted;
      if (modelSelect.value !== wanted) modelSelect.value = wanted;
    }

    function applyQuality(quality) {
      if (quality !== 'balanced' && quality !== 'high') return;
      current.quality = quality;
      if (qualitySelect.value !== quality) qualitySelect.value = quality;
    }

    function setSettings(settings) {
      if (destroyed || !settings) return;
      if (typeof settings.enabled === 'boolean') applyEnabled(settings.enabled);
      if (isNum(settings.vocalLevel)) applyVocalLevel(settings.vocalLevel);
      if (isNum(settings.semitones)) applySemitones(settings.semitones);
      if (settings.modelId != null) applyModel(settings.modelId);
      if (settings.quality != null) applyQuality(settings.quality);
    }

    /* ---- user interaction: update the view, then notify ---- */

    toggle.addEventListener('click', function () {
      applyEnabled(!current.enabled);
      call(on.toggle, current.enabled);
    });

    slider.addEventListener('input', function () {
      applyVocalLevel(Number(slider.value) / 100);
      call(on.vocalLevel, current.vocalLevel);
    });

    function stepTranspose(delta) {
      const next = clamp(current.semitones + delta, -SEMITONE_LIMIT, SEMITONE_LIMIT);
      if (next === current.semitones) return;
      applySemitones(next);
      call(on.transpose, current.semitones);
    }
    down.addEventListener('click', function () { stepTranspose(-1); });
    up.addEventListener('click', function () { stepTranspose(1); });
    reset.addEventListener('click', function () { stepTranspose(-current.semitones); });

    modelSelect.addEventListener('change', function () {
      if (!modelIds.has(modelSelect.value)) return;
      current.modelId = modelSelect.value;
      call(on.model, current.modelId);
    });

    qualitySelect.addEventListener('change', function () {
      applyQuality(qualitySelect.value);
      call(on.quality, current.quality);
    });

    retry.addEventListener('click', function () { call(on.retry); });
    clearCache.addEventListener('click', function () { call(on.clearCache); });

    /* ---- state display (hot path: only write what changed) ---- */

    const shown = {
      phase: '', pill: '', cached: false, message: '', detail: '',
      meta: '', retry: false, valuenow: '0', playhead: ''
    };

    function setState(state) {
      if (destroyed || !state) return;
      const phase = typeof state.phase === 'string' ? state.phase : 'off';
      const percent = processedPercent(state);
      const duration = state.duration;

      // Phase hooks for CSS + pill wording
      if (shown.phase !== phase) {
        root.setAttribute('data-phase', phase);
        pill.setAttribute('data-phase', phase);
        shown.phase = phase;
      }
      const pillLabel = pillText(state, phase, percent);
      if (shown.pill !== pillLabel) {
        pill.textContent = pillLabel;
        shown.pill = pillLabel;
      }
      const cached = !!state.fromCache;
      if (shown.cached !== cached) {
        pill.classList.toggle('vrx-cached', cached);
        shown.cached = cached;
      }

      // Message / detail
      const msg = state.message != null ? String(state.message) : '';
      if (shown.message !== msg) {
        message.textContent = msg;
        message.title = msg; // full text when the line is ellipsized
        shown.message = msg;
      }
      const det = state.detail != null ? String(state.detail) : '';
      if (shown.detail !== det) {
        detail.textContent = det;
        detail.title = det;
        detail.hidden = det === '';
        shown.detail = det;
      }

      // Backend · speed
      const info = metaText(state);
      if (shown.meta !== info) {
        meta.textContent = info;
        shown.meta = info;
      }

      // Retry only while in error
      const showRetry = phase === 'error';
      if (shown.retry !== showRetry) {
        retry.hidden = !showRetry;
        shown.retry = showRetry;
      }

      // Progress strip
      capturedLayer.update(state.captured, duration);
      decodedLayer.update(state.decoded, duration);
      processedLayer.update(state.processed, duration);
      const valuenow = percent == null ? '0' : String(percent);
      if (shown.valuenow !== valuenow) {
        strip.setAttribute('aria-valuenow', valuenow);
        shown.valuenow = valuenow;
      }

      // Playhead marker
      let left = '';
      if (isNum(state.playhead) && isNum(duration) && duration > 0) {
        left = ((clamp(state.playhead, 0, duration) / duration) * 100).toFixed(2) + '%';
      }
      if (shown.playhead !== left) {
        if (left) {
          playhead.style.left = left;
          if (!shown.playhead) playhead.style.display = '';
        } else {
          playhead.style.display = 'none';
        }
        shown.playhead = left;
      }
    }

    /* ---- mounting ---- */

    // Insert as the FIRST child of `mount` (YouTube's #below). Safe to call
    // often: it only touches the DOM when the panel is detached or elsewhere.
    function ensureMounted(mount) {
      if (destroyed) return false;
      const target = mount || lastMount;
      if (!target || typeof target.insertBefore !== 'function') return false;
      lastMount = target;
      if (root.isConnected && root.parentNode === target) return true;
      target.insertBefore(root, target.firstChild);
      return true;
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      lastMount = null;
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    /* ---- initial values ---- */
    applyEnabled(false);
    applyVocalLevel(0);
    applySemitones(0);
    if (modelIds.size) applyModel(modelIds.values().next().value);
    applyQuality('balanced');
    setSettings(opts.settings);
    ensureMounted(opts.mount);

    return {
      el: root,
      setSettings: setSettings,
      setState: setState,
      ensureMounted: ensureMounted,
      destroy: destroy
    };
  }

  /* ------------------------------------------------------------------ */
  /* Seek bar overlay (inside YouTube's .ytp-progress-bar)                */
  /* ------------------------------------------------------------------ */

  function createSeekbarOverlay(progressBar) {
    const root = el('div', 'vrx-seek-overlay');
    root.setAttribute('aria-hidden', 'true');
    const decoded = createRangeLayer(root, 'vrx-seek-range vrx-decoded');
    const processed = createRangeLayer(root, 'vrx-seek-range vrx-processed');
    let destroyed = false;

    if (progressBar && typeof progressBar.appendChild === 'function') {
      progressBar.appendChild(root);
    }

    function update(state) {
      if (destroyed || !state) return;
      decoded.update(state.decoded, state.duration);
      processed.update(state.processed, state.duration);
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (root.parentNode) root.parentNode.removeChild(root);
    }

    return { el: root, update: update, destroy: destroy };
  }

  globalThis.VRX_UI = {
    createPanel: createPanel,
    createSeekbarOverlay: createSeekbarOverlay,
    formatTime: formatTime
  };
})();
