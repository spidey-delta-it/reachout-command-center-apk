// Reachout Command Center v2.0 — dashboard.js
// ReachOut Admin Platform Edition
// Fully integrated: Dashboard · Devices · Divisions · Activity · Mail · Export · Settings
'use strict';

const { ipcRenderer } = require('electron');

// ══════════════════════════════════════════════════════════════
//  GLOBALS
// ══════════════════════════════════════════════════════════════
let allDevices      = [];
let divisionMap     = {};       // { divName: [device,...] }
let activityLog     = [];
let mailSettings    = {}; // kept for legacy store cleanup only
let uptimeHistory   = {};       // { deviceId: [{ts,online},...] }
let pollHistory     = [];       // [{ts, online, offline, total}]
let sparkHistory    = { online:[], offline:[], health:[] };
let divOverrides    = {};       // { deviceId: 'DivName' }
let settings        = {};
let isFetching      = false;
let isAutoSync      = false; // true during background auto-refresh, false for user-triggered
let pollTimer       = null;
let currentFilter   = 'all';
let divFilter       = 'all';
let sortCol         = 'name';
let sortAsc         = true;
let actFilter       = 'all';
let demFilter       = 'all';
let advFilter       = { uptime: '', lastSeen: '', dateFrom: '', dateTo: '', offlinePreset: '', datetimeFrom: '', datetimeTo: '' };
let selectedDevs    = new Set(); // retained for backward-compat; selection UI removed
let notifCount      = 0;
let darkMode        = false;
let sessionStats    = { wentOffline:0, cameOnline:0, polls:0 }; // insight counters
let pollCountdown   = 0;     // for countdown bar
let pollCountdownTimer = null;
let sidebarCollapsed= false;
let actPanelOpen    = true;

// Charts removed — replaced with insight widgets

// ══════════════════════════════════════════════════════════════
//  BOOT
// ══════════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  // ── Loading screen: step 1 — initialising ──
  setLoadingStatus('Initialising…', 15);

  await loadAllPersisted();
  setLoadingStatus('Loading settings…', 30);

  applySettings();
  startClock();
  loadStoragePath();

  // ── Loading screen: step 2 — fetching data ──
  setLoadingStatus('Connecting to ReachOut…', 50);

  if (settings.autostart !== false) {
    setLoadingStatus('Fetching device data…', 65);
    await refreshData();
    setLoadingStatus('Rendering dashboard…', 90);
  }

  startPollTimer();
  renderActPanel();

  // ── Version: read from package.json via IPC — single source of truth ──
  try {
    const ver = await ipcRenderer.invoke('get-version');
    const vStr = 'v' + ver;
    // Update all version display locations
    const loVer = $('lo-ver');      if (loVer)  loVer.textContent  = vStr;
    const sbVer = document.querySelector('.sb-ver'); if (sbVer) sbVer.textContent = vStr;
    document.title = 'Reachout Command Center ' + vStr;
    window._appVersion = vStr;
  } catch(e) { window._appVersion = 'v2.3.0'; }

  // ── Loading screen: complete — hide with fade ──
  setTimeout(() => {
    setLoadingStatus('Ready', 100);
    setTimeout(hideLoadingScreen, 300);
  }, 200);
});

// ══════════════════════════════════════════════════════════════
//  CLOCK
// ══════════════════════════════════════════════════════════════
function startClock() {
  const tick = () => {
    const now = new Date();
    setText('kpi-clock', now.toLocaleTimeString());
  };
  tick(); setInterval(tick, 1000);
}

// ══════════════════════════════════════════════════════════════
//  PERSIST
// ══════════════════════════════════════════════════════════════
async function loadAllPersisted() {
  try {
    const d = await ipcRenderer.invoke('get-perm-all');
    activityLog   = d.activityLog   || [];
    uptimeHistory  = d.uptimeHistory  || {};
    // Migrate: strip consecutive duplicate entries left by Option A recording
    // Keeps only real transition points — runs once on load
    Object.keys(uptimeHistory).forEach(id => {
      const raw = uptimeHistory[id];
      if (!Array.isArray(raw) || raw.length < 2) return;
      const clean = [raw[0]];
      for (let i = 1; i < raw.length; i++) {
        if (raw[i].online !== clean[clean.length - 1].online) {
          clean.push(raw[i]);
        }
      }
      uptimeHistory[id] = clean;
    });
    pollHistory    = d.pollHistory    || [];
    sparkHistory   = d.sparkHistory   || { online:[], offline:[], health:[] };
    divOverrides   = d.divOverrides   || {};
    settings       = d.settings       || {};
    // ── Migration: upgrade old 30s default to 60s ──────────────
    // The old hardcoded default was 30s. Any saved value of 30 or
    // lower must be upgraded so stored settings don't override the
    // new 60s minimum. User-set values above 30 are kept as-is.
    if (!settings.pollInterval || settings.pollInterval <= 30) {
      settings.pollInterval = 60;
      console.log('[Settings] Migrated pollInterval → 60s');
    }
    darkMode       = d.darkMode       || false;
    if (darkMode) document.body.classList.add('dm');
    loadSettingsToUI();
    updateActBadge();
  } catch(e) { console.error('[Persist]', e); }
}

async function savePersisted(key, val) {
  try { await ipcRenderer.invoke('set-perm', key, val); } catch(e) { console.error(e); }
}

async function saveBatch(obj) {
  try { await ipcRenderer.invoke('set-perm-batch', obj); } catch(e) { console.error(e); }
}

// ══════════════════════════════════════════════════════════════
//  SETTINGS
// ══════════════════════════════════════════════════════════════
function loadSettingsToUI() {
  setVal('s-url',          settings.gasUrl      || '');
  setVal('s-poll',         settings.pollInterval|| 60);
  setCheck('s-notif-os',      settings.notifOS     !== false);
  setCheck('s-notif-offline', settings.notifOffline!== false);
  setCheck('s-notif-online',  settings.notifOnline !== false);
  setCheck('s-notif-warn',    settings.notifWarn   !== false);
  setCheck('s-notif-silent',  settings.notifSilent || false);
  setCheck('s-autostart',     settings.autostart   !== false);
  setCheck('s-sound',         settings.sound       !== false);
  setText('kpi-poll', settings.pollInterval || 60);
}

async function applySettings() {
  settings.gasUrl       = getVal('s-url')            || settings.gasUrl || '';
  settings.pollInterval = parseInt(getVal('s-poll'))  || 60;
  settings.notifOS      = getCheck('s-notif-os');
  settings.notifOffline = getCheck('s-notif-offline');
  settings.notifOnline  = getCheck('s-notif-online');
  settings.notifWarn    = getCheck('s-notif-warn');
  settings.notifSilent  = getCheck('s-notif-silent');
  settings.autostart    = getCheck('s-autostart');
  settings.sound        = getCheck('s-sound');
  await savePersisted('settings', settings);
  startPollTimer();
  setText('kpi-poll', settings.pollInterval);
  showToast('✅ Settings saved & applied');
}

async function loadSettings() {
  const d = await ipcRenderer.invoke('get-perm-all');
  settings = d.settings || {};
  loadSettingsToUI();
  showToast('Settings reset from saved');
}

async function loadStoragePath() {
  try {
    const r = await ipcRenderer.invoke('get-perm-path');
    setText('storage-info', r.perm || '—');
  } catch {}
}

async function testScriptUrl() {
  const url = getVal('s-url').trim();
  const resultEl = $('s-url-test-result');
  if (!url) { showToast('⚠️ Enter a URL first'); return; }
  resultEl.style.display = 'block';
  resultEl.textContent = '⏳ Testing…';
  resultEl.style.color = 'var(--t3)';
  try {
    const r = await ipcRenderer.invoke('test-script-url', url);
    if (r.ok) {
      resultEl.textContent = `✅ Connected (HTTP ${r.status})`;
      resultEl.style.color = 'var(--green)';
    } else {
      resultEl.textContent = `❌ Failed: ${r.reason || 'HTTP ' + r.status}`;
      resultEl.style.color = 'var(--red)';
    }
  } catch(e) {
    resultEl.textContent = '❌ Error: ' + e.message;
    resultEl.style.color = 'var(--red)';
  }
}

// ══════════════════════════════════════════════════════════════
//  POLL / REFRESH
// ══════════════════════════════════════════════════════════════
function startPollTimer() {
  clearInterval(pollTimer);
  const interval = Math.max(5, parseInt(settings.pollInterval) || 60) * 1000;
  pollTimer = setInterval(() => {
    if (!isFetching) {
      isAutoSync = true;
      refreshData().finally(() => { isAutoSync = false; });
    }
  }, interval);
}

async function refreshData() {
  if (isFetching) return;

  const userTriggered = !isAutoSync; // manual click vs background timer

  // ── User-triggered: show full feedback ──────────────────────
  const refreshBtn = $('topbar-refresh-btn');
  if (userTriggered && refreshBtn) {
    refreshBtn._orig = refreshBtn.innerHTML;
    refreshBtn.innerHTML = '<span style="display:inline-block;animation:spin .65s linear infinite;font-size:13px">🔄</span>';
    refreshBtn.style.pointerEvents = 'none';
    refreshBtn.style.opacity = '.7';
  }

  // Sync dot always updates (subtle, in topbar — not disruptive)
  const syncDot = $('sync-dot');
  if (syncDot) syncDot.className = 'sync-dot syncing';
  setText('sync-lbl', 'Syncing…');

  // Progress bar: full animation for user-triggered, subtle for background
  if (userTriggered) showProg(0.1);
  else showProgSilent(0.1); // thin, low-opacity bar for background

  isFetching = true;
  try {
    await pollRefresh();
  } finally {
    isFetching = false;

    // Restore button only for user-triggered
    if (userTriggered && refreshBtn && refreshBtn._orig) {
      refreshBtn.innerHTML = refreshBtn._orig;
      refreshBtn.style.pointerEvents = '';
      refreshBtn.style.opacity = '';
    }

    if (syncDot) syncDot.className = 'sync-dot';
    hideProg();
  }
}

// Silent progress bar — thin, low opacity, for background auto-sync
function showProgSilent(pct) {
  const b = $('progress-bar');
  if (!b) return;
  b.style.opacity = '0.35';
  b.style.height  = '2px';
  b.style.width   = Math.round(pct * 100) + '%';
  b.style.display = 'block';
}

