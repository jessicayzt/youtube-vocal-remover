# Chrome Web Store submission kit

Everything the developer dashboard asks for, ready to paste. The package itself is built with
`zip -r -X dist/youtube-vocal-remover-<version>.zip manifest.json offscreen.html popup.html popup.js icons models src vendor THIRD_PARTY_NOTICES.md -x '*.DS_Store'`
from the repository root (the store requires `manifest.json` at the root of the ZIP; limit 2 GB).

## Steps

1. Register at https://chrome.google.com/webstore/devconsole with the Google account that should
   own the listing. There is a one-time developer registration fee (US$5 at the time of writing).
   On the **Account** page set and verify a contact email; publishing is blocked until it is verified.
2. **New item**, upload `dist/youtube-vocal-remover-0.1.0.zip`.
3. **Store listing** tab: the texts below, the screenshots, the promo tile.
4. **Privacy practices** tab: the single purpose, the permission justifications, remote code = no,
   the data-usage boxes and certifications, the privacy policy URL.
5. **Distribution** tab: free, public (or unlisted for a quiet first release), all regions.
6. **Submit for review.** Items that request host permissions get an in-depth review; expect a
   few days. Fix-and-resubmit is normal on a first submission.

## Store listing

**Name**: YouTube Vocal Remover

**Summary** (132 characters max; the dashboard pre-fills it from the manifest, replace it with this):

> Removes vocals from YouTube videos with an on-device AI model. Karaoke for any video, transpose up to ±7 semitones.

**Category**: Entertainment. **Language**: English.

**Detailed description**:

> Turn any YouTube video into a karaoke track. YouTube Vocal Remover runs an AI separation model
> (UVR MDX-Net) entirely on your computer and plays the instrumental in sync with the video, so
> nothing is uploaded and no account is needed.
>
> • Vocal Remover: a panel appears under the player. Flip the switch and the video's audio is
> processed from start to finish; green marks on the seek bar show what is ready. A Vocals slider
> lets you keep some of the original voice.
> • Transpose: shift the pitch by whole semitones, −7 to +7, without changing the tempo. YouTube's
> playback-speed setting keeps working.
> • Whole-track processing: the part you are listening to is done first; the rest follows.
> • Cache: processed audio is kept on your device so replaying or reloading never processes twice.
>
> Requirements: Chrome 124 or newer. WebGPU is used when available (an Apple-silicon Mac processes
> several times faster than real time); otherwise the model runs on WebAssembly at about real time.
> The two models are bundled, which is why the download is large.
>
> Not supported: live streams, videos longer than 60 minutes, and videos whose audio YouTube does
> not play through its normal web player. While an ad plays the extension steps aside and lets
> YouTube's own audio through.
>
> Privacy: all processing happens locally; the extension makes no network requests of its own and
> collects no data. Source code: https://github.com/jessicayzt/youtube-vocal-remover

**Images**
- Store icon: taken from the manifest (`icons/icon128.png`). The store guideline is 96×96 artwork
  inside 16 px of transparent padding; `store/icon-128-padded.png` is that variant if the full-bleed
  icon looks cramped in the store.
- Small promo tile (required, 440×280): `store/promo-small-440x280.png`.
- Screenshots (at least one; 1280×800 preferred, or 640×400; PNG or JPEG; full bleed, square
  corners): `store/screenshot-1-1280x800.png` (the watch page with the panel switched on, mid
  processing) and `store/screenshot-2-1280x800.png` (the panel up close, with a caption). Both were
  made from real screenshots; the originals are not committed. Upload them in that order.
- Marquee tile (optional, 1400×560): not provided.

## Privacy practices tab

**Single purpose description**:

> Removes the vocals from the YouTube video being watched, with an optional pitch transpose, using
> an AI model that runs entirely on the user's device.

**Permission justifications**

- `storage`: stores the extension's own settings (on/off switch, vocals level, transpose, model,
  quality) in `chrome.storage.local`. Nothing else is stored there.
- `offscreen`: hosts the audio engine: the on-device separation model (ONNX Runtime Web on
  WebAssembly or WebGPU), audio decoding, and Web Audio playback of the processed audio.
  A service worker cannot use Web Audio or WebGPU, and the engine has to outlive individual page
  loads of the YouTube tab.
- Host permission `https://www.youtube.com/*`: the extension works only on YouTube watch pages.
  Its content scripts add the control panel under the player, capture the audio segments the
  page's own player loads (no additional requests to YouTube are made for the video being
  watched), and silence the page's audio while the processed version plays in sync.
- Host permission `https://www.youtube-nocookie.com/*`: YouTube's privacy-enhanced embed domain.
  To process a whole video ahead of playback the extension opens a hidden, muted embed of the same
  video from this domain and captures its audio in the same way. The cookieless domain keeps this
  helper player separate from the user's YouTube account.

**Remote code**: No. All scripts, WebAssembly binaries and model files are packaged with the
extension; nothing is downloaded or executed from a remote source at run time.

**Data usage**: the extension collects none of the listed categories (no personally identifiable
information, health, financial or payment information, authentication information, personal
communications, location, web history, user activity, or website content). Audio is processed
in memory and cached only in the browser's own IndexedDB on the device; nothing is transmitted.
Tick all three certifications: data is not sold to third parties, not used or transferred for
purposes unrelated to the single purpose, and not used to determine creditworthiness or for
lending purposes.

**Privacy policy URL**: https://github.com/jessicayzt/youtube-vocal-remover/blob/main/PRIVACY.md
(the file `PRIVACY.md` in this repository; it has to be pushed before the URL resolves).

## Things a reviewer may ask about

- The hidden helper player. The justification above explains it; if asked, the point is that it
  is the same YouTube player fetching the same video, only muted and off-screen, so the whole
  track can be processed before the user reaches it.
- Package size (about 118 MB compressed): two bundled models, no remote download, no remote code.
- Third-party components and their licenses are listed in `THIRD_PARTY_NOTICES.md`, which is in
  the package.
