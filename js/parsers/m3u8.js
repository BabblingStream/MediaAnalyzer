/* ============================================================================
 * MediaAnalyzer — parsers/m3u8.js
 *
 * HLS playlists (RFC 8216 + the LL-HLS draft tags).
 *
 * The parser is strictly offline: it reads the playlist text that is already in
 * hand and never fetches a segment, a variant or a key. An earlier build
 * probed the first segment with a synchronous XHR — that made the page hang on
 * every playlist and is deliberately not coming back.
 *
 * Two playlist shapes come out of the same walk:
 *   master  — #EXT-X-STREAM-INF variants (+ #EXT-X-MEDIA renditions)
 *   media   — #EXTINF segments (+ byteranges, keys, parts)
 *
 * Byte offsets: every structure field points at the first character of the
 * line it came from, so the hex view can jump there.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField, nodeNote = MA.nodeNote;
  var hex = MA.hex, formatBitrate = MA.formatBitrate;

  var MAX_LINES = 200000;       // playlist line guard
  var MAX_VARIANTS = 2000;
  var MAX_SEGMENTS = 20000;     // segments kept for the UI
  var MAX_MEDIA = 2000;         // #EXT-X-MEDIA renditions
  var MAX_STRUCT_NODES = 3000;

  function msg(e) { return String((e && e.message) || e); }

  /* ==========================================================================
   * Line walking
   * ========================================================================*/

  /**
   * Split the playlist into lines while keeping the byte offset of each one.
   * The file may be UTF-8 with a BOM and may use CRLF or LF.
   */
  function readLines(data) {
    var text = '';
    var bom = 0;
    if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) bom = 3;
    try {
      text = new TextDecoder('utf-8').decode(data.subarray(bom));
    } catch (e) {
      // Latin-1 fallback keeps us going on odd encodings.
      for (var i = bom; i < data.length; i++) text += String.fromCharCode(data[i]);
    }
    var lines = [];
    var lineStart = 0;
    // Offsets are counted in the original byte stream, so the BOM is added back.
    for (var p = 0; p <= text.length && lines.length < MAX_LINES; p++) {
      if (p < text.length && text.charCodeAt(p) !== 10) continue;
      if (p >= text.length && lineStart >= text.length) break;   // no phantom last line
      var raw = text.slice(lineStart, p);
      var start = lineStart + bom;
      var end = p + bom;
      if (raw.length && raw.charCodeAt(raw.length - 1) === 13) raw = raw.slice(0, -1);
      lines.push({ text: raw, start: start, size: end - start });
      lineStart = p + 1;
    }
    return lines;
  }

  /**
   * Attribute list: NAME=value pairs, values quoted or bare.
   *   #EXT-X-STREAM-INF:BANDWIDTH=1280000,RESOLUTION=416x234,CODECS="avc1.4d401f,mp4a.40.2"
   */
  function parseAttributes(s) {
    var out = {};
    var order = [];
    var re = /([A-Za-z0-9-]+)=("[^"]*"|(?:[^,]*))/g;
    var m;
    while ((m = re.exec(s)) !== null) {
      var key = m[1].toUpperCase();
      var val = m[2];
      if (val.charAt(0) === '"' && val.charAt(val.length - 1) === '"') {
        val = val.slice(1, -1);
      } else {
        val = val.replace(/\s+$/, '');
      }
      if (out[key] === undefined) order.push(key);
      out[key] = val;
    }
    out.__order = order;
    return out;
  }

  function num(v) {
    if (v == null || v === '') return null;
    var n = parseFloat(v);
    return isFinite(n) ? n : null;
  }
  function int(v) {
    var n = num(v);
    return n == null ? null : Math.round(n);
  }

  /* ==========================================================================
   * RFC 6381 codec strings
   * ========================================================================*/

  var AVC_PROFILES = {
    66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
    122: 'High 4:2:2', 244: 'High 4:4:4 Predictive', 44: 'CAVLC 4:4:4 Intra'
  };
  var AVC_LEVELS = {
    10: '1', 11: '1b', 12: '1.1', 13: '1.2', 20: '2', 21: '2.1', 22: '2.2',
    30: '3', 31: '3.1', 32: '3.2', 40: '4', 41: '4.1', 42: '4.2', 50: '5',
    51: '5.1', 52: '5.2', 60: '6', 61: '6.1', 62: '6.2'
  };
  var AAC_AOT = {
    1: 'AAC Main', 2: 'AAC LC', 3: 'AAC SSR', 4: 'AAC LTP',
    5: 'SBR (HE-AAC)', 6: 'AAC Scalable', 17: 'ER AAC LC', 29: 'PS (HE-AAC v2)'
  };

  /**
   * Decode one RFC 6381 codec string.
   * @returns {{ codec, codecName, type, profile, level, sampleRate, channels }}
   */
  function parseCodecString(str) {
    var s = String(str || '').trim();
    var out = { codec: s, codecName: s, type: 'video', profile: '', level: '',
                sampleRate: null, channels: null };
    if (!s) { out.type = 'other'; return out; }
    var parts = s.split('.');
    var id = parts[0].toLowerCase();
    var name = id, type = 'video', profile = '', level = '';
    var sampleRate = null, channels = null;

    function hx(v) { return parseInt(v, 16); }

    if (id === 'avc1' || id === 'avc3' || id === 'avc2' || id === 'avc4') {
      name = 'H.264 / AVC';
      // avc1.PPCCLL — profile_idc, compatibility, level_idc as hex bytes.
      if (parts.length >= 4 && parts[1].length >= 2) {
        var pidc = hx(parts[1].slice(0, 2));
        var lidc = hx(parts[3]);
        profile = AVC_PROFILES[pidc] || ('profile_idc ' + pidc);
        level = AVC_LEVELS[lidc] || String(lidc / 10);
      }
    } else if (id === 'hvc1' || id === 'hev1') {
      name = 'H.265 / HEVC';
      // hvc1.<profile byte><tier+level><constraints…>
      if (parts.length >= 2 && parts[1].length) {
        var pb = hx(parts[1].slice(0, 1));
        var space = (pb >> 6) & 3;
        var hpidc = pb & 0x1f;
        profile = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'RExt' }[hpidc] ||
          ('profile_idc ' + hpidc);
        if (space) profile += ' (profile space ' + space + ')';
        if (parts.length >= 3 && parts[2].length) {
          var hlevel = hx(parts[2].slice(0, 2));
          level = hlevel ? (hlevel / 30).toFixed(1) : '';
          if (/^H/i.test(parts[2].slice(2))) level += ' high tier';
        }
      }
    } else if (id === 'vvc1' || id === 'vvi1') {
      name = 'H.266 / VVC';
    } else if (id === 'vp08') {
      name = 'VP8';
    } else if (id === 'vp09') {
      name = 'VP9';
      // vp09.PP.LL.DD — profile, level, bit depth.
      if (parts.length >= 4) {
        profile = 'profile ' + hx(parts[1]);
        level = 'level ' + hx(parts[2]) + '.' + hx(parts[3]);
      }
    } else if (id === 'av01') {
      name = 'AV1';
      // av01.P.LLT.DD — profile, level+tier, bit depth.
      if (parts.length >= 4) {
        profile = 'profile ' + hx(parts[1]);
        var lv = parts[2];
        level = 'level ' + hx(lv.slice(0, 2)) + (lv.length > 2 && lv.charAt(2) === 'H' ? ' high tier' : ' main tier');
      }
    } else if (id === 'av02') {
      name = 'AV2';
    } else if (id === 'dvh1' || id === 'dvhe') {
      name = 'Dolby Vision (HEVC)';
      profile = 'profile ' + (parts[1] || '?');
    } else if (id === 'mp4a') {
      type = 'audio';
      name = 'MPEG-4 Audio';
      if (parts[1] === '40') {
        var aot = int(parts[2]);
        sampleRate = null;
        name = 'AAC';
        profile = AAC_AOT[aot] || ('audioObjectType ' + aot);
      } else if (parts[1] === '69' || parts[1] === '6B') {
        name = 'MP3';
      } else if (parts[1] === 'A5') {
        name = 'AC-3';
      } else if (parts[1] === 'A6') {
        name = 'E-AC-3';
      }
    } else if (id === 'ac-3') {
      type = 'audio'; name = 'AC-3';
    } else if (id === 'ec-3') {
      type = 'audio'; name = 'E-AC-3';
    } else if (id === 'opus') {
      type = 'audio'; name = 'Opus';
    } else if (id === 'vorbis') {
      type = 'audio'; name = 'Vorbis';
    } else if (id === 'flac') {
      type = 'audio'; name = 'FLAC';
    } else if (id === 'alac') {
      type = 'audio'; name = 'ALAC';
    } else if (id === 'mp3' || id === 'mp4a.6b') {
      type = 'audio'; name = 'MP3';
    } else if (id === 'stpp') {
      type = 'subtitle'; name = 'TTML';
    } else if (id === 'wvtt') {
      type = 'subtitle'; name = 'WebVTT';
    } else if (id === 'tx3g' || id === 'sbtl') {
      type = 'subtitle'; name = '3GPP timed text';
    } else if (id === 'theora') {
      name = 'Theora';
    }

    out.codec = id;
    out.codecName = name;
    out.type = type;
    out.profile = profile;
    out.level = level;
    out.sampleRate = sampleRate;
    out.channels = channels;
    return out;
  }

  function parseResolution(str, out) {
    var m = /^(\d+)\s*[xX*]\s*(\d+)$/.exec(String(str || '').trim());
    if (m) { out.width = parseInt(m[1], 10); out.height = parseInt(m[2], 10); }
    return out;
  }

  /* ==========================================================================
   * Playlist parse
   * ========================================================================*/

  function newResult() {
    return {
      formatId: 'm3u8',
      formatName: 'HLS playlist (M3U8)',
      durationSec: null,
      bitrate: null,
      tracks: [],
      metadata: [],
      structures: [],
      frames: [],
      notes: [],
      codecContexts: {},
      extra: [],
      isPlaylist: true,
      segments: [],
      variants: [],
      media: [],
      keys: [],
      dateranges: [],
      encrypted: false,
      streamType: null,       // 'VOD' | 'EVENT' | 'LIVE' (media playlists only)
      selectedVariant: -1
    };
  }

  function parse(ctx) {
    var result = newResult();
    var data = ctx && ctx.data;
    if (!data || !data.length) {
      result.notes.push('Empty playlist file.');
      return result;
    }
    var lines;
    try {
      lines = readLines(data);
    } catch (e) {
      result.notes.push('The playlist could not be decoded: ' + msg(e));
      return result;
    }
    try {
      walk(lines, data, result);
    } catch (e) {
      result.notes.push('Playlist parsing stopped early: ' + msg(e));
    }
    finish(result);
    return result;
  }

  function walk(lines, data, result) {
    var notes = result.notes;
    var header = makeNode('header', 'M3U8', 'HLS Playlist Header', 0, 0);
    header.children = [];
    result.structures.push(header);

    if (!lines.length || !/^#EXTM3U/.test(lines[0].text.trim())) {
      notes.push('The file does not start with #EXTM3U — it may not be an HLS playlist.');
    }
    nodeField(header, 'signature', lines.length ? "'" + lines[0].text.trim() + "'" : '(empty)', 0,
      lines.length ? lines[0].size : 0);

    var segNode = makeNode('group', 'segments', 'Segments', 0, 0);
    segNode.expanded = false;
    var varNode = makeNode('group', 'variants', 'Variant Streams', 0, 0);
    varNode.expanded = true;
    var medNode = makeNode('group', 'renditions', 'Renditions (#EXT-X-MEDIA)', 0, 0);

    var curInf = null;     // last #EXTINF
    var curByteRange = null;
    var curKey = null;     // active key (METHOD != NONE)
    var curMap = null;
    var curDiscontinuity = false;
    var curParts = [];
    var curStreamInf = null;
    var programDateTime = null;
    var segIndex = 0;
    var variantIndex = 0;
    var mediaIndex = 0;

    var TAGS = {
      '#EXTM3U': 1, '#EXT-X-VERSION': 1, '#EXT-X-TARGETDURATION': 1,
      '#EXT-X-MEDIA-SEQUENCE': 1, '#EXT-X-DISCONTINUITY-SEQUENCE': 1,
      '#EXT-X-PLAYLIST-TYPE': 1, '#EXT-X-ALLOW-CACHE': 1,
      '#EXT-X-INDEPENDENT-SEGMENTS': 1, '#EXT-X-I-FRAMES-ONLY': 1,
      '#EXT-X-ENDLIST': 1, '#EXT-X-DISCONTINUITY': 1, '#EXT-X-START': 1,
      '#EXT-X-DEFINE': 1
    };

    for (var li = 0; li < lines.length; li++) {
      var line = lines[li];
      var text = line.text;
      var trimmed = text.replace(/^\s+/, '');

      if (!trimmed.length) {
        nodeField(header, 'blank line', '', line.start, Math.max(line.size, 0));
        continue;
      }

      if (trimmed.charAt(0) !== '#') {
        /* ---- URI line: belongs to the pending variant or segment ---- */
        if (curStreamInf) {
          if (result.variants.length < MAX_VARIANTS) {
            var v = buildVariant(curStreamInf, trimmed, line.start, line.size, variantIndex);
            result.variants.push(v);
            addTrack(result, v);
            if (varNode.children.length < MAX_STRUCT_NODES) varNode.children.push(v.node);
            variantIndex++;
          } else {
            notes.push('Variant list capped at ' + MAX_VARIANTS + ' entries.');
          }
          curStreamInf = null;
        } else {
          if (result.segments.length < MAX_SEGMENTS) {
            var seg = buildSegment({
              index: segIndex, uri: trimmed, offset: line.start, size: line.size,
              inf: curInf, byteRange: curByteRange, key: curKey, map: curMap,
              discontinuity: curDiscontinuity, programDateTime: programDateTime,
              parts: curParts.slice()
            });
            result.segments.push(seg);
            if (segNode.children.length < MAX_STRUCT_NODES) segNode.children.push(seg.node);
            segIndex++;
          } else if (result.segments.length === MAX_SEGMENTS) {
            notes.push('Segment list capped at ' + MAX_SEGMENTS + ' entries.');
          }
          curInf = null; curByteRange = null; curDiscontinuity = false;
          curParts = []; programDateTime = null;
        }
        continue;
      }

      /* ---- tags ---- */
      var colon = trimmed.indexOf(':');
      var tag = colon > 0 ? trimmed.slice(0, colon) : trimmed;
      var rest = colon > 0 ? trimmed.slice(colon + 1) : '';

      if (tag === '#EXT-X-STREAM-INF' || tag === '#EXT-X-I-FRAME-STREAM-INF') {
        var attrs = parseAttributes(rest);
        if (tag === '#EXT-X-I-FRAME-STREAM-INF') {
          // I-frame variants carry their URI as an attribute, not on the next line.
          var iv = buildVariant(attrs, attrs.URI || '', line.start, line.size, variantIndex);
          iv.iframeOnly = true;
          iv.node.code = 'IFRAME-INF';
          nodeField(iv.node, 'I-frame only', 'yes', line.start, 0);
          if (result.variants.length < MAX_VARIANTS) {
            result.variants.push(iv);
            addTrack(result, iv);
            if (varNode.children.length < MAX_STRUCT_NODES) varNode.children.push(iv.node);
            variantIndex++;
          }
        } else {
          curStreamInf = { attrs: attrs, offset: line.start, size: line.size };
        }
      } else if (tag === '#EXT-X-MEDIA') {
        var ma = parseAttributes(rest);
        var media = { attrs: ma, offset: line.start, size: line.size };
        if (result.media.length < MAX_MEDIA) {
          result.media.push(media);
          addMediaTrack(result, media, mediaIndex++);
          if (medNode.children.length < MAX_STRUCT_NODES) medNode.children.push(mediaNode(media));
        } else {
          notes.push('Rendition list capped at ' + MAX_MEDIA + ' entries.');
        }
      } else if (tag === '#EXT-X-SESSION-DATA') {
        var sd = parseAttributes(rest);
        header.children.push(sessionDataNode(sd, line.start, line.size));
        notes.push('Session data: ' + (sd['DATA-ID'] || '') + ' = ' +
          (sd.VALUE != null ? sd.VALUE : '(URI ' + (sd.URI || '') + ')'));
      } else if (tag === '#EXT-X-SESSION-KEY') {
        var sk = parseAttributes(rest);
        header.children.push(keyNode(sk, line.start, line.size, 'Session key'));
        addKey(result, sk, line.start, line.size, true);
      } else if (tag === '#EXT-X-KEY') {
        var ka = parseAttributes(rest);
        if ((ka.METHOD || '').toUpperCase() === 'NONE') {
          curKey = null;
        } else {
          curKey = { method: ka.METHOD, uri: ka.URI, iv: ka.IV,
                     keyformat: ka.KEYFORMAT, keyformatversions: ka.KEYFORMATVERSIONS };
          addKey(result, ka, line.start, line.size, false);
        }
        header.children.push(keyNode(ka, line.start, line.size, 'Key'));
      } else if (tag === '#EXT-X-MAP') {
        var mp = parseAttributes(rest);
        curMap = { uri: mp.URI, byterange: mp.BYTERANGE };
        var mn = makeNode('entry', 'MAP', 'Initialization Section', line.start, line.size);
        nodeField(mn, 'URI', mp.URI || '', line.start, line.size);
        if (mp.BYTERANGE) nodeField(mn, 'BYTERANGE', mp.BYTERANGE, line.start, line.size);
        header.children.push(mn);
      } else if (tag === '#EXTINF') {
        var comma = rest.indexOf(',');
        var durStr = comma >= 0 ? rest.slice(0, comma) : rest;
        var title = comma >= 0 ? rest.slice(comma + 1) : '';
        curInf = { duration: num(durStr), title: title, offset: line.start, size: line.size };
      } else if (tag === '#EXT-X-BYTERANGE') {
        curByteRange = parseByteRange(rest, result.segments);
        if (curByteRange) {
          curByteRange.lineOffset = line.start;
          curByteRange.lineSize = line.size;
        }
      } else if (tag === '#EXT-X-PROGRAM-DATE-TIME') {
        programDateTime = rest;
        nodeField(header, '#EXT-X-PROGRAM-DATE-TIME', rest, line.start, line.size);
      } else if (tag === '#EXT-X-DISCONTINUITY') {
        curDiscontinuity = true;
        nodeField(header, '#EXT-X-DISCONTINUITY', 'discontinuity before the next segment',
          line.start, line.size);
      } else if (tag === '#EXT-X-DATERANGE') {
        var dr = parseAttributes(rest);
        result.dateranges.push(dr);
        header.children.push(daterangeNode(dr, line.start, line.size));
      } else if (tag === '#EXT-X-PART') {
        var pa = parseAttributes(rest);
        curParts.push({ uri: pa.URI, duration: num(pa.DURATION),
                        byterange: pa.BYTERANGE, gap: pa.GAP === 'YES',
                        independent: pa.INDEPENDENT === 'YES' });
      } else if (tag === '#EXT-X-PRELOAD-HINT') {
        var ph = parseAttributes(rest);
        header.children.push(hintNode('#EXT-X-PRELOAD-HINT', ph, line.start, line.size));
      } else if (tag === '#EXT-X-RENDITION-REPORT') {
        var rr = parseAttributes(rest);
        header.children.push(hintNode('#EXT-X-RENDITION-REPORT', rr, line.start, line.size));
      } else if (tag === '#EXT-X-SKIP') {
        var skp = parseAttributes(rest);
        header.children.push(hintNode('#EXT-X-SKIP', skp, line.start, line.size));
        notes.push('This playlist uses #EXT-X-SKIP — the segment list is a delta, not the full timeline.');
      } else if (tag === '#EXT-X-VERSION') {
        result.version = num(rest);
        nodeField(header, '#EXT-X-VERSION', rest.trim(), line.start, line.size);
      } else if (tag === '#EXT-X-TARGETDURATION') {
        result.targetDuration = num(rest);
        nodeField(header, '#EXT-X-TARGETDURATION', rest.trim() + ' s', line.start, line.size);
      } else if (tag === '#EXT-X-MEDIA-SEQUENCE') {
        result.mediaSequence = int(rest);
        nodeField(header, '#EXT-X-MEDIA-SEQUENCE', rest.trim(), line.start, line.size);
      } else if (tag === '#EXT-X-DISCONTINUITY-SEQUENCE') {
        result.discontinuitySequence = int(rest);
        nodeField(header, '#EXT-X-DISCONTINUITY-SEQUENCE', rest.trim(), line.start, line.size);
      } else if (tag === '#EXT-X-PLAYLIST-TYPE') {
        result.playlistType = rest.trim();
        nodeField(header, '#EXT-X-PLAYLIST-TYPE', rest.trim(), line.start, line.size);
      } else if (tag === '#EXT-X-ALLOW-CACHE') {
        result.allowCache = rest.trim();
        nodeField(header, '#EXT-X-ALLOW-CACHE', rest.trim(), line.start, line.size);
      } else if (tag === '#EXT-X-INDEPENDENT-SEGMENTS') {
        result.independentSegments = true;
        nodeField(header, '#EXT-X-INDEPENDENT-SEGMENTS', 'segments are independently decodable',
          line.start, line.size);
      } else if (tag === '#EXT-X-I-FRAMES-ONLY') {
        result.iframeOnly = true;
        nodeField(header, '#EXT-X-I-FRAMES-ONLY', 'playlist describes I-frames only',
          line.start, line.size);
      } else if (tag === '#EXT-X-ENDLIST') {
        result.endList = true;
        nodeField(header, '#EXT-X-ENDLIST', 'the playlist is complete', line.start, line.size);
      } else if (tag === '#EXT-X-START') {
        var sa = parseAttributes(rest);
        header.children.push(hintNode('#EXT-X-START', sa, line.start, line.size));
      } else if (tag === '#EXTM3U') {
        nodeField(header, '#EXTM3U', 'playlist marker', line.start, line.size);
      } else if (TAGS[tag]) {
        nodeField(header, tag, rest.trim(), line.start, line.size);
      } else if (/^#EXT/.test(tag)) {
        nodeField(header, tag, rest.trim() || '(no value)', line.start, line.size);
      } else {
        // A comment — kept as a field so the tree mirrors the file exactly.
        nodeField(header, 'comment', trimmed.slice(0, 120), line.start, line.size);
      }
    }

    header.size = data.length;
    if (varNode.children.length) result.structures.push(varNode);
    if (medNode.children.length) result.structures.push(medNode);
    if (segNode.children.length) result.structures.push(segNode);

    result.extra.push({
      label: 'Playlist kind',
      value: result.variants.length ? 'master (variant list)' : (result.segments.length ? 'media (segment list)' : 'empty')
    });
    if (result.segments.length >= MAX_SEGMENTS) {
      notes.push('Only the first ' + MAX_SEGMENTS + ' segments were kept.');
    }
  }

  /* ------------------------------------------------------------- variants */

  function buildVariant(inf, uri, offset, size, index) {
    var a = inf.attrs;
    // The node spans the #EXT-X-STREAM-INF line and the URI line that follows.
    var nodeStart = inf.offset != null ? inf.offset : offset;
    var nodeEnd = (offset || 0) + (size || 0);
    var node = makeNode('entry', 'STREAM-INF', 'Variant Stream #' + (index + 1), nodeStart,
      nodeEnd > nodeStart ? nodeEnd - nodeStart : (inf.size || 0));
    node.expanded = false;
    nodeField(node, 'BANDWIDTH', a.BANDWIDTH != null ? a.BANDWIDTH : '', inf.offset, inf.size);
    if (a['AVERAGE-BANDWIDTH']) nodeField(node, 'AVERAGE-BANDWIDTH', a['AVERAGE-BANDWIDTH'], inf.offset, inf.size);
    if (a.CODECS) nodeField(node, 'CODECS', a.CODECS, inf.offset, inf.size);
    if (a.RESOLUTION) nodeField(node, 'RESOLUTION', a.RESOLUTION, inf.offset, inf.size);
    if (a['FRAME-RATE']) nodeField(node, 'FRAME-RATE', a['FRAME-RATE'] + ' fps', inf.offset, inf.size);
    if (a.AUDIO) nodeField(node, 'AUDIO', a.AUDIO, inf.offset, inf.size);
    if (a.VIDEO) nodeField(node, 'VIDEO', a.VIDEO, inf.offset, inf.size);
    if (a.SUBTITLES) nodeField(node, 'SUBTITLES', a.SUBTITLES, inf.offset, inf.size);
    if (a['CLOSED-CAPTIONS']) nodeField(node, 'CLOSED-CAPTIONS', a['CLOSED-CAPTIONS'], inf.offset, inf.size);
    if (a.NAME) nodeField(node, 'NAME', a.NAME, inf.offset, inf.size);
    if (a['PROGRAM-ID']) nodeField(node, 'PROGRAM-ID', a['PROGRAM-ID'], inf.offset, inf.size);
    if (uri) nodeField(node, 'URI', uri, offset, size);

    var codecs = (a.CODECS || '').split(',').map(function (c) { return c.trim(); })
      .filter(function (c) { return !!c; });
    var video = null, audio = null;
    for (var i = 0; i < codecs.length; i++) {
      var c = parseCodecString(codecs[i]);
      if (!video && c.type === 'video') video = c;
      else if (!audio && c.type === 'audio') audio = c;
    }
    var v = {
      index: index,
      uri: uri,
      bandwidth: int(a.BANDWIDTH),
      averageBandwidth: int(a['AVERAGE-BANDWIDTH']),
      codecs: codecs,
      codecsRaw: a.CODECS || '',
      video: video,
      audio: audio,
      frameRate: num(a['FRAME-RATE']),
      audioGroup: a.AUDIO || '',
      videoGroup: a.VIDEO || '',
      subtitlesGroup: a.SUBTITLES || '',
      programId: int(a['PROGRAM-ID']),
      iframeOnly: false,
      offset: offset,
      node: node
    };
    parseResolution(a.RESOLUTION, v);
    return v;
  }

  function addTrack(result, v) {
    var src = v.video || (v.codecs.length ? parseCodecString(v.codecs[0]) : null);
    var track = {
      id: result.tracks.length + 1,
      type: src ? src.type : 'video',
      codec: src ? src.codec : (v.codecsRaw || ''),
      codecName: src ? src.codecName : 'unknown',
      profile: src ? src.profile : '',
      level: src ? src.level : '',
      width: v.width != null ? v.width : null,
      height: v.height != null ? v.height : null,
      fps: v.frameRate != null ? v.frameRate : null,
      sampleRate: src && src.sampleRate != null ? src.sampleRate : null,
      channels: null,
      durationSec: null,
      bitrate: v.bandwidth != null ? v.bandwidth
             : (v.averageBandwidth != null ? v.averageBandwidth : null),
      sampleCount: 0,
      language: '',
      extra: []
    };
    if (v.averageBandwidth != null) {
      track.extra.push({ label: 'Average bandwidth', value: formatBitrate(v.averageBandwidth) });
    }
    if (v.audio && v.audio.codec !== track.codec) {
      track.extra.push({ label: 'Audio codec', value: v.audio.codecName + ' (' + v.audio.codec + ')' });
    }
    if (v.codecsRaw) track.extra.push({ label: 'CODECS', value: v.codecsRaw });
    if (v.audioGroup) track.extra.push({ label: 'AUDIO group', value: v.audioGroup });
    if (v.subtitlesGroup) track.extra.push({ label: 'SUBTITLES group', value: v.subtitlesGroup });
    if (v.videoGroup) track.extra.push({ label: 'VIDEO group', value: v.videoGroup });
    if (v.iframeOnly) track.extra.push({ label: 'I-frame only', value: 'yes' });
    track.extra.push({ label: 'URI', value: v.uri || '(none)' });
    result.tracks.push(track);
    v.trackId = track.id;
  }

  function addMediaTrack(result, m, index) {
    var a = m.attrs;
    var type = (a.TYPE || '').toUpperCase();
    var kind = type === 'AUDIO' ? 'audio' : type === 'SUBTITLES' ? 'subtitle' :
               type === 'VIDEO' ? 'video' : type === 'CLOSED-CAPTIONS' ? 'subtitle' : 'other';
    var codecs = (a.CODECS || '').split(',').map(function (c) { return c.trim(); })
      .filter(function (c) { return !!c; });
    var src = codecs.length ? parseCodecString(codecs[0]) : null;
    var ch = a.CHANNELS;
    var channels = null;
    if (ch) {
      var mch = /^\d+/.exec(ch);
      channels = mch ? parseInt(mch[0], 10) : null;
    }
    var track = {
      id: result.tracks.length + 1,
      type: kind,
      codec: src ? src.codec : (type || 'media'),
      codecName: src ? src.codecName : (type || 'media rendition'),
      profile: src ? src.profile : '',
      level: src ? src.level : '',
      width: null, height: null, fps: null,
      sampleRate: null,
      channels: channels,
      channelLayout: ch || '',
      durationSec: null,
      bitrate: null,
      sampleCount: 0,
      language: a.LANGUAGE || '',
      extra: []
    };
    if (a['GROUP-ID']) track.extra.push({ label: 'GROUP-ID', value: a['GROUP-ID'] });
    if (a.NAME) track.extra.push({ label: 'NAME', value: a.NAME });
    if (a.DEFAULT) track.extra.push({ label: 'DEFAULT', value: a.DEFAULT });
    if (a.AUTOSELECT) track.extra.push({ label: 'AUTOSELECT', value: a.AUTOSELECT });
    if (a.FORCED) track.extra.push({ label: 'FORCED', value: a.FORCED });
    if (a.URI) track.extra.push({ label: 'URI', value: a.URI });
    if (ch) track.extra.push({ label: 'CHANNELS', value: ch });
    result.tracks.push(track);
    m.trackId = track.id;
  }

  function mediaNode(m) {
    var a = m.attrs;
    var node = makeNode('entry', 'MEDIA', 'Rendition (' + (a.TYPE || '?') + ')', m.offset, m.size);
    var order = a.__order || Object.keys(a);
    for (var i = 0; i < order.length; i++) {
      if (order[i] === '__order') continue;
      nodeField(node, order[i], a[order[i]], m.offset, m.size);
    }
    return node;
  }

  function sessionDataNode(a, offset, size) {
    var node = makeNode('entry', 'SESSION-DATA', 'Session Data', offset, size);
    var order = a.__order || Object.keys(a);
    for (var i = 0; i < order.length; i++) {
      if (order[i] === '__order') continue;
      nodeField(node, order[i], a[order[i]], offset, size);
    }
    return node;
  }

  function keyNode(a, offset, size, title) {
    var method = (a.METHOD || '').toUpperCase();
    var node = makeNode('entry', 'KEY', title + (method ? ' (' + method + ')' : ''), offset, size);
    nodeField(node, 'METHOD', a.METHOD || '', offset, size);
    if (a.URI) nodeField(node, 'URI', a.URI, offset, size);
    if (a.IV) nodeField(node, 'IV', a.IV, offset, size);
    if (a.KEYFORMAT) nodeField(node, 'KEYFORMAT', a.KEYFORMAT, offset, size);
    if (a.KEYFORMATVERSIONS) nodeField(node, 'KEYFORMATVERSIONS', a.KEYFORMATVERSIONS, offset, size);
    return node;
  }

  function daterangeNode(a, offset, size) {
    var node = makeNode('entry', 'DATERANGE', 'Date Range', offset, size);
    var order = a.__order || Object.keys(a);
    for (var i = 0; i < order.length; i++) {
      if (order[i] === '__order') continue;
      nodeField(node, order[i], a[order[i]], offset, size);
    }
    return node;
  }

  function hintNode(tag, a, offset, size) {
    var node = makeNode('entry', tag.replace('#EXT-X-', ''), tag, offset, size);
    var order = a.__order || Object.keys(a);
    for (var i = 0; i < order.length; i++) {
      if (order[i] === '__order') continue;
      nodeField(node, order[i], a[order[i]], offset, size);
    }
    return node;
  }

  function addKey(result, a, offset, size, session) {
    var method = (a.METHOD || '').toUpperCase();
    var key = {
      method: a.METHOD || '', uri: a.URI || '', iv: a.IV || '',
      keyformat: a.KEYFORMAT || '', keyformatversions: a.KEYFORMATVERSIONS || '',
      session: !!session, offset: offset, size: size
    };
    result.keys.push(key);
    if (method && method !== 'NONE') {
      result.encrypted = true;
      result.notes.push('Encrypted playlist: #EXT-X-KEY METHOD=' + method +
        (a.KEYFORMAT ? ' KEYFORMAT=' + a.KEYFORMAT : '') +
        (session ? ' (session key)' : '') + ' — the key itself is never fetched.');
    }
  }

  /* ------------------------------------------------------------- segments */

  function parseByteRange(rest, segments) {
    var s = rest.trim();
    var m = /^(\d+)(?:@(\d+))?$/.exec(s);
    if (!m) return { length: null, offset: null, raw: s };
    var len = parseInt(m[1], 10);
    var off = m[2] != null ? parseInt(m[2], 10) : null;
    if (off == null && segments && segments.length) {
      // A byterange without @offset continues right after the previous one.
      var prev = segments[segments.length - 1];
      if (prev && prev.byterange && prev.byterange.offset != null && prev.byterange.length != null) {
        off = prev.byterange.offset + prev.byterange.length;
      }
    }
    return { length: len, offset: off, raw: s };
  }

  function buildSegment(s) {
    var inf = s.inf || {};
    var br = s.byteRange;
    var title = inf.title != null ? inf.title : '';
    var node = makeNode('entry', 'SEGMENT', 'Segment #' + s.index, inf.offset != null ? inf.offset : s.offset,
      (inf.size || 0) + s.size);
    node.expanded = false;
    if (inf.duration != null) {
      nodeField(node, '#EXTINF', inf.duration.toFixed(3) + ' s' + (title ? ', ' + title : ''),
        inf.offset, inf.size);
    }
    if (br) {
      nodeField(node, '#EXT-X-BYTERANGE',
        br.raw + (br.offset != null ? ' (offset ' + br.offset + ')' : ''),
        br.lineOffset != null ? br.lineOffset : s.offset,
        br.lineSize != null ? br.lineSize : 0);
    }
    if (s.discontinuity) nodeField(node, '#EXT-X-DISCONTINUITY', 'yes', s.offset, 0);
    if (s.programDateTime) nodeField(node, '#EXT-X-PROGRAM-DATE-TIME', s.programDateTime, s.offset, 0);
    if (s.map) nodeField(node, '#EXT-X-MAP', s.map.uri || '', s.offset, 0);
    if (s.parts && s.parts.length) nodeField(node, 'partial segments', s.parts.length, s.offset, 0);
    if (s.key && s.key.method) nodeField(node, '#EXT-X-KEY', s.key.method, s.offset, 0);
    nodeField(node, 'URI', s.uri, s.offset, s.size);

    return {
      index: s.index,
      uri: s.uri,
      duration: inf.duration != null ? inf.duration : null,
      title: title,
      byterange: br ? { length: br.length, offset: br.offset } : null,
      key: s.key ? { method: s.key.method, uri: s.key.uri, iv: s.key.iv,
                     keyformat: s.key.keyformat } : null,
      map: s.map || null,
      discontinuity: !!s.discontinuity,
      programDateTime: s.programDateTime || null,
      parts: s.parts && s.parts.length ? s.parts : null,
      offset: s.offset,
      size: s.size,
      node: node
    };
  }

  /* --------------------------------------------------------------- finish */

  /**
   * RFC 8216 playlist type:
   *   #EXT-X-PLAYLIST-TYPE:VOD           → VOD
   *   #EXT-X-PLAYLIST-TYPE:EVENT         → EVENT (append-only while live)
   *   no tag + #EXT-X-ENDLIST            → VOD (implicit)
   *   no tag + no ENDLIST                → LIVE (sliding window)
   * Master playlists carry no type of their own.
   */
  function classifyStream(result) {
    if (result.variants.length) return null;
    var tag = (result.playlistType || '').toUpperCase();
    if (tag === 'VOD') return 'VOD';
    if (tag === 'EVENT') return 'EVENT';
    if (!result.segments.length) return null;
    return result.endList ? 'VOD' : 'LIVE';
  }

  /** First regular (non-I-frame) variant is the one nested playlists open. */
  function selectVariant(result) {
    for (var i = 0; i < result.variants.length; i++) {
      if (!result.variants[i].iframeOnly) return i;
    }
    return result.variants.length ? 0 : -1;
  }

  /** DEFAULT=YES, else AUTOSELECT=YES, else simply the first rendition. */
  function pickRendition(result, groupId) {
    if (!groupId) return null;
    var list = [];
    for (var i = 0; i < result.media.length; i++) {
      var m = result.media[i];
      if ((m.attrs['GROUP-ID'] || '') === groupId && m.attrs.URI) list.push(m);
    }
    for (var d = 0; d < list.length; d++) {
      if ((list[d].attrs.DEFAULT || '').toUpperCase() === 'YES') return list[d];
    }
    for (var a = 0; a < list.length; a++) {
      if ((list[a].attrs.AUTOSELECT || '').toUpperCase() === 'YES') return list[a];
    }
    return list[0] || null;
  }

  function finish(result) {
    result.streamType = classifyStream(result);
    result.selectedVariant = selectVariant(result);
    if (result.selectedVariant >= 0) {
      result.variants[result.selectedVariant].selected = true;
    }
    // Mark the audio / subtitle / video renditions that would be loaded for
    // the selected variant (one per referenced group).
    if (result.selectedVariant >= 0) {
      var sv = result.variants[result.selectedVariant];
      [['AUDIO', sv.audioGroup], ['SUBTITLES', sv.subtitlesGroup], ['VIDEO', sv.videoGroup]]
        .forEach(function (pair) {
          var m = pickRendition(result, pair[1]);
          if (m) m.selected = true;
        });
    }

    var total = 0;
    var haveDuration = false;
    for (var i = 0; i < result.segments.length; i++) {
      if (result.segments[i].duration != null) {
        total += result.segments[i].duration;
        haveDuration = true;
      }
    }
    if (haveDuration) {
      result.durationSec = total;
      result.extra.push({ label: 'Segments', value: String(result.segments.length) });
      result.extra.push({ label: 'Total duration', value: MA.formatDuration(total) });
    }
    if (result.targetDuration != null) {
      result.extra.push({ label: 'Target duration', value: result.targetDuration + ' s' });
    }
    if (result.version != null) result.extra.push({ label: 'HLS version', value: String(result.version) });
    if (result.streamType) {
      result.extra.push({ label: 'Stream type',
        value: result.streamType + (result.streamType === 'EVENT' && result.endList
          ? ' (complete — #EXT-X-ENDLIST present)' : '') });
    }
    if (result.mediaSequence != null) {
      result.extra.push({ label: 'Media sequence', value: String(result.mediaSequence) });
    }
    if (result.variants.length) {
      result.extra.push({ label: 'Variants', value: String(result.variants.length) });
      if (result.selectedVariant >= 0) {
        var sel = result.variants[result.selectedVariant];
        result.extra.push({ label: 'Selected variant', value:
          '#' + (result.selectedVariant + 1) + ' — ' + (sel.uri || '') +
          (sel.bandwidth != null ? ' (' + MA.formatBitrate(sel.bandwidth) + ')' : '') });
      }
    }
    if (result.endList) result.extra.push({ label: 'Complete', value: '#EXT-X-ENDLIST present' });

    // Give each variant track a share of the duration/orientation once known.
    for (var t = 0; t < result.tracks.length; t++) {
      if (result.tracks[t].type === 'video' && result.durationSec != null &&
          result.tracks[t].durationSec == null && result.segments.length) {
        result.tracks[t].durationSec = result.durationSec;
        result.tracks[t].sampleCount = result.segments.length;
      }
    }

    /* ---- frames: one row per segment (the playlist has no samples of its own) ---- */
    for (var f = 0; f < result.segments.length; f++) {
      var seg = result.segments[f];
      result.frames.push({
        track: 0,
        index: seg.index + 1,
        type: 'segment',
        kind: 'other',
        codec: '',
        offset: seg.offset,
        size: seg.size,
        ptsSec: null,
        dtsSec: null,
        durationSec: seg.duration,
        keyframe: false,
        label: (seg.byterange && seg.byterange.length
                  ? 'byterange ' + seg.byterange.length + ' B'
                  : 'segment') + (seg.key ? ' [encrypted]' : ''),
        // A playlist segment has no samples of its own, but it does have a URI
        // and a duration — show those rather than an empty panel.
        tables: [MA.synSection('EXTINF segment',
          'segment ' + (seg.index + 1) + ' of ' + result.segments.length, [
          { name: 'URI', syntax: '', bits: '', value: seg.uri || '—',
            note: '', offset: seg.offset || 0, depth: 0 },
          { name: 'duration', syntax: 'EXTINF', bits: '',
            value: seg.duration != null ? seg.duration + ' s' : '—',
            note: seg.title || '', offset: seg.offset || 0, depth: 0 },
          seg.byterange ? { name: 'byterange', syntax: 'EXT-X-BYTERANGE', bits: '',
            value: seg.byterange.length + ' B @ ' +
                   (seg.byterange.offset != null ? seg.byterange.offset : 'implicit'),
            note: '', offset: seg.offset || 0, depth: 0 } : null,
          seg.key ? { name: 'encryption', syntax: 'EXT-X-KEY', bits: '',
            value: seg.key.method || '—', note: seg.key.uri || '',
            offset: seg.offset || 0, depth: 0 } : null
        ].filter(Boolean))]
      });
    }

    /* ---- notes ---- */
    if (result.variants.length && !result.segments.length) {
      result.notes.push('Master playlist: ' + result.variants.length +
        ' variant streams, no media segments — the segments live in the referenced playlists.');
      if (result.selectedVariant >= 0) {
        result.notes.push('Nested playlist: the first variant (' +
          result.variants[result.selectedVariant].uri + ') is selected for loading.');
      }
    }
    if (!result.variants.length && !result.segments.length) {
      result.notes.push('No variant streams and no segments were found in this playlist.');
    }
    if (result.streamType === 'LIVE') {
      result.notes.push('Live stream (sliding window): no #EXT-X-PLAYLIST-TYPE and no ' +
        '#EXT-X-ENDLIST — the playlist keeps refreshing.');
    } else if (result.streamType === 'EVENT') {
      result.notes.push('Event stream: segments are appended until #EXT-X-ENDLIST' +
        (result.endList ? ' (now present, so the event is complete).' : ' (not present yet).'));
    } else if (result.streamType === 'VOD' && !result.playlistType) {
      result.notes.push('VOD stream: #EXT-X-ENDLIST closes the playlist (implicit VOD).');
    }
    if (result.iframeOnly) {
      result.notes.push('#EXT-X-I-FRAMES-ONLY: the listed segments contain I-frames only.');
    }
    if (result.dateranges.length) {
      result.notes.push(result.dateranges.length + ' #EXT-X-DATERANGE entr(y/ies) present.');
    }
    if (result.segments.length) {
      var withMap = 0;
      for (var m = 0; m < result.segments.length; m++) if (result.segments[m].map) withMap++;
      if (withMap) {
        result.notes.push(withMap + ' segment(s) reference an initialization section (#EXT-X-MAP).');
      }
    }
    result.notes.push('Playlist parsing is offline: no segment or key URL was fetched.');
  }

  /* ============================================================ online ====
   *
   * The synchronous parse() above only reads playlist text. expand() is the
   * optional online pass: it follows the first variant of a master playlist,
   * loads the default audio / video / subtitle renditions, fetches a bounded
   * number of media segments, parses the actual .ts / .m4s containers and
   * attaches the decoded frames to the playlist result so the frame list and
   * syntax panels show real samples.
   *
   * All network access goes through opts.fetchUrl, so the logic is testable
   * without sockets and the browser stays in control of credentials/CORS.
   * ========================================================================*/

  var DEFAULT_SEGMENTS_PER_TRACK = 2;

  function encodeUtf8(text) {
    try { return new TextEncoder().encode(text); }
    catch (e) {
      var out = new Uint8Array(text.length);
      for (var i = 0; i < text.length; i++) out[i] = text.charCodeAt(i) & 0xff;
      return out;
    }
  }

  function decodeUtf8(bytes) {
    try { return new TextDecoder('utf-8').decode(bytes); }
    catch (e) {
      var s = '';
      for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
      return s;
    }
  }

  /** Parse playlist text the same way a downloaded .m3u8 would be parsed. */
  function parseText(text, name) {
    return parse({ data: encodeUtf8(text), name: name || 'playlist.m3u8',
                   ext: 'm3u8', size: text.length });
  }

  function defaultFetchUrl(url, range) {
    var headers = {};
    if (range && range.length != null && range.start != null) {
      headers.Range = 'bytes=' + range.start + '-' + (range.start + range.length - 1);
    }
    return globalThis.fetch(url, { headers: headers }).then(function (res) {
      if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status + ' for ' + url);
      return res.arrayBuffer();
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  function urlExt(uri) {
    var path = String(uri || '').split('?')[0].split('#')[0];
    var slash = path.lastIndexOf('/');
    var base = slash >= 0 ? path.slice(slash + 1) : path;
    var dot = base.lastIndexOf('.');
    return dot >= 0 ? base.slice(dot + 1).toLowerCase() : '';
  }

  function fourcc(bytes, off) {
    var s = '';
    for (var i = 0; i < 4; i++) s += String.fromCharCode(bytes[off + i] || 0);
    return s;
  }

  /**
   * Identify the media container of one segment.
   * @param forcedType 'audio' | 'video' | 'subtitle' — the rendition's TYPE
   */
  function segmentContainer(uri, bytes, forcedType) {
    var ext = urlExt(uri);
    if (forcedType === 'subtitle' || ext === 'vtt' || ext === 'webvtt') return 'vtt';
    if (ext === 'ts' || ext === 'm2ts' || ext === 'tsv' || ext === 'tsa') return 'ts';
    if (ext === 'm4s' || ext === 'mp4' || ext === 'cmfv' || ext === 'cmfa' ||
        ext === 'cmft' || ext === 'm4v') return 'fmp4';
    if (ext === 'aac') return 'aac';
    // Content sniffing for URIs without a useful extension.
    if (bytes.length >= 1 && bytes[0] === 0x47) return 'ts';
    if (bytes.length >= 8 && /^(ftyp|styp|moof)$/.test(fourcc(bytes, 4))) return 'fmp4';
    if (bytes.length >= 6 && decodeUtf8(bytes.subarray(0, 6)).replace(/^﻿/, '') === 'WEBVTT') {
      return 'vtt';
    }
    return 'unknown';
  }

  function errMsg(err) { return (err && err.message) ? err.message : String(err); }

  function countVttCues(text) {
    var m = text.match(/-->/g);
    return m ? m.length : 0;
  }

  /** Build the load plan: the chosen variant plus its referenced renditions. */
  function planLoads(result) {
    var loads = [];
    if (result.variants.length) {
      var vi = result.selectedVariant >= 0 ? result.selectedVariant
             : (result.variants[0] && !result.variants[0].iframeOnly ? 0 : 0);
      var v = result.variants[vi];
      if (v && v.uri) {
        loads.push({ role: 'variant', type: 'video', uri: v.uri,
                     trackId: v.trackId, label: 'Variant #' + (vi + 1) });
      }
      if (v) {
        [['audio', v.audioGroup], ['subtitle', v.subtitlesGroup], ['video', v.videoGroup]]
          .forEach(function (pair) {
            var m = pickRendition(result, pair[1]);
            if (m && m.attrs.URI) {
              loads.push({ role: 'rendition', type: pair[0], uri: m.attrs.URI,
                           trackId: m.trackId, label: (m.attrs.NAME || pair[0]) +
                             ' (' + pair[0] + ')', media: m });
            }
          });
      }
    } else if (result.segments.length) {
      loads.push({ role: 'inline', type: 'auto', uri: null,
                   trackId: null, label: 'Media playlist' });
    }
    return loads;
  }

  /**
   * Fetch + parse one media playlist and a bounded prefix of its segments.
   * @returns Promise<{trackInfo, frameCount, kind…}> never rejects (notes only).
   */
  function loadStream(load, parent, opts, state) {
    var streamUrl = load.uri ? new URL(load.uri, opts.baseUrl).href : opts.baseUrl;
    var mediaPromise = load.uri
      ? opts.fetchUrl(streamUrl).then(function (bytes) {
          var text = decodeUtf8(bytes);
          return { result: parseText(text, urlExt(new URL(streamUrl).pathname) || 'media.m3u8'),
                   bytes: bytes };
        })
      : Promise.resolve({ result: parent, bytes: null });

    return mediaPromise.then(function (mr) {
      var pl = mr.result;
      // Segment / key / init URIs resolve against the media playlist URL,
      // which for a rendition may live in a different directory from the
      // master playlist that referenced it.
      var streamBase = streamUrl;
      if (!pl.segments.length) return { load: load, frames: 0, cues: 0, containers: {} };

      // The stream type of a master is really the variant playlist's type.
      if (parent.variants.length && pl.streamType) parent.effectiveStreamType = pl.streamType;
      if (pl.durationSec != null && (parent.durationSec == null || pl.durationSec > parent.durationSec)) {
        parent.durationSec = pl.durationSec;
      }

      var max = Math.min(opts.maxSegments, pl.segments.length);
      var initCache = null;
      var timeBase = { video: 0, audio: 0, subtitle: 0 };
      var added = [];
      var containers = {};
      var cues = 0;
      var chain = Promise.resolve();

      pl.segments.slice(0, max).forEach(function (seg, segIdx) {
        chain = chain.then(function () {
          if (seg.key && (seg.key.method || 'NONE') !== 'NONE') {
            containers.encrypted = (containers.encrypted || 0) + 1;
            parent.notes.push('Segment ' + (segIdx + 1) + ' is encrypted (' +
              seg.key.method + '); skipped — keys are not fetched.');
            return { skipped: true };
          }
          var abs = new URL(seg.uri, streamBase).href;
          var range = seg.byterange && seg.byterange.offset != null && seg.byterange.length
            ? { start: seg.byterange.offset, length: seg.byterange.length } : null;
          return opts.fetchUrl(abs, range).then(function (bytes) {
            var forced = load.type === 'auto' ? null : load.type;
            var kind = segmentContainer(seg.uri, bytes, forced);
            containers[kind] = (containers[kind] || 0) + 1;
            if (opts.onProgress) {
              opts.onProgress('Parsed ' + load.label + ' segment ' + (segIdx + 1) +
                              ' (' + kind + ', ' + MA.formatSize(bytes.length) + ')');
            }
            if (kind === 'vtt') return consumeVtt(load, parent, state, seg, segIdx,
                                                   abs, bytes, timeBase, added);
            if (kind !== 'ts' && kind !== 'fmp4' && kind !== 'aac') {
              return { skipped: true };
            }
            return fetchInitIfNeeded(pl, seg, opts, initCache, streamBase).then(function (gotInit) {
              initCache = gotInit;
              var buffer = kind === 'fmp4' && initCache
                ? MA.concatBytes([initCache, bytes]) : bytes;
              var parserId = kind === 'ts' ? 'ts' : kind === 'aac' ? 'adts' : 'mp4';
              var parsed = parseSegmentBuffer(parserId, buffer, seg.uri, kind);
              consumeSegment(load, parent, state, seg, segIdx, abs, parsed,
                             buffer, kind, timeBase, added);
              return null;
            });
          });
        });
      });

      return chain.then(function () {
        return { load: load, frames: added.length, cues: cues,
                 containers: containers, mediaPlaylist: pl };
      });
    }).catch(function (err) {
      parent.notes.push('HLS load failed for "' + (load.uri || 'media playlist') +
                        '": ' + errMsg(err));
      return { load: load, frames: 0, cues: 0, containers: {}, error: errMsg(err) };
    });
  }

  function fetchInitIfNeeded(pl, seg, opts, cache, streamBase) {
    if (cache) return Promise.resolve(cache);
    var map = seg.map || (pl.segments[0] && pl.segments[0].map);
    if (!map || !map.uri) return Promise.resolve(null);
    var abs = new URL(map.uri, streamBase).href;
    var range = map.byterange && map.byterange.offset != null && map.byterange.length
      ? { start: map.byterange.offset, length: map.byterange.length } : null;
    return opts.fetchUrl(abs, range).then(function (b) { return b; }, function () { return null; });
  }

  function parseSegmentBuffer(parserId, buffer, uri, kind) {
    var detected = { id: parserId };
    var parser = MA.getParser(parserId);
    return parser.parse({
      data: buffer, bytes: MA.makeByteSource(buffer, null),
      name: urlExt(uri) ? uri.split('/').pop() : ('segment.' + (kind === 'ts' ? 'ts' : 'm4s')),
      ext: kind === 'ts' ? 'ts' : 'm4s', size: buffer.length, detection: detected
    });
  }

  /** Find/create the playlist-level track a segment track maps to. */
  function resolveTrack(load, parent, state, segTrack) {
    var type = segTrack.type;
    // The rendition's own declared track always wins for its content type.
    if (load.trackId != null) {
      var declared = parent.tracks.filter(function (t) { return t.id === load.trackId; })[0];
      // 'auto' is the media playlist itself (e.g. muxed TS): all its tracks
      // share that declared playlist track. A variant only claims matching
      // types — extra muxed content (audio inside a video variant) gets its
      // own track below.
      if (declared && (load.type === 'auto' || load.type === type)) {
        return declared;
      }
    }
    // Muxed content inside a variant maps onto the loaded rendition track.
    if (state.prepared[type] != null) return state.prepared[type];
    var t = {
      id: parent.tracks.length + 1,
      type: type,
      codec: segTrack.codec || '',
      codecName: segTrack.codecName || 'unknown',
      profile: segTrack.profile || '', level: segTrack.level || '',
      width: segTrack.width || null, height: segTrack.height || null,
      fps: segTrack.fps || null,
      sampleRate: segTrack.sampleRate || null, channels: segTrack.channels || null,
      durationSec: null, bitrate: null, sampleCount: 0,
      language: segTrack.language || '', extra: [], fromHlsSegments: true
    };
    t.extra.push({ label: 'HLS track', value: load.label });
    parent.tracks.push(t);
    state.created[type] = t.id;
    state.prepared[type] = t;
    return t;
  }

  function adoptTrackInfo(track, segTrack) {
    // The playlist may have left a placeholder codec copied from the
    // rendition TYPE (AUDIO / VIDEO / SUBTITLES); a real codec from the
    // parsed segment replaces it.
    var placeholder = { audio: 'AUDIO', video: 'VIDEO', subtitle: 'SUBTITLES' }[track.type];
    ['codec', 'codecName', 'profile', 'level'].forEach(function (k) {
      if ((!track[k] || track[k] === placeholder || track[k] === 'unknown') && segTrack[k]) {
        track[k] = segTrack[k];
      }
    });
    ['width', 'height', 'fps', 'sampleRate', 'channels'].forEach(function (k) {
      if (track[k] == null && segTrack[k] != null) track[k] = segTrack[k];
    });
    if (!track.language && segTrack.language) track.language = segTrack.language;
    if (segTrack.bitrate) track.bitrate = segTrack.bitrate;
    track.fromHlsSegments = true;
  }

  function consumeSegment(load, parent, state, seg, segIdx, absUrl, parsed,
                          buffer, kind, timeBase, added) {
    // Map every segment track to a playlist track.
    parsed.tracks.forEach(function (st) {
      var mt = resolveTrack(load, parent, state, st);
      adoptTrackInfo(mt, st);
      state.segToMain[st.id] = mt.id;
      if (st.type === 'video' || st.type === 'audio') state.prepared[st.type] = mt;
    });
    // Default mapping when a frame references an unknown segment track id.
    var fallbackByType = {};
    parsed.tracks.forEach(function (st) { fallbackByType[st.type] = state.segToMain[st.id]; });

    var source = MA.makeByteSource(buffer, null);
    var baseOffset = 0;
    parsed.frames.forEach(function (fr) {
      var stTrack = parsed.tracks.filter(function (t) { return String(t.id) === String(fr.track); })[0];
      var type = stTrack ? stTrack.type : (fr.kind === 'audio' ? 'audio' : 'video');
      var mainId = state.segToMain[fr.track] != null ? state.segToMain[fr.track]
                   : fallbackByType[type];
      if (mainId == null) return;
      var vf = shallowCopyFrame(fr);
      vf.track = mainId;
      vf.virtual = true;
      vf.virtualSource = source;
      vf.virtualResult = parsed;
      vf.detail = Object.assign({}, vf.detail, {
        hlsSegment: segIdx + 1, hlsUri: absUrl.split('/').pop()
      });
      // TS timestamps restart at every segment; fMP4 tfdt is already on the
      // continuous media timeline.
      if (kind === 'ts') {
        baseOffset = timeBase[type] || 0;
        if (fr.dtsSec != null) vf.dtsSec = fr.dtsSec + baseOffset;
        if (fr.ptsSec != null) vf.ptsSec = fr.ptsSec + baseOffset;
      }
      added.push(vf);
      parent.frames.push(vf);
    });
    if (kind === 'ts' && seg.duration != null) {
      ['video', 'audio'].forEach(function (ty) {
        if (fallbackByType[ty] != null || (load.type === ty)) {
          timeBase[ty] = (timeBase[ty] || 0) + seg.duration;
        }
      });
    }
    // Per-track stats.
    parsed.tracks.forEach(function (st) {
      var mt = parent.tracks.filter(function (t) { return t.id === state.segToMain[st.id]; })[0];
      if (!mt) return;
      mt.sampleCount = (mt.sampleCount || 0) + (st.sampleCount || 0);
      if (st.durationSec && (mt.durationSec == null || st.durationSec > mt.durationSec)) {
        mt.durationSec = st.durationSec;
      }
    });
    markPlaylistSegmentLoaded(parent, seg);
  }

  function shallowCopyFrame(fr) {
    var out = {};
    Object.keys(fr).forEach(function (k) {
      if (k === 'tables') return;          // rebuilt lazily from the virtual source
      out[k] = fr[k];
    });
    return out;
  }

  function consumeVtt(load, parent, state, seg, segIdx, absUrl, bytes, timeBase, added) {
    var text = decodeUtf8(bytes);
    var cues = countVttCues(text);
    var mainId = load.trackId;
    if (mainId == null) {
      var track = {
        id: parent.tracks.length + 1, type: 'subtitle', codec: 'wvtt',
        codecName: 'WebVTT', profile: '', level: '', width: null, height: null,
        fps: null, sampleRate: null, channels: null, durationSec: null,
        bitrate: null, sampleCount: cues, language: load.media && load.media.attrs.LANGUAGE || '',
        extra: [{ label: 'HLS track', value: load.label }], fromHlsSegments: true
      };
      parent.tracks.push(track);
      mainId = track.id;
      state.prepared.subtitle = track;
    } else {
      var mt = parent.tracks.filter(function (t) { return t.id === mainId; })[0];
      if (mt) {
        if (!mt.codec || mt.codec === 'SUBTITLES' || mt.codec === 'unknown') mt.codec = 'wvtt';
        if (!mt.codecName || mt.codecName === 'SUBTITLES' || /media rendition/.test(mt.codecName)) {
          mt.codecName = 'WebVTT';
        }
        mt.fromHlsSegments = true;
      }
    }
    var vf = {
      track: mainId, index: segIdx + 1, type: 'subtitle', kind: 'other',
      codec: 'wvtt', offset: seg.offset || 0, size: bytes.length,
      ptsSec: null, dtsSec: null, durationSec: seg.duration, keyframe: false,
      label: 'WebVTT (' + cues + ' cue' + (cues === 1 ? '' : 's') + ')',
      tables: [MA.synSection('WebVTT segment', seg.uri + ' — segment ' + (segIdx + 1), [
        { name: 'URI', syntax: '', bits: '', value: seg.uri, note: '', offset: seg.offset || 0, depth: 0 },
        { name: 'cues', syntax: '', bits: '', value: String(cues),
          note: 'cue timing lines (-->)', offset: seg.offset || 0, depth: 0 }
      ])]
    };
    added.push(vf);
    parent.frames.push(vf);
    markPlaylistSegmentLoaded(parent, seg);
    return { skipped: false, cues: cues };
  }

  function markPlaylistSegmentLoaded(parent, seg) {
    seg.loaded = true;
    // Annotate the playlist-owned segment row so its panel shows the outcome.
    for (var i = 0; i < parent.frames.length; i++) {
      var f = parent.frames[i];
      if (f.type === 'segment' && f.index === seg.index + 1) {
        f.loaded = true;
        f.label = (f.label || 'segment') + ' · parsed';
        break;
      }
    }
  }

  function appendLoadedGroup(parent, reports) {
    var group = MA.makeNode('group', 'hls-loaded', 'Loaded Media (HLS)', 0, 0);
    group.expanded = false;
    reports.forEach(function (rep) {
      var entry = MA.makeNode('entry', 'HLS-TRACK', rep.load.label, 0, 0);
      MA.nodeField(entry, 'URI', rep.load.uri || '(this playlist)', 0, 0);
      Object.keys(rep.containers || {}).forEach(function (k) {
        MA.nodeField(entry, k + ' segments', String(rep.containers[k]), 0, 0);
      });
      MA.nodeField(entry, 'media frames', String(rep.frames || 0), 0, 0);
      if (rep.error) MA.nodeNote(entry, rep.error);
      group.children.push(entry);
    });
    parent.structures.push(group);
  }

  /**
   * Online expansion. Mutates and returns the same result object.
   * @param {object} result    output of the synchronous m3u8 parse()
   * @param {object} opts      { baseUrl, fetchUrl, maxSegments, onProgress }
   */
  function expand(result, opts) {
    opts = opts || {};
    if (!opts.fetchUrl) opts.fetchUrl = defaultFetchUrl;
    if (opts.maxSegments == null) opts.maxSegments = DEFAULT_SEGMENTS_PER_TRACK;
    if (!opts.baseUrl) throw new Error('expand() needs a baseUrl to resolve relative URIs');
    if (result._hlsExpanding) return Promise.resolve(result);
    result._hlsExpanding = true;

    var loads = planLoads(result);
    var state = { prepared: {}, created: {}, segToMain: {} };
    var reports = [];

    var chain = Promise.resolve();
    loads.forEach(function (load) {
      chain = chain.then(function () {
        return loadStream(load, result, opts, state).then(function (rep) {
          reports.push(rep);
        });
      });
    });

    return chain.then(function () {
      finishExpand(result, reports);
      if (result.mediaFrameCount > 0) appendLoadedGroup(result, reports);
      result._hlsExpanding = false;
      result._hlsExpanded = true;
      return result;
    }).catch(function (err) {
      result._hlsExpanding = false;
      result.notes.push('HLS expansion stopped: ' + errMsg(err));
      return result;
    });
  }

  function finishExpand(result, reports) {
    var loadedSegments = 0, containers = {};
    reports.forEach(function (r) {
      Object.keys(r.containers || {}).forEach(function (k) {
        containers[k] = (containers[k] || 0) + r.containers[k];
        if (k !== 'encrypted') loadedSegments += r.containers[k];
      });
    });
    result.loadedSegments = loadedSegments;
    result.mediaFrameCount = countVirtualFrames(result);

    // Nothing could be fetched (404s, CORS, all-encrypted …): keep the result
    // in its offline state rather than claiming an empty online pass.
    if (!loadedSegments || !result.mediaFrameCount) {
      return;
    }

    // Drop the "offline" disclaimer — segments really were fetched.
    result.notes = result.notes.filter(function (n) {
      return n.indexOf('Playlist parsing is offline') !== 0;
    });
    result.extra = result.extra.filter(function (e) { return e.label !== 'Loaded media'; });
    result.extra.push({ label: 'Loaded media',
      value: loadedSegments + ' segment(s) parsed — ' + result.mediaFrameCount +
             ' media frames (' + Object.keys(containers).join(', ') + ')' });
    if (result.effectiveStreamType && !result.streamType) {
      result.extra.push({ label: 'Stream type', value: result.effectiveStreamType + ' (variant playlist)' });
    }
    result.notes.push('Online: fetched and parsed ' + loadedSegments +
      ' segment(s); decoded frames are attached to their tracks.');
    // Virtual frames were pushed during consumption; re-sort on a stable key
    // (track, then pts) while keeping playlist rows first.
    var rows = result.frames.filter(function (f) { return f.type === 'segment'; });
    var media = result.frames.filter(function (f) { return f.type !== 'segment'; });
    media.sort(function (a, b) {
      var ta = a.track == null ? 0 : a.track, tb = b.track == null ? 0 : b.track;
      if (ta !== tb) return ta - tb;
      return (a.dtsSec != null ? a.dtsSec : (a.ptsSec || 0)) -
             (b.dtsSec != null ? b.dtsSec : (b.ptsSec || 0));
    });
    result.frames = rows.concat(media);
    result.frames.forEach(function (f, i) { f.listIndex = i + 1; });
  }

  function countVirtualFrames(result) {
    var n = 0;
    for (var i = 0; i < result.frames.length; i++) {
      if (result.frames[i].virtual) n++;
    }
    return n;
  }

  MA.registerParser({
    id: 'm3u8',
    name: 'HLS playlist (M3U8)',
    extensions: ['m3u8', 'm3u'],
    parse: parse
  });

  MA.m3u8 = {
    parseCodecString: parseCodecString,
    parseAttributes: parseAttributes,
    parseText: parseText,
    classifyStream: classifyStream,
    expand: expand
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