async function pollRefresh() {
  // API-only paths — JSON endpoints to try first
  const apiPaths = [
    '/admin/devices.json', '/status_data', '/api/devices',
    '/api/v1/devices', '/api/status', '/devices',
  ];
  // Full page scrape loads /admin directly—the scraper shares the main
  // Electron session (cookies), so /admin loads successfully with auth.
  const scrapePath = '/admin';
  let devices = null;

  // ── Step 1: Try JSON API endpoints ────────────────────────────────────────────
  for (let i = 0; i < apiPaths.length; i++) {
    showProg(0.1 + (i / apiPaths.length) * 0.3);
    try {
      const ar = await ipcRenderer.invoke('fetch-reachout-api', { apiPath: apiPaths[i] });
      if (ar.success && ar.json) {
        const parsed = parseDevices(ar.json);
        if (parsed && parsed.length > 0) { devices = parsed; break; }
      }
    } catch {}
  }

  // ── Step 2: Full page scrape from root / ─────────────────────────────────────
  // Always runs — this is the only reliable source for Last Seen values
  showProg(0.5);
  try {
    const pr = await ipcRenderer.invoke('fetch-reachout', { path: scrapePath, waitMs: 12000 });
    if (pr.success) {

      // ── Priority 1: Pre-extracted structured devices (header-mapped) ──
      if (pr.devices && pr.devices.length > 0) {
        const parsed = parseExtractedDevices(pr.devices);
        if (parsed && parsed.length > 0) {
          console.log('[Poll] Extraction success:', parsed.length, 'devices',
            '| source:', pr.apiSource,
            '| sample last:', parsed.slice(0,3).map(d => d.name + ':' + d.last).join(', '));
          devices = parsed;
        }
      }

      // ── Priority 2: Parse full HTML (fallback) ──
      if (!devices || !devices.length) {
        const parsed = parseHtmlDevices(pr.html);
        if (parsed && parsed.length > 0) {
          console.log('[Poll] Used HTML parse fallback:', parsed.length, 'devices');
          devices = parsed;
        }
      }

      // ── Priority 3: Window state JSON ──
      if (!devices || !devices.length) {
        if (pr.stateJson) {
          try {
            const st = JSON.parse(pr.stateJson);
            const pd = parseDevices(st);
            if (pd && pd.length > 0) {
              console.log('[Poll] Used state JSON:', pd.length, 'devices');
              devices = pd;
            }
          } catch {}
        }
      }
    }
  } catch {}

  showProg(0.85);

  if (!devices || !devices.length) {
    setSyncStatus('error', '❌ No device data');
    logEvent('Fetch failed — no device data returned', 'err');
    showToast('⚠️ Could not fetch device data');
    hideProg();
    return;
  }

  // Apply division overrides
  devices = devices.map(d => ({
    ...d,
    division: divOverrides[d._id] || d.division || '—'
  }));

  // Detect status changes vs previous
  sessionStats.polls++;
  const prevMap = new Map(allDevices.map(d => [d._id, d.online]));
  devices.forEach(d => {
    const was = prevMap.get(d._id);
    if (was === undefined) return;
    if (was && !d.online) {
      sessionStats.wentOffline++;
      logEvent(`${d.name} went OFFLINE (${d.division})`, 'err');
      notifyOS(`🔴 ${d.name} Offline`, `${d.division} — went offline`, settings.notifOffline);
      addNotif();
    } else if (!was && d.online) {
      sessionStats.cameOnline++;
      logEvent(`${d.name} came ONLINE (${d.division})`, 'ok');
      notifyOS(`✅ ${d.name} Online`, `${d.division} — back online`, settings.notifOnline);
    }
    // Track uptime history — Option B: record ONLY on status transition
    // This keeps 200 entries = 200 real events, not 200 duplicate snapshots
    if (!uptimeHistory[d._id]) uptimeHistory[d._id] = [];
    const hist = uptimeHistory[d._id];
    const last = hist.length ? hist[hist.length - 1] : null;
    const isFirst   = !last;
    const isChanged = last && last.online !== d.online;
    if (isFirst || isChanged) {
      hist.push({ ts: Date.now(), online: d.online });
      if (hist.length > 200) hist.shift();
    }
  });

  allDevices = devices;
  buildDivisionMap();

  // Poll history
  const on  = allDevices.filter(d => d.online).length;
  const off = allDevices.length - on;
  const pct = allDevices.length ? Math.round((on / allDevices.length) * 100) : 0;
  pollHistory.push({ ts: Date.now(), online: on, offline: off, total: allDevices.length, pct });
  if (pollHistory.length > 60) pollHistory.shift();

  // Sparkline arrays
  sparkHistory.online.push(on);
  sparkHistory.offline.push(off);
  sparkHistory.health.push(pct);
  if (sparkHistory.online.length  > 20) sparkHistory.online.shift();
  if (sparkHistory.offline.length > 20) sparkHistory.offline.shift();
  if (sparkHistory.health.length  > 20) sparkHistory.health.shift();

  // Sync all modules
  syncAllModules();

  setSyncStatus('ok', 'Synced ' + new Date().toLocaleTimeString());
  logEvent(`Synced ${allDevices.length} devices · ${on} online · ${off} offline`, 'info');

  showProg(1);
  // Throttled save — only write to disk when online/offline counts changed
  // Avoids constant disk I/O every 60 seconds when nothing changed
  const _saveHash = allDevices.length + '|' + allDevices.filter(d=>d.online).length;
  if (window._lastSaveHash !== _saveHash) {
    window._lastSaveHash = _saveHash;
    await saveBatch({ activityLog, uptimeHistory, pollHistory, sparkHistory, divOverrides });
  }
  hideProg();
}

// ══════════════════════════════════════════════════════════════
//  PARSE DEVICES
// ══════════════════════════════════════════════════════════════
function parseDevices(raw) {
  if (!raw) return [];
  let arr = [];
  if (Array.isArray(raw))               arr = raw;
  else if (Array.isArray(raw.devices))  arr = raw.devices;
  else if (Array.isArray(raw.data))     arr = raw.data;
  else if (Array.isArray(raw.results))  arr = raw.results;
  else if (Array.isArray(raw.result))   arr = raw.result;
  else {
    const vals = Object.values(raw);
    if (vals.length && typeof vals[0] === 'object') arr = vals;
  }
  if (!arr.length) return [];

  const ONLINE_SET = new Set(['online','active','up','connected','1','true','running','alive','on','yes']);
  return arr.map((d, i) => {
    const id   = str(d.device_id ?? d.DeviceId ?? d.deviceId ?? d.id ?? d.ID ?? d._id ?? d.name ?? i);
    const name = str(d.device_name ?? d.DeviceName ?? d.deviceName ?? d.name ?? d.Name ?? d.hostname ?? id ?? 'Unknown');
    const div  = str(d.division ?? d.Division ?? d.group ?? d.Group ?? d.location ?? d.Location ?? d.area ?? d.Area ?? d.zone ?? d.Zone ?? d.district ?? d.District ?? d.city ?? d.City ?? d.region ?? d.Region ?? '—');
    let online = false;
    if      (d.online       !== undefined) online = Boolean(d.online);
    else if (d.is_online    !== undefined) online = Boolean(d.is_online);
    else if (d.isOnline     !== undefined) online = Boolean(d.isOnline);
    else if (d.active       !== undefined) online = Boolean(d.active);
    else if (d.connected    !== undefined) online = Boolean(d.connected);
    else if (d.status       !== undefined) online = ONLINE_SET.has(str(d.status).toLowerCase().trim());
    else if (d.Status       !== undefined) online = ONLINE_SET.has(str(d.Status).toLowerCase().trim());
    else if (d.device_status!== undefined) online = ONLINE_SET.has(str(d.device_status).toLowerCase().trim());
    else if (d.state        !== undefined) online = ONLINE_SET.has(str(d.state).toLowerCase().trim());
    else if (d.status_code  !== undefined) online = d.status_code === 1 || d.status_code === '1';
    const uptimeStr  = str(d.uptime ?? d.uptime_str ?? d.up_time ?? d.uptimeStr ?? d.Uptime ?? d.UptimeStr ?? '—');
    const rawLast    = resolveLastSeen(d);
    // Resolve _lastTs: try in priority order:
    //  1. Parse rawLast as a relative string ("3h ago", "1d ago") — ReachOut native format
    //  2. Parse rawLast as a timestamp/ISO date
    
    let derivedLastTs = null;
    if (rawLast !== '—') {
      derivedLastTs = parseRelativeLastSeen(rawLast, online);
    }
    // No uptime fallback — _lastTs stays null when no real last_seen exists
    return {
      _id:     id,
      name,
      division: div,
      online,
      uptime:  uptimeStr,
      last:    rawLast,
      _lastTs: derivedLastTs,
      ip:      str(d.ip ?? d.ip_address ?? d.ipAddress ?? '—'),
      mac:     str(d.mac ?? d.mac_address ?? d.macAddress ?? '—'),
      version: str(d.version ?? d.firmware ?? d.app_version ?? '—'),
      model:   str(d.model ?? d.device_type ?? d.type ?? '—'),
    };
  }).filter(d => d.name && d.name !== 'Unknown');
}

// ─── Parse relative last-seen strings from ReachOut platform ─────────
// Converts "3h ago" → timestamp, "1d ago" → timestamp, "30m ago" → timestamp
// Returns null if the string can't be parsed
// ─── Parse pre-extracted devices (from EXTRACT_ALL_JS header-based scrape) ──
// These already have correct column mapping done in the browser context.
function parseExtractedDevices(rawDevices) {
  if (!Array.isArray(rawDevices) || !rawDevices.length) return [];
  const out = [];
  rawDevices.forEach((d, i) => {
    const name = String(d.name || '').trim();
    if (!name || name === '—') return;

    const div     = String(d.division || '—').trim();
    const online  = !!d.online;
    const uptimeStr = String(d.uptime || '—').trim();
    const lastRaw   = String(d.last   || '—').trim();

    // Use source value exactly as-is — no transformation, no fallback
    const lastDisplay = lastRaw;
    // Resolve timestamp for filtering/sorting only
    const lastTs = parseRelativeLastSeen(lastDisplay, online);

    out.push({
      _id:     `ext-${i}-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`,
      name,
      division: div,
      online,
      uptime:  uptimeStr,
      last:    lastDisplay,
      _lastTs: lastTs,
      ip:      String(d.ip || '—').trim(),
      mac:     '—', version: '—', model: '—',
    });
  });
  return out;
}

function parseRelativeLastSeen(str, isOnline) {
  if (!str || str === '—') return null;
  const s = str.toLowerCase().trim();

  // Online devices: "active now", "just now", "online"
  if (isOnline || /^(just now|active now|now|online)/.test(s)) return Date.now();

  // e.g. "3h ago", "1h ago", "6h 18m ago", "1d ago", "2d ago", "30m ago"
  let totalMs = 0;
  const wk = s.match(/(\d+)\s*w/);  if (wk)  totalMs += parseInt(wk[1])  * 604800000;
  const dy = s.match(/(\d+)\s*d/);  if (dy)  totalMs += parseInt(dy[1])  * 86400000;
  const hr = s.match(/(\d+)\s*h/);  if (hr)  totalMs += parseInt(hr[1])  * 3600000;
  const mn = s.match(/(\d+)\s*m(?!s)/); if (mn) totalMs += parseInt(mn[1]) * 60000;
  const sc = s.match(/(\d+)\s*s/);  if (sc)  totalMs += parseInt(sc[1])  * 1000;

  if (totalMs > 0) return Date.now() - totalMs;

  // Fall through: try as a direct date/time string
  return parseDateField(str);
}

function parseHtmlDevices(html) {
  if (!html) return [];
  try {
    const parser = new DOMParser();
    const doc    = parser.parseFromString(html, 'text/html');
    const devices = [];

    // ── Find device table and detect columns from header text ────
    // Works with or without <thead>/<tbody> wrappers (SPAs often omit them).
    const tables = Array.from(doc.querySelectorAll('table'));
    for (const table of tables) {
      // Get ALL rows from the table
      const allRows = Array.from(table.querySelectorAll('tr'));
      if (allRows.length < 2) continue;

      // Find the header row: prefer rows with <th>, else use row 0
      let headerRowIdx = 0;
      let headerCells = [];
      for (let ri = 0; ri < Math.min(3, allRows.length); ri++) {
        const ths = allRows[ri].querySelectorAll('th');
        if (ths.length) { headerRowIdx = ri; headerCells = Array.from(ths); break; }
        if (ri === 0) {
          const tds = allRows[ri].querySelectorAll('td');
          if (tds.length) headerCells = Array.from(tds);
        }
      }
      if (!headerCells.length) continue;

      // Normalise header text — strip sort arrows, emoji, extra whitespace
      const headers = headerCells.map(h =>
        h.textContent.replace(/[↑↓⇅↕▲▼⬆⬇]/g, '').trim().toLowerCase()
      );

      // Only process tables that look like a device table
      const hasDevice = headers.some(h => /device|\bname\b/.test(h));
      const hasStatus = headers.some(h => /\b(status|state)\b/.test(h));
      if (!hasDevice || !hasStatus) continue;

      // Map column names → indices from header text
      const col = {};
      headers.forEach((h, i) => {
        if (/^(device name|device|\bname\b)/.test(h) && col.name     === undefined) col.name     = i;
        if (/division|zone|\bgroup\b|\barea\b/.test(h) && col.division === undefined) col.division = i;
        if (/\b(status|state)\b/.test(h)                  && col.status   === undefined) col.status   = i;
        if (/uptime|up.?time/.test(h)                        && col.uptime   === undefined) col.uptime   = i;
        if (/last/.test(h)                                   && col.last     === undefined) col.last     = i;
        if (/\bip\b|ip.?address/.test(h)                    && col.ip       === undefined) col.ip       = i;
      });

      // ── Extract data rows — allRows/headerRowIdx already set above ──
      const dataRows = allRows.slice(headerRowIdx + 1);

      console.log('[parseHtmlDevices] colMap:', JSON.stringify(col),
        '| headers:', headers.join(', '), '| dataRows:', dataRows.length);

      let rowIdx = 0;
      dataRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;

        const get = (idx) => {
          if (idx === undefined || !cells[idx]) return '—';
          return cells[idx].textContent.trim() || '—';
        };

        const name = get(col.name);
        if (!name || name === '—' || /^(device|\bname\b)$/i.test(name)) return;

        const statusTxt = get(col.status).toLowerCase();
        const online    = /online|active|\bup\b|running|connected/.test(statusTxt);
        const up        = get(col.uptime);
        const lastRaw   = get(col.last);
        const ip        = get(col.ip);
        const div       = get(col.division);

        // Use source value exactly as-is — no transformation, no fallback
        const lastNorm  = lastRaw || '—';
        const lastTs    = parseRelativeLastSeen(lastNorm, online);

        devices.push({
          _id:      `html-${rowIdx++}-${name.toLowerCase().replace(/[^a-z0-9]/g, '').slice(0,12)}`,
          name, division: div, online, uptime: up,
          last: lastNorm, _lastTs: lastTs,
          ip: ip || '—', mac: '—', version: '—', model: '—',
        });
      });

      if (devices.length > 0) break; // Found the device table
    }

    return devices;
  } catch(e) {
    console.error('[parseHtmlDevices] error:', e.message);
    return [];
  }
}

