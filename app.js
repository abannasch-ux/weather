'use strict';

// Andy's Weather — built for one job: before you walk out the door,
// will it rain or snow, when, and how much. Places / Radar / Right Here.
// Data: Open-Meteo (forecast + geocoding), RainViewer (radar),
// National Weather Service (alerts). All free, no keys.

var FALLBACK = { lat: 42.7325, lon: -84.5555, name: 'Lansing, MI' };
var SEED_PLACES = [
  { name: 'Home — DeWitt, MI', lat: 42.8328, lon: -84.5642 },
  { name: 'Portland, MI', lat: 42.8692, lon: -84.9031 },
  { name: 'Cedar, MI', lat: 44.8992, lon: -85.8675 }
];
var LS_KEY = 'andy-weather-places-v1';

/* ---------------- State ---------------- */

var places = loadPlaces();
var gpsPos = null;          // {lat, lon} once known
var gpsPromise = null;
var alertCache = {};        // "lat,lon" -> [features]
var currentView = 'here';

function loadPlaces() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* fall through to seeds */ }
  return SEED_PLACES.slice();
}
function savePlaces() {
  try { localStorage.setItem(LS_KEY, JSON.stringify(places)); } catch (e) { /* storage off */ }
}

function getPosition() {
  if (gpsPromise) return gpsPromise;
  gpsPromise = new Promise(function (resolve) {
    if (!('geolocation' in navigator)) { resolve(null); return; }
    navigator.geolocation.getCurrentPosition(
      function (pos) { gpsPos = { lat: pos.coords.latitude, lon: pos.coords.longitude }; resolve(gpsPos); },
      function () { resolve(null); },
      { timeout: 10000, maximumAge: 300000 }
    );
  });
  return gpsPromise;
}

/* ---------------- Formatting helpers ---------------- */

function fmtHour(iso) {
  var h = parseInt(iso.slice(11, 13), 10);
  var ap = h >= 12 ? 'PM' : 'AM';
  return (h % 12 || 12) + ' ' + ap;
}
function fmtAmt(v) {
  if (!v || v < 0.005) return '0';
  var s = (Math.round(v * 100) / 100).toFixed(2);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}
function fmtDayName(isoDate, idx) {
  if (idx === 0) return 'Today';
  var d = new Date(isoDate + 'T12:00:00');
  return d.toLocaleDateString([], { weekday: 'short' });
}
function esc(s) {
  return String(s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function codeInfo(code) {
  if (code === 0) return ['☀️', 'Clear'];
  if (code === 1) return ['🌤️', 'Mostly clear'];
  if (code === 2) return ['⛅', 'Partly cloudy'];
  if (code === 3) return ['☁️', 'Overcast'];
  if (code === 45 || code === 48) return ['🌫️', 'Fog'];
  if (code === 51 || code === 53 || code === 55) return ['🌦️', 'Drizzle'];
  if (code === 56 || code === 57) return ['🌦️', 'Freezing drizzle'];
  if (code === 61) return ['🌧️', 'Light rain'];
  if (code === 63) return ['🌧️', 'Rain'];
  if (code === 65) return ['🌧️', 'Heavy rain'];
  if (code === 66 || code === 67) return ['🌧️', 'Freezing rain'];
  if (code === 71) return ['🌨️', 'Light snow'];
  if (code === 73) return ['🌨️', 'Snow'];
  if (code === 75) return ['🌨️', 'Heavy snow'];
  if (code === 77) return ['🌨️', 'Snow grains'];
  if (code === 80) return ['🌦️', 'Light showers'];
  if (code === 81) return ['🌦️', 'Showers'];
  if (code === 82) return ['🌦️', 'Heavy showers'];
  if (code === 85 || code === 86) return ['🌨️', 'Snow showers'];
  if (code === 95) return ['⛈️', 'Thunderstorm'];
  if (code === 96 || code === 99) return ['⛈️', 'T-storm with hail'];
  return ['🌡️', '—'];
}

// Wind severity — plain words from sustained speed + gusts.
function windSev(speed, gust) {
  var s = Math.round(speed || 0), g = Math.round(gust || 0);
  var m = Math.max(s, g);
  var label = m < 8 ? 'Calm' : m < 14 ? 'Light' : m < 20 ? 'Breezy' : m < 28 ? 'Windy' : m < 38 ? 'Strong' : 'Very strong';
  return { label: label, text: label + ' · ' + s + ' mph' + (g > s ? ', gusts ' + g : '') };
}

/* ---------------- Forecast fetching ---------------- */

function fetchForecast(lat, lon) {
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
    '&longitude=' + lon.toFixed(4) +
    '&current=temperature_2m,weather_code,wind_speed_10m,wind_gusts_10m,precipitation' +
    '&hourly=temperature_2m,weather_code,precipitation,precipitation_probability,snowfall,wind_speed_10m,wind_gusts_10m' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,snowfall_sum,precipitation_probability_max,wind_gusts_10m_max' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&snowfall_unit=inch' +
    '&timezone=auto&forecast_days=7';
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('forecast ' + r.status);
    return r.json();
  });
}

