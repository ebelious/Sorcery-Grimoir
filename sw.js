self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service worker active');
});

self.addEventListener('fetch', (event) => {
  // Basic pass-through (you can enhance later)
});
