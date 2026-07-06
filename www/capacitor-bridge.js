/**
 * capacitor-bridge.js
 * ────────────────────
 * Drop-in replacement for Electron's `require('electron').ipcRenderer` so that
 * dashboard.js, login.html, and index.html run completely UNCHANGED on Android.
 *
 * Every ipcRenderer.invoke(channel, ...) call the app already makes is handled
 * here using Capacitor plugins (or plain browser APIs) instead of an Electron
 * main process. Same channel names, same argument shapes, same return shapes.
 *
 * This file MUST load before dashboard.js and before login.html's inline script.
 */
(function () {
  'use strict';

  const { Preferences }         = Capacitor.Plugins;
  const { Filesystem, Directory } = Capacitor.Plugins;
  const { Share }                = Capacitor.Plugins;
  const { LocalNotifications }   = Capacitor.Plugins;
  const { Browser }              = Capacitor.Plugins;
  const { App }                  = Capacitor.Plugins;
  const { ReachoutScraper }      = Capacitor.Plugins; // our custom native plugin

  const REACHOUT_BASE  = 'https://app.reachoutmediatech.info';
  const REACHOUT_ADMIN = REACHOUT_BASE + '/admin';
  const PERM_STORE_KEY = 'rcc_perm_store';

  // ── SHA-256 helper (Web Crypto) — mirrors main.js's crypto.createHash('sha256') ──
  async function sha256(str) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(str)));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  // Same three authorized users as the desktop app (src/main.js)
  const AUTH_USERS = [
    { username: 'abhinandan', hash: 'b68a62c18ccc22e7b74cc76ab134baeab74a7973a3a84c79cd75ce67dcb96c0d' },
    { username: 'mahavir',    hash: 'aa82088246685c17ebf16d48877686b831ed384ffdc42e76494283c271704d7a' },
    { username: 'sandesh',    hash: 'aa82088246685c17ebf16d48877686b831ed384ffdc42e76494283c271704d7a' }
  ];

  // ── Local permission/settings store (replaces the JSON file main.js kept on disk) ──
  async function readStore() {
    try {
      const r = await Preferences.get({ key: PERM_STORE_KEY });
      return r && r.value ? JSON.parse(r.value) : {};
    } catch { return {}; }
  }
  async function writeStore(data) {
    await Preferences.set({ key: PERM_STORE_KEY, value: JSON.stringify(data) });
  }

  // ── xlsx helper: SheetJS's browser build (loaded via <script> in index.html) ──
  function buildFleetWorkbook({ onlineDevices, offlineDevices, divisions, divisionDevices }) {
    const XLSX = window.XLSX;
    const now = new Date(), wb = XLSX.utils.book_new();
    const on = (onlineDevices || []).length, off = (offlineDevices || []).length, tot = on + off;

    const ws0 = XLSX.utils.aoa_to_sheet([
      ['ReachSync v1 — ReachOut Fleet Summary'],
      ['Generated', now.toLocaleString()],
      ['Source', 'app.reachoutmediatech.info/admin'],
      [],
      ['Total', tot, 'Online', on, 'Offline', off, 'Uptime%', tot > 0 ? ((on / tot) * 100).toFixed(1) + '%' : '—'],
      [],
      ['Online Device', 'Division', 'Uptime', ''],
      ...Array.from({ length: Math.max(on, off) }, (_, i) => {
        const o = (onlineDevices || [])[i] || {};
        const f = (offlineDevices || [])[i] || {};
        return [o.name || '', o.division || '', o.uptime || '—', '',
                f.name || '', f.division || '', f.last || ''];
      })
    ]);
    ws0['!cols'] = [{ wch: 28 }, { wch: 18 }, { wch: 12 }, { wch: 3 }, { wch: 28 }, { wch: 18 }, { wch: 22 }];
    XLSX.utils.book_append_sheet(wb, ws0, 'Fleet Summary');

    for (const dv of (divisions || [])) {
      const devs = (divisionDevices || {})[dv] || [];
      const on2 = devs.filter(d => d.online).length;
      const ws = XLSX.utils.aoa_to_sheet([
        [`${dv} — Division Report`],
        ['Generated', now.toLocaleString()],
        ['Total', devs.length, 'Online', on2, 'Offline', devs.length - on2],
        [],
        ['Device', 'Status', 'Uptime', 'Last Seen'],
        ...devs.slice().sort((a, b) => a.name.localeCompare(b.name))
               .map(d => [d.name, d.online ? 'Online' : 'Offline', d.uptime || '—', d.last || '—'])
      ]);
      ws['!cols'] = [{ wch: 28 }, { wch: 10 }, { wch: 12 }, { wch: 22 }];
      XLSX.utils.book_append_sheet(wb, ws,
        String(dv).replace(/[\\\/\?\*\[\]:]/g, '').slice(0, 28) || 'Division');
    }
    return XLSX.write(wb, { bookType: 'xlsx', type: 'base64' });
  }

  // ── HTTP helper for send-email / test-script-url (replaces Node's https module) ──
  async function httpFetchText(url, opts) {
    const res = await fetch(url, opts);
    const text = await res.text();
    return { status: res.status, body: text, ok: res.ok };
  }

  // ── The channel router — mirrors every ipcMain.handle(...) in main.js ──
  const handlers = {
    async 'login-attempt'({ username, password, remember } = {}) {
      const uname = String(username || '').trim().toLowerCase();
      const user = AUTH_USERS.find(u => u.username === uname);
      if (!user) return { success: false, reason: 'Invalid username or password.' };
      const hash = await sha256(password);
      if (hash !== user.hash) return { success: false, reason: 'Invalid username or password.' };
      await Preferences.set({ key: 'rcc_logged_in', value: '1' });
      // "Remember Me": store the username + password HASH only (never the
      // plaintext password) so a future launch can silently re-validate
      // against the same AUTH_USERS list used for real logins.
      if (remember) {
        await Preferences.set({ key: 'rcc_remember_user', value: JSON.stringify({ username: uname, hash }) });
      } else {
        await Preferences.remove({ key: 'rcc_remember_user' });
      }
      return { success: true };
    },

    async 'get-remembered-login'() {
      try {
        const r = await Preferences.get({ key: 'rcc_remember_user' });
        if (!r || !r.value) return null;
        const data = JSON.parse(r.value);
        // Never trust the stored hash blindly — re-validate against AUTH_USERS.
        const user = AUTH_USERS.find(u => u.username === data.username && u.hash === data.hash);
        return user ? { username: data.username } : null;
      } catch { return null; }
    },

    async 'clear-remembered-login'() {
      await Preferences.remove({ key: 'rcc_remember_user' });
      await Preferences.remove({ key: 'rcc_logged_in' });
      return { success: true };
    },

    async 'get-perm'(key) {
      const d = await readStore();
      return d[key] ?? null;
    },
    async 'set-perm'(key, val) {
      try {
        const d = await readStore();
        if (val == null) delete d[key]; else d[key] = val;
        await writeStore(d);
        return { success: true };
      } catch (e) { return { success: false, reason: e.message }; }
    },
    async 'get-perm-all'() {
      return await readStore();
    },
    async 'set-perm-batch'(upd) {
      try {
        const d = await readStore();
        for (const [k, v] of Object.entries(upd || {})) { if (v == null) delete d[k]; else d[k] = v; }
        await writeStore(d);
        return { success: true };
      } catch (e) { return { success: false, reason: e.message }; }
    },
    async 'get-perm-path'() {
      return { perm: 'capacitor-preferences (device-local storage)', userData: 'app-sandbox' };
    },

    async 'fetch-reachout'({ path: reqPath = '/admin', waitMs = 15000 } = {}) {
      const url = REACHOUT_BASE + reqPath;
      try {
        const r = await ReachoutScraper.loadAndExtract({ url, waitMs });
        if (!r.success) return { success: false, reason: r.reason };
        return { success: true, html: r.html, stateJson: r.state, devices: r.devices, colMap: r.colMap, path: reqPath };
      } catch (e) { return { success: false, reason: e.message }; }
    },

    async 'fetch-reachout-api'({ apiPath } = {}) {
      const apiUrl = REACHOUT_BASE + apiPath;
      try {
        const r = await ReachoutScraper.runFetch({ adminUrl: REACHOUT_ADMIN, apiUrl });
        if (!r.success) return { success: false, reason: r.reason };
        let json = null;
        try { json = JSON.parse(r.text); } catch {}
        return { success: true, json, text: r.text, apiPath };
      } catch (e) { return { success: false, reason: e.message }; }
    },

    async 'generate-xlsx'(payload) {
      try {
        const data = buildFleetWorkbook(payload || {});
        return { success: true, data };
      } catch (e) { return { success: false, reason: e.message }; }
    },

    async 'show-notification'({ title, body, silent } = {}) {
      try {
        const perm = await LocalNotifications.checkPermissions();
        if (perm.display !== 'granted') {
          // Only ever show the OS permission dialog once. If the user already
          // made a choice (Allow or Don't Allow), don't ask again on every
          // subsequent Sync Now — just skip the notification silently.
          const askedBefore = (await Preferences.get({ key: 'rcc_notif_asked' })).value === '1';
          if (askedBefore) return { success: false, reason: 'permission-denied' };
          await Preferences.set({ key: 'rcc_notif_asked', value: '1' });
          const req = await LocalNotifications.requestPermissions();
          if (req.display !== 'granted') return { success: false, reason: 'permission-denied' };
        }
        await LocalNotifications.schedule({
          notifications: [{
            id: Date.now() % 100000,
            title: title || 'ReachSync',
            body: body || '',
            silent: !!silent,
            schedule: { at: new Date(Date.now() + 200) }
          }]
        });
        return { success: true };
      } catch (e) { return { success: false, reason: e.message }; }
    },

    async 'send-email'(payload) {
      try {
        const r = await httpFetchText(payload.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload.data)
        });
        let parsed = {};
        try { parsed = JSON.parse(r.body); } catch {}
        return { success: parsed.status === 'ok', status: r.status, response: parsed, rawBody: r.body.slice(0, 500) };
      } catch (e) { return { success: false, reason: e.message }; }
    },

    async 'test-script-url'(url) {
      try {
        const r = await httpFetchText(url, { method: 'GET' });
        return { ok: r.ok, status: r.status, body: r.body.slice(0, 400) };
      } catch (e) { return { ok: false, reason: e.message }; }
    },

    async 'save-file'({ data, filename, type, encoding } = {}) {
      try {
        await Filesystem.writeFile({
          path: filename,
          data: encoding === 'base64' ? data : data,
          directory: Directory.Documents,
          encoding: encoding === 'base64' ? undefined : 'utf8'
        });
        const { uri } = await Filesystem.getUri({ path: filename, directory: Directory.Documents });
        // Offer to share/save it wherever the user wants (Android has no desktop-style save dialog)
        try { await Share.share({ title: filename, url: uri }); } catch {}
        return { success: true, path: uri };
      } catch (e) { return { success: false, reason: e.message }; }
    },

    async 'open-external'(url) {
      try { await Browser.open({ url }); return { success: true }; }
      catch (e) { return { success: false, reason: e.message }; }
    },

    async 'get-version'() {
      try { const info = await App.getInfo(); return info.version; }
      catch { return '2.3.0'; }
    },

    async 'app-reload'() {
      try { await ReachoutScraper.reset(); } catch {}
      window.location.reload();
      return { success: true };
    }
  };

  const ipcRenderer = {
    invoke(channel, ...args) {
      const fn = handlers[channel];
      if (!fn) {
        console.warn('[capacitor-bridge] Unhandled channel:', channel);
        return Promise.resolve({ success: false, reason: 'Unsupported on this platform: ' + channel });
      }
      return Promise.resolve(fn(...args));
    }
  };

  // Shim `require('electron')` exactly like dashboard.js / login.html expect.
  window.require = function (moduleName) {
    if (moduleName === 'electron') return { ipcRenderer };
    throw new Error('Module not available in the Android build: ' + moduleName);
  };
  // Also expose as a bare global, since index.html's inline onclick handlers
  // reference `ipcRenderer` directly (matching the original app's behavior,
  // where dashboard.js's top-level const was visible script-wide).
  window.ipcRenderer = ipcRenderer;
})();
