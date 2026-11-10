/* ============================================================================
 * MediaAnalyzer — ui/structure.js
 *
 * The File Structure view: a box/element tree on the left, the selected
 * node's fields and codec tables on the right.
 *
 * Expansion state lives on the model (`node.expanded`), not in the DOM, so
 * re-rendering after a language switch keeps the tree exactly as the user
 * left it.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var filter = '';
  var selected = null;
  var expandedDefaultDepth = 3;
  // Subtrees larger than this stay collapsed by default even within the
  // default expansion depth — parsers attach up to 20k children (Ogg pages,
  // FLV tags, NAL units) to a single node.
  var AUTO_EXPAND_MAX_CHILDREN = 50;

  function render(ctx) {
    var treeRoot = MA.ui.$('treeRoot');
    var detail = MA.ui.$('nodeDetail');
    if (!treeRoot) return;

    if (!ctx.result) {
      MA.ui.clear(treeRoot);
      MA.ui.clear(detail);
      return;
    }

    // A fresh file resets the selection.
    if (selected && !nodeInTree(ctx.result.structures, selected)) selected = null;

    var search = MA.ui.$('structureSearch');
    if (search && search.value !== filter) search.value = filter;

    MA.ui.clear(treeRoot);
    var nodes = ctx.result.structures || [];
    if (!nodes.length) {
      treeRoot.appendChild(MA.ui.el('div', 'empty', MA.ui.t('st.noMatch')));
    }
    var visible = 0;
    nodes.forEach(function (n) {
      var built = buildNode(n, 0);
      if (built) { treeRoot.appendChild(built); visible++; }
    });
    if (filter && !visible) {
      treeRoot.appendChild(MA.ui.el('div', 'empty', MA.ui.t('st.noMatch')));
    }

    renderDetail(ctx);
  }

  function nodeInTree(nodes, node) {
    for (var i = 0; i < (nodes || []).length; i++) {
      if (nodes[i] === node) return true;
      if (nodeInTree(nodes[i].children, node)) return true;
    }
    return false;
  }

  function matches(node, lowerFilter) {
    if ((node.code || '').toLowerCase().indexOf(lowerFilter) >= 0) return true;
    if ((node.name || '').toLowerCase().indexOf(lowerFilter) >= 0) return true;
    return false;
  }

  function subtreeMatches(node, lowerFilter) {
    if (matches(node, lowerFilter)) return true;
    for (var i = 0; i < (node.children || []).length; i++) {
      if (subtreeMatches(node.children[i], lowerFilter)) return true;
    }
    return false;
  }

  /** @returns {Element|null} — null when the node is filtered out. */
  function buildNode(node, depth) {
    var lower = filter.toLowerCase();
    if (lower && !subtreeMatches(node, lower)) return null;

    var wrap = MA.ui.el('div', 'tree-node');
    var row = MA.ui.el('div', 'tree-row');
    if (selected === node) row.classList.add('selected');

    var hasChildren = node.children && node.children.length;
    var childCount = hasChildren ? node.children.length : 0;

    // Parsers mark bulky list nodes (tag chains, NAL streams, …) with
    // `expanded = false`. Within the default expansion depth that hint only
    // sticks for large subtrees — small ones open like everything else.
    // The flag is consumed once; afterwards the user's toggles own it.
    if (!lower && node.expanded === false && !node._expandUserTouched &&
        depth < expandedDefaultDepth && childCount > 0 && childCount <= AUTO_EXPAND_MAX_CHILDREN) {
      node.expanded = true;
    }

    var expanded = lower ? true
      : (node.expanded != null ? node.expanded
        : depth < expandedDefaultDepth && childCount <= AUTO_EXPAND_MAX_CHILDREN);

    var toggle = MA.ui.el('span', 'tree-toggle' + (hasChildren ? '' : ' leaf'),
                          hasChildren ? (expanded ? '▾' : '▸') : '•');
    row.appendChild(toggle);
    row.appendChild(MA.ui.el('span', 'tree-code', node.code || node.type || ''));
    if (node.name && node.name !== node.code) {
      row.appendChild(MA.ui.el('span', 'tree-name', node.name));
    }
    // The offset doubles as a jump link into the hex view.
    var offLink = MA.ui.el('a', 'tree-offset goto', MA.hex(node.offset, 8));
    offLink.href = '#';
    offLink.title = MA.ui.t('st.viewInHex');
    offLink.addEventListener('click', function (ev) {
      ev.preventDefault();
      ev.stopPropagation();
      MA.ui.gotoOffset(node.offset, node.size);
    });
    row.appendChild(offLink);
    row.appendChild(MA.ui.el('span', 'tree-size', MA.formatSize(node.size)));

    row.addEventListener('click', function () {
      if (hasChildren) {
        node._expandUserTouched = true;
        node.expanded = !expanded;
      }
      selected = node;
      render(MA.ui.ctx);
    });

    wrap.appendChild(row);

    if (hasChildren && expanded) {
      var kids = MA.ui.el('div', 'tree-children');
      node.children.forEach(function (c) {
        var built = buildNode(c, depth + 1);
        if (built) kids.appendChild(built);
      });
      wrap.appendChild(kids);
    } else if (hasChildren) {
      var kids2 = MA.ui.el('div', 'tree-children');
      kids2.hidden = true;
      wrap.appendChild(kids2);
    }
    return wrap;
  }

  function renderDetail(ctx) {
    var detail = MA.ui.$('nodeDetail');
    var title = MA.ui.$('nodeDetailTitle');
    if (!detail) return;
    MA.ui.clear(detail);

    if (!selected) {
      if (title) title.textContent = MA.ui.t('st.details');
      detail.appendChild(MA.ui.el('div', 'empty', MA.ui.t('st.selectNode')));
      return;
    }

    if (title) title.textContent = selected.code || selected.name || MA.ui.t('st.details');

    detail.appendChild(MA.ui.kvBlock([
      { label: MA.ui.t('st.type'), value: selected.name || selected.type },
      { label: MA.ui.t('st.size'), value: MA.formatSize(selected.size) + ' (' + selected.size + ' bytes)', mono: true },
      { label: MA.ui.t('st.offset'), value: MA.hex(selected.offset, 8), mono: true },
      { label: MA.ui.t('st.children'), value: (selected.children || []).length, mono: true }
    ]));

    var jump = MA.ui.el('button', 'btn btn-sm', MA.ui.t('st.viewInHex'));
    jump.addEventListener('click', function () {
      MA.ui.gotoOffset(selected.offset, selected.size);
    });
    detail.appendChild(jump);

    // ---- fields ----
    if (selected.fields && selected.fields.length) {
      detail.appendChild(MA.ui.el('h4', 'card-title', MA.ui.t('st.fields')));
      var table = MA.ui.el('table', 'fields');
      var thead = MA.ui.el('thead');
      var hr = MA.ui.el('tr');
      [MA.ui.t('st.field'), MA.ui.t('st.value'), MA.ui.t('st.offset')].forEach(function (label) {
        hr.appendChild(MA.ui.el('th', null, label));
      });
      thead.appendChild(hr);
      table.appendChild(thead);

      var tbody = MA.ui.el('tbody');
      var limit = 200;
      selected.fields.slice(0, limit).forEach(function (f) {
        var tr = MA.ui.el('tr', f.note ? 'note' : null);
        tr.appendChild(MA.ui.el('td', 'name', f.name || ''));
        tr.appendChild(MA.ui.el('td', 'value', f.value == null ? '' : String(f.value)));
        var tdOff = MA.ui.el('td');
        if (f.offset != null && f.offset >= 0 && f.size > 0) {
          var a = MA.ui.el('a', 'goto', MA.hex(f.offset, 8) + ' +' + MA.formatSize(f.size));
          a.href = '#';
          a.dataset.off = f.offset;
          a.dataset.size = f.size;
          a.addEventListener('click', function (ev) {
            ev.preventDefault();
            MA.ui.gotoOffset(Number(this.dataset.off), Number(this.dataset.size));
          });
          tdOff.appendChild(a);
        }
        tr.appendChild(tdOff);
        tbody.appendChild(tr);
      });
      table.appendChild(tbody);
      detail.appendChild(table);
      if (selected.fields.length > limit) {
        detail.appendChild(MA.ui.el('div', 'hint',
          '… ' + (selected.fields.length - limit) + ' more fields'));
      }
    }

    // ---- codec syntax attached to this node (avcC, esds, …) ----
    if (selected._tables && selected._tables.length) {
      detail.appendChild(MA.ui.el('h4', 'card-title', MA.ui.t('fr.tabSyntax')));
      selected._tables.forEach(function (t) {
        detail.appendChild(MA.ui.syntaxBlock(t));
      });
    }

    // ---- child shortcut list ----
    if (selected.children && selected.children.length) {
      detail.appendChild(MA.ui.el('h4', 'card-title', MA.ui.t('st.children')));
      var list = MA.ui.el('div', 'chips');
      selected.children.slice(0, 60).forEach(function (c) {
        var chip = MA.ui.el('button', 'chip', c.code + (c.name ? ' — ' + c.name : ''));
        chip.addEventListener('click', function () {
          c.expanded = true;
          selected = c;
          render(MA.ui.ctx);
        });
        list.appendChild(chip);
      });
      detail.appendChild(list);
    }
  }

  function init() {
    var search = MA.ui.$('structureSearch');
    if (search) {
      search.addEventListener('input', function () {
        filter = this.value.trim();
        render(MA.ui.ctx);
      });
    }
  }

  MA.ui.registerView('structure', { render: render, init: init });
  MA.ui.structure = {
    select: function (node) { selected = node; },
    clearSelection: function () { selected = null; }
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
