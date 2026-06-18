// Runs in MAIN world at document_start — intercepts fetch/XHR/WebSocket before DK's code runs
(function () {
  // WebSocket interception — mybets data comes over WS, not fetch
  const OrigWS = window.WebSocket;
  function PatchedWS(url, protocols) {
    const ws = protocols !== undefined ? new OrigWS(url, protocols) : new OrigWS(url);
    if (typeof url === 'string' && (url.includes('dkapis.com') || url.includes('draftkings.com'))) {
      ws.addEventListener('open', function () {
        window.postMessage({ type: 'DK_WS_STATUS', connected: true, url, ts: Date.now() }, '*');
      });
      ws.addEventListener('close', function (e) {
        window.postMessage({ type: 'DK_WS_STATUS', connected: false, url, code: e.code, ts: Date.now() }, '*');
      });
      ws.addEventListener('error', function () {
        window.postMessage({ type: 'DK_WS_STATUS', connected: false, url, error: true, ts: Date.now() }, '*');
      });
      ws.addEventListener('message', function (evt) {
        try {
          const data = JSON.parse(evt.data);
          if (data?.result?.initial?.bets || data?.result?.update?.bets) {
            window.postMessage({ type: 'DK_API', url: url, data: data }, '*');
          }
        } catch (_) {}
      });
    }
    return ws;
  }
  PatchedWS.prototype = OrigWS.prototype;
  PatchedWS.CONNECTING = 0; PatchedWS.OPEN = 1; PatchedWS.CLOSING = 2; PatchedWS.CLOSED = 3;
  window.WebSocket = PatchedWS;

  const orig = window.fetch;
  window.fetch = function (...args) {
    // Get the original promise and return it UNTOUCHED — this keeps any rejection
    // attributed to the caller (DK's code), not our extension.
    const promise = orig.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (url.includes('draftkings.com') && url.includes('/api/')) {
      // Observe on a SEPARATE side-chain that never propagates to anyone
      promise.then(res => {
        try {
          res.clone().json().then(data => {
            window.postMessage({ type: 'DK_API', url, data }, '*');
          }).catch(() => {});
        } catch (_) {}
      }).catch(() => {}); // swallow errors from our side-chain only
    }
    return promise; // original promise, untouched — errors belong to DK's caller
  };

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      if (this._url?.includes('draftkings.com') && this._url?.includes('/api/')) {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ type: 'DK_API', url: this._url, data }, '*');
        } catch (_) {}
      }
    });
    return origSend.apply(this, arguments);
  };
})();
