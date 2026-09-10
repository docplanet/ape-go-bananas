// Cross-origin isolation, without a server that can set headers.
//
// The in-tab runtime needs SharedArrayBuffer, which a page only gets when it
// is cross-origin isolated -- two response headers the origin must send.
// GitHub Pages serves static files and sets no custom headers, so a service
// worker adds them to every response instead: the first visit registers it
// and reloads once, and from then on the page is isolated.
//
// This file is loaded in two contexts and behaves differently in each: as the
// service worker, and as a script on the page that registers it.
if (typeof self.document === 'undefined') {
  self.addEventListener('install', () => self.skipWaiting());
  self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
  self.addEventListener('fetch', (event) => {
    const request = event.request;
    // A cache-only request cannot be re-issued; leave it alone.
    if (request.cache === 'only-if-cached' && request.mode !== 'same-origin') return;
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status === 0) return response; // opaque: no headers to add
          const headers = new Headers(response.headers);
          headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
          headers.set('Cross-Origin-Opener-Policy', 'same-origin');
          return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
        })
        .catch((err) => new Response(String(err), { status: 502 })),
    );
  });
} else if (!self.crossOriginIsolated && self.isSecureContext && self.navigator.serviceWorker) {
  const src = self.document.currentScript.src;
  self.navigator.serviceWorker.register(src).then(
    (registration) => {
      // Registered but not yet in control of this page: one reload puts it there.
      if (registration.active && !self.navigator.serviceWorker.controller) self.location.reload();
      registration.addEventListener('updatefound', () => self.location.reload());
    },
    () => {
      /* no worker: the page still runs, minus the in-tab runtime */
    },
  );
}