function fetchAlerts(lat, lon) {
  var key = lat.toFixed(2) + ',' + lon.toFixed(2);
  if (alertCache[key]) return Promise.resolve(alertCache[key]);
  return fetch('https://api.weather.gov/alerts/active?point=' + lat.toFixed(4) + ',' + lon.toFixed(4))
    .then(function (r) { return r.ok ? r.json() : { features: [] }; })
    .then(function (j) { alertCache[key] = j.features || []; return alertCache[key]; })
    .catch(function () { return []; });
}

function nowIdx(data) {
  var ct = data.current.time.slice(0, 13);
  for (var i = 0; i < data.hourly.time.length; i++) {
    if (data.hourly.time[i].slice(0, 13) === ct) return i;
  }
  return 0;
}
function endOfTodayIdx(data, fromIdx) {
  var day = data.current.time.slice(0, 10);
  var i = fromIdx;
  while (i < data.hourly.time.length && data.hourly.time[i].slice(0, 10) === day) i++;
  return i;
}

// Group wet hours into windows (merges a single dry hour inside a window).
function precipWindows(data, startIdx, endIdx) {
  var H = data.hourly, out = [], cur = null, i;
  for (i = startIdx; i < endIdx && i < H.time.length; i++) {
    var amt = H.precipitation[i] || 0;
    var snow = H.snowfall[i] || 0;
    var wet = amt > 0.005 || snow > 0.005;
    if (wet) {
      if (!cur) cur = { start: i, end: i, total: 0, snow: 0, gap: 0 };
      if (i - cur.end > 1) { out.push(cur); cur = { start: i, end: i, total: 0, snow: 0, gap: 0 }; }
      cur.end = i; cur.total += amt; cur.snow += snow;
    }
  }
  if (cur) out.push(cur);
  out.forEach(function (w) {
    w.isSnow = w.snow >= 0.1;
    w.isMixed = w.isSnow && (w.total - 0) > 0.02 && w.snow < w.total * 4 && (w.total - Math.min(w.total, w.snow / 10)) > 0.03;
    w.kind = w.isSnow ? 'Snow' : 'Rain';
    w.amountText = w.isSnow
      ? fmtAmt(w.snow) + ' in of snow'
      : fmtAmt(w.total) + ' in of rain';
  });
  return out;
}

function windowSentence(w, data, nowI) {
  var H = data.hourly;
  var startTxt = w.start <= nowI ? 'now' : fmtHour(H.time[w.start]);
  var endTxt = fmtHour(H.time[Math.min(w.end + 1, H.time.length - 1)]);
  if (w.start <= nowI) {
    return '<b>' + w.kind + ' now</b>, ending around <b>' + endTxt + '</b> · ' + w.amountText + ' total';
  }
  return '<b>' + w.kind + ' starting ' + startTxt + '</b>, through about ' + endTxt + ' · ' + w.amountText;
}

/* ---------------- Shared render blocks ---------------- */

