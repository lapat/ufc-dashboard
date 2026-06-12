// Injected into DraftKings page context — intercepts all fetch calls
(function () {
  const orig = window.fetch;
  window.fetch = async function (...args) {
    const res = await orig.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (url.includes('api.draftkings.com')) {
      try {
        const clone = res.clone();
        clone.json().then(data => {
          window.postMessage({ type: 'DK_API', url, data }, '*');
        }).catch(() => {});
      } catch (_) {}
    }
    return res;
  };

  // Also intercept XHR in case DK uses it
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this._url = url;
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    this.addEventListener('load', function () {
      if (this._url && this._url.includes('api.draftkings.com')) {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ type: 'DK_API', url: this._url, data }, '*');
        } catch (_) {}
      }
    });
    return origSend.apply(this, arguments);
  };
})();