// ─── Resolve last-seen from any known API field name ──────────
function resolveLastSeen(d) {
  // Ordered list of field names to try
  const raw =
    d.last_seen_str    ??
    d.last_seen        ?? d.lastSeen        ??
    d.last_active      ?? d.lastActive      ??
    d.last_ping        ?? d.lastPing        ??
    d.last_contact     ?? d.lastContact     ??
    d.last_online      ?? d.lastOnline      ??
    d.last_check       ?? d.lastCheck       ??
    d.last_update      ?? d.lastUpdate      ??
    d.last_response    ?? d.lastResponse    ??
    d.last_heartbeat   ?? d.lastHeartbeat   ??
    d.heartbeat        ?? d.heartbeat_at    ??
    d.ping             ?? d.ping_time       ??
    d.seen_at          ?? d.seenAt          ??
    d.checkin          ?? d.check_in        ??
    d.checked_at       ?? d.checkedAt       ??
    d.last_report      ?? d.lastReport      ??
    d.report_time      ?? d.reportTime      ??
    d.disconnected_at  ?? d.disconnectedAt  ??
    d.offline_since    ?? d.offlineSince    ??
    d.updated_at       ?? d.updatedAt       ??
    d.modified_at      ?? d.modifiedAt      ??
    d.timestamp        ?? d.Timestamp       ??
    d.created_at       ?? d.createdAt       ??
    null;
  if (raw == null) return '—';
  const s = String(raw).trim();
  if (!s || s === 'null' || s === 'undefined') return '—';
  return s;
}



// ─── Parse uptime/duration string → milliseconds ─────────────
// e.g. "4h 38m", "2d 3h", "38m", "1w 2d", "30s"
function parseUptimeDuration(uptimeStr) {
  if (!uptimeStr || uptimeStr === '—') return null;
  const s = String(uptimeStr).toLowerCase().trim();
  let ms = 0;
  const rw  = s.match(/(\d+)\s*w/);       if (rw)  ms += parseInt(rw[1])  * 604800000;
  const rdy = s.match(/(\d+)\s*d/);       if (rdy) ms += parseInt(rdy[1]) * 86400000;
  const rh  = s.match(/(\d+)\s*h/);       if (rh)  ms += parseInt(rh[1])  * 3600000;
  const rm  = s.match(/(\d+)\s*m(?!s)/);  if (rm)  ms += parseInt(rm[1])  * 60000;
  const rs  = s.match(/(\d+)\s*s/);       if (rs)  ms += parseInt(rs[1])  * 1000;
  return ms > 0 ? ms : null;
}

function buildDivisionMap() {
  divisionMap = {};
  allDevices.forEach(d => {
    const dv = d.division || '—';
    if (!divisionMap[dv]) divisionMap[dv] = [];
    divisionMap[dv].push(d);
  });
}

// ══════════════════════════════════════════════════════════════
//  SYNC ALL MODULES
// ══════════════════════════════════════════════════════════════
function syncAllModules() {
  // Always update core KPI numbers and health (lightweight DOM text updates)
  updateKPIs();
  updateHealthBand();
  updateNavCounters();
  updateActBadge();

  // During auto-sync: if modal is open, defer heavy UI work until modal closes
  // Prevents any flicker or disruption to the user's current view
  if (isAutoSync && _modalDeviceId) {
    window._pendingSync = true; // flag to re-sync when modal closes
    return;
  }
  window._pendingSync = false;

  updateInsightWidgets();
  updateDivHealthList();
  updateOfflineList();

  // Activity panel: skip rebuild during auto-sync if user is reading it
  const actPageActive = document.getElementById('page-activity')?.classList.contains('active');
  if (!isAutoSync || !actPageActive) renderActPanel();

  // Device table: DOM-diffing — only changed rows update
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);

  // Division chips: skip rebuild during auto-sync if count unchanged (preserves scroll)
  const divCount = Object.keys(divisionMap).length;
  if (!isAutoSync || divCount !== (window._lastDivCount || 0)) {
    updateDivTagsBar();
    window._lastDivCount = divCount;
  }

  setText('div-total-count', divCount);
  updateDivSummaryBar();
  if (document.getElementById('page-divisions').classList.contains('active')) {
    renderDivisionsList();
  }
  updateSortIndicators();
}

// ══════════════════════════════════════════════════════════════
//  KPIs
// ══════════════════════════════════════════════════════════════
function updateKPIs() {
  const total = allDevices.length;
  const on    = allDevices.filter(d => d.online).length;
  const off   = total - on;
  const pct   = total ? ((on / total) * 100).toFixed(1) : '0.0';
  const divs  = Object.keys(divisionMap).length;

  animateCount('kpi-total',   total);
  animateCount('kpi-online',  on);
  animateCount('kpi-offline', off);
  animateCount('kpi-divs',    divs);
  setText('kpi-pct', pct + '%');

  setText('kpi-online-sub',  on  + ' of ' + total + ' devices');
  setText('kpi-offline-sub', off + ' need attention');
  setText('db-sub-lbl', `Last sync: ${new Date().toLocaleTimeString()} · ${total} devices across ${divs} divisions`);

  setText('nav-online',  on);
  setText('nav-offline', off);
  setText('nav-total',   total);

  // Health colour on KPI card
  const p = parseFloat(pct);
  const pctEl = $('kpi-pct');
  if (pctEl) pctEl.style.color = p >= 80 ? 'var(--green)' : p >= 50 ? 'var(--amber)' : 'var(--red)';

  // Trend badges
  if (pollHistory.length >= 2) {
    const prev = pollHistory[pollHistory.length - 2];
    const cur  = pollHistory[pollHistory.length - 1];
    setTrend('kpi-online-trend',  cur.online  - prev.online);
    setTrend('kpi-offline-trend', cur.offline - prev.offline, true);
    setTrend('kpi-health-trend',  cur.pct     - prev.pct);
  }

  // Sparklines
  drawSparkline('spark-total',   sparkHistory.online.map((_,i) => sparkHistory.online[i] + sparkHistory.offline[i]), '#6366f1');
  drawSparkline('spark-online',  sparkHistory.online,  '#10b981');
  drawSparkline('spark-offline', sparkHistory.offline, '#ef4444');
  drawSparkline('spark-health',  sparkHistory.health,  '#8b5cf6');
}

function setTrend(id, delta, invert=false) {
  const el = $(id);
  if (!el) return;
  const d = invert ? -delta : delta;
  if (d > 0) {
    el.className = 'kpi-trend kt-up';
    el.textContent = '+' + Math.abs(delta);
  } else if (d < 0) {
    el.className = 'kpi-trend kt-dn';
    el.textContent = '−' + Math.abs(delta);
  } else {
    el.className = 'kpi-trend kt-neut';
    el.textContent = '—';
  }
}

// ══════════════════════════════════════════════════════════════
//  HEALTH BAND
// ══════════════════════════════════════════════════════════════
function updateHealthBand() {
  const on  = allDevices.filter(d => d.online).length;
  const tot = allDevices.length;
  const pct = tot ? ((on / tot) * 100).toFixed(1) : '0.0';
  const p   = parseFloat(pct);

  const bar = $('health-bar');
  if (bar) {
    bar.style.width = pct + '%';
    bar.className   = 'hb-fill ' + (p >= 80 ? 'hf-good' : p >= 50 ? 'hf-warn' : 'hf-crit');
  }
  setText('hb-pct', pct + '%');

  const badge = $('hb-badge');
  if (badge) {
    if (p >= 90)      { badge.textContent = '🟢 Excellent'; badge.style.background='var(--green-bg)'; badge.style.color='var(--green2)'; }
    else if (p >= 75) { badge.textContent = '🟡 Good';      badge.style.background='var(--green-bg)'; badge.style.color='var(--green2)'; }
    else if (p >= 50) { badge.textContent = '🟠 Warning';   badge.style.background='var(--amber-bg)'; badge.style.color='var(--amber2)'; }
    else              { badge.textContent = '🔴 Critical';  badge.style.background='var(--red-bg)';   badge.style.color='var(--red2)'; }
  }
}

// ══════════════════════════════════════════════════════════════
//  INSIGHT WIDGETS  (replaced Fleet Composition, Online Trend,
//                    Division Health charts)
// ══════════════════════════════════════════════════════════════
function updateInsightWidgets() {
  updateSyncWidget();
  updateStatusChangeWidget();
  updateMostAffectedWidget();
  updateBestDivisionWidget();
}

/* ── Widget 1: Last Sync / Poll countdown ── */
function updateSyncWidget() {
  const now = new Date();
  setText('sync-time-big', now.toLocaleTimeString());
  setText('sync-age-lbl', now.toLocaleDateString());
  const interval = Math.max(5, parseInt(settings.pollInterval) || 60);
  setText('poll-interval-lbl', interval);
  // Reset countdown bar and timer
  pollCountdown = interval;
  clearInterval(pollCountdownTimer);
  const bar = $('poll-countdown-bar');
  if (bar) bar.style.width = '100%';
  const lbl = $('next-poll-lbl');
  pollCountdownTimer = setInterval(() => {
    pollCountdown = Math.max(0, pollCountdown - 1);
    if (lbl) lbl.textContent = pollCountdown;
    if (bar) bar.style.width = ((pollCountdown / interval) * 100) + '%';
    if (pollCountdown <= 0) clearInterval(pollCountdownTimer);
  }, 1000);
  if (lbl) lbl.textContent = interval;
}

/* ── Widget 2: Status Change Rate ── */
function updateStatusChangeWidget() {
  setText('stat-went-offline', sessionStats.wentOffline);
  setText('stat-came-online',  sessionStats.cameOnline);
  setText('stat-polls',        sessionStats.polls);
}

/* ── Widget 3: Most Affected Division ── */
function updateMostAffectedWidget() {
  const entries = Object.entries(divisionMap)
    .map(([name, devs]) => {
      const off = devs.filter(d => !d.online).length;
      const pct = devs.length ? Math.round((off / devs.length) * 100) : 0;
      return { name, off, total: devs.length, pct };
    })
    .filter(e => e.off > 0)
    .sort((a, b) => b.off - a.off);

  if (!entries.length) {
    setText('most-affected-div', 'None — all online!');
    setText('most-affected-cnt', '0');
    setText('most-affected-pct', 'All devices responding');
    const bar = $('most-affected-bar');
    if (bar) bar.style.width = '0%';
    return;
  }
  const top = entries[0];
  setText('most-affected-div', top.name);
  setText('most-affected-cnt', top.off);
  setText('most-affected-pct', top.pct + '% of division offline');
  const bar = $('most-affected-bar');
  if (bar) bar.style.width = top.pct + '%';
}

/* ── Widget 4: Best Division ── */
function updateBestDivisionWidget() {
  const entries = Object.entries(divisionMap)
    .map(([name, devs]) => {
      const on  = devs.filter(d => d.online).length;
      const pct = devs.length ? Math.round((on / devs.length) * 100) : 0;
      return { name, on, total: devs.length, pct };
    })
    .sort((a, b) => b.pct - a.pct || b.total - a.total);

  if (!entries.length) {
    setText('best-div-name', '—'); setText('best-div-pct', '—');
    return;
  }
  const top = entries[0];
  setText('best-div-name', top.name);
  setText('best-div-pct', top.pct + '%');
  setText('best-div-sub', `${top.on} of ${top.total} devices online`);
  const bar = $('best-div-bar');
  if (bar) bar.style.width = top.pct + '%';
}

