'use strict';

// Andy's Weather v2 — built for a visual person: charts and animated
// conditions first, plain-English descriptions on top.
// Tabs: Places (add your own) + Radar. Tap a place for day-by-day detail.
// Data: Open-Meteo (forecast + geocoding + air quality), RainViewer
// (radar over Esri satellite), National Weather Service (alerts).

var FALLBACK = { lat: 42.7325, lon: -84.5555, name: 'Lansing, MI' };
var POLLEN_ZIP = '48906'; // Andy's home ZIP, for the Pollen.com link
var SEED_PLACES = [
  { name: 'Home — DeWitt, MI', lat: 42.8328, lon: -84.5642 },
  { name: 'Portland, MI', lat: 42.8692, lon: -84.9031 },
  { name: 'Cedar, MI', lat: 44.8992, lon: -85.8675 }
];
var LS_KEY = 'andy-weather-places-v1';

/* ---------------- State ---------------- */

var places = loadPlaces();
var gpsPos = null;
var gpsPromise = null;
var alertCache = {};
var currentView = 'places';
var detailState = null; // { place, data, alerts, air, day }

function loadPlaces() {
  try {
    var raw = localStorage.getItem(LS_KEY);
    if (raw) return JSON.parse(raw);
  } catch (e) { /* seeds */ }
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

/* ---------------- Formatting ---------------- */

function fmtHour(iso) {
  var h = parseInt(iso.slice(11, 13), 10);
  var ap = h >= 12 ? 'PM' : 'AM';
  return (h % 12 || 12) + ' ' + ap;
}
function fmtHourShort(h) {
  var ap = h >= 12 ? 'p' : 'a';
  return (h % 12 || 12) + ap;
}
function fmtTimeOfDay(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function fmtAmt(v) {
  if (!v || v < 0.005) return '0';
  var s = (Math.round(v * 100) / 100).toFixed(2);
  return s.replace(/0+$/, '').replace(/\.$/, '');
}
function fmtDayName(isoDate, idx) {
  if (idx === 0) return 'Today';
  if (idx === 1) return 'Tmrw';
  return new Date(isoDate + 'T12:00:00').toLocaleDateString([], { weekday: 'short' });
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
function windSev(speed, gust) {
  var s = Math.round(speed || 0), g = Math.round(gust || 0);
  var m = Math.max(s, g);
  var label = m < 8 ? 'Calm' : m < 14 ? 'Light' : m < 20 ? 'Breezy' : m < 28 ? 'Windy' : m < 38 ? 'Strong' : 'Very strong';
  return { label: label, text: label + ' · ' + s + ' mph' + (g > s ? ', gusts ' + g : '') };
}
function uvCat(uv) {
  if (uv < 0.5) return 'None';
  if (uv < 3) return 'Low';
  if (uv < 6) return 'Moderate';
  if (uv < 8) return 'High';
  if (uv < 11) return 'Very high';
  return 'Extreme';
}
function aqiCat(aqi) {
  if (aqi <= 50) return 'Good';
  if (aqi <= 100) return 'Moderate';
  if (aqi <= 150) return 'Unhealthy for sensitive groups';
  if (aqi <= 200) return 'Unhealthy';
  if (aqi <= 300) return 'Very unhealthy';
  return 'Hazardous';
}

/* ---------------- Data ---------------- */

function fetchForecast(lat, lon) {
  var url = 'https://api.open-meteo.com/v1/forecast?latitude=' + lat.toFixed(4) +
    '&longitude=' + lon.toFixed(4) +
    '&current=temperature_2m,apparent_temperature,weather_code,wind_speed_10m,wind_gusts_10m,precipitation' +
    '&hourly=temperature_2m,apparent_temperature,weather_code,precipitation,precipitation_probability,snowfall,wind_speed_10m,wind_gusts_10m,uv_index' +
    '&daily=temperature_2m_max,temperature_2m_min,weather_code,precipitation_sum,snowfall_sum,precipitation_probability_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset' +
    '&temperature_unit=fahrenheit&wind_speed_unit=mph&precipitation_unit=inch&snowfall_unit=inch' +
    '&timezone=auto&forecast_days=7';
  return fetch(url).then(function (r) {
    if (!r.ok) throw new Error('forecast ' + r.status);
    return r.json();
  });
}
function fetchAir(lat, lon) {
  var url = 'https://air-quality-api.open-meteo.com/v1/air-quality?latitude=' + lat.toFixed(4) +
    '&longitude=' + lon.toFixed(4) +
    '&hourly=us_aqi,pm2_5,pm10&timezone=auto&forecast_days=5';
  return fetch(url).then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; });
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
function dayStart(data, d) { return d * 24; }
function endOfDayIdx(data, d) { return Math.min(d * 24 + 24, data.hourly.time.length); }

function precipWindows(data, startIdx, endIdx) {
  var H = data.hourly, out = [], cur = null, i;
  for (i = startIdx; i < endIdx && i < H.time.length; i++) {
    var amt = H.precipitation[i] || 0;
    var snow = H.snowfall[i] || 0;
    var wet = amt > 0.005 || snow > 0.005;
    if (wet) {
      if (!cur) cur = { start: i, end: i, total: 0, snow: 0 };
      if (i - cur.end > 1) { out.push(cur); cur = { start: i, end: i, total: 0, snow: 0 }; }
      cur.end = i; cur.total += amt; cur.snow += snow;
    }
  }
  if (cur) out.push(cur);
  out.forEach(function (w) {
    w.isSnow = w.snow >= 0.1;
    w.kind = w.isSnow ? 'Snow' : 'Rain';
    w.amountText = w.isSnow ? fmtAmt(w.snow) + ' in of snow' : fmtAmt(w.total) + ' in of rain';
    var hrs = w.end - w.start + 1;
    var rate = (w.isSnow ? w.snow : w.total) / hrs;
    if (w.isSnow) w.intensity = rate < 0.2 ? 'Light' : rate < 0.5 ? 'Moderate' : 'Heavy';
    else w.intensity = rate < 0.03 ? 'Light' : rate < 0.12 ? 'Moderate' : 'Heavy';
  });
  return out;
}
function windowSentence(w, data, liveIdx) {
  var H = data.hourly;
  var endTxt = fmtHour(H.time[Math.min(w.end + 1, H.time.length - 1)]);
  var tail = ' · ' + w.intensity.toLowerCase() + ' · ' + w.amountText;
  if (liveIdx !== null && w.start <= liveIdx && w.end >= liveIdx) {
    return '<b>' + w.kind + ' now</b>, ending around <b>' + endTxt + '</b>' + tail + ' total';
  }
  if (liveIdx !== null && w.start <= liveIdx) {
    return '<b>' + w.kind + '</b> until about ' + endTxt + tail;
  }
  return '<b>' + w.kind + ' starting ' + fmtHour(H.time[w.start]) + '</b>, through about ' + endTxt + tail;
}

/* ---------------- Charts (inline SVG) ---------------- */

var CH_W = 352, CH_PAD_L = 10, CH_PAD_R = 10;
function chX(i) { return CH_PAD_L + i * (CH_W - CH_PAD_L - CH_PAD_R) / 23; }
function hourLabels(y) {
  var s = '';
  [0, 6, 12, 18, 23].forEach(function (h) {
    s += '<text x="' + chX(h) + '" y="' + y + '" font-size="10" fill="#7e97a8" text-anchor="middle">' + fmtHourShort(h) + '</text>';
  });
  return s;
}
function tempChart(data, d, nI) {
  var H = data.hourly, s = dayStart(data, d), temps = [], feels = [], i, v;
  for (i = 0; i < 24; i++) {
    temps.push(H.temperature_2m[s + i]);
    feels.push(H.apparent_temperature && H.apparent_temperature[s + i] !== null && H.apparent_temperature[s + i] !== undefined ? H.apparent_temperature[s + i] : H.temperature_2m[s + i]);
  }
  var both = temps.concat(feels);
  var min = Math.min.apply(null, both), max = Math.max.apply(null, both);
  var lo = min - 3, hi = max + 3, HGT = 128, padT = 18, padB = 22;
  function Y(t) { return padT + (hi - t) / (hi - lo) * (HGT - padT - padB); }
  var pts = temps.map(function (t, k) { return chX(k).toFixed(1) + ',' + Y(t).toFixed(1); });
  var area = 'M' + chX(0).toFixed(1) + ',' + Y(temps[0]).toFixed(1) + ' L' +
    pts.join(' L') + ' L' + chX(23).toFixed(1) + ',' + (HGT - padB) + ' L' + chX(0).toFixed(1) + ',' + (HGT - padB) + ' Z';
  var minI = temps.indexOf(min), maxI = temps.indexOf(max);
  var svg = '<svg viewBox="0 0 ' + CH_W + ' ' + HGT + '">';
  svg += '<defs><linearGradient id="tgrad" x1="0" y1="0" x2="0" y2="1">' +
    '<stop offset="0" stop-color="#ffb02e" stop-opacity=".32"/><stop offset="1" stop-color="#ffb02e" stop-opacity="0"/></linearGradient></defs>';
  svg += '<path d="' + area + '" fill="url(#tgrad)"/>';
  svg += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#ffb02e" stroke-width="2.5" stroke-linejoin="round"/>';
  temps.forEach(function (t, k) { svg += '<circle cx="' + chX(k) + '" cy="' + Y(t) + '" r="1.8" fill="#ffd28a"/>'; });
  var fpts = feels.map(function (t, k) { return chX(k).toFixed(1) + ',' + Y(t).toFixed(1); });
  svg += '<polyline points="' + fpts.join(' ') + '" fill="none" stroke="#9fd8ff" stroke-width="1.6" stroke-dasharray="4 3" stroke-linejoin="round" opacity=".9"/>';
  svg += '<text x="' + chX(maxI) + '" y="' + (Y(max) - 6) + '" font-size="12" font-weight="700" fill="#eef4f8" text-anchor="middle">' + Math.round(max) + '°</text>';
  svg += '<text x="' + chX(minI) + '" y="' + (Y(min) + 15) + '" font-size="12" font-weight="700" fill="#aee2ff" text-anchor="middle">' + Math.round(min) + '°</text>';
  if (d === 0 && nI !== null) {
    var rel = nI - s;
    if (rel >= 0 && rel < 24) {
      svg += '<line x1="' + chX(rel) + '" y1="' + (padT - 6) + '" x2="' + chX(rel) + '" y2="' + (HGT - padB) + '" stroke="#4cc3ff" stroke-width="1.5" stroke-dasharray="3 3"/>';
      svg += '<text x="' + chX(rel) + '" y="' + (padT - 8) + '" font-size="9.5" fill="#4cc3ff" text-anchor="middle">now</text>';
    }
  }
  svg += hourLabels(HGT - 6);
  svg += '</svg>';
  return svg;
}
function precipChart(data, d) {
  var H = data.hourly, s = dayStart(data, d), i;
  var amts = [], snows = [], probs = [], maxAmt = 0.08, maxDispI = -1, maxDisp = 0;
  for (i = 0; i < 24; i++) {
    var p = H.precipitation[s + i] || 0, sn = H.snowfall[s + i] || 0;
    amts.push(p); snows.push(sn); probs.push(H.precipitation_probability[s + i] || 0);
    var disp = sn >= 0.03 ? sn : p;
    if (disp > maxAmt) maxAmt = disp;
    if (disp > maxDisp) { maxDisp = disp; maxDispI = i; }
  }
  var HGT = 112, padT = 20, padB = 22, base = HGT - padB;
  var slotW = (CH_W - CH_PAD_L - CH_PAD_R) / 24, barW = slotW * 0.62;
  var svg = '<svg viewBox="0 0 ' + CH_W + ' ' + HGT + '">';
  svg += '<line x1="' + CH_PAD_L + '" y1="' + base + '" x2="' + (CH_W - CH_PAD_R) + '" y2="' + base + '" stroke="rgba(255,255,255,.18)"/>';
  for (i = 0; i < 24; i++) {
    var isSnow = snows[i] >= 0.03;
    var dispV = isSnow ? snows[i] : amts[i];
    if (dispV > 0.005) {
      var hgt = Math.max(3, dispV / maxAmt * (base - padT));
      var x = CH_PAD_L + i * slotW + (slotW - barW) / 2;
      svg += '<rect x="' + x.toFixed(1) + '" y="' + (base - hgt).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + hgt.toFixed(1) + '" rx="2" fill="' + (isSnow ? '#e8f4fb' : '#4cc3ff') + '"/>';
      if (i === maxDispI && dispV >= 0.02) {
        svg += '<text x="' + (x + barW / 2).toFixed(1) + '" y="' + (base - hgt - 4).toFixed(1) + '" font-size="9.5" fill="#dcebf5" text-anchor="middle">' + fmtAmt(dispV) + '</text>';
      }
    }
  }
  var pPts = probs.map(function (p, k) { return (CH_PAD_L + k * slotW + slotW / 2).toFixed(1) + ',' + (padT + (100 - p) / 100 * (base - padT)).toFixed(1); });
  svg += '<polyline points="' + pPts.join(' ') + '" fill="none" stroke="#8fd0f5" stroke-width="1.6" stroke-dasharray="4 3" stroke-linejoin="round" opacity=".95"/>';
  var maxProb = Math.max.apply(null, probs), pkI = probs.indexOf(maxProb);
  if (maxProb >= 30) {
    svg += '<text x="' + (CH_PAD_L + 2) + '" y="' + (padT - 7) + '" font-size="9.5" fill="#8fd0f5">chance peaks ' + maxProb + '% · ' + fmtHour(H.time[s + pkI]) + '</text>';
  }
  svg += hourLabels(HGT - 6);
  svg += '</svg>';
  return svg;
}
function windChart(data, d) {
  var H = data.hourly, s = dayStart(data, d), i;
  var spd = [], gst = [], maxG = 10;
  for (i = 0; i < 24; i++) {
    spd.push(H.wind_speed_10m[s + i] || 0);
    gst.push(H.wind_gusts_10m[s + i] || 0);
    if (gst[i] > maxG) maxG = gst[i];
  }
  maxG = Math.ceil(maxG * 1.15);
  var HGT = 112, padT = 18, padB = 22, base = HGT - padB;
  function Y(v) { return base - v / maxG * (base - padT); }
  var slotW = (CH_W - CH_PAD_L - CH_PAD_R) / 24, barW = slotW * 0.62;
  var svg = '<svg viewBox="0 0 ' + CH_W + ' ' + HGT + '">';
  svg += '<line x1="' + CH_PAD_L + '" y1="' + base + '" x2="' + (CH_W - CH_PAD_R) + '" y2="' + base + '" stroke="rgba(255,255,255,.18)"/>';
  for (i = 0; i < 24; i++) {
    var x = CH_PAD_L + i * slotW + (slotW - barW) / 2;
    svg += '<rect x="' + x.toFixed(1) + '" y="' + Y(gst[i]).toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + (base - Y(gst[i])).toFixed(1) + '" rx="2" fill="rgba(245,166,35,.5)"/>';
  }
  var pts = spd.map(function (v, k) { return chX(k).toFixed(1) + ',' + Y(v).toFixed(1); });
  svg += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="#f5d9a8" stroke-width="2" stroke-linejoin="round"/>';
  var pk = gst.indexOf(Math.max.apply(null, gst));
  svg += '<text x="' + chX(pk) + '" y="' + (Y(gst[pk]) - 5) + '" font-size="11" font-weight="700" fill="#f5d9a8" text-anchor="middle">' + Math.round(gst[pk]) + '</text>';
  svg += hourLabels(HGT - 6);
  svg += '</svg>';
  return svg;
}

/* ---------------- Animated condition scene ---------------- */

function sceneHtml(code) {
  function cloud(dark) {
    var c = dark ? '#8fa9bb' : '#c7d6e0';
    return '<div class="cloudblob" style="left:10px;top:30px;width:66px;height:28px;background:' + c + '"></div>' +
           '<div class="cloudblob" style="left:30px;top:16px;width:40px;height:40px;border-radius:50%;background:' + c + '"></div>';
  }
  function drops(n, snow) {
    var out = '', i;
    for (i = 0; i < n; i++) {
      var left = 6 + Math.round(Math.random() * 82);
      var delay = (Math.random() * 1.6).toFixed(2);
      if (snow) {
        var sz = 10 + Math.round(Math.random() * 7);
        out += '<span class="flake" style="left:' + left + '%;font-size:' + sz + 'px;animation-delay:' + delay + 's">❄</span>';
      } else {
        out += '<span class="drop" style="left:' + left + '%;animation-delay:' + delay + 's"></span>';
      }
    }
    return out;
  }
  var inner = '';
  if (code === 0 || code === 1) {
    var rays = '';
    for (var a = 0; a < 8; a++) rays += '<line x1="40" y1="2" x2="40" y2="13" stroke="#ffb02e" stroke-width="4" stroke-linecap="round" transform="rotate(' + (a * 45) + ' 40 40)"/>';
    inner = '<svg class="rays" viewBox="0 0 80 80">' + rays + '</svg><div class="sun-core"></div>' + (code === 1 ? cloud(false) : '');
  } else if (code === 2) {
    inner = '<div class="sun-core" style="width:38px;height:38px;left:12px;top:10px"></div>' + cloud(false);
  } else if (code === 3) {
    inner = cloud(true);
  } else if (code === 45 || code === 48) {
    inner = '<div class="mist" style="top:30px"></div><div class="mist" style="top:48px;animation-delay:.7s"></div><div class="mist" style="top:66px;animation-delay:1.3s"></div>';
  } else if (code === 71 || code === 73 || code === 75 || code === 77 || code === 85 || code === 86) {
    inner = cloud(false) + drops(11, true);
  } else if (code === 95 || code === 96 || code === 99) {
    inner = '<div class="flash"></div>' + cloud(true) + drops(10, false);
  } else {
    inner = cloud(false) + drops(code >= 63 || code === 82 ? 13 : 8, false);
  }
  return '<div class="scene" aria-hidden="true">' + inner + '</div>';
}

/* ---------------- Shared bits ---------------- */

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
function dailyRowHtml(data, i, active) {
  var D = data.daily;
  var ci = codeInfo(D.weather_code[i]);
  var rain = D.precipitation_sum[i] || 0, snow = D.snowfall_sum[i] || 0;
  var pp = snow >= 0.1 ? '❄ ' + fmtAmt(snow) + ' in snow'
    : (rain > 0.005 ? '💧 ' + fmtAmt(rain) + ' in rain'
    : ((D.precipitation_probability_max[i] || 0) >= 20 ? (D.precipitation_probability_max[i]) + '% chance' : 'Dry'));
  return '<button class="day-row' + (active ? ' active' : '') + '" type="button" data-day="' + i + '">' +
    '<span class="d">' + fmtDayName(D.time[i], i) + '</span><span class="e">' + ci[0] + '</span>' +
    '<span>' + ci[1] + '</span><span class="hl"><b>' + Math.round(D.temperature_2m_max[i]) + '°</b> / ' + Math.round(D.temperature_2m_min[i]) + '°' +
    '<span class="pp">' + pp + '</span></span></button>';
}

/* ---------------- Places tab ---------------- */

var els = {
  placesList: document.getElementById('places-list'),
  gpsSlot: document.getElementById('gps-slot'),
  placesStatus: document.getElementById('places-status'),
  searchInput: document.getElementById('search-input'),
  searchResults: document.getElementById('search-results'),
  editBtn: document.getElementById('edit-btn'),
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
  var wins = precipWindows(data, nI, endOfDayIdx(data, 0));
  var sev = windSev(c.wind_speed_10m, c.wind_gusts_10m);
  // Andy prefers feels-like / wind chill as the headline number.
  var feels = (c.apparent_temperature !== null && c.apparent_temperature !== undefined) ? c.apparent_temperature : c.temperature_2m;
  cardEl.querySelector('[data-role="temp"]').textContent = Math.round(feels) + '°';
  cardEl.querySelector('[data-role="cond"]').textContent = 'feels like · ' + ci[0] + ' ' + ci[1] + ' · actual ' + Math.round(c.temperature_2m) + '°';
  var precipTxt;
  if (wins.length) {
    precipTxt = wins.slice(0, 2).map(function (w) { return windowSentence(w, data, nI).replace(/<[^>]+>/g, ''); }).join('  ·  ');
    if (wins.length > 2) precipTxt += '  ·  +' + (wins.length - 2) + ' more';
  } else {
    precipTxt = 'No rain or snow the rest of today';
  }
  cardEl.querySelector('[data-role="meta"]').innerHTML =
    'H <b>' + Math.round(data.daily.temperature_2m_max[0]) + '°</b> / L <b>' + Math.round(data.daily.temperature_2m_min[0]) + '°</b> · ' +
    'Wind <b>' + sev.label + '</b><br>' + esc(precipTxt);
  cardEl.querySelector('[data-role="alert-dot"]').textContent = features.length ? '⚠' : '';
}
function renderPlaces() {
  els.gpsSlot.innerHTML = cardShell('card-gps', '◎ Current Location', 'gps-card');
  var gpsCard = document.getElementById('card-gps');
  gpsCard.querySelector('[data-role="del"]').remove();
  gpsCard.addEventListener('click', function () {
    getPosition().then(function (pos) {
      var p = pos || FALLBACK;
      openDetail({ name: pos ? 'Current Location' : 'Lansing, MI (location off)', lat: p.lat, lon: p.lon });
    });
  });
  getPosition().then(function (pos) {
    var p = pos || FALLBACK;
    if (!pos) gpsCard.querySelector('.name').childNodes[0].textContent = '◎ Current Location (Lansing fallback)';
    return Promise.all([fetchForecast(p.lat, p.lon), fetchAlerts(p.lat, p.lon)])
      .then(function (res) { fillCard(gpsCard, res[0], res[1]); })
      .catch(function () { gpsCard.querySelector('[data-role="cond"]').textContent = 'Could not load'; });
  });

  els.placesList.innerHTML = places.map(function (p, i) { return cardShell('card-' + i, p.name); }).join('');
  places.forEach(function (p, i) {
    var card = document.getElementById('card-' + i);
    card.addEventListener('click', function () {
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
            places.push({ name: r.name + (r.admin1 ? ', ' + r.admin1 : ''), lat: r.latitude, lon: r.longitude });
            savePlaces();
            els.searchInput.value = '';
            els.searchResults.style.display = 'none';
            renderPlaces();
          });
        });
      })
      .catch(function () { /* leave as-is */ });
  }, 300);
});

