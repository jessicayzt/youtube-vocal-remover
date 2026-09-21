# YouTube Vocal Remover

A Chrome extension that removes the vocals from any YouTube video with an AI separation model
running **entirely on your computer**, and can transpose the audio from −7 to +7 semitones.
Nothing is uploaded; the model, the audio and the results never leave the browser.

## What it does

* **Vocal Remover** – a panel appears under the player. Turn it on and the extension fetches the
  video's audio track in the background, runs it through an MDX-Net instrumental model
  (the same "UVR-MDX-NET Inst HQ" models used by Ultimate Vocal Remover) and plays the
  result in sync with the video. A **Vocals** slider lets you keep some of the original vocals
  (0 % = removed, 100 % = original).
* **Transpose** – shifts the pitch of whatever is playing (processed or original) by whole
  semitones, −7 … +7, without changing the tempo. YouTube's playback-speed setting keeps working.
* **Whole-track processing with a progress map** – the audio is processed from start to finish,
  independent of where you are in the video. Green marks on YouTube's seek bar (and a strip in
  the panel) show which parts are already processed; amber shows parts that are fetched but not
  yet processed. Processing prioritises the part you are listening to, so seeking ahead makes the
  engine jump there first.
* **Session cache** – processed audio is kept in memory for the current browser session and in
  the extension's IndexedDB, so replaying a part, reloading the page or coming back to the video
  later never re-processes it (the cache is capped at 2 GB, oldest videos are evicted first).

## Install (unpacked)

1. Open `chrome://extensions`, enable **Developer mode** (top right).
2. Click **Load unpacked** and select this folder (`youtube-vocal-remover`).
3. Open any `youtube.com/watch` page. The **Vocal Remover** panel appears between the player
   and the title. Flip the switch.

Requirements: Chrome 124 or newer. WebGPU is used automatically when available (on a Mac with an
Apple GPU processing runs several times faster than real time); otherwise the model runs on
multi-threaded WebAssembly, roughly at real-time speed.

The models are bundled in `models/` (about 120 MB); nothing is downloaded at run time.

## How it works

```
YouTube tab                                          Extension offscreen document
┌──────────────────────────────┐                     ┌─────────────────────────────────────┐
│ hook.js (page world)         │ encoded audio       │ decoder: MSE segments → PCM          │
│  • copies the audio segments │ segments (base64)   │   (decodeAudioData, incremental)     │
│    YouTube appends to MSE    │ ───────────────────▶│ separator worker: ONNX Runtime Web   │
│  • silences the <video>      │                     │   MDX-Net (WebGPU / WASM threads)    │
│    while we play instead     │ sync (time, rate,   │ player worklet: mixes, transposes    │
│ content.js (isolated world)  │ play/pause, volume) │   (Signalsmith Stretch), plays in    │
│  • panel + seek-bar overlay  │ ───────────────────▶│   sync through the speakers          │
│  • hidden helper embed       │◀─────────────────── │ IndexedDB cache                      │
└──────────────────────────────┘ progress, takeover  └─────────────────────────────────────┘
```

