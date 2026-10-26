/* SpoofLens probe: what a Web Worker sees. Spoofing tools often patch the page's
   navigator but forget workers, so the page compares these values with its own. */
self.onmessage = function () {
  var n = self.navigator || {};
  var tz = '';
  try { tz = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (e) {}
  self.postMessage({
    ok: true,
    ua: n.userAgent || null,
    platform: n.platform || null,
    languages: n.languages ? Array.prototype.slice.call(n.languages) : null,
    hc: typeof n.hardwareConcurrency === 'number' ? n.hardwareConcurrency : null,
    dm: typeof n.deviceMemory === 'number' ? n.deviceMemory : null,
    tz: tz,
    webdriver: n.webdriver === true
  });
};