function alertsHtml(features) {
  if (!features.length) return '';
  return features.map(function (f) {
    var p = f.properties || {};
    var sev = (p.severity === 'Extreme' || p.severity === 'Severe') ? ' severe' : '';
    var ends = p.ends || p.expires;
    var endsTxt = ends ? ' · until ' + new Date(ends).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' }) : '';
    return '<div class="alert' + sev + '"><b>⚠ ' + esc(p.event || 'Weather alert') + '</b>' +
      esc(p.headline || '') + '<span>' + esc(p.areaDesc || '') + endsTxt + '</span></div>';
  }).join('');
}

function hourlyHtml(data, startIdx, count) {
  var H = data.hourly, cells = '';
  for (var i = startIdx; i < startIdx + count && i < H.time.length; i++) {
    var ci = codeInfo(H.weather_code[i]);
    var p = H.precipitation[i] || 0;
    var sn = H.snowfall[i] || 0;
    var pTxt = (p > 0.005 || sn > 0.005)
      ? (sn >= 0.05 ? '❄ ' + fmtAmt(sn) + '"' : '💧 ' + fmtAmt(p) + '"')
      : ((H.precipitation_probability[i] || 0) >= 20 ? (H.precipitation_probability[i]) + '%' : '');
    cells += '<div class="hour"><div class="h">' + (i === startIdx ? 'Now' : fmtHour(H.time[i])) + '</div>' +
      '<div class="e">' + ci[0] + '</div><div class="t">' + Math.round(H.temperature_2m[i]) + '°</div>' +
      '<div class="p">' + pTxt + '</div><div class="w">' + Math.round(H.wind_gusts_10m[i] || 0) + ' mph</div></div>';
  }
  return '<div class="hourly">' + cells + '</div>';
}

function dailyHtml(data) {
  var D = data.daily, rows = '';
  for (var i = 0; i < D.time.length; i++) {
    var ci = codeInfo(D.weather_code[i]);
    var rain = D.precipitation_sum[i] || 0, snow = D.snowfall_sum[i] || 0;
    var pp = snow >= 0.1
      ? '❄ ' + fmtAmt(snow) + ' in snow'
      : (rain > 0.005 ? '💧 ' + fmtAmt(rain) + ' in rain' : ((D.precipitation_probability_max[i] || 0) >= 20 ? (D.precipitation_probability_max[i]) + '% chance' : 'Dry'));
    rows += '<div class="day-row"><span class="d">' + fmtDayName(D.time[i], i) + '</span><span class="e">' + ci[0] + '</span>' +
      '<span>' + ci[1] + '</span><span class="hl"><b>' + Math.round(D.temperature_2m_max[i]) + '°</b> / ' + Math.round(D.temperature_2m_min[i]) + '°' +
      '<span class="pp">' + pp + '</span></span></div>';
  }
  return rows;
}

