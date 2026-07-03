(async function() {
  const out = { html: '', state: null, devices: null, headers: null, apiSource: null, log: [] };

  // ── Helpers ─────────────────────────────────────────────────────
  function log(msg) { out.log.push(msg); console.log('[PCC-Extract] ' + msg); }

  // Detect if an array looks like device data (has name + status fields)
  function isDeviceArray(arr) {
    if (!Array.isArray(arr) || arr.length === 0) return false;
    const first = arr[0];
    if (!first || typeof first !== 'object') return false;
    const keys = Object.keys(first).map(k => k.toLowerCase());
    return keys.some(k => /^(name|device|device_name|hostname)$/.test(k)) &&
           keys.some(k => /^(status|state|online|is_online|active|offline)$/.test(k));
  }

  // Recursively search an object for a device array (depth-limited)
  function findDeviceArray(obj, depth) {
    if (depth <= 0 || !obj || typeof obj !== 'object') return null;
    if (isDeviceArray(obj)) return obj;
    for (const key of Object.keys(obj)) {
      try {
        const found = findDeviceArray(obj[key], depth - 1);
        if (found) return found;
      } catch {}
    }
    return null;
  }

  // Normalise a raw device object from API into our standard shape
  function normaliseApiDevice(d, idx) {
    const name = d.name || d.device_name || d.deviceName || d.hostname || d.title || '';
    if (!name) return null;
    const div  = d.division || d.zone || d.group || d.area || d.region || d.category || '—';
    // Status: try boolean online first, then string status
    let online = false;
    if (typeof d.online === 'boolean')     online = d.online;
    else if (typeof d.is_online === 'boolean') online = d.is_online;
    else if (typeof d.active === 'boolean')    online = d.active;
    else {
      const st = String(d.status || d.state || '').toLowerCase();
      online = /online|active|\bup\b|running|connected/.test(st);
    }
    // last_seen_str is the exact field from /status_data API
    const lastSeen =
      d.last_seen_str || d.last_seen || d.lastSeen || d.last_active || d.lastActive ||
      d.last_online  || d.lastOnline  || d.last_ping    || d.lastPing    ||
      d.last_contact || d.lastContact || d.offline_since|| d.offlineSince||
      d.updated_at   || d.updatedAt   || d.seen_at      || d.seenAt      ||
      d.disconnected_at || d.checkin  || d.last_report  ||
      '—';
    return {
      name: String(name).trim(),
      division: String(div).trim(),
      online,
      uptime: String(d.uptime || d.uptime_today || d.up_time || d.uptimeStr || '—').trim(),
      last:   String(lastSeen).trim(),
      ip:     String(d.ip || d.ip_address || d.ipAddress || '—').trim(),
    };
  }

  // ── STRATEGY 1: Same-origin fetch() — direct API call ───────────
  // Most reliable — gets full JSON before SPA rendering
  log('Trying direct API fetch...');
  const apiPaths = [
    '/api/devices',       '/api/v1/devices',    '/api/monitor/devices',
    '/api/device/list',   '/api/status',        '/api/monitor',
    '/admin/devices.json','/admin/api/devices',  '/devices.json',
    '/api/dashboard',     '/api/v1/monitor',    '/monitor/devices',
  ];
  for (const path of apiPaths) {
    try {
      const r = await fetch(path, {
        headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
        credentials: 'same-origin'
      });
      if (!r.ok) continue;
      const ct = r.headers.get('content-type') || '';
      if (!ct.includes('json')) continue;
      const data = await r.json();
      // Try common wrapper shapes
      const candidates = [data, data.data, data.devices, data.device_list,
        data.deviceList, data.items, data.records, data.result, data.results,
        data.payload, data.response, data.monitors, data.list];
      for (const c of candidates) {
        if (isDeviceArray(c)) {
          const devs = c.map(normaliseApiDevice).filter(Boolean);
          if (devs.length > 0) {
            out.devices   = devs;
            out.apiSource = 'fetch:' + path;
            log('API fetch success: ' + path + ' → ' + devs.length + ' devices');
            break;
          }
        }
      }
      if (out.devices) {
        // Check if last_seen is actually populated — API may omit it
        const hasLastSeen = out.devices.some(d => d.last && d.last !== '—' && d.last !== '—');
        if (hasLastSeen) break;
        log('API returned devices but NO last_seen — will continue to DOM scrape for last_seen');
        out.apiDevices = out.devices;   // stash API devices
        out.devices    = null;           // clear so DOM scrape runs
      }
    } catch(e) { /* path not found or network error */ }
  }

  // ── STRATEGY 2: Window object / Vue store scan ───────────────────
  if (!out.devices) {
    log('Trying window state scan...');
    // Named store properties
    const storeKeys = [
      '__store__','__STORE__','__STATE__','__INITIAL_STATE__',
      '__PRELOADED_STATE__','__APP_STATE__','__NUXT__','__NEXT_DATA__',
      'store','_store','appStore','vuex','reduxStore',
      'Laravel','App','ReachOut','deviceData','monitorData','appData',
    ];
    for (const k of storeKeys) {
      try {
        const v = window[k];
        if (!v) continue;
        const s = typeof v.getState === 'function' ? v.getState() : v;
        const found = findDeviceArray(s, 5);
        if (found) {
          const devs = found.map(normaliseApiDevice).filter(Boolean);
          if (devs.length > 0) {
            out.devices = devs; out.apiSource = 'window.' + k;
            log('Window scan hit: window.' + k + ' → ' + devs.length + ' devices');
            break;
          }
        }
        try { if (!out.state) out.state = JSON.stringify(s); } catch {}
      } catch {}
    }

    // Vue 2: root instance via #app.__vue__
    if (!out.devices) {
      try {
        const vueRoot = document.querySelector('#app')?.__vue__;
        if (vueRoot) {
          const store = vueRoot.$store?.state || vueRoot.$data;
          const found = findDeviceArray(store, 4);
          if (found) {
            const devs = found.map(normaliseApiDevice).filter(Boolean);
            if (devs.length > 0) {
              out.devices = devs; out.apiSource = 'vue2.$store';
              log('Vue2 store hit → ' + devs.length + ' devices');
            }
          }
          if (!out.state) { try { out.state = JSON.stringify(store); } catch {} }
        }
      } catch {}
    }

    // Vue 3: globalProperties
    if (!out.devices) {
      try {
        const app3 = document.querySelector('#app')?.__vue_app__;
        if (app3) {
          const store = app3.config?.globalProperties?.$store?.state;
          const found = store ? findDeviceArray(store, 4) : null;
          if (found) {
            const devs = found.map(normaliseApiDevice).filter(Boolean);
            if (devs.length > 0) {
              out.devices = devs; out.apiSource = 'vue3.$store';
              log('Vue3 store hit → ' + devs.length + ' devices');
            }
          }
        }
      } catch {}
    }
    // Check if window/store scan returned last_seen — if not, continue to DOM
    if (out.devices) {
      const hasLastSeen = out.devices.some(d => d.last && d.last !== '—' && d.last !== '—');
      if (!hasLastSeen) {
        log('Window scan found devices but NO last_seen — continuing to DOM scrape');
        out.apiDevices = out.apiDevices || out.devices;
        out.devices    = null;
      }
    }
  }

  // ── STRATEGY 3: Table DOM scrape ─────────────────────────────────
  // ALWAYS runs if no last_seen data yet — this is the ONLY reliable source
  // for Last Seen because the SPA computes it client-side and renders it into
  // cells[4]. The API JSON never includes this field.
  // If apiDevices exists (from Strategy 1/2), we MERGE last_seen from DOM into them.
  if (!out.devices) {
    log('Trying table DOM scrape...');
    const tables = Array.from(document.querySelectorAll('table'));
    log('Tables found: ' + tables.length);

    for (const table of tables) {
      // Get ALL <tr> elements — do NOT use tbody tr (SPA may omit <tbody>)
      const allRows = Array.from(table.querySelectorAll('tr'));
      if (allRows.length < 2) continue;

      // Find header row (first row with <th>)
      let hdrIdx = 0;
      let hdrCells = [];
      for (let ri = 0; ri < Math.min(3, allRows.length); ri++) {
        const ths = allRows[ri].querySelectorAll('th');
        if (ths.length >= 3) { hdrIdx = ri; hdrCells = Array.from(ths); break; }
      }
      // Fallback: use first row's <td> as headers
      if (!hdrCells.length && allRows[0].querySelectorAll('td').length >= 3) {
        hdrCells = Array.from(allRows[0].querySelectorAll('td'));
        hdrIdx   = 0;
      }
      if (!hdrCells.length) continue;

      const headers = hdrCells.map(h =>
        h.textContent.replace(/[\u2191\u2193\u21c5\u2195\u25b2\u25bc\u2B06\u2B07↑↓⇅↕▲▼]/g,'').trim().toLowerCase()
      );
      log('Table headers: [' + headers.join(' | ') + ']');

      // Only process the device table
      const hasDevice = headers.some(h => /device|\bname\b/.test(h));
      const hasStatus = headers.some(h => /\b(status|state)\b/.test(h));
      if (!hasDevice || !hasStatus) { log('Skipping table — no device/status columns'); continue; }

      // Map column names → indices using header text
      const col = { name:-1, division:-1, status:-1, uptime:-1, last:-1, ip:-1 };
      headers.forEach((h, i) => {
        if (/^(device name|device|\bname\b)/.test(h) && col.name     < 0) col.name     = i;
        if (/division|zone|\bgroup\b/.test(h)          && col.division < 0) col.division = i;
        if (/\b(status|state)\b/.test(h)                && col.status   < 0) col.status   = i;
        if (/uptime|up.?time/.test(h)                    && col.uptime   < 0) col.uptime   = i;
        if (/last/.test(h)                               && col.last     < 0) col.last     = i;
        if (/\bip\b/.test(h)                            && col.ip       < 0) col.ip       = i;
      });
      log('ColMap: name=' + col.name + ' div=' + col.division + ' status=' + col.status +
          ' uptime=' + col.uptime + ' last=' + col.last);

      // Extract data rows
      const dataRows = allRows.slice(hdrIdx + 1);
      log('Data rows: ' + dataRows.length);
      const devices = [];

      dataRows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 3) return;
        const get = idx => (idx >= 0 && cells[idx]) ? (cells[idx].textContent.trim() || '—') : '—';

        // Strip leading avatar initials (e.g. "AK akhadabalapur1" → "akhadabalapur1")
        const rawName = get(col.name);
        const name = rawName.replace(/^[A-Z]{2,3}\s+/, '').trim();
        if (!name || name === '—' || /^(device|\bname\b|-)$/i.test(name)) return;

        const statusTxt = get(col.status).toLowerCase();
        const online    = /online|active|\bup\b|running|connected/.test(statusTxt);

        // !! CRITICAL: last seen comes from col.last (col index 4) NOT col.uptime (col index 3) !!
        const uptime   = col.uptime >= 0 ? get(col.uptime) : '—';
        const lastSeen = col.last   >= 0 ? get(col.last)   : '—';
        // Pass raw value exactly as-is from source — no transformation

        devices.push({
          name, division: get(col.division), online,
          uptime,
          last: lastSeen,
          ip:   get(col.ip),
        });
      });

      if (devices.length > 0) {
        // If we had API devices (better data quality) but no last_seen,
        // merge the DOM-scraped last_seen into them by device name
        if (out.apiDevices && out.apiDevices.length > 0) {
          const lastSeenMap = {};
          devices.forEach(d => { if (d.name) lastSeenMap[d.name.toLowerCase()] = d.last; });
          out.devices = out.apiDevices.map(d => {
            const domLast = lastSeenMap[d.name.toLowerCase()];
            return { ...d, last: (domLast && domLast !== '—') ? domLast : d.last };
          });
          // Check merge actually worked — if ALL still '—', use DOM devices directly
          const mergeWorked = out.devices.some(d => d.last && d.last !== '—');
          if (!mergeWorked) {
            log('Merge FAILED (name mismatch?) — using DOM devices directly');
            out.devices = devices;
            out.apiSource = 'table-dom-fallback';
          } else {
            out.apiSource = 'api+dom-merge';
          }
          log('Merged DOM last_seen into API devices: ' + out.devices.length + ' devices');
        } else {
          out.devices = devices;
          out.apiSource = 'table-dom';
        }
        out.headers   = headers;
        out.colMap    = col;
        log('Table scrape success: ' + devices.length + ' devices');
        log('Sample last_seen: ' + devices.slice(0,3).map(d => d.name+':'+d.last).join(', '));
        break;
      }
    }
  }

  // ── STRATEGY 4: Div/grid-based layout ───────────────────────────
  if (!out.devices) {
    log('Trying div/grid scrape...');
    const grid = document.querySelector('[role="grid"],[role="table"],.device-table,.device-list');
    if (grid) {
      const rows = Array.from(grid.querySelectorAll('[role="row"],.table-row,.device-row,li'));
      if (rows.length > 1) {
        const hCells = Array.from(rows[0].querySelectorAll('[role="columnheader"],th,.col-header'));
        const headers = hCells.map(h => h.textContent.trim().toLowerCase());
        const col = { name:-1, division:-1, status:-1, uptime:-1, last:-1 };
        headers.forEach((h, i) => {
          if (/device|\bname\b/.test(h) && col.name     < 0) col.name     = i;
          if (/division/.test(h)          && col.division < 0) col.division = i;
          if (/status/.test(h)            && col.status   < 0) col.status   = i;
          if (/uptime/.test(h)            && col.uptime   < 0) col.uptime   = i;
          if (/last/.test(h)              && col.last     < 0) col.last     = i;
        });
        const devices = [];
        rows.slice(1).forEach(row => {
          const cells = Array.from(row.querySelectorAll('[role="cell"],[role="gridcell"],td,.cell'));
          const get   = idx => (idx >= 0 && cells[idx]) ? cells[idx].textContent.trim() || '—' : '—';
          const rawName2 = get(col.name);
          const name  = rawName2.replace(/^[A-Z]{2,3}\s+/, '').trim();
          if (!name || name === '—') return;
          const st = get(col.status).toLowerCase();
          devices.push({ name, division: get(col.division), online: /online|active/.test(st),
            uptime: get(col.uptime), last: get(col.last), ip: '—' });
        });
        if (devices.length > 0) {
          out.devices = devices; out.apiSource = 'div-grid';
          log('Div grid scrape: ' + devices.length + ' devices');
        }
      }
    }
  }

  // Include raw HTML for debugging (last resort fallback in dashboard.js)
  out.html = document.documentElement.outerHTML;
  log('Done. devices=' + (out.devices ? out.devices.length : 0) + ' apiSource=' + out.apiSource);
  return JSON.stringify(out);
})()