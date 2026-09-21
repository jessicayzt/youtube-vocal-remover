# Privacy policy: YouTube Vocal Remover

YouTube Vocal Remover does not collect, store or transmit any personal data.

- **Everything runs on your device.** The audio of the video you are watching is decoded and
  processed in your browser's memory, and the separation model runs locally. Nothing about you,
  the videos you watch or the audio itself leaves your computer.
- **No traffic of its own.** The extension makes no network requests to its developer or to any
  third party. The only network traffic is YouTube's own player loading the video, including a
  hidden, muted helper player of the same video that the extension opens on YouTube's cookieless
  `youtube-nocookie.com` domain so that the whole track can be processed ahead of playback.
- **Local storage only.** Your settings (on/off, vocals level, transpose, model, quality) are kept
  in the browser's extension storage. Processed audio is cached in the browser's IndexedDB so a
  video does not have to be processed twice; the cache is capped at 2 GB, oldest first, and can
  be emptied with the panel's "Clear cache" button or by removing the extension.
- **No analytics, no accounts, no identifiers.**

Questions: https://github.com/jessicayzt/youtube-vocal-remover/issues

Last updated: 2026-09-21
