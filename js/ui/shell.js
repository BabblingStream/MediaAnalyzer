/* ============================================================================
 * MediaAnalyzer — ui/shell.js
 *
 * Shared UI infrastructure used by all four views:
 *   - DOM builders that never use innerHTML on file-derived text (a parser
 *     reading a hostile file must not be able to inject markup)
 *   - the view registry and router
 *   - syntax-table / key-value renderers shared by the structure and frame
 *     panels
 *   - loading mask, toast, and the jump-to-hex plumbing
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var doc = root.document;

  /* ------------------------------------------------------------ DOM helpers */

  /** Create an element. `text` is always set via textContent. */
  function el(tag, cls, text) {
    var n = doc.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = String(text);
    return n;
  }

  function clear(node) {
    while (node && node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function $(id) { return doc.getElementById(id); }

  function t(key, vars) { return MA.i18n.t(key, vars); }

  /** A two-column key/value block. `rows` is [{label, value, mono}]. */
  function kvBlock(rows) {
    var dl = el('dl', 'kv');
    rows.forEach(function (r) {
      if (r == null || r.value == null || r.value === '') return;
      dl.appendChild(el('dt', null, r.label));
      var dd = el('dd', r.mono ? 'mono' : null, r.value);
      dl.appendChild(dd);
    });
    return dl;
  }

  function card(title, body, badge) {
    var c = el('div', 'card');
    if (title) {
      var h = el('div', 'card-title');
      h.appendChild(el('span', null, title));
      if (badge) h.appendChild(el('span', 'badge ' + badge.cls, badge.text));
      c.appendChild(h);
    }
    if (body) c.appendChild(body);
    return c;
  }

  /**
   * Render one syntax section.
   * A section is { title, sub, rows:[{name, syntax, bits, value, note, depth,
   * group, offset}] } — the shape produced by MA.SyntaxReader.
   */
  function syntaxBlock(section) {
    var wrap = el('div', 'syntax-block');
    wrap.appendChild(el('h4', null, section.title || ''));
    if (section.sub) wrap.appendChild(el('div', 'syntax-sub', section.sub));

    if (!section.rows || !section.rows.length) {
      wrap.appendChild(el('div', 'empty', t('fr.noSyntax')));
      return wrap;
    }

    // Columns follow the standard's own layout: the syntax element name, its
    // notation (u(n)/ue(v)/…), the bit count, the decoded value, and what it
    // means. 'Syntax' and 'Bits' are spec terminology and stay in English.
    var table = el('table', 'syntax');
    var thead = el('thead');
    var hr = el('tr');
    [t('st.field'), 'Syntax', 'Bits', t('st.value'), t('hex.selection') === 'Selection' ? 'Meaning' : t('ov.notes')]
      .forEach(function (label) { hr.appendChild(el('th', null, label)); });
    thead.appendChild(hr);
    table.appendChild(thead);

    var tbody = el('tbody');
    var rowLimit = 4000;
    for (var i = 0; i < section.rows.length && i < rowLimit; i++) {
      var row = section.rows[i];
      var tr = el('tr', row.group ? 'group' : null);

      var tdName = el('td', 's-name', row.name);
      // Indent by nesting depth. Padding on the first cell — spaces collapse
      // under `white-space: nowrap` and padding on <tr> is ignored by table
      // layout, so this is the only form that reliably renders. The base 7px
      // matches the stylesheet's td padding; 14px per level ≈ two monospace
      // characters at the table's 11.5px font size.
      if (row.depth) tdName.style.paddingLeft = (7 + row.depth * 14) + 'px';
      var tdSyn = el('td', 's-syntax', row.syntax || '');
      var tdBits = el('td', 's-bits', row.bits === '' || row.bits == null ? '' : row.bits);
      var tdVal = el('td', 's-value');
      var tdNote = el('td', 's-note', row.note || '');

      // A row that knows its byte offset becomes a link into the hex view.
      var valText = row.value == null ? '' : String(row.value);
      if (!row.group && row.offset != null && row.offset >= 0 && valText.length < 200) {
        var a = el('a', null, valText);
        a.href = '#';
        a.dataset.off = row.offset;
        a.dataset.size = row.bits ? Math.max(1, Math.ceil(row.bits / 8)) : 1;
        a.addEventListener('click', function (ev) {
          ev.preventDefault();
          ui.gotoOffset(Number(this.dataset.off), Number(this.dataset.size));
        });
        tdVal.appendChild(a);
      } else {
        tdVal.textContent = valText;
      }

      tr.appendChild(tdName); tr.appendChild(tdSyn); tr.appendChild(tdBits);
      tr.appendChild(tdVal); tr.appendChild(tdNote);
      tbody.appendChild(tr);
    }
    if (section.rows.length > rowLimit) {
      var trMore = el('tr', 'group');
      var td = el('td', null, '… ' + (section.rows.length - rowLimit) + ' more rows');
      td.colSpan = 5;
      trMore.appendChild(td);
      tbody.appendChild(trMore);
    }
    table.appendChild(tbody);
    wrap.appendChild(table);
    return wrap;
  }

  /* --------------------------------------------------------- overlays */

  var toastTimer = null;
  function toast(message, isError) {
    var node = $('toast');
    if (!node) return;
    node.textContent = message;
    node.className = 'toast' + (isError ? ' error' : '');
    node.hidden = false;
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { node.hidden = true; }, isError ? 7000 : 3600);
  }

  function showLoading(text) {
    var mask = $('loadingMask');
    if (!mask) return;
    $('loadingText').textContent = text || t('msg.loading');
    mask.hidden = false;
  }
  function hideLoading() {
    var mask = $('loadingMask');
    if (mask) mask.hidden = true;
  }

  /** Yield to the browser so the loading mask actually paints before parsing. */
  function nextFrame() {
    return new Promise(function (resolve) {
      if (root.requestAnimationFrame) root.requestAnimationFrame(function () { setTimeout(resolve, 0); });
      else setTimeout(resolve, 20);
    });
  }

  /* ------------------------------------------------------ view registry */

  var views = {};
  var currentView = 'overview';

  /**
   * Every view that has markup in index.html. 'welcome' is the start screen:
   * it is pure static markup with no renderer, but it must still be a legal
   * target — treating it as unknown silently redirected the start screen to
   * the overview pane, so a freshly opened page never showed its drop zone.
   */
  var VIEW_NAMES = ['welcome', 'overview', 'structure', 'frames', 'hex'];

  function registerView(name, impl) { views[name] = impl; }

  /** Application state, owned here and shared with every view. */
  var ctx = {
    bytes: null,          // ByteSource (lazy reads after parse)
    result: null,         // parser result
    fileName: '',
    fileSize: 0,
    file: null,           // original File/Blob, when there is one
    previewUrl: null,
    blobUrl: null,
    selectedFrame: null,
    selectedNode: null
  };

  function setContext(next) {
    revokeUrls();
    ctx.bytes = next.bytes || null;
    ctx.result = next.result || null;
    ctx.fileName = next.fileName || '';
    ctx.fileSize = next.fileSize || 0;
    ctx.file = next.file || null;
    ctx.selectedFrame = null;
    ctx.selectedNode = null;
  }

  function revokeUrls() {
    if (ctx.previewUrl) { URL.revokeObjectURL(ctx.previewUrl); ctx.previewUrl = null; }
  }

  function showView(name) {
    if (VIEW_NAMES.indexOf(name) < 0) name = ctx.result ? 'overview' : 'welcome';
    // A data view without a registered renderer would show an empty pane.
    if (name !== 'welcome' && !views[name]) name = 'overview';
    currentView = name;
    VIEW_NAMES.forEach(function (v) {
      var node = $('view-' + v);
      if (node) node.hidden = (v !== name);
    });
    var items = doc.querySelectorAll('.menu-item');
    for (var i = 0; i < items.length; i++) {
      items[i].classList.toggle('active', items[i].dataset.view === name);
    }
    var view = views[name];
    if (view && view.render) {
      try { view.render(ctx); }
      catch (e) { toast('Render error: ' + (e && e.message || e), true); }
    }
  }

  function renderAll() {
    if (!ctx.result) { showView('welcome'); return; }
    Object.keys(views).forEach(function (name) {
      var v = views[name];
      if (v.render && name === currentView) {
        try { v.render(ctx); } catch (e) { /* reported by showView */ }
      }
    });
  }

  /** Re-render everything from the model — used after a language switch. */
  function rerender() {
    if (!ctx.result) { showView('welcome'); return; }
    showView(currentView);
  }

  /** Jump the hex view to an absolute offset and select that many bytes. */
  function gotoOffset(offset, size) {
    if (offset == null || offset < 0) return;
    if (views.hex && views.hex.reveal) views.hex.reveal(offset, size || 1);
  }

  var ui = {
    state: ctx,
    ctx: ctx,
    el: el,
    clear: clear,
    $: $,
    t: t,
    kvBlock: kvBlock,
    card: card,
    syntaxBlock: syntaxBlock,
    toast: toast,
    showLoading: showLoading,
    hideLoading: hideLoading,
    nextFrame: nextFrame,
    registerView: registerView,
    views: views,
    setContext: setContext,
    showView: showView,
    renderAll: renderAll,
    rerender: rerender,
    gotoOffset: gotoOffset,
    get currentView() { return currentView; }
  };

  MA.ui = ui;
})(typeof globalThis !== 'undefined' ? globalThis : this);