1. **Getting the audio without re-implementing YouTube's downloader.** YouTube's player feeds
   Media Source Extensions; the extension hooks `SourceBuffer.appendBuffer` in the page and copies
   every audio segment (Opus/WebM or AAC/MP4). This works with YouTube's current server-driven
   (SABR) streaming, needs no URL deciphering and no extra requests to YouTube beyond what a
   player does. To get the *whole* track quickly instead of only what you have watched, the
   extension opens a hidden, muted helper copy of the video (a YouTube embed of the same video,
   on YouTube's cookieless `youtube-nocookie.com` domain so that nothing its hidden player does
   is attributed to your account) at the lowest video quality (the audio track is the same one the main player uses) and, each
   time that player has filled its buffer, seeks it forward to just short of the buffered end so
   it fetches the next stretch; its segments are captured the same way. It never plays faster
   than normal speed: a helper that raced ahead at 16× drained its buffer faster than YouTube's
   server-paced delivery refilled it and rebuffered constantly, and those stalls are exactly what
   YouTube's "Experiencing interruptions?" prompt reports, against the account, even later. If the
   embed cannot play (YouTube's embed player sometimes refuses with "player configuration
   error"), it tries the signed-in embed, then a hidden same-origin watch-page frame, and after that a temporary muted
   background tab (closed automatically when the audio is fetched). If everything fails,
   processing simply follows your own playback and the panel says why.

   The extension keeps out of the player's way while it is starting up. Capturing itself begins
   immediately and is deliberately cheap -- the bytes are copied and then just held -- while the
   expensive parts wait: encoding and shipping them to the engine, and starting the engine at
   all (loading the model, compiling its GPU pipelines, allocating the track buffers). Those
   begin once the player is in a steady state: past its cold start, actually playing or paused
   mid-watch, and with a real buffer ahead of it. Nothing captured in the meantime is thrown
   away, which matters because the first segments of a stream carry the codec headers and
   nothing later can be decoded without them.

   Because the helper is a second copy of the same video, it is careful too: it waits for the
   same steady state before it starts, asks for the lowest video quality (only the audio track matters to it), and pauses
   itself whenever the real player rebuffers or its buffer runs low, resuming once playback is smooth again. Captured
   segments are handed to the engine in short slices rather than one long task, so encoding them
   never stalls the page. Without this, YouTube notices the contention and offers its
   "Experiencing interruptions?" prompt.
2. **Decoding.** Segments are parsed (WebM/EBML and fragmented MP4) to learn their exact times,
   assembled into decodable files in ~40 s windows and decoded with the browser's decoder at
   44.1 kHz into a shared 16-bit PCM store.
3. **Separation.** A worker runs the ONNX model with ONNX Runtime Web. The pipeline mirrors
   UVR's MDX-Net inference exactly: 6144/5120-point STFT (periodic Hann, hop 1024, centre/reflect
   padding), 256-frame chunks, Hann-windowed overlap-add, `compensate` gain, lowest bins zeroed,
   optional two-pass "denoise". Processed blocks are written straight into the shared store and
   become playable immediately. While the video is playing and the processed audio is more than
   30 s ahead of the playhead, the worker pauses after each chunk for as long as the chunk took,
   so the GPU and CPU are not saturated while you watch; paused, or not yet that far ahead, it
   runs flat out.
4. **Playback.** An AudioWorklet in the offscreen document reads the store, blends
   instrumental/original per the Vocals slider, applies transpose and speed with Signalsmith
   Stretch, and follows the video clock (the content script sends time/rate/play state; small
   jitter is ignored, seeks snap). Meanwhile the page's `<video>` is silenced by shadowing its
   `volume`/`muted` properties, so YouTube's own volume control keeps working and drives our
   output. Parts that are not decoded yet fall back to YouTube's own audio automatically.

## Quality settings

* **High** (default): 50 % chunk overlap plus the two-pass denoise trick — four model passes per
  second of audio. Best quality; recommended with WebGPU.
* **Balanced**: 25 % overlap, single pass — UVR's defaults; four times faster.

Models: **Inst HQ 5** (2025, default) and **Inst HQ 3**. Both output the instrumental directly,
which gives cleaner karaoke tracks than subtracting a vocal model. Switching model or quality
starts a new pass; previous results stay cached.

## Limitations

* Live streams and videos longer than 60 minutes are not supported (the decoded and processed audio for one hour occupies about 1.3 GB of memory).
* When the helper embed is unavailable (embedding disabled, age restriction), the progress map
  only grows as far as YouTube has buffered, so processing follows playback.
* Ads: while an ad plays, the extension steps aside and lets YouTube's audio through.
* The first run after loading the extension compiles the model for your GPU; expect a few
  seconds before the progress map starts moving.

## Development

```
node --test test/            # unit tests (FFT, STFT, chunking, container parsers, decoder glue)
node test/model-e2e.mjs      # pushes a synthetic signal through the real ONNX models (slow)
open test/ui-preview.html    # panel/seek-bar UI mock outside YouTube
```

Layout: `src/content/` page scripts, `src/offscreen/` engine (decoder, worker, worklet, cache),
`src/dsp/` FFT/STFT/MDX chunking, `src/media/` MSE container parsers, `vendor/` ONNX Runtime Web
and Signalsmith Stretch, `models/` ONNX models with their parameters in `models.json`.
