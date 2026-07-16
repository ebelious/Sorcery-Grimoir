self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('Service worker active');
});

self.addEventListener('fetch', (event) => {
  // Basic pass-through (you can enhance later)
});

// ─────────────────────────────────────────────────────────────────────────────
// FIREBASE CLOUD MESSAGING (background push)
// This handles News/Discord/YouTube notifications that arrive while the app
// is closed or backgrounded. Fill in the SAME config used in index.html
// (Project Settings → General → Your apps → Web app).
// ─────────────────────────────────────────────────────────────────────────────
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js');

firebase.initializeApp({
  apiKey: "AIzaSyAnTZ_8Ya-l9lWEG2CIw6OAR0X8dvQziys",
  authDomain: "sorcery-grimoir.firebaseapp.com",
  projectId: "sorcery-grimoir",
  storageBucket: "sorcery-grimoir.firebasestorage.app",
  messagingSenderId: "58533506214",
  appId: "1:58533506214:web:ce8917b858d9da0e211867",
  measurementId: "G-34SMF7DB6S"
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage(function(payload) {
  var n = (payload && payload.notification) || {};
  var title = n.title || 'Sorcery Grimoire';
  var options = {
    body: n.body || '',
    icon: 'icons/icon-192.png',
    badge: 'icons/icon-192.png'
  };
  self.registration.showNotification(title, options);
});