// ══════════════════════════════════════════════════════════════
//  DIVISION HEALTH LIST (dashboard widget)
// ══════════════════════════════════════════════════════════════
function updateDivHealthList() {
  const el   = $('db-div-list');
  const mini = $('db-div-mini');
  if (!el) return;

  const entries = Object.entries(divisionMap)
    .map(([name, devs]) => {
      const on  = devs.filter(d => d.online).length;
      const pct = devs.length ? Math.round((on / devs.length) * 100) : 0;
      return { name, on, off: devs.length - on, total: devs.length, pct };
    })
    .sort((a, b) => b.total - a.total);

  setText('db-div-count', entries.length);

  if (!entries.length) { el.innerHTML = '<div class="af-empty">No divisions found</div>'; return; }

  el.innerHTML = entries.map(e => {
    const color = e.pct >= 80 ? 'var(--green)' : e.pct >= 50 ? 'var(--amber)' : 'var(--red)';
    return `<div class="dhl-row" onclick="filterByDiv('${esc(e.name)}')">
      <div class="dhl-dot" style="background:${color}"></div>
      <div class="dhl-name" title="${esc(e.name)}">${esc(e.name)}</div>
      <div class="dhl-bar-wrap"><div class="dhl-bar" style="width:${e.pct}%;background:${color}"></div></div>
      <div class="dhl-pct" style="color:${color}">${e.pct}%</div>
      <div class="dhl-count">${e.on}/${e.total}</div>
    </div>`;
  }).join('');

  if (mini) {
    const totDivs = entries.length;
    const healthy = entries.filter(e => e.pct >= 80).length;
    const warn    = entries.filter(e => e.pct >= 50 && e.pct < 80).length;
    const crit    = entries.filter(e => e.pct < 50).length;
    mini.innerHTML = `
      <div class="mini-stat"><div class="ms-val" style="color:var(--green)">${healthy}</div><div class="ms-lbl">Healthy</div></div>
      <div class="mini-stat"><div class="ms-val" style="color:var(--amber)">${warn}</div><div class="ms-lbl">Warning</div></div>
      <div class="mini-stat"><div class="ms-val" style="color:var(--red)">${crit}</div><div class="ms-lbl">Critical</div></div>
      <div class="mini-stat"><div class="ms-val">${totDivs}</div><div class="ms-lbl">Total</div></div>
    `;
  }
}

// ══════════════════════════════════════════════════════════════
//  OFFLINE LIST WIDGET
// ══════════════════════════════════════════════════════════════
function updateOfflineList() {
  const el   = $('db-offline-list');
  const mini = $('db-offline-mini');
  if (!el) return;

  const offline = allDevices.filter(d => !d.online)
    .sort((a, b) => a.division.localeCompare(b.division));

  setText('db-offline-cnt', offline.length + ' offline');

  if (!offline.length) {
    el.innerHTML = '<div class="ol-empty">✅ All devices online!</div>';
    if (mini) mini.innerHTML = '';
    return;
  }

  el.innerHTML = offline.map(d => `
    <div class="ol-row" onclick="showDevModal('${esc(d._id)}')">
      <div class="ol-av">${d.name.charAt(0).toUpperCase()}</div>
      <div class="ol-name" title="${esc(d.name)}">${esc(d.name)}</div>
      <div class="ol-div">${esc(d.division)}</div>
      <div class="ol-last">${esc(fmtLastSeen(d.last, d._lastTs, false))}</div>
    </div>`).join('');

  if (mini) {
    const byDiv = {};
    offline.forEach(d => { byDiv[d.division] = (byDiv[d.division] || 0) + 1; });
    const worst = Object.entries(byDiv).sort((a,b) => b[1]-a[1]).slice(0,3);
    mini.innerHTML = worst.map(([name, cnt]) =>
      `<div class="mini-stat"><div class="ms-val" style="color:var(--red)">${cnt}</div><div class="ms-lbl" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:60px" title="${esc(name)}">${esc(name)}</div></div>`
    ).join('');
  }
}

// ══════════════════════════════════════════════════════════════
//  DIVISION TAGS BAR (table filter)
// ══════════════════════════════════════════════════════════════
function updateDivTagsBar() {
  const all = '<button class="div-filter-btn active" onclick="setDivFilter(\'all\',this)">All Divisions</button>';
  const tags = Object.entries(divisionMap)
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([name]) =>
      `<button class="div-filter-btn" onclick="setDivFilter('${esc(name)}',this)">${esc(name)}</button>`
    ).join('');

  // Populate dashboard table div filter bar
  const wrap1 = $('div-tags-wrap');
  if (wrap1) wrap1.innerHTML = all + tags;

  // Populate devices page div filter bar
  const wrap2 = $('div-tags-wrap2');
  if (wrap2) wrap2.innerHTML = all + tags;
}

function setDivFilter(name, btn) {
  divFilter = name;
  // Update ALL div-filter buttons in both tables
  document.querySelectorAll('.div-filter-btn').forEach(b => {
    const matches = name === 'all' ? b.textContent === 'All Divisions' : b.textContent === name;
    b.classList.toggle('active', matches);
  });
  renderDeviceTable('device-tbody', true);
  renderDeviceTable('device-tbody2', false);
}

function filterByDiv(name) {
  setDivFilter(name, null);
  navTo('devices');
}

// ══════════════════════════════════════════════════════════════
//  DEVICE TABLE
// ══════════════════════════════════════════════════════════════
// Build one device row HTML string
function buildDeviceRow(d, withCheckbox) {
  const initials = d.name.slice(0,2).toUpperCase();
  // Selection checkbox column removed from the UI — see renderDeviceTable's
  // cols calc below, which no longer varies by withCheckbox either.
  const chk = '';
  const lastFmt = fmtLastSeen(d.last, d._lastTs, d.online);
  const lastRaw = d.last !== '—' ? d.last : (d._lastTs ? new Date(d._lastTs).toLocaleString() : '—');
  const tu = computeTotalUptime(d._id);
  const tuDisplay = tu
    ? `<span style="font-weight:600;color:var(--primary)">${esc(tu.pct)}</span><span style="color:var(--t4);font-size:11px"> · ${esc(tu.dur)}</span>`
    : '<span style="color:var(--t5)">—</span>';
  const tuTitle = tu ? esc(tu.tooltip) : 'No history yet — accumulates with each status change';
  return `<tr class="dev-row" data-id="${esc(d._id)}" onclick="showDevModal('${esc(d._id)}')">
    ${chk}
    <td><div class="dev-name-cell">
      <div class="dev-av ${d.online?'av-on':'av-off'}">${initials}</div>
      <div><div class="dev-name">${esc(d.name)}</div>${d.ip && d.ip !== '—' ? `<div class="mono t3" style="font-size:11px">${esc(d.ip)}</div>` : ''}</div>
    </div></td>
    <td><span class="status-pill ${d.online?'pill-on':'pill-off'}">${d.online?'🟢 Online':'🔴 Offline'}</span></td>
    <td class="mono">${esc(d.uptime)}</td>
    <td>${esc(d.division)}</td>
    <td class="mono t3" title="${esc(lastRaw)}">${esc(lastFmt)}</td>
    <td class="mono" style="font-size:12px" title="${tuTitle}">${tuDisplay}</td>
    <td onclick="event.stopPropagation()">
      <button class="btn btn-outline btn-xs" onclick="openDivExplore('${esc(d.division)}')">📂</button>
    </td>
  </tr>`;
}

// Get filtered + sorted device list (shared between both tables)
function getFilteredDevices() {
  const search = ($('global-search')?.value || '').toLowerCase().trim();
  const advUptime       = advFilter.uptime.toLowerCase().trim();
  const advLastSeen     = advFilter.lastSeen.toLowerCase().trim();
  const advDateFrom     = advFilter.dateFrom     ? new Date(advFilter.dateFrom + 'T00:00:00').getTime()     : null;
  const advDateTo       = advFilter.dateTo       ? new Date(advFilter.dateTo   + 'T23:59:59').getTime()     : null;
  const advDatetimeFrom = advFilter.datetimeFrom ? new Date(advFilter.datetimeFrom).getTime()               : null;
  const advDatetimeTo   = advFilter.datetimeTo   ? new Date(advFilter.datetimeTo).getTime()                 : null;
  const advPreset       = advFilter.offlinePreset;

  let list = allDevices.filter(d => {
    if (currentFilter === 'online'  && !d.online) return false;
    if (currentFilter === 'offline' &&  d.online) return false;
    if (divFilter !== 'all' && d.division !== divFilter) return false;
    if (search && !d.name.toLowerCase().includes(search)
               && !d.division.toLowerCase().includes(search)
               && !d.ip.toLowerCase().includes(search)) return false;
    if (advUptime && !d.uptime.toLowerCase().includes(advUptime)) return false;
    if (advLastSeen) {
      const fmtd = fmtLastSeen(d.last, d._lastTs, d.online).toLowerCase();
      if (!fmtd.includes(advLastSeen) && !d.last.toLowerCase().includes(advLastSeen)) return false;
    }
    if (advPreset) {
      const thresholdH = parseFloat(advPreset);
      const offH = computeOfflineHours(d);
      if (offH === null || offH < thresholdH) return false;
    }
    if (advDateFrom || advDateTo) {
      const lastTs = d._lastTs ?? parseDateField(d.last) ?? null;
      if (!lastTs) return false;
      if (advDateFrom && lastTs < advDateFrom) return false;
      if (advDateTo   && lastTs > advDateTo)   return false;
    }
    if (advDatetimeFrom || advDatetimeTo) {
      const lastTs = d._lastTs ?? parseDateField(d.last) ?? null;
      if (!lastTs) return false;
      if (advDatetimeFrom && lastTs < advDatetimeFrom) return false;
      if (advDatetimeTo   && lastTs > advDatetimeTo)   return false;
    }
    return true;
  });

  return sortDevices(list);
}

// DOM-diffing render — only updates rows that actually changed
// ~900x fewer DOM operations vs full innerHTML rebuild on each sync
function renderDeviceTable(tbodyId, withCheckbox) {
  const tbody = $(tbodyId);
  if (!tbody) return;

  const list = getFilteredDevices();

  // Update count labels
  setText('dev-count',  list.length + ' / ' + allDevices.length);
  setText('dev-count2', list.length + ' / ' + allDevices.length);

  const cols = 7; // checkbox column removed — same column count for both tables now
  if (!list.length) {
    tbody.innerHTML = `<tr><td colspan="${cols}" class="empty-row">No devices match the current filter.</td></tr>`;
    return;
  }

  // Build a map of existing rows by device id
  const existingRows = new Map();
  tbody.querySelectorAll('tr[data-id]').forEach(tr => existingRows.set(tr.dataset.id, tr));

  // Determine if this is a full structural change (filter/sort changed order)
  // In that case, rebuild fully — it's user-triggered so no lag concern
  const existingIds = [...existingRows.keys()];
  const newIds      = list.map(d => d._id);
  const orderChanged = existingIds.length !== newIds.length
    || newIds.some((id, i) => id !== existingIds[i]);

  if (orderChanged) {
    // Full rebuild — order or filter changed (user action, not auto-sync)
    tbody.innerHTML = list.map(d => buildDeviceRow(d, withCheckbox)).join('');
    // Stamp hashes for future diff
    tbody.querySelectorAll('tr[data-id]').forEach(tr => {
      const d = allDevices.find(x => x._id === tr.dataset.id);
      if (d) tr.dataset.hash = rowHash(d);
    });
    return;
  }

  // DOM diff — only update rows where data actually changed (auto-sync path)
  requestAnimationFrame(() => {
    list.forEach(d => {
      const existing = existingRows.get(d._id);
      const newHash  = rowHash(d);
      if (!existing) return; // shouldn't happen after order check above
      if (existing.dataset.hash === newHash) return; // unchanged — skip
      // Only this row changed — replace it
      const tmp = document.createElement('tbody');
      tmp.innerHTML = buildDeviceRow(d, withCheckbox);
      const newRow = tmp.firstElementChild;
      newRow.dataset.hash = newHash;
      existing.replaceWith(newRow);
    });
  });
}

// ─── Format last-seen field ───────────────────────────────────
// raw       = d.last   (API field — may be '—')
// derivedTs = d._lastTs (computed from uptime — may be null)
// isOnline  = d.online
function fmtLastSeen(raw, derivedTs, isOnline) {
  // Return exactly what the source dashboard shows — no transformation, no fallback
  return (raw && raw !== '—') ? raw : '—';
}

function fmtRelative(ts) {
  const now    = Date.now();
  const diffMs = now - ts;
  if (diffMs < 0)         return new Date(ts).toLocaleString();
  if (diffMs < 60000)     return 'Just now';
  if (diffMs < 3600000) {
    const m = Math.floor(diffMs / 60000);
    return `${m}m ago`;
  }
  if (diffMs < 86400000) {
    const h = Math.floor(diffMs / 3600000);
    const m = Math.floor((diffMs % 3600000) / 60000);
    return m > 0 ? `${h}h ${m}m ago` : `${h}h ago`;
  }
  if (diffMs < 172800000) {
    const h = Math.floor(diffMs / 3600000);
    return `${h}h ago`;
  }
  const dd = Math.floor(diffMs / 86400000);
  const rh = Math.floor((diffMs % 86400000) / 3600000);
  if (dd < 7) return rh > 0 ? `${dd}d ${rh}h ago` : `${dd}d ago`;
  return new Date(ts).toLocaleString();
}

