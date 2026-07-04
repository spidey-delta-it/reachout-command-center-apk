package com.reachoutmediatech.commandcenter;

import android.annotation.SuppressLint;
import android.net.http.SslError;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.webkit.SslErrorHandler;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONObject;
import org.json.JSONTokener;

import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

/**
 * ReachoutScraperPlugin
 * ─────────────────────
 * Mobile equivalent of the Electron hidden BrowserWindow scraper in main.js.
 *
 * Electron used a hidden desktop Chromium window + webContents.executeJavaScript()
 * to render app.reachoutmediatech.info and pull live device data out of it using
 * the same-origin session cookies (no server-side API access was ever available).
 *
 * Android's WebView supports the same core primitive — evaluateJavascript() runs
 * inside the loaded page's real JS context, with real session cookies — so the
 * exact same extraction script (extract_all.js, copied byte-for-byte from main.js)
 * can be reused unmodified. This plugin keeps ONE hidden WebView alive for the
 * life of the app (mirroring scraperWin), loads/reloads it as needed, waits for
 * the SPA to render, then evaluates the extraction script and returns the JSON
 * result — same shape, same fields, same fallback strategies as desktop.
 */
@CapacitorPlugin(name = "ReachoutScraper")
public class ReachoutScraperPlugin extends Plugin {

    // ──────────────────────────────────────────────────────────────────────
    // ⚠️  EDIT THESE TWO LINES BEFORE BUILDING  ⚠️
    // The server now requires a real login (username + "security key") at
    // /login before /admin or /status_data will return real data. Put the
    // single shared service account's credentials here — this is baked into
    // the app for all users, per your "single shared service credential"
    // choice. These values never leave the device; they're only used to
    // submit the same POST /login the browser form itself submits.
    private static final String LOGIN_USERNAME = "reachout";
    private static final String LOGIN_PASSWORD = "reach2424";
    // ──────────────────────────────────────────────────────────────────────

    private static final String REACHOUT_BASE = "https://app.reachoutmediatech.info";

    private WebView scraperWebView;
    private String currentLoadedUrl;
    private boolean sessionEstablished = false;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    // ── JS→native result bridge ──────────────────────────────────────────
    // Android's WebView.evaluateJavascript() does NOT wait for a script's
    // Promise to settle — if the script's completion value is a pending
    // Promise, WebView immediately JSON-serializes it (a Promise has no own
    // enumerable properties, so it serializes to the literal string "{}").
    // This bit us for both the login POST and the extraction script, since
    // both are async. The fix: never rely on evaluateJavascript's own return
    // value for async work — instead, chain `.then()`/`.catch()` inside the
    // page's JS to call back into this @JavascriptInterface once the Promise
    // actually resolves/rejects.
    private final ConcurrentHashMap<String, Consumer<String>> pendingCallbacks = new ConcurrentHashMap<>();
    private final AtomicInteger callIdSeq = new AtomicInteger(0);

    private class JsBridge {
        @android.webkit.JavascriptInterface
        public void deliver(String callId, String result) {
            final Consumer<String> cb = pendingCallbacks.remove(callId);
            if (cb != null) mainHandler.post(() -> cb.accept(result));
        }
    }

