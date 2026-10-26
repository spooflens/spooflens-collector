# spooflens-collector

A small, dependency-free script that collects what a browser reports about itself, so you can check whether those reports are consistent. It is the signal collector behind the [SpoofLens browser check](https://spooflens.com/en/browser), published under the MIT license.

It only collects. It does not score, does not send anything anywhere and does not store anything. What you do with the signals is up to you.

## What it collects

| Group | Signals |
|---|---|
| `nav` | User-Agent, platform, vendor, languages, CPU cores, device memory, touch points, cookies, Do Not Track, Global Privacy Control, PDF viewer, plugin and MIME counts, User-Agent Client Hints (low and high entropy) |
| `scr` | Screen and available size, color depth, pixel ratio, inner and outer window size, window position, visibility state, whether the page was prerendered |
| `scr2` | The screen in device pixels, how much of it the taskbar or dock takes and where (offset from the top and the left), color gamut (sRGB, P3, Rec. 2020), HDR, an extended second screen |
| `tz` | Time zone name, UTC offset from `Date`, UTC offset computed from the zone name with `Intl`, locale |
| `media` | System settings seen through CSS: dark mode, reduced motion, pointer type, hover, contrast, reduced transparency, inverted colors, forced colors |
| `gfx` | WebGL vendor and renderer, version, GLSL version, max texture size, extension count, parameter hash, WebGPU adapter vendor and architecture; `gfx.params`: a hash of the WebGL limits and shader precision formats and a hash of the extension list, without the name of the graphics card |
| `canvas`, `audio` | Two renders each, their hashes and a `noise` flag when the two differ; `canvas.flat` counts pixels of a one-color fill that did not read back exactly |
| `scene` | Our own WebGL scene (a shaded triangle on a flat background) drawn twice: two hashes, `flat` = changed pixels of the background, `blank` when reading is blocked; `roads` = how many pixels differ when the first drawing is read back two more ways (the canvas PNG, decoded by the script itself, and a copy into a 2D canvas) |
| `scene2` | A second scene of five small shaders (float math, derivatives, blending, texture filtering, trigonometry at the edges of its range), drawn twice: a hash, the five part hashes and a `noise` flag |
| `audio2` | Sample rate, output channel count and base latency of the default audio output (an `AudioContext` that is opened and closed at once, nothing is played) |
| `emoji` | The newest Unicode emoji version the system can draw (11 to 16) and a hash of how the test emoji render |
| `store` | The class of the storage quota a site gets, 0 to 8 (from `navigator.storage.estimate()`); the number itself is not returned |
| `motion` | Motion sensors as any page sees them without asking: is the API there, is there a permission function, readings received in 1.2 s and their average gravity (m/s²). The readings themselves are not kept |
| `fonts` | Which of 43 common system fonts are installed (measured, not enumerated) |
| `voices`, `vo`, `vh`, `devices` | Number of speech synthesis voices; of the local ones, how many look like Microsoft, Apple and other voices (`vo`); a hash of their names (`vh`, the names themselves are not returned); number of microphones, speakers and cameras (no labels, no permission prompt) |
| `rtc` | Whether WebRTC exposes a local IP address or hides it behind an mDNS name. No STUN server is contacted |
| `worker`, `iframe` | The same key values as seen from a Web Worker and from an invisible iframe |
| `auto` | `navigator.webdriver`, presence of `window.chrome`, a list of built-in functions and getters that were replaced by JavaScript, the JavaScript engine (`engine`: `v8`, `gecko`, `jsc`, from the wording of a built-in error) and global names left behind by automation tools (`traces`) |
| `wt` | Whether the WebTransport API exists (`null` outside a secure context, where browsers never expose it) |
| `priv` | Hints of Brave and of Firefox with resistFingerprinting |
| `fp` | A short hash of the stable signals, useful as a fingerprint ID |

## Usage

```html
<script src="/collector.js"></script>
<script>
  SpoofLensCollector.collect({ worker: '/collector-worker.js' }).then(function (signals) {
    console.log(signals.fp, signals);
  });
</script>
```

Serve `collector-worker.js` from your own origin. Without the `worker` option the Web Worker cross-check is skipped. The script also works as a CommonJS module (`require('./collector.js')`), but it needs a browser environment to run.

Collection takes about two seconds, mostly waiting for audio rendering, WebGPU, WebRTC and the motion sensors, with timeouts. Chrome and Edge report the window size a moment after a page starts, so the script waits up to 2.5 s for it instead of reading 0x0.

## Reading the signals

A real browser is consistent with itself. Spoofing tools usually change only some values, and the seams show up as contradictions. A few examples of checks you can build on top of the output:

- `nav.ua` against the User-Agent header your server received.
- `nav.platform` and `nav.uad.platform` against the operating system in `nav.ua`.
- `worker.ua`, `worker.languages`, `worker.hc` and `iframe.ua` against the values on the page.
- `tz.offset` against `tz.intlOffset`: they differ only when one of them was changed.
- `auto.engine` against the browser in `nav.ua`: Chromium browsers run V8, Firefox runs SpiderMonkey (`gecko`), Safari and every browser on iOS run JavaScriptCore (`jsc`). A user-agent switch does not change the engine.
- `canvas.noise` or `audio.noise`: a real device renders the same input the same way. Brave, Safari and Firefox with resistFingerprinting add or change such data on purpose, so treat those as privacy protection, not as fraud.
- `canvas.flat` or `scene.flat` above 0 with no `noise`: steady noise, the same on every read (one seed per profile or per site), which two drawings cannot reveal. Firefox private windows and DuckDuckGo do this as protection.
- `scene.roads` above 0 while the scene itself reads clean: the image was changed on one way of reading it and not on the others.
- `scene.h1` is drawn by the real graphics card whatever `gfx.renderer` says, so two profiles on one machine usually share it.
- `scene2`, `gfx.params`, `scr2`, `media`, `audio2`, `emoji` and `vh` describe the device and its system rather than the browser engine. Canvas and audio hashes differ between Chrome and Firefox on one computer; these mostly do not, so they help tell whether two browsers run on the same device.
- `vo`: a Windows User-Agent with only Apple voices, or a Mac with only Microsoft voices.
- `emoji.v` older than the system version in `nav.ua`, or `wt` false in a recent Chrome or Firefox: an older system or engine under a newer name.
- A phone User-Agent (Android) with `motion.real` at 0, or `motion.g` far from 9.8: real Android phones send accelerometer readings to any page. Skip this for in-app browsers, privacy browsers and when `motion.blocked` (your Permissions-Policy turned sensors off). Do not use `motion.perm` to tell iPhones apart: desktop Chrome has that function too.
- A non-empty `auto.tamper` or `auto.traces` list: built-in functions that are no longer native code, or the leftovers of an automation tool.

No single signal proves anything. VPNs, corporate networks, laptops with two graphics cards and privacy browsers all produce some of them. Weigh several signals, and prefer asking for extra verification over blocking.

The hosted [SpoofLens check](https://spooflens.com/en/browser) runs more than thirty such rules, adds server-side data (IP network, Tor exits, proxy headers, Client Hints headers, the TLS, HTTP/2, TCP and QUIC handshakes) and explains every finding.

## What this project is not

This repository holds only the collector. The SpoofLens rules and their weights, the server-side checks (TLS, HTTP/2, TCP, QUIC, DNS and WebRTC as our own servers see them), the comparison of devices and the SpoofLens API are not part of it and are not covered by its license.

This project explains how detection works. It does not include, and will not accept, techniques for getting around anti-fraud checks.

## Privacy and consent

The output can identify a browser across sites. Depending on where you and your visitors are, collecting it may require consent (for example under the EU ePrivacy rules) or a clear statement in your privacy policy. Use it to protect your service and your users, not to track people without their knowledge.

## License and trademark

The code is MIT licensed, see [LICENSE](LICENSE). You may use it, change it and ship it in your own products, free or paid.

"SpoofLens" and the SpoofLens logo are trademarks of SpoofLens. The MIT license covers the code, not the name or the logo: please do not call your product SpoofLens or present it as made or endorsed by us.

## Changes

- 0.3.0 (26 October 2026): the device and system traits (`scr2`, `scene2`, `gfx.params`, `audio2`, `emoji`, `store`, the system settings in `media`), speech voice origins and a hash of their names, the JavaScript engine and traces of automation tools, the second and third way of reading the WebGL scene, WebTransport, waiting for the real window size. Built from the site's own collector, so it is the code the SpoofLens check runs.
- 0.2.0: the WebGL scene, the flat fill check, the motion sensor summary.
- 0.1.0: first release.
