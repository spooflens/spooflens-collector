/**
 * spooflens-collector 0.3.0: collects what a browser reports about itself, for consistency checks.
 * Extracted from the SpoofLens browser check (https://spooflens.com/en/browser), MIT license.
 * Built from the site's own probe.js by tools/build-collector.js, so this is the code the check runs,
 * minus the parts that talk to the SpoofLens servers.
 *
 * Runs entirely in the page: no network requests, no storage, no external STUN servers,
 * works under a strict Content Security Policy when the worker file is served from your origin.
 *
 *   SpoofLensCollector.collect({ worker: '/collector-worker.js' }).then(function (signals) { ... });
 *
 * Returns raw signals only. Interpreting them (which combinations are impossible in a real
 * browser) is up to you; the SpoofLens service does it server-side with more data.
 * Collecting fingerprints may require user consent where you operate (e.g. the EU ePrivacy rules).
 * "SpoofLens" and its logo are trademarks of SpoofLens and are not licensed by the MIT license.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.SpoofLensCollector = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function timeout(p, ms, fallback) {
    return Promise.race([p, new Promise(function (r) { setTimeout(function () { r(fallback); }, ms); })])
      .catch(function () { return fallback; });
  }
  // fast non-cryptographic 53-bit hash (cyrb53) -> hex
  function hash(str, seed) {
    var h1 = 0xdeadbeef ^ (seed || 0), h2 = 0x41c6ce57 ^ (seed || 0);
    for (var i = 0, ch; i < str.length; i++) {
      ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761); h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(16).padStart(14, '0');
  }


  /* ------------------------------------------------------------ signals --- */

  function isNative(fn) {
    try { return typeof fn === 'function' && /\{\s*\[native code\]\s*\}\s*$/.test(Function.prototype.toString.call(fn)); }
    catch (e) { return false; }
  }
  // built-ins that spoofing tools override in JavaScript; a non-native getter or method = tampering
  function tamperCheck() {
    var out = [];
    function getter(proto, name, label) {
      try {
        var d = proto && Object.getOwnPropertyDescriptor(proto, name);
        if (d && d.get && !isNative(d.get)) out.push(label + '.' + name);
      } catch (e) {}
    }
    function method(proto, name, label) {
      try { if (proto && typeof proto[name] === 'function' && !isNative(proto[name])) out.push(label + '.' + name); } catch (e) {}
    }
    if (!isNative(Function.prototype.toString)) out.push('Function.toString');
    var N = window.Navigator && Navigator.prototype;
    ['userAgent', 'platform', 'language', 'languages', 'hardwareConcurrency', 'deviceMemory', 'webdriver', 'maxTouchPoints', 'vendor']
      .forEach(function (n) { getter(N, n, 'navigator'); });
    try {
      var own = Object.getOwnPropertyNames(navigator);
      if (own.length) out.push('navigator{' + own.slice(0, 4).join(',') + '}');
    } catch (e) {}
    var S = window.Screen && Screen.prototype;
    ['width', 'height', 'availWidth', 'availHeight', 'colorDepth'].forEach(function (n) { getter(S, n, 'screen'); });
    method(window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'toDataURL', 'canvas');
    method(window.HTMLCanvasElement && HTMLCanvasElement.prototype, 'getContext', 'canvas');
    method(window.CanvasRenderingContext2D && CanvasRenderingContext2D.prototype, 'getImageData', 'canvas2d');
    method(window.WebGLRenderingContext && WebGLRenderingContext.prototype, 'getParameter', 'webgl');
    method(window.AudioBuffer && AudioBuffer.prototype, 'getChannelData', 'audio');
    method(Date.prototype, 'getTimezoneOffset', 'Date');
    method(Intl.DateTimeFormat && Intl.DateTimeFormat.prototype, 'resolvedOptions', 'Intl');
    return out;
  }

  function intlOffset(tz) {
    try {
      var now = Math.floor(Date.now() / 1000) * 1000;
      var parts = {};
      new Intl.DateTimeFormat('en-US', {
        timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit'
      }).formatToParts(new Date(now)).forEach(function (x) { parts[x.type] = x.value; });
      var asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, (+parts.hour) % 24, +parts.minute, +parts.second);
      return Math.round((asUtc - now) / 60000);
    } catch (e) { return null; }
  }

  function canvasHash() {
    try {
      var c = document.createElement('canvas'); c.width = 280; c.height = 70;
      var x = c.getContext('2d');
      var g = x.createLinearGradient(0, 0, 280, 0);
      g.addColorStop(0, '#2dd4bf'); g.addColorStop(1, '#f97316');
      x.fillStyle = g; x.fillRect(0, 0, 280, 70);
      x.textBaseline = 'alphabetic'; x.font = "18px 'Arial'";
      x.fillStyle = '#0d1524'; x.fillText('SpoofLens 🔍 Cwm fjordbank glyphs', 6, 30);
      x.globalCompositeOperation = 'multiply';
      x.fillStyle = 'rgba(255,0,180,0.6)'; x.beginPath(); x.arc(220, 40, 24, 0, Math.PI * 2); x.fill();
      x.fillStyle = 'rgba(0,140,255,0.6)'; x.beginPath(); x.arc(240, 34, 22, 0, Math.PI * 2); x.fill();
      return hash(c.toDataURL());
    } catch (e) { return ''; }
  }

  // A flat fill must read back exactly. Noise that an antidetect adds the same way every time
  // (one seed per profile) leaves the two drawings above equal, but it still changes these pixels.
  // Returns how many of the 1600 checked pixels differ from the colour that was painted.
  function canvasFlat() {
    try {
      var c = document.createElement('canvas'); c.width = 120; c.height = 40;
      var x = c.getContext('2d');
      x.fillStyle = '#336699'; x.fillRect(0, 0, 120, 40);
      x.fillStyle = '#ffffff'; x.font = "14px 'Arial'"; x.fillText('SpoofLens', 50, 26); // a drawing, not just a fill
      var d = x.getImageData(0, 0, 40, 40).data, bad = 0;
      for (var i = 0; i < d.length; i += 4) if (d[i] !== 51 || d[i + 1] !== 102 || d[i + 2] !== 153 || d[i + 3] !== 255) bad++;
      return bad;
    } catch (e) { return null; }
  }

  function webgl() {
    var o = {};
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return o;
      var dbg = gl.getExtension('WEBGL_debug_renderer_info');
      o.vendor = dbg ? String(gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) || '') : '';
      o.renderer = dbg ? String(gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) || '') : '';
      o.version = String(gl.getParameter(gl.VERSION) || '');
      o.glsl = String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || '');
      o.maxTex = gl.getParameter(gl.MAX_TEXTURE_SIZE);
      var ext = (gl.getSupportedExtensions() || []).slice().sort();
      o.extCount = ext.length;
      o.hash = hash([o.vendor, o.renderer, o.version, o.glsl, o.maxTex,
        String(gl.getParameter(gl.MAX_VIEWPORT_DIMS)), gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
        String(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE)), ext.join(',')].join('|'));
    } catch (e) {}
    return o;
  }

  // Our own WebGL scene: a shaded triangle on a flat clear colour. The pixels come from the real
  // graphics card and driver, whatever name the renderer string gives, so two profiles of one
  // antidetect on one machine draw the same image. Drawn twice: an unmodified browser returns
  // identical pixels and the exact clear colour in the two corners the triangle does not touch.
  // roads: filled here for sceneRoads() (the first drawing top-down, its canvas image, the 2D copy);
  // the pixels themselves are not sent anywhere.
  function webglScene(roads) {
    roads = roads || {};
    var o = { h1: '', h2: '', flat: 0, blank: false };
    try {
      var c = document.createElement('canvas'); c.width = 64; c.height = 64;
      var opt = { antialias: false, preserveDrawingBuffer: true };
      var gl = c.getContext('webgl', opt) || c.getContext('experimental-webgl', opt);
      if (!gl) return o;
      var hp = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      var sh = function (type, src) { var x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
      var p = gl.createProgram();
      gl.attachShader(p, sh(gl.VERTEX_SHADER, 'attribute vec2 a;varying vec2 v;void main(){v=a*0.5+0.5;gl_Position=vec4(a,0.0,1.0);}'));
      gl.attachShader(p, sh(gl.FRAGMENT_SHADER, 'precision ' + (hp && hp.precision > 0 ? 'highp' : 'mediump') + ' float;varying vec2 v;void main(){'
        + 'float s=sin(v.x*37.0)*cos(v.y*23.0);float n=fract(sin(dot(v,vec2(12.9898,78.233)))*43758.5453);'
        + 'gl_FragColor=vec4(fract(s+n*0.25),exp2(v.x*3.0)/8.0,atan(v.y-0.5,v.x-0.5)/6.2831853+0.5,1.0);}'));
      gl.linkProgram(p);
      if (!gl.getProgramParameter(p, gl.LINK_STATUS)) return o;
      gl.useProgram(p);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-0.9, -0.9, 0.9, -0.6, -0.2, 0.9]), gl.STATIC_DRAW);
      var loc = gl.getAttribLocation(p, 'a');
      gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      gl.disable(gl.DITHER); gl.viewport(0, 0, 64, 64);
      var px = new Uint8Array(64 * 64 * 4);
      var draw = function () {
        gl.clearColor(0.2, 0.4, 0.6, 1.0); gl.clear(gl.COLOR_BUFFER_BIT);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, px);
        var s = [];
        for (var i = 0; i < px.length; i += 1024) s.push(String.fromCharCode.apply(null, px.subarray(i, i + 1024)));
        return s.join('');
      };
      var d1 = draw();
      o.h1 = hash(d1);
      // rows count from the bottom: corners top-left (x 0-7, y 56-63) and bottom-right (x 56-63, y 0-7)
      for (var y = 0; y < 8; y++) for (var x = 0; x < 8; x++) {
        [[x, 56 + y], [56 + x, y]].forEach(function (q) {
          var i = (q[1] * 64 + q[0]) * 4;
          if (px[i] !== 51 || px[i + 1] !== 102 || px[i + 2] !== 153 || px[i + 3] !== 255) o.flat++;
        });
      }
      o.blank = d1 === new Array(64 * 64 + 1).join(d1.slice(0, 4)); // one colour everywhere: reading is blocked (zeros) or nothing was drawn
      // the same drawing by two other roads (lib/truth.php webgl_paths): the canvas image and a copy into a
      // 2D canvas. An unmodified browser gives the same pixels on every road.
      if (!o.blank) {
        roads.rp = topDown(px, 64, 64);
        try { roads.png = c.toDataURL('image/png'); } catch (e) {}
        try {
          var c2 = document.createElement('canvas'); c2.width = 64; c2.height = 64;
          var x2 = c2.getContext('2d'); x2.drawImage(c, 0, 0);
          roads.d2 = diffPx(roads.rp, x2.getImageData(0, 0, 64, 64).data);
        } catch (e) {}
      }
      o.h2 = hash(draw());
    } catch (e) {}
    return o;
  }

  // readPixels rows run from the bottom; canvas images run from the top
  function topDown(px, w, h) {
    var out = new Uint8Array(w * h * 4), row = w * 4;
    for (var y = 0; y < h; y++) out.set(px.subarray((h - 1 - y) * row, (h - y) * row), y * row);
    return out;
  }
  // how many pixels differ between two RGBA arrays of one size (all of them when the sizes differ)
  function diffPx(a, b) {
    if (!a || !b) return null;
    if (a.length !== b.length) return a.length / 4;
    var n = 0;
    for (var i = 0; i < a.length; i += 4) if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2] || a[i + 3] !== b[i + 3]) n++;
    return n;
  }
  // Decodes the canvas PNG (8-bit RGB or RGBA, not interlaced) without the canvas API, so a hook on
  // getImageData cannot touch this road. null where the browser has no DecompressionStream.
  function pngPixels(url) {
    if (!window.DecompressionStream || !window.Response || !url || url.indexOf('data:image/png;base64,') !== 0) return null;
    try {
      var bin = atob(url.slice(22)), b = new Uint8Array(bin.length);
      for (var i = 0; i < bin.length; i++) b[i] = bin.charCodeAt(i);
      var u32 = function (p) { return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; };
      var w = 0, h = 0, ct = -1, idat = [], p = 8;
      while (p + 8 <= b.length) {
        var len = u32(p), type = String.fromCharCode(b[p + 4], b[p + 5], b[p + 6], b[p + 7]);
        if (type === 'IHDR') { w = u32(p + 8); h = u32(p + 12); if (b[p + 16] !== 8 || b[p + 20] !== 0) return null; ct = b[p + 17]; }
        else if (type === 'IDAT') idat.push(b.subarray(p + 8, p + 8 + len));
        else if (type === 'IEND') break;
        p += 12 + len;
      }
      var bpp = ct === 6 ? 4 : (ct === 2 ? 3 : 0);
      if (!bpp || !w || !h || !idat.length) return null;
      var stream = new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'));
      return new Response(stream).arrayBuffer().then(function (ab) {
        var raw = new Uint8Array(ab), stride = w * bpp, out = new Uint8Array(w * h * 4);
        var prev = new Uint8Array(stride), cur = new Uint8Array(stride);
        for (var y = 0; y < h; y++) {
          var at = y * (stride + 1), f = raw[at];
          for (var x = 0; x < stride; x++) {
            var left = x >= bpp ? cur[x - bpp] : 0, up = prev[x], ul = x >= bpp ? prev[x - bpp] : 0, v = raw[at + 1 + x];
            if (f === 1) v += left;
            else if (f === 2) v += up;
            else if (f === 3) v += (left + up) >> 1;
            else if (f === 4) {
              var pa = Math.abs(up - ul), pb = Math.abs(left - ul), pc = Math.abs(left + up - 2 * ul);
              v += (pa <= pb && pa <= pc) ? left : (pb <= pc ? up : ul);
            }
            cur[x] = v & 255;
          }
          for (var q = 0; q < w; q++) {
            var o = (y * w + q) * 4, s = q * bpp;
            out[o] = cur[s]; out[o + 1] = cur[s + 1]; out[o + 2] = cur[s + 2]; out[o + 3] = bpp === 4 ? cur[s + 3] : 255;
          }
          var t2 = prev; prev = cur; cur = t2;
        }
        return out;
      });
    } catch (e) { return null; }
  }
  // where the browser cannot decode the PNG itself: through an image and a 2D canvas
  function imagePixels(url) {
    return new Promise(function (res) {
      var im = new Image();
      im.onload = function () {
        try {
          var c = document.createElement('canvas'); c.width = im.width; c.height = im.height;
          var x = c.getContext('2d'); x.drawImage(im, 0, 0);
          res(x.getImageData(0, 0, c.width, c.height).data);
        } catch (e) { res(null); }
      };
      im.onerror = function () { res(null); };
      im.src = url;
    });
  }
  // {png: differing pixels on the canvas-image road, d2: on the 2D-copy road, dec: 'png' | '2d' (how the image was decoded)}
  function sceneRoads(r) {
    if (!r || !r.rp) return Promise.resolve(null);
    var out = { png: null, d2: r.d2 == null ? null : r.d2, dec: '' };
    if (!r.png) return Promise.resolve(out);
    var own = pngPixels(r.png);
    return timeout((own || Promise.resolve(null)).then(function (px) {
      if (px) { out.png = diffPx(r.rp, px); out.dec = 'png'; return out; }
      return imagePixels(r.png).then(function (px2) {
        if (px2) { out.png = diffPx(r.rp, px2); out.dec = '2d'; }
        return out;
      });
    }).catch(function () { return out; }), 1500, out);
  }

  function webgpu() {
    if (!navigator.gpu || !navigator.gpu.requestAdapter) return Promise.resolve(null);
    return timeout(navigator.gpu.requestAdapter().then(function (a) {
      if (!a) return null;
      var info = a.info || null;
      if (!info && a.requestAdapterInfo) return a.requestAdapterInfo().then(function (i) { return { vendor: i.vendor, arch: i.architecture }; });
      return info ? { vendor: info.vendor || '', arch: info.architecture || '' } : null;
    }), 1500, null);
  }

  function audioHash() {
    var AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return Promise.resolve('');
    return timeout(new Promise(function (resolve) {
      try {
        var ctx = new AC(1, 44100, 44100);
        var osc = ctx.createOscillator(); osc.type = 'triangle'; osc.frequency.value = 10000;
        var comp = ctx.createDynamicsCompressor();
        comp.threshold.value = -50; comp.knee.value = 40; comp.ratio.value = 12;
        comp.attack.value = 0; comp.release.value = 0.25;
        osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
        ctx.oncomplete = function (e) {
          var d = e.renderedBuffer.getChannelData(0), sum = 0;
          for (var i = 4500; i < 5000; i++) sum += Math.abs(d[i]);
          resolve(sum.toString());
        };
        ctx.startRendering();
      } catch (e) { resolve(''); }
    }), 2000, '');
  }

  var FONTS = [
    'Segoe UI', 'Tahoma', 'Consolas', 'Microsoft Sans Serif', 'Calibri', 'Cambria', 'Segoe UI Emoji', 'Franklin Gothic Medium', 'Gabriola', 'Nirmala UI', 'Malgun Gothic', 'Yu Gothic', 'SimSun',
    'Helvetica Neue', 'Menlo', 'Avenir', 'Avenir Next', 'Geneva', 'Lucida Grande', 'Monaco', 'Futura', 'Optima', 'Apple Chancery', 'Hiragino Sans', 'PingFang SC',
    'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Cantarell', 'Noto Sans', 'Droid Sans', 'Roboto',
    'Arial', 'Times New Roman', 'Courier New', 'Verdana', 'Georgia', 'Trebuchet MS', 'Comic Sans MS', 'Impact', 'Arial Black', 'Palatino Linotype', 'Garamond'
  ];
  function fonts() {
    try {
      var c = document.createElement('canvas').getContext('2d');
      var sample = 'mmmmmmmmmmlli1WQ@#';
      var bases = ['monospace', 'serif', 'sans-serif'], base = {};
      bases.forEach(function (b) { c.font = '72px ' + b; base[b] = c.measureText(sample).width; });
      return FONTS.filter(function (f) {
        return bases.some(function (b) { c.font = "72px '" + f + "'," + b; return c.measureText(sample).width !== base[b]; });
      });
    } catch (e) { return []; }
  }

  // speech voices: the count, and which system the on-device voices come with (Microsoft ones with Windows,
  // Apple ones with macOS and iOS); network voices (Google in desktop Chrome, "Online" in Edge) are left out.
  // Only the counts leave the browser, not the names.
  var APPLE_VOICES = /^(Samantha|Alex|Daniel|Karen|Moira|Tessa|Fiona|Fred|Victoria|Rishi|Veena|Thomas|Anna|Milena|Yuri|Amelie|Amélie|Kyoko|Ting-Ting)( |$)/;
  function voiceSummary(list) {
    var k = { win: 0, apple: 0, other: 0 }, names = [];
    for (var i = 0; i < list.length; i++) {
      var v = list[i];
      if (!v || v.localService !== true) continue;
      var n = String(v.name || ''), u = String(v.voiceURI || '');
      names.push(n);
      if (/^Microsoft /.test(n)) k.win++;
      else if (/^com\.apple\./.test(u) || APPLE_VOICES.test(n)) k.apple++;
      else k.other++;
    }
    // the names of the system's own voices, as one hash (0.18.0): the same in every browser of a device, and voices
    // the owner downloaded tell two phones of one model apart; the names themselves are not sent
    return { n: list.length, k: k, h: names.length ? hash(names.sort().join('|')) : '' };
  }
  function voices() {
    if (!window.speechSynthesis) return Promise.resolve(null);
    var v = speechSynthesis.getVoices();
    if (v && v.length) return Promise.resolve(voiceSummary(v));
    return timeout(new Promise(function (r) {
      speechSynthesis.addEventListener('voiceschanged', function () { r(voiceSummary(speechSynthesis.getVoices())); }, { once: true });
    }), 800, { n: 0, k: null });
  }

  // the JavaScript engine words its own TypeError: V8 (Chromium), SpiderMonkey (Firefox), JavaScriptCore (Safari, every iOS browser)
  function jsEngine() {
    try { var o = null; o.x = 1; } catch (e) {
      var m = String((e && e.message) || '');
      if (/Cannot set propert/.test(m)) return 'v8';
      if (/can't access property|has no properties|is null/.test(m)) return 'gecko';
      if (/is not an object/.test(m)) return 'jsc';
      return 'other';
    }
    return '';
  }

  // globals and document properties that automation frameworks leave behind
  function autoTraces() {
    var out = [];
    ['__playwright__binding__', '__pwInitScripts', '_phantom', 'callPhantom', '__nightmare', 'domAutomation', 'domAutomationController',
     '_selenium', 'callSelenium', '_Selenium_IDE_Recorder', '__webdriver_evaluate', '__selenium_evaluate', '__webdriver_script_fn',
     '__driver_evaluate', '__fxdriver_evaluate', '__lastWatirAlert'].forEach(function (k) {
      try { if (k in window) out.push(k); } catch (e) {}
    });
    try {
      Object.keys(document).forEach(function (k) {
        if (/^\$?cdc_|^\$wdc_|^__(webdriver|selenium|fxdriver|driver)_/.test(k)) out.push('document.' + k);
      });
      ['webdriver', 'selenium', 'driver'].forEach(function (a) { if (document.documentElement.hasAttribute(a)) out.push('html[' + a + ']'); });
    } catch (e) {}
    return out.slice(0, 8);
  }

  function devices() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) return Promise.resolve(null);
    return timeout(navigator.mediaDevices.enumerateDevices().then(function (list) {
      var o = { audioinput: 0, audiooutput: 0, videoinput: 0 };
      list.forEach(function (d) { if (o[d.kind] != null) o[d.kind]++; });
      return o;
    }), 1500, null);
  }

  /* ------------------------------------------------ device traits (0.18.0) --- */
  // What comes from the machine and the system rather than from the browser engine, so that two browsers of one
  // device can be told apart from two devices (Chrome and Firefox on one computer share almost no other trait).

  // WebGL limits and shader precision without the names: the graphics card and its driver. p: the limits and
  // precision; e: the extension list (it differs more between engines, kept apart).
  function glParams() {
    var o = { p: '', e: '' };
    try {
      var c = document.createElement('canvas');
      var gl = c.getContext('webgl') || c.getContext('experimental-webgl');
      if (!gl) return o;
      var P = ['MAX_TEXTURE_SIZE', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_UNIFORM_VECTORS',
        'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_TEXTURE_IMAGE_UNITS',
        'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_VIEWPORT_DIMS', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE', 'SUBPIXEL_BITS'];
      var out = P.map(function (k) { var v = gl.getParameter(gl[k]); return v && typeof v === 'object' && v.length !== undefined ? Array.prototype.join.call(v, 'x') : String(v); });
      ['VERTEX_SHADER', 'FRAGMENT_SHADER'].forEach(function (sh) {
        ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT'].forEach(function (pr) {
          var x = gl.getShaderPrecisionFormat(gl[sh], gl[pr]);
          out.push(x ? x.rangeMin + '/' + x.rangeMax + '/' + x.precision : '-');
        });
      });
      o.p = hash(out.join('|'));
      o.e = hash((gl.getSupportedExtensions() || []).slice().sort().join(','));
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (e) {}
    return o;
  }

  // Scene 2.0: five small drawings, each leaning on another part of the graphics card (float maths, derivatives,
  // blending, texture filtering, trigonometry at its edges). Browsers of one computer go through one driver, so
  // our first scene already matched across engines; five give more to tell devices apart. Drawn twice: an
  // unmodified browser gives the same pixels (noise = something rewrote them).
  function scene2() {
    var o = { h: '', parts: [], noise: false };
    try {
      var c = document.createElement('canvas'); c.width = 32; c.height = 32;
      var opt = { antialias: false, preserveDrawingBuffer: true };
      var gl = c.getContext('webgl', opt) || c.getContext('experimental-webgl', opt);
      if (!gl) return o;
      var hp = gl.getShaderPrecisionFormat && gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
      var prec = 'precision ' + (hp && hp.precision > 0 ? 'highp' : 'mediump') + ' float;varying vec2 v;';
      var der = gl.getExtension('OES_standard_derivatives');
      var vs = 'attribute vec2 a;varying vec2 v;void main(){v=a*0.5+0.5;gl_Position=vec4(a,0.0,1.0);}';
      var frags = [
        prec + 'void main(){float x=v.x*1000.0+v.y*7.3;gl_FragColor=vec4(fract(sin(x)*1e4),fract(exp(v.y*9.0)),fract(pow(v.x+1.0,13.7)),1.0);}',
        der ? '#extension GL_OES_standard_derivatives : enable\n' + prec + 'void main(){float f=sin(v.x*50.0)*cos(v.y*31.0);gl_FragColor=vec4(fwidth(f)*8.0,abs(dFdx(f))*20.0,abs(dFdy(f))*20.0,1.0);}' : '',
        prec + 'uniform float k;void main(){gl_FragColor=vec4(v.x,v.y*k,1.0-v.x*k,0.37);}',
        prec + 'uniform sampler2D t;void main(){gl_FragColor=texture2D(t,v*0.73+0.11);}',
        prec + 'void main(){float a=atan(v.y*2.0-1.0,v.x*2.0-1.0);gl_FragColor=vec4(fract(a*7.0),fract(acos(v.x*1.999-0.9995)*5.0),fract(tan(v.y*1.5)),1.0);}'
      ];
      var sh = function (type, src) { var x = gl.createShader(type); gl.shaderSource(x, src); gl.compileShader(x); return x; };
      var buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
      var tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      var tp = new Uint8Array(64);
      for (var i = 0; i < 64; i++) tp[i] = (i * 53 + 17) % 256;
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 4, 4, 0, gl.RGBA, gl.UNSIGNED_BYTE, tp);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.disable(gl.DITHER); gl.viewport(0, 0, 32, 32);
      var px = new Uint8Array(32 * 32 * 4);
      var progs = frags.map(function (src) {
        if (!src) return null;
        var p = gl.createProgram();
        gl.attachShader(p, sh(gl.VERTEX_SHADER, vs)); gl.attachShader(p, sh(gl.FRAGMENT_SHADER, src)); gl.linkProgram(p);
        return gl.getProgramParameter(p, gl.LINK_STATUS) ? p : null;
      });
      var pass = function () {
        return progs.map(function (p, n) {
          if (!p) return '-';
          gl.useProgram(p);
          var loc = gl.getAttribLocation(p, 'a');
          gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
          gl.clearColor(0.1, 0.2, 0.3, 1.0); gl.clear(gl.COLOR_BUFFER_BIT);
          if (n === 2) {
            // three half-transparent layers on top of each other
            gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
            var k = gl.getUniformLocation(p, 'k');
            [0.3, 0.6, 0.9].forEach(function (x) { gl.uniform1f(k, x); gl.drawArrays(gl.TRIANGLES, 0, 6); });
            gl.disable(gl.BLEND);
          } else {
            if (n === 3) gl.uniform1i(gl.getUniformLocation(p, 't'), 0);
            gl.drawArrays(gl.TRIANGLES, 0, 6);
          }
          gl.readPixels(0, 0, 32, 32, gl.RGBA, gl.UNSIGNED_BYTE, px);
          var str = [];
          for (var i2 = 0; i2 < px.length; i2 += 1024) str.push(String.fromCharCode.apply(null, px.subarray(i2, i2 + 1024)));
          return hash(str.join('')).slice(0, 8);
        });
      };
      var a = pass(), b = pass();
      o.parts = a;
      o.noise = a.join() !== b.join();
      o.h = hash(a.join('|'));
      var lose = gl.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
    } catch (e) {}
    return o;
  }

  // The screen as the system lays it out: the size in device pixels, the strip the taskbar or dock takes, the
  // menu bar at the top (macOS), the colour range of the display and HDR, and whether more than one display is on.
  function screen2() {
    var sc = window.screen || {}, dpr = window.devicePixelRatio || 1;
    var on = function (q) { return mq(q) === true; };
    return {
      pw: Math.round((sc.width || 0) * dpr), ph: Math.round((sc.height || 0) * dpr),
      tb: (sc.height || 0) - (sc.availHeight || 0), tw: (sc.width || 0) - (sc.availWidth || 0),
      at: typeof sc.availTop === 'number' ? sc.availTop : null, al: typeof sc.availLeft === 'number' ? sc.availLeft : null,
      gamut: on('(color-gamut: rec2020)') ? 'rec2020' : (on('(color-gamut: p3)') ? 'p3' : (on('(color-gamut: srgb)') ? 'srgb' : '')),
      hdr: on('(dynamic-range: high)'), ext: sc.isExtended === true
    };
  }

  // The sound hardware: the default sample rate, the output channels and the latency of the system's audio.
  function audioHw() {
    var AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return Promise.resolve(null);
    try {
      var ac = new AC();
      var o = { sr: ac.sampleRate || 0, ch: ac.destination ? ac.destination.maxChannelCount : null,
        bl: typeof ac.baseLatency === 'number' ? Math.round(ac.baseLatency * 10000) / 10 : null };
      try { ac.close(); } catch (e) {}
      return Promise.resolve(o);
    } catch (e) { return Promise.resolve(null); }
  }

  // Emoji clock: one emoji of each Unicode emoji version. The newest one the system draws in colour as a single
  // glyph tells the version of its emoji font, which follows the version of the system: browsers and iOS 26+
  // freeze the system version in the User-Agent, the emoji do not. m: the sizes of three emoji (the font itself).
  var EMOJI = [['11', '\uD83E\uDD70'], ['12', '\uD83E\uDD71'], ['13', '\uD83E\uDD72'], ['13.1', '\u2764\uFE0F\u200D\uD83D\uDD25'], ['14', '\uD83E\uDEE0'],
    ['15', '\uD83E\uDEE8'], ['15.1', '\uD83D\uDE42\u200D\u2194\uFE0F'], ['16', '\uD83E\uDEE9']];
  function emojiClock() {
    var o = { v: '', ok: '', m: '' };
    try {
      var c = document.createElement('canvas'); c.width = 64; c.height = 40;
      var x = c.getContext('2d');
      x.font = '28px sans-serif'; x.textBaseline = 'top';
      var one = x.measureText('\uD83D\uDE00').width;
      var ok = [];
      EMOJI.forEach(function (e) {
        x.clearRect(0, 0, 64, 40);
        x.fillText(e[1], 0, 2);
        var d = x.getImageData(0, 0, 64, 40).data, col = 0;
        for (var i = 0; i < d.length; i += 4) {
          if (d[i + 3] > 128 && (Math.abs(d[i] - d[i + 1]) > 40 || Math.abs(d[i + 1] - d[i + 2]) > 40)) col++;
        }
        // in colour and as one glyph: a sequence the font does not know falls apart into two or more
        if (col > 20 && x.measureText(e[1]).width < one * 1.5) ok.push(e[0]);
      });
      o.ok = ok.join(',');
      o.v = ok.length ? ok[ok.length - 1] : '';
      var m = x.measureText('\uD83D\uDE00\uD83E\uDEE0\uD83D\uDC4D\uD83C\uDFFD');
      o.m = hash([one, m.width, m.actualBoundingBoxAscent, m.actualBoundingBoxDescent].map(function (n) { return Math.round((n || 0) * 10); }).join(','));
    } catch (e) {}
    return o;
  }

  // How much the browser lets a site keep, as a class only (0: under 1 GB ... 8: 1.6 TB and more). In Chromium
  // it follows the size of the disk, which tells two phones of one model with different storage apart.
  function storeTier() {
    if (!navigator.storage || !navigator.storage.estimate) return Promise.resolve(null);
    return timeout(navigator.storage.estimate().then(function (e) {
      var gb = ((e && e.quota) || 0) / 1e9, edges = [1, 10, 50, 100, 200, 400, 800, 1600], t = 0;
      while (t < edges.length && gb >= edges[t]) t++;
      return { t: t };
    }), 1000, null);
  }

  // Motion sensors, as any page sees them without asking. Chrome and Firefox on Android deliver
  // accelerometer readings straight away; iOS shows them only after the visitor allows it
  // (requestPermission, which we never call; desktop Chrome has that function too since 2025, so it
  // tells nothing about the device and is only noted); computers have no sensors and send nothing or empty
  // readings. Only a summary is kept: how many readings came in 1.2 s and the average strength of
  // gravity in them, never the readings themselves.
  function motion() {
    var D = window.DeviceMotionEvent;
    var o = { api: !!D, perm: !!(D && typeof D.requestPermission === 'function'), blocked: false, n: 0, real: 0, g: null };
    try {
      var pp = document.permissionsPolicy || document.featurePolicy;
      if (pp && pp.allowsFeature && !pp.allowsFeature('accelerometer')) o.blocked = true; // the page's own policy turned sensors off
    } catch (e) {}
    if (!D || o.blocked) return Promise.resolve(o);
    return new Promise(function (resolve) {
      var sum = 0;
      var on = function (e) {
        o.n++;
        var a = e.accelerationIncludingGravity;
        if (!a || a.x == null || a.y == null || a.z == null) return;
        o.real++;
        sum += Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
      };
      window.addEventListener('devicemotion', on);
      setTimeout(function () {
        window.removeEventListener('devicemotion', on);
        if (o.real) o.g = Math.round(sum / o.real * 100) / 100;
        resolve(o);
      }, 1200);
    });
  }

  // WebRTC local candidate (no STUN): a real local IP here = the browser leaks it
  function rtc() {
    return new Promise(function (resolve) {
      var res = { supported: false, ip: '', mdns: false };
      var RTC = window.RTCPeerConnection || window.webkitRTCPeerConnection;
      if (!RTC) return resolve(res);
      res.supported = true;
      var pc, done = false;
      function finish() { if (!done) { done = true; try { pc.close(); } catch (e) {} resolve(res); } }
      try {
        pc = new RTC({ iceServers: [] });
        pc.createDataChannel('sl');
        pc.onicecandidate = function (e) {
          var cand = e && e.candidate && e.candidate.candidate;
          if (!cand) return;
          var m = cand.match(/([0-9]{1,3}(?:\.[0-9]{1,3}){3})|([a-f0-9-]+\.local)/i);
          if (m) { if (m[2]) res.mdns = true; else if (m[1] && !res.ip) res.ip = m[1]; }
        };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(finish);
      } catch (e) { return resolve(res); }
      setTimeout(finish, 1500);
    });
  }

  function workerProbe(src) {
    return timeout(new Promise(function (resolve) {
      try {
        var w = new Worker(src);
        w.onmessage = function (e) { resolve(e.data); w.terminate(); };
        w.onerror = function () { resolve(null); };
        w.postMessage(1);
      } catch (e) { resolve(null); }
    }), 1500, null);
  }

  function iframeProbe() {
    try {
      var f = document.createElement('iframe');
      // not display:none: a hidden-by-display frame reports a 0-wide screen in Chromium
      f.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1px;height:1px;border:0;visibility:hidden';
      document.body.appendChild(f);
      var w = f.contentWindow, n = w.navigator, o = {
        ok: true, ua: n.userAgent, platform: n.platform,
        hc: typeof n.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
        sw: w.screen ? w.screen.width : null
      };
      document.body.removeChild(f);
      return o;
    } catch (e) { return null; }
  }

  function uaData() {
    var u = navigator.userAgentData;
    if (!u) return Promise.resolve(null);
    var base = { brands: (u.brands || []).map(function (b) { return { brand: b.brand, version: b.version }; }), mobile: !!u.mobile, platform: u.platform || '' };
    if (!u.getHighEntropyValues) return Promise.resolve(base);
    return timeout(u.getHighEntropyValues(['platformVersion', 'architecture', 'bitness', 'model', 'fullVersionList']).then(function (h) {
      base.high = { platformVersion: h.platformVersion, architecture: h.architecture, bitness: h.bitness, model: h.model,
        fullVersionList: (h.fullVersionList || []).map(function (b) { return b.brand + ' ' + b.version; }) };
      return base;
    }), 1000, base);
  }

  function mq(q) { try { return window.matchMedia(q).matches; } catch (e) { return null; } }
  // Chrome and Edge hand a page its window size a little after it starts: until then the outer window
  // reads 0x0 (a light page like home checks early, a prerendered page was just shown). Wait for the
  // real size, at most 2.5 s; an old headless browser stays 0x0 and is still caught.
  function waitOuter(s) {
    if (s.scr.ow || s.scr.oh) return s;
    return new Promise(function (done) {
      var t0 = Date.now();
      (function tick() {
        if (!window.outerWidth && !window.outerHeight && Date.now() - t0 < 2500) return setTimeout(tick, 50);
        s.scr.ow = window.outerWidth; s.scr.oh = window.outerHeight;
        s.scr.sx = window.screenX; s.scr.sy = window.screenY; s.scr.vis = document.visibilityState || '';
        done(s);
      })();
    });
  }
  // a page the browser prerendered (from the address bar) and then showed: activationStart is set
  function wasPrerendered() {
    try { var n = performance.getEntriesByType('navigation')[0]; return !!(n && n.activationStart > 0); } catch (e) { return false; }
  }

  function collect(workerSrc, edgeConf) {
    var nav = navigator, scr = window.screen || {};
    var tzName = ''; try { tzName = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
    var locale = ''; try { locale = Intl.DateTimeFormat().resolvedOptions().locale || ''; } catch (e) {}
    var gl = webgl();
    var c1 = canvasHash(), c2 = canvasHash();
    var roads = {};
    var s = {
      v: 1,
      nav: {
        ua: nav.userAgent || '', platform: nav.platform || '', vendor: nav.vendor || '',
        language: nav.language || '', languages: nav.languages ? Array.prototype.slice.call(nav.languages) : [],
        hc: typeof nav.hardwareConcurrency === 'number' ? nav.hardwareConcurrency : null,
        dm: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
        touch: nav.maxTouchPoints || 0, cookies: !!nav.cookieEnabled,
        dnt: nav.doNotTrack || window.doNotTrack || null, gpc: nav.globalPrivacyControl === true,
        pdf: nav.pdfViewerEnabled === true,
        plugins: nav.plugins ? nav.plugins.length : 0, mimes: nav.mimeTypes ? nav.mimeTypes.length : 0
      },
      scr: {
        w: scr.width || 0, h: scr.height || 0, aw: scr.availWidth || 0, ah: scr.availHeight || 0,
        cd: scr.colorDepth || 0, dpr: window.devicePixelRatio || 1,
        iw: window.innerWidth || 0, ih: window.innerHeight || 0, ow: window.outerWidth, oh: window.outerHeight,
        sx: window.screenX, sy: window.screenY, vis: document.visibilityState || '', pre: wasPrerendered()
      },
      tz: { name: tzName, offset: -new Date().getTimezoneOffset(), intlOffset: tzName ? intlOffset(tzName) : null, locale: locale },
      media: {
        dark: mq('(prefers-color-scheme: dark)'), reduced: mq('(prefers-reduced-motion: reduce)'),
        pointer: mq('(pointer: fine)') ? 'fine' : (mq('(pointer: coarse)') ? 'coarse' : 'none'), hover: mq('(hover: hover)'),
        // settings of the system (0.18.0): contrast, transparency, inverted and forced colours
        contrast: mq('(prefers-contrast: more)') ? 'more' : (mq('(prefers-contrast: less)') ? 'less' : (mq('(prefers-contrast: custom)') ? 'custom' : 'no')),
        transp: mq('(prefers-reduced-transparency: reduce)'), invert: mq('(inverted-colors: inverted)'), forced: mq('(forced-colors: active)')
      },
      scr2: screen2(),
      gfx: { vendor: gl.vendor || '', renderer: gl.renderer || '', version: gl.version || '', glsl: gl.glsl || '',
             maxTex: gl.maxTex || null, extCount: gl.extCount || 0, hash: gl.hash || '', params: glParams() },
      canvas: { h1: c1, h2: c2, noise: !!(c1 && c2 && c1 !== c2), flat: canvasFlat() },
      scene: webglScene(roads),
      scene2: scene2(),
      emoji: emojiClock(),
      fonts: fonts(),
      auto: { webdriver: nav.webdriver === true, chromeObj: !!window.chrome, tamper: tamperCheck(), engine: jsEngine(), traces: autoTraces() },
      // WebTransport (HTTP/3 for pages, 0.19.0): exposed only in a secure context, so elsewhere nothing is said
      wt: window.isSecureContext ? typeof window.WebTransport === 'function' : null,
      iframe: iframeProbe(),
      priv: {
        brave: !!(nav.brave && typeof nav.brave.isBrave === 'function'),
        rfpLike: /Firefox\//.test(nav.userAgent || '') && scr.width === window.innerWidth && scr.height === window.innerHeight
      }
    };
    return Promise.all([audioHash(), audioHash(), webgpu(), voices(), devices(), rtc(), workerProbe(workerSrc), uaData(), null /* the open collector contacts no server */, motion(), sceneRoads(roads), audioHw(), storeTier()])
      .then(function (r) {
        if (r[10]) s.scene.roads = r[10];
        s.audio = { h1: r[0] ? hash(r[0]) : '', h2: r[1] ? hash(r[1]) : '', noise: !!(r[0] && r[1] && r[0] !== r[1]) };
        if (r[2]) { s.gfx.webgpuVendor = r[2].vendor || ''; s.gfx.webgpuArch = r[2].arch || ''; }
        s.voices = r[3] ? r[3].n : r[3]; s.vo = r[3] ? r[3].k : null; s.devices = r[4]; s.rtc = r[5]; s.worker = r[6]; s.nav.uad = r[7];
        if (r[8]) s.edge = r[8];
        s.motion = r[9];
        s.audio2 = r[11];
        s.store = r[12];
        s.vh = r[3] ? r[3].h || '' : '';
        // the voice list often arrives late: read it once more now that everything else is done
        try {
          var vl = window.speechSynthesis ? speechSynthesis.getVoices() : [];
          if (vl && vl.length > (s.voices || 0)) { var vs2 = voiceSummary(vl); s.voices = vs2.n; s.vo = vs2.k; s.vh = vs2.h; }
        } catch (e) {}
        s.fp = hash([s.canvas.h1, s.gfx.hash, s.audio.h1, s.fonts.join(','), s.scr.w + 'x' + s.scr.h + '@' + s.scr.dpr,
          s.nav.hc, s.nav.dm, s.tz.name, s.nav.languages.join(','), s.nav.platform].join('|'));
        return s;
      })
      .then(waitOuter);
  }

  // Research links (0.16.1): two more quick passes over the drawing, sound, font and voice tests. Only how many
  // times each part came out different is kept (s.rep), which shows the natural noise of this device.

  return {
    version: '0.3.0',
    /** @param {{worker?: string}} [opts] worker: URL of collector-worker.js (same origin); omit to skip the worker cross-check */
    collect: function (opts) { opts = opts || {}; return collect(opts.worker || null, null); },
    hash: hash
  };
}));
