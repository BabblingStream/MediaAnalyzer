/* ============================================================================
 * MediaAnalyzer — parsers/flv.js
 *
 * FLV (Flash Video), Adobe "Video File Format Specification v10.1".
 *
 *   FLV header : Signature 'FLV', Version, TypeFlags, DataOffset
 *   tag chain  : 11-byte tag header + payload + PreviousTagSize
 *                TagType 8  = audio   (SoundFormat/Rate/Size/Type)
 *                TagType 9  = video   (FrameType/CodecID + AVC / HEVC framing)
 *                TagType 18 = script  (AMF0 — usually onMetaData)
 *
 * Two things this file is careful about:
 *
 *   1. every `nodeField` / syntax-row offset is the TRUE absolute file offset,
 *      so the hex view can jump to it;
 *   2. sample frames carry a small `syn` recipe (numbers + strings) instead of
 *      a closure over the payload. The app re-reads [offset, offset+size) from
 *      the ByteSource on demand — see js/framesyntax.js.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField, nodeNote = MA.nodeNote;
  var synSection = MA.synSection, hex = MA.hex, formatSize = MA.formatSize;

  /* ------------------------------------------------------------------ caps */

  var MAX_TAGS = 400000;        // tag-chain iteration guard
  var MAX_FRAMES = 50000;       // frames handed to the UI
  var MAX_TAG_NODES = 5000;     // structure-tree tag nodes
  var MAX_META_ROWS = 80;       // metadata keys rendered in the script table
  var AMF_MAX_DEPTH = 4;        // AMF0 nesting guard
  var AMF_MAX_ITEMS = 4096;     // properties / array elements per container

  /* ---------------------------------------------------------------- tables */

  var TAG_TYPE = { 8: 'audio', 9: 'video', 18: 'script' };

  var VIDEO_CODEC = {
    2:  { name: 'Sorenson H.263', codec: 'h263' },
    3:  { name: 'Screen video', codec: 'screen' },
    4:  { name: 'On2 VP6', codec: 'vp6' },
    5:  { name: 'On2 VP6 with alpha', codec: 'vp6a' },
    6:  { name: 'Screen video v2', codec: 'screen2' },
    7:  { name: 'H.264 / AVC', codec: 'h264' },
    12: { name: 'H.265 / HEVC', codec: 'h265' }
  };

  var FRAME_TYPE = {
    1: 'keyframe', 2: 'inter frame', 3: 'disposable inter frame',
    4: 'generated keyframe', 5: 'video info / command frame'
  };

  var SOUND_FORMAT = {
    0: { name: 'Linear PCM, platform endian', codec: 'pcm' },
    1: { name: 'ADPCM', codec: 'adpcm' },
    2: { name: 'MP3', codec: 'mp3' },
    3: { name: 'Linear PCM, little endian', codec: 'pcm' },
    4: { name: 'Nellymoser 16 kHz mono', codec: 'nellymoser' },
    5: { name: 'Nellymoser 8 kHz mono', codec: 'nellymoser' },
    6: { name: 'Nellymoser', codec: 'nellymoser' },
    7: { name: 'G.711 A-law', codec: 'alaw' },
    8: { name: 'G.711 mu-law', codec: 'mulaw' },
    10: { name: 'AAC', codec: 'aac' },
    11: { name: 'Speex', codec: 'speex' },
    14: { name: 'MP3 8 kHz', codec: 'mp3' },
    15: { name: 'Device-specific', codec: '' }
  };

  /* The FLV SoundRate field is labelled 5.5 / 11 / 22 / 44 kHz in the spec,
   * but MP3-in-FLV actually carries the MPEG sample rates below. Repeating the
   * spec labels would mis-state every MP3 track, so the real Hz are reported. */
  var SOUND_RATES = [5512, 11025, 22050, 44100];

  var AMF_TYPE_NAME = {
    0x00: 'Number', 0x01: 'Boolean', 0x02: 'String', 0x03: 'Object',
    0x04: 'MovieClip', 0x05: 'Null', 0x06: 'Undefined', 0x07: 'Reference',
    0x08: 'ECMA Array', 0x09: 'Object End', 0x0a: 'Strict Array',
    0x0b: 'Date', 0x0c: 'Long String', 0x0d: 'Unsupported',
    0x0f: 'XML Document', 0x10: 'Typed Object', 0x11: 'AVM+ (AMF3)'
  };

  function msg(e) { return String((e && e.message) || e); }

  /* ==========================================================================
   * AMF0 decoder
   *
   * The script tag is a flat list of (name, value) pairs. Only the value types
   * that actually appear in FLV files are worth decoding in full; everything
   * else stops the walk cleanly with a note instead of throwing.
   * ========================================================================*/

  /**
   * @param {Uint8Array} data
   * @param {number} start  absolute offset of the first value
   * @param {number} end    absolute end of the script data block
   * @returns {{ values: Array, error: null|string, consumed: number }}
   */
  function amfDecode(data, start, end) {
    var p = start, values = [], error = null;

    function fail(t) { throw new Error(t); }
    function need(n) { if (p + n > end) fail('AMF0 value truncated'); }

    function u8() { need(1); return data[p++]; }
    function u16() { need(2); var v = (data[p] << 8) | data[p + 1]; p += 2; return v; }
    function i16() { var v = u16(); return v > 0x7fff ? v - 0x10000 : v; }
    function u32() {
      need(4);
      var v = data[p] * 16777216 + (data[p + 1] << 16) + (data[p + 2] << 8) + data[p + 3];
      p += 4;
      return v >>> 0;
    }
    function f64() {
      need(8);
      var v = new DataView(data.buffer, data.byteOffset + p, 8).getFloat64(0);
      p += 8;
      return v;
    }
    function str(n) {
      if (n <= 0) return '';
      need(n);
      var s = '';
      try {
        s = new TextDecoder('utf-8').decode(data.subarray(p, p + n));
      } catch (e) {
        for (var i = 0; i < n; i++) s += String.fromCharCode(data[p + i]);
      }
      p += n;
      return s;
    }

    /** Property list, terminated by ('' + 0x09). */
    function readProperties(depth, offs, isEcma) {
      if (depth > AMF_MAX_DEPTH) fail('AMF0 nesting deeper than ' + AMF_MAX_DEPTH);
      var obj = {}, n = 0;
      for (;;) {
        if (p >= end) break;
        if (n > AMF_MAX_ITEMS) break;
        var keyOff = p;
        var klen = u16();
        // A zero-length key directly followed by the object-end marker ends
        // the list. Some encoders emit an empty property instead — keep going.
        if (klen === 0 && data[p] === 0x09) { p++; break; }
        var key = str(klen);
        var v = readValue(depth + 1);
        obj[key] = v;
        if (offs) offs[key] = keyOff;
        n++;
      }
      return obj;
    }

    function attachOffsets(obj, offs) {
      try {
        Object.defineProperty(obj, '__off', { value: offs, enumerable: false });
      } catch (e) { /* frozen object — offsets are a nicety, not a requirement */ }
    }

    function readValue(depth) {
      if (depth > AMF_MAX_DEPTH) fail('AMF0 nesting deeper than ' + AMF_MAX_DEPTH);
      var type = u8();
      switch (type) {
        case 0x00: return f64();
        case 0x01: return u8() !== 0;
        case 0x02: return str(u16());
        case 0x0c: return str(u32());
        case 0x03: {                                   // anonymous object
          var offs3 = {};
          var o3 = readProperties(depth, offs3, false);
          attachOffsets(o3, offs3);
          return o3;
        }
        case 0x04: return readProperties(depth, null, false);   // MovieClip (reserved)
        case 0x08: {                                   // ECMA array
          u32();                                       // count is only a hint
          var offs8 = {};
          var o8 = readProperties(depth, offs8, true);
          attachOffsets(o8, offs8);
          return o8;
        }
        case 0x09: fail('unexpected AMF0 object-end marker');
        case 0x0a: {                                   // strict array
          var n = u32();
          var cap = MA.safeCount(n, end - p, 1);
          if (cap < n) fail('strict array declares ' + n + ' elements, ' + cap + ' fit');
          var arr = [];
          for (var i = 0; i < n; i++) arr.push(readValue(depth + 1));
          return arr;
        }
        case 0x05: return null;
        case 0x06: return undefined;
        case 0x07: { var idx = u16(); return { __ref: idx }; }
        case 0x0b: {                                   // Date
          var ms = f64();
          var tz = i16();
          var d = new Date(ms);
          var out = isNaN(d.getTime()) ? { __date: ms } : d;
          if (out && typeof out === 'object') out.__tz = tz;
          return out;
        }
        case 0x0d: return { __unsupported: true };
        case 0x0f: return str(u32());                  // XML document
        case 0x10: {                                   // typed object
          var cls = str(u16());
          var offs10 = {};
          var o10 = readProperties(depth, offs10, false);
          attachOffsets(o10, offs10);
          o10.__class = cls;
          return o10;
        }
        case 0x11: return { __avmplus: true };         // AMF3 object — not decoded
        default:
          fail('unsupported AMF0 type 0x' + type.toString(16) + ' at ' + hex(p - 1, 8));
      }
      return null;
    }

    var guard = 0;
    while (p < end && guard++ < AMF_MAX_ITEMS) {
      try {
        values.push(readValue(0));
      } catch (e) {
        error = msg(e);
        break;
      }
    }
    return { values: values, error: error, consumed: p - start };
  }

  /** Byte offset recorded for `key` inside an AMF0 object (or `fallback`). */
  function metaOffset(obj, key, fallback) {
    var m = obj && obj.__off;
    return (m && m[key] != null) ? m[key] : fallback;
  }

  /** Display string for an arbitrary AMF0 value. */
  function amfText(v, depth) {
    depth = depth || 0;
    if (v === null) return 'null';
    if (v === undefined) return 'undefined';
    if (typeof v === 'number') return MA.formatNum(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'string') return v.length > 240 ? v.slice(0, 240) + '…' : v;
    if (v instanceof Date) return isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
    if (Array.isArray(v)) {
      if (depth > 2) return '[' + v.length + ' items]';
      var parts = [];
      for (var i = 0; i < v.length && i < 12; i++) parts.push(amfText(v[i], depth + 1));
      return '[' + parts.join(', ') + (v.length > 12 ? ', … (' + v.length + ' items)' : '') + ']';
    }
    if (typeof v === 'object') {
      if (v.__ref != null) return '<reference #' + v.__ref + '>';
      if (v.__unsupported) return '<unsupported>';
      if (v.__avmplus) return '<AVM+ object>';
      if (v.__class) return '<' + v.__class + ' object>';
      var keys = Object.keys(v).filter(function (k) { return k.indexOf('__') !== 0; });
      if (depth > 2) return '{' + keys.length + ' keys}';
      var out = [];
      for (var k = 0; k < keys.length && k < 12; k++) {
        out.push(keys[k] + ': ' + amfText(v[keys[k]], depth + 1));
      }
      return '{' + out.join(', ') + (keys.length > 12 ? ', …' : '') + '}';
    }
    return String(v);
  }

  function asNumber(v) {
    if (typeof v === 'number' && isFinite(v)) return v;
    if (typeof v === 'string' && v !== '' && isFinite(Number(v))) return Number(v);
    return null;
  }
  function asBool(v) {
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v === 'true' || v === '1';
    return null;
  }
  function asText(v) {
    if (v == null) return '';
    return typeof v === 'string' ? v : amfText(v);
  }

  /* ==========================================================================
   * FLV parse
   * ========================================================================*/

  function newResult() {
    return {
      formatId: 'flv',
      formatName: 'FLV',
      durationSec: null,
      bitrate: null,
      tracks: [],
      metadata: [],
      structures: [],
      frames: [],
      notes: [],
      codecContexts: {},
      extra: []
    };
  }

  function parse(ctx) {
    var result = newResult();
    var data = ctx && ctx.data;
    if (!data || data.length < 9) {
      result.notes.push('File is too short to contain an FLV header.');
      return result;
    }
    try {
      parseFile(data, ctx, result);
    } catch (e) {
      result.notes.push('FLV parsing stopped early: ' + msg(e));
    }
    result.frames.sort(function (a, b) {
      if (a.offset !== b.offset) return a.offset - b.offset;
      return (a.dtsSec || 0) - (b.dtsSec || 0);
    });
    return result;
  }

  function parseFile(data, ctx, result) {
    var size = data.length;
    var notes = result.notes;

    /* ------------------------------------------------------------ header */

    var sig = String.fromCharCode(data[0], data[1], data[2]);
    if (sig !== 'FLV') {
      notes.push('Signature is "' + sig + '", not "FLV" — continuing anyway.');
    }
    var version = data[3];
    var flags = data[4];
    var hasAudio = (flags & 0x04) !== 0;
    var hasVideo = (flags & 0x01) !== 0;
    var dataOffset = (data[5] * 16777216) + (data[6] * 65536) + (data[7] * 256) + data[8];
    if (dataOffset < 9 || dataOffset > size) {
      notes.push('DataOffset ' + dataOffset + ' is out of range — clamped to 9.');
      dataOffset = 9;
    }

    var hdr = makeNode('header', 'FLV', 'FLV File Header', 0, dataOffset);
    nodeField(hdr, 'Signature', "'" + sig + "'", 0, 3);
    nodeField(hdr, 'Version', version, 3, 1);
    nodeField(hdr, 'TypeFlags', '0x' + (flags >>> 0).toString(16).toUpperCase() +
      ' (audio=' + (hasAudio ? 1 : 0) + ', video=' + (hasVideo ? 1 : 0) + ')', 4, 1);
    nodeField(hdr, 'DataOffset', dataOffset + ' bytes', 5, 4);

    var p = dataOffset;
    if (p + 4 <= size) {
      var prev0 = (data[p] * 16777216) + (data[p + 1] * 65536) + (data[p + 2] * 256) + data[p + 3];
      nodeField(hdr, 'PreviousTagSize0', prev0, p, 4);
      p += 4;
    } else {
      nodeField(hdr, 'PreviousTagSize0', '(missing)', p, 0);
    }
    result.structures.push(hdr);

    result.extra.push({ label: 'Audio present (header flag)', value: hasAudio ? 'yes' : 'no' });
    result.extra.push({ label: 'Video present (header flag)', value: hasVideo ? 'yes' : 'no' });

    /* -------------------------------------------------------- tag chain */

    var tagsNode = makeNode('group', 'tags', 'FLV Tag Chain', p, size - p);
    tagsNode.expanded = false;
    result.structures.push(tagsNode);

    var st = {
      video: { tags: 0, bytes: 0, firstPts: null, lastPts: null, codecId: null },
      audio: { tags: 0, bytes: 0, firstPts: null, lastPts: null, fmt: null },
      script: 0,
      cfgAvc: null, cfgHevc: null, cfgAac: null,
      avcCtxKey: '1:h264', hevcCtxKey: '1:h265', aacCtxKey: '2:aac',
      meta: null,
      truncated: false
    };

    var tagIndex = 0;
    while (p + 11 <= size && tagIndex < MAX_TAGS) {
      var tagStart = p;
      var tagType = data[tagStart];
      var dataSize = (data[tagStart + 1] << 16) | (data[tagStart + 2] << 8) | data[tagStart + 3];
      var ts24 = (data[tagStart + 4] << 16) | (data[tagStart + 5] << 8) | data[tagStart + 6];
      var tsExt = data[tagStart + 7];
      var timestamp = tsExt * 16777216 + ts24;                  // milliseconds
      var streamId = (data[tagStart + 8] << 16) | (data[tagStart + 9] << 8) | data[tagStart + 10];
      var ds = tagStart + 11;
      var de = ds + dataSize;

      if (de > size) {
        notes.push('Tag #' + (tagIndex + 1) + ' at ' + hex(tagStart, 8) + ' declares ' +
          dataSize + ' bytes but only ' + (size - ds) + ' remain — file is truncated.');
        st.truncated = true;
        break;
      }

      var node = null;
      if (tagsNode.children.length < MAX_TAG_NODES) {
        node = makeNode('tag', tagTypeCode(tagType), 'FLV ' +
          (TAG_TYPE[tagType] ? TAG_TYPE[tagType] + ' tag' : 'tag') + ' #' + (tagIndex + 1),
          tagStart, 11 + dataSize + 4);
        nodeField(node, 'TagType', tagType + ' (' + (TAG_TYPE[tagType] || 'unknown') + ')',
          tagStart, 1);
        nodeField(node, 'DataSize', dataSize, tagStart + 1, 3);
        nodeField(node, 'Timestamp', ts24 + ' ms', tagStart + 4, 3);
        nodeField(node, 'TimestampExtended', tsExt, tagStart + 7, 1);
        nodeField(node, 'StreamID', streamId, tagStart + 8, 3);
        tagsNode.children.push(node);
      } else if (tagsNode.children.length === MAX_TAG_NODES) {
        nodeNote(tagsNode, '… further tag nodes omitted (structure tree capped at ' +
          MAX_TAG_NODES + ' tags)');
        notes.push('Structure tree capped at ' + MAX_TAG_NODES + ' tag nodes.');
      }

      try {
        if (tagType === 9) {
          parseVideoTag(data, ds, de, timestamp, tagStart, tagIndex, node, st, result);
          st.video.tags++;
          st.video.bytes += dataSize;
          if (st.video.firstPts == null) st.video.firstPts = timestamp;
          st.video.lastPts = timestamp;
        } else if (tagType === 8) {
          parseAudioTag(data, ds, de, timestamp, tagStart, tagIndex, node, st, result);
          st.audio.tags++;
          st.audio.bytes += dataSize;
          if (st.audio.firstPts == null) st.audio.firstPts = timestamp;
          st.audio.lastPts = timestamp;
        } else if (tagType === 18) {
          parseScriptTag(data, ds, de, timestamp, tagStart, tagIndex, node, st, result);
          st.script++;
        } else if (node) {
          nodeNote(node, 'Unknown tag type ' + tagType + ' — ' + dataSize + ' bytes skipped.');
        }
      } catch (e) {
        // One broken tag must not cost us the rest of the file.
        if (node) nodeNote(node, 'Parse error: ' + msg(e));
        else notes.push('Tag #' + (tagIndex + 1) + ' at ' + hex(tagStart, 8) +
          ' could not be parsed: ' + msg(e));
      }

      // PreviousTagSize — its value should be 11 + DataSize.
      var prevPos = de;
      if (prevPos + 4 <= size) {
        var prev = (data[prevPos] * 16777216) + (data[prevPos + 1] * 65536) +
                   (data[prevPos + 2] * 256) + data[prevPos + 3];
        if (node) {
          nodeField(node, 'PreviousTagSize', prev + (prev === dataSize + 11 ? '' : ' (expected ' +
            (dataSize + 11) + ')'), prevPos, 4);
        }
      }
      p = de + 4;
      tagIndex++;
    }

    if (tagIndex >= MAX_TAGS) {
      notes.push('Tag chain capped at ' + MAX_TAGS + ' tags — the list is partial.');
    }
    if (p + 11 > size && p !== size) {
      notes.push((size - p) + ' trailing byte(s) after the last tag.');
    }
    tagsNode.size = Math.max(0, Math.min(p, size) - tagsNode.offset);

    result.extra.push({ label: 'Tags parsed', value: String(tagIndex) });
    if (st.script) result.extra.push({ label: 'Script tags', value: String(st.script) });

    /* ------------------------------------------------------------ tracks */

    buildTracks(result, st, size, hasVideo, hasAudio, notes);

    /* ------------------------------------------------- frame durations */

    fillDurations(result.frames);

    if (result.frames.length >= MAX_FRAMES) {
      notes.push('Frame list capped at ' + MAX_FRAMES + ' entries.');
    }
  }

  function tagTypeCode(t) {
    if (t === 8) return 'AUDIO';
    if (t === 9) return 'VIDEO';
    if (t === 18) return 'SCRIPT';
    return 'TAG';
  }

  /* ------------------------------------------------------------ video tag */

  function parseVideoTag(data, ds, de, timestamp, tagStart, tagIndex, node, st, result) {
    var b0 = data[ds];
    var frameType = (b0 >> 4) & 0x0f;
    var codecId = b0 & 0x0f;
    var info = VIDEO_CODEC[codecId] || { name: 'codec id ' + codecId, codec: 'cid' + codecId };
    var tsSec = timestamp / 1000;
    var payload = ds + 1;
    var payloadEnd = de;

    if (node) {
      nodeField(node, 'FrameType', frameType + ' (' + (FRAME_TYPE[frameType] || 'unknown') + ')',
        ds, 1);
      nodeField(node, 'CodecID', codecId + ' (' + info.name + ')', ds, 1);
    }

    if (st.video.codecId == null) st.video.codecId = codecId;

    if (result.frames.length >= MAX_FRAMES) return;

    /* ---- AVC (7) and HEVC (12) share the same packet framing ---- */
    if (codecId === 7 || codecId === 12) {
      var isHevc = codecId === 12;
      var pktType = data[ds + 1];
      var cto = 0;

      // Enhanced FLV (E-RTMP) keeps the codec in a FourCC instead of a packet
      // type: byte 1..4 is printable ASCII ('hvc1'), while the legacy packet
      // type is 0..2 — the two can never be confused.
      var enhanced = false;
      if (isHevc && pktType >= 0x30 && pktType <= 0x7a) enhanced = true;

      if (enhanced) {
        var fourcc = String.fromCharCode(data[ds + 1], data[ds + 2], data[ds + 3], data[ds + 4]);
        if (node) {
          nodeField(node, 'FourCC', "'" + fourcc + "' (enhanced FLV framing)", ds + 1, 4);
          nodeField(node, 'PacketType', (b0 & 0x0f) + ' (enhanced mapping)', ds, 1);
        }
        result.notes.push('Video tag uses enhanced FLV framing (fourCC "' + fourcc +
          '") — packet types follow E-RTMP, not the legacy CodecID 12 layout.');
        payload = ds + 5;
        pktType = b0 & 0x0f;
      } else {
        cto = (data[ds + 2] << 16) | (data[ds + 3] << 8) | data[ds + 4];
        if (cto & 0x800000) cto -= 0x1000000;              // s(24)
        if (node) {
          nodeField(node, isHevc ? 'HEVCPacketType' : 'AVCPacketType',
            pktType + ' (' + packetTypeName(pktType) + ')', ds + 1, 1);
          nodeField(node, 'CompositionTime', cto + ' ms (signed)', ds + 2, 3);
        }
        payload = ds + 5;
      }

      var dtsSec = tsSec;
      var ptsSec = tsSec + cto / 1000;
      var keyframe = frameType === 1 || frameType === 4;
      var codec = isHevc ? 'h265' : 'h264';

      if (pktType === 0) {
        parseVideoConfig(data, payload, payloadEnd, tsSec, keyframe, tagIndex, node,
          st, result, codec, isHevc, ds);
      } else if (pktType === 1 || pktType === 3) {
        var cfg = isHevc ? st.cfgHevc : st.cfgAvc;
        result.frames.push({
          track: 1,
          index: tagIndex + 1,
          type: frameType === 1 ? 'I' : (frameType === 2 ? 'P' : 'frame'),
          kind: 'video',
          codec: codec,
          offset: payload,
          size: Math.max(0, payloadEnd - payload),
          dtsSec: dtsSec,
          ptsSec: ptsSec,
          keyframe: keyframe,
          label: (FRAME_TYPE[frameType] || 'frame') + ', ' + (isHevc ? 'HEVC' : 'AVC') + ' NALUs',
          syn: {
            codec: codec,
            kind: 'sample',
            offset: payload,
            size: Math.max(0, payloadEnd - payload),
            base: payload,
            lengthSize: (cfg && cfg.lengthSize) || 4,
            annexB: false,
            ctxKey: isHevc ? st.hevcCtxKey : st.avcCtxKey
          }
        });
        if (!cfg) {
          result.notes.push('AVC/HEVC NALU tag at ' + hex(tagStart, 8) +
            ' arrived before its sequence header — the NAL length size is assumed to be 4 bytes.');
        }
      } else if (pktType === 2) {
        // End of sequence — no payload to decode, but worth listing.
        result.frames.push({
          track: 1,
          index: tagIndex + 1,
          type: 'end',
          kind: 'video',
          codec: codec,
          offset: ds,
          size: payloadEnd - ds,
          dtsSec: dtsSec,
          ptsSec: ptsSec,
          keyframe: false,
          label: (isHevc ? 'HEVC' : 'AVC') + ' end of sequence',
          tables: [synSection(isHevc ? 'HEVC end of sequence' : 'AVC end of sequence',
            'The decoder must flush its picture buffers here.', [{
              name: isHevc ? 'HEVCPacketType' : 'AVCPacketType',
              syntax: 'u(8)', bits: 8, value: 2,
              note: 'end of sequence', offset: ds + 1, depth: 0
            }])]
        });
      } else if (node) {
        nodeNote(node, 'Unknown packet type ' + pktType + ' — ' +
          Math.max(0, payloadEnd - payload) + ' bytes not decoded.');
      }
      return;
    }

    /* ---- codecs without a documented per-frame header ---- */
    var frameOff = ds + 1;
    if (frameType === 5) {
      // Video info / command frame: the payload is a command byte, not a picture.
      var cmd = data[ds + 1];
      if (node) nodeField(node, 'VideoCommand', cmd === 0 ? '0 (start of client-side seek)' :
        String(cmd), ds + 1, 1);
      result.frames.push({
        track: 1, index: tagIndex + 1, type: 'command', kind: 'video', codec: info.codec,
        offset: ds, size: payloadEnd - ds, dtsSec: tsSec, ptsSec: tsSec, keyframe: false,
        label: 'video info / command frame',
        tables: [synSection('Video command frame',
          'FrameType 5 — the payload is a command byte, not a coded picture.', [{
            name: 'command', syntax: 'u(8)', bits: 8, value: cmd || 0,
            note: cmd === 0 ? 'start of client-side seek' : '', offset: ds + 1, depth: 0
          }])]
      });
      return;
    }

    result.frames.push({
      track: 1,
      index: tagIndex + 1,
      type: (frameType === 1 || frameType === 4) ? 'I' : 'P',
      kind: 'video',
      codec: info.codec,
      offset: frameOff,
      size: Math.max(0, payloadEnd - frameOff),
      dtsSec: tsSec,
      ptsSec: tsSec,
      keyframe: frameType === 1 || frameType === 4,
      label: (FRAME_TYPE[frameType] || 'frame') + ', ' + info.name,
      syn: { codec: info.codec, kind: 'raw', offset: frameOff, base: frameOff,
             size: Math.max(0, payloadEnd - frameOff) }
    });
    if (!st.warnedOtherCodec) {
      st.warnedOtherCodec = true;
      result.notes.push('Video codec "' + info.name + '" (CodecID ' + codecId +
        ') has no per-frame syntax definition in this build — payloads are listed by offset/size only.');
    }
  }

  function packetTypeName(t) {
    return t === 0 ? 'sequence header' : t === 1 ? 'NALU / coded frames' :
      t === 2 ? 'end of sequence' : t === 3 ? 'coded frames (X)' : 'unknown';
  }

  /**
   * AVCDecoderConfigurationRecord / HEVCDecoderConfigurationRecord carried in a
   * sequence-header video tag. The decoder config is decoded eagerly (there is
   * at most a handful of them) and its tables hang on the header frame.
   */
  function parseVideoConfig(data, payload, payloadEnd, tsSec, keyframe, tagIndex, node,
                            st, result, codec, isHevc, ds) {
    var len = Math.max(0, payloadEnd - payload);
    var cfg = null;
    var tables = null;
    var codecMod = MA.getCodec(codec);
    var recName = isHevc ? 'HEVCDecoderConfigurationRecord (hvcC)' :
                           'AVCDecoderConfigurationRecord (avcC)';

    if (!codecMod) {
      result.notes.push(isHevc
        ? 'HEVC sequence header found but the h265 codec module is not loaded — ' +
          'the decoder configuration record (' + len + ' bytes @ ' + hex(payload, 8) + ') is only listed.'
        : 'AVC sequence header found but the h264 codec module is not loaded — ' +
          'the decoder configuration record (' + len + ' bytes @ ' + hex(payload, 8) + ') is only listed.');
    } else {
      try {
        var br = new MA.ByteReader(data);
        br.seek(payload);
        cfg = isHevc
          ? (codecMod.parseHVCC ? codecMod.parseHVCC(br, payloadEnd, payload) : null)
          : (codecMod.parseAVCC ? codecMod.parseAVCC(br, payloadEnd, payload) : null);
      } catch (e) {
        result.notes.push(recName + ' at ' + hex(payload, 8) + ' could not be decoded: ' + msg(e));
        cfg = null;
      }
    }

    if (cfg) {
      if (isHevc) {
        st.cfgHevc = cfg;
        tables = [];
        if (cfg.table) tables.push(cfg.table);
        if (cfg.spsTables) tables = tables.concat(cfg.spsTables);
        if (cfg.ppsTables) tables = tables.concat(cfg.ppsTables);
      } else {
        st.cfgAvc = cfg;
        tables = [];
        if (cfg.table) tables.push(cfg.table);
        if (cfg.spsTables) tables = tables.concat(cfg.spsTables);
        if (cfg.ppsTables) tables = tables.concat(cfg.ppsTables);
      }
      // Context for later slice-header decoding.
      var ctx = null;
      try {
        if (isHevc) {
          ctx = (codecMod.ctxFromHVCC ? codecMod.ctxFromHVCC(cfg) : (cfg.ctx || null));
          if (ctx) result.codecContexts[st.hevcCtxKey] = ctx;
        } else {
          ctx = (codecMod.ctxFromAVCC ? codecMod.ctxFromAVCC(cfg) : (cfg.ctx || null));
          if (ctx) result.codecContexts[st.avcCtxKey] = ctx;
        }
      } catch (e) { /* slice headers will fall back to a bare parse */ }
      if (cfg.info && cfg.info.width) {
        // A truncated or synthetic parameter set yields bogus geometry; in that
        // case onMetaData is the better authority for the display size, so the
        // SPS values are kept separately rather than overwriting it.
        st.video.spsWidth = cfg.info.width;
        st.video.spsHeight = cfg.info.height;
        if (!cfg.info.incomplete && st.video.width == null) {
          st.video.width = cfg.info.width;
          st.video.height = cfg.info.height;
        }
      }
      if (cfg.info) {
        st.video.profile = cfg.info.profile || st.video.profile;
        st.video.level = cfg.info.level || st.video.level;
        if (cfg.info.fps) st.video.spsFps = cfg.info.fps;
      }
    } else if (!tables) {
      // Degrade honestly: record the bytes we cannot interpret.
      var rows = [
        { name: 'configurationVersion', syntax: 'u(8)', bits: 8, value: data[payload] || 0,
          note: '', offset: payload, depth: 0 },
        { name: 'raw record', syntax: '', bits: len * 8, value: formatSize(len),
          note: 'not decoded', offset: payload, depth: 0 }
      ];
      if (len >= 4) {
        rows.splice(1, 0,
          { name: 'profile byte', syntax: 'u(8)', bits: 8, value: data[payload + 1],
            note: '', offset: payload + 1, depth: 0 },
          { name: 'level byte', syntax: 'u(8)', bits: 8, value: data[payload + 3],
            note: '', offset: payload + 3, depth: 0 });
      }
      tables = [synSection(recName + ' (undecoded)', hex(payload, 8) + ', ' + len + ' bytes', rows)];
    }

    if (node) {
      node.code = isHevc ? 'hvcC' : 'avcC';
      node.name = 'Video Tag (' + (isHevc ? 'HEVC sequence header' : 'AVC sequence header') + ')';
      nodeNote(node, recName + ', ' + len + ' bytes');
    }

    if (result.frames.length < MAX_FRAMES) {
      result.frames.push({
        track: 1,
        index: tagIndex + 1,
        type: 'header',
        kind: 'header',
        codec: codec,
        offset: payload,
        size: len,
        dtsSec: tsSec,
        ptsSec: tsSec,
        keyframe: false,
        label: isHevc ? 'HEVC sequence header (hvcC)' : 'AVC sequence header (avcC)',
        tables: tables
      });
    }
  }

  /* ------------------------------------------------------------ audio tag */

  function parseAudioTag(data, ds, de, timestamp, tagStart, tagIndex, node, st, result) {
    var b0 = data[ds];
    var fmt = (b0 >> 4) & 0x0f;
    var rateIdx = (b0 >> 2) & 0x03;
    var sampleSize = ((b0 >> 1) & 1) ? 16 : 8;
    var channels = (b0 & 1) ? 2 : 1;
    var info = SOUND_FORMAT[fmt] || { name: 'format ' + fmt, codec: 'fmt' + fmt };
    var sampleRate = SOUND_RATES[rateIdx];
    var tsSec = timestamp / 1000;

    if (node) {
      nodeField(node, 'SoundFormat', fmt + ' (' + info.name + ')', ds, 1);
      nodeField(node, 'SoundRate', sampleRate + ' Hz (index ' + rateIdx + ')', ds, 1);
      nodeField(node, 'SoundSize', sampleSize + ' bit', ds, 1);
      nodeField(node, 'SoundType', channels === 2 ? '2 (stereo)' : '1 (mono)', ds, 1);
    }
    if (st.audio.fmt == null) {
      st.audio.fmt = fmt;
      st.audio.sampleRate = sampleRate;
      st.audio.channels = channels;
      st.audio.bitDepth = sampleSize;
    }
    if (result.frames.length >= MAX_FRAMES) return;

    if (fmt === 10) {
      /* AAC — the only audio format with its own packet framing in FLV. */
      var pktType = data[ds + 1];
      if (node) {
        nodeField(node, 'AACPacketType', pktType + ' (' +
          (pktType === 0 ? 'AudioSpecificConfig' : pktType === 1 ? 'raw AAC frame' : 'unknown') + ')',
          ds + 1, 1);
      }
      if (pktType === 0) {
        var payload = ds + 2;
        var len = Math.max(0, de - payload);
        var cfg = null, tables = null;
        var aac = MA.getCodec('aac');
        if (aac && aac.parseAudioSpecificConfig) {
          try {
            cfg = aac.parseAudioSpecificConfig(data, payload, len);
          } catch (e) {
            result.notes.push('AudioSpecificConfig at ' + hex(payload, 8) +
              ' could not be decoded: ' + msg(e));
          }
        } else {
          result.notes.push('AAC sequence header found but the aac codec module is not loaded — ' +
            'the AudioSpecificConfig (' + len + ' bytes @ ' + hex(payload, 8) + ') is only listed.');
        }
        if (cfg && cfg.table) {
          st.cfgAac = cfg;
          tables = [cfg.table];
          result.codecContexts[st.aacCtxKey] = cfg;
          st.audio.sampleRate = cfg.outputSampleRate || cfg.sampleRate || sampleRate;
          st.audio.channels = cfg.channels || channels;
          st.audio.channelLayout = cfg.channelLayout || null;
          st.audio.aotName = cfg.aotName || null;
        } else {
          tables = [synSection('AudioSpecificConfig (undecoded)',
            hex(payload, 8) + ', ' + len + ' bytes', [{
              name: 'raw config', syntax: '', bits: len * 8, value: formatSize(len),
              note: 'not decoded', offset: payload, depth: 0
            }])];
        }
        if (node) { node.code = 'esds'; node.name = 'Audio Tag (AAC sequence header)'; }
        result.frames.push({
          track: 2, index: tagIndex + 1, type: 'header', kind: 'header', codec: 'aac',
          offset: payload, size: len, dtsSec: tsSec, ptsSec: tsSec, keyframe: false,
          label: 'AAC sequence header (AudioSpecificConfig)', tables: tables
        });
      } else {
        var off = ds + 2;
        if (node) node.code = 'AAC';
        // Raw AAC has no per-frame header — the recipe lets the codec module
        // describe the access unit from the AudioSpecificConfig instead of us
        // inventing syntax that is not in the bitstream.
        result.frames.push({
          track: 2, index: tagIndex + 1, type: 'audio', kind: 'audio', codec: 'aac',
          offset: off, size: Math.max(0, de - off), dtsSec: tsSec, ptsSec: tsSec,
          keyframe: true, label: 'raw AAC frame',
          syn: { codec: 'aac', kind: 'sample', offset: off, base: off,
                 size: Math.max(0, de - off), ctxKey: st.aacCtxKey }
        });
      }
      return;
    }

    if (fmt === 2 || fmt === 14) {
      var p2 = ds + 1;
      if (node) node.code = 'MP3';
      result.frames.push({
        track: 2, index: tagIndex + 1, type: 'audio', kind: 'audio', codec: 'mp3',
        offset: p2, size: Math.max(0, de - p2), dtsSec: tsSec, ptsSec: tsSec,
        keyframe: true, label: info.name + ' frame',
        syn: { codec: 'mp3', kind: 'mp3-frame', offset: p2, base: p2,
               size: Math.max(0, de - p2) }
      });
      return;
    }

    var off2 = ds + 1;
    if (node) node.code = 'A' + fmt;
    result.frames.push({
      track: 2, index: tagIndex + 1, type: 'audio', kind: 'audio', codec: info.codec,
      offset: off2, size: Math.max(0, de - off2), dtsSec: tsSec, ptsSec: tsSec,
      keyframe: true, label: info.name,
      syn: { codec: info.codec, kind: 'raw', offset: off2, base: off2,
             size: Math.max(0, de - off2) }
    });
    if (!st.warnedOtherAudio) {
      st.warnedOtherAudio = true;
      result.notes.push('Audio format "' + info.name + '" (SoundFormat ' + fmt +
        ') has no per-frame syntax definition in this build — payloads are listed by offset/size only.');
    }
  }

  /* ----------------------------------------------------------- script tag */

  function parseScriptTag(data, ds, de, timestamp, tagStart, tagIndex, node, st, result) {
    var dec = amfDecode(data, ds, de);
    var tsSec = timestamp / 1000;
    var rows = [];
    var other = [];

    if (node) {
      node.code = 'SCRIPT';
      node.name = 'FLV Script Tag';
      nodeNote(node, 'AMF0, ' + (de - ds) + ' bytes' + (dec.error ? ' — ' + dec.error : ''));
    }
    if (dec.error) {
      result.notes.push('Script tag at ' + hex(ds, 8) + ': ' + dec.error +
        ' (the values decoded so far are still shown).');
    }

    // Script data is a flat list of name/value pairs.
    var values = dec.values;
    for (var i = 0; i + 1 < values.length; i += 2) {
      var name = values[i];
      var value = values[i + 1];
      if (typeof name !== 'string') continue;

      if (value && typeof value === 'object' && !Array.isArray(value) &&
          !(value instanceof Date)) {
        if (name === 'onMetaData') {
          st.meta = value;
          var keys = Object.keys(value).filter(function (k) { return k.indexOf('__') !== 0; });
          for (var k = 0; k < keys.length && k < MAX_META_ROWS; k++) {
            var key = keys[k];
            var off = metaOffset(value, key, ds);
            rows.push({
              name: key, syntax: '', bits: '', value: amfText(value[key]),
              note: '', offset: off, depth: 0
            });
            result.metadata.push({ key: key, value: metaValue(value[key]) });
          }
          if (keys.length > MAX_META_ROWS) {
            rows.push({
              name: '…', syntax: '', bits: '',
              value: (keys.length - MAX_META_ROWS) + ' more propert(ies) not shown',
              note: '', offset: ds, depth: 0
            });
          }
        } else {
          other.push({ name: name, syntax: '', bits: '', value: amfText(value),
                       note: 'object value', offset: ds, depth: 0 });
        }
      } else {
        other.push({ name: name, syntax: '', bits: '', value: amfText(value),
                     note: '', offset: ds, depth: 0 });
      }
    }
    var tables = [];
    if (rows.length) {
      tables.push(synSection('onMetaData (AMF0 ECMA array)',
        'script tag @ ' + hex(ds, 8) + ', ' + rows.length + ' propert(y/ies)', rows));
    }
    if (other.length) {
      tables.push(synSection('script data values', 'name/value pairs', other));
    }
    if (!tables.length) {
      tables.push(synSection('script tag', 'No AMF0 name/value pairs were decoded.', [{
        name: 'data_size', syntax: '', bits: '', value: formatSize(de - ds),
        note: '', offset: ds, depth: 0
      }]));
    }

    result.frames.push({
      track: 0, index: tagIndex + 1, type: 'script', kind: 'other', codec: 'AMF0',
      offset: tagStart, size: 11 + (de - ds), dtsSec: tsSec, ptsSec: tsSec,
      keyframe: false, label: 'script tag' + (st.meta ? ' (onMetaData)' : ''), tables: tables
    });
  }

  /** Metadata values are kept display-friendly: primitives stay raw, the rest become text. */
  function metaValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' || typeof v === 'boolean') return v;
    if (typeof v === 'string') return v;
    return amfText(v);
  }

  /* ---------------------------------------------------------------- tracks */

  function buildTracks(result, st, size, hasVideoFlag, hasAudioFlag, notes) {
    var md = st.meta || {};
    var v = st.video, a = st.audio;

    var metaDuration = asNumber(md.duration);
    var lastPts = null;
    if (v.lastPts != null) lastPts = v.lastPts / 1000;
    if (a.lastPts != null) lastPts = Math.max(lastPts == null ? 0 : lastPts, a.lastPts / 1000);
    var durationSec = (metaDuration != null && metaDuration > 0) ? metaDuration : lastPts;
    result.durationSec = durationSec;

    var metaFps = asNumber(md.framerate);
    if (metaFps == null) metaFps = asNumber(md.videoframerate);
    var metaVideoRate = asNumber(md.videodatarate);        // kbit/s
    var metaAudioRate = asNumber(md.audiodatarate);        // kbit/s
    var metaVideoCodec = asNumber(md.videocodecid);
    var metaAudioCodec = asNumber(md.audiocodecid);
    var metaWidth = asNumber(md.width);
    var metaHeight = asNumber(md.height);

    /* ---- video track ---- */
    var wantsVideo = v.tags > 0 || metaWidth != null || metaHeight != null ||
                     metaVideoCodec != null || (hasVideoFlag && v.tags === 0);
    if (wantsVideo) {
      var vInfo = VIDEO_CODEC[v.codecId] ||
                  (metaVideoCodec != null ? VIDEO_CODEC[metaVideoCodec] : null) ||
                  { name: md.videocodecid != null ? String(md.videocodecid) : 'unknown', codec: '' };
      var vcodec = vInfo.codec || (metaVideoCodec != null ? 'cid' + metaVideoCodec : '');
      var videoFrames = countFrames(result.frames, 1, 'video');
      var vDuration = durationSec;
      var videoTrack = {
        id: 1,
        type: 'video',
        codec: vcodec,
        codecName: vInfo.name,
        profile: st.video.profile || (md.avcprofile != null ? asText(md.avcprofile) : ''),
        level: st.video.level || (md.avclevel != null ? asText(md.avclevel) : ''),
        width: st.video.width != null ? st.video.width : metaWidth,
        height: st.video.height != null ? st.video.height : metaHeight,
        fps: metaFps != null ? metaFps : (st.video.spsFps || null),
        sampleRate: null,
        channels: null,
        durationSec: vDuration,
        bitrate: metaVideoRate != null ? Math.round(metaVideoRate * 1000)
                 : (vDuration > 0 && v.bytes > 0 ? Math.round(v.bytes * 8 / vDuration) : null),
        streamSize: v.bytes || null,
        sampleCount: videoFrames,
        language: '',
        extra: []
      };
      if (videoTrack.fps == null && videoFrames > 0 && vDuration > 0) {
        videoTrack.fps = videoFrames / vDuration;
      }
      if (v.tags === 0) {
        videoTrack.extra.push({ label: 'Source', value: 'onMetaData only — no video tags in this file' });
        notes.push('The header/metadata declare video but no video tag was found.');
      }
      if (st.cfgAvc && st.cfgAvc.lengthSize) {
        videoTrack.extra.push({ label: 'NAL length size', value: st.cfgAvc.lengthSize + ' bytes' });
      }
      if (st.cfgHevc && st.cfgHevc.lengthSize) {
        videoTrack.extra.push({ label: 'NAL length size', value: st.cfgHevc.lengthSize + ' bytes' });
      }
      if (v.bytes) videoTrack.extra.push({ label: 'Video tag bytes', value: formatSize(v.bytes) });
      result.tracks.push(videoTrack);
    }

    /* ---- audio track ---- */
    var wantsAudio = a.tags > 0 || metaAudioCodec != null ||
                     asNumber(md.audiosamplerate) != null || (hasAudioFlag && a.tags === 0);
    if (wantsAudio) {
      var aInfo = SOUND_FORMAT[a.fmt] ||
                  (metaAudioCodec != null ? SOUND_FORMAT[metaAudioCodec] : null) ||
                  { name: md.audiocodecid != null ? String(md.audiocodecid) : 'unknown', codec: '' };
      var acodec = aInfo.codec || (metaAudioCodec != null ? 'fmt' + metaAudioCodec : '');
      var aDuration = durationSec;
      var metaRate = asNumber(md.audiosamplerate);
      var metaSize = asNumber(md.audiosamplesize);
      var stereo = asBool(md.stereo);
      var metaChannels = asNumber(md.audiochannels);
      var aChannels = a.channels != null ? a.channels
        : (metaChannels != null ? metaChannels : (stereo === true ? 2 : (stereo === false ? 1 : null)));
      var audioTrack = {
        id: 2,
        type: 'audio',
        codec: acodec,
        codecName: a.aotName || aInfo.name,
        profile: '',
        level: '',
        width: null,
        height: null,
        fps: null,
        sampleRate: a.sampleRate != null ? a.sampleRate : metaRate,
        channels: aChannels,
        channelLayout: a.channelLayout ||
          (aChannels === 1 ? 'mono' : aChannels === 2 ? 'stereo' : (aChannels ? aChannels + ' ch' : '')),
        bitDepth: a.bitDepth != null ? a.bitDepth : metaSize,
        durationSec: aDuration,
        bitrate: metaAudioRate != null ? Math.round(metaAudioRate * 1000)
                 : (aDuration > 0 && a.bytes > 0 ? Math.round(a.bytes * 8 / aDuration) : null),
        streamSize: a.bytes || null,
        sampleCount: countFrames(result.frames, 2, 'audio'),
        language: '',
        extra: []
      };
      if (a.tags === 0) {
        audioTrack.extra.push({ label: 'Source', value: 'onMetaData only — no audio tags in this file' });
      }
      if (a.bytes) audioTrack.extra.push({ label: 'Audio tag bytes', value: formatSize(a.bytes) });
      if (st.cfgAac) {
        audioTrack.extra.push({ label: 'AAC AudioSpecificConfig',
          value: (st.cfgAac.aotName || 'AAC') + (st.cfgAac.sbr ? ' + SBR' : '') });
      }
      result.tracks.push(audioTrack);
    }
    if (!result.tracks.length) {
      notes.push('No audio or video track could be identified in this FLV file.');
    }

    /* ---- container bitrate ---- */
    var totalBytes = v.bytes + a.bytes;
    if (durationSec > 0 && totalBytes > 0) {
      result.bitrate = Math.round(totalBytes * 8 / durationSec);
    } else if (metaVideoRate != null || metaAudioRate != null) {
      result.bitrate = Math.round(((metaVideoRate || 0) + (metaAudioRate || 0)) * 1000);
    }
    if (durationSec > 0) {
      result.extra.push({ label: 'Duration source',
        value: (metaDuration != null && metaDuration > 0) ? 'onMetaData.duration' : 'last tag timestamp' });
    }

    /* ---- the rest of onMetaData is worth showing in the overview ---- */
    var shown = {};
    ['duration', 'width', 'height', 'videodatarate', 'framerate', 'videocodecid',
     'audiodatarate', 'audiosamplerate', 'audiosamplesize', 'stereo', 'audiocodecid',
     'encoder', 'filesize', 'creationdate'].forEach(function (k) { shown[k] = 1; });
    Object.keys(md).forEach(function (k) {
      if (shown[k] || k.indexOf('__') === 0) return;
      if (result.metadata.length >= 120) return;
      result.metadata.push({ key: k, value: metaValue(md[k]) });
    });
  }

  function countFrames(frames, trackId, kind) {
    var n = 0;
    for (var i = 0; i < frames.length; i++) {
      if (frames[i].track === trackId && frames[i].kind === kind && frames[i].type !== 'header') n++;
    }
    return n;
  }

  /** Fill per-frame durations from the next frame of the same track. */
  function fillDurations(frames) {
    var last = {};
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var prev = last[f.track];
      if (prev && f.dtsSec != null && prev.dtsSec != null && f.dtsSec > prev.dtsSec) {
        prev.durationSec = f.dtsSec - prev.dtsSec;
      }
      last[f.track] = f;
    }
    for (var t in last) {
      if (last[t] && last[t].durationSec == null) last[t].durationSec = null;
    }
  }

  MA.registerParser({
    id: 'flv',
    name: 'FLV',
    extensions: ['flv', 'f4v'],
    parse: parse
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
