import '@soundworks/helpers/polyfills.js';

// After a researcher reset the page opens with ?reset and never connects, so it
// holds no checkin slot; scanning the QR code opens the plain URL and rejoins.
if (new URLSearchParams(window.location.search).has('reset')) {
  document.documentElement.lang = 'en';
  document.body.className = 'player';
  document.title = 'Reset';
  const notice = document.createElement('main');
  notice.className = 'introduction';
  const heading = document.createElement('h1');
  heading.textContent = 'This round has ended';
  const text = document.createElement('p');
  text.textContent = 'Please scan the QR code again to join.';
  notice.append(heading, text);
  document.body.append(notice);
} else {
  import('./player/app.js');
}
