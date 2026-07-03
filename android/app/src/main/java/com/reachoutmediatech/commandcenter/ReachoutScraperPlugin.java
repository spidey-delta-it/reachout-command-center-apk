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

import java.net.URI;

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

    private WebView scraperWebView;
    private String currentLoadedUrl;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

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

        scraperWebView = wv;
        android.util.Log.d("ReachoutScraper", "Hidden WebView created");
        return wv;
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
        });
    }

    private interface ExtractionCallback { void onResult(String raw); }

    private void runExtraction(WebView wv, ExtractionCallback cb) {
        try {
            String script = readAssetText("scraper/extract_all.js");
            wv.evaluateJavascript(script, cb::onResult);
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
            String domain = null;
            try { domain = URI.create(adminUrl).getHost(); } catch (Exception ignored) {}
            boolean onDomain = domain != null && currentLoadedUrl != null && currentLoadedUrl.contains(domain);

            Runnable doFetch = () -> {
                String script = "(function() {" +
                        "  return fetch(" + JSONObject.quote(apiUrl) + ", {" +
                        "    headers: { 'Accept': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }," +
                        "    credentials: 'same-origin'" +
                        "  }).then(r => r.ok ? r.text() : Promise.reject('HTTP ' + r.status))" +
                        "    .catch(e => '__ERR__:' + String(e));" +
                        "})()";
                wv.evaluateJavascript(script, raw -> {
                    JSObject res = new JSObject();
                    try {
                        String unwrapped = raw;
                        if (unwrapped != null && !unwrapped.equals("null")) {
                            unwrapped = (String) new JSONTokener(raw).nextValue();
                        }
                        if (unwrapped != null && unwrapped.startsWith("__ERR__:")) {
                            res.put("success", false);
                            res.put("reason", unwrapped.substring(8));
                        } else {
                            res.put("success", true);
                            res.put("text", unwrapped == null ? "" : unwrapped);
                        }
                    } catch (Exception e) {
                        res.put("success", false);
                        res.put("reason", e.getMessage());
                    }
                    call.resolve(res);
                });
            };

            if (onDomain) {
                doFetch.run();
            } else {
                wv.setWebViewClient(new WebViewClient() {
                    @Override
                    public void onReceivedSslError(WebView view, SslErrorHandler handler, SslError error) {
                        handler.proceed();
                    }
                    @Override
                    public void onPageFinished(WebView view, String finishedUrl) {
                        currentLoadedUrl = finishedUrl;
                        mainHandler.postDelayed(doFetch, 4000);
                    }
                });
                wv.loadUrl(adminUrl);
            }
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
            call.resolve();
        });
    }
}
