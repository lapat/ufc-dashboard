// Runs in MAIN world at document_start — intercepts fetch before DK's code runs
(function () {
  const orig = window.fetch;
  window.fetch = async function (...args) {
    const res = await orig.apply(this, args);
    const url = typeof args[0] === 'string' ? args[0] : (args[0]?.url || '');
    if (url.includes('draftkings.com') && url.includes('/api/')) {
      try {
        res.clone().json().then(data => {
          window.postMessage({ type: 'DK_API', url, data }, '*');
        }).catch(() => {});
      } catch (_) {}
    }
    return res;
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
