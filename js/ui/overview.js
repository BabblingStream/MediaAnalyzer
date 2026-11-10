/* ============================================================================
 * MediaAnalyzer — ui/overview.js
 *
 * The Overview view: a summary of the file, an inline preview where the
 * browser can render one, and one card per track.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var PREVIEW_MIME = {
    png: 'image/png', apng: 'image/png', jpeg: 'image/jpeg', gif: 'image/gif',
    webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif', heic: 'image/heic',
    mp4: 'video/mp4', webm: 'video/webm', matroska: 'video/webm', flv: 'video/x-flv',
    ts: 'video/mp2t', ogg: 'audio/ogg', mp3: 'audio/mpeg', adts: 'audio/aac',
    flac: 'audio/flac', wav: 'audio/wav', avi: 'video/x-msvideo'
  };

  // Image formats every browser can decode natively.
  var IMAGE_OK = { png: 1, apng: 1, jpeg: 1, gif: 1, webp: 1, bmp: 1, avif: 1 };
  // HEIF-family brands (inside an ISOBMFF container) browsers cannot decode.
  var IMAGE_BAD_BRAND = { heic: 1, heix: 1, mif1: 1, msf1: 1, hevc: 1, hevx: 1 };

  function previewKind(ctx) {
    var r = ctx.result;
    if (!r) return null;
    var id = r.formatId;
    if (['m3u8', 'h264', 'h265', 'h266', 'av1', 'ivf'].indexOf(id) >= 0) return null;
    var kinds = (r.tracks || []).map(function (t) { return t.type; });
    if (id === 'png' || id === 'jpeg' || id === 'gif' || id === 'webp' || id === 'bmp') return 'image';
    if (kinds.indexOf('image') >= 0) return 'image';
    if (kinds.indexOf('video') >= 0) return 'video';
    if (kinds.indexOf('audio') >= 0) return 'audio';
    return null;
  }

  function previewMime(r, kind) {
    var mime = PREVIEW_MIME[r.formatId];
    if (r.formatId === 'ogg' && kind === 'video') mime = 'video/ogg';
    return mime;
  }

  /**
   * Whether the browser stands a chance of playing this file at all.
   * Returns null when playable, otherwise a { key, vars } reason descriptor
   * naming the exact cause (container, image format, or codec).
   */
  function webUnsupportedReason(ctx, kind) {
    var r = ctx.result;
    if (kind === 'image') {
      if (IMAGE_OK[r.formatId]) return null;
      // HEIC/AVIF arrive as mp4 containers; only AVIF decodes in browsers.
      if (r.formatId === 'mp4' && r.brand && !IMAGE_BAD_BRAND[r.brand]) return null;
      return { key: 'ov.rsImage', vars: { fmt: r.brandName || r.formatName || r.formatId } };
    }
    var mime = previewMime(r, kind);
    var ok = false;
    if (mime) {
      try {
        var probe = document.createElement(kind === 'video' ? 'video' : 'audio');
        ok = !!(probe.canPlayType && probe.canPlayType(mime) !== '');
      } catch (e) { ok = false; }
    }
    return ok ? null : { key: 'ov.rsContainer', vars: { fmt: r.formatName || r.formatId } };
  }

  /** Collapse state survives re-renders (new file, language switch, …). */
  var previewCollapsed = false;

  /**
   * The preview card with a collapse chevron in its title row; the media body
   * hides while collapsed. Used for both the player and the hint variants.
   */
  function previewCard(box) {
    var c = MA.ui.el('div', 'card preview-card' + (previewCollapsed ? ' collapsed' : ''));
    var head = MA.ui.el('div', 'card-title');
    head.appendChild(MA.ui.el('span', null, MA.ui.t('ov.preview')));
    var btn = MA.ui.el('button', 'preview-toggle', previewCollapsed ? '▸' : '▾');
    btn.type = 'button';
    btn.setAttribute('aria-expanded', String(!previewCollapsed));
    btn.title = MA.ui.t(previewCollapsed ? 'ov.expand' : 'ov.collapse');
    btn.addEventListener('click', function () {
      previewCollapsed = !previewCollapsed;
      c.classList.toggle('collapsed', previewCollapsed);
      btn.textContent = previewCollapsed ? '▸' : '▾';
      btn.setAttribute('aria-expanded', String(!previewCollapsed));
      btn.title = MA.ui.t(previewCollapsed ? 'ov.expand' : 'ov.collapse');
    });
    head.appendChild(btn);
    c.appendChild(head);
    var body = MA.ui.el('div', 'preview-body');
    body.appendChild(box);
    c.appendChild(body);
    return c;
  }

  /** Full-screen image overlay; closes on click or Escape. */
  function openLightbox(src, alt) {
    var overlay = MA.ui.el('div', 'lightbox');
    var img = MA.ui.el('img');
    img.src = src;
    img.alt = alt || '';
    overlay.appendChild(img);
    function close() {
      document.removeEventListener('keydown', onKey, true);
      overlay.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.stopPropagation(); close(); }
    }
    overlay.addEventListener('click', close);
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(overlay);
  }

  /**
   * The preview lives in a fixed host above the scrollable pane body, so it
   * stays put — and always ahead of the summary — while details scroll.
   */
  function renderPreview(ctx) {
    var host = MA.ui.$('overviewPreview');
    if (!host) return;
    MA.ui.clear(host);
    host.hidden = true;
    var r = ctx.result;
    if (!r) return;

    function showHint(key, reason) {
      var text = MA.ui.t(key);
      if (reason) text += ' ' + MA.ui.t(reason.key, reason.vars);
      host.appendChild(previewCard(MA.ui.el('div', 'hint', text)));
      host.hidden = false;
    }

    var kind = previewKind(ctx);
    if (!kind) {
      if ((r.tracks || []).length) showHint('ov.noPreview');
      return;
    }
    var reason = webUnsupportedReason(ctx, kind);
    if (reason) { showHint('ov.webUnsupported', reason); return; }

    var blob = ctx.bytes && ctx.bytes.asBlob ? ctx.bytes.asBlob(previewMime(r, kind)) : null;
    if (!blob) { showHint('ov.webUnsupported'); return; }
    if (!ctx.previewUrl) {
      try { ctx.previewUrl = URL.createObjectURL(blob); } catch (e) { ctx.previewUrl = null; }
    }
    if (!ctx.previewUrl) { showHint('ov.webUnsupported'); return; }

    var box = MA.ui.el('div', 'preview-box');
    var media;
    if (kind === 'image') {
      media = MA.ui.el('img');
      media.alt = ctx.fileName;
      media.title = MA.ui.t('ov.zoom');
      media.addEventListener('click', function () {
        openLightbox(ctx.previewUrl, ctx.fileName);
      });
    } else if (kind === 'video') {
      media = MA.ui.el('video');
      media.controls = true;
    } else {
      media = MA.ui.el('audio');
      media.controls = true;
    }
    // The mime probe passed but the actual codec may still be unplayable
    // (e.g. HEVC in MP4) — swap the player for a hint naming that codec.
    media.addEventListener('error', function () {
      var codecs = (r.tracks || [])
        .map(function (t) { return t.codecName || t.codec; })
        .filter(function (c, i, a) { return c && a.indexOf(c) === i; })
        .join(', ');
      MA.ui.clear(box);
      box.appendChild(MA.ui.el('div', 'hint',
        MA.ui.t('ov.webUnsupported') +
        (codecs ? ' ' + MA.ui.t('ov.rsCodec', { codec: codecs }) : '')));
    });
    media.src = ctx.previewUrl;
    box.appendChild(media);
    host.appendChild(previewCard(box));
    host.hidden = false;
  }

  function render(ctx) {
    var body = MA.ui.$('overviewBody');
    if (!body) return;
    MA.ui.clear(body);
    renderPreview(ctx);
    var r = ctx.result;
    if (!r) return;

    var wrap = MA.ui.el('div');

    /* ---------------- summary ---------------- */
    var summaryRows = [
      { label: MA.ui.t('ov.fileName'), value: ctx.fileName || '—' },
      { label: MA.ui.t('ov.format'), value: r.formatName || r.formatId },
      { label: MA.ui.t('ov.size'), value: MA.formatSize(ctx.fileSize), mono: true }
    ];
    if (r.brandName) summaryRows.push({ label: 'Brand', value: r.brandName + ' (' + r.brand + ')', mono: true });
    if (r.durationSec != null) {
      summaryRows.push({ label: MA.ui.t('ov.duration'), value: MA.formatDuration(r.durationSec), mono: true });
    }
    if (r.bitrate) summaryRows.push({ label: MA.ui.t('ov.bitrate'), value: MA.formatBitrate(r.bitrate), mono: true });
    var trackCounts = {};
    (r.tracks || []).forEach(function (t) {
      trackCounts[t.type] = (trackCounts[t.type] || 0) + 1;
    });
    var typeParts = Object.keys(trackCounts).map(function (k) {
      return trackCounts[k] + ' ' + MA.ui.t('tr.' + k);
    });
    summaryRows.push({
      label: MA.ui.t('ov.tracks'),
      value: typeParts.length ? typeParts.join(', ') : MA.ui.t('common.none')
    });
    (r.extra || []).forEach(function (row) {
      summaryRows.push({ label: row.label, value: row.value, mono: true });
    });

    var summaryCard = MA.ui.card(MA.ui.t('ov.overview'), MA.ui.kvBlock(summaryRows));
    wrap.appendChild(summaryCard);

    /* ---------------- tracks ---------------- */
    (r.tracks || []).forEach(function (track, i) {
      wrap.appendChild(trackCard(track, i));
    });

    /* ---------------- images (multi-picture files) ---------------- */
    var imageFrames = (r.frames || []).filter(function (f) { return f.imageInfo; });
    if (imageFrames.length >= 2) wrap.appendChild(imagesCard(imageFrames));

    /* ---------------- metadata ---------------- */
    var meta = r.metadata || [];
    if (meta.length) {
      var rows = meta.map(function (m) {
        return { label: m.key, value: String(m.value) };
      });
      wrap.appendChild(MA.ui.card(MA.ui.t('ov.metadata'), MA.ui.kvBlock(rows)));
    }

    /* ---------------- notes ---------------- */
    var notes = r.notes || [];
    if (notes.length) {
      var ul = MA.ui.el('ul', 'notes');
      notes.forEach(function (n) { ul.appendChild(MA.ui.el('li', null, String(n))); });
      wrap.appendChild(MA.ui.card(MA.ui.t('ov.notes'), ul));
    }

    body.appendChild(wrap);
  }

  function trackCard(track, index) {
    var typeLabel = MA.ui.t('tr.' + (track.type || 'other'));
    var c = MA.ui.el('div', 'card track-card ' + (track.type || 'other'));

    var head = MA.ui.el('div', 'card-title');
    head.appendChild(MA.ui.el('span', 'badge ' + (track.type || 'other'), typeLabel));
    head.appendChild(MA.ui.el('span', null, (track.codecName || track.codec || '') +
      (index != null ? '  #' + (index + 1) : '')));
    c.appendChild(head);

    var rows = [];
    rows.push({ label: MA.ui.t('ov.trackId'), value: track.id, mono: true });
    if (track.codec) rows.push({ label: MA.ui.t('ov.codec'), value: track.codec, mono: true });
    if (track.profile) rows.push({ label: MA.ui.t('ov.profile'), value: track.profile });
    if (track.level) rows.push({ label: MA.ui.t('ov.level'), value: track.level });
    if (track.width && track.height) {
      rows.push({ label: MA.ui.t('ov.resolution'), value: track.width + ' × ' + track.height, mono: true });
    }
    if (track.fps) rows.push({ label: MA.ui.t('ov.fps'), value: MA.formatFps(track.fps), mono: true });
    if (track.sampleRate) rows.push({ label: MA.ui.t('ov.sampleRate'), value: MA.formatHz(track.sampleRate), mono: true });
    if (track.channels) {
      rows.push({ label: MA.ui.t('ov.channels'),
                  value: track.channelLayout || MA.formatChannels(track.channels) });
    }
    if (track.bitDepth) rows.push({ label: MA.ui.t('ov.bitDepth'), value: track.bitDepth + ' bit' });
    if (track.language && track.language !== 'und' && track.language !== '') {
      rows.push({ label: MA.ui.t('ov.language'), value: track.language });
    }
    if (track.handlerName) rows.push({ label: 'Handler', value: track.handlerName });
    if (track.durationSec) rows.push({ label: MA.ui.t('ov.duration'), value: MA.formatDuration(track.durationSec), mono: true });
    if (track.bitrate) rows.push({ label: MA.ui.t('ov.bitrate'), value: MA.formatBitrate(track.bitrate), mono: true });
    if (track.streamSize) {
      rows.push({ label: MA.ui.t('ov.streamSize'),
                  value: MA.formatSize(track.streamSize) + ' (' + MA.formatNum(track.streamSize) + ' bytes)',
                  mono: true });
    }
    if (track.sampleCount) rows.push({ label: MA.ui.t('ov.samples'), value: track.sampleCount, mono: true });
    (track.extra || []).forEach(function (row) {
      rows.push({ label: row.label, value: row.value, mono: true });
    });

    c.appendChild(MA.ui.kvBlock(rows));
    return c;
  }

  /**
   * One row per picture inside a multi-image file (HEIF items, APNG frames,
   * JPEG main + Exif thumbnail): role, resolution, codec and the encoding
   * parameters the parser recovered.
   */
  function imagesCard(imageFrames) {
    var table = MA.ui.el('table', 'frame-table ov-images');
    var thead = MA.ui.el('thead');
    var hr = MA.ui.el('tr');
    ['#', MA.ui.t('ov.image'), MA.ui.t('ov.resolution'), MA.ui.t('ov.codec'),
     MA.ui.t('ov.params'), MA.ui.t('ov.size')]
      .forEach(function (label) { hr.appendChild(MA.ui.el('th', null, label)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = MA.ui.el('tbody');
    imageFrames.forEach(function (f, i) {
      var info = f.imageInfo;
      var tr = MA.ui.el('tr');
      tr.appendChild(MA.ui.el('td', 'num mono', i + 1));
      var tdName = MA.ui.el('td');
      tdName.appendChild(MA.ui.el('div', null, info.role || f.label || '—'));
      if (info.role && f.label && f.label !== info.role) {
        tdName.appendChild(MA.ui.el('div', 'dim small', f.label));
      }
      tr.appendChild(tdName);
      tr.appendChild(MA.ui.el('td', 'mono',
        info.width && info.height ? info.width + ' × ' + info.height : '—'));
      tr.appendChild(MA.ui.el('td', 'mono', info.codecName || info.codec || f.codec || '—'));
      tr.appendChild(MA.ui.el('td', null, info.params || '—'));
      tr.appendChild(MA.ui.el('td', 'num mono', MA.formatSize(f.size)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return MA.ui.card(MA.ui.t('ov.images') + ' (' + imageFrames.length + ')', table);
  }

  MA.ui.registerView('overview', { render: render });
})(typeof globalThis !== 'undefined' ? globalThis : this);