// The full conditions block used by both Right Here and a place detail.
function conditionsHtml(name, data, features, opts) {
  var c = data.current;
  var ci = codeInfo(c.weather_code);
  var nI = nowIdx(data);
  var sev = windSev(c.wind_speed_10m, c.wind_gusts_10m);
  var wins12 = precipWindows(data, nI, Math.min(nI + 12, data.hourly.time.length));
  var verdict;
  if (!wins12.length) {
    verdict = '<b>No rain or snow</b> expected in the next 12 hours.';
  } else {
    verdict = windowSentence(wins12[0], data, nI) + (wins12.length > 1 ? ' <b>More later</b> — see below.' : '');
  }
  var todayWins = precipWindows(data, nI, endOfTodayIdx(data, nI));
  var winRows = todayWins.length
    ? todayWins.map(function (w) {
        return '<div class="window-row">' + windowSentence(w, data, nI) + '</div>';
      }).join('')
    : '<div class="window-row">Nothing the rest of today.</div>';
  var hi = Math.round(data.daily.temperature_2m_max[0]);
  var lo = Math.round(data.daily.temperature_2m_min[0]);
  var html = '';
  html += '<h1>' + esc(name) + '</h1>';
  html += '<div class="big-temp">' + Math.round(c.temperature_2m) + '°</div>';
  html += '<div class="cond-line">' + ci[0] + ' ' + ci[1] + ' · High ' + hi + '° / Low ' + lo + '°</div>';
  html += '<div class="kv">Wind: <b>' + sev.text + ' mph</b> now · strongest gusts today <b>' + Math.round(data.daily.wind_gusts_10m_max[0] || 0) + ' mph</b></div>';
  html += alertsHtml(features);
  html += '<div class="verdict">' + verdict + '</div>';
  html += '<div class="section-title">Rest of today — rain / snow windows</div>' + winRows;
  html += '<div class="section-title">Next 24 hours</div>' + hourlyHtml(data, nI, 24);
  if (opts && opts.daily) {
    html += '<div class="section-title">7-day outlook</div>' + dailyHtml(data);
  }
  var upd = new Date(c.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  html += '<div id="status-line">Updated ' + upd + ' · Open-Meteo + National Weather Service</div>';
  return html;
}

/* ---------------- Places tab ---------------- */

var els = {
  placesList: document.getElementById('places-list'),
  gpsSlot: document.getElementById('gps-slot'),
  placesStatus: document.getElementById('places-status'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  editBtn: document.getElementById('edit-btn'),
  hereBody: document.getElementById('here-body'),
  detailBody: document.getElementById('detail-body')
};

function cardShell(id, name, extraClass) {
  return '<button class="card ' + (extraClass || '') + '" id="' + id + '" type="button">' +
    '<span class="name">' + esc(name) + '<span class="alert-dot" data-role="alert-dot"></span></span>' +
    '<span class="now-row"><span class="temp" data-role="temp">--°</span><span class="cond" data-role="cond">Loading…</span></span>' +
    '<span class="meta" data-role="meta">&nbsp;</span>' +
    '<span class="del" data-role="del" aria-label="Remove">✕</span></button>';
}

function fillCard(cardEl, data, features) {
  var c = data.current;
  var ci = codeInfo(c.weather_code);
  var nI = nowIdx(data);
  var wins = precipWindows(data, nI, endOfTodayIdx(data, nI));
  var sev = windSev(c.wind_speed_10m, c.wind_gusts_10m);
  cardEl.querySelector('[data-role="temp"]').textContent = Math.round(c.temperature_2m) + '°';
  cardEl.querySelector('[data-role="cond"]').textContent = ci[0] + ' ' + ci[1];
  var precipTxt = wins.length
    ? windowSentence(wins[0], data, nI).replace(/<[^>]+>/g, '')
    : 'No rain or snow the rest of today';
  cardEl.querySelector('[data-role="meta"]').innerHTML =
    'H <b>' + Math.round(data.daily.temperature_2m_max[0]) + '°</b> / L <b>' + Math.round(data.daily.temperature_2m_min[0]) + '°</b> · ' +
    'Wind <b>' + sev.label + '</b><br>' + esc(precipTxt);
  cardEl.querySelector('[data-role="alert-dot"]').textContent = features.length ? '⚠' : '';
}

function renderPlaces() {
  // GPS card
  els.gpsSlot.innerHTML = cardShell('card-gps', '◎ Current Location', 'gps-card');
  var gpsCard = document.getElementById('card-gps');
  gpsCard.querySelector('[data-role="del"]').remove();
  gpsCard.addEventListener('click', function () { showView('here'); });
  getPosition().then(function (pos) {
    var p = pos || FALLBACK;
    var label = pos ? 'Current Location' : 'Current Location (Lansing fallback)';
    gpsCard.querySelector('.name').childNodes[0].textContent = '◎ ' + label;
    return Promise.all([fetchForecast(p.lat, p.lon), fetchAlerts(p.lat, p.lon)])
      .then(function (res) { fillCard(gpsCard, res[0], res[1]); })
      .catch(function () { gpsCard.querySelector('[data-role="cond"]').textContent = 'Could not load'; });
  });

  // Saved places
  els.placesList.innerHTML = places.map(function (p, i) { return cardShell('card-' + i, p.name); }).join('');
  places.forEach(function (p, i) {
    var card = document.getElementById('card-' + i);
    card.addEventListener('click', function (ev) {
      if (document.body.classList.contains('editing')) return;
      openDetail(p);
    });
    card.querySelector('[data-role="del"]').addEventListener('click', function (ev) {
      ev.stopPropagation();
      places.splice(i, 1);
      savePlaces();
      renderPlaces();
    });
    Promise.all([fetchForecast(p.lat, p.lon), fetchAlerts(p.lat, p.lon)])
      .then(function (res) { fillCard(card, res[0], res[1]); })
      .catch(function () { card.querySelector('[data-role="cond"]').textContent = 'Could not load'; });
  });
  els.placesStatus.textContent = places.length ? '' : 'No saved places yet — search above to add one.';
}

els.editBtn.addEventListener('click', function () {
  var on = document.body.classList.toggle('editing');
  els.editBtn.textContent = on ? 'Done' : 'Edit';
});

// Add-a-place search (Open-Meteo geocoding)
var searchTimer = null;
els.searchInput.addEventListener('input', function () {
  var q = els.searchInput.value.trim();
  clearTimeout(searchTimer);
  if (q.length < 3) { els.searchResults.style.display = 'none'; els.searchResults.innerHTML = ''; return; }
  searchTimer = setTimeout(function () {
    fetch('https://geocoding-api.open-meteo.com/v1/search?name=' + encodeURIComponent(q) + '&count=6&language=en&format=json')
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var results = j.results || [];
        if (!results.length) {
          els.searchResults.innerHTML = '<div class="sub">No matches for "' + esc(q) + '".</div>';
          els.searchResults.style.display = 'block';
          return;
        }
        els.searchResults.innerHTML = results.map(function (r, i) {
          var label = r.name + (r.admin1 ? ', ' + r.admin1 : '') + (r.country_code !== 'US' && r.country ? ' · ' + r.country : '');
          var sub = [r.admin2, r.admin1, r.country].filter(Boolean).join(' · ');
          return '<button class="search-item" type="button" data-i="' + i + '">' + esc(label) + '<span>' + esc(sub) + '</span></button>';
        }).join('');
        els.searchResults.style.display = 'block';
        Array.prototype.forEach.call(els.searchResults.querySelectorAll('.search-item'), function (btn) {
          btn.addEventListener('click', function () {
            var r = results[parseInt(btn.getAttribute('data-i'), 10)];
            var nice = r.name + (r.admin1 ? ', ' + r.admin1 : '');
            places.push({ name: nice, lat: r.latitude, lon: r.longitude });
            savePlaces();
            els.searchInput.value = '';
            els.searchResults.style.display = 'none';
            renderPlaces();
          });
        });
      })
      .catch(function () { /* leave results as-is */ });
  }, 300);
});

