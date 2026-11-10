/* ============================================================================
 * MediaAnalyzer — ui/frames.js
 *
 * The Frame Analysis view: a paged, filterable frame table on the left and,
 * on the right, the codec syntax of the selected frame resolved lazily from
 * its `syn` recipe.
 *
 * The table is paged rather than virtualised because the mockup calls for a
 * pager, and because a 60 000-row list is cheaper to page than to keep in the
 * DOM.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var PAGE_SIZES = [100, 200, 500, 1000, 2000];
  var state = {
    page: 0,
    perPage: 200,
    filter: 'all',
    trackFilter: 'all',
    selectedIndex: -1,
    detailTab: 'syntax',
    syntaxToken: 0,
    framePreviewUrl: null
  };

  /* ------------------------------------------------------------- rendering */

  function filtered(ctx) {
    var frames = (ctx.result && ctx.result.frames) || [];
    if (state.filter === 'all' && state.trackFilter === 'all') return frames;
    return frames.filter(function (f) {
      if (state.trackFilter !== 'all' && String(f.track) !== String(state.trackFilter)) return false;
      if (state.filter === 'all') return true;
      if (state.filter === 'video') return f.kind === 'video' || f.kind === 'image';
      if (state.filter === 'audio') return f.kind === 'audio';
      if (state.filter === 'header') return f.kind === 'header';
      return f.kind !== 'video' && f.kind !== 'audio' && f.kind !== 'header' && f.kind !== 'image';
    });
  }

  function kindCounts(frames) {
    var c = { all: frames.length, video: 0, audio: 0, header: 0, other: 0 };
    frames.forEach(function (f) {
      if (f.kind === 'video' || f.kind === 'image') c.video++;
      else if (f.kind === 'audio') c.audio++;
      else if (f.kind === 'header') c.header++;
      else c.other++;
    });
    return c;
  }

  function render(ctx) {
    var list = MA.ui.$('frameList');
    if (!list) return;
    MA.ui.clear(list);

    if (!ctx.result) { renderPager(null, 0, 0); return; }

    buildFilterChips(ctx);
    buildPerPage(ctx);

    var all = ctx.result.frames || [];
    var rows = filtered(ctx);
    var counts = kindCounts(all);

    var pages = Math.max(1, Math.ceil(rows.length / state.perPage));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;

    if (!rows.length) {
      list.appendChild(MA.ui.el('div', 'empty', MA.ui.t('fr.empty')));
      renderPager(ctx, 0, 0);
      return;
    }

    var start = state.page * state.perPage;
    var slice = rows.slice(start, start + state.perPage);

    var table = MA.ui.el('table', 'frame-table');
    var thead = MA.ui.el('thead');
    var hr = MA.ui.el('tr');
    [MA.ui.t('fr.index'), MA.ui.t('fr.type'), MA.ui.t('fr.offset'), MA.ui.t('fr.size'),
     MA.ui.t('fr.codec'), MA.ui.t('fr.time'), MA.ui.t('fr.duration')]
      .forEach(function (label) { hr.appendChild(MA.ui.el('th', null, label)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = MA.ui.el('tbody');
    slice.forEach(function (frame, i) {
      var globalIndex = start + i;
      var tr = MA.ui.el('tr');
      if (globalIndex === state.selectedIndex) tr.classList.add('selected');
      tr.dataset.idx = globalIndex;

      tr.appendChild(MA.ui.el('td', 'num mono', frame.listIndex != null ? frame.listIndex : (globalIndex + 1)));

      var tdType = MA.ui.el('td');
      tdType.appendChild(MA.ui.el('span', 'type-tag ' + tagClass(frame), frame.type || '—'));
      tr.appendChild(tdType);

      tr.appendChild(MA.ui.el('td', 'mono', MA.hex(frame.offset, 8)));
      tr.appendChild(MA.ui.el('td', 'num mono', MA.formatSize(frame.size)));
      tr.appendChild(MA.ui.el('td', 'mono', frame.codec || '—'));

      var timeText = '—';
      if (frame.ptsSec != null) {
        timeText = MA.formatDuration(frame.ptsSec);
        if (frame.durationSec) {
          timeText += ' – ' + MA.formatDuration(frame.ptsSec + frame.durationSec);
        }
      }
      tr.appendChild(MA.ui.el('td', 'mono', timeText));
      tr.appendChild(MA.ui.el('td', 'num mono',
        frame.durationSec != null ? MA.formatMs(frame.durationSec) : '—'));

      tr.addEventListener('click', function () { selectFrame(ctx, globalIndex); });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    list.appendChild(table);

    // Restore the scroll position of the previously selected row.
    var sel = tbody.querySelector('tr.selected');
    if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: 'nearest' });

    renderPager(ctx, rows.length, counts);
  }

  /**
   * A timestamp that may be negative. DTS legitimately goes negative ahead of
   * the first I frame in a B-frame sequence, and formatDuration() renders any
   * negative value as a dash — which reads as "unknown" rather than "before
   * the reference point".
   */
  function signedTime(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    return (sec < 0 ? '-' : '') + MA.formatDuration(Math.abs(sec));
  }

  function tagClass(frame) {
    if (frame.kind === 'header') return 'header';
    if (frame.kind === 'audio') return 'audio';
    if (frame.kind === 'image') return 'image';
    if (frame.keyframe || frame.type === 'I' || frame.type === 'keyframe') return 'key';
    if (frame.kind === 'video') return 'video';
    return 'other';
  }

  function buildFilterChips(ctx) {
    var box = MA.ui.$('frameFilters');
    if (!box) return;
    MA.ui.clear(box);
    var counts = kindCounts(ctx.result.frames || []);
    var defs = [
      ['all', MA.ui.t('fr.all'), counts.all],
      ['video', MA.ui.t('tr.video'), counts.video],
      ['audio', MA.ui.t('tr.audio'), counts.audio],
      ['header', MA.ui.t('tr.header'), counts.header],
      ['other', MA.ui.t('tr.other'), counts.other]
    ];
    defs.forEach(function (d) {
      if (d[0] !== 'all' && d[2] === 0) return;
      var chip = MA.ui.el('button', 'chip' + (state.filter === d[0] ? ' active' : ''),
                          d[1] + ' (' + d[2] + ')');
      chip.addEventListener('click', function () {
        state.filter = d[0];
        state.page = 0;
        render(MA.ui.ctx);
      });
      box.appendChild(chip);
    });
  }

  function buildPerPage(ctx) {
    var sel = MA.ui.$('framePerPage');
    if (!sel) return;
    var lang = MA.i18n.getLang();
    if (sel.dataset.lang === lang) return;
    MA.ui.clear(sel);
    PAGE_SIZES.forEach(function (n) {
      var o = MA.ui.el('option', null, MA.ui.t('fr.perPageOption', { n: n }));
      o.value = String(n);
      sel.appendChild(o);
    });
    sel.value = String(state.perPage);
    sel.dataset.lang = lang;
    if (!sel.dataset.wired) {
      sel.dataset.wired = '1';
      sel.addEventListener('change', function () {
        state.perPage = Number(this.value) || 200;
        state.page = 0;
        render(MA.ui.ctx);
      });
    }
  }

  function renderPager(ctx, total, counts) {
    var pager = MA.ui.$('framePager');
    if (!pager) return;
    MA.ui.clear(pager);
    if (!ctx.result) return;

    var pages = Math.max(1, Math.ceil(total / state.perPage));
    var prev = MA.ui.el('button', 'btn btn-sm', MA.ui.t('fr.prev'));
    prev.disabled = state.page <= 0;
    prev.addEventListener('click', function () { state.page--; render(MA.ui.ctx); });

    var next = MA.ui.el('button', 'btn btn-sm', MA.ui.t('fr.next'));
    next.disabled = state.page >= pages - 1;
    next.addEventListener('click', function () { state.page++; render(MA.ui.ctx); });

    var info = MA.ui.el('span', null,
      MA.ui.t('fr.page') + ' ' + (state.page + 1) + ' ' + MA.ui.t('fr.of') + ' ' + pages +
      ' — ' + MA.ui.t('fr.total', { n: total }));

    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
    void counts;
  }

  /* -------------------------------------------------------------- detail */

  function selectFrame(ctx, index) {
    state.selectedIndex = index;
    var frame = (ctx.result.frames || [])[index];
    ctx.selectedFrame = frame;
    render(ctx);
    renderDetail(ctx, frame);
  }

  async function renderDetail(ctx, frame) {
    var title = MA.ui.$('frameDetailTitle');
    var syntaxPane = MA.ui.$('frameSyntaxPane');
    var hexPane = MA.ui.$('frameHexPane');
    var previewPane = MA.ui.$('framePreviewPane');
    if (!syntaxPane) return;

    MA.ui.clear(syntaxPane);
    MA.ui.clear(hexPane);
    MA.ui.clear(previewPane);

    if (!frame) {
      if (title) title.textContent = MA.ui.t('fr.selectFrame');
      syntaxPane.appendChild(MA.ui.el('div', 'empty', MA.ui.t('fr.selectFrame')));
      return;
    }

    if (title) {
      title.textContent = '#' + (frame.listIndex != null ? frame.listIndex : (state.selectedIndex + 1)) +
        ' — ' + (frame.label || frame.type || '') +
        (frame.track != null ? ' · ' + MA.ui.t('fr.track') + ' ' + frame.track : '');
    }

    syntaxPane.appendChild(MA.ui.kvBlock([
      { label: MA.ui.t('fr.track'), value: frame.track, mono: true },
      { label: MA.ui.t('fr.type'), value: frame.type || '—' },
      { label: MA.ui.t('ov.codec'), value: frame.codec || '—', mono: true },
      { label: MA.ui.t('fr.offset'), value: MA.hex(frame.offset, 8), mono: true },
      { label: MA.ui.t('fr.size'), value: MA.formatSize(frame.size) + ' (' + frame.size + ' bytes)', mono: true },
      frame.ptsSec != null ? { label: MA.ui.t('fr.pts'), value: signedTime(frame.ptsSec), mono: true } : null,
      frame.dtsSec != null ? { label: MA.ui.t('fr.dts'), value: signedTime(frame.dtsSec), mono: true } : null,
      frame.durationSec != null ? { label: MA.ui.t('fr.duration'), value: MA.formatMs(frame.durationSec), mono: true } : null,
      frame.keyframe != null ? { label: MA.ui.t('fr.keyframe'), value: frame.keyframe ? MA.ui.t('common.yes') : MA.ui.t('common.no') } : null
    ].filter(Boolean)));

    var busy = MA.ui.el('div', 'hint', MA.ui.t('msg.loading'));
    syntaxPane.appendChild(busy);

    var token = ++state.syntaxToken;
    // Frames decoded from fetched HLS segments live in their own per-segment
    // byte buffer, not in the playlist file the context was opened with.
    var frameResult = frame.virtual && frame.virtualResult ? frame.virtualResult : ctx.result;
    var frameBytes = frame.virtual && frame.virtualSource ? frame.virtualSource : ctx.bytes;
    var tables;
    try {
      tables = await MA.buildFrameSyntax(frameResult, frame, frameBytes);
    } catch (e) {
      tables = [{ title: 'Error', sub: '', rows: [
        { name: 'error', syntax: '', bits: '', value: String(e && e.message || e), note: '', offset: frame.offset, depth: 0 }
      ] }];
    }
    if (token !== state.syntaxToken) return;              // a newer frame was selected
    syntaxPane.removeChild(busy);

    if (!tables || !tables.length) {
      syntaxPane.appendChild(MA.ui.el('div', 'empty', MA.ui.t('fr.noSyntax')));
    } else {
      tables.forEach(function (t) { syntaxPane.appendChild(MA.ui.syntaxBlock(t)); });
    }

    // ---- hex tab: the frame's own bytes ----
    var limit = Math.min(frame.size || 0, 65536);
    if (limit > 0 && frameBytes) {
      try {
        var bytes = await frameBytes.range(frame.offset, limit);
        if (token !== state.syntaxToken) return;
        hexPane.appendChild(hexDump(bytes, frame.offset));
        if (frame.size > limit) {
          hexPane.appendChild(MA.ui.el('div', 'hint',
            '… ' + MA.formatSize(frame.size - limit) + ' more bytes not shown'));
        }
      } catch (e) {
        hexPane.appendChild(MA.ui.el('div', 'empty', String(e && e.message || e)));
      }
    } else {
      hexPane.appendChild(MA.ui.el('div', 'empty', MA.ui.t('fr.noSyntax')));
    }

    // ---- preview tab ----
    renderFramePreview(ctx, frame, previewPane, token);
  }

  /**
   * Per-frame preview. Frames carrying a `preview` recipe (JPEG main/thumbnail
   * slices, whole-file PNG, rebuildable APNG frames) become an <img>; image
   * frames without one (HEIF items — raw coded bitstreams) get an explicit
   * "unsupported" hint; anything else falls back to the whole-file player.
   */
  async function renderFramePreview(ctx, frame, pane, token) {
    var recipe = frame.preview;
    if (recipe) {
      var busy = MA.ui.el('div', 'hint', MA.ui.t('msg.loading'));
      pane.appendChild(busy);
      try {
        var blob = await buildPreviewBlob(ctx, recipe);
        if (token !== state.syntaxToken) return;
        pane.removeChild(busy);
        if (!blob) throw new Error('no data');
        revokeFramePreviewUrl();
        state.framePreviewUrl = URL.createObjectURL(blob);
        var img = MA.ui.el('img', 'frame-preview-img');
        img.alt = frame.label || '';
        img.addEventListener('error', function () {
          MA.ui.clear(pane);
          pane.appendChild(MA.ui.el('div', 'hint',
            MA.ui.t('ov.webUnsupported') + ' ' +
            MA.ui.t('ov.rsCodec', { codec: frame.codecName || frame.codec || '?' })));
        });
        img.src = state.framePreviewUrl;
        pane.appendChild(img);
      } catch (e) {
        if (token !== state.syntaxToken) return;
        if (busy.parentNode === pane) pane.removeChild(busy);
        pane.appendChild(MA.ui.el('div', 'empty', String(e && e.message || e)));
      }
      return;
    }

    var isImageFrame = frame.kind === 'image' || frame.kind === 'keyframe' ||
                       frame.type === 'image' || frame.type === 'thumbnail';
    if (isImageFrame && frame.imageInfo) {
      pane.appendChild(MA.ui.el('div', 'hint',
        MA.ui.t('ov.webUnsupported') + ' ' +
        MA.ui.t('ov.rsCodec', { codec: frame.codecName || frame.codec || '?' })));
      return;
    }

    var blob = ctx.bytes && ctx.bytes.asBlob ? ctx.bytes.asBlob() : null;
    var trackTypes = (ctx.result.tracks || []).map(function (t) { return t.type; });
    var avKind = trackTypes.indexOf('video') >= 0 ? 'video'
               : trackTypes.indexOf('audio') >= 0 ? 'audio' : null;
    if (blob && ctx.previewUrl && avKind) {
      pane.appendChild(MA.ui.el('div', 'hint', MA.ui.t('fr.previewHint')));
      var media;
      if (avKind === 'video') { media = MA.ui.el('video'); media.controls = true; }
      else { media = MA.ui.el('audio'); media.controls = true; }
      media.src = ctx.previewUrl;
      pane.appendChild(media);
    } else {
      pane.appendChild(MA.ui.el('div', 'empty', MA.ui.t('ov.noPreview')));
    }
  }

  function revokeFramePreviewUrl() {
    if (state.framePreviewUrl) {
      try { URL.revokeObjectURL(state.framePreviewUrl); } catch (e) { /* ignore */ }
      state.framePreviewUrl = null;
    }
  }

  /** Build a decodable Blob from a frame preview recipe. */
  async function buildPreviewBlob(ctx, recipe) {
    if (recipe.mode === 'whole') {
      return ctx.bytes && ctx.bytes.asBlob ? ctx.bytes.asBlob(recipe.mime) : null;
    }
    if (recipe.mode === 'slice') {
      var bytes = await ctx.bytes.range(recipe.offset, recipe.size);
      if (!bytes || !bytes.length) return null;
      return new Blob([bytes], { type: recipe.mime });
    }
    if (recipe.mode === 'pngRebuild') {
      return buildPngFromFrame(ctx, recipe);
    }
    return null;
  }

  var PNG_SIG = new Uint8Array([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  var PNG_IEND = new Uint8Array([0, 0, 0, 0, 0x49, 0x45, 0x4E, 0x44, 0xAE, 0x42, 0x60, 0x82]);

  /** One PNG chunk: length(4 BE) + type(4) + data + CRC32(type+data). */
  function pngChunk(type, data) {
    var out = new Uint8Array(8 + data.length + 4);
    var dv = new DataView(out.buffer);
    dv.setUint32(0, data.length);
    for (var i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
    out.set(data, 8);
    dv.setUint32(8 + data.length, MA.crc32([out.subarray(4, 8), data]));
    return out;
  }

  /**
   * Rebuild an APNG frame into a standalone PNG: signature, an IHDR carrying
   * the frame's own dimensions (fcTL frames are never interlaced), the
   * pre-IDAT chunks it inherits (palette, transparency, colour setup), one
   * IDAT per data part, and IEND.
   */
  async function buildPngFromFrame(ctx, p) {
    var ihdr = new Uint8Array(13);
    var dv = new DataView(ihdr.buffer);
    dv.setUint32(0, p.width);
    dv.setUint32(4, p.height);
    ihdr[8] = p.bitDepth;
    ihdr[9] = p.colorType;
    /* compression 0, filter 0, interlace 0 — already zeroed */

    var blobs = [PNG_SIG, pngChunk('IHDR', ihdr)];
    for (var i = 0; i < (p.chunks || []).length; i++) {
      blobs.push(await ctx.bytes.range(p.chunks[i].offset, p.chunks[i].size));
    }
    var total = 0;
    var datas = [];
    for (var j = 0; j < (p.parts || []).length; j++) {
      var d = await ctx.bytes.range(p.parts[j].offset, p.parts[j].size);
      datas.push(d);
      total += d.length;
    }
    if (!total) return null;
    for (var k = 0; k < datas.length; k++) blobs.push(pngChunk('IDAT', datas[k]));
    blobs.push(PNG_IEND);
    return new Blob(blobs, { type: p.mime || 'image/png' });
  }

  function hexDump(bytes, baseOffset) {
    var wrap = MA.ui.el('div', 'hex-mini');
    var pre = MA.ui.el('div');
    pre.style.fontFamily = 'var(--mono)';
    pre.style.fontSize = '11.5px';
    pre.style.whiteSpace = 'pre';
    var rows = Math.min(Math.ceil(bytes.length / 16), 2048);
    var out = [];
    for (var i = 0; i < rows; i++) {
      var off = baseOffset + i * 16;
      var hex = '', ascii = '';
      for (var j = 0; j < 16; j++) {
        var idx = i * 16 + j;
        if (idx < bytes.length) {
          var b = bytes[idx];
          hex += MA.pad(b.toString(16), 2).toUpperCase() + ' ';
          ascii += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
        } else { hex += '   '; ascii += ' '; }
        if (j === 7) hex += ' ';
      }
      out.push(MA.hex(off, 8) + '  ' + hex + ' |' + ascii + '|');
    }
    pre.textContent = out.join('\n');
    wrap.appendChild(pre);
    return wrap;
  }

  /* ---------------------------------------------------------------- init */

  function init() {
    var tabs = MA.ui.$('frameTabs');
    if (!tabs) return;
    tabs.addEventListener('click', function (ev) {
      var btn = ev.target.closest ? ev.target.closest('.tab') : null;
      if (!btn) return;
      state.detailTab = btn.dataset.ftab;
      var all = tabs.querySelectorAll('.tab');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('active', all[i] === btn);
      var panes = root.document.querySelectorAll('.tab-pane[data-fpane]');
      for (var j = 0; j < panes.length; j++) {
        panes[j].classList.toggle('active', panes[j].dataset.fpane === state.detailTab);
      }
    });
  }

  MA.ui.registerView('frames', { render: render, init: init });
  MA.ui.frames = {
    selectIndex: function (ctx, i) { selectFrame(ctx, i); },
    reset: function () {
      revokeFramePreviewUrl();
      /* Invalidate any in-flight async detail render from the previous file,
       * then wipe the detail panes — otherwise the old file's preview stays
       * visible until the user selects a frame in the new file. */
      state.syntaxToken++;
      state.page = 0;
      state.selectedIndex = -1;
      state.filter = 'all';
      state.trackFilter = 'all';
      if (MA.ui.ctx) MA.ui.ctx.selectedFrame = null;
      var title = MA.ui.$('frameDetailTitle');
      if (title) title.textContent = MA.ui.t('fr.selectFrame');
      ['frameHexPane', 'framePreviewPane'].forEach(function (id) {
        var pane = MA.ui.$(id);
        if (pane) MA.ui.clear(pane);
      });
      var syntaxPane = MA.ui.$('frameSyntaxPane');
      if (syntaxPane) {
        MA.ui.clear(syntaxPane);
        syntaxPane.appendChild(MA.ui.el('div', 'empty', MA.ui.t('fr.selectFrame')));
      }
    }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