    /**
     * evalAsync — evaluates a JS expression that evaluates to a Promise (or a
     * plain value), and reliably delivers the SETTLED result via JsBridge
     * instead of evaluateJavascript's own (unreliable, pre-settlement) callback.
     */
    private void evalAsync(final WebView wv, final String promiseExpr, final Consumer<String> callback) {
        final String callId = "cb" + callIdSeq.incrementAndGet();
        pendingCallbacks.put(callId, callback);
        String script =
            "(function(){" +
            "  try {" +
            "    Promise.resolve(" + promiseExpr + ")" +
            "      .then(function(r){ window.AndroidBridge.deliver(" + JSONObject.quote(callId) + ", (typeof r === 'string') ? r : JSON.stringify(r)); })" +
            "      .catch(function(e){ window.AndroidBridge.deliver(" + JSONObject.quote(callId) + ", '__JSERR__:' + String(e)); });" +
            "  } catch (e) {" +
            "    window.AndroidBridge.deliver(" + JSONObject.quote(callId) + ", '__JSERR__:' + String(e));" +
            "  }" +
            "})();";
        wv.evaluateJavascript(script, ignored -> { /* real result arrives via JsBridge.deliver, not here */ });
        // Safety net in case the bridge callback is ever dropped (e.g. page navigated away)
        mainHandler.postDelayed(() -> {
            Consumer<String> cb = pendingCallbacks.remove(callId);
            if (cb != null) cb.accept("__JSERR__:timeout waiting for JS result");
        }, 20000);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private WebView getScraperWebView() {
        if (scraperWebView != null) return scraperWebView;

        WebView wv = new WebView(getContext());
        WebSettings settings = wv.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setLoadWithOverviewMode(true);
        settings.setUseWideViewPort(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        settings.setBlockNetworkImage(true); // mirrors Electron's `images: false`
        wv.setVisibility(View.GONE);          // never shown, same as Electron's `show: false`

        // Explicitly enable cookies — required for the /login session cookie to
        // stick and be sent back on subsequent /status_data fetches.
        android.webkit.CookieManager cm = android.webkit.CookieManager.getInstance();
        cm.setAcceptCookie(true);
        cm.setAcceptThirdPartyCookies(wv, true);

        // Register the JS→native result bridge (see evalAsync/JsBridge above)
        wv.addJavascriptInterface(new JsBridge(), "AndroidBridge");

        // A hidden WebView that's never attached to the view hierarchy can behave
        // unreliably (page loads / JS timers silently stalling) on some Android
        // versions. Attaching it as a 1x1 view keeps it "real" without ever
        // showing it on screen.
        try {
            getActivity().addContentView(wv, new android.widget.FrameLayout.LayoutParams(1, 1));
        } catch (Exception e) {
            android.util.Log.e("ReachoutScraper", "Could not attach hidden WebView: " + e.getMessage());
        }

        scraperWebView = wv;
        android.util.Log.d("ReachoutScraper", "Hidden WebView created");
        return wv;
    }

    /**
     * ensureSession — logs the hidden WebView into the real server via POST /login
     * (the exact same form the browser login page submits — see the page's own
     * <form action="/login" method="POST"> with fields "username"/"password").
     * Runs at most once per app run (cached via sessionEstablished); every caller
     * (loadAndExtract, runFetch) routes through this first.
     */
    private void ensureSession(final WebView wv, final Runnable onSuccess, final Consumer<String> onFail) {
        if (sessionEstablished) { onSuccess.run(); return; }

        if ("REPLACE_WITH_USERNAME".equals(LOGIN_USERNAME) || "REPLACE_WITH_PASSWORD".equals(LOGIN_PASSWORD)) {
            onFail.accept("Login credentials not configured — edit LOGIN_USERNAME / LOGIN_PASSWORD at the top of ReachoutScraperPlugin.java and rebuild.");
            return;
        }

        final String loginUrl = REACHOUT_BASE + "/login";
        wv.setWebViewClient(new WebViewClient() {
            @Override
            public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                android.util.Log.d("ReachoutScraper", "SSL error bypassed (login page): " + error);
                handler.proceed();
            }
            @Override
            public void onPageFinished(WebView view, String finishedUrl) {
                super.onPageFinished(view, finishedUrl);
                currentLoadedUrl = finishedUrl;
                // Small settle delay before submitting, mirrors the app's own
                // page-render wait pattern elsewhere in this plugin.
                mainHandler.postDelayed(() -> submitLogin(wv, onSuccess, onFail), 800);
            }
            @Override
            public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                android.util.Log.e("ReachoutScraper", "Login page failed to load: " + description + " (" + errorCode + ")");
                onFail.accept("Could not load login page: " + description + " (" + errorCode + ")");
            }
        });
        android.util.Log.d("ReachoutScraper", "Loading login page to establish session...");
        wv.loadUrl(loginUrl);
    }