/* ---------------- Detail view ---------------- */

function openDetail(place) {
  showView('detail');
  els.detailBody.innerHTML = '<div class="sub">Loading ' + esc(place.name) + '…</div>';
  Promise.all([fetchForecast(place.lat, place.lon), fetchAlerts(place.lat, place.lon), fetchAir(place.lat, place.lon)])
    .then(function (res) {
      detailState = { place: place, data: res[0], alerts: res[1], air: res[2], day: 0 };
      renderDetail();
    })
    .catch(function () {
      els.detailBody.innerHTML = '<div class="sub">Could not load the forecast. Check your connection.</div>';
    });
}
document.getElementById('back-btn').addEventListener('click', function () { showView('places'); });

function airForDay(air, dateStr, hourPrefix) {
  if (!air || !air.hourly) return null;
  var H = air.hourly, idxs = [], i;
  for (i = 0; i < H.time.length; i++) if (H.time[i].slice(0, 10) === dateStr) idxs.push(i);
  if (!idxs.length) return null;
  var maxAqi = null, pmSum = 0, pmN = 0, curAqi = null;
  idxs.forEach(function (i) {
    var a = H.us_aqi[i];
    if (a !== null && a !== undefined && (maxAqi === null || a > maxAqi)) maxAqi = a;
    if (H.pm2_5[i] !== null && H.pm2_5[i] !== undefined) { pmSum += H.pm2_5[i]; pmN++; }
    if (hourPrefix && H.time[i].slice(0, 13) === hourPrefix) curAqi = a;
  });
  return { maxAqi: maxAqi, curAqi: curAqi, pmAvg: pmN ? pmSum / pmN : null };
}

