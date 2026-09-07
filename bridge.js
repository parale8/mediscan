/* =====================================================================
   MediScan  <->  OneGlance bridge          v1.1.0
   (v1.1 adds SET_KEY: the extension supplies the Gemini API key)
   ---------------------------------------------------------------------
   Drop this in at the very END of MediScan's index.html, just before
   </body>:

       <script src="bridge.js"></script>

   It is PURELY ADDITIVE. It does not read, rename or modify a single
   line of MediScan's own code, styling or layout. It drives the app the
   same way a human does — it puts files into the file input, fires the
   'change' event the app already listens for, waits for the app's own
   "Done!" state, then clicks Analyse.

   That is deliberate: MediScan's logic lives inside a DOMContentLoaded
   closure, so its functions are not reachable from outside. Driving the
   DOM is the one integration that cannot break when MediScan is edited.
   ===================================================================== */
(function () {
  'use strict';

  var TAG = '[MediScan bridge]';
  var PARENT_ORIGIN = '*';           // panel checks source, not origin
  var inFrame = window.parent !== window;

  if (!inFrame) { console.log(TAG, 'not framed — standalone mode, bridge idle'); return; }

  /* ---------- talk back to the extension panel ---------- */
  function say(type, payload) {
    try { window.parent.postMessage({ source: 'mediscan-bridge', type: type, payload: payload }, PARENT_ORIGIN); }
    catch (e) { console.warn(TAG, e); }
  }
  var state = function (message, kind, pct) { say('STATE', { message: message, kind: kind || 'busy', pct: pct }); };

  /* ---------- small DOM helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function waitFor(fn, timeout, step) {
    timeout = timeout || 60000; step = step || 200;
    var t0 = Date.now();
    return new Promise(function (resolve) {
      (function tick() {
        var v = null;
        try { v = fn(); } catch (e) {}
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(null);
        setTimeout(tick, step);
      })();
    });
  }

  /* ---------- context received from the EMR ---------- */
  var lastContext = null;
  var keyApplied = false;

  /* ---------- API key supplied by the extension ----------
     MediScan's safeStorage cannot persist a key in this frame: Chrome
     blocks localStorage / sessionStorage / cookies for cross-site iframes,
     so it silently falls back to an in-memory copy that dies on reload.
     The extension keeps the key in chrome.storage.sync instead and types
     it into MediScan's own field here, on every load. No app code changes. */
  function applyApiKey(key) {
    if (!key) return false;
    var input = $('apiKey');
    if (!input) return false;

    input.value = key;
    // Let MediScan's own 'input' listener update its status line
    input.dispatchEvent(new Event('input', { bubbles: true }));

    // Press its Save Key button so its normal path runs. That write will
    // not survive a reload here — which is fine, we re-supply it each time.
    var btn = $('saveKeyBtn');
    if (btn) { try { btn.click(); } catch (e) {} }

    // Collapse the config panel: with a key present it is just clutter.
    var details = $('apiConfigDetails');
    if (details) { try { details.removeAttribute('open'); } catch (e) {} }

    keyApplied = true;
    say('KEY_SET', { ok: true, version: '1.1.0', masked: key.length > 8 ? key.slice(0, 6) + '…' + key.slice(-4) : 'set' });
    return true;
  }

  /* Show a slim, unobtrusive banner naming the patient so the doctor can
     see at a glance which visit the analysis belongs to. Uses MediScan's
     own CSS variables, so it inherits the app's colour scheme exactly. */
  function showContextBanner(ctx) {
    var id = '__og_ctx_banner__';
    var el = $(id);
    if (!el) {
      el = document.createElement('div');
      el.id = id;
      el.style.cssText =
        'margin:0 0 1rem;padding:.6rem .9rem;border-radius:10px;' +
        'background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.32);' +
        'color:var(--text-primary,#f8fafc);font-size:.82rem;line-height:1.45;';
      var host = document.querySelector('.container') || document.body;
      var anchor = document.querySelector('.upload-section') || host.firstChild;
      host.insertBefore(el, anchor);
    }
    var p = (ctx && ctx.patient) || {};
    var bits = [];
    if (p.name) bits.push('<b>' + esc(p.name) + '</b>');
    if (p.id) bits.push('ID ' + esc(p.id));
    if (p.gender || p.age) bits.push(esc([p.gender, p.age].filter(Boolean).join(' ')));
    var docs = (ctx.documents || []).filter(function (d) { return d.ok; });
    el.innerHTML =
      '🔗 <b>From OneGlance EMR</b> · ' + bits.join(' · ') +
      '<br><span style="color:var(--text-secondary,#94a3b8)">Visit ' + esc(ctx.visitDatePretty || ctx.visitDate || '') +
      ' · ' + docs.length + ' document(s) + EMR investigation sheet</span>';
  }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  /* ---------- put files into MediScan's own input ---------- */
  function loadFiles(files) {
    var input = $('fileInput') || $('addFileInput');
    if (!input) throw new Error('MediScan file input not found (#fileInput).');

    var dt = new DataTransfer();
    files.forEach(function (f) { dt.items.add(f); });
    input.files = dt.files;
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return input;
  }

  /* MediScan sets the Analyse button's label to "✅ Done! Extract & Analyze"
     once every page has been compressed / PDF-split. That is our green light. */
  function analyseBtn() { return $('analyzeBtn'); }
  function btnLabel() {
    var b = analyseBtn(); if (!b) return '';
    var t = b.querySelector('.btn-text');
    return (t ? t.textContent : b.textContent) || '';
  }
  function galleryCount() {
    var g = $('previewGallery');
    if (!g) return 0;
    return g.querySelectorAll('img, .preview-item, [class*="preview"]').length;
  }

  /* ---------- the run ---------- */
  var busy = false;

  async function runAnalysis(payload) {
    if (busy) { state('Already analysing — ignoring duplicate request.', 'busy'); return; }
    busy = true;

    try {
      lastContext = payload.context || null;
      if (lastContext) showContextBanner(lastContext);

      /* rebuild real File objects from the transferred buffers */
      var files = (payload.files || []).map(function (f) {
        return new File([f.buf], f.name, { type: f.type || 'application/octet-stream' });
      });
      if (!files.length) { state('Nothing was sent to analyse.', 'err'); busy = false; return; }

      // A reload can land between SET_KEY and ANALYSE — make sure the field
      // is still populated before we spend time preparing pages.
      var keyField = $('apiKey');
      if (keyField && !keyField.value.trim() && !keyApplied) {
        say('ERROR', { message: 'No Gemini API key. Add one in the extension Options, then press ↻ Analyse.' });
        busy = false; return;
      }

      state('Loading ' + files.length + ' file(s) into the analyser…', 'busy', 84);

      /* clear whatever the previous patient left behind */
      var clearBtn = $('clearGalleryBtn') || $('clearAllBtn');
      if (clearBtn && clearBtn.offsetParent !== null) { try { clearBtn.click(); await sleep(250); } catch (e) {} }
      var comment = $('doctorComment');
      if (comment) comment.value = '';

      loadFiles(files);

      /* MediScan splits PDFs into page images; wait for it to finish */
      state('Preparing pages (PDF pages are split into images)…', 'busy', 88);
      var ready = await waitFor(function () {
        var b = analyseBtn();
        return b && !b.disabled && /Done/i.test(btnLabel()) ? true : null;
      }, 180000, 350);

      if (!ready) {
        // Fall back on the gallery filling up — some builds word the label differently
        ready = await waitFor(function () { return galleryCount() > 0 ? true : null; }, 20000, 400);
        if (!ready) { say('ERROR', { message: 'MediScan did not finish preparing the pages.' }); busy = false; return; }
      }

      await sleep(300);
      state('Analysing with Gemini Vision…', 'busy', 92);

      var b = analyseBtn();
      if (!b) { say('ERROR', { message: 'Analyse button not found.' }); busy = false; return; }
      b.click();

      /* Watch MediScan's own status line until it settles */
      var statusEl = $('analysisStatus');
      var seenWorking = false;
      var finished = await waitFor(function () {
        var t = statusEl ? (statusEl.textContent || '') : '';
        if (/analy|prepar|extract|generat/i.test(t)) seenWorking = true;
        if (/error|failed/i.test(t)) return 'error';
        var label = btnLabel();
        var hasResult = ($('analysisResult') && $('analysisResult').innerHTML.trim().length > 80);
        if (seenWorking && hasResult && /Done/i.test(label) && !analyseBtn().disabled) return 'done';
        return null;
      }, 300000, 700);

      if (finished === 'error') {
        say('ERROR', { message: (statusEl && statusEl.textContent) || 'MediScan reported an error.' });
      } else if (finished === 'done') {
        var n = files.length;
        say('DONE', { message: 'Analysed ' + n + ' page(s). Doctor Report ready.' });
      } else {
        say('DONE', { message: 'Analysis is still running in the panel — results will appear below.' });
      }

    } catch (e) {
      console.error(TAG, e);
      say('ERROR', { message: e && e.message ? e.message : String(e) });
    } finally {
      busy = false;
    }
  }

  /* ---------- inbound messages ---------- */
  window.addEventListener('message', function (ev) {
    var d = ev.data;
    if (!d || d.source !== 'oneglance-bridge') return;
    if (d.type === 'SET_KEY') {
      applyApiKey(d.payload && d.payload.apiKey);
    } else if (d.type === 'ANALYSE') {
      if (d.payload && d.payload.autoAnalyse === false) {
        lastContext = d.payload.context || null;
        if (lastContext) showContextBanner(lastContext);
        state('Files received — press Extract & Analyze when ready.', 'ok', 100);
        return;
      }
      runAnalysis(d.payload || {});
    } else if (d.type === 'PING') {
      say('READY', { version: '1.1.0' });
    }
  });

  /* ---------- announce ---------- */
  function announce() { say('READY', { version: '1.1.0' }); }
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(announce, 60);
  } else {
    document.addEventListener('DOMContentLoaded', function () { setTimeout(announce, 60); });
  }
  // MediScan wires its handlers on DOMContentLoaded; repeat once so the
  // panel is never left waiting if it attached late.
  setTimeout(announce, 1200);

  console.log(TAG, 'active — v1.1.0 (SET_KEY supported)');
})();
