// Page-world hook: forwards web notifications the site shows to the isolated content script.
// Injected on Start, so it only catches notifications created after that point.
(() => {
  if (window.__stlMain) return;
  window.__stlMain = true;
  const post = (title, opts) => {
    try {
      window.postMessage({ __stl: true, kind: 'notification', title: String(title ?? ''), body: opts?.body ? String(opts.body) : '' }, '*');
    } catch {}
  };

  const N = window.Notification;
  if (N) {
    const Wrapped = function (title, opts) {
      post(title, opts);
      return new N(title, opts);
    };
    Wrapped.prototype = N.prototype;
    Object.defineProperty(Wrapped, 'permission', { get: () => N.permission });
    Wrapped.requestPermission = N.requestPermission.bind(N);
    window.Notification = Wrapped;
  }

  const SWR = window.ServiceWorkerRegistration?.prototype;
  if (SWR?.showNotification) {
    const orig = SWR.showNotification;
    SWR.showNotification = function (title, opts) {
      post(title, opts);
      return orig.call(this, title, opts);
    };
  }
})();