// Shows an absolute clock time (distinct from duration strings)
// e.g. "2:15 PM today", "10:42 AM yesterday", "Jan 15, 2:15 PM"
function fmtAbsolute(ts) {
  const d    = new Date(ts);
  const now  = new Date();
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (d.toDateString() === now.toDateString()) {
    return time + ' today';
  }
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) {
    return time + ' yesterday';
  }
  const diffDays = Math.floor((now - d) / 86400000);
  if (diffDays < 7) {
    return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' }) + ' ' + time;
}

function parseDateField(raw) {
  if (!raw || raw === '—') return null;
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    if (n > 1000000000000) return n;
    if (n > 1000000000)   return n * 1000;
    return null;
  }
  const d = new Date(s);
  if (!isNaN(d.getTime())) return d.getTime();
  const d2 = new Date(s.replace(' ', 'T'));
  if (!isNaN(d2.getTime())) return d2.getTime();
  return null;
}

// ─── Compute hours offline from last-seen ─────────────────────
// Works with: "3h ago", "1d ago", ISO timestamps, derived _lastTs
function computeOfflineHours(d) {
  if (d.online) return 0;
  // Priority: _lastTs (already resolved by parseRelativeLastSeen/parseDevices),
  // then try direct parse of d.last as relative or timestamp
  const ts = d._lastTs
    ?? parseRelativeLastSeen(d.last, false)
    ?? parseDateField(d.last)
    ?? null;
  if (!ts) return null;
  return Math.max(0, (Date.now() - ts) / 3600000);
}


// ─── Advanced filter controls ─────────────────────────────────
function applyAdvFilter() {
  advFilter.uptime        = $('adv-filter-uptime')?.value       || '';
  advFilter.lastSeen      = $('adv-filter-lastseen')?.value     || '';
  advFilter.dateFrom      = $('adv-filter-from')?.value         || '';
  advFilter.dateTo        = $('adv-filter-to')?.value           || '';
  advFilter.offlinePreset = $('adv-filter-preset')?.value       || '';
  advFilter.datetimeFrom  = $('adv-filter-dt-from')?.value      || '';
  advFilter.datetimeTo    = $('adv-filter-dt-to')?.value        || '';
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);
  // Badge count
  const activeCount = [
    advFilter.uptime, advFilter.lastSeen,
    advFilter.dateFrom, advFilter.dateTo,
    advFilter.offlinePreset,
    advFilter.datetimeFrom, advFilter.datetimeTo
  ].filter(Boolean).length;
  const badge = $('adv-filter-badge');
  if (badge) {
    badge.textContent = activeCount > 0 ? activeCount : '';
    badge.style.display = activeCount > 0 ? 'inline-flex' : 'none';
  }
}

function setOfflinePreset(val, btn) {
  // Update the select to match
  const sel = $('adv-filter-preset');
  if (sel) sel.value = val;
  // Clear custom datetime if using preset
  if (val) {
    advFilter.datetimeFrom = ''; advFilter.datetimeTo = '';
    if ($('adv-filter-dt-from')) $('adv-filter-dt-from').value = '';
    if ($('adv-filter-dt-to'))   $('adv-filter-dt-to').value   = '';
  }
  // Highlight preset chips
  document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
  if (btn) btn.classList.add('active');
  applyAdvFilter();
}

function clearAdvFilter() {
  advFilter = { uptime: '', lastSeen: '', dateFrom: '', dateTo: '', offlinePreset: '', datetimeFrom: '', datetimeTo: '' };
  ['adv-filter-uptime','adv-filter-lastseen','adv-filter-from','adv-filter-to',
   'adv-filter-preset','adv-filter-dt-from','adv-filter-dt-to'].forEach(id => {
    const el = $(id); if (el) el.value = '';
  });
  document.querySelectorAll('.preset-chip').forEach(c => c.classList.remove('active'));
  const badge = $('adv-filter-badge');
  if (badge) badge.style.display = 'none';
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);
}

function toggleAdvFilter() {
  const panel = $('adv-filter-panel');
  if (!panel) return;
  const open = panel.style.display === 'flex';
  panel.style.display = open ? 'none' : 'flex';
  const btn = $('adv-filter-btn');
  if (btn) btn.classList.toggle('active-filter', !open);
}

function sortDevices(list) {
  return list.slice().sort((a, b) => {
    let va, vb;

    if (sortCol === 'online') {
      // Online first, then offline
      va = a.online ? 0 : 1;
      vb = b.online ? 0 : 1;

    } else if (sortCol === 'uptime') {
      // Parse uptime string to milliseconds for accurate time-based sort
      // e.g. "1h" < "5h" < "10h" < "1d" < "2d"
      va = parseUptimeDuration(a.uptime) ?? -1;
      vb = parseUptimeDuration(b.uptime) ?? -1;

    } else if (sortCol === 'last') {
      // Use pre-resolved timestamp for accurate time-based sort
      // "--" and no-data devices (null _lastTs) always go to bottom regardless of direction
      const tsA = a._lastTs ?? parseRelativeLastSeen(a.last, false) ?? null;
      const tsB = b._lastTs ?? parseRelativeLastSeen(b.last, false) ?? null;
      // Nulls always sink to bottom
      if (tsA === null && tsB === null) return 0;
      if (tsA === null) return 1;
      if (tsB === null) return -1;
      va = tsA; vb = tsB;

    } else if (sortCol === 'name') {
      // Alphabetical — case insensitive
      return sortAsc
        ? (a.name || '').toLowerCase().localeCompare((b.name || '').toLowerCase())
        : (b.name || '').toLowerCase().localeCompare((a.name || '').toLowerCase());

    } else {
      va = a[sortCol] ?? ''; vb = b[sortCol] ?? '';
    }

    if (typeof va === 'string') va = va.toLowerCase();
    if (typeof vb === 'string') vb = vb.toLowerCase();
    return sortAsc ? (va > vb ? 1 : -1) : (va < vb ? 1 : -1);
  });
}

function setSort(col, tableId) {
  if (sortCol === col) sortAsc = !sortAsc; else { sortCol = col; sortAsc = true; }
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);
  updateSortIndicators();
}

function updateSortIndicators() {
  document.querySelectorAll('[data-sort]').forEach(th => {
    const col = th.getAttribute('data-sort');
    const indicator = th.querySelector('.sort-icon');
    if (!indicator) return;
    if (col === sortCol) {
      indicator.textContent = sortAsc ? ' ▲' : ' ▼';
      indicator.style.color = 'var(--primary)';
      th.style.color = 'var(--primary)';
    } else {
      indicator.textContent = ' ⇅';
      indicator.style.color = 'var(--t4)';
      th.style.color = '';
    }
  });
}