    private void submitLogin(final WebView wv, final Runnable onSuccess, final Consumer<String> onFail) {
        String promiseExpr =
            "fetch('/login', {" +
            "  method: 'POST'," +
            "  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }," +
            "  body: 'username=' + encodeURIComponent(" + JSONObject.quote(LOGIN_USERNAME) + ") + '&password=' + encodeURIComponent(" + JSONObject.quote(LOGIN_PASSWORD) + ")," +
            "  credentials: 'same-origin'," +
            "  redirect: 'follow'" +
            "}).then(function(r){ return (r.url && r.url.indexOf('/login') === -1) ? ('OK:' + r.url) : 'FAIL:still-on-login-page'; })";

        evalAsync(wv, promiseExpr, result -> {
            if (result != null && result.startsWith("OK")) {
                sessionEstablished = true;
                android.util.Log.d("ReachoutScraper", "Login succeeded: " + result);
                onSuccess.run();
            } else {
                android.util.Log.e("ReachoutScraper", "Login failed: " + result);
                onFail.accept("Login failed (check LOGIN_USERNAME/LOGIN_PASSWORD are correct): " + result);
            }
        });
    }

    private String readAssetText(String path) throws Exception {
        java.io.InputStream is = getContext().getAssets().open(path);
        java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
        byte[] buf = new byte[4096];
        int n;
        while ((n = is.read(buf)) != -1) bos.write(buf, 0, n);
        is.close();
        return bos.toString("UTF-8");
    }

    /**
     * loadAndExtract — equivalent of Electron's browserLoad(url, waitMs) + EXTRACT_ALL_JS.
     * Call args: { url: String, waitMs: Int }
     * Resolves: { success, html, state, devices, colMap, apiSource } or { success:false, reason }
     */
    @PluginMethod
    public void loadAndExtract(final PluginCall call) {
        final String url = call.getString("url");
        if (url == null) { call.reject("Missing url"); return; }
        final long waitMs = call.getInt("waitMs", 15000);
        final long overallTimeoutMs = waitMs + 20000;

        mainHandler.post(() -> {
            final WebView wv = getScraperWebView();
            ensureSession(wv, () -> doLoadAndExtract(call, wv, url, waitMs, overallTimeoutMs),
                reason -> {
                    JSObject res = new JSObject();
                    res.put("success", false);
                    res.put("reason", reason);
                    call.resolve(res);
                });
        });
    }

    private void doLoadAndExtract(final PluginCall call, final WebView wv, final String url, final long waitMs, final long overallTimeoutMs) {
        final boolean[] finished = { false };

            final Runnable giveUpRunnable = () -> {
                if (!finished[0]) {
                    finished[0] = true;
                    runExtraction(wv, raw -> resolveExtraction(call, raw, true));
                }
            };
            mainHandler.postDelayed(giveUpRunnable, overallTimeoutMs);

            wv.setWebViewClient(new WebViewClient() {
                @Override
                public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                    // Mirrors Electron's global certificate-error bypass
                    android.util.Log.d("ReachoutScraper", "SSL error bypassed: " + error);
                    handler.proceed();
                }

                @Override
                public void onPageFinished(WebView view, String finishedUrl) {
                    super.onPageFinished(view, finishedUrl);
                    currentLoadedUrl = finishedUrl;
                    mainHandler.postDelayed(() -> {
                        if (!finished[0]) {
                            finished[0] = true;
                            mainHandler.removeCallbacks(giveUpRunnable);
                            runExtraction(wv, raw -> resolveExtraction(call, raw, false));
                        }
                    }, waitMs);
                }

                @Override
                public void onReceivedError(WebView view, int errorCode, String description, String failingUrl) {
                    // Genuine hard failure (DNS, connection refused, etc.) — SSL errors go
                    // through onReceivedSslError above and don't reach here.
                    if (!finished[0]) {
                        finished[0] = true;
                        mainHandler.removeCallbacks(giveUpRunnable);
                        JSObject res = new JSObject();
                        res.put("success", false);
                        res.put("reason", description + " (" + errorCode + ")");
                        call.resolve(res);
                    }
                }
            });