/* ---------------- Detail view ---------------- */

function openDetail(place) {
  showView('detail');
  els.detailBody.innerHTML = '<div class="sub">Loading ' + esc(place.name) + '…</div>';
  Promise.all([fetchForecast(place.lat, place.lon), fetchAlerts(place.lat, place.lon)])
    .then(function (res) {
      els.detailBody.innerHTML = conditionsHtml(place.name, res[0], res[1], { daily: true });
    })
    .catch(function () {
      els.detailBody.innerHTML = '<div class="sub">Could not load the forecast. Check your connection.</div>';
    });
}
document.getElementById('back-btn').addEventListener('click', function () { showView('places'); });

/* ---------------- Right Here tab ---------------- */

var hereLoadedAt = 0;
function loadHere() {
  getPosition().then(function (pos) {
    var p = pos || FALLBACK;
    var name = pos ? 'Where you are' : 'Lansing, MI (location off)';
    return Promise.all([fetchForecast(p.lat, p.lon), fetchAlerts(p.lat, p.lon)])
      .then(function (res) {
        hereLoadedAt = Date.now();
        els.hereBody.innerHTML = conditionsHtml(name, res[0], res[1], { daily: false });
      })
      .catch(function () {
        els.hereBody.innerHTML = '<div class="sub">Could not load the forecast. Check your connection and reopen the app.</div>';
      });
  });
}

/* ---------------- Radar tab ---------------- */

var radar = { inited: false, map: null, layers: [], frames: [], idx: 0, timer: null, playing: true, youMarker: null };