function setFilter(f, btn) {
  currentFilter = f;
  document.querySelectorAll('.filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);
}

// Selection UI removed (checkbox column + sel-bar no longer rendered).

// ══════════════════════════════════════════════════════════════
//  DEVICE MODAL — Full History View
// ══════════════════════════════════════════════════════════════
let _modalDeviceId = null;  // track currently open device

function showDevModal(id) {
  const d = allDevices.find(x => x._id === id);
  if (!d) return;
  _modalDeviceId = id;

  // Header
  const av = $('modal-av');
  av.textContent     = d.name.slice(0,2).toUpperCase();
  av.style.background= d.online ? 'var(--green-bg)' : 'var(--red-bg)';
  av.style.color     = d.online ? 'var(--green2)'   : 'var(--red2)';
  setText('modal-name', d.name);
  setText('modal-sub',  d.division + (d.ip !== '—' ? '  ·  ' + d.ip : '') + '  ·  ' + d.model);

  const pill = $('modal-status-pill');
  if (pill) {
    pill.textContent  = d.online ? '🟢 Online' : '🔴 Offline';
    pill.className    = 'status-pill ' + (d.online ? 'pill-on' : 'pill-off');
  }

  setText('modal-last-updated', 'Last updated: ' + new Date().toLocaleTimeString());

  $('modal-exp-btn').onclick = () => exportDeviceReport(d);
  $('modal-ref-btn').onclick = () => {
    closeModal();
    refreshData().then(() => setTimeout(() => showDevModal(id), 400));
  };

  // Open to Overview by default
  switchModalTab('overview');
  renderModalOverview(d);

  $('device-modal').style.display = 'flex';
}

function switchModalTab(tab) {
  ['overview','history','activity','connectivity'].forEach(t => {
    const btn = $('mtab-' + t);
    const cnt = $('mtab-content-' + t);
    if (btn) btn.classList.toggle('active', t === tab);
    if (cnt) {
      cnt.classList.toggle('active', t === tab);
      cnt.style.display = t === tab ? 'flex' : 'none';
    }
  });
  const d = allDevices.find(x => x._id === _modalDeviceId);
  if (!d) return;
  if (tab === 'history')     renderModalHistory(d);
  if (tab === 'activity')    renderModalActivity(d);
  if (tab === 'connectivity') renderModalConnectivity(d);
}

/* ── Overview Tab ── */
function renderModalOverview(d) {
  const hist  = uptimeHistory[d._id] || [];
  const onCnt = hist.filter(h => h.online).length;
  const pct   = hist.length ? Math.round((onCnt / hist.length) * 100) : (d.online ? 100 : 0);
  const totalChecks = hist.length;
  const offCnt = totalChecks - onCnt;

  // Compute first seen & last change
  const firstSeen  = hist.length ? new Date(hist[0].ts).toLocaleString() : '—';
  const lastChange = hist.length ? (() => {
    for (let i = hist.length - 1; i > 0; i--) {
      if (hist[i].online !== hist[i-1].online) return new Date(hist[i].ts).toLocaleTimeString();
    }
    return '—';
  })() : '—';

  $('modal-stats').innerHTML = `
    <div class="mstat"><div class="mstat-v ${d.online?'c-green':'c-red'}">${d.online ? '🟢 Online' : '🔴 Offline'}</div><div class="mstat-l">Current Status</div></div>
    <div class="mstat"><div class="mstat-v">${esc(d.uptime)}</div><div class="mstat-l">${d.online ? 'Uptime' : 'Offline For'}</div></div>
    <div class="mstat"><div class="mstat-v" style="color:var(--primary)">${pct}%</div><div class="mstat-l">Availability</div></div>
    <div class="mstat"><div class="mstat-v mono" style="font-size:12px">${esc(fmtLastSeen(d.last, d._lastTs, d.online))}</div><div class="mstat-l">Last Seen</div></div>
    <div class="mstat"><div class="mstat-v">${totalChecks}</div><div class="mstat-l">Total Checks</div></div>
    <div class="mstat"><div class="mstat-v mono" style="font-size:11px">${esc(lastChange)}</div><div class="mstat-l">Last Change</div></div>
  `;

  setText('modal-avail-pct', pct + '% online this session');
  $('modal-bar').innerHTML = `
    <div class="ubar-on" style="flex:${pct};border-radius:${pct===100?'8px':'8px 0 0 8px'}" title="${pct}% online (${onCnt} checks)"></div>
    <div class="ubar-off" style="flex:${100-pct};border-radius:${pct===0?'8px':'0 8px 8px 0'}" title="${100-pct}% offline (${offCnt} checks)"></div>
  `;

  // Sparkline — render after paint
  setTimeout(() => drawModalSparkline(d, hist), 80);
}

// Segmented timeline bar — replaces canvas sparkline
// Green blocks = online, Red blocks = offline, with duration labels
function drawModalSparkline(d, hist) {
  const bar    = $('modal-status-bar');
  const legend = $('modal-status-legend');
  if (!bar) return;

  if (!hist.length) {
    bar.innerHTML = `<div style="width:100%;display:flex;align-items:center;justify-content:center;padding:14px;font-size:12px;color:var(--t3)">No history yet — accumulates with each sync</div>`;
    if (legend) legend.innerHTML = '';
    return;
  }

  // Build segments from transition history
  const segments = [];
  const now = Date.now();
  for (let i = 0; i < hist.length; i++) {
    const start = hist[i].ts;
    const end   = i < hist.length - 1 ? hist[i + 1].ts : now;
    const ms    = end - start;
    segments.push({ online: hist[i].online, start, end, ms });
  }

  const totalMs = segments.reduce((sum, s) => sum + s.ms, 0);
  if (totalMs <= 0) return;

  // Render segments as flex children with proportional width
  bar.innerHTML = segments.map(s => {
    const pct     = (s.ms / totalMs) * 100;
    const dur     = fmtDuration(s.ms);
    const color   = s.online ? 'var(--green)' : 'var(--red)';
    const bg      = s.online ? 'var(--green-bg)' : 'var(--red-bg)';
    const label   = pct > 8 ? dur : ''; // only show label if segment wide enough
    const title   = `${s.online ? 'Online' : 'Offline'}: ${dur}\n${new Date(s.start).toLocaleTimeString()} → ${new Date(s.end).toLocaleTimeString()}`;
    return `<div title="${title}" style="flex:${pct} 0 0%;min-width:2px;background:${bg};border-right:1px solid var(--surface);display:flex;align-items:center;justify-content:center;overflow:hidden;cursor:default;transition:filter .15s;position:relative"
      onmouseenter="this.style.filter='brightness(.92)'"
      onmouseleave="this.style.filter=''">
      <div style="position:absolute;inset:0;border-left:2px solid ${color};opacity:.6"></div>
      ${label ? `<span style="font-size:10px;font-weight:600;color:${color};white-space:nowrap;padding:0 4px;z-index:1">${label}</span>` : ''}
    </div>`;
  }).join('');

  // Legend: first and last timestamps
  if (legend) {
    const first = new Date(segments[0].start).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const last  = new Date(now).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
    const onMs  = segments.filter(s=>s.online).reduce((t,s)=>t+s.ms,0);
    const pct   = ((onMs/totalMs)*100).toFixed(0);
    legend.innerHTML = `<span>${first}</span><span style="color:var(--primary);font-weight:500">${pct}% online · ${segments.length} segment${segments.length>1?'s':''}</span><span>${last}</span>`;
  }
}

/* ── History Timeline Tab ── */
function renderModalHistory(d) {
  if (!d) d = allDevices.find(x => x._id === _modalDeviceId);
  if (!d) return;
  const hist = uptimeHistory[d._id] || [];
  const fSel = $('hist-filter-sel')?.value || 'all';

  // Build change events from raw history
  const events = [];
  let runStart  = hist.length ? hist[0].ts : null;
  let runState  = hist.length ? hist[0].online : null;

  for (let i = 1; i < hist.length; i++) {
    if (hist[i].online !== hist[i-1].online) {
      // transition: close previous run
      const durMs  = hist[i].ts - runStart;
      const durStr = fmtDuration(durMs);
      events.push({ ts: hist[i-1].ts, endTs: hist[i].ts, online: runState, duration: durStr });
      runStart = hist[i].ts;
      runState = hist[i].online;
    }
  }
  // Close final run
  if (hist.length) {
    const durMs = Date.now() - runStart;
    events.push({ ts: runStart, endTs: Date.now(), online: runState, duration: fmtDuration(durMs) + ' (ongoing)' });
  }
  events.reverse();

  const filtered = fSel === 'all' ? events : events.filter(e => (fSel === 'online') === e.online);
  setText('hist-count-lbl', filtered.length + (filtered.length !== events.length ? ` of ${events.length} events` : ' events'));

  const wrap = $('modal-timeline');
  if (!wrap) return;

  if (!filtered.length && !hist.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:32px;color:var(--t3);font-size:13px">
      No history data yet. History is recorded as the app polls the API.<br>
      <span style="font-size:11px;color:var(--t4)">Data accumulates with each sync cycle.</span>
    </div>`;
    return;
  }
  if (!filtered.length) {
    wrap.innerHTML = `<div style="text-align:center;padding:32px;color:var(--t3);font-size:13px">No events match the current filter.</div>`;
    return;
  }

  wrap.innerHTML = filtered.map((e, idx) => {
    const ts   = new Date(e.ts).toLocaleString();
    const icon = e.online ? '🟢' : '🔴';
    const lbl  = e.online ? 'Came Online' : 'Went Offline';
    const cls  = e.online ? 'tl-on' : 'tl-off';
    const dotColor = e.online ? 'var(--green)' : 'var(--red)';
    return `<div class="tl-item">
      <div class="tl-line-wrap">
        <div class="tl-dot" style="color:${dotColor};background:${dotColor}"></div>
        ${idx < filtered.length - 1 ? '<div class="tl-line"></div>' : ''}
      </div>
      <div class="tl-body">
        <div class="tl-card ${cls}">
          <div class="tl-event">${icon} ${lbl}</div>
          <div class="tl-meta">${ts}</div>
          <div class="tl-duration">⏱ ${e.duration}</div>
        </div>
      </div>
    </div>`;
  }).join('');
}

/* ── Activity Logs Tab ── */
function renderModalActivity(d) {
  if (!d) d = allDevices.find(x => x._id === _modalDeviceId);
  if (!d) return;
  const search = ($('modal-act-search')?.value || '').toLowerCase().trim();

  // Filter global activity log for events mentioning this device
  const entries = activityLog.filter(e =>
    e.msg.toLowerCase().includes(d.name.toLowerCase()) &&
    (!search || e.msg.toLowerCase().includes(search))
  );

  const el = $('modal-activity-list');
  if (!el) return;
  if (!entries.length) {
    el.innerHTML = `<div style="text-align:center;padding:28px;color:var(--t3);font-size:13px">No activity recorded for this device yet.</div>`;
    return;
  }
  el.innerHTML = entries.map(e => {
    const col = e.type==='ok'?'var(--green)':e.type==='err'?'var(--red)':e.type==='warn'?'var(--amber)':'var(--t4)';
    const cls = e.type==='ok'?'apt-ok':e.type==='err'?'apt-err':e.type==='warn'?'apt-warn':'apt-info';
    return `<div class="ap-item" style="margin-bottom:5px">
      <div class="ap-dot" style="background:${col}"></div>
      <div class="ap-time">${new Date(e.ts).toLocaleTimeString()}</div>
      <div class="ap-msg" style="flex:1">${esc(e.msg)}</div>
      <span class="ap-type ${cls}">${e.type}</span>
    </div>`;
  }).join('');
}

/* ── Connectivity Tab ── */
function renderModalConnectivity(d) {
  if (!d) d = allDevices.find(x => x._id === _modalDeviceId);
  if (!d) return;
  const fields = [
    ['IP Address',   d.ip],
    ['MAC Address',  d.mac],
    ['Division',     d.division],
    ['Model / Type', d.model],
    ['Firmware',     d.version],
    ['Device ID',    d._id],
    ['Uptime',       d.uptime],
    ['Last Seen',    fmtLastSeen(d.last, d._lastTs, d.online)],
  ];
  const el = $('modal-connectivity');
  if (!el) return;
  el.innerHTML = fields.map(([lbl,val]) => `
    <div class="conn-field">
      <div class="conn-field-lbl">${lbl}</div>
      <div class="conn-field-val">${esc(val) || '—'}</div>
    </div>`).join('');
}

function closeModal() {
  // If a background sync was deferred while modal was open, apply it now
  if (window._pendingSync) {
    window._pendingSync = false;
    setTimeout(() => syncAllModules(), 100);
  }
  $('device-modal').style.display = 'none';
  _modalDeviceId = null;
}

/* Duration helper */
function fmtDuration(ms) {
  if (ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  if (s < 60)   return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60)   return m + 'm ' + (s % 60) + 's';
  const h = Math.floor(m / 60);
  return h + 'h ' + (m % 60) + 'm';
}

// ─── Compute total cumulative uptime from history ─────────────
// Returns { pct, dur, offlineDur, transitions, trackedSince, tooltip }
// Returns null if no history yet (< 2 entries) — caller shows "—"
// Uses ONLY transition-based history (Option B) — no uptime column data
function computeTotalUptime(deviceId) {
  const hist = uptimeHistory[deviceId] || [];
  if (hist.length < 1) return null;

  let totalMs   = 0;
  let onlineMs  = 0;
  let offlineMs = 0;

  // Sum spans between each consecutive transition entry
  for (let i = 0; i < hist.length - 1; i++) {
    const spanMs = hist[i + 1].ts - hist[i].ts;
    totalMs += spanMs;
    if (hist[i].online) onlineMs  += spanMs;
    else                offlineMs += spanMs;
  }

  // Add current ongoing run (from last entry to now)
  const ongoingMs = Date.now() - hist[hist.length - 1].ts;
  totalMs += ongoingMs;
  if (hist[hist.length - 1].online) onlineMs  += ongoingMs;
  else                               offlineMs += ongoingMs;

  if (totalMs <= 0) return null;

  const pctNum    = (onlineMs / totalMs) * 100;
  const pct       = pctNum.toFixed(1) + '%';
  const dur       = fmtDuration(onlineMs);
  const offlineDur= fmtDuration(offlineMs);
  const transitions = hist.length - 1;
  const trackedSince= new Date(hist[0].ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  // Tooltip breakdown shown on hover
  const tooltip = `Online: ${dur} | Offline: ${offlineDur} | Transitions: ${transitions} | Tracked since: ${trackedSince}`;

  return { pct, dur, offlineDur, transitions, trackedSince, tooltip };
}

// ══════════════════════════════════════════════════════════════
//  DIVISION EXPLORE MODAL
// ══════════════════════════════════════════════════════════════
function openDivExplore(dv) {
  const devs = divisionMap[dv] || [];
  const on   = devs.filter(d => d.online).length;
  const off  = devs.length - on;
  const pct  = devs.length ? ((on / devs.length) * 100).toFixed(1) : '0.0';

  setText('dem-name',   dv);
  setText('dem-sub',    `${devs.length} device${devs.length===1?'':'s'} · ${pct}% health`);
  setText('dem-total',  devs.length);
  setText('dem-online', on);
  setText('dem-offline',off);
  setText('dem-pct',    pct + '%');

  demFilter = 'all';
  renderDemList();

  $('div-explore-modal').style.display = 'flex';
}

function renderDemList() {
  const tbody  = $('dem-tbody');
  const dv     = $('dem-name')?.textContent || '';
  const devs   = divisionMap[dv] || [];
  const search = ($('dem-search')?.value || '').toLowerCase().trim();

  let list = devs.filter(d => {
    if (demFilter === 'online'  && !d.online)  return false;
    if (demFilter === 'offline' &&  d.online)  return false;
    if (search && !d.name.toLowerCase().includes(search)) return false;
    return true;
  });
  list.sort((a,b) => { if(a.online!==b.online) return a.online?-1:1; return a.name.localeCompare(b.name); });

  if (!list.length) { tbody.innerHTML = `<tr><td colspan="5" class="empty-row">No devices match.</td></tr>`; return; }
  tbody.innerHTML = list.map(d => `
    <tr style="cursor:pointer;border-bottom:1px solid var(--border);transition:background .1s" onmouseover="this.style.background='var(--surface2)'" onmouseout="this.style.background=''" onclick="closeDivExplore();showDevModal('${esc(d._id)}')">
      <td style="padding:9px 16px">
        <div style="display:flex;align-items:center;gap:8px">
          <div style="width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:${d.online?'var(--green-bg)':'var(--red-bg)'};color:${d.online?'var(--green2)':'var(--red2)'}">
            ${d.name.charAt(0).toUpperCase()}
          </div>
          <span style="font-weight:600;color:var(--t1);font-size:13px">${esc(d.name)}</span>
        </div>
      </td>
      <td style="padding:9px 16px"><span class="status-pill ${d.online?'pill-on':'pill-off'}">${d.online?'🟢 Online':'🔴 Offline'}</span></td>
      <td style="padding:9px 16px;font-family:var(--fm);font-size:12px;color:var(--t2)">${esc(d.uptime)}</td>
      <td style="padding:9px 16px;font-family:var(--fm);font-size:11.5px;color:var(--t3)" title="${esc(d.last !== '—' ? d.last : '')}">${esc(fmtLastSeen(d.last, d._lastTs, d.online))}</td>
      <td style="padding:9px 16px"><button class="btn btn-outline btn-xs" onclick="event.stopPropagation();showDevModal('${esc(d._id)}')">Detail</button></td>
    </tr>`).join('');
}

function filterDemDevices(f, btn) {
  demFilter = f;
  document.querySelectorAll('#div-explore-modal .filter-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderDemList();
}
function closeDivExplore() { $('div-explore-modal').style.display = 'none'; }

// ══════════════════════════════════════════════════════════════
//  DIVISIONS PAGE
// ══════════════════════════════════════════════════════════════
function updateDivSummaryBar() {
  const bar = $('div-summary-bar');
  if (!bar) return;
  const total = allDevices.length;
  const on    = allDevices.filter(d => d.online).length;
  const divs  = Object.keys(divisionMap).length;
  const pct   = total ? ((on/total)*100).toFixed(1) : '0.0';
  bar.innerHTML = `
    <div class="dsb-card"><span class="dsb-icon">📂</span><div><div class="dsb-val">${divs}</div><div class="dsb-lbl">Divisions</div></div></div>
    <div class="dsb-card"><span class="dsb-icon">🖥️</span><div><div class="dsb-val">${total}</div><div class="dsb-lbl">Total Devices</div></div></div>
    <div class="dsb-card"><span class="dsb-icon" style="color:var(--green)">✅</span><div><div class="dsb-val" style="color:var(--green)">${on}</div><div class="dsb-lbl">Online</div></div></div>
    <div class="dsb-card"><span class="dsb-icon" style="color:var(--red)">🔴</span><div><div class="dsb-val" style="color:var(--red)">${total-on}</div><div class="dsb-lbl">Offline</div></div></div>
    <div class="dsb-card"><span class="dsb-icon" style="color:var(--purple)">💚</span><div><div class="dsb-val" style="color:var(--purple)">${pct}%</div><div class="dsb-lbl">Fleet Health</div></div></div>
  `;
}

function renderDivisionsList() {
  const grid   = $('divisions-list');
  const search = ($('div-search')?.value || '').toLowerCase().trim();
  if (!grid) return;

  let entries = Object.entries(divisionMap);
  if (search) entries = entries.filter(([name]) => name.toLowerCase().includes(search));
  entries.sort((a, b) => a[0].localeCompare(b[0]));

  setText('div-total-count', entries.length);
  if (!entries.length) { grid.innerHTML = '<div class="div-empty-state">No divisions found</div>'; return; }

  grid.innerHTML = entries.map(([dv, devs]) => {
    const on  = devs.filter(d => d.online).length;
    const off = devs.length - on;
    const pct = devs.length ? Math.round((on / devs.length) * 100) : 0;
    const tier     = pct >= 80 ? 'good' : pct >= 50 ? 'warn' : 'crit';
    const label    = pct >= 80 ? '✅ Healthy' : pct >= 50 ? '⚠️ Warning' : '🔴 Critical';
    const fillCls  = pct >= 80 ? 'f-good'    : pct >= 50 ? 'f-warn'    : 'f-crit';

    const CHIP_MAX   = 5;
    const sorted     = [...devs].sort((a,b) => { if(a.online!==b.online) return b.online?1:-1; return (a.name||'').localeCompare(b.name||''); });
    const chips      = sorted.slice(0, CHIP_MAX).map(d =>
      `<span class="dev-tag ${d.online?'dt-on':'dt-off'}" onclick="event.stopPropagation();showDevModal('${esc(d._id)}')" title="${esc(d.name)}">${esc(d.name)}</span>`
    ).join('');
    const hidden     = Math.max(0, devs.length - CHIP_MAX);
    const exploreLabel = hidden > 0
      ? `🔍 +${hidden} more — Explore all ${devs.length} device${devs.length===1?'':'s'}`
      : `🔍 Explore all ${devs.length} device${devs.length===1?'':'s'}`;

    return `<div class="div-mod-card dmc-${tier}">
      <div class="dmc-head">
        <div class="dmc-name">${esc(dv)}</div>
        <span class="dmc-badge b-${tier}">${label}</span>
      </div>
      <div class="dmc-stats">
        <div class="dmc-stat"><div class="dmc-stat-v">${devs.length}</div><div class="dmc-stat-l">Total</div></div>
        <div class="dmc-stat s-on"><div class="dmc-stat-v">${on}</div><div class="dmc-stat-l">Online</div></div>
        <div class="dmc-stat s-off"><div class="dmc-stat-v">${off}</div><div class="dmc-stat-l">Offline</div></div>
      </div>
      <div class="dmc-bar-wrap">
        <div class="dmc-bar-track"><div class="dmc-bar-fill ${fillCls}" style="width:${pct}%"></div></div>
        <div class="dmc-pct-row"><span>0%</span><span style="font-weight:600;color:var(--t1)">${pct}%</span><span>100%</span></div>
      </div>
      <div class="dmc-devs">${chips}</div>
      <div class="dmc-footer">
        <button class="dmc-explore-btn" onclick="openDivExplore('${esc(dv)}')">${exploreLabel}</button>
      </div>
    </div>`;
  }).join('');
}

function populateAssignSelects() {} // placeholder for future override UI

// ══════════════════════════════════════════════════════════════
//  ACTIVITY LOG
// ══════════════════════════════════════════════════════════════
function logEvent(msg, type = 'info') {
  const entry = { ts: Date.now(), msg, type };
  activityLog.unshift(entry);
  if (activityLog.length > 2000) activityLog.length = 2000;
  updateActBadge();
  if (document.getElementById('page-activity').classList.contains('active')) renderActPage();
}

function updateActBadge() {
  const n = activityLog.length;
  setText('act-count', n);
  setText('act-page-cnt', n + ' events');
}

function renderActPanel() {
  const el   = $('act-list');
  if (!el) return;
  const srch = ($('act-search')?.value || '').toLowerCase().trim();
  const list = activityLog.filter(e => !srch || e.msg.toLowerCase().includes(srch)).slice(0, 30);
  if (!list.length) { el.innerHTML = '<div class="af-empty">No events yet.</div>'; return; }
  el.innerHTML = list.map(e => {
    const col = e.type==='ok'?'var(--green)':e.type==='err'?'var(--red)':e.type==='warn'?'var(--amber)':'var(--t4)';
    return `<div class="af-row">
      <div class="af-dot" style="background:${col}"></div>
      <div class="af-content">
        <div class="af-msg">${esc(e.msg)}</div>
        <div class="af-time">${new Date(e.ts).toLocaleTimeString()}</div>
      </div>
    </div>`;
  }).join('');
}

function setActF(f, btn) {
  actFilter = f;
  document.querySelectorAll('.af-btn').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  renderActPage();
}

function renderActPage() {
  const el   = $('act-page-list');
  if (!el) return;
  const srch = ($('act-page-s')?.value || '').toLowerCase().trim();
  const list = activityLog.filter(e => {
    if (actFilter !== 'all' && e.type !== actFilter) return false;
    if (srch && !e.msg.toLowerCase().includes(srch)) return false;
    return true;
  });
  if (!list.length) { el.innerHTML = '<div style="text-align:center;color:var(--t3);padding:32px;font-size:13px">No matching events.</div>'; return; }
  el.innerHTML = list.map(e => {
    const col = e.type==='ok'?'var(--green)':e.type==='err'?'var(--red)':e.type==='warn'?'var(--amber)':'var(--t4)';
    const cls = e.type==='ok'?'apt-ok':e.type==='err'?'apt-err':e.type==='warn'?'apt-warn':'apt-info';
    return `<div class="ap-item">
      <div class="ap-dot" style="background:${col}"></div>
      <div class="ap-time">${new Date(e.ts).toLocaleTimeString()}</div>
      <div class="ap-msg">${esc(e.msg)}</div>
      <span class="ap-type ${cls}">${e.type}</span>
    </div>`;
  }).join('');
}

function toggleActPanel() {
  actPanelOpen = !actPanelOpen;
  const el = $('act-list');
  if (el) el.style.display = actPanelOpen ? '' : 'none';
  const btn = $('act-toggle-btn');
  if (btn) btn.textContent = actPanelOpen ? '▲' : '▼';
}

async function downloadLog() {
  const text = activityLog.map(e => `[${new Date(e.ts).toISOString()}] [${e.type.toUpperCase()}] ${e.msg}`).join('\n');
  const r    = await ipcRenderer.invoke('save-file', { data: text, filename: `PiCommand-v18-log-${dateStamp()}.txt`, type: 'txt', encoding: 'utf8' });
  if (r.success) showToast('✅ Log downloaded'); else showToast('⚠️ Download cancelled');
}

async function clearLog() {
  if (!confirm('Clear all activity log entries?')) return;
  activityLog = [];
  updateActBadge();
  renderActPage();
  renderActPanel();
  await savePersisted('activityLog', []);
  showToast('Log cleared');
}

// ══════════════════════════════════════════════════════════════
//  NAV COUNTERS
// ══════════════════════════════════════════════════════════════
function updateNavCounters() {
  const divs = Object.keys(divisionMap).length;
  const divBadge = $('div-badge');
  if (divBadge) {
    divBadge.textContent = divs;
    divBadge.classList.toggle('show', divs > 0);
  }
}

// ══════════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ══════════════════════════════════════════════════════════════
async function notifyOS(title, body, enabled=true) {
  if (!enabled || !settings.notifOS) return;
  try { await ipcRenderer.invoke('show-notification', { title, body, silent: settings.notifSilent }); } catch {}
}
function addNotif() {
  notifCount++;
  const badge = $('notif-badge');
  if (badge) { badge.textContent = notifCount > 9 ? '9+' : notifCount; badge.classList.add('show'); }
}
function clearNotifs() {
  notifCount = 0;
  const badge = $('notif-badge');
  if (badge) badge.classList.remove('show');
}

// ══════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════
//  EXPORTS
// ══════════════════════════════════════════════════════════════
async function exportXLSX() {
  showToast('⏳ Generating XLSX…');
  const on  = allDevices.filter(d => d.online);
  const off = allDevices.filter(d => !d.online);
  const divs= Object.keys(divisionMap);
  const divDevs = {};
  divs.forEach(dv => divDevs[dv] = divisionMap[dv]);
  try {
    const r = await ipcRenderer.invoke('generate-xlsx', { onlineDevices:on, offlineDevices:off, divisions:divs, divisionDevices:divDevs });
    if (!r.success) { showToast('❌ XLSX failed: ' + r.reason); return; }
    const saveR = await ipcRenderer.invoke('save-file', { data: r.data, filename: `PiCommand-v18-Fleet-${dateStamp()}.xlsx`, type: 'xlsx', encoding: 'base64' });
    if (saveR.success) { showToast('✅ XLSX saved!'); logEvent('XLSX exported', 'ok'); }
    else showToast('Cancelled');
  } catch(e) { showToast('❌ ' + e.message); }
}

async function exportCSV() {
  const hdr  = 'Name,Division,Status,Uptime,Last Seen,IP\n';
  const rows = allDevices.map(d =>
    [d.name, d.division, d.online?'Online':'Offline', d.uptime, fmtLastSeen(d.last, d._lastTs, d.online), d.ip]
      .map(v => `"${String(v).replace(/"/g,'""')}"`)
      .join(',')
  ).join('\n');
  const r = await ipcRenderer.invoke('save-file', { data: hdr+rows, filename:`PiCommand-v18-Fleet-${dateStamp()}.csv`, type:'csv', encoding:'utf8' });
  if (r.success) { showToast('✅ CSV saved!'); logEvent('CSV exported','ok'); }
  else showToast('Cancelled');
}

