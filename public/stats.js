// Privacy-friendly visit count with GoatCounter: no cookies, nothing stored on the device,
// no personal data. Sends only the page path (never the query string or anything typed),
// the referring site's origin and the screen width. Skipped when Do Not Track is on, and
// everywhere except the live site (so local copies and tests never count).
(function () {
  if (location.hostname !== 'perezamadorluisenrique-gif.github.io') return;
  if (navigator.doNotTrack === '1' || window.doNotTrack === '1') return;
  var ref = '';
  try { if (document.referrer) ref = new URL(document.referrer).origin; } catch (e) { ref = ''; }
  if (ref === location.origin) ref = '';
  var url = 'https://siuldev5454.goatcounter.com/count?p=' + encodeURIComponent(location.pathname) +
    '&r=' + encodeURIComponent(ref) + '&s=' + (screen.width || 0) + '&rnd=' + Math.random().toString(36).slice(2);
  try { if (navigator.sendBeacon && navigator.sendBeacon(url)) return; } catch (e) { /* fall back */ }
  new Image().src = url;
})();