function initRadar() {
  if (radar.inited || typeof L === 'undefined') return;
  radar.inited = true;
  radar.map = L.map('map', { zoomControl: true }).setView([FALLBACK.lat, FALLBACK.lon], 8);
  L.tileLayer('https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png', {
    attribution: '© OpenStreetMap · © CARTO · Radar © RainViewer',
    maxZoom: 18
  }).addTo(radar.map);
  getPosition().then(function (pos) {
    var p = pos || FALLBACK;
    radar.map.setView([p.lat, p.lon], 8);
    radar.youMarker = L.circleMarker([p.lat, p.lon], {
      radius: 7, color: '#4cc3ff', weight: 2, fillColor: '#4cc3ff', fillOpacity: 0.7
    }).addTo(radar.map);
  });
  loadRadarFrames();
}

function loadRadarFrames() {
  fetch('https://api.rainviewer.com/public/weather-maps.json')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var host = j.host;
      var past = (j.radar.past || []).map(function (f) { return { time: f.time, path: f.path, fc: false }; });
      var now = (j.radar.nowcast || []).map(function (f) { return { time: f.time, path: f.path, fc: true }; });
      radar.frames = past.concat(now);
      radar.layers = radar.frames.map(function (f) {
        var layer = L.tileLayer(host + f.path + '/256/{z}/{x}/{y}/2/1_1.png', { opacity: 0, zIndex: 10 });
        layer.addTo(radar.map);
        return layer;
      });
      radar.idx = Math.max(0, past.length - 1); // start at the most recent real frame
      showRadarFrame(radar.idx);
      startRadarAnim();
    })
    .catch(function () {
      document.getElementById('radar-time').textContent = 'Radar unavailable right now';
    });
}

function showRadarFrame(i) {
  radar.layers.forEach(function (layer, k) { layer.setOpacity(k === i ? 0.78 : 0); });
  var f = radar.frames[i];
  if (f) {
    var t = new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    document.getElementById('radar-time').textContent = t + (f.fc ? ' · forecast' : ' · observed');
  }
}
function startRadarAnim() {
  stopRadarAnim();
  radar.timer = setInterval(function () {
    if (!radar.playing || !radar.frames.length) return;
    radar.idx = (radar.idx + 1) % radar.frames.length;
    showRadarFrame(radar.idx);
  }, 800);
}
function stopRadarAnim() { if (radar.timer) clearInterval(radar.timer); radar.timer = null; }

document.getElementById('radar-play').addEventListener('click', function () {
  radar.playing = !radar.playing;
  this.textContent = radar.playing ? 'Pause' : 'Play';
});
document.getElementById('radar-center').addEventListener('click', function () {
  getPosition().then(function (pos) {
    var p = pos || FALLBACK;
    if (radar.map) radar.map.setView([p.lat, p.lon], 8);
    if (radar.youMarker) radar.youMarker.setLatLng([p.lat, p.lon]);
  });
});

/* ---------------- Tabs ---------------- */

function showView(name) {
  currentView = name;
  ['places', 'radar', 'here', 'detail'].forEach(function (v) {
    document.getElementById('view-' + v).classList.toggle('active', v === name);
  });
  ['places', 'radar', 'here'].forEach(function (v) {
    document.getElementById('tab-' + v).classList.toggle('active', v === name || (name === 'detail' && v === 'places'));
  });
  if (name === 'radar') {
    initRadar();
    setTimeout(function () { if (radar.map) radar.map.invalidateSize(); }, 60);
  }
  if (name === 'here' && Date.now() - hereLoadedAt > 10 * 60 * 1000) loadHere();
  window.scrollTo(0, 0);
}
document.getElementById('tab-places').addEventListener('click', function () { showView('places'); });
document.getElementById('tab-radar').addEventListener('click', function () { showView('radar'); });
document.getElementById('tab-here').addEventListener('click', function () { showView('here'); });

/* ---------------- Boot ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline is a bonus */ });
  });
}
renderPlaces();
showView('here');
loadHere();
setInterval(function () { if (currentView === 'here') loadHere(); }, 10 * 60 * 1000);