async function exportDeviceReport(d) {
  const hist = uptimeHistory[d._id] || [];
  const pct  = hist.length ? Math.round((hist.filter(h=>h.online).length/hist.length)*100) : (d.online?100:0);
  const lines = [
    `Reachout Command Center v2.0 — Device Report`,
    `Generated: ${new Date().toLocaleString()}`,
    ``,
    `Name:      ${d.name}`,
    `Division:  ${d.division}`,
    `Status:    ${d.online?'Online':'Offline'}`,
    `Uptime:    ${d.uptime}`,
    `Last Seen: ${fmtLastSeen(d.last, d._lastTs, d.online)}`,
    `IP:        ${d.ip}`,
    `MAC:       ${d.mac}`,
    `Version:   ${d.version}`,
    `Model:     ${d.model}`,
    `Availability: ${pct}% (${hist.length} data points this session)`,
  ].join('\n');
  const r = await ipcRenderer.invoke('save-file', { data:lines, filename:`Device-${d.name.replace(/\s+/g,'-')}.txt`, type:'txt', encoding:'utf8' });
  if (r.success) showToast('✅ Device report saved'); else showToast('Cancelled');
}

async function exportSelectedDivisionsXLSX() { await exportXLSX(); }
async function drawSparkline(id, data, color) {
  const canvas = $(id);
  if (!canvas || !data.length) return;
  const ctx = canvas.getContext('2d');
  const W = canvas.offsetWidth || 200;
  const H = canvas.offsetHeight || 40;
  canvas.width = W; canvas.height = H;
  ctx.clearRect(0,0,W,H);
  const max  = Math.max(...data, 1);
  const step = W / Math.max(data.length - 1, 1);
  ctx.beginPath();
  data.forEach((v,i) => { const x=i*step, y=H-(v/max)*(H-4)-2; i?ctx.lineTo(x,y):ctx.moveTo(x,y); });
  ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke();
  ctx.lineTo((data.length-1)*step, H); ctx.lineTo(0,H); ctx.closePath();
  const g = ctx.createLinearGradient(0,0,0,H);
  g.addColorStop(0, color+'44'); g.addColorStop(1, color+'00');
  ctx.fillStyle = g; ctx.fill();
}