            wv.loadUrl(url);
    }

    private interface ExtractionCallback { void onResult(String raw); }

    private void runExtraction(WebView wv, ExtractionCallback cb) {
        try {
            String rawScript = readAssetText("scraper/extract_all.js").trim();
            // extract_all.js is `(async function(){ ... })();` — a statement, not a bare
            // expression. Strip the trailing semicolon and stash the resulting Promise on
            // `window` so a second, separate evalAsync() call can await its real settlement
            // (evaluateJavascript itself can't await it — see evalAsync's doc comment).
            if (rawScript.endsWith(";")) rawScript = rawScript.substring(0, rawScript.length() - 1);
            final String assign = "window.__pccExtractPromise = (" + rawScript + ");";
            wv.evaluateJavascript(assign, ignored ->
                evalAsync(wv, "window.__pccExtractPromise", cb::onResult)
            );
        } catch (Exception e) {
            android.util.Log.e("ReachoutScraper", "Extraction failed: " + e.getMessage());
            cb.onResult(null);
        }
    }

    private void resolveExtraction(PluginCall call, String rawJsResult, boolean timedOut) {
        try {
            if (rawJsResult == null || rawJsResult.equals("null")) {
                JSObject res = new JSObject();
                res.put("success", false);
                res.put("reason", timedOut ? "Load timeout" : "Extraction returned no data");
                call.resolve(res);
                return;
            }
            // evaluateJavascript wraps the JS string return value in an extra layer of
            // JSON string-encoding (e.g. "\"{...}\""), so unwrap it first.
            String unwrapped = rawJsResult;
            if (unwrapped.startsWith("\"") && unwrapped.endsWith("\"")) {
                unwrapped = (String) new JSONTokener(rawJsResult).nextValue();
            }
            JSONObject parsed = new JSONObject(unwrapped);
            JSObject res = new JSObject();
            res.put("success", true);
            res.put("html", parsed.optString("html", ""));
            res.put("state", parsed.isNull("state") ? null : parsed.optString("state"));
            res.put("devices", parsed.opt("devices"));
            res.put("colMap", parsed.opt("colMap"));
            res.put("apiSource", parsed.isNull("apiSource") ? null : parsed.optString("apiSource"));
            call.resolve(res);
        } catch (Exception e) {
            android.util.Log.e("ReachoutScraper", "Parse failed: " + e.getMessage() + ", raw=" + rawJsResult);
            JSObject res = new JSObject();
            res.put("success", false);
            res.put("reason", "Parse error: " + e.getMessage());
            call.resolve(res);
        }
    }

    /**
     * runFetch — equivalent of Electron's fetch-reachout-api handler.
     * Ensures the hidden webview is on the target domain (loading it first if not),
     * then runs a same-origin fetch() inside that page's context so session cookies
     * are sent automatically — exactly like win.webContents.executeJavaScript() did.
     * Call args: { adminUrl: String, apiUrl: String }
     */
    @PluginMethod
    public void runFetch(final PluginCall call) {
        final String adminUrl = call.getString("adminUrl");
        final String apiUrl = call.getString("apiUrl");
        if (adminUrl == null) { call.reject("Missing adminUrl"); return; }
        if (apiUrl == null) { call.reject("Missing apiUrl"); return; }

        mainHandler.post(() -> {
            final WebView wv = getScraperWebView();
            ensureSession(wv, () -> doApiFetch(call, wv, apiUrl),
                reason -> {
                    JSObject res = new JSObject();
                    res.put("success", false);
                    res.put("reason", reason);
                    call.resolve(res);
                });
        });
    }

    /**
     * doApiFetch — runs the actual same-origin fetch() for a JSON API path,
     * now that ensureSession has guaranteed a real, logged-in session cookie
     * is present. No more "load /admin first" dance needed — the cookie set
     * by POST /login is valid for every path on the origin.
     */
    private void doApiFetch(final PluginCall call, final WebView wv, final String apiUrl) {
        String promiseExpr =
            "fetch(" + JSONObject.quote(apiUrl) + ", {" +
            "  headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }," +
            "  credentials: 'same-origin'" +
            "}).then(function(r){ return r.ok ? r.text() : Promise.reject('HTTP ' + r.status); })";

        evalAsync(wv, promiseExpr, result -> {
            JSObject res = new JSObject();
            if (result != null && result.startsWith("__JSERR__:")) {
                res.put("success", false);
                res.put("reason", result.substring(10));
            } else {
                res.put("success", true);
                res.put("text", result == null ? "" : result);
            }
            call.resolve(res);
        });
    }

    /** reset — destroys the hidden webview so the next call reconnects fresh (mirrors app-reload). */
    @PluginMethod
    public void reset(PluginCall call) {
        mainHandler.post(() -> {
            if (scraperWebView != null) {
                scraperWebView.destroy();
                scraperWebView = null;
            }
            currentLoadedUrl = null;
            sessionEstablished = false;
            call.resolve();
        });
    }
}
