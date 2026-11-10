/* ============================================================================
 * MediaAnalyzer — parsers/images.js
 *
 * Container parsers for the still-image formats:
 *
 *   png   PNG / APNG (and MNG) chunk walk — IHDR, palette, text, animation
 *   jpeg  marker walk, full Exif (TIFF) IFD resolution, DQT/DHT/SOF/SOS
 *   gif   GIF87a/89a block stream, graphic control extensions, animation
 *   webp  RIFF/WEBP chunk walk — VP8 / VP8L / VP8X / ANIM+ANMF / ALPH
 *   bmp   BITMAPFILEHEADER and every DIB header revision (CORE/INFO/V2..V5)
 *
 * Every parser is synchronous, self-contained and never throws: a damaged
 * structure is reported through `notes` and the remaining bytes are still
 * decoded. Every node/field offset is an absolute file offset so the hex view
 * can jump straight to the bytes a value was read from.
 *
 * Frame tables are built eagerly here (an image has only a handful of frames
 * and every structure is already known), which keeps the frame panel working
 * after `ctx.data` has been released.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField, nodeNote = MA.nodeNote,
      synSection = MA.synSection, hex = MA.hex, safeCount = MA.safeCount;

  /* ======================================================================
   * Shared helpers
   * ====================================================================*/

  /* Bounds-checked endian readers over a MA.ByteReader. A DataView throws on
   * an out-of-range read, so every accessor clamps against the buffer end. */
  function u16be(r, p) { return p + 2 <= r.length ? r.dv.getUint16(p) : 0; }
  function u32be(r, p) { return p + 4 <= r.length ? r.dv.getUint32(p) : 0; }
  function u16le(r, p) { return p + 2 <= r.length ? r.dv.getUint16(p, true) : 0; }
  function u32le(r, p) { return p + 4 <= r.length ? r.dv.getUint32(p, true) : 0; }
  function i32le(r, p) { return p + 4 <= r.length ? r.dv.getInt32(p, true) : 0; }
  function u24le(r, p) {
    if (p + 3 > r.length) return 0;
    return (r.u8[p] | (r.u8[p + 1] << 8) | (r.u8[p + 2] << 16)) >>> 0;
  }
  function u8at(r, p) { return p < r.length ? r.u8[p] : 0; }

  /** Latin-1 text of a byte range with NUL padding trimmed. */
  function latin1At(r, p, n) {
    var s = '', end = Math.min(p + n, r.length);
    for (var i = p; i < end; i++) s += String.fromCharCode(r.u8[i]);
    return s.replace(/\0+$/, '');
  }

  /** UTF-8 text of a byte range (falls back to Latin-1 on a decoder error). */
  function utf8At(r, p, n) {
    var end = Math.min(p + n, r.length);
    try { return new TextDecoder('utf-8').decode(r.u8.subarray(p, end)).replace(/\0+$/, ''); }
    catch (e) { return latin1At(r, p, n); }
  }

  /** Make a string safe for a table cell: strip controls, cap the length. */
  function clean(s, max) {
    s = String(s == null ? "" : s).replace(/[\u0000-\u001f\u007f]/g, " ");
    if (max && s.length > max) s = s.slice(0, max) + '…';
    return s.replace(/\s+$/, '');
  }

  /** Offset of the first NUL at/after `p`, bounded by `end`. */
  function nulAt(r, p, end) {
    var q = p;
    while (q < end && r.u8[q] !== 0) q++;
    return q;
  }

  function baseResult(formatId, formatName) {
    return {
      formatId: formatId, formatName: formatName,
      durationSec: null, bitrate: null,
      tracks: [], metadata: [], structures: [], frames: [],
      notes: [], codecContexts: {}
    };
  }

  function addMeta(res, key, value) {
    if (value == null || value === '') return;
    res.metadata.push({ key: String(key), value: String(value) });
  }

  function addNote(res, text) { res.notes.push(String(text)); }

  /**
   * Normalise a frame record.
   *   type  what the entry represents: 'image' | 'frame' | 'scan' | 'thumbnail'
   *   kind  UI tag class: 'keyframe' | 'frame' | 'audio' | 'other'
   */
  function makeFrame(o) {
    return {
      track: o.track == null ? 1 : o.track,
      index: o.index == null ? 0 : o.index,
      type: o.type || 'image',
      kind: o.kind || 'frame',
      codec: o.codec || '',
      offset: o.offset || 0,
      size: o.size || 0,
      ptsSec: o.ptsSec == null ? null : o.ptsSec,
      dtsSec: o.dtsSec == null ? (o.ptsSec == null ? null : o.ptsSec) : o.dtsSec,
      durationSec: o.durationSec == null ? null : o.durationSec,
      keyframe: !!o.keyframe,
      label: o.label || '',
      tables: o.tables || null,
      syn: o.syn || null,
      imageInfo: o.imageInfo || null,
      preview: o.preview || null
    };
  }

  /** One syntax row, matching what MA.SyntaxReader produces. */
  function row(name, syntax, bits, value, offset, note, depth) {
    return {
      name: name || '', syntax: syntax || '', bits: bits == null || bits === '' ? '' : bits,
      value: value == null ? '' : value, note: note || '',
      offset: offset == null ? 0 : offset, depth: depth || 0
    };
  }

  /** Turn an already-parsed node's fields into syntax rows (image panels). */
  function rowsOfFields(node, depth, budget) {
    var rows = [];
    if (!node) return rows;
    var fields = node.fields || [];
    for (var i = 0; i < fields.length && rows.length < (budget || 48); i++) {
      var f = fields[i];
      if (f.note) {
        rows.push(row('', '', '', f.value, node.offset, '', depth || 0));
        continue;
      }
      var known = f.size > 0;
      rows.push(row(f.name, known ? 'bytes(' + f.size + ')' : '', known ? f.size * 8 : '',
                    f.value, f.offset < 0 ? node.offset : f.offset, '', depth || 0));
    }
    return rows;
  }

  /** One eager syntax table describing a frame, built from its structure nodes. */
  function imageTables(title, sub, nodes, budget) {
    var rows = [];
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (!nd) continue;
      if (i > 0) rows.push(row('// ' + (nd.name || nd.code), '', '', '', nd.offset, '', 0));
      rows = rows.concat(rowsOfFields(nd, 0, budget || 40));
      if (rows.length >= (budget || 40)) break;
    }
    return [synSection(title, sub, rows)];
  }

  /** Eager tables from explicit rows plus an optional structure node. */
  function tables2(title, sub, rows, nodes) {
    var all = rows || [];
    if (nodes) {
      for (var i = 0; i < nodes.length; i++) {
        if (!nodes[i]) continue;
        all = all.concat(rowsOfFields(nodes[i], 0, 24));
      }
    }
    return [synSection(title, sub, all)];
  }

  /* ======================================================================
   * PNG / APNG / MNG
   * ====================================================================*/

  var PNG_COLOR_TYPES = {
    0: 'greyscale', 2: 'truecolour', 3: 'indexed colour',
    4: 'greyscale + alpha', 6: 'truecolour + alpha'
  };
  /** Samples per pixel for each colour type — used to derive the pixel depth. */
  var PNG_CHANNELS = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
  var PNG_SRGB_INTENT = ['perceptual', 'relative colorimetric', 'saturation',
                         'absolute colorimetric'];
  var PNG_DISPOSE = ['none', 'clear to background', 'restore previous'];
  var PNG_BLEND = ['source', 'over'];
  /** Pre-IDAT chunks copied when an APNG frame is rebuilt into a lone PNG. */
  var PNG_REBUILD_CHUNKS = { PLTE: 1, tRNS: 1, gAMA: 1, cHRM: 1, sRGB: 1, iCCP: 1, sBIT: 1 };
  var PNG_CHUNK_NAMES = {
    IHDR: 'Image header', PLTE: 'Palette', IDAT: 'Image data', IEND: 'Image end',
    tRNS: 'Transparency', cHRM: 'Primary chromaticities and white point',
    gAMA: 'Image gamma', iCCP: 'Embedded ICC profile', sBIT: 'Significant bits',
    sRGB: 'Standard RGB colour space', tEXt: 'Textual data',
    zTXt: 'Compressed textual data', iTXt: 'International textual data',
    bKGD: 'Background colour', hIST: 'Palette histogram', pHYs: 'Physical pixel dimensions',
    sPLT: 'Suggested palette', tIME: 'Last modification time', acTL: 'Animation control',
    fcTL: 'Frame control', fdAT: 'Frame data', MHDR: 'MNG header', MEND: 'MNG end',
    LOOP: 'MNG loop', FRAM: 'MNG frame', DEFI: 'MNG object definition',
    TERM: 'MNG termination', BACK: 'MNG background', CLIP: 'MNG clipping',
    MOVE: 'MNG move', nEED: 'MNG need', BASI: 'MNG basis', SAVE: 'MNG save',
    SEEK: 'MNG seek', eXPI: 'MNG export image', fPRI: 'MNG frame priority',
    nMAG: 'MNG magnification', DROP: 'MNG drop', PAST: 'MNG paste',
    DISC: 'MNG discard', SHOW: 'MNG show', MAGN: 'MNG magnification'
  };
  /** Well known tEXt keywords; unknown keywords are still surfaced verbatim. */
  var PNG_TEXT_KEYS = {
    Title: 'Title', Author: 'Author', Description: 'Description',
    Copyright: 'Copyright', 'Creation Time': 'Creation Time', Software: 'Software',
    Disclaimer: 'Disclaimer', Warning: 'Warning', Source: 'Source', Comment: 'Comment'
  };

  var PNG_MAX_CHUNK_NODES = 20000;

  function parsePng(ctx) {
    var res = baseResult('png', 'PNG');
    var r = new MA.ByteReader(ctx.data || new Uint8Array(0), 0);
    var n = r.length, b = r.u8;
    var root = res.structures;

    var isPng = n >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;
    var isMng = n >= 8 && b[0] === 0x8a && b[1] === 0x4d && b[2] === 0x4e && b[3] === 0x47;
    var isApng = false;

    var sig = makeNode('marker', 'SIG', isMng ? 'MNG signature' : 'PNG signature', 0, Math.min(8, n));
    if (isMng) {
      nodeField(sig, 'magic', '8A 4D 4E 47', 0, 4);
      nodeField(sig, 'MNG version', hex(b[4], 2) + ' ' + hex(b[5], 2), 4, 2);
    } else {
      nodeField(sig, 'PNG magic', '89 50 4E 47', 0, 4);
      nodeField(sig, 'CR + LF', '0D 0A', 4, 2);
      nodeField(sig, 'CTRL-Z', '1A', 6, 1);
      nodeField(sig, 'LF', '0A', 7, 1);
    }
    nodeNote(sig, isPng ? 'Valid PNG signature' :
      (isMng ? 'MNG signature — the PNG chunk walk still applies' :
               'Signature mismatch — decoding as a best-effort chunk stream'));
    root.push(sig);
    if (!isPng && !isMng) addNote(res, 'PNG signature not found; the chunk walk is a best effort.');

    /* ---- header state ---- */
    var width = 0, height = 0, bitDepth = 0, colorType = -1;
    var interlace = 0, compMethod = 0, filterMethod = 0;
    var ihdrNode = null;
    var paletteEntries = 0, hasTrns = false;
    var numFrames = 0, numPlays = 0;

    /* ---- chunk walk ---- */
    var idatStart = -1, idatEnd = -1, idatNode = null, idatChunks = 0;
    var animFrames = [];      // one record per fcTL
    var curFrame = null;      // frame being filled (IDAT or fdAT chunks)
    var preChunks = [];       // whole pre-IDAT chunks an APNG frame inherits on rebuild
    var p = 8, chunkCount = 0, truncated = false;

    while (p + 12 <= n) {
      var len = u32be(r, p);
      var type = r.fourcc(p + 4);
      var dStart = p + 8;
      var crcOff = dStart + len;
      var total = 12 + len;
      if (crcOff + 4 > n) {
        addNote(res, 'Chunk ' + type + ' at ' + hex(p, 8) + ' is truncated (' +
                    len + ' declared bytes, ' + Math.max(0, n - dStart) + ' present).');
        len = Math.max(0, Math.min(len, n - dStart));
        total = Math.min(n - p, 12 + len);
        truncated = true;
      }

      chunkCount++;
      var node = null;
      if (chunkCount <= PNG_MAX_CHUNK_NODES) {
        node = makeNode('chunk', type, PNG_CHUNK_NAMES[type] || ('Chunk ' + type),
                        p, total);
        nodeField(node, 'length', len + ' bytes', p, 4);
        nodeField(node, 'type', "'" + type + "'", p + 4, 4);
        if (crcOff + 4 <= n) {
          nodeField(node, 'CRC', hex(u32be(r, crcOff), 8), crcOff, 4);
        } else {
          nodeField(node, 'CRC', 'missing (truncated)', crcOff, 0);
        }
        root.push(node);
      } else if (chunkCount === PNG_MAX_CHUNK_NODES + 1) {
        addNote(res, 'More than ' + PNG_MAX_CHUNK_NODES +
                    ' chunks — further chunk nodes were folded away.');
      }

      try {
        /* -------- IHDR / MHDR -------- */
        if (type === 'IHDR' && len >= 13) {
          width = u32be(r, dStart);
          height = u32be(r, dStart + 4);
          bitDepth = u8at(r, dStart + 8);
          colorType = u8at(r, dStart + 9);
          compMethod = u8at(r, dStart + 10);
          filterMethod = u8at(r, dStart + 11);
          interlace = u8at(r, dStart + 12);
          ihdrNode = node || makeNode('chunk', 'IHDR', 'Image header', p, total);
          if (node) {
            nodeField(node, 'width', width, dStart, 4);
            nodeField(node, 'height', height, dStart + 4, 4);
            nodeField(node, 'bit depth', bitDepth, dStart + 8, 1);
            nodeField(node, 'colour type', colorType + ' — ' +
                      (PNG_COLOR_TYPES[colorType] || 'reserved'), dStart + 9, 1);
            nodeField(node, 'compression method', compMethod + (compMethod === 0 ? ' — deflate/inflate' : ' — reserved'), dStart + 10, 1);
            nodeField(node, 'filter method', filterMethod + (filterMethod === 0 ? ' — adaptive filtering' : ' — reserved'), dStart + 11, 1);
            nodeField(node, 'interlace method', interlace === 1 ? '1 — Adam7' :
                      interlace === 0 ? '0 — none (progressive scan)' : interlace + ' — reserved',
                      dStart + 12, 1);
            nodeNote(node, 'Colour type ' + (PNG_COLOR_TYPES[colorType] || '?') + ' — ' +
                     (PNG_CHANNELS[colorType] || 1) + ' sample(s) per pixel, ' +
                     ((PNG_CHANNELS[colorType] || 1) * bitDepth) + ' bits per pixel');
          }
          if (bitDepth === 0) addNote(res, 'IHDR declares bit depth 0 (invalid).');
        } else if (type === 'MHDR' && len >= 28 && node) {
          nodeField(node, 'frame width', u32be(r, dStart), dStart, 4);
          nodeField(node, 'frame height', u32be(r, dStart + 4), dStart + 4, 4);
          nodeField(node, 'ticks per second', u32be(r, dStart + 8), dStart + 8, 4);
          nodeField(node, 'nominal layer count', u32be(r, dStart + 12), dStart + 12, 4);
          nodeField(node, 'nominal frame count', u32be(r, dStart + 16), dStart + 16, 4);
          nodeField(node, 'nominal play time', u32be(r, dStart + 20), dStart + 20, 4);
          nodeField(node, 'simplicity profile', u32be(r, dStart + 24), dStart + 24, 4);
          width = width || u32be(r, dStart);
          height = height || u32be(r, dStart + 4);
        }

        /* -------- palette and transparency -------- */
        else if (type === 'PLTE' && node) {
          paletteEntries = Math.floor(len / 3);
          nodeField(node, 'entries', paletteEntries + ' × RGB', dStart, 0);
          if (len % 3) addNote(res, 'PLTE length ' + len + ' is not a multiple of 3.');
          var shown = Math.min(paletteEntries, 4);
          for (var pi = 0; pi < shown; pi++) {
            var po = dStart + pi * 3;
            nodeField(node, 'entry[' + pi + ']',
              '#' + hex(u8at(r, po), 2).slice(2) + hex(u8at(r, po + 1), 2).slice(2) +
              hex(u8at(r, po + 2), 2).slice(2), po, 3);
          }
          if (paletteEntries > shown) nodeNote(node, '… ' + (paletteEntries - shown) + ' more entries');
        } else if (type === 'tRNS' && node) {
          hasTrns = true;
          if (colorType === 3) {
            nodeField(node, 'alpha entries', len, dStart, 0);
          } else if (colorType === 0 && len >= 2) {
            nodeField(node, 'grey sample', u16be(r, dStart), dStart, 2);
          } else if (colorType === 2 && len >= 6) {
            nodeField(node, 'transparent red', u16be(r, dStart), dStart, 2);
            nodeField(node, 'transparent green', u16be(r, dStart + 2), dStart + 2, 2);
            nodeField(node, 'transparent blue', u16be(r, dStart + 4), dStart + 4, 2);
          }
          nodeNote(node, 'Sample values are not premultiplied by the bit depth.');
        } else if (type === 'bKGD' && node) {
          if (colorType === 3 && len >= 1) {
            nodeField(node, 'palette index', u8at(r, dStart), dStart, 1);
          } else if (colorType === 0 && len >= 2) {
            nodeField(node, 'grey', u16be(r, dStart), dStart, 2);
          } else if (len >= 6) {
            nodeField(node, 'red', u16be(r, dStart), dStart, 2);
            nodeField(node, 'green', u16be(r, dStart + 2), dStart + 2, 2);
            nodeField(node, 'blue', u16be(r, dStart + 4), dStart + 4, 2);
          }
        }

        /* -------- colour space -------- */
        else if (type === 'pHYs' && len >= 9 && node) {
          var px = u32be(r, dStart), py = u32be(r, dStart + 4), unit = u8at(r, dStart + 8);
          nodeField(node, 'pixels per unit, X', px, dStart, 4);
          nodeField(node, 'pixels per unit, Y', py, dStart + 4, 4);
          nodeField(node, 'unit specifier', unit === 1 ? '1 — metre' : '0 — unknown', dStart + 8, 1);
          if (unit === 1 && px > 0 && py > 0) {
            nodeNote(node, (px / 1000).toFixed(2) + ' × ' + (py / 1000).toFixed(2) + ' pixels/mm' +
                     ' — ' + Math.round(px * 0.0254) + ' × ' + Math.round(py * 0.0254) + ' dpi');
            addMeta(res, 'Physical resolution', Math.round(px * 0.0254) + ' × ' +
                    Math.round(py * 0.0254) + ' dpi');
          }
        } else if (type === 'gAMA' && len >= 4 && node) {
          var gamma = u32be(r, dStart) / 100000;
          nodeField(node, 'image gamma', gamma + ' (stored ×100000)', dStart, 4);
          addMeta(res, 'Gamma', gamma);
        } else if (type === 'cHRM' && len >= 32 && node) {
          var chrNames = ['white point x', 'white point y', 'red x', 'red y',
                          'green x', 'green y', 'blue x', 'blue y'];
          for (var ci = 0; ci < 8; ci++) {
            nodeField(node, chrNames[ci], (u32be(r, dStart + ci * 4) / 100000) + '', dStart + ci * 4, 4);
          }
        } else if (type === 'sRGB' && len >= 1 && node) {
          var intent = u8at(r, dStart);
          nodeField(node, 'rendering intent', intent + ' — ' + (PNG_SRGB_INTENT[intent] || 'reserved'), dStart, 1);
          addMeta(res, 'sRGB rendering intent', PNG_SRGB_INTENT[intent] || intent);
        } else if (type === 'iCCP' && node) {
          var nameEnd = nulAt(r, dStart, dStart + Math.min(len, 80));
          var profName = latin1At(r, dStart, nameEnd - dStart);
          nodeField(node, 'profile name', clean(profName, 79), dStart, Math.max(0, nameEnd - dStart));
          if (nameEnd + 1 < dStart + len) {
            nodeField(node, 'compression method', u8at(r, nameEnd + 1) === 0 ? '0 — deflate' : u8at(r, nameEnd + 1) + '', nameEnd + 1, 1);
            nodeField(node, 'compressed profile', (dStart + len - nameEnd - 2) + ' bytes',
                      nameEnd + 2, Math.max(0, dStart + len - nameEnd - 2));
          }
          if (profName) addMeta(res, 'ICC profile', profName);
        } else if (type === 'sBIT' && node) {
          var samples = PNG_CHANNELS[colorType] || 1;
          if (colorType === 3) samples = 3;
          var sbitNames = colorType === 3 ? ['red', 'green', 'blue'] :
                          (colorType === 0 || colorType === 4) ? ['grey', 'grey alpha'] :
                          ['red', 'green', 'blue', 'alpha'];
          var sbitCount = Math.min(samples, len);
          for (var si = 0; si < sbitCount; si++) {
            nodeField(node, 'significant bits — ' + (sbitNames[si] || ('sample ' + si)),
                      u8at(r, dStart + si), dStart + si, 1);
          }
        }

        /* -------- text -------- */
        else if (type === 'tEXt' && node) {
          var kEnd = nulAt(r, dStart, dStart + Math.min(len, 80));
          var key = latin1At(r, dStart, kEnd - dStart);
          var textStart = key.length + 1 <= len ? kEnd + 1 : kEnd;
          var val = clean(latin1At(r, textStart, dStart + len - textStart), 512);
          nodeField(node, 'keyword', clean(key, 79), dStart, Math.max(0, kEnd - dStart));
          if (textStart <= dStart + len) {
            nodeField(node, 'text', val, textStart, Math.max(0, dStart + len - textStart));
          }
          addMeta(res, PNG_TEXT_KEYS[key] || key || 'tEXt', val);
        } else if (type === 'zTXt' && node) {
          var zEnd = nulAt(r, dStart, dStart + Math.min(len, 80));
          var zKey = latin1At(r, dStart, zEnd - dStart);
          nodeField(node, 'keyword', clean(zKey, 79), dStart, Math.max(0, zEnd - dStart));
          if (zEnd + 1 <= dStart + len) {
            nodeField(node, 'compression method', u8at(r, zEnd + 1) === 0 ? '0 — deflate' : u8at(r, zEnd + 1) + '', zEnd + 1, 1);
            var zLen = Math.max(0, dStart + len - zEnd - 2);
            nodeField(node, 'compressed text', zLen + ' bytes', zEnd + 2, zLen);
            nodeNote(node, 'Deflate stream left compressed — the container panel does not inflate.');
          }
          addMeta(res, PNG_TEXT_KEYS[zKey] || zKey || 'zTXt',
                  '(compressed text, ' + len + ' bytes)');
        } else if (type === 'iTXt' && node) {
          var iEnd = nulAt(r, dStart, dStart + Math.min(len, 80));
          var iKey = latin1At(r, dStart, iEnd - dStart);
          nodeField(node, 'keyword', clean(iKey, 79), dStart, Math.max(0, iEnd - dStart));
          var q = iEnd + 1;
          if (q + 2 <= dStart + len) {
            var compFlag = u8at(r, q), compMethod = u8at(r, q + 1);
            nodeField(node, 'compression flag', compFlag === 1 ? '1 — compressed' : '0 — uncompressed', q, 1);
            nodeField(node, 'compression method', compMethod === 0 ? '0 — deflate' : compMethod + '', q + 1, 1);
            q += 2;
            var langEnd = nulAt(r, q, dStart + len);
            var lang = latin1At(r, q, langEnd - q);
            if (langEnd > q) nodeField(node, 'language tag', clean(lang, 32), q, langEnd - q);
            q = Math.min(langEnd + 1, dStart + len);
            var transEnd = nulAt(r, q, dStart + len);
            var trans = utf8At(r, q, transEnd - q);
            if (transEnd > q) nodeField(node, 'translated keyword', clean(trans, 79), q, transEnd - q);
            q = Math.min(transEnd + 1, dStart + len);
            var remaining = Math.max(0, dStart + len - q);
            if (remaining > 0) {
              var itext = compFlag === 0 ? utf8At(r, q, remaining) :
                '(compressed, ' + remaining + ' bytes)';
              nodeField(node, 'text', clean(itext, 512), q, remaining);
              addMeta(res, PNG_TEXT_KEYS[iKey] || iKey || 'iTXt', clean(itext, 512));
            }
          }
        } else if (type === 'tIME' && len >= 7 && node) {
          var yr = u16be(r, dStart);
          var stamp = yr + '-' + pad2(u8at(r, dStart + 2)) + '-' + pad2(u8at(r, dStart + 3)) +
                      ' ' + pad2(u8at(r, dStart + 4)) + ':' + pad2(u8at(r, dStart + 5)) +
                      ':' + pad2(u8at(r, dStart + 6)) + ' UTC';
          nodeField(node, 'last modification time', stamp, dStart, 7);
          addMeta(res, 'Last modification', stamp);
        }

        /* -------- animation (APNG) -------- */
        else if (type === 'acTL' && len >= 8 && node) {
          isApng = true;
          numFrames = u32be(r, dStart);
          numPlays = u32be(r, dStart + 4);
          nodeField(node, 'num_frames', numFrames, dStart, 4);
          nodeField(node, 'num_plays', numPlays === 0 ? '0 — infinite' : numPlays, dStart + 4, 4);
        } else if (type === 'fcTL' && len >= 26 && node) {
          isApng = true;
          var seq = u32be(r, dStart);
          var fw = u32be(r, dStart + 4), fh = u32be(r, dStart + 8);
          var fx = u32be(r, dStart + 12), fy = u32be(r, dStart + 16);
          var dn = u16be(r, dStart + 20), dd = u16be(r, dStart + 22);
          var dispose = u8at(r, dStart + 24), blend = u8at(r, dStart + 25);
          var den = dd === 0 ? 100 : dd;
          nodeField(node, 'sequence_number', seq, dStart, 4);
          nodeField(node, 'width', fw, dStart + 4, 4);
          nodeField(node, 'height', fh, dStart + 8, 4);
          nodeField(node, 'x_offset', fx, dStart + 12, 4);
          nodeField(node, 'y_offset', fy, dStart + 16, 4);
          nodeField(node, 'delay_num', dn, dStart + 20, 2);
          nodeField(node, 'delay_den', dd + (dd === 0 ? ' (treated as 100)' : ''), dStart + 22, 2);
          nodeField(node, 'dispose_op', dispose + ' — ' + (PNG_DISPOSE[dispose] || 'reserved'), dStart + 24, 1);
          nodeField(node, 'blend_op', blend + ' — ' + (PNG_BLEND[blend] || 'reserved'), dStart + 25, 1);
          nodeNote(node, 'Frame duration ' + (dn * 1000 / den).toFixed(1) + ' ms');
          curFrame = {
            ctlNode: node, offset: p, end: p + total, ctlSize: total,
            seq: seq, w: fw, h: fh, x: fx, y: fy,
            delaySec: dn / den, dispose: dispose, blend: blend,
            dataOffset: -1, dataSize: 0, usesIdat: false, parts: []
          };
          animFrames.push(curFrame);
          if (animFrames.length > 65536) {
            addNote(res, 'More than 65536 APNG frames — animation parsing stopped.');
            curFrame = null;
          }
        } else if (type === 'fdAT' && curFrame) {
          /* fdAT chunks always extend the frame opened by the preceding fcTL. */
          if (curFrame.dataOffset < 0) curFrame.dataOffset = p;
          curFrame.dataSize += total;
          curFrame.end = p + total;
          curFrame.sawFdat = true;
          /* fdAT payload minus its 4-byte sequence number is plain IDAT data —
           * kept per chunk so the frame can be rebuilt into a standalone PNG. */
          if (len >= 4) curFrame.parts.push({ offset: dStart + 4, size: len - 4 });
        } else if (type === 'IDAT' && curFrame && !curFrame.sawFdat) {
          /* The IDAT sequence belongs to the animation only when an fcTL
           * precedes it — the default image is then its first frame. */
          curFrame.usesIdat = true;
          if (curFrame.dataOffset < 0) curFrame.dataOffset = p;
          curFrame.dataSize += total;
          curFrame.end = p + total;
          curFrame.parts.push({ offset: dStart, size: len });
        }

        /* Chunks a rebuilt APNG-frame PNG must inherit from the default image. */
        if (idatStart < 0 && PNG_REBUILD_CHUNKS[type]) {
          preChunks.push({ offset: p, size: total });
        }

        /* -------- image data -------- */
        if (type === 'IDAT') {
          if (idatStart < 0) { idatStart = p; idatNode = node; }
          idatEnd = p + total;
          idatChunks++;
        }
      } catch (e) {
        addNote(res, 'Error while decoding the ' + type + ' chunk at ' + hex(p, 8) + ': ' +
                    String(e && e.message || e));
      }

      if (truncated) break;
      p += total;
      if (type === 'IEND' || type === 'MEND') break;
    }
    if (p + 12 > n && p < n && !truncated) {
      addNote(res, (n - p) + ' trailing bytes after the last chunk.');
    }

    /* ---- derived header facts ---- */
    var channels = PNG_CHANNELS[colorType] || 1;
    var alpha = colorType === 4 || colorType === 6 || hasTrns;
    if (width > 0 && height > 0 && (bitDepth === 16 || bitDepth === 8)) {
      addMeta(res, 'Image size', width + ' × ' + height);
    }
    addMeta(res, 'Bit depth', bitDepth ? bitDepth + ' bits per sample' : null);
    addMeta(res, 'Colour type', colorType >= 0 ?
            colorType + ' — ' + (PNG_COLOR_TYPES[colorType] || 'reserved') : null);
    if (interlace === 1) addMeta(res, 'Interlacing', 'Adam7');
    if (isApng) {
      addMeta(res, 'Animated', 'APNG');
      addMeta(res, 'Frame count', numFrames);
      addMeta(res, 'Loop count', numPlays === 0 ? 'infinite' : String(numPlays));
    }
    if (paletteEntries) addMeta(res, 'Palette entries', paletteEntries);
    if (hasTrns) addMeta(res, 'Transparency', 'semi-transparent samples (tRNS)');
    if (idatChunks) addMeta(res, 'IDAT chunks', idatChunks);
    if (isMng) addMeta(res, 'Container', 'MNG');

    /* ---- frames ---- */
    var totalDelay = 0;
    for (var fi = 0; fi < animFrames.length; fi++) totalDelay += animFrames[fi].delaySec;

    var usesDefault = animFrames.length > 0 && animFrames[0].usesIdat && idatStart >= 0;
    var frames = [];
    var index = 1;

    if (idatStart >= 0) {
      var mainSize = Math.max(0, idatEnd - idatStart);
      var mainLabel = 'Main image (IDAT)';
      if (usesDefault) mainLabel += ' — APNG frame 1';
      else if (isApng) mainLabel += ' — not part of the animation';
      frames.push(makeFrame({
        index: index++, track: 1, type: 'image', kind: 'keyframe', codec: 'png',
        offset: idatStart, size: mainSize,
        ptsSec: usesDefault ? 0 : null,
        durationSec: usesDefault ? animFrames[0].delaySec : null,
        keyframe: true, label: mainLabel,
        tables: tables2('PNG image data', idatStart >= 0 ?
                 (idatChunks + ' IDAT chunk(s) — ' + mainSize + ' bytes, deflate stream not inflated') : '',
                 [], [ihdrNode, idatNode]),
        syn: { codec: 'png', offset: idatStart, size: mainSize },
        imageInfo: {
          role: usesDefault ? 'APNG frame 1' : (isApng ? 'default image' : 'main'),
          width: width || null, height: height || null,
          codec: 'png', codecName: isApng ? 'PNG (APNG)' : 'PNG',
          params: (PNG_COLOR_TYPES[colorType] || '?') + ', ' + bitDepth + '-bit' +
                  (interlace === 1 ? ', Adam7' : '')
        },
        /* The whole file is a decodable PNG — slice it whole. */
        preview: { mode: 'slice', offset: 0, size: n, mime: 'image/png' }
      }));
    }

    var pts = 0, firstAnim = usesDefault ? 1 : 0;
    if (usesDefault) pts = animFrames[0].delaySec;
    for (var ai = firstAnim; ai < animFrames.length; ai++) {
      var af = animFrames[ai];
      var size = Math.max(0, af.end - af.offset);
      frames.push(makeFrame({
        index: index++, track: 1, type: 'frame', kind: 'frame', codec: 'png',
        offset: af.offset, size: size, ptsSec: pts, durationSec: af.delaySec,
        keyframe: af.dispose === 0,
        label: 'APNG frame ' + (ai + 1) + ' (seq ' + af.seq + ')',
        tables: tables2('fcTL — APNG frame control',
          'frame ' + (ai + 1) + ' of ' + Math.max(numFrames, animFrames.length) +
          ', ' + (af.delaySec * 1000).toFixed(1) + ' ms, dispose ' + (PNG_DISPOSE[af.dispose] || '?') +
          ', blend ' + (PNG_BLEND[af.blend] || '?'), [
            row('sequence_number', 'u(32)', 32, af.seq, af.ctlNode.offset + 8, '', 0),
            row('width', 'u(32)', 32, af.w, af.ctlNode.offset + 12, '', 0),
            row('height', 'u(32)', 32, af.h, af.ctlNode.offset + 16, '', 0),
            row('x_offset', 'u(32)', 32, af.x, af.ctlNode.offset + 20, '', 0),
            row('y_offset', 'u(32)', 32, af.y, af.ctlNode.offset + 24, '', 0),
            row('delay_num / delay_den', 'u(16)×2', 32, (af.delaySec * 1000).toFixed(1) + ' ms',
                af.ctlNode.offset + 28, '', 0),
            row('dispose_op', 'u(8)', 8, (PNG_DISPOSE[af.dispose] || af.dispose),
                af.ctlNode.offset + 32, '', 0),
            row('blend_op', 'u(8)', 8, (PNG_BLEND[af.blend] || af.blend),
                af.ctlNode.offset + 33, '', 0),
            row('data', '', '', af.dataSize + ' bytes in ' + (af.usesIdat ? 'IDAT' : 'fdAT') +
                ' chunk(s)', af.dataOffset < 0 ? af.offset : af.dataOffset, '', 0)
          ], [af.ctlNode]),
        syn: { codec: 'png', offset: af.offset, size: size },
        imageInfo: {
          role: 'APNG frame ' + (ai + 1),
          width: af.w || null, height: af.h || null,
          codec: 'png', codecName: 'PNG (APNG frame)',
          params: (af.delaySec * 1000).toFixed(1) + ' ms, dispose ' + (PNG_DISPOSE[af.dispose] || '?') +
                  ', blend ' + (PNG_BLEND[af.blend] || '?')
        },
        /* fcTL frames are never interlaced; rebuilt lazily into a lone PNG. */
        preview: af.parts.length ? {
          mode: 'pngRebuild', width: af.w, height: af.h,
          bitDepth: bitDepth, colorType: colorType,
          chunks: preChunks, parts: af.parts, mime: 'image/png'
        } : null
      }));
      pts += af.delaySec;
    }

    var track = {
      id: 1, type: 'image', codec: 'png', codecName: 'PNG',
      profile: isApng ? 'APNG' : (isMng ? 'MNG' : 'PNG'),
      width: width || null, height: height || null,
      bitDepth: bitDepth || null, sampleCount: frames.length,
      durationSec: isApng && totalDelay > 0 ? totalDelay : null,
      extra: [
        { label: 'Colour type', value: colorType >= 0 ? colorType + ' — ' + (PNG_COLOR_TYPES[colorType] || 'reserved') : '—' },
        { label: 'Channels', value: channels },
        { label: 'Bits per pixel', value: channels * bitDepth },
        { label: 'Alpha', value: alpha ? 'yes' : 'no' },
        { label: 'Interlace', value: interlace === 1 ? 'Adam7' : 'none' },
        { label: 'Compression', value: compMethod === 0 ? 'deflate' : String(compMethod) },
        { label: 'Filter', value: filterMethod === 0 ? 'adaptive (5 types)' : String(filterMethod) },
        { label: 'Palette', value: paletteEntries ? paletteEntries + ' entries' : 'none' }
      ]
    };
    res.tracks = [track];
    if (isApng && totalDelay > 0) {
      res.durationSec = totalDelay;
      addMeta(res, 'Animation duration', MA.formatDuration(totalDelay));
    }
    res.frames = frames;
    return res;
  }

  function pad2(v) { return (v < 10 ? '0' : '') + v; }

  /* ======================================================================
   * JPEG — marker walk, Exif (TIFF), DQT/DHT/SOF/SOS
   * ====================================================================*/

  var JPEG_MARKERS = {
    0xc0: 'SOF0 — baseline DCT', 0xc1: 'SOF1 — extended sequential DCT',
    0xc2: 'SOF2 — progressive DCT', 0xc3: 'SOF3 — lossless (sequential)',
    0xc4: 'DHT — define Huffman table', 0xc5: 'SOF5 — differential sequential DCT',
    0xc6: 'SOF6 — differential progressive DCT', 0xc7: 'SOF7 — differential lossless',
    0xc8: 'JPG — reserved', 0xc9: 'SOF9 — extended sequential, arithmetic',
    0xca: 'SOF10 — progressive, arithmetic', 0xcb: 'SOF11 — lossless, arithmetic',
    0xcc: 'DAC — arithmetic coding conditioning',
    0xcd: 'SOF13 — differential sequential, arithmetic',
    0xce: 'SOF14 — differential progressive, arithmetic',
    0xcf: 'SOF15 — differential lossless, arithmetic',
    0xd0: 'RST0', 0xd1: 'RST1', 0xd2: 'RST2', 0xd3: 'RST3',
    0xd4: 'RST4', 0xd5: 'RST5', 0xd6: 'RST6', 0xd7: 'RST7',
    0xd8: 'SOI — start of image', 0xd9: 'EOI — end of image',
    0xda: 'SOS — start of scan', 0xdb: 'DQT — define quantization table',
    0xdc: 'DNL — define number of lines', 0xdd: 'DRI — define restart interval',
    0xde: 'DHP — define hierarchical progression', 0xdf: 'EXP — expand reference components',
    0xe0: 'APP0 — JFIF / JFXX', 0xe1: 'APP1 — Exif / XMP', 0xe2: 'APP2 — ICC profile',
    0xe3: 'APP3 — meta', 0xe4: 'APP4', 0xe5: 'APP5', 0xe6: 'APP6', 0xe7: 'APP7',
    0xe8: 'APP8', 0xe9: 'APP9', 0xea: 'APP10', 0xeb: 'APP11', 0xec: 'APP12',
    0xed: 'APP13 — Photoshop IRB', 0xee: 'APP14 — Adobe', 0xef: 'APP15',
    0xfe: 'COM — comment'
  };

  var TIFF_TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
  var TIFF_TYPE_NAME = {
    1: 'BYTE', 2: 'ASCII', 3: 'SHORT', 4: 'LONG', 5: 'RATIONAL', 6: 'SBYTE',
    7: 'UNDEFINED', 8: 'SSHORT', 9: 'SLONG', 10: 'SRATIONAL', 11: 'FLOAT', 12: 'DOUBLE'
  };
  var EXIF_TAGS = {
    0x0100: 'ImageWidth', 0x0101: 'ImageLength', 0x0102: 'BitsPerSample',
    0x0103: 'Compression', 0x0106: 'PhotometricInterpretation', 0x010e: 'ImageDescription',
    0x010f: 'Make', 0x0110: 'Model', 0x0111: 'StripOffsets', 0x0112: 'Orientation',
    0x0115: 'SamplesPerPixel', 0x011a: 'XResolution', 0x011b: 'YResolution',
    0x011c: 'PlanarConfiguration', 0x0128: 'ResolutionUnit', 0x0131: 'Software',
    0x0132: 'DateTime', 0x013b: 'Artist', 0x013e: 'WhitePoint', 0x013f: 'PrimaryChromaticities',
    0x0201: 'JPEGInterchangeFormat', 0x0202: 'JPEGInterchangeFormatLength',
    0x0211: 'YCbCrCoefficients', 0x0213: 'YCbCrPositioning',
    0x8298: 'Copyright', 0x829a: 'ExposureTime', 0x829d: 'FNumber',
    0x8769: 'ExifIFDPointer', 0x8822: 'ExposureProgram', 0x8825: 'GPSInfoIFDPointer',
    0x8827: 'ISOSpeedRatings', 0x8830: 'SensitivityType', 0x9000: 'ExifVersion',
    0x9003: 'DateTimeOriginal', 0x9004: 'DateTimeDigitized', 0x9101: 'ComponentsConfiguration',
    0x9201: 'ShutterSpeedValue', 0x9202: 'ApertureValue', 0x9204: 'ExposureBiasValue',
    0x9207: 'MeteringMode', 0x9209: 'Flash', 0x920a: 'FocalLength',
    0x9291: 'SubSecTimeOriginal', 0xa000: 'FlashpixVersion', 0xa001: 'ColorSpace',
    0xa002: 'PixelXDimension', 0xa003: 'PixelYDimension', 0xa20e: 'FocalPlaneXResolution',
    0xa210: 'FocalPlaneResolutionUnit', 0xa401: 'CustomRendered', 0xa402: 'ExposureMode',
    0xa403: 'WhiteBalance', 0xa406: 'SceneCaptureType', 0xa409: 'GainControl',
    0xa40a: 'Contrast', 0xa431: 'BodySerialNumber', 0xa432: 'LensSpecification',
    0xa434: 'LensModel', 0xa435: 'LensSerialNumber'
  };
  var GPS_TAGS = {
    0x0000: 'GPSVersionID', 0x0001: 'GPSLatitudeRef', 0x0002: 'GPSLatitude',
    0x0003: 'GPSLongitudeRef', 0x0004: 'GPSLongitude', 0x0005: 'GPSAltitudeRef',
    0x0006: 'GPSAltitude', 0x0007: 'GPSTimeStamp', 0x0008: 'GPSSatellites',
    0x000c: 'GPSSpeedRef', 0x000d: 'GPSSpeed', 0x001d: 'GPSDateStamp'
  };
  var ORIENTATION_NAMES = {
    1: 'normal (0°)', 2: 'mirror horizontal', 3: 'rotate 180°',
    4: 'mirror vertical', 5: 'mirror horizontal, rotate 270° CW',
    6: 'rotate 90° CW', 7: 'mirror horizontal, rotate 90° CW',
    8: 'rotate 270° CW'
  };
  /** Tags copied into the metadata panel (values are formatted first). */
  var EXIF_META_TAGS = {
    0x010e: 'Description', 0x010f: 'Make', 0x0110: 'Model', 0x0112: 'Orientation',
    0x0131: 'Software', 0x0132: 'DateTime', 0x013b: 'Artist', 0x8298: 'Copyright',
    0x829a: 'Exposure Time', 0x829d: 'F Number', 0x8822: 'Exposure Program',
    0x8827: 'ISO', 0x9003: 'Date/Time Original', 0x9004: 'Date/Time Digitized',
    0x9204: 'Exposure Bias', 0x9207: 'Metering Mode', 0x9209: 'Flash',
    0x920a: 'Focal Length', 0xa001: 'Colour Space', 0xa002: 'Pixel X Dimension',
    0xa003: 'Pixel Y Dimension', 0xa402: 'Exposure Mode', 0xa403: 'White Balance',
    0xa434: 'Lens Model', 0xa431: 'Body Serial Number'
  };
  var JPEG_SOF_NAMES = {
    0xc0: 'Baseline DCT', 0xc1: 'Extended sequential DCT', 0xc2: 'Progressive DCT',
    0xc3: 'Lossless', 0xc5: 'Differential sequential DCT', 0xc6: 'Differential progressive DCT',
    0xc7: 'Differential lossless', 0xc9: 'Extended sequential DCT (arithmetic)',
    0xca: 'Progressive DCT (arithmetic)', 0xcb: 'Lossless (arithmetic)',
    0xcd: 'Differential sequential (arithmetic)', 0xce: 'Differential progressive (arithmetic)',
    0xcf: 'Differential lossless (arithmetic)'
  };

  function isSofMarker(m) {
    return m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
  }

  /** "4:2:0" style string derived from the SOF sampling factors. */
  function chromaSubsampling(comps) {
    if (comps.length === 1) return '4:0:0 (monochrome)';
    if (comps.length === 4) return '4:4:4 (4 components)';
    var y = comps[0], cb = comps[1], cr = comps[2];
    if (cb.h !== cr.h || cb.v !== cr.v) {
      return 'custom (H/V ' + comps.map(function (c) { return c.h + 'x' + c.v; }).join(' ') + ')';
    }
    var hr = y.h / cb.h, vr = y.v / cb.v;
    if (hr === 1 && vr === 1) return '4:4:4';
    if (hr === 2 && vr === 1) return '4:2:2';
    if (hr === 2 && vr === 2) return '4:2:0';
    if (hr === 4 && vr === 1) return '4:1:1';
    if (hr === 4 && vr === 2) return '4:1:0';
    if (hr === 1 && vr === 2) return '4:4:0';
    return 'H' + y.h + 'V' + y.v + ':H' + cb.h + 'V' + cb.v;
  }

  function parseJpeg(ctx) {
    var res = baseResult('jpeg', 'JPEG');
    var r = new MA.ByteReader(ctx.data || new Uint8Array(0), 0);
    var n = r.length, b = r.u8;
    var root = res.structures;

    var soi = makeNode('marker', 'SOI', 'Start of image', 0, 2);
    nodeField(soi, 'marker', 'FF D8', 0, 2);
    root.push(soi);
    if (!(n >= 2 && b[0] === 0xff && b[1] === 0xd8)) {
      addNote(res, 'No SOI marker — the walk starts at the first 0xFF anyway.');
    }

    var width = 0, height = 0, precision = 0, components = [];
    var sofNode = null, sofMarker = 0, sofRows = [];
    var subsampling = '';
    var scans = [];              // { offset, size, rows, node }
    var thumb = null, thumbNode = null;
    var eoiEnd = n, sawEoi = false;
    var dqtCount = 0, dhtCount = 0, app1Exif = null, iccChunks = 0, adobeTransform = -1;
    var exifBase = -1, exifEnd = -1, iccCount = 0;
    var p = 2, guard = 0;

    while (p + 1 < n && guard++ < 200000) {
      if (b[p] !== 0xff) { p++; continue; }        // resync after garbage
      var markerStart = p;
      while (p < n && b[p] === 0xff) p++;          // fill bytes
      if (p >= n) break;
      var marker = b[p++];
      if (marker === 0x00) continue;               // stuffed byte inside entropy data
      if (marker === 0xd9) {                       // EOI
        var eoi = makeNode('marker', 'FFD9', JPEG_MARKERS[0xd9], markerStart, Math.max(2, p - markerStart));
        nodeField(eoi, 'marker', 'FF D9', markerStart, p - markerStart);
        root.push(eoi);
        eoiEnd = p;
        sawEoi = true;
        break;
      }
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;                                   // TEM / RSTn: no length, no payload
      }
      if (p + 2 > n) { addNote(res, 'Truncated marker at ' + hex(markerStart, 8) + '.'); break; }
      var segLen = u16be(r, p);
      if (segLen < 2) {
        addNote(res, 'Invalid segment length ' + segLen + ' at ' + hex(p, 8) +
                    ' — marker walk stopped.');
        break;
      }
      var payloadStart = p + 2;
      var payloadEnd = p + segLen;
      if (payloadEnd > n) {
        addNote(res, 'Segment FF' + hex(marker, 2).slice(2) + ' at ' + hex(markerStart, 8) +
                    ' is truncated (' + segLen + ' declared bytes).');
        payloadEnd = n;
      }
      var code = 'FF' + hex(marker, 2).slice(2);
      var node = makeNode('marker', code, JPEG_MARKERS[marker] || ('Marker ' + code),
                          markerStart, payloadEnd - markerStart);
      nodeField(node, 'marker', 'FF ' + hex(marker, 2).slice(2), markerStart, p - markerStart);
      nodeField(node, 'length', segLen + ' bytes (including these 2)', p, 2);
      root.push(node);

      try {
        /* ---------------- frame headers ---------------- */
        if (isSofMarker(marker) && payloadStart + 6 <= payloadEnd) {
          precision = u8at(r, payloadStart);
          height = u16be(r, payloadStart + 1);
          width = u16be(r, payloadStart + 3);
          var ncomp = u8at(r, payloadStart + 5);
          var usable = safeCount(ncomp, payloadEnd - payloadStart - 6, 3);
          components = [];
          for (var ci = 0; ci < usable; ci++) {
            var cp = payloadStart + 6 + ci * 3;
            components.push({
              id: u8at(r, cp), h: u8at(r, cp + 1) >> 4, v: u8at(r, cp + 1) & 0x0f,
              tq: u8at(r, cp + 2), offset: cp
            });
            nodeField(node, 'component ' + (ci + 1) + ' — Ci', u8at(r, cp), cp, 1);
            nodeField(node, 'component ' + (ci + 1) + ' — Hi/Vi',
                      'H=' + (u8at(r, cp + 1) >> 4) + ' V=' + (u8at(r, cp + 1) & 0x0f), cp + 1, 1);
            nodeField(node, 'component ' + (ci + 1) + ' — Tqi', u8at(r, cp + 2), cp + 2, 1);
          }
          subsampling = chromaSubsampling(components);
          nodeField(node, 'P — sample precision', precision + ' bits', payloadStart, 1);
          nodeField(node, 'Y — number of lines', height, payloadStart + 1, 2);
          nodeField(node, 'X — samples per line', width, payloadStart + 3, 2);
          nodeField(node, 'Nf — number of components', ncomp, payloadStart + 5, 1);
          nodeNote(node, 'Chroma subsampling ' + subsampling);
          if (!sofNode) {
            sofNode = node;
            sofMarker = marker;
          }
          sofRows = [
            row('P — sample precision', 'u(8)', 8, precision + ' bits', payloadStart, '', 0),
            row('Y — number of lines', 'u(16)', 16, height, payloadStart + 1, '', 0),
            row('X — samples per line', 'u(16)', 16, width, payloadStart + 3, '', 0),
            row('Nf — number of components', 'u(8)', 8, ncomp, payloadStart + 5, '', 0),
            row('// component specification', '', '', '', payloadStart + 6, '', 0)
          ];
          for (var ri = 0; ri < components.length; ri++) {
            var cc = components[ri];
            sofRows.push(row('Ci[' + ri + ']', 'u(8)', 8, cc.id, cc.offset, '', 1));
            sofRows.push(row('Hi/Vi[' + ri + ']', 'u(4)+u(4)', 8, 'H=' + cc.h + ' V=' + cc.v,
                             cc.offset + 1, '', 1));
            sofRows.push(row('Tqi[' + ri + ']', 'u(8)', 8, cc.tq, cc.offset + 2, '', 1));
          }
          sofRows.push(row('chroma subsampling', '', '', subsampling, payloadStart + 6,
                           'derived from the sampling factors', 0));
          if (height === 0) addNote(res, 'SOF declares 0 lines — a DNL marker should follow.');
        }

        /* ---------------- quantization tables ---------------- */
        else if (marker === 0xdb) {
          var q = payloadStart, tables = 0;
          while (q + 65 <= payloadEnd && tables < 4) {
            var pq = u8at(r, q) >> 4, tq = u8at(r, q) & 0x0f;
            var tlen = 1 + (pq ? 128 : 64);
            if (q + tlen > payloadEnd) break;
            nodeField(node, 'table ' + tq + ' — precision', pq === 0 ? '0 — 8-bit' : '1 — 16-bit', q, 1);
            nodeField(node, 'table ' + tq + ' — destination id', tq, q, 1);
            nodeField(node, 'table ' + tq + ' — coefficients', (tlen - 1) + ' bytes', q + 1, tlen - 1);
            dqtCount++;
            q += tlen;
            tables++;
          }
          if (q < payloadEnd) nodeNote(node, (payloadEnd - q) + ' bytes not consumed.');
        }

        /* ---------------- Huffman tables ---------------- */
        else if (marker === 0xc4) {
          var h = payloadStart, hTables = 0;
          while (h + 17 <= payloadEnd && hTables < 8) {
            var tc = u8at(r, h) >> 4, th = u8at(r, h) & 0x0f;
            var symbols = 0;
            for (var k = 0; k < 16; k++) symbols += u8at(r, h + 1 + k);
            if (h + 17 + symbols > payloadEnd) break;
            nodeField(node, 'table (Tc=' + tc + ', Th=' + th + ') — class',
                      tc === 0 ? '0 — DC' : '1 — AC', h, 1);
            nodeField(node, 'table (Tc=' + tc + ', Th=' + th + ') — id', th, h, 1);
            nodeField(node, 'table (Tc=' + tc + ', Th=' + th + ') — symbols', symbols, h + 1, 16);
            dhtCount++;
            h += 17 + symbols;
            hTables++;
          }
          if (h < payloadEnd) nodeNote(node, (payloadEnd - h) + ' bytes not consumed.');
        }

        /* ---------------- restart interval ---------------- */
        else if (marker === 0xdd && payloadStart + 2 <= payloadEnd) {
          var ri = u16be(r, payloadStart);
          nodeField(node, 'Ri — restart interval', ri + ' MCU(s)', payloadStart, 2);
          addMeta(res, 'Restart interval', ri + ' MCU');
        } else if (marker === 0xdc && payloadStart + 2 <= payloadEnd) {
          var lines = u16be(r, payloadStart);
          nodeField(node, 'NL — number of lines', lines, payloadStart, 2);
          if (!height) height = lines;
        } else if (marker === 0xcc && payloadStart < payloadEnd) {
          nodeField(node, 'Tc/Tb conditioning', hex(u8at(r, payloadStart), 2), payloadStart, 1);
        }

        /* ---------------- scans ---------------- */
        else if (marker === 0xda) {
          var ns = u8at(r, payloadStart);
          var usableNs = safeCount(ns, payloadEnd - payloadStart - 1, 2);
          var sosRows = [row('Ns — number of components in scan', 'u(8)', 8, ns, payloadStart, '', 0)];
          nodeField(node, 'Ns — components in scan', ns, payloadStart, 1);
          for (var si2 = 0; si2 < usableNs; si2++) {
            var sp = payloadStart + 1 + si2 * 2;
            var cs = u8at(r, sp), tdta = u8at(r, sp + 1);
            nodeField(node, 'Cs' + (si2 + 1) + ' — component selector', cs, sp, 1);
            nodeField(node, 'Td/Ta' + (si2 + 1), 'Td=' + (tdta >> 4) + ' Ta=' + (tdta & 0x0f), sp + 1, 1);
            sosRows.push(row('Cs' + (si2 + 1) + ' — component selector', 'u(8)', 8, cs, sp, '', 1));
            sosRows.push(row('Td' + (si2 + 1) + '/Ta' + (si2 + 1), 'u(4)+u(4)', 8,
                             'Td=' + (tdta >> 4) + ' Ta=' + (tdta & 0x0f), sp + 1, '', 1));
          }
          var ssp = payloadStart + 1 + ns * 2;
          if (ssp + 3 <= payloadEnd) {
            var ss = u8at(r, ssp), se = u8at(r, ssp + 1), ahal = u8at(r, ssp + 2);
            nodeField(node, 'Ss — spectral selection start', ss, ssp, 1);
            nodeField(node, 'Se — spectral selection end', se, ssp + 1, 1);
            nodeField(node, 'Ah/Al — successive approximation',
                      'Ah=' + (ahal >> 4) + ' Al=' + (ahal & 0x0f), ssp + 2, 1);
            sosRows.push(row('Ss — spectral selection start', 'u(8)', 8, ss, ssp, '', 0));
            sosRows.push(row('Se — spectral selection end', 'u(8)', 8, se, ssp + 1, '', 0));
            sosRows.push(row('Ah / Al — successive approximation', 'u(4)+u(4)', 8,
                             'Ah=' + (ahal >> 4) + ' Al=' + (ahal & 0x0f), ssp + 2, '', 0));
          }
          /* entropy-coded data: skip to the next real marker */
          var q2 = payloadEnd;
          var guard2 = 0;
          while (q2 + 1 < n && guard2++ < n) {
            if (b[q2] === 0xff) {
              var m2 = b[q2 + 1];
              if (m2 !== 0x00 && m2 !== 0xff && !(m2 >= 0xd0 && m2 <= 0xd7)) break;
            }
            q2++;
          }
          node.size = Math.max(node.size, q2 - markerStart);
          nodeField(node, 'entropy-coded data', (q2 - payloadEnd) + ' bytes', payloadEnd, q2 - payloadEnd);
          sosRows.push(row('entropy-coded segment', '', '', (q2 - payloadEnd) + ' bytes',
                           payloadEnd, '', 0));
          scans.push({ offset: markerStart, size: q2 - markerStart, rows: sosRows, node: node });
          p = q2;
          if (q2 < n && b[q2] === 0xff) p = q2;      // outer loop re-reads the marker
          continue;
        }

        /* ---------------- APPn ---------------- */
        else if (marker === 0xe0 && payloadStart + 5 <= payloadEnd) {
          var app0id = r.fourcc(payloadStart);
          if (app0id === 'JFIF') {
            nodeField(node, 'identifier', "'JFIF' + NUL", payloadStart, 5);
            if (payloadStart + 14 <= payloadEnd) {
              nodeField(node, 'version', u8at(r, payloadStart + 5) + '.' + u8at(r, payloadStart + 6),
                        payloadStart + 5, 2);
              var units = u8at(r, payloadStart + 7);
              nodeField(node, 'units', units === 1 ? '1 — dots per inch' :
                        units === 2 ? '2 — dots per cm' : '0 — aspect ratio only', payloadStart + 7, 1);
              nodeField(node, 'X density', u16be(r, payloadStart + 8), payloadStart + 8, 2);
              nodeField(node, 'Y density', u16be(r, payloadStart + 10), payloadStart + 10, 2);
              nodeField(node, 'thumbnail', u8at(r, payloadStart + 12) + ' × ' +
                        u8at(r, payloadStart + 13) + ' pixels (RGB)', payloadStart + 12, 2);
              if (units === 1) {
                addMeta(res, 'Resolution', u16be(r, payloadStart + 8) + ' × ' +
                        u16be(r, payloadStart + 10) + ' dpi');
              }
            }
          } else if (app0id === 'JFXX') {
            var extCode = u8at(r, payloadStart + 5);
            nodeField(node, 'identifier', "'JFXX' + NUL", payloadStart, 5);
            nodeField(node, 'extension code', extCode === 0x10 ? '0x10 — JPEG thumbnail' :
                      extCode === 0x11 ? '0x11 — 1 byte/pixel palette thumbnail' :
                      extCode === 0x13 ? '0x13 — 3 bytes/pixel thumbnail' :
                      hex(extCode, 2), payloadStart + 5, 1);
          }
        } else if (marker === 0xe1 && payloadStart + 6 <= payloadEnd) {
          var app1id = latin1At(r, payloadStart, 6);
          if (app1id === 'Exif\0\0' || app1id.replace(/\0/g, '') === 'Exif') {
            nodeField(node, 'identifier', "'Exif' + NUL NUL", payloadStart, 6);
            exifBase = payloadStart + 6;
            exifEnd = payloadEnd;
            var exif = parseExifTiff(r, exifBase, exifEnd, res, node);
            app1Exif = node;
            if (exif.thumb) {
              thumb = exif.thumb;
              thumbNode = node;
              nodeField(node, 'embedded thumbnail', thumb.size + ' bytes',
                        thumb.offset, Math.min(thumb.size, 1 << 20));
              nodeNote(node, 'Thumbnail located through IFD1 tags 0x0201/0x0202');
            }
            if (exif.tagCount) {
              addMeta(res, 'Exif', exif.tagCount + ' tags (IFD0/ExifIFD' +
                      (exif.hasGps ? '/GPS' : '') + ')');
            }
          } else if (latin1At(r, payloadStart, 29).indexOf('http://ns.adobe.com/xap/1.0/') === 0) {
            var xmpIdLen = 29;                       // including the trailing NUL
            nodeField(node, 'identifier', 'XMP namespace URI', payloadStart, Math.min(xmpIdLen, payloadEnd - payloadStart));
            var pkt = Math.max(0, payloadEnd - payloadStart - xmpIdLen);
            nodeField(node, 'XMP packet', pkt + ' bytes', payloadStart + xmpIdLen, pkt);
            addMeta(res, 'XMP packet', pkt + ' bytes');
            var xmpText = latin1At(r, payloadStart + xmpIdLen, Math.min(pkt, 262144));
            var t = /<dc:title>[\s\S]{0,400}?<rdf:li[^>]*>([\s\S]{0,200}?)<\/rdf:li>/.exec(xmpText);
            if (t) addMeta(res, 'XMP Title', clean(t[1], 200));
            var cr = /<dc:creator>[\s\S]{0,400}?<rdf:li[^>]*>([\s\S]{0,120}?)<\/rdf:li>/.exec(xmpText);
            if (cr) addMeta(res, 'XMP Creator', clean(cr[1], 120));
          }
        } else if (marker === 0xe2 && payloadStart + 12 <= payloadEnd) {
          if (latin1At(r, payloadStart, 11) === 'ICC_PROFILE') {
            iccChunks++;
            iccCount = u8at(r, payloadStart + 12);
            nodeField(node, 'identifier', "'ICC_PROFILE' + NUL", payloadStart, 12);
            nodeField(node, 'chunk', u8at(r, payloadStart + 12) + ' of ' + iccCount,
                      payloadStart + 12, 2);
            nodeField(node, 'profile data', (payloadEnd - payloadStart - 14) + ' bytes',
                      payloadStart + 14, Math.max(0, payloadEnd - payloadStart - 14));
          }
        } else if (marker === 0xed && payloadStart + 14 <= payloadEnd) {
          if (latin1At(r, payloadStart, 13) === 'Photoshop 3.0') {
            nodeField(node, 'identifier', "'Photoshop 3.0' + NUL", payloadStart, 14);
            nodeField(node, 'IRB data', (payloadEnd - payloadStart - 14) + ' bytes',
                      payloadStart + 14, Math.max(0, payloadEnd - payloadStart - 14));
          }
        } else if (marker === 0xee && payloadStart + 11 <= payloadEnd) {
          if (latin1At(r, payloadStart, 5) === 'Adobe') {
            nodeField(node, 'identifier', "'Adobe'", payloadStart, 5);
            nodeField(node, 'version', u16be(r, payloadStart + 5), payloadStart + 5, 2);
            nodeField(node, 'flags0', u16be(r, payloadStart + 7), payloadStart + 7, 2);
            nodeField(node, 'flags1', u16be(r, payloadStart + 9), payloadStart + 9, 2);
            adobeTransform = u8at(r, payloadStart + 11);
            nodeField(node, 'colour transform', adobeTransform === 0 ? '0 — unknown (RGB or CMYK)' :
                      adobeTransform === 1 ? '1 — YCbCr' :
                      adobeTransform === 2 ? '2 — YCCK' : adobeTransform + ' — reserved',
                      payloadStart + 11, 1);
            addMeta(res, 'Adobe transform', adobeTransform === 1 ? 'YCbCr' :
                    adobeTransform === 2 ? 'YCCK' : adobeTransform === 0 ? 'unknown' : adobeTransform);
          }
        } else if (marker === 0xfe) {
          var comment = clean(latin1At(r, payloadStart, payloadEnd - payloadStart), 512);
          nodeField(node, 'comment', comment, payloadStart, payloadEnd - payloadStart);
          addMeta(res, 'Comment', comment);
        }
      } catch (e) {
        addNote(res, 'Error decoding marker ' + code + ' at ' + hex(markerStart, 8) + ': ' +
                    String(e && e.message || e));
      }
      p = payloadEnd;
    }
    if (!sawEoi) addNote(res, 'EOI marker not found — the file may be truncated.');

    /* ---- derived facts ---- */
    if (width && height) addMeta(res, 'Image size', width + ' × ' + height);
    var frames = [];
    var index = 1;
    if (scans.length) {
      frames.push(makeFrame({
        index: index++, track: 1, type: 'image', kind: 'keyframe', codec: 'jpeg',
        offset: 0, size: eoiEnd,
        ptsSec: null, keyframe: true,
        label: 'Main image (SOI → EOI)',
        tables: tables2('SOF — frame header and scan 1',
          (JPEG_SOF_NAMES[sofMarker] || 'SOF') + ', ' + width + ' × ' + height +
          ', ' + components.length + ' component(s), ' + subsampling,
          sofRows, [sofNode, scans[0].node, soi]),
        syn: { codec: 'jpeg', offset: 0, size: eoiEnd },
        imageInfo: {
          role: 'main', width: width || null, height: height || null,
          codec: 'jpeg', codecName: 'JPEG',
          params: (JPEG_SOF_NAMES[sofMarker] || 'JPEG') +
                  (subsampling ? ', ' + subsampling : '') + ', ' + precision + '-bit'
        },
        /* SOI → EOI is a complete decodable JPEG stream. */
        preview: { mode: 'slice', offset: 0, size: eoiEnd, mime: 'image/jpeg' }
      }));
      for (var sj = 1; sj < scans.length; sj++) {
        frames.push(makeFrame({
          index: index++, track: 1, type: 'scan', kind: 'frame', codec: 'jpeg',
          offset: scans[sj].offset, size: scans[sj].size,
          keyframe: false,
          label: 'Scan ' + (sj + 1) + ' (SOS)',
          tables: [synSection('SOS — scan header ' + (sj + 1),
            'progressive scan ' + (sj + 1) + ' of ' + scans.length, scans[sj].rows)],
          syn: { codec: 'jpeg', offset: scans[sj].offset, size: scans[sj].size }
        }));
      }
    } else {
      frames.push(makeFrame({
        index: index++, track: 1, type: 'image', kind: 'keyframe', codec: 'jpeg',
        offset: 0, size: n, keyframe: true, label: 'Main image',
        tables: tables2('SOF — frame header', 'no SOS scan was found', sofRows, [sofNode]),
        syn: { codec: 'jpeg', offset: 0, size: n },
        imageInfo: {
          role: 'main', width: width || null, height: height || null,
          codec: 'jpeg', codecName: 'JPEG',
          params: (JPEG_SOF_NAMES[sofMarker] || 'JPEG') +
                  (subsampling ? ', ' + subsampling : '') + ', ' + precision + '-bit'
        },
        preview: { mode: 'slice', offset: 0, size: n, mime: 'image/jpeg' }
      }));
      addNote(res, 'No SOS marker found — the scan structure is missing.');
    }
    if (thumb) {
      frames.push(makeFrame({
        index: index++, track: 1, type: 'thumbnail', kind: 'keyframe', codec: 'jpeg',
        offset: thumb.offset, size: thumb.size, keyframe: true,
        label: 'Exif thumbnail',
        tables: imageTables('Exif thumbnail', 'IFD1 JPEGInterchangeFormat', [thumbNode]),
        syn: { codec: 'jpeg', offset: thumb.offset, size: thumb.size },
        imageInfo: {
          role: 'Exif thumbnail', width: null, height: null,
          codec: 'jpeg', codecName: 'JPEG', params: ''
        },
        /* IFD1 points at a standalone JPEG stream inside APP1. */
        preview: { mode: 'slice', offset: thumb.offset, size: thumb.size, mime: 'image/jpeg' }
      }));
    }

    var profile = JPEG_SOF_NAMES[sofMarker] || 'JPEG';
    res.tracks = [{
      id: 1, type: 'image', codec: 'jpeg', codecName: 'JPEG',
      profile: profile,
      width: width || null, height: height || null,
      bitDepth: precision || null,
      sampleCount: frames.length,
      extra: [
        { label: 'Components', value: components.length ?
          components.length + ' (' + components.map(function (c) { return c.id; }).join(', ') + ')' : '—' },
        { label: 'Chroma subsampling', value: subsampling || '—' },
        { label: 'Scans', value: scans.length },
        { label: 'Quantization tables', value: dqtCount },
        { label: 'Huffman tables', value: dhtCount },
        { label: 'ICC profile chunks', value: iccChunks + (iccCount ? ' (of ' + iccCount + ')' : '') },
        { label: 'Exif', value: exifBase >= 0 ? 'present' : 'absent' },
        { label: 'Progressive', value: sofMarker === 0xc2 || sofMarker === 0xca ? 'yes' : 'no' }
      ]
    }];
    if (subsampling) addMeta(res, 'Chroma subsampling', subsampling);
    if (iccChunks) addMeta(res, 'ICC profile', iccChunks + ' chunk(s)');
    res.frames = frames;
    return res;
  }

  /* ----------------------------------------------------------------------
   * Exif (TIFF) — the classic trap is the value/offset rule: a value that
   * fits in 4 bytes is stored inline in the entry, everything else is an
   * offset *relative to the TIFF header base* (not to the file, not to the
   * APP1 segment). Both cases are handled below.
   * -------------------------------------------------------------------- */

  /**
   * @param {MA.ByteReader} r     reader over the whole file
   * @param {number} base         absolute offset of the TIFF header ('II'/'MM')
   * @param {number} end          absolute end of the enclosing segment
   * @param {object} res          result — metadata and notes are appended
   * @param {object} hostNode     structure node the IFD children hang off
   * @returns {{ thumb:{offset,size}|null, tagCount:number, hasGps:boolean }}
   */
  function parseExifTiff(r, base, end, res, hostNode) {
    var out = { thumb: null, tagCount: 0, hasGps: false };
    try {
      if (base + 8 > end) { addNote(res, 'Exif: TIFF header lies outside the segment.'); return out; }
      var b = r.u8;
      var le;
      if (b[base] === 0x49 && b[base + 1] === 0x49) le = true;
      else if (b[base] === 0x4d && b[base + 1] === 0x4d) le = false;
      else {
        addNote(res, 'Exif: unknown byte order marker ' + hex(b[base], 2) + ' ' + hex(b[base + 1], 2));
        return out;
      }
      function g16(p) { return le ? u16le(r, p) : u16be(r, p); }
      function g32(p) { return le ? u32le(r, p) : u32be(r, p); }

      var magic = g16(base + 2);
      if (magic !== 42) {
        addNote(res, 'Exif: TIFF magic is ' + magic + ', expected 42.');
        return out;
      }
      var ifd0 = base + g32(base + 4);

      var hdr = makeNode('entry', 'TIFF', 'TIFF header', base, 8);
      nodeField(hdr, 'byte order', le ? "'II' — little-endian" : "'MM' — big-endian", base, 2);
      nodeField(hdr, 'magic', magic + ' (0x002A)', base + 2, 2);
      nodeField(hdr, 'IFD0 offset', g32(base + 4) + ' → ' + hex(ifd0, 8), base + 4, 4);
      if (hostNode) hostNode.children.push(hdr);

      var budget = 256, visited = {}, ifdSeq = 0;

      /** Format one TIFF value; returns { text, nums }. */
      function readValue(type, count, dataOff, total) {
        var nums = [], text = '', i;
        if (total <= 0) return { text: '', nums: nums };
        if (type === 2) {                                   // ASCII
          var raw = latin1At(r, dataOff, Math.min(total, 512));
          return { text: clean(raw, 512), nums: nums };
        }
        if (type === 1 || type === 6 || type === 7) {       // BYTE / SBYTE / UNDEFINED
          var shown = Math.min(count, type === 7 ? 12 : 8);
          var parts = [];
          for (i = 0; i < shown && dataOff + i < r.length; i++) {
            var v = r.u8[dataOff + i];
            parts.push(type === 7 ? hex(v, 2) : String(type === 6 && v > 127 ? v - 256 : v));
            nums.push(type === 6 && v > 127 ? v - 256 : v);
          }
          text = parts.join(' ') + (count > shown ? ' …' : '');
          return { text: text, nums: nums };
        }
        if (type === 3 || type === 8) {                     // SHORT / SSHORT
          for (i = 0; i < count && i < 6 && dataOff + i * 2 + 2 <= r.length; i++) {
            var sv = g16(dataOff + i * 2);
            if (type === 8 && sv > 0x7fff) sv -= 0x10000;
            nums.push(sv);
          }
          text = nums.join(', ') + (count > nums.length ? ' …' : '');
          return { text: text, nums: nums };
        }
        if (type === 4 || type === 9 || type === 11) {      // LONG / SLONG / FLOAT
          for (i = 0; i < count && i < 6 && dataOff + i * 4 + 4 <= r.length; i++) {
            var lv = type === 11 ? r.dv.getFloat32(dataOff + i * 4, le)
                                 : (le ? u32le(r, dataOff + i * 4) : u32be(r, dataOff + i * 4));
            if (type === 9 && lv > 0x7fffffff) lv -= 0x100000000;
            nums.push(lv);
          }
          text = nums.join(', ') + (count > nums.length ? ' …' : '');
          return { text: text, nums: nums };
        }
        if (type === 5 || type === 10 || type === 12) {     // RATIONAL family
          var defs = type === 12 ? 8 : 8;
          for (i = 0; i < count && i < 4 && dataOff + i * defs + defs <= r.length; i++) {
            var num, den;
            if (type === 12) {
              num = r.dv.getFloat64(dataOff + i * 8, le);
              den = 1;
            } else {
              num = le ? u32le(r, dataOff + i * 8) : u32be(r, dataOff + i * 8);
              den = le ? u32le(r, dataOff + i * 8 + 4) : u32be(r, dataOff + i * 8 + 4);
              if (type === 10) {
                if (num > 0x7fffffff) num -= 0x100000000;
                if (den > 0x7fffffff) den -= 0x100000000;
              }
            }
            nums.push(den ? num / den : 0);
            text += (i ? ', ' : '') + num + '/' + den +
                    (den ? ' (' + (num / den).toFixed(4).replace(/0+$/, '').replace(/\.$/, '') + ')' : '');
          }
          return { text: text, nums: nums };
        }
        return { text: 'type ' + type + ' (' + count + ' values)', nums: nums };
      }

      /** Walk one IFD; returns the next-IFD offset (0 when none). */
      function walkIfd(off, label, names) {
        if (!off || off + 2 > end || visited[off]) return 0;
        if (ifdSeq++ > 4) return 0;
        visited[off] = 1;
        var count = g16(off);
        var usable = safeCount(count, Math.max(0, end - off - 2), 12);
        var nd = makeNode('entry', label, label + ' — ' + count + ' entries',
                          off, Math.min(end - off, 2 + count * 12 + 4));
        nodeField(nd, 'entry count', count, off, 2);
        if (usable < count) {
          nodeNote(nd, (count - usable) + ' entries lie past the segment end and were ignored');
        }
        if (hostNode) hostNode.children.push(nd);

        var subIfd = 0, gpsIfd = 0, thumbOff = -1, thumbLen = 0, next = 0;
        for (var i = 0; i < usable && budget > 0; i++, budget--) {
          var e = off + 2 + i * 12;
          var tag = g16(e), type = g16(e + 2), cnt = g32(e + 4);
          var tsize = TIFF_TYPE_SIZE[type] || 0;
          var total = tsize * cnt;
          var dataOff = e + 8;                       // inline value
          var outside = false;
          if (total > 4) {
            dataOff = base + g32(e + 8);             // out-of-line, relative to the TIFF base
            if (dataOff <= 0 || dataOff > r.length) outside = true;
            else if (dataOff + total > end) outside = true;
          }
          var res1 = outside ? { text: 'value outside the segment (' + hex(base + g32(e + 8), 8) + ')', nums: [] }
                             : readValue(type, cnt, dataOff, total);
          var tagName = (names && names[tag]) || EXIF_TAGS[tag] || ('Tag 0x' + hex(tag, 4).slice(2));
          var text = res1.text;
          if (tag === 0x0112 && res1.nums.length) {
            text = res1.nums[0] + ' — ' + (ORIENTATION_NAMES[res1.nums[0]] || 'reserved');
          } else if (tag === 0x829a && res1.nums.length) {
            text = res1.text + ' s';
          } else if (tag === 0x829d && res1.nums.length) {
            text = res1.text + '  (f/' + res1.nums[0] + ')';
          } else if (tag === 0x920a && res1.nums.length) {
            text = res1.text + ' mm';
          } else if (tag === 0x9204 && res1.nums.length) {
            text = res1.text + ' EV';
          } else if (tag === 0xa001 && res1.nums.length) {
            text = res1.nums[0] === 1 ? '1 — sRGB' : res1.nums[0] === 0xffff ? '0xFFFF — uncalibrated' : res1.text;
          }
          nodeField(nd, tagName, clean(text, 300) + '  [' + (TIFF_TYPE_NAME[type] || ('type ' + type)) +
                    ' × ' + cnt + ']', e, 12);
          if (tag === 0x8769) subIfd = base + g32(e + 8);
          else if (tag === 0x8825) { gpsIfd = base + g32(e + 8); out.hasGps = true; }
          else if (tag === 0x0201) thumbOff = g32(e + 8);
          else if (tag === 0x0202) thumbLen = g32(e + 8);
          out.tagCount++;
          if (names && !hostNode) { /* GPS IFD stays out of the metadata panel */ }
          if (EXIF_META_TAGS[tag] && res1.text) addMeta(res, EXIF_META_TAGS[tag], clean(text, 300));
        }
        if (off + 2 + count * 12 + 4 <= end) next = g32(off + 2 + count * 12);
        if (thumbOff > 0 && thumbLen > 0) {
          var abs = base + thumbOff;
          if (abs + thumbLen <= end && abs >= 0) out.thumb = { offset: abs, size: thumbLen };
        }
        if (subIfd) walkIfd(subIfd, 'Exif SubIFD', null);
        if (gpsIfd) walkIfd(gpsIfd, 'GPS IFD', GPS_TAGS);
        return next;
      }

      var nextIfd = walkIfd(ifd0, 'IFD0', null);
      if (nextIfd) walkIfd(base + nextIfd, 'IFD1', null);
      if (budget <= 0) addNote(res, 'Exif: more than 256 tags — the rest were skipped.');
    } catch (e) {
      addNote(res, 'Exif: ' + String(e && e.message || e));
    }
    return out;
  }

  /* ======================================================================
   * GIF
   * ====================================================================*/

  var GIF_DISPOSAL = ['unspecified', 'do not dispose', 'restore to background',
                      'restore to previous', 'reserved (4)', 'reserved (5)',
                      'reserved (6)', 'reserved (7)'];

  function skipSubBlocks(r, p, end, limit) {
    var blocks = 0;
    while (p < end) {
      var len = r.u8[p];
      p += 1 + len;
      if (len === 0) break;
      if (++blocks > (limit || 4096)) break;
    }
    return Math.min(p, end);
  }

  function parseGif(ctx) {
    var res = baseResult('gif', 'GIF');
    var r = new MA.ByteReader(ctx.data || new Uint8Array(0), 0);
    var n = r.length;
    var root = res.structures;

    if (n < 13) { addNote(res, 'File too short for a GIF header (' + n + ' bytes).'); return res; }

    var version = latin1At(r, 0, 6);
    if (version !== 'GIF87a' && version !== 'GIF89a') {
      addNote(res, 'Unexpected GIF signature "' + clean(version, 8) + '".');
    }
    var width = u16le(r, 6), height = u16le(r, 8);
    var packed = u8at(r, 10);
    var gctFlag = !!(packed & 0x80);
    var colorRes = ((packed >> 4) & 0x07) + 1;
    var sortFlag = !!(packed & 0x08);
    var gctSize = 1 << ((packed & 0x07) + 1);
    var bgIndex = u8at(r, 11), aspect = u8at(r, 12);

    var hdr = makeNode('marker', 'HEADER', 'GIF header and logical screen descriptor', 0, 13);
    nodeField(hdr, 'signature', "'" + version + "'", 0, 6);
    nodeField(hdr, 'logical screen width', width, 6, 2);
    nodeField(hdr, 'logical screen height', height, 8, 2);
    nodeField(hdr, 'global colour table flag', gctFlag ? '1 — present' : '0 — absent', 10, 1);
    nodeField(hdr, 'colour resolution', colorRes + ' bits per primary', 10, 1);
    nodeField(hdr, 'sort flag', sortFlag ? '1 — sorted by decreasing frequency' : '0', 10, 1);
    nodeField(hdr, 'size of global colour table', gctFlag ? gctSize + ' entries' : 'n/a', 10, 1);
    nodeField(hdr, 'background colour index', bgIndex, 11, 1);
    nodeField(hdr, 'pixel aspect ratio', aspect === 0 ? '0 — no ratio given' :
              ((aspect + 15) / 64).toFixed(3), 12, 1);
    root.push(hdr);

    addMeta(res, 'Version', version);
    addMeta(res, 'Logical screen', width + ' × ' + height);
    addMeta(res, 'Background colour index', bgIndex);

    var p = 13;
    if (gctFlag && p + gctSize * 3 <= n) {
      var gct = makeNode('table', 'GCT', 'Global colour table', p, gctSize * 3);
      nodeField(gct, 'entries', gctSize + ' × RGB', p, 0);
      for (var gi = 0; gi < Math.min(gctSize, 4); gi++) {
        var go = p + gi * 3;
        nodeField(gct, 'entry[' + gi + ']',
          '#' + hex(u8at(r, go), 2).slice(2) + hex(u8at(r, go + 1), 2).slice(2) +
          hex(u8at(r, go + 2), 2).slice(2), go, 3);
      }
      if (gctSize > 4) nodeNote(gct, '… ' + (gctSize - 4) + ' more entries');
      root.push(gct);
      p += gctSize * 3;
      addMeta(res, 'Global colour table', gctSize + ' entries');
    } else if (gctFlag) {
      addNote(res, 'The global colour table extends past the end of the file.');
      p = n;
    }

    var frames = [];
    var pendingGce = null;        // applies to the next image descriptor
    var pendingDelay = 0;
    var loopCount = null, hasLoop = false;
    var totalDelay = 0;
    var imageCount = 0, elapsed = 0, guard = 0, extCount = 0;
    var truncated = false;

    while (p < n && guard++ < 500000) {
      var b = r.u8[p];
      if (b === 0x3b) {
        var trail = makeNode('marker', 'TRAILER', 'GIF trailer', p, 1);
        nodeField(trail, 'trailer', '3B', p, 1);
        root.push(trail);
        p++;
        break;
      }

      /* ---- extensions ---- */
      if (b === 0x21) {
        if (p + 2 > n) { addNote(res, 'Truncated extension header at ' + hex(p, 8)); break; }
        var label = r.u8[p + 1];
        var q = p + 2;
        if (label === 0xf9) {                                       // graphic control
          var blockSize = u8at(r, q);
          var gce = makeNode('ext', 'GCE', 'Graphic control extension', p, Math.min(n - p, 3 + blockSize + 1));
          if (blockSize >= 4 && q + 5 <= n) {
            var gp = u8at(r, q + 1);
            pendingDelay = u16le(r, q + 2);
            var transIndex = u8at(r, q + 4);
            pendingGce = { node: gce, disposal: (gp >> 2) & 0x07,
                           userInput: !!(gp & 0x02), transparency: !!(gp & 0x01),
                           delay: pendingDelay, transIndex: transIndex };
            nodeField(gce, 'block size', blockSize, q, 1);
            nodeField(gce, 'disposal method', ((gp >> 2) & 0x07) + ' — ' +
                      (GIF_DISPOSAL[(gp >> 2) & 0x07] || 'reserved'), q + 1, 1);
            nodeField(gce, 'user input flag', (gp & 0x02) ? '1 — waits for user input' : '0', q + 1, 1);
            nodeField(gce, 'transparent colour flag', (gp & 0x01) ? '1 — index is transparent' : '0', q + 1, 1);
            nodeField(gce, 'delay time', pendingDelay + ' (1/100 s = ' +
                      (pendingDelay * 10) + ' ms)', q + 2, 2);
            nodeField(gce, 'transparent colour index', transIndex, q + 4, 1);
          } else {
            nodeNote(gce, 'Graphic control block shorter than 4 bytes');
          }
          root.push(gce);
          p = skipSubBlocks(r, q + blockSize, n);
          continue;
        }
        if (label === 0xff) {                                       // application
          var appLen = u8at(r, q);
          var appId = latin1At(r, q + 1, Math.min(appLen, 11));
          var app = makeNode('ext', 'APP', 'Application extension: ' + clean(appId, 11), p, 0);
          nodeField(app, 'application identifier', "'" + clean(appId, 11) + "'", q + 1, Math.min(appLen, 11));
          if (appId.indexOf('NETSCAPE') === 0 || appId.indexOf('ANIMEXTS') === 0) {
            var sub = q + 1 + appLen;
            var subGuard = 0;
            while (sub < n && r.u8[sub] !== 0 && subGuard++ < 256) {
              var subLen = r.u8[sub];
              if (subLen >= 3 && r.u8[sub + 1] === 0x01) {
                loopCount = u16le(r, sub + 2);
                hasLoop = true;
                nodeField(app, 'loop count', loopCount === 0 ? '0 — infinite' : loopCount, sub + 2, 2);
              }
              sub += 1 + subLen;
            }
            nodeNote(app, 'NETSCAPE2.0 animation loop block');
            p = skipSubBlocks(r, q + 1 + appLen, n);
          } else {
            p = skipSubBlocks(r, q + 1 + appLen, n);
          }
          app.size = Math.min(n, p) - app.offset;
          root.push(app);
          extCount++;
          continue;
        }
        if (label === 0xfe) {                                       // comment
          var cLen = u8at(r, q);
          var cEnd = skipSubBlocks(r, q, n);
          var text = clean(latin1At(r, q + 1, Math.max(0, cEnd - q - 2)), 512);
          var com = makeNode('ext', 'COM', 'Comment extension', p, Math.max(0, cEnd - p));
          nodeField(com, 'data sub-blocks', Math.max(0, cEnd - q - 1) + ' bytes', q, Math.max(0, Math.min(cLen, cEnd - q - 1)));
          nodeField(com, 'text', text, q + 1, Math.max(0, cEnd - q - 2));
          root.push(com);
          extCount++;
          if (text) addMeta(res, 'Comment', text);
          p = cEnd;
          continue;
        }
        if (label === 0x01) {                                       // plain text
          var ptLen = u8at(r, q);
          var ptEnd = skipSubBlocks(r, q + 1 + ptLen, n);
          var plain = makeNode('ext', 'PTEXT', 'Plain text extension', p, Math.max(0, ptEnd - p));
          if (ptLen >= 12) {
            nodeField(plain, 'grid left', u16le(r, q + 1), q + 1, 2);
            nodeField(plain, 'grid top', u16le(r, q + 3), q + 3, 2);
            nodeField(plain, 'grid width', u16le(r, q + 5), q + 5, 2);
            nodeField(plain, 'grid height', u16le(r, q + 7), q + 7, 2);
            nodeField(plain, 'character cell width', u8at(r, q + 9), q + 9, 1);
            nodeField(plain, 'character cell height', u8at(r, q + 10), q + 10, 1);
            nodeField(plain, 'foreground colour index', u8at(r, q + 11), q + 11, 1);
            nodeField(plain, 'background colour index', u8at(r, q + 12), q + 12, 1);
          }
          root.push(plain);
          extCount++;
          p = ptEnd;
          continue;
        }
        /* unknown extension: skip its sub-block chain */
        var uEnd = skipSubBlocks(r, q + (u8at(r, q) || 0) + 1, n);
        var unk = makeNode('ext', 'EXT', 'Extension 0x' + hex(label, 2).slice(2), p, Math.max(0, uEnd - p));
        nodeField(unk, 'label', hex(label, 2), p + 1, 1);
        root.push(unk);
        extCount++;
        p = uEnd;
        continue;
      }

      /* ---- image descriptor ---- */
      if (b === 0x2c) {
        if (p + 10 > n) { addNote(res, 'Truncated image descriptor at ' + hex(p, 8)); break; }
        imageCount++;
        var iw = u16le(r, p + 5), ih = u16le(r, p + 7);
        var ip = u8at(r, p + 9);
        var lctFlag = !!(ip & 0x80), interlace = !!(ip & 0x40);
        var lctSize = 1 << ((ip & 0x07) + 1);
        var img = makeNode('image', 'IMAGE', 'Image descriptor #' + imageCount, p, 0);
        nodeField(img, 'image separator', '2C', p, 1);
        nodeField(img, 'image left position', u16le(r, p + 1), p + 1, 2);
        nodeField(img, 'image top position', u16le(r, p + 3), p + 3, 2);
        nodeField(img, 'image width', iw, p + 5, 2);
        nodeField(img, 'image height', ih, p + 7, 2);
        nodeField(img, 'local colour table flag', lctFlag ? '1 — present' : '0 — absent', p + 9, 1);
        nodeField(img, 'interlace flag', interlace ? '1 — interlaced (4-pass)' : '0 — sequential', p + 9, 1);
        nodeField(img, 'sort flag', (ip & 0x20) ? '1 — sorted' : '0', p + 9, 1);
        nodeField(img, 'size of local colour table', lctFlag ? lctSize + ' entries' : 'n/a', p + 9, 1);

        var q3 = p + 10;
        if (lctFlag && q3 + lctSize * 3 <= n) {
          nodeField(img, 'local colour table', lctSize + ' × RGB', q3, lctSize * 3);
          q3 += lctSize * 3;
        } else if (lctFlag) {
          addNote(res, 'Local colour table of image #' + imageCount + ' runs past the end.');
          q3 = n;
        }
        var minCodeSize = u8at(r, q3);
        nodeField(img, 'LZW minimum code size', minCodeSize, q3, 1);
        var blocksStart = q3 + 1;
        var dataEnd = skipSubBlocks(r, blocksStart, n);
        var lzwBytes = Math.max(0, dataEnd - blocksStart - 1);   // minus the terminator
        nodeField(img, 'LZW image data', lzwBytes + ' bytes in sub-blocks', blocksStart, Math.max(0, dataEnd - blocksStart));
        img.size = Math.min(n, dataEnd) - p;
        if (dataEnd > n) truncated = true;
        root.push(img);

        var framesRows = rowsOfFields(img, 0, 32);
        if (pendingGce) {
          framesRows = framesRows.concat(rowsOfFields(pendingGce.node, 0, 12));
          framesRows.push(row('// display', '', '',
            (pendingDelay * 10) + ' ms, disposal ' + (GIF_DISPOSAL[pendingGce.disposal] || '?') +
            ', transparency ' + (pendingGce.transparency ? 'index ' + pendingGce.transIndex : 'none'),
            p, '', 0));
        }

        frames.push(makeFrame({
          index: imageCount,
          track: 1,
          type: imageCount === 1 ? 'image' : 'frame',
          kind: 'keyframe',
          codec: 'gif',
          offset: p,
          size: img.size,
          ptsSec: elapsed,
          durationSec: pendingDelay / 100,
          keyframe: true,
          label: imageCount === 1 ? 'Main image' : ('Frame ' + imageCount),
          tables: [synSection('GIF image descriptor #' + imageCount,
            iw + ' × ' + ih + ' at (' + u16le(r, p + 1) + ', ' + u16le(r, p + 3) + ')' +
            (interlace ? ', interlaced' : '') + (lctFlag ? ', local colour table' : ''),
            framesRows)],
          syn: { codec: 'gif', offset: p, size: img.size }
        }));

        elapsed += pendingDelay / 100;
        totalDelay += pendingDelay;
        pendingDelay = 0;
        pendingGce = null;
        p = dataEnd;
        continue;
      }

      /* unknown byte — resync one byte forward */
      addNote(res, 'Unexpected byte ' + hex(b, 2) + ' at ' + hex(p, 8) + ' — skipped.');
      p++;
    }

    if (imageCount === 0) addNote(res, 'No image descriptor found in the block stream.');
    if (loopCount != null || hasLoop) {
      addMeta(res, 'Loop count', loopCount === 0 ? 'infinite' : String(loopCount));
    }
    if (imageCount > 1 || hasLoop) {
      addMeta(res, 'Animated', 'yes');
      addMeta(res, 'Frame count', imageCount);
      res.durationSec = totalDelay / 100;
      addMeta(res, 'Animation duration', MA.formatDuration(res.durationSec));
    }
    void truncated; void extCount;

    res.tracks = [{
      id: 1, type: 'image', codec: 'gif', codecName: 'GIF',
      profile: version,
      width: width || null, height: height || null,
      bitDepth: colorRes,
      sampleCount: imageCount,
      durationSec: res.durationSec,
      extra: [
        { label: 'Version', value: version },
        { label: 'Frame count', value: imageCount },
        { label: 'Colour resolution', value: colorRes + ' bits' },
        { label: 'Global colour table', value: gctFlag ? gctSize + ' entries' : 'none' },
        { label: 'Loop count', value: loopCount == null ? '—' : (loopCount === 0 ? 'infinite' : String(loopCount)) }
      ]
    }];
    res.frames = frames;
    return res;
  }

  /* ======================================================================
   * WebP (RIFF container)
   * ====================================================================*/

  /**
   * VP8 lossy key-frame geometry. The 14-bit width/height live in two
   * *little-endian* 16-bit words (bits 0..13 are the size, 14..15 the scale),
   * which is the opposite of the usual big-endian bit packing.
   */
  function parseVP8(r, dStart, size, node, res, out) {
    if (size < 10) { addNote(res, 'VP8 chunk is only ' + size + ' bytes — too short.'); return; }
    var tag = (u8at(r, dStart) | (u8at(r, dStart + 1) << 8) | (u8at(r, dStart + 2) << 16)) >>> 0;
    var keyFrame = (tag & 1) === 0;
    var version = (tag >> 1) & 7;
    var showFrame = (tag >> 4) & 1;
    var firstPart = (tag >>> 5) & 0x7ffff;
    nodeField(node, 'frame tag', hex(tag, 6) + ' (24-bit LSB-first)', dStart, 3);
    nodeField(node, 'frame type', keyFrame ? '0 — key frame' : '1 — inter frame', dStart, 1);
    nodeField(node, 'version', version, dStart, 1);
    nodeField(node, 'show_frame', showFrame, dStart, 1);
    nodeField(node, 'first partition size', firstPart + ' bytes', dStart, 3);
    out.keyFrame = keyFrame;
    out.version = version;
    if (!keyFrame) return;
    if (!(u8at(r, dStart + 3) === 0x9d && u8at(r, dStart + 4) === 0x01 && u8at(r, dStart + 5) === 0x2a)) {
      addNote(res, 'VP8 key frame start code 9D 01 2A is missing.');
      return;
    }
    nodeField(node, 'start code', '9D 01 2A', dStart + 3, 3);
    var wRaw = u16le(r, dStart + 6), hRaw = u16le(r, dStart + 8);
    out.width = wRaw & 0x3fff;
    out.height = hRaw & 0x3fff;
    out.hScale = wRaw >> 14;
    out.vScale = hRaw >> 14;
    nodeField(node, 'width', out.width + ' (14-bit, little-endian word)', dStart + 6, 2);
    nodeField(node, 'horizontal scale', out.hScale, dStart + 6, 0);
    nodeField(node, 'height', out.height + ' (14-bit, little-endian word)', dStart + 8, 2);
    nodeField(node, 'vertical scale', out.vScale, dStart + 8, 0);
  }

  /**
   * VP8L lossless header: signature 0x2F then a 32-bit *LSB-first* packed
   * block — width-1 (14 bits), height-1 (14 bits), alpha (1), version (3).
   * Bits must be pulled from the least significant bit upwards.
   */
  function parseVP8L(r, dStart, size, node, res, out) {
    if (size < 5) { addNote(res, 'VP8L chunk is only ' + size + ' bytes — too short.'); return; }
    if (u8at(r, dStart) !== 0x2f) {
      addNote(res, 'VP8L signature byte 0x2F missing (found ' + hex(u8at(r, dStart), 2) + ').');
    }
    nodeField(node, 'signature', hex(u8at(r, dStart), 2), dStart, 1);
    var packed = u32le(r, dStart + 1);
    out.width = (packed & 0x3fff) + 1;
    out.height = ((packed >>> 14) & 0x3fff) + 1;
    out.alpha = ((packed >>> 28) & 1) === 1;
    out.version = (packed >>> 29) & 7;
    nodeField(node, 'packed size block', hex(packed, 8) + ' (32-bit LSB-first)', dStart + 1, 4);
    nodeField(node, 'width − 1', out.width - 1 + ' (bits 0..13 → width ' + out.width + ')', dStart + 1, 0);
    nodeField(node, 'height − 1', out.height - 1 + ' (bits 14..27 → height ' + out.height + ')', dStart + 4, 0);
    nodeField(node, 'alpha_is_used', out.alpha ? '1 — alpha channel present' : '0', dStart + 4, 1);
    nodeField(node, 'version', out.version, dStart + 4, 1);
    out.codec = 'vp8l';
  }

  function parseWebp(ctx) {
    var res = baseResult('webp', 'WebP');
    var r = new MA.ByteReader(ctx.data || new Uint8Array(0), 0);
    var n = r.length;
    var root = res.structures;

    var riffSize = u32le(r, 4);
    var riff = makeNode('chunk', 'RIFF', 'RIFF container', 0,
                        Math.min(n, riffSize ? 8 + riffSize : n));
    nodeField(riff, 'chunk id', "'RIFF'", 0, 4);
    nodeField(riff, 'size', riffSize + ' bytes (file size − 8)', 4, 4);
    nodeField(riff, 'form type', "'" + r.fourcc(8) + "'", 8, 4);
    root.push(riff);
    if (r.fourcc(0) !== 'RIFF' || r.fourcc(8) !== 'WEBP') {
      addNote(res, 'Not a RIFF/WEBP container — decoding as a best effort.');
    }
    if (riffSize + 8 > n) {
      addNote(res, 'RIFF size declares ' + (riffSize + 8) + ' bytes but the file holds ' + n + '.');
    }

    var out = {
      width: 0, height: 0, canvasWidth: 0, canvasHeight: 0,
      alpha: false, animated: false, codec: '', version: 0,
      hasIcc: false, hasExif: false, hasXmp: false
    };
    var stillNode = null, frameCount = 0, loopCount = null, totalDuration = 0;
    var animFrames = [];
    var p = 12, guard = 0, chunkNodes = 0;

    while (p + 8 <= n && guard++ < 100000) {
      var id = r.fourcc(p);
      var size = u32le(r, p + 4);
      var dStart = p + 8;
      var total = 8 + size + (size & 1);          // chunk payloads are word aligned
      if (dStart + size > n) {
        addNote(res, 'Chunk ' + id + ' at ' + hex(p, 8) + ' declares ' + size +
                    ' bytes but only ' + Math.max(0, n - dStart) + ' are present.');
        size = Math.max(0, n - dStart);
        total = n - p;
      }
      var node = makeNode('chunk', id.trim() || id, 'Chunk ' + id, p,
                          Math.min(n - p, 8 + size + (size & 1)));
      nodeField(node, 'chunk id', "'" + id + "'", p, 4);
      nodeField(node, 'size', size + ' bytes' + (size & 1 ? ' (+1 padding byte)' : ''), p + 4, 4);
      root.push(node);
      chunkNodes++;

      try {
        if (id === 'VP8X') {
          var flags = u8at(r, dStart);
          out.hasIcc = !!(flags & 0x20);
          out.alpha = !!(flags & 0x10);
          out.hasExif = !!(flags & 0x08);
          out.hasXmp = !!(flags & 0x04);
          out.animated = !!(flags & 0x02);
          out.canvasWidth = u24le(r, dStart + 4) + 1;
          out.canvasHeight = u24le(r, dStart + 7) + 1;
          nodeField(node, 'flags', hex(flags, 2), dStart, 1);
          nodeField(node, 'ICC profile flag', out.hasIcc ? 1 : 0, dStart, 1);
          nodeField(node, 'alpha flag', out.alpha ? 1 : 0, dStart, 1);
          nodeField(node, 'Exif flag', out.hasExif ? 1 : 0, dStart, 1);
          nodeField(node, 'XMP flag', out.hasXmp ? 1 : 0, dStart, 1);
          nodeField(node, 'animation flag', out.animated ? 1 : 0, dStart, 1);
          nodeField(node, 'canvas width − 1', out.canvasWidth - 1 + ' → ' + out.canvasWidth, dStart + 4, 3);
          nodeField(node, 'canvas height − 1', out.canvasHeight - 1 + ' → ' + out.canvasHeight, dStart + 7, 3);
        } else if (id === 'VP8 ') {
          stillNode = stillNode || node;
          if (!out.codec) out.codec = 'vp8';
          parseVP8(r, dStart, size, node, res, out);
        } else if (id === 'VP8L') {
          stillNode = stillNode || node;
          if (!out.codec) out.codec = 'vp8l';
          parseVP8L(r, dStart, size, node, res, out);
        } else if (id === 'ALPH') {
          out.alpha = true;
          var apre = u8at(r, dStart);
          nodeField(node, 'flags', hex(apre, 2), dStart, 1);
          nodeField(node, 'pre-processing', (apre >> 4) & 3, dStart, 1);
          nodeField(node, 'filtering method', (apre >> 2) & 3, dStart, 1);
          nodeField(node, 'compression method', apre & 3, dStart, 1);
          if (size > 1) nodeField(node, 'alpha data', (size - 1) + ' bytes', dStart + 1, size - 1);
        } else if (id === 'ANIM') {
          out.animated = true;
          nodeField(node, 'background colour', hex(u32le(r, dStart), 8) + ' (BGRA)', dStart, 4);
          loopCount = u16le(r, dStart + 4);
          nodeField(node, 'loop count', loopCount === 0 ? '0 — infinite' : loopCount, dStart + 4, 2);
        } else if (id === 'ANMF') {
          out.animated = true;
          frameCount++;
          var fx = u24le(r, dStart) * 2;
          var fy = u24le(r, dStart + 3) * 2;
          var fw = u24le(r, dStart + 6) + 1;
          var fh = u24le(r, dStart + 9) + 1;
          var dur = u24le(r, dStart + 12);
          var aflags = u8at(r, dStart + 15);
          nodeField(node, 'frame X', u24le(r, dStart) + ' × 2 = ' + fx, dStart, 3);
          nodeField(node, 'frame Y', u24le(r, dStart + 3) + ' × 2 = ' + fy, dStart + 3, 3);
          nodeField(node, 'frame width − 1', fw - 1 + ' → ' + fw, dStart + 6, 3);
          nodeField(node, 'frame height − 1', fh - 1 + ' → ' + fh, dStart + 9, 3);
          nodeField(node, 'frame duration', dur + ' ms', dStart + 12, 3);
          nodeField(node, 'disposal method', (aflags & 1) ? '1 — clear to background' : '0 — none', dStart + 15, 1);
          nodeField(node, 'blending method', (aflags & 2) ? '1 — do not blend' : '0 — alpha blend', dStart + 15, 1);

          /* nested image sub-chunks (ALPH / VP8 / VP8L) */
          var sub = dStart + 16, subEnd = Math.min(n, dStart + size), subCount = 0;
          var frameCodec = '';
          while (sub + 8 <= subEnd && subCount++ < 64) {
            var subId = r.fourcc(sub);
            var subSize = u32le(r, sub + 4);
            var subNode = makeNode('chunk', subId.trim() || subId,
                                   'Frame sub-chunk ' + subId, sub, Math.min(n - sub, 8 + subSize + (subSize & 1)));
            nodeField(subNode, 'chunk id', "'" + subId + "'", sub, 4);
            nodeField(subNode, 'size', subSize + ' bytes' + (subSize & 1 ? ' (+1 padding)' : ''), sub + 4, 4);
            if (subId === 'ALPH') {
              out.alpha = true;
              var saf = u8at(r, sub + 8);
              nodeField(subNode, 'pre-processing', (saf >> 4) & 3, sub + 8, 1);
              nodeField(subNode, 'filtering method', (saf >> 2) & 3, sub + 8, 1);
              nodeField(subNode, 'compression method', saf & 3, sub + 8, 1);
            } else if (subId === 'VP8 ') {
              frameCodec = frameCodec || 'vp8';
              parseVP8(r, sub + 8, subSize, subNode, res, out);
            } else if (subId === 'VP8L') {
              frameCodec = frameCodec || 'vp8l';
              parseVP8L(r, sub + 8, subSize, subNode, res, out);
            }
            node.children.push(subNode);
            var step = 8 + subSize + (subSize & 1);
            if (step <= 0) break;
            sub += step;
          }
          if (!frameCodec) frameCodec = out.codec || 'webp';
          totalDuration += dur;
          animFrames.push({ node: node, offset: p, size: node.size, durSec: dur / 1000,
                            codec: frameCodec, x: fx, y: fy, w: fw, h: fh,
                            dispose: aflags & 1, blend: (aflags >> 1) & 1 });
        } else if (id === 'ICCP') {
          out.hasIcc = true;
          nodeField(node, 'ICC profile', size + ' bytes', dStart, Math.min(size, 4096));
        } else if (id === 'EXIF') {
          out.hasExif = true;
          var exifOff = dStart, exifLen = size;
          if (latin1At(r, dStart, 6).replace(/\0/g, '') === 'Exif') { exifOff += 6; exifLen -= 6; }
          nodeField(node, 'Exif payload', exifLen + ' bytes', exifOff, Math.max(0, exifLen));
          parseExifTiff(r, exifOff, dStart + size, res, node);
        } else if (id === 'XMP ') {
          out.hasXmp = true;
          nodeField(node, 'XMP packet', size + ' bytes', dStart, Math.min(size, 4096));
          var xmp = latin1At(r, dStart, Math.min(size, 262144));
          var xt = /<dc:title>[\s\S]{0,400}?<rdf:li[^>]*>([\s\S]{0,200}?)<\/rdf:li>/.exec(xmp);
          if (xt) addMeta(res, 'XMP Title', clean(xt[1], 200));
          var xc = /<dc:creator>[\s\S]{0,400}?<rdf:li[^>]*>([\s\S]{0,120}?)<\/rdf:li>/.exec(xmp);
          if (xc) addMeta(res, 'XMP Creator', clean(xc[1], 120));
        }
      } catch (e) {
        addNote(res, 'Error while decoding the ' + id + ' chunk at ' + hex(p, 8) + ': ' +
                    String(e && e.message || e));
      }

      p += total;
    }
    void chunkNodes;

    /* ---- frames ---- */
    var frames = [], index = 1, pts = 0;
    if (animFrames.length) {
      for (var fi = 0; fi < animFrames.length; fi++) {
        var af = animFrames[fi];
        frames.push(makeFrame({
          index: index++, track: 1, type: 'frame', kind: 'frame', codec: af.codec,
          offset: af.offset, size: af.size, ptsSec: pts, durationSec: af.durSec,
          keyframe: af.dispose === 1,
          label: 'Animation frame ' + (fi + 1) + ' (' + af.w + ' × ' + af.h + ' at ' + af.x + ', ' + af.y + ')',
          tables: imageTables('ANMF — animation frame header',
            (af.durSec * 1000).toFixed(0) + ' ms, disposal ' + af.dispose + ', blending ' + af.blend,
            [af.node], 48),
          syn: { codec: af.codec, offset: af.offset, size: af.size }
        }));
        pts += af.durSec;
      }
    } else if (stillNode) {
      var codec = out.codec || 'webp';
      frames.push(makeFrame({
        index: index++, track: 1, type: 'image', kind: 'keyframe', codec: codec,
        offset: stillNode.offset, size: stillNode.size, keyframe: true,
        label: 'Main image (' + (codec === 'vp8l' ? 'VP8L lossless' : 'VP8 lossy') + ')',
        tables: imageTables('WebP bitstream header',
          (codec === 'vp8l' ? 'VP8L lossless' : 'VP8 lossy') + ', ' +
          (out.width || '?') + ' × ' + (out.height || '?'), [stillNode]),
        syn: { codec: codec, offset: stillNode.offset, size: stillNode.size }
      }));
    }

    var canvasW = out.canvasWidth || out.width;
    var canvasH = out.canvasHeight || out.height;
    if (canvasW && canvasH) addMeta(res, 'Canvas size', canvasW + ' × ' + canvasH);
    if (out.animated) {
      addMeta(res, 'Animated', 'yes');
      addMeta(res, 'Frame count', frameCount);
      addMeta(res, 'Loop count', loopCount === 0 ? 'infinite' : String(loopCount));
      res.durationSec = totalDuration;
      addMeta(res, 'Animation duration', MA.formatDuration(totalDuration));
    }
    if (out.alpha) addMeta(res, 'Alpha', 'yes');
    if (out.hasIcc) addMeta(res, 'ICC profile', 'present');
    if (out.hasExif) addMeta(res, 'Exif', 'present');
    if (out.hasXmp) addMeta(res, 'XMP', 'present');
    addMeta(res, 'Bitstream', out.codec === 'vp8l' ? 'VP8L (lossless)' :
            out.codec === 'vp8' ? 'VP8 (lossy)' : (out.codec || 'unknown'));

    res.tracks = [{
      id: 1, type: 'image',
      codec: out.codec || 'webp',
      codecName: out.codec === 'vp8l' ? 'WebP lossless (VP8L)' :
                 out.codec === 'vp8' ? 'WebP lossy (VP8)' : 'WebP',
      profile: out.animated ? 'Animation' : (out.hasIcc ? 'Extended (VP8X)' : 'Simple'),
      width: canvasW || null, height: canvasH || null,
      bitDepth: 8,
      sampleCount: frames.length,
      durationSec: out.animated ? totalDuration : null,
      extra: [
        { label: 'Lossless', value: out.codec === 'vp8l' ? 'yes' : (out.codec === 'vp8' ? 'no' : '—') },
        { label: 'Alpha', value: out.alpha ? 'yes' : 'no' },
        { label: 'VP8 version', value: out.version },
        { label: 'Canvas', value: canvasW + ' × ' + canvasH },
        { label: 'Extended (VP8X)', value: out.hasIcc || out.hasExif || out.hasXmp || out.animated ? 'yes' : 'no' }
      ]
    }];
    res.frames = frames;
    return res;
  }

  /* ======================================================================
   * BMP
   * ====================================================================*/

  var BMP_COMPRESSION = {
    0: 'BI_RGB — none', 1: 'BI_RLE8 — RLE, 8 bit', 2: 'BI_RLE4 — RLE, 4 bit',
    3: 'BI_BITFIELDS — bit masks', 4: 'BI_JPEG — embedded JPEG',
    5: 'BI_PNG — embedded PNG', 6: 'BI_ALPHABITFIELDS — bit masks with alpha',
    11: 'BI_CMYK — uncompressed CMYK', 12: 'BI_CMYKRLE8', 13: 'BI_CMYKRLE4'
  };
  var BMP_COLOR_SPACE = {
    0x73524742: 'sRGB', 0x57696e20: 'Windows colour space',
    0x4c494e4b: 'LINKED', 0x4d424544: 'EMBEDDED', 0: 'LCS_CALIBRATED_RGB'
  };

  function parseBmp(ctx) {
    var res = baseResult('bmp', 'BMP');
    var r = new MA.ByteReader(ctx.data || new Uint8Array(0), 0);
    var n = r.length;
    var root = res.structures;

    if (n < 14) { addNote(res, 'File too short for a BITMAPFILEHEADER (' + n + ' bytes).'); return res; }

    var fileSize = u32le(r, 2);
    var pixelOffset = u32le(r, 10);
    var dibSize = u32le(r, 14);

    var fh = makeNode('header', 'FILE', 'BITMAPFILEHEADER', 0, 14);
    nodeField(fh, 'bfType', "'" + latin1At(r, 0, 2) + "' (BM)", 0, 2);
    nodeField(fh, 'bfSize', fileSize + ' bytes', 2, 4);
    nodeField(fh, 'bfReserved1', u16le(r, 6), 6, 2);
    nodeField(fh, 'bfReserved2', u16le(r, 8), 8, 2);
    nodeField(fh, 'bfOffBits — pixel data offset', pixelOffset, 10, 4);
    if (r.fourcc(0).slice(0, 2) !== 'BM') addNote(res, 'bfType is not "BM" — not a standard bitmap file.');
    if (fileSize && fileSize !== n) {
      nodeNote(fh, 'bfSize ' + fileSize + ' does not match the ' + n + '-byte file');
      addNote(res, 'bfSize (' + fileSize + ') differs from the actual file size (' + n + ').');
    }
    root.push(fh);

    if (dibSize === 0) { addNote(res, 'DIB header size is 0 — the bitmap cannot be decoded.'); return res; }
    var knownDib = dibSize === 12 ? 'BITMAPCOREHEADER' : dibSize === 40 ? 'BITMAPINFOHEADER' :
                   dibSize === 52 ? 'BITMAPV2INFOHEADER' : dibSize === 56 ? 'BITMAPV3INFOHEADER' :
                   dibSize === 64 ? 'OS/2 BITMAPINFOHEADER2' :
                   dibSize === 108 ? 'BITMAPV4HEADER' : dibSize === 124 ? 'BITMAPV5HEADER' :
                   'unknown (' + dibSize + ' bytes)';
    var dibEnd = Math.min(n, 14 + dibSize);
    var dib = makeNode('header', 'DIB', 'DIB header — ' + knownDib, 14, Math.max(0, dibEnd - 14));
    nodeField(dib, 'biSize', dibSize + ' bytes — ' + knownDib, 14, 4);
    root.push(dib);

    var width = 0, heightRaw = 0, height = 0, topDown = false;
    var planes = 0, bpp = 0, compression = 0, imageSize = 0;
    var xppm = 0, yppm = 0, colorsUsed = 0, colorsImportant = 0;
    var paletteEntrySize = 4;

    try {
      if (dibSize === 12) {                       // BITMAPCOREHEADER (OS/2 1.x)
        width = u16le(r, 18);
        heightRaw = u16le(r, 20);
        planes = u16le(r, 22);
        bpp = u16le(r, 24);
        paletteEntrySize = 3;
        nodeField(dib, 'bcWidth', width, 18, 2);
        nodeField(dib, 'bcHeight', heightRaw, 20, 2);
        nodeField(dib, 'bcPlanes', planes, 22, 2);
        nodeField(dib, 'bcBitCount', bpp, 24, 2);
      } else {
        width = u32le(r, 18);
        heightRaw = i32le(r, 22);                 // signed: negative => top-down
        topDown = heightRaw < 0;
        height = Math.abs(heightRaw);
        planes = u16le(r, 26);
        bpp = u16le(r, 28);
        compression = u32le(r, 30);
        nodeField(dib, 'biWidth', width, 18, 4);
        nodeField(dib, 'biHeight', heightRaw + (topDown ? ' — negative: top-down row order' :
                  ' — positive: bottom-up row order'), 22, 4);
        nodeField(dib, 'biPlanes', planes, 26, 2);
        nodeField(dib, 'biBitCount', bpp, 28, 2);
        nodeField(dib, 'biCompression', compression + ' — ' +
                  (BMP_COMPRESSION[compression] || 'unknown'), 30, 4);
        if (dibSize >= 40) {
          imageSize = u32le(r, 34);
          xppm = i32le(r, 38);
          yppm = i32le(r, 42);
          colorsUsed = u32le(r, 46);
          colorsImportant = u32le(r, 50);
          nodeField(dib, 'biSizeImage', imageSize + ' bytes', 34, 4);
          nodeField(dib, 'biXPelsPerMeter', xppm, 38, 4);
          nodeField(dib, 'biYPelsPerMeter', yppm, 42, 4);
          nodeField(dib, 'biClrUsed', colorsUsed, 46, 4);
          nodeField(dib, 'biClrImportant', colorsImportant, 50, 4);
        }
        if (dibSize >= 52 && 14 + 56 <= n) {      // V2/V3: explicit bit masks
          nodeField(dib, 'RedMask', hex(u32le(r, 54), 8), 54, 4);
          nodeField(dib, 'GreenMask', hex(u32le(r, 58), 8), 58, 4);
          nodeField(dib, 'BlueMask', hex(u32le(r, 62), 8), 62, 4);
        }
        if (dibSize >= 108 && 14 + 108 <= n) {    // V4/V5: alpha mask + colour space
          nodeField(dib, 'AlphaMask', hex(u32le(r, 66), 8), 66, 4);
          nodeField(dib, 'CSType', hex(u32le(r, 70), 8) + ' — ' +
                    (BMP_COLOR_SPACE[u32le(r, 70)] || 'unknown'), 70, 4);
          var gammaNames = ['GammaRed', 'GammaGreen', 'GammaBlue'];
          for (var gi = 0; gi < 3; gi++) {
            nodeField(dib, gammaNames[gi], (i32le(r, 110 + gi * 4) / 65536).toFixed(4), 110 + gi * 4, 4);
          }
          nodeField(dib, 'Intent', u32le(r, 122), 122, 4);
          if (dibSize >= 124 && 14 + 124 <= n) {
            nodeField(dib, 'ProfileData', u32le(r, 126), 126, 4);
            nodeField(dib, 'ProfileSize', u32le(r, 130), 130, 4);
          }
        }
      }
    } catch (e) {
      addNote(res, 'DIB header decode error: ' + String(e && e.message || e));
    }

    /* ---- derived facts ---- */
    var rowStride = bpp ? Math.floor((bpp * width + 31) / 32) * 4 : 0;
    nodeNote(dib, 'Orientation: ' + (topDown ? 'top-down (biHeight < 0)' : 'bottom-up (biHeight > 0)'));
    if (width && bpp) {
      nodeNote(dib, 'Row stride ' + rowStride + ' bytes (rows are padded to a 4-byte boundary)');
    }

    /* ---- palette ---- */
    var paletteEntries = 0, paletteEnd = 0;
    if (bpp > 0 && bpp <= 8 && compression !== 3 && compression !== 6) {
      paletteEntries = colorsUsed || (1 << bpp);
      var palBytes = paletteEntries * paletteEntrySize;
      if (14 + dibSize + palBytes <= n) {
        var pal = makeNode('table', 'PALETTE', 'Colour palette', 14 + dibSize, palBytes);
        nodeField(pal, 'entries', paletteEntries + ' × ' +
                  (paletteEntrySize === 3 ? 'RGB' : 'BGRX'), 14 + dibSize, 0);
        for (var pi = 0; pi < Math.min(paletteEntries, 4); pi++) {
          var po = 14 + dibSize + pi * paletteEntrySize;
          nodeField(pal, 'entry[' + pi + ']',
            '#' + hex(u8at(r, po + 2), 2).slice(2) + hex(u8at(r, po + 1), 2).slice(2) +
            hex(u8at(r, po), 2).slice(2), po, paletteEntrySize);
        }
        if (paletteEntries > 4) nodeNote(pal, '… ' + (paletteEntries - 4) + ' more entries');
        root.push(pal);
        paletteEnd = 14 + dibSize + palBytes;
      } else {
        addNote(res, 'Palette of ' + paletteEntries + ' entries does not fit in the file.');
      }
    }

    /* ---- pixel data ---- */
    var pixStart = pixelOffset;
    if (pixStart < 14 + dibSize || pixStart > n) {
      addNote(res, 'bfOffBits ' + hex(pixelOffset, 8) + ' points outside the pixel data area; ' +
                  'using ' + hex(Math.max(paletteEnd, 14 + dibSize), 8) + ' instead.');
      pixStart = Math.min(Math.max(paletteEnd, 14 + dibSize), n);
    }
    var pixSize = Math.max(0, n - pixStart);
    var pix = makeNode('data', 'PIXELS', 'Pixel data', pixStart, pixSize);
    nodeField(pix, 'pixel data', pixSize + ' bytes', pixStart, pixSize);
    if (rowStride && height) {
      nodeNote(pix, 'Expected ' + (rowStride * height) + ' bytes for ' + width + ' × ' + height +
               ' at ' + bpp + ' bpp' + (rowStride * height === (imageSize || pixSize) ? '' : ' (mismatch)'));
    }
    root.push(pix);

    var alpha = bpp === 32 || compression === 6;
    res.tracks = [{
      id: 1, type: 'image', codec: 'bmp', codecName: 'BMP',
      profile: knownDib,
      width: width || null, height: height || null,
      bitDepth: bpp || null,
      sampleCount: 1,
      extra: [
        { label: 'DIB header', value: knownDib },
        { label: 'Orientation', value: topDown ? 'top-down' : 'bottom-up' },
        { label: 'Compression', value: BMP_COMPRESSION[compression] || String(compression) },
        { label: 'Row stride', value: rowStride + ' bytes' },
        { label: 'Alpha', value: alpha ? 'yes' : 'no' },
        { label: 'Palette', value: paletteEntries ? paletteEntries + ' entries' : 'none' },
        { label: 'Resolution', value: xppm ? Math.round(xppm * 0.0254) + ' × ' +
          Math.round(yppm * 0.0254) + ' dpi' : '—' }
      ]
    }];
    addMeta(res, 'Image size', width + ' × ' + height);
    addMeta(res, 'Bit depth', bpp + ' bpp');
    addMeta(res, 'Orientation', topDown ? 'top-down (negative height)' : 'bottom-up (positive height)');
    addMeta(res, 'Compression', BMP_COMPRESSION[compression] || String(compression));
    if (xppm) addMeta(res, 'Resolution', Math.round(xppm * 0.0254) + ' × ' + Math.round(yppm * 0.0254) + ' dpi');
    if (paletteEntries) addMeta(res, 'Palette', paletteEntries + ' entries');
    if (compression === 4 || compression === 5) {
      addMeta(res, 'Embedded image', compression === 4 ? 'JPEG' : 'PNG');
    }

    res.frames = [makeFrame({
      index: 1, track: 1, type: 'image', kind: 'keyframe', codec: 'bmp',
      offset: pixStart, size: pixSize, keyframe: true, label: 'Main image (pixel data)',
      tables: imageTables('BMP image data', width + ' × ' + height + ', ' + bpp + ' bpp, ' +
        (topDown ? 'top-down' : 'bottom-up'), [fh, dib, pix]),
      syn: { codec: 'bmp', offset: pixStart, size: pixSize }
    })];
    return res;
  }

  /* ======================================================================
   * Registration
   * ====================================================================*/

  MA.registerParser({ id: 'png', name: 'PNG', exts: ['png', 'apng', 'mng'], kinds: ['image'], parse: parsePng });
  MA.registerParser({ id: 'jpeg', name: 'JPEG', exts: ['jpg', 'jpeg', 'jpe', 'jfif'], kinds: ['image'], parse: parseJpeg });
  MA.registerParser({ id: 'gif', name: 'GIF', exts: ['gif'], kinds: ['image'], parse: parseGif });
  MA.registerParser({ id: 'webp', name: 'WebP', exts: ['webp'], kinds: ['image'], parse: parseWebp });
  MA.registerParser({ id: 'bmp', name: 'BMP', exts: ['bmp', 'dib'], kinds: ['image'], parse: parseBmp });

  /* Shared with parsers/riff.js (a WebP "EXIF" chunk and an AVI/JPEG APP1
   * carry the very same TIFF structure). */
  MA.parseExifTiff = parseExifTiff;
  MA.chromaSubsampling = chromaSubsampling;

  void MA.formatSize;
})(typeof globalThis !== 'undefined' ? globalThis : this);