// ══════════════════════════════════════════════════════════════
//  PROGRESS BAR
// ══════════════════════════════════════════════════════════════
function showProg(pct) {
  const b = $('progress-bar');
  if (!b) return;
  b.classList.add('on');
  b.style.transform = `scaleX(${pct})`;
}
function hideProg() {
  const b = $('progress-bar');
  if (!b) return;
  b.style.transform = 'scaleX(1)';
  setTimeout(() => { b.classList.remove('on'); b.style.transform = 'scaleX(0)'; }, 350);
}

// ══════════════════════════════════════════════════════════════
//  SYNC STATUS
// ══════════════════════════════════════════════════════════════
function setSyncStatus(state, msg) {
  const dot = $('sync-dot'); const lbl = $('sync-lbl');
  if (!dot || !lbl) return;
  if (state === 'ok')    { dot.className='sync-dot';       lbl.textContent=msg||'Synced'; }
  else if (state==='error') { dot.className='sync-dot error'; lbl.textContent=msg||'Error'; }
  else                   { dot.className='sync-dot syncing'; lbl.textContent='Syncing…'; }
}

// ══════════════════════════════════════════════════════════════
//  NAVIGATION
// ══════════════════════════════════════════════════════════════
// In-app navigation history — lets the Android hardware back button return to
// the previous screen/module instead of falling through to WebView history
// (which would land on the login page). See the backButton listener below.
let _navStack = [];

function _renderPage(page) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
  const pg = document.getElementById('page-' + page);
  const nv = document.getElementById('nav-' + page);
  if (pg) pg.classList.add('active');
  if (nv) nv.classList.add('active');
  document.querySelector('.page-wrap')?.scrollTo(0,0);
  if (page==='activity') { renderActPage(); }
  if (page==='dashboard') { updateInsightWidgets(); }
}

function navTo(page) {
  const current = document.querySelector('.page.active')?.id?.replace('page-', '');
  if (current && current !== page) _navStack.push(current);
  _renderPage(page);
}

// Used by the hardware back button — goes to the previous screen WITHOUT
// pushing a new forward-history entry.
function navBackInApp() {
  const prev = _navStack.pop() || 'dashboard';
  _renderPage(prev);
}

// ─── Dashboard card navigation helpers ─────────────────────────
function navToFilteredDevices(filter, division) {
  currentFilter = filter || 'all';
  divFilter     = division || 'all';
  // Reset buttons in all filter bars
  document.querySelectorAll('.filter-btn[data-sf]').forEach(b => {
    b.classList.toggle('active', b.getAttribute('data-sf') === currentFilter);
  });
  navTo('devices');
  // Highlight division tag if applicable
  if (division && division !== 'all') {
    setTimeout(() => {
      document.querySelectorAll('.div-filter-btn').forEach(b => {
        b.classList.toggle('active', b.textContent === division);
      });
    }, 50);
  }
  clearAdvFilter();
}

function navToMostAffected() {
  // Find division with most offline devices
  const entries = Object.entries(divisionMap)
    .map(([name, devs]) => ({ name, off: devs.filter(d => !d.online).length }))
    .filter(e => e.off > 0)
    .sort((a, b) => b.off - a.off);
  const top = entries[0];
  navToFilteredDevices('offline', top ? top.name : 'all');
}

// ══════════════════════════════════════════════════════════════
//  SIDEBAR COLLAPSE
// ══════════════════════════════════════════════════════════════
function toggleSidebar() {
  sidebarCollapsed = !sidebarCollapsed;
  const sb = $('sidebar');
  if (sb) sb.classList.toggle('collapsed', sidebarCollapsed);
}

// ══════════════════════════════════════════════════════════════
//  DARK MODE
// ══════════════════════════════════════════════════════════════
function toggleDark() {
  darkMode = !darkMode;
  document.body.classList.toggle('dm', darkMode);
  savePersisted('darkMode', darkMode);
}

// ══════════════════════════════════════════════════════════════
//  SEARCH
// ══════════════════════════════════════════════════════════════
// Debounced table render — 300ms delay
const _debouncedRender = debounce(() => {
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);
}, 300);

// ── Universal search dropdown ──────────────────────────────────
let _searchDropdownIdx = -1;

function onSearchInput() {
  const v = ($('global-search')?.value || '').trim();
  const c = $('s-clear');
  if (c) c.classList.toggle('show', v.length > 0);
  if (v.length < 2) { hideSearchDropdown(); _debouncedRender(); return; }
  showSearchDropdown(v);
  _debouncedRender();
}

function showSearchDropdown(q) {
  const dd = $('search-dropdown');
  if (!dd) return;
  const ql = q.toLowerCase();
  const matches = allDevices.filter(d =>
    d.name.toLowerCase().includes(ql) ||
    d.division.toLowerCase().includes(ql)
  ).slice(0, 10);

  if (!matches.length) {
    dd.innerHTML = `<div class="sd-empty">No devices found for "<strong>${esc(q)}</strong>"</div>`;
    dd.classList.add('show');
    return;
  }
  const items = matches.map((d, i) =>
    `<div class="sd-item" data-idx="${i}" data-id="${esc(d._id)}"
       onmousedown="selectSearchResult('${esc(d._id)}','${esc(d.name)}')">
      <div class="sd-av ${d.online?'on':'off'}">${esc(d.name.slice(0,2).toUpperCase())}</div>
      <div>
        <div class="sd-name">${esc(d.name)}</div>
        <div class="sd-meta">${esc(d.division)}</div>
      </div>
      <span class="sd-status ${d.online?'on':'off'}">${d.online?'Online':'Offline'}</span>
    </div>`
  ).join('');
  const footer = matches.length >= 10
    ? `<div class="sd-footer" onmousedown="applySearchFilter()">See all results for "<strong>${esc(q)}</strong>"</div>`
    : `<div class="sd-footer" onmousedown="applySearchFilter()">Show ${matches.length} result${matches.length>1?'s':''} in device list</div>`;
  dd.innerHTML = items + footer;
  dd.classList.add('show');
  _searchDropdownIdx = -1;
}

function hideSearchDropdown() {
  const dd = $('search-dropdown');
  if (dd) dd.classList.remove('show');
  _searchDropdownIdx = -1;
}

function selectSearchResult(id, name) {
  hideSearchDropdown();
  const inp = $('global-search');
  if (inp) inp.value = name;
  const c = $('s-clear');
  if (c) c.classList.add('show');
  navTo('devices');
  setTimeout(() => {
    renderDeviceTable('device-tbody',  true);
    renderDeviceTable('device-tbody2', false);
    // Highlight and scroll to device
    const row = document.querySelector(`tr[data-id="${CSS.escape(id)}"]`);
    if (row) {
      row.style.background = 'var(--primary-bg)';
      row.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => { row.style.background = ''; }, 2000);
    }
  }, 100);
}

function applySearchFilter() {
  hideSearchDropdown();
  navTo('devices');
  setTimeout(() => {
    renderDeviceTable('device-tbody',  true);
    renderDeviceTable('device-tbody2', false);
  }, 100);
}

function onSearchKeydown(e) {
  const dd = $('search-dropdown');
  if (!dd?.classList.contains('show')) return;
  const items = dd.querySelectorAll('.sd-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    _searchDropdownIdx = Math.min(_searchDropdownIdx + 1, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('focused', i === _searchDropdownIdx));
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    _searchDropdownIdx = Math.max(_searchDropdownIdx - 1, 0);
    items.forEach((el, i) => el.classList.toggle('focused', i === _searchDropdownIdx));
  } else if (e.key === 'Enter' && _searchDropdownIdx >= 0) {
    e.preventDefault();
    items[_searchDropdownIdx]?.dispatchEvent(new MouseEvent('mousedown'));
  } else if (e.key === 'Escape') {
    hideSearchDropdown();
  }
}

// Close dropdown on outside click
document.addEventListener('click', e => {
  if (!$('global-search')?.closest('.tb-search')?.contains(e.target)) {
    hideSearchDropdown();
  }
});

function onSearch() { onSearchInput(); } // legacy compat

function clearSearch() {
  const inp = $('global-search');
  if (inp) inp.value = '';
  const c = $('s-clear');
  if (c) c.classList.remove('show');
  hideSearchDropdown();
  renderDeviceTable('device-tbody',  true);
  renderDeviceTable('device-tbody2', false);
}

// ══════════════════════════════════════════════════════════════
//  USER MENU
// ══════════════════════════════════════════════════════════════
function toggleUserMenu() { $('user-menu')?.classList.toggle('show'); }
function closeUserMenu()   { $('user-menu')?.classList.remove('show'); }
// Keyboard shortcut: Ctrl+Shift+R = full app reload
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    reloadApp();
  }
});

document.addEventListener('click', e => {
  if (!$('user-wrap')?.contains(e.target)) closeUserMenu();
});

// ══════════════════════════════════════════════════════════════
//  AUTH / LOGOUT
// ══════════════════════════════════════════════════════════════
// ── App Reload ──────────────────────────────────────────────────────
async function reloadApp() {
  showToast('🔄 Reloading application…');
  await new Promise(r => setTimeout(r, 600));
  await ipcRenderer.invoke('app-reload');
}

async function logout() {
  if (!confirm('Sign out? This will clear session data.')) return;
  await ipcRenderer.invoke('set-perm', 'session', null);
  await ipcRenderer.invoke('clear-remembered-login'); // also clears any "Remember Me" auto-login
  logEvent('User signed out', 'warn');
  showToast('Signed out');
  setTimeout(() => { window.location.href = 'index.html'; }, 500);
}
async function resetAll() {
  if (!confirm('Reset ALL data? This cannot be undone.')) return;
  await ipcRenderer.invoke('set-perm-batch', {
    activityLog:null, uptimeHistory:null, pollHistory:null,
    sparkHistory:null, divOverrides:null, settings:null
  });
  activityLog=[]; uptimeHistory={}; pollHistory=[]; sparkHistory={online:[],offline:[],health:[]};
  divOverrides={}; settings={};
  showToast('All data reset');
  await refreshData();
}

// ══════════════════════════════════════════════════════════════
//  ANIMATION HELPERS
// ══════════════════════════════════════════════════════════════
function animateCount(id, target) {
  const el = $(id);
  if (!el) return;
  const start = parseInt(el.textContent) || 0;
  if (start === target) return;
  const dur  = 400;
  const t0   = performance.now();
  const tick = now => {
    const p = Math.min((now - t0) / dur, 1);
    el.textContent = Math.round(start + (target - start) * p);
    if (p < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

// ══════════════════════════════════════════════════════════════
//  TOAST
// ══════════════════════════════════════════════════════════════
let _toastT;
function showToast(msg, dur=3000) {
  const el = $('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastT);
  _toastT = setTimeout(() => el.classList.remove('show'), dur);
}

// ══════════════════════════════════════════════════════════════
//  UTILS
// ══════════════════════════════════════════════════════════════
function $(id)         { return document.getElementById(id); }

// ── Loading screen ─────────────────────────────────────────
function setLoadingStatus(msg, pct) {
  const s = $('lo-status'); if (s) s.textContent = msg;
  const b = $('lo-bar');    if (b && pct != null) b.style.width = pct + '%';
}
function hideLoadingScreen() {
  const ov = $('loading-overlay');
  if (!ov || ov.classList.contains('hide')) return;
  ov.classList.add('hide');
  setTimeout(() => { if (ov.parentNode) ov.parentNode.removeChild(ov); }, 450);
}

// Debounce — prevents search firing on every keystroke for 910 devices
function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// Row data hash — only re-render rows when meaningful data changes
// Deliberately excludes uptime (changes every sync) to avoid full rebuild
function rowHash(d) {
  const tu = (typeof computeTotalUptime === 'function') ? (computeTotalUptime(d._id)?.pct || '') : '';
  return d.online + '|' + d.last + '|' + d.division + '|' + tu;
}
function setText(id,v) { const el=$(id); if(el) el.textContent=v; }
function setVal(id,v)  { const el=$(id); if(el) el.value=v; }
function getVal(id)    { return $(id)?.value??''; }
function setCheck(id,v){ const el=$(id); if(el) el.checked=!!v; }
function getCheck(id)  { return !!($(id)?.checked); }
function esc(v)        { return String(v??'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
function str(v)        { return v==null?'—':String(v); }
function dateStamp()   { return new Date().toISOString().slice(0,10); }
