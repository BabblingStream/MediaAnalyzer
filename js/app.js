/* ============================================================================
 * MediaAnalyzer — app.js
 *
 * Application entry point: language setup, the file pickers, full-page drag
 * and drop, the online-file dialog, and the load -> detect -> parse -> render
 * pipeline.
 *
 * Memory lifecycle: the whole file is read once so the parsers can work
 * synchronously over it, and `bytes.release()` then drops that copy. Every
 * later interaction — hex paging, per-frame syntax, media preview — reads
 * ranges back from the File/Blob on demand.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var doc = root.document;

  var MAX_LOCAL_BYTES = 2 * 1024 * 1024 * 1024;    // 2 GB
  var MAX_REMOTE_BYTES = 1024 * 1024 * 1024;       // 1 GB
  var HEAD_BYTES = 4096;                           // sniff window

  var busy = false;

  /* ============================================================ bootstrap */

  function init() {
    buildLanguageSelect();

    bindNavigation();
    bindFilePickers();
    bindDragAndDrop();
    bindUrlModal();
    bindKeyboard();

    MA.i18n.applyDOM();
    MA.i18n.onchange(function () { MA.ui.rerender(); });

    // Each view module registers an `init` hook for its own widgets.
    Object.keys(MA.ui.views).forEach(function (name) {
      var v = MA.ui.views[name];
      if (v && typeof v.init === 'function') {
        try { v.init(); } catch (e) { /* a broken init must not block boot */ }
      }
    });

    MA.ui.showView('welcome');
  }

  function buildLanguageSelect() {
    var sel = MA.ui.$('langSelect');
    if (!sel) return;
    MA.i18n.available().forEach(function (lang) {
      var o = doc.createElement('option');
      o.value = lang.code;
      o.textContent = lang.name;
      sel.appendChild(o);
    });
    sel.value = MA.i18n.getLang();
    sel.addEventListener('change', function () {
      MA.i18n.setLang(this.value);
      MA.i18n.applyDOM();
    });
  }

  function bindNavigation() {
    var nav = MA.ui.$('sideNav');
    if (nav) {
      nav.addEventListener('click', function (ev) {
        var btn = ev.target.closest ? ev.target.closest('.menu-item') : null;
        if (!btn) return;
        if (!MA.ui.ctx.result) {
          // No file loaded (or the last file was unrecognised): stay on the
          // welcome screen and just remind the user to open a file.
          MA.ui.toast(MA.ui.t('msg.noFile'), true);
          return;
        }
        MA.ui.showView(btn.dataset.view);
      });
    }
  }

  function bindFilePickers() {
    var input = MA.ui.$('fileInput');
    var open = MA.ui.$('btnOpenFile');
    var browse = MA.ui.$('btnBrowse');
    var zone = MA.ui.$('dropZone');

    function pick() { if (input) input.click(); }
    if (open) open.addEventListener('click', pick);
    if (browse) browse.addEventListener('click', pick);
    if (zone) {
      zone.addEventListener('click', function (ev) {
        if (ev.target.tagName !== 'BUTTON') pick();
      });
      zone.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); pick(); }
      });
    }
    if (input) {
      input.addEventListener('change', function () {
        if (this.files && this.files[0]) handleFile(this.files[0]);
        this.value = '';                         // allow re-picking the same file
      });
    }
  }

  /* ------------------------------------------------------- drag and drop */

  function bindDragAndDrop() {
    var depth = 0;
    var overlay = MA.ui.$('dropOverlay');

    function hasFiles(ev) {
      var dt = ev.dataTransfer;
      if (!dt) return false;
      if (dt.types) {
        for (var i = 0; i < dt.types.length; i++) if (dt.types[i] === 'Files') return true;
      }
      return false;
    }

    // The whole page is the drop target, hence the counter: dragenter fires
    // for every nested element and its matching dragleave would otherwise
    // hide the overlay while the pointer is still inside the window.
    root.addEventListener('dragenter', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth++;
      if (overlay) overlay.hidden = false;
    });
    root.addEventListener('dragover', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      ev.dataTransfer.dropEffect = 'copy';
    });
    root.addEventListener('dragleave', function (ev) {
      if (!hasFiles(ev)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0 && overlay) overlay.hidden = true;
    });
    root.addEventListener('drop', function (ev) {
      if (!hasFiles(ev)) return;
      ev.preventDefault();
      depth = 0;
      if (overlay) overlay.hidden = true;
      var file = ev.dataTransfer.files && ev.dataTransfer.files[0];
      if (file) handleFile(file);
    });
  }

  /* ----------------------------------------------------------- URL modal */

  function bindUrlModal() {
    var modal = MA.ui.$('urlModal');
    var open = MA.ui.$('btnOpenUrl');
    var open2 = MA.ui.$('btnBrowseOnline');
    var cancel = MA.ui.$('btnUrlCancel');
    var ok = MA.ui.$('btnUrlOk');
    var input = MA.ui.$('urlInput');

    function show() { if (modal) { modal.hidden = false; if (input) input.focus(); } }
    function hide() { if (modal) modal.hidden = true; }

    if (open) open.addEventListener('click', show);
    if (open2) open2.addEventListener('click', show);
    if (cancel) cancel.addEventListener('click', hide);
    if (modal) {
      modal.addEventListener('click', function (ev) { if (ev.target === modal) hide(); });
    }
    if (ok) ok.addEventListener('click', function () { hide(); handleUrl(input ? input.value : ''); });
    if (input) {
      input.addEventListener('keydown', function (ev) {
        if (ev.key === 'Enter') { hide(); handleUrl(input.value); }
      });
    }
  }

  function bindKeyboard() {
    doc.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape') {
        var modal = MA.ui.$('urlModal');
        if (modal && !modal.hidden) modal.hidden = true;
      }
    });
  }

  /* ============================================================ loading */

  function handleFile(file) {
    if (busy) return;
    if (file.size > MAX_LOCAL_BYTES) {
      MA.ui.toast(MA.ui.t('msg.tooLarge', {
        size: MA.formatSize(file.size), limit: MA.formatSize(MAX_LOCAL_BYTES)
      }), true);
      return;
    }
    if (file.size === 0) {
      MA.ui.toast(MA.ui.t('msg.empty'), true);
      return;
    }
    busy = true;
    MA.ui.showLoading(MA.ui.t('msg.loading'));

    file.arrayBuffer().then(function (buf) {
      return run(new Uint8Array(buf), file.name, file);
    }).catch(function (err) {
      MA.ui.hideLoading();
      MA.ui.toast(MA.ui.t('msg.parseFailed', { msg: err && err.message || err }), true);
    }).then(function () {
      busy = false;
    });
  }

  function handleUrl(url) {
    if (busy || !url) return;
    url = String(url).trim();
    if (!/^https?:\/\//i.test(url)) {
      MA.ui.toast(MA.ui.t('msg.rtmp'), true);
      return;
    }
    busy = true;
    MA.ui.showLoading(MA.ui.t('msg.loading'));

    var src;
    try {
      src = MA.makeHttpSource(url);
    } catch (e) {
      MA.ui.hideLoading();
      MA.ui.toast(MA.ui.t('msg.httpError', { msg: e.message }), true);
      busy = false;
      return;
    }

    src.init().then(function () {
      if (src.size > MAX_REMOTE_BYTES) {
        throw new Error(MA.ui.t('msg.tooLarge', {
          size: MA.formatSize(src.size), limit: MA.formatSize(MAX_REMOTE_BYTES)
        }));
      }
      // The whole file is needed for parsing; the source keeps serving ranges
      // afterwards for hex paging and per-frame syntax.
      return src.range(0, src.size).then(function (bytes) {
        var blob = null;
        try { blob = new Blob([bytes]); } catch (e) { blob = null; }
        return runRemote(new Uint8Array(bytes), src.name || url, blob, src, url);
      });
    }).catch(function (err) {
      MA.ui.hideLoading();
      MA.ui.toast(MA.ui.t('msg.httpError', { msg: err && err.message || err }), true);
    }).then(function () {
      busy = false;
    });
  }

  function runRemote(data, name, blob, src, sourceUrl) {
    return run(data, name, blob, src, sourceUrl);
  }

  /* ============================================================= pipeline */

  /**
   * @param {Uint8Array} data    the whole file
   * @param {string} name        file name (used for the extension hint)
   * @param {File|Blob} [blob]   backing store for lazy reads after release
   * @param {object} [remote]    an HttpSource, used when there is no Blob
   * @param {string} [sourceUrl] absolute URL the data was downloaded from;
   *                             enables online HLS segment expansion
   */
  function run(data, name, blob, remote, sourceUrl) {
    return MA.ui.nextFrame().then(function () {
      var detected = MA.detect(data.subarray(0, Math.min(HEAD_BYTES, data.length)), name, data.length);

      // Prefer the Blob for lazy reads; fall back to the HTTP source.
      var bytes = blob ? MA.makeByteSource(data, blob) : MA.makeByteSource(data, null);
      if (!blob && remote) {
        bytes = remote;
        remote.size = data.length;
      }

      var parser = MA.getParser(detected.id);
      if (!parser) {
        MA.ui.hideLoading();
        MA.ui.toast(MA.ui.t('msg.unsupported') + ' (' + detected.id + ')', true);
        return;
      }

      var result;
      try {
        result = parser.parse({
          data: data,
          bytes: bytes,
          name: name || '',
          ext: MA.fileExt(name),
          size: data.length,
          detection: detected
        });
      } catch (err) {
        MA.ui.hideLoading();
        MA.ui.toast(MA.ui.t('msg.parseFailed', { msg: err && err.message || err }), true);
        if (root.console) console.error(err);
        return;
      }

      result = normalize(result, detected, name, data.length);

      // Drop the in-memory copy — everything downstream reads from the source.
      try { bytes.release(); } catch (e) { /* an HttpSource may not need it */ }
      data = null;

      var present = function () {
        MA.ui.setContext({
          bytes: bytes,
          result: result,
          fileName: name || '',
          fileSize: result.fileSize || 0,
          file: blob || null
        });

        updateBadge(detected, name, result.fileSize);
        if (MA.ui.frames && MA.ui.frames.reset) MA.ui.frames.reset();
        if (MA.ui.hex && MA.ui.hex.reset) MA.ui.hex.reset();

        MA.ui.hideLoading();
        MA.ui.showView('overview');

        if (result.notes && result.notes.length && result.frames && !result.frames.length) {
          MA.ui.toast(result.notes[0], true);
        }
      };

      // Remote HLS playlist: follow the first variant, load the default
      // audio/video/subtitle renditions and parse a few segments so the frame
      // list shows real samples. Local playlists stay offline (no fetch base).
      if (result.isPlaylist && sourceUrl && /^https?:\/\//i.test(sourceUrl) &&
          MA.m3u8 && typeof MA.m3u8.expand === 'function') {
        MA.ui.showLoading(MA.ui.t('msg.loading'));
        return MA.m3u8.expand(result, {
          baseUrl: sourceUrl,
          onProgress: function (m) { MA.ui.showLoading(MA.ui.t('msg.loading') + ' — ' + m); }
        }).then(present, function (err) {
          if (root.console) console.error(err);
          present();
        });
      }

      present();
    });
  }

  /** Fill in anything a parser left undefined, so the views can rely on it. */
  function normalize(result, detected, name, size) {
    if (typeof result !== 'object' || result === null) result = {};
    result.formatId = result.formatId || detected.id;
    result.formatName = result.formatName || detected.name || detected.id;
    result.fileSize = size;
    ['tracks', 'structures', 'frames', 'notes', 'metadata', 'extra'].forEach(function (k) {
      if (!Array.isArray(result[k])) result[k] = [];
    });
    if (!result.codecContexts) result.codecContexts = {};

    // Round-trip every node so the views never index undefined.
    (function walk(nodes) {
      (nodes || []).forEach(function (n) {
        if (!Array.isArray(n.children)) n.children = [];
        if (!Array.isArray(n.fields)) n.fields = [];
        if (n.offset == null) n.offset = 0;
        if (n.size == null) n.size = 0;
        walk(n.children);
      });
    })(result.structures);

    // Every frame gets a stable 1-based list index for display.
    result.frames.forEach(function (f, i) {
      if (f.listIndex == null) f.listIndex = i + 1;
      if (f.size == null) f.size = 0;
      if (f.offset == null) f.offset = 0;
    });

    void name;
    return result;
  }

  function updateBadge(detected, name, size) {
    var badge = MA.ui.$('fileBadge');
    if (!badge) return;
    MA.ui.$('badgeFormat').textContent = detected.name || detected.id;
    MA.ui.$('badgeName').textContent = name || '';
    MA.ui.$('badgeSize').textContent = MA.formatSize(size);
    badge.hidden = false;
  }

  /* ================================================================ boot */

  if (doc.readyState === 'loading') {
    doc.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