function renderDetail() {
  if (!detailState) return;
  var place = detailState.place, data = detailState.data;
  var d = detailState.day;
  var D = data.daily, H = data.hourly;
  var nI = nowIdx(data);
  var isToday = d === 0;
  var s = dayStart(data, d), e = endOfDayIdx(data, d);
  var html = '';

  // Day chips
  html += '<div class="chips">' + D.time.map(function (t, i) {
    var label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(t + 'T12:00:00').toLocaleDateString([], { weekday: 'short' }) +
      ' ' + (parseInt(t.slice(5, 7), 10)) + '/' + parseInt(t.slice(8, 10), 10);
    return '<button class="chip' + (i === d ? ' active' : '') + '" type="button" data-day="' + i + '">' + label + '</button>';
  }).join('') + '</div>';

  // Hero
  var dayCi = codeInfo(D.weather_code[d]);
  html += '<h1>' + esc(place.name) + '</h1>';
  if (isToday) {
    var c = data.current, cci = codeInfo(c.weather_code);
    var feelsNow = (c.apparent_temperature !== null && c.apparent_temperature !== undefined) ? c.apparent_temperature : c.temperature_2m;
    html += '<div class="hero"><div><div class="big-temp">' + Math.round(feelsNow) + '°</div>' +
      '<div class="cond-line">feels like · ' + cci[0] + ' ' + cci[1] + '</div></div>' +
      '<div class="hero-side">' + sceneHtml(c.weather_code) + '</div></div>';
    html += '<div class="kv">Actual <b>' + Math.round(c.temperature_2m) + '°</b> · High <b>' +
      Math.round(D.temperature_2m_max[0]) + '°</b> / Low <b>' + Math.round(D.temperature_2m_min[0]) + '°</b></div>';
  } else {
    html += '<div class="hero"><div><div class="big-temp">' + Math.round(D.temperature_2m_max[d]) + '°</div>' +
      '<div class="cond-line">' + dayCi[0] + ' ' + dayCi[1] + '</div></div>' +
      '<div class="hero-side">' + sceneHtml(D.weather_code[d]) + '</div></div>';
    html += '<div class="kv">High <b>' + Math.round(D.temperature_2m_max[d]) + '°</b> / Low <b>' + Math.round(D.temperature_2m_min[d]) + '°</b> · ' +
      new Date(D.time[d] + 'T12:00:00').toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }) + '</div>';
  }

  // Alerts
  html += alertsHtml(detailState.alerts);

  // Verdict + windows
  var winStart = isToday ? nI : s;
  var wins = precipWindows(data, winStart, e);
  var verdict;
  if (!wins.length) {
    verdict = isToday ? '<b>No rain or snow</b> expected the rest of today.' : '<b>No rain or snow</b> expected this day.';
  } else {
    verdict = windowSentence(wins[0], data, isToday ? nI : null) + (wins.length > 1 ? ' <b>More later</b> — see below.' : '');
  }
  html += '<div class="verdict">' + verdict + '</div>';

  // Charts
  var temps = [], i;
  for (i = s; i < e; i++) temps.push(H.temperature_2m[i]);
  var maxT = Math.max.apply(null, temps), minT = Math.min.apply(null, temps);
  var maxTH = temps.indexOf(maxT), minTH = temps.indexOf(minT);
  html += '<div class="section-title">Temperature</div><div class="chart-box">' + tempChart(data, d, isToday ? nI : null) +
    '<div class="chart-cap">High <b>' + Math.round(maxT) + '°</b> at ' + fmtHour(H.time[s + maxTH]) + ' · Low <b>' + Math.round(minT) + '°</b> at ' + fmtHour(H.time[s + minTH]) + ' · dashed blue = feels like</div></div>';

  var totRain = D.precipitation_sum[d] || 0, totSnow = D.snowfall_sum[d] || 0;
  var precipCap = totSnow >= 0.1 ? 'Total <b>' + fmtAmt(totSnow) + ' in of snow</b> expected'
    : totRain > 0.005 ? 'Total <b>' + fmtAmt(totRain) + ' in of rain</b> expected'
    : 'No precipitation expected';
  html += '<div class="section-title">Precipitation by hour</div><div class="chart-box">' + precipChart(data, d) +
    '<div class="chart-cap">' + precipCap + ' · bars = amount per hour · dashed line = chance of rain</div></div>';

  var sevDay = windSev(Math.max.apply(null, H.wind_speed_10m.slice(s, e)), D.wind_gusts_10m_max[d]);
  html += '<div class="section-title">Wind — severity</div><div class="chart-box">' + windChart(data, d) +
    '<div class="chart-cap"><b>' + sevDay.label + '</b> · bars = gusts, line = steady wind · strongest gusts <b>' + Math.round(D.wind_gusts_10m_max[d] || 0) + ' mph</b></div></div>';

  html += '<div class="section-title">' + (isToday ? 'Rest of today' : 'That day') + ' — rain / snow windows</div>';
  html += wins.length
    ? wins.map(function (w) { return '<div class="window-row">' + windowSentence(w, data, isToday ? nI : null) + '</div>'; }).join('')
    : '<div class="window-row">Dry all day.</div>';

  // Bottom info: UV + air
  var uvMax = D.uv_index_max[d];
  var uvPeakH = null, uvPeakV = -1;
  for (i = s; i < e; i++) { var uv = H.uv_index[i] || 0; if (uv > uvPeakV) { uvPeakV = uv; uvPeakH = i; } }
  var air = airForDay(detailState.air, D.time[d], isToday ? data.current.time.slice(0, 13) : null);
  html += '<div class="section-title">Sun, UV & air</div><div class="info-grid">';
  html += '<div class="info-box"><div class="lab">UV Index (max)</div><div class="val">' + (uvMax !== null && uvMax !== undefined ? Math.round(uvMax) : '—') + '</div>' +
    '<div class="desc">' + uvCat(uvMax || 0) + (uvPeakH !== null && uvPeakV > 0.5 ? ' · peaks around ' + fmtHour(H.time[uvPeakH]) : '') + '</div>' +
    '<div class="gauge"><div class="pin" style="left:calc(' + Math.min(100, (uvMax || 0) / 11 * 100) + '% - 2px)"></div></div></div>';
  if (air && (air.maxAqi !== null || air.curAqi !== null)) {
    var aqiShow = isToday && air.curAqi !== null ? air.curAqi : air.maxAqi;
    html += '<div class="info-box"><div class="lab">Air Quality (US AQI)</div><div class="val">' + Math.round(aqiShow) + '</div>' +
      '<div class="desc">' + aqiCat(aqiShow) + (isToday ? ' right now' : ' · worst hour that day') +
      (air.pmAvg !== null ? ' · PM2.5 avg ' + air.pmAvg.toFixed(1) + ' µg/m³' : '') + '</div>' +
      '<div class="gauge aqi"><div class="pin" style="left:calc(' + Math.min(100, aqiShow / 300 * 100) + '% - 2px)"></div></div></div>';
  } else {
    html += '<div class="info-box"><div class="lab">Air Quality</div><div class="val">—</div><div class="desc">No air data for this spot.</div></div>';
  }
  html += '</div>';
  html += '<div class="kv">Sunrise <b>' + fmtTimeOfDay(D.sunrise[d]) + '</b> · Sunset <b>' + fmtTimeOfDay(D.sunset[d]) + '</b></div>';
  html += '<a class="pollen-link" href="https://www.pollen.com/forecast/current/pollen/' + POLLEN_ZIP + '" target="_blank" rel="noopener">🌼 Today\'s pollen counts — Pollen.com<span>Opens Pollen.com for ZIP ' + POLLEN_ZIP + ' (home). No free pollen feed exists for Michigan in the app\'s data — this is the reliable source.</span></a>';

  // 7-day
  html += '<div class="section-title">7-day outlook — tap a day</div>';
  for (i = 0; i < D.time.length; i++) html += dailyRowHtml(data, i, i === d);
  var upd = new Date(data.current.time).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  html += '<div id="status-line">Forecast updated ' + upd + ' · Open-Meteo + National Weather Service</div>';

  els.detailBody.innerHTML = html;
  Array.prototype.forEach.call(els.detailBody.querySelectorAll('[data-day]'), function (el) {
    el.addEventListener('click', function () {
      detailState.day = parseInt(el.getAttribute('data-day'), 10);
      renderDetail();
      window.scrollTo(0, 0);
    });
  });
}

