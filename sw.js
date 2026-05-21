/**
 * sw.js — Kain Tayo Filipino Food Identifier
 * Offline-first PWA service worker with versioned cache management.
 *
 * Strategy summary:
 *   - App shell (HTML, icons) → Cache-First
 *   - AI model files (model.json, metadata.json, weights.bin) → Network-First with cache fallback
 *   - TF.js + Teachable Machine CDN scripts → Network-First (cached after first fetch, works offline)
 *   - Google Fonts → Stale-While-Revalidate
 *   - POST / non-GET → pass through (never intercept)
 */

const CACHE_VERSION = "kain-tayo-v3";
const OFFLINE_URL   = "./index.html";

// ─── Assets to pre-cache on install ─────────────────────────────────────────
// TF.js and Teachable Machine are loaded from CDN — they get cached
// automatically by the fetch handler on first use (no local copies needed).
const PRECACHE_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
];

// Model files are pre-cached separately so a single fetch failure
// doesn't abort the entire install.
const MODEL_ASSETS = [
  "./model/model.json",
  "./model/metadata.json",
  "./model/weights.bin",
];

// ─── Install ─────────────────────────────────────────────────────────────────
self.addEventListener("install", (event) => {
  console.log("[SW] Installing v3…");
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_VERSION);

      // Pre-cache app shell — fail-fast so we know about broken paths early
      await cache.addAll(PRECACHE_ASSETS);
      console.log("[SW] App shell cached.");

      // Pre-cache model files — best-effort (offline install is fine without them)
      await Promise.allSettled(
        MODEL_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn("[SW] Could not pre-cache model file:", url, err.message)
          )
        )
      );
      console.log("[SW] Model pre-cache attempt complete.");

      // Activate immediately without waiting for old SW to die
      await self.skipWaiting();
    })()
  );
});

// ─── Activate ────────────────────────────────────────────────────────────────
self.addEventListener("activate", (event) => {
  console.log("[SW] Activating…");
  event.waitUntil(
    (async () => {
      // Purge all caches from previous versions
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_VERSION)
          .map((name) => {
            console.log("[SW] Removing old cache:", name);
            return caches.delete(name);
          })
      );

      // Take control of all open pages immediately
      await self.clients.claim();

      // Notify all clients that the new SW is active so they can show
      // the "App ready for offline use" banner.
      const clients = await self.clients.matchAll({ type: "window" });
      clients.forEach((client) =>
        client.postMessage({ type: "SW_ACTIVATED", version: CACHE_VERSION })
      );

      console.log("[SW] Active — controlling all clients.");
    })()
  );
});

// ─── Fetch ───────────────────────────────────────────────────────────────────
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Only intercept GET requests over http(s)
  if (request.method !== "GET") return;
  if (!url.protocol.startsWith("http")) return;

  // 1. Google Fonts → stale-while-revalidate
  if (
    url.hostname === "fonts.googleapis.com" ||
    url.hostname === "fonts.gstatic.com"
  ) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  // 2. AI Model files → network-first (ensures fresh weights after retraining)
  if (url.pathname.includes("/model/")) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 3. TF.js + Teachable Machine CDN → network-first, cached after first fetch
  //    On second+ visits (including offline), these are served from cache.
  if (
    url.hostname.includes("teachablemachine") ||
    url.hostname.includes("tensorflow") ||
    url.hostname.includes("jsdelivr")
  ) {
    event.respondWith(networkFirst(request));
    return;
  }

  // 4. Same-origin app shell + libs → cache-first
  if (url.origin === self.location.origin) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 5. Everything else → stale-while-revalidate
  event.respondWith(staleWhileRevalidate(request));
});

// ─── Caching Strategies ──────────────────────────────────────────────────────

/** Cache-First: serve from cache; fall back to network and update cache. */
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    // Return the offline page for navigation requests
    if (request.mode === "navigate") {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    return new Response("Offline — resource not available.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/** Network-First: try network; fall back to cache. Useful for model files. */
async function networkFirst(request) {
  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_VERSION);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) return cached;

    if (request.mode === "navigate") {
      const offline = await caches.match(OFFLINE_URL);
      if (offline) return offline;
    }
    return new Response("Offline — resource not available.", {
      status: 503,
      headers: { "Content-Type": "text/plain" },
    });
  }
}

/** Stale-While-Revalidate: return cache immediately; update in background. */
async function staleWhileRevalidate(request) {
  const cache  = await caches.open(CACHE_VERSION);
  const cached = await cache.match(request);

  // Kick off a background update whether or not we have a cached copy
  const fetchPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);

  return cached || fetchPromise || new Response("Offline", { status: 503 });
}
