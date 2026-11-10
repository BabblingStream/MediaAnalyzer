/* ============================================================================
 * MediaAnalyzer — ui/hex.js
 *
 * The Hexadecimal view: a paged hex + ASCII dump with a "structures on this
 * page" panel, byte selection, and jump-to-offset with highlight.
 *
 * The page is read lazily from the ByteSource — after parsing the file is no
 * longer in memory, so one page costs one range read.
 *
 * RENDERING NOTE — why bytes are not individual elements:
 * The obvious implementation emits a <span> per byte for the hex column and
 * another for the ASCII column, so a click lands on a known byte. At the
 * 64 KB page size this option offers, that is 131 072 elements for a single
 * page: the browser pegs a core building them and then runs out of memory,
 * which is exactly the "entering the hex view repeatedly hangs the tab"
 * failure. Instead, consecutive bytes that share a highlight class are
 * emitted as one text run, so a page inside a large box costs one run per
 * line rather than sixteen. A single delegated listener on the grid recovers
 * the clicked byte from the caret position inside the run, which keeps byte
 * picking working at every page size.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var doc = root.document;

  var PAGE_SIZES = [1024, 4096, 16384, 65536];
  var STRUCT_LIMIT = 400;
  var RUN_LIMIT_PER_LINE = 12;      // beyond this, tinting granularity is not
                                    // worth more elements; the line is merged

  var state = {
    page: 0,
    pageSize: 4096,
    selStart: null,
    selEnd: null,
    anchor: null,
    pendingScroll: null,
    renderSeq: 0
  };

  /** The page currently drawn, so selection repaints know their bounds. */
  var drawn = { start: 0, len: 0, bytes: null, cover: null };

  /* ---------------------------------------------------------- model index */

  /** Every node in the tree, with its ancestors, sorted by offset. */
  function flatten(ctx) {
    if (ctx._hexFlatFor === ctx.result) return ctx._hexFlat;
    var out = [];
    (function walk(nodes, ancestors) {
      (nodes || []).forEach(function (n) {
        var entry = { node: n, ancestors: ancestors };
        out.push(entry);
        walk(n.children, ancestors.concat(entry));
      });
    })(ctx.result && ctx.result.structures, []);
    out.sort(function (a, b) {
      return (a.node.offset - b.node.offset) || (b.node.size - a.node.size);
    });
    ctx._hexFlatFor = ctx.result;
    ctx._hexFlat = out;
    return out;
  }

  /** Frame ranges, used to tint bytes that belong to a frame. */
  function frameRanges(ctx) {
    if (ctx._hexFramesFor === ctx.result) return ctx._hexFrames;
    var ranges = ((ctx.result && ctx.result.frames) || [])
      .filter(function (f) { return f.offset != null && f.size > 0; })
      .map(function (f) { return { start: f.offset, end: f.offset + f.size, frame: f }; });
    ranges.sort(function (a, b) { return a.start - b.start; });
    ctx._hexFramesFor = ctx.result;
    ctx._hexFrames = ranges;
    return ranges;
  }

  /**
   * Index of the first entry whose node could still cover `pos`, using a
   * binary search on the offset-sorted list. A linear scan here is what made
   * a click on a late page walk the whole node list.
   */
  function firstCandidate(flat, pos) {
    var lo = 0, hi = flat.length - 1, best = flat.length;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (flat[mid].node.offset + flat[mid].node.size > pos) { best = mid; hi = mid - 1; }
      else lo = mid + 1;
    }
    return best;
  }

  /** The deepest structure covering `pos`, or null. */
  function structAt(flat, pos) {
    var best = null;
    for (var i = firstCandidate(flat, pos); i < flat.length; i++) {
      var n = flat[i].node;
      if (n.offset > pos) break;
      if (pos >= n.offset && pos < n.offset + n.size) {
        if (!best || n.size < best.node.size) best = flat[i];
      }
    }
    return best;
  }

  /* -------------------------------------------------------------- render */

  function render(ctx) {
    var grid = MA.ui.$('hexGrid');
    if (!grid) return;
    buildPageSizes();

    if (!ctx.result || !ctx.bytes) {
      MA.ui.clear(grid);
      grid.appendChild(MA.ui.el('div', 'empty', MA.ui.t('msg.empty')));
      return;
    }

    var total = ctx.bytes.length;
    var pages = Math.max(1, Math.ceil(total / state.pageSize));
    if (state.page >= pages) state.page = pages - 1;
    if (state.page < 0) state.page = 0;

    var start = state.page * state.pageSize;
    var len = Math.min(state.pageSize, total - start);

    var seq = ++state.renderSeq;
    ctx.bytes.range(start, len).then(function (bytes) {
      if (seq !== state.renderSeq) return;          // a newer render superseded this
      drawPage(ctx, bytes, start);
    }).catch(function (err) {
      if (seq !== state.renderSeq) return;
      MA.ui.clear(grid);
      grid.appendChild(MA.ui.el('div', 'empty', String(err && err.message || err)));
    });

    renderPager(ctx, pages, total);
  }

  function drawPage(ctx, bytes, pageStart) {
    var grid = MA.ui.$('hexGrid');
    MA.ui.clear(grid);

    var flat = flatten(ctx);
    var cover = computeCover(flat, frameRanges(ctx), bytes.length, pageStart, pageStart + bytes.length);

    drawn = { start: pageStart, len: bytes.length, bytes: bytes, cover: cover, flat: flat };

    var frag = doc.createDocumentFragment();
    var lineCount = Math.ceil(bytes.length / 16);
    for (var line = 0; line < lineCount; line++) {
      frag.appendChild(buildLine(bytes, pageStart, line * 16, cover));
    }
    grid.appendChild(frag);

    renderStructPanel(ctx, flat, pageStart, pageStart + bytes.length);
    updatePosInfo(ctx, flat);

    if (state.pendingScroll != null) {
      var target = state.pendingScroll;
      state.pendingScroll = null;
      var lineEl = doc.getElementById('hexline-' + (Math.floor(target / 16) * 16));
      if (lineEl && lineEl.scrollIntoView) lineEl.scrollIntoView({ block: 'center' });
    }
  }

  /** 1 = inside a structure, 2 = inside a frame (frames win). */
  function computeCover(flat, frames, len, pageStart, pageEnd) {
    var cover = new Uint8Array(len);
    var i;
    for (i = 0; i < frames.length; i++) {
      var fr = frames[i];
      if (fr.end <= pageStart) continue;
      if (fr.start >= pageEnd) break;
      var fs = Math.max(0, fr.start - pageStart);
      var fe = Math.min(len, fr.end - pageStart);
      for (var m = fs; m < fe; m++) cover[m] = 2;
    }
    // Structures only tint what a frame did not already claim.
    for (i = firstCandidate(flat, pageStart); i < flat.length; i++) {
      var n = flat[i].node;
      if (n.offset >= pageEnd) break;
      if (n.offset + n.size <= pageStart) continue;
      var s = Math.max(0, n.offset - pageStart);
      var e = Math.min(len, n.offset + n.size - pageStart);
      for (var k = s; k < e; k++) if (cover[k] !== 2) cover[k] = 1;
    }
    return cover;
  }

  function clsFor(idx) {
    var c = drawn.cover[idx];
    var base = c === 2 ? 'in-frame' : c === 1 ? 'in-struct' : '';
    return isSelected(drawn.start + idx) ? (base ? base + ' sel' : 'sel') : base;
  }

  /**
   * Build one dump line. Bytes that share a highlight class are grouped into a
   * single text run, so a typical line produces two or three spans rather than
   * thirty-two.
   */
  function buildLine(bytes, pageStart, lineStart, cover) {
    var absLine = pageStart + lineStart;
    var div = MA.ui.el('div', 'hex-line');
    div.id = 'hexline-' + absLine;
    div.dataset.line = String(absLine);

    div.appendChild(MA.ui.el('span', 'hex-addr', MA.hex(absLine, 8)));

    var hexCol = MA.ui.el('span', 'hex-bytes');
    var ascCol = MA.ui.el('span', 'hex-ascii');

    var avail = Math.min(16, bytes.length - lineStart);
    var i = 0, runs = 0;
    while (i < avail && runs < RUN_LIMIT_PER_LINE) {
      var cls = clsFor(lineStart + i);
      var j = i + 1;
      while (j < avail && clsFor(lineStart + j) === cls && runs < RUN_LIMIT_PER_LINE - 1) j++;
      if (runs === RUN_LIMIT_PER_LINE - 1) j = avail;      // last run absorbs the rest
      appendRun(hexCol, ascCol, bytes, lineStart, i, j, cls);
      i = j;
      runs++;
    }
    // Pad the tail so a short final line still lines up.
    if (avail < 16) {
      var padHex = '', padAsc = '';
      for (var k = avail; k < 16; k++) {
        padHex += (k === 7) ? '    ' : '   ';
        padAsc += (k === 7) ? '  ' : ' ';
      }
      hexCol.appendChild(doc.createTextNode(padHex));
      ascCol.appendChild(doc.createTextNode(padAsc));
    }

    div.appendChild(hexCol);
    div.appendChild(ascCol);
    return div;
  }

  /** One run = consecutive bytes with the same class, in both columns. */
  function appendRun(hexCol, ascCol, bytes, lineStart, from, to, cls) {
    var hexText = '', ascText = '';
    for (var k = from; k < to; k++) {
      var b = bytes[lineStart + k];
      hexText += (b < 16 ? '0' : '') + b.toString(16).toUpperCase();
      hexText += (k === 7) ? '  ' : ' ';
      ascText += (b >= 32 && b < 127) ? String.fromCharCode(b) : '.';
      ascText += (k === 7) ? ' ' : '';
    }

    var h = MA.ui.el('span', 'hex-run' + (cls ? ' ' + cls : ''), hexText);
    h.dataset.col = 'hex';
    h.dataset.b = String(from);
    h.dataset.n = String(to - from);
    var a = MA.ui.el('span', 'hex-run' + (cls ? ' ' + cls : ''), ascText);
    a.dataset.col = 'ascii';
    a.dataset.b = String(from);
    a.dataset.n = String(to - from);
    hexCol.appendChild(h);
    ascCol.appendChild(a);
  }

  function isSelected(abs) {
    if (state.selStart == null) return false;
    var lo = Math.min(state.selStart, state.selEnd);
    var hi = Math.max(state.selStart, state.selEnd);
    return abs >= lo && abs <= hi;
  }

  /* --------------------------------------------------------- byte picking */

  /**
   * Recover which byte a click landed on from the caret position inside the
   * run's text node. Falls back to measuring the character width when the
   * caret APIs are unavailable.
   */
  function clickedByteOffset(ev, runEl) {
    var node = runEl.firstChild;
    if (!node || node.nodeType !== 3) return null;
    var lineEl = runEl.parentNode && runEl.parentNode.parentNode;
    var lineStart = lineEl && lineEl.dataset ? Number(lineEl.dataset.line) : 0;
    var runFrom = Number(runEl.dataset.b);
    var runLen = Number(runEl.dataset.n);
    var isAscii = runEl.dataset.col === 'ascii';

    var ci = caretCharIndex(ev, runEl, node);
    if (ci == null) return null;

    // Map the character index back to a byte, accounting for the wider gap
    // that follows byte 7 of each line.
    var c = 0;
    for (var k = 0; k < runLen; k++) {
      var lineIdx = runFrom + k;
      var w = isAscii ? (lineIdx === 7 ? 2 : 1) : (lineIdx === 7 ? 4 : 3);
      if (ci < c + w) return lineStart + runFrom + k;
      c += w;
    }
    return lineStart + runFrom + runLen - 1;
  }

  function caretCharIndex(ev, runEl, textNode) {
    var range = null;
    if (doc.caretRangeFromPoint) {
      range = doc.caretRangeFromPoint(ev.clientX, ev.clientY);
    } else if (doc.caretPositionFromPoint) {
      var pos = doc.caretPositionFromPoint(ev.clientX, ev.clientY);
      if (pos) range = { startContainer: pos.offsetNode, startOffset: pos.offset };
    }
    if (range && range.startContainer === textNode) return range.startOffset;

    // Measurement fallback: monospace, so the character width is uniform.
    var rect = runEl.getBoundingClientRect();
    if (!rect.width) return null;
    var charW = rect.width / Math.max(1, textNode.length);
    var ci = Math.floor((ev.clientX - rect.left) / charW);
    return Math.max(0, Math.min(textNode.length - 1, ci));
  }

  function onGridClick(ev) {
    var runEl = ev.target && ev.target.closest ? ev.target.closest('.hex-run') : null;
    if (!runEl) return;
    var abs = clickedByteOffset(ev, runEl);
    if (abs == null) return;

    var oldLo = state.selStart == null ? null : Math.min(state.selStart, state.selEnd);
    var oldHi = state.selStart == null ? null : Math.max(state.selStart, state.selEnd);

    if (ev.shiftKey && state.anchor != null) {
      state.selStart = state.anchor;
      state.selEnd = abs;
    } else {
      state.selStart = state.selEnd = state.anchor = abs;
    }

    // Repaint only the lines whose selection state actually changed.
    repaintRange(oldLo, oldHi);
    repaintRange(Math.min(state.selStart, state.selEnd), Math.max(state.selStart, state.selEnd));

    updatePosInfo(MA.ui.ctx, drawn.flat || flatten(MA.ui.ctx));
    highlightStructPanelItem();
  }

  /** Rebuild the line elements covering [lo, hi]. */
  function repaintRange(lo, hi) {
    if (lo == null || hi == null || !drawn.bytes) return;
    var firstLine = Math.floor(lo / 16) * 16;
    var lastLine = Math.floor(hi / 16) * 16;
    for (var lineAbs = firstLine; lineAbs <= lastLine; lineAbs += 16) {
      var el = doc.getElementById('hexline-' + lineAbs);
      if (!el || !el.parentNode) continue;
      var lineStart = lineAbs - drawn.start;
      if (lineStart < 0 || lineStart >= drawn.bytes.length) continue;
      var fresh = buildLine(drawn.bytes, drawn.start, lineStart, drawn.cover);
      el.parentNode.replaceChild(fresh, el);
    }
  }

  /* --------------------------------------------------------- struct panel */

  function renderStructPanel(ctx, flat, pageStart, pageEnd) {
    var panel = MA.ui.$('hexStructList');
    if (!panel) return;
    MA.ui.clear(panel);

    var onPage = [];
    for (var i = firstCandidate(flat, pageStart); i < flat.length && onPage.length < STRUCT_LIMIT; i++) {
      var n = flat[i].node;
      if (n.offset >= pageEnd) break;
      if (n.offset + n.size > pageStart) onPage.push(flat[i]);
    }

    if (!onPage.length) {
      panel.appendChild(MA.ui.el('div', 'empty', MA.ui.t('hex.noStructures')));
      return;
    }

    var frag = doc.createDocumentFragment();
    onPage.forEach(function (entry) {
      var n = entry.node;
      var item = MA.ui.el('div', 'hex-struct-item');
      item.dataset.off = n.offset;
      item.dataset.end = n.offset + n.size;
      if (state.selStart != null && state.selStart >= n.offset && state.selStart < n.offset + n.size) {
        item.classList.add('selected');
      }
      item.appendChild(MA.ui.el('span', 's-code', n.code || n.type));
      if (n.name) item.appendChild(MA.ui.el('span', 's-name', n.name));
      item.appendChild(MA.ui.el('span', 's-off', MA.hex(n.offset, 8) + ' +' + MA.formatSize(n.size)));
      frag.appendChild(item);
    });
    panel.appendChild(frag);
  }

  function highlightStructPanelItem() {
    var panel = MA.ui.$('hexStructList');
    if (!panel || state.selStart == null) return;
    var items = panel.querySelectorAll('.hex-struct-item');
    var best = null;
    for (var i = 0; i < items.length; i++) {
      var s = Number(items[i].dataset.off);
      var e = Number(items[i].dataset.end);
      var hit = state.selStart >= s && state.selStart < e;
      items[i].classList.toggle('selected', hit);
      if (hit && (!best || (e - s) < (Number(best.dataset.end) - Number(best.dataset.off)))) {
        best = items[i];
      }
    }
    if (best && best.scrollIntoView) best.scrollIntoView({ block: 'nearest' });
  }

  function updatePosInfo(ctx, flat) {
    var info = MA.ui.$('hexPosInfo');
    if (!info) return;
    if (state.selStart == null) {
      info.textContent = MA.ui.t('hex.none');
      return;
    }
    var lo = Math.min(state.selStart, state.selEnd);
    var hi = Math.max(state.selStart, state.selEnd);
    var text = MA.hex(lo, 8) + ' – ' + MA.hex(hi, 8) + ' (' + (hi - lo + 1) + ' B)';
    var entry = structAt(flat, lo);
    if (entry) {
      var chain = entry.ancestors.concat([entry]).map(function (a) {
        return a.node.code || a.node.name || a.node.type;
      });
      text += '   ' + chain.join(' / ');
    }
    info.textContent = text;
    void ctx;
  }

  function renderPager(ctx, pages, total) {
    var pager = MA.ui.$('hexPager');
    if (!pager) return;
    MA.ui.clear(pager);

    var prev = MA.ui.el('button', 'btn btn-sm', MA.ui.t('hex.prev'));
    prev.disabled = state.page <= 0;
    prev.addEventListener('click', function () { state.page--; render(MA.ui.ctx); });

    var next = MA.ui.el('button', 'btn btn-sm', MA.ui.t('hex.next'));
    next.disabled = state.page >= pages - 1;
    next.addEventListener('click', function () { state.page++; render(MA.ui.ctx); });

    var start = state.page * state.pageSize;
    var info = MA.ui.el('span', null,
      MA.ui.t('hex.page') + ' ' + (state.page + 1) + ' ' + MA.ui.t('hex.of') + ' ' + pages +
      ' @ ' + MA.hex(start, 8) + ' — ' + MA.ui.t('hex.totalBytes', { n: total }));

    pager.appendChild(prev);
    pager.appendChild(info);
    pager.appendChild(next);
  }

  function buildPageSizes() {
    var sel = MA.ui.$('hexPageSize');
    if (!sel || sel.dataset.built) return;
    PAGE_SIZES.forEach(function (n) {
      var o = MA.ui.el('option', null, MA.formatSize(n));
      o.value = String(n);
      sel.appendChild(o);
    });
    sel.value = String(state.pageSize);
    sel.dataset.built = '1';
    sel.addEventListener('change', function () {
      state.pageSize = Number(this.value) || 4096;
      state.page = 0;
      render(MA.ui.ctx);
    });
  }

  /* ---------------------------------------------------------- navigation */

  /** Move the view to `offset` and select `size` bytes there. */
  function reveal(offset, size) {
    size = Math.max(1, size || 1);
    state.page = Math.floor(offset / state.pageSize);
    state.selStart = offset;
    state.selEnd = offset + size - 1;
    state.anchor = offset;
    state.pendingScroll = offset;
    MA.ui.showView('hex');
    // After the page paints, centre the target line.
    setTimeout(function () {
      var el = doc.getElementById('hexline-' + (Math.floor(offset / 16) * 16));
      if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' });
      var addr = MA.ui.$('hexAddr');
      if (addr) addr.value = MA.hex(offset, 8);
    }, 60);
  }

  function parseAddress(text) {
    if (!text) return null;
    var s = String(text).trim().replace(/^0x/i, '').replace(/h$/i, '');
    if (!/^[0-9a-f]+$/i.test(s)) return null;
    return parseInt(s, 16);
  }

  function init() {
    var go = MA.ui.$('btnHexGo');
    var addr = MA.ui.$('hexAddr');
    var grid = MA.ui.$('hexGrid');

    if (go && addr) {
      var doGo = function () {
        var off = parseAddress(addr.value);
        if (off == null) return;
        var total = MA.ui.ctx.bytes ? MA.ui.ctx.bytes.length : 0;
        if (off >= total) off = Math.max(0, total - 1);
        reveal(off, 1);
      };
      go.addEventListener('click', doGo);
      addr.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') doGo(); });
    }

    // ONE delegated listener for byte picking — the spans are replaced on every
    // page render, so per-element listeners would have to be re-attached each
    // time.
    if (grid) {
      grid.addEventListener('click', onGridClick);
      grid.addEventListener('keydown', function (ev) {
        if (!MA.ui.ctx.bytes) return;
        var lo = state.selStart == null ? -1 : Math.min(state.selStart, state.selEnd);
        if (ev.key === 'ArrowRight' && lo >= 0) { reveal(lo + 1, 1); ev.preventDefault(); }
        if (ev.key === 'ArrowLeft' && lo > 0) { reveal(lo - 1, 1); ev.preventDefault(); }
      });
    }
  }

  MA.ui.registerView('hex', { render: render, init: init, reveal: reveal });
  MA.ui.hex = {
    reveal: reveal,
    reset: function () {
      state.page = 0;
      state.selStart = state.selEnd = state.anchor = null;
      state.pendingScroll = null;
      drawn = { start: 0, len: 0, bytes: null, cover: null };
    },
    state: state
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
