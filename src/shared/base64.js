// Fast-enough base64 for shipping captured media bytes through chrome.runtime ports
// (which only carry JSON). Classic script; exposes VRX.b64.
(function (root) {
  function encode(u8) {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode.apply(null, u8.subarray(i, Math.min(i + CH, u8.length)));
    return btoa(s);
  }
  function decode(str) {
    const bin = atob(str);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  root.VRX = root.VRX || {};
  root.VRX.b64 = { encode, decode };
})(typeof globalThis !== 'undefined' ? globalThis : self);