/* ---------------- Radar tab (MapLibre vector base + RainViewer) ---------------- */

var radar = { inited: false, ready: false, map: null, frames: [], idx: 0, visibleIdx: -1, timer: null, fadeTimer: null, playing: true, marker: null, framesAt: 0 };

function initRadar() {
  if (radar.inited || typeof maplibregl === 'undefined') return;
  radar.inited = true;
  // Vector base map (OpenFreeMap, keyless): crisp labels at every zoom,
  // smooth animated zoom — raster bases (CARTO/Esri) served placeholder
  // "API key required" / "zoom not supported" tiles.
  radar.map = new maplibregl.Map({
    container: 'map',
    style: 'https://tiles.openfreemap.org/styles/liberty',
    center: [FALLBACK.lon, FALLBACK.lat],
    zoom: 7.5,
    attributionControl: { compact: true },
    fadeDuration: 120
  });
  radar.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');
  radar.map.on('load', function () {
    radar.ready = true;
    positionYou(false);
    loadRadarFrames();
  });
}
function positionYou(animate) {
  getPosition().then(function (pos) {
    var p = pos || FALLBACK;
    if (!radar.map) return;
    if (animate) radar.map.flyTo({ center: [p.lon, p.lat], zoom: 7.5 });
    else radar.map.jumpTo({ center: [p.lon, p.lat], zoom: 7.5 });
    if (!radar.marker) {
      var el = document.createElement('div');
      el.className = 'you-dot';
      radar.marker = new maplibregl.Marker({ element: el }).setLngLat([p.lon, p.lat]).addTo(radar.map);
    } else {
      radar.marker.setLngLat([p.lon, p.lat]);
    }
  });
}
function loadRadarFrames() {
  fetch('https://api.rainviewer.com/public/weather-maps.json')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var host = j.host;
      var past = (j.radar.past || []).map(function (f) { return { time: f.time, path: f.path, fc: false }; });
      var now = (j.radar.nowcast || []).map(function (f) { return { time: f.time, path: f.path, fc: true }; });
      radar.frames = past.concat(now);
      radar.framesAt = Date.now();
      // Insert radar layers just below the first label/symbol layer so
      // place names and road shields stay readable on top of the radar.
      var layers = radar.map.getStyle().layers;
      var beforeId = null;
      for (var i = 0; i < layers.length; i++) {
        if (layers[i].type === 'symbol') { beforeId = layers[i].id; break; }
      }
      radar.frames.forEach(function (f, k) {
        radar.map.addSource('rv' + k, {
          type: 'raster',
          // RainViewer publishes tiles only through zoom 7; higher zooms
          // return a "Zoom Level Not Supported" placeholder tile. maxzoom 7
          // makes MapLibre overscale the z7 tiles when zoomed in instead.
          tiles: [host + f.path + '/256/{z}/{x}/{y}/2/1_1.png'],
          tileSize: 256,
          maxzoom: 7
        });
        radar.map.addLayer({
          id: 'rv' + k, type: 'raster', source: 'rv' + k,
          paint: { 'raster-opacity': 0, 'raster-resampling': 'linear' }
        }, beforeId || undefined);
      });
      radar.idx = Math.max(0, past.length - 1);
      var sc = document.getElementById('radar-scrub');
      if (sc) { sc.max = Math.max(0, radar.frames.length - 1); sc.value = radar.idx; }
      setRadarFrame(radar.idx, true);
      startRadarAnim();
    })
    .catch(function () {
      document.getElementById('radar-time').textContent = 'Radar unavailable right now';
    });
}
function refreshRadarFrames() {
  if (!radar.ready) return;
  radar.frames.forEach(function (_, k) {
    if (radar.map.getLayer('rv' + k)) radar.map.removeLayer('rv' + k);
    if (radar.map.getSource('rv' + k)) radar.map.removeSource('rv' + k);
  });
  radar.frames = []; radar.visibleIdx = -1;
  loadRadarFrames();
}
function setRadarFrame(i, instant) {
  if (!radar.ready || !radar.frames.length) return;
  var prev = radar.visibleIdx;
  radar.visibleIdx = i;
  var f = radar.frames[i];
  if (f) {
    var t = new Date(f.time * 1000).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    document.getElementById('radar-time').textContent = t + (f.fc ? ' · forecast' : ' · observed');
    var sc2 = document.getElementById('radar-scrub');
    if (sc2 && document.activeElement !== sc2) sc2.value = i;
  }
  if (instant || prev < 0 || prev === i) {
    radar.frames.forEach(function (_, k) {
      radar.map.setPaintProperty('rv' + k, 'raster-opacity', k === i ? 0.8 : 0);
    });
    return;
  }
  // Crossfade: incoming frame fades up while the outgoing one fades out.
  if (radar.fadeTimer) clearInterval(radar.fadeTimer);
  var start = Date.now(), DUR = 300;
  radar.fadeTimer = setInterval(function () {
    var p = Math.min(1, (Date.now() - start) / DUR);
    radar.map.setPaintProperty('rv' + i, 'raster-opacity', 0.8 * p);
    radar.map.setPaintProperty('rv' + prev, 'raster-opacity', 0.8 * (1 - p));
    if (p >= 1) { clearInterval(radar.fadeTimer); radar.fadeTimer = null; }
  }, 40);
}
function startRadarAnim() {
  stopRadarAnim();
  radar.timer = setInterval(function () {
    if (!radar.playing || !radar.frames.length) return;
    radar.idx = (radar.idx + 1) % radar.frames.length;
    setRadarFrame(radar.idx, false);
  }, 950);
}
function stopRadarAnim() { if (radar.timer) clearInterval(radar.timer); radar.timer = null; }
document.getElementById('radar-play').addEventListener('click', function () {
  radar.playing = !radar.playing;
  this.textContent = radar.playing ? 'Pause' : 'Play';
});
document.getElementById('radar-center').addEventListener('click', function () { positionYou(true); });
document.getElementById('radar-scrub').addEventListener('input', function () {
  radar.playing = false;
  document.getElementById('radar-play').textContent = 'Play';
  radar.idx = parseInt(this.value, 10) || 0;
  setRadarFrame(radar.idx, true);
});

/* ---------------- Tabs ---------------- */

function showView(name) {
  currentView = name;
  ['places', 'radar', 'detail'].forEach(function (v) {
    document.getElementById('view-' + v).classList.toggle('active', v === name);
  });
  document.getElementById('tab-places').classList.toggle('active', name === 'places' || name === 'detail');
  document.getElementById('tab-radar').classList.toggle('active', name === 'radar');
  if (name === 'radar') {
    initRadar();
    setTimeout(function () { if (radar.map) radar.map.resize(); }, 60);
    if (radar.ready && radar.framesAt && Date.now() - radar.framesAt > 5 * 60 * 1000) refreshRadarFrames();
  }
  window.scrollTo(0, 0);
}
document.getElementById('tab-places').addEventListener('click', function () { showView('places'); });
document.getElementById('tab-radar').addEventListener('click', function () { showView('radar'); });

/* ---------------- Boot ---------------- */

if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('sw.js').catch(function () { /* offline is a bonus */ });
  });
}
renderPlaces();
showView('places');
