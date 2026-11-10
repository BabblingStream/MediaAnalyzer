/* ============================================================================
 * MediaAnalyzer — parsers/asf.js
 *
 * ASF (Advanced Systems Format, "Windows Media" — .asf/.wma/.wmv),
 * Microsoft [MS-ASFB] / [MS-ASF], packet walk matching ffmpeg asfdec_f.c.
 *
 * File layout: a chain of top-level GUID objects:
 *   Header Object (75B22630…)  — File Properties, Stream Properties ×N,
 *                                Header Extension (nested Metadata), Codec
 *                                List, Content/Extended Content Description…
 *   Data Object (75B22636…)    — fixed-size data packets carrying interleaved
 *                                payload fragments, reassembled into samples
 *   Simple Index / Index …     — index tables (listed, not decoded)
 *
 * Every data packet: optional ECC bytes, flags/property, send time + duration,
 * per-payload stream id, fragment offset / replicated-data lengths chosen by
 * 2-bit type codes (0=absent/default, 1=u8, 2=u16, 3=u32), then fragment
 * bytes. Replicated data (when present, >= 8 bytes) carries the media-object
 * size and its presentation time in milliseconds. Samples are stitched from
 * their fragments (`syn.parts`) the same way the TS parser does for PES.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField, nodeNote = MA.nodeNote;
  var hex = MA.hex, formatSize = MA.formatSize;

  /* ------------------------------------------------------------------ caps */

  var MAX_OBJECTS = 4096;
  var MAX_FRAMES = 50000;
  var MAX_CHILDREN = 256;

  /* ----------------------------------------------------------------- GUIDs */

  var GUID = {
    HEADER: '75b22630-668e-11cf-a6d9-00aa0062ce6c',
    DATA: '75b22636-668e-11cf-a6d9-00aa0062ce6c',
    SIMPLE_INDEX: '33000890-e5b1-11cf-89f4-00a0c90349cb',
    FILE_PROPERTIES: '8cabdca1-a947-11cf-8ee4-00c00c205365',
    STREAM_PROPERTIES: 'b7dc0791-a9b7-11cf-8ee6-00c00c205365',
    HEADER_EXTENSION: '5fbf03b5-a92e-11cf-8ee3-00c00c205365',
    CODEC_LIST: '86d15240-311d-11d0-a3a4-00a0c90348f6',
    CONTENT_DESC: '75b22633-668e-11cf-a6d9-00aa0062ce6c',
    EXT_CONTENT_DESC: 'd2d0a440-e307-11d2-97f0-00a0c95ea850',
    METADATA: 'c5f8cbea-5baf-4877-8467-aa8c44fa4cca',
    STREAM_VIDEO: 'bc19efc0-5b4d-11cf-a8fd-00805f5c442b',
    STREAM_AUDIO: 'f8699e40-5b4d-11cf-a8fd-00805f5c442b',
    STREAM_JFIF: 'b61eb1b0-5b4d-11cf-a8fd-00805f5c442b',
    STREAM_COMMAND: 'b91d3c50-5da0-11cf-a8fd-00805f5c442b',
    EC_NONE: '20fb5700-555b-11cf-a8fd-00805f5c442b',
    EC_AUDIO_SPREAD: 'bfc3cd50-618f-11cf-8bb2-00aa00b4e220'
  };

  var OBJECT_NAMES = {};
  OBJECT_NAMES[GUID.HEADER] = 'Header Object';
  OBJECT_NAMES[GUID.DATA] = 'Data Object';
  OBJECT_NAMES[GUID.SIMPLE_INDEX] = 'Simple Index Object';
  OBJECT_NAMES[GUID.FILE_PROPERTIES] = 'File Properties Object';
  OBJECT_NAMES[GUID.STREAM_PROPERTIES] = 'Stream Properties Object';
  OBJECT_NAMES[GUID.HEADER_EXTENSION] = 'Header Extension Object';
  OBJECT_NAMES[GUID.CODEC_LIST] = 'Codec List Object';
  OBJECT_NAMES[GUID.CONTENT_DESC] = 'Content Description Object';
  OBJECT_NAMES[GUID.EXT_CONTENT_DESC] = 'Extended Content Description Object';
  OBJECT_NAMES[GUID.METADATA] = 'Metadata Object';

  /* ------------------------------------------------------------ codec maps */

  var VIDEO_FOURCC = {
    H263: { codec: 'h263', name: 'ITU-T H.263' },
    U263: { codec: 'h263', name: 'ITU-T H.263' },
    I263: { codec: 'h263', name: 'Intel H.263' },
    DIV3: { codec: 'mpeg4', name: 'DivX 3 MPEG-4' },
    DIV4: { codec: 'mpeg4', name: 'DivX 4 MPEG-4' },
    DIVX: { codec: 'mpeg4', name: 'DivX MPEG-4' },
    DX50: { codec: 'mpeg4', name: 'DivX 5 MPEG-4' },
    XVID: { codec: 'mpeg4', name: 'Xvid MPEG-4' },
    MP43: { codec: 'mpeg4', name: 'Microsoft MPEG-4 v3' },
    M4S2: { codec: 'mpeg4', name: 'Microsoft MPEG-4 v2' },
    WMV1: { codec: 'wmv1', name: 'Windows Media Video 7' },
    WMV2: { codec: 'wmv2', name: 'Windows Media Video 8' },
    WMV3: { codec: 'wmv3', name: 'Windows Media Video 9' },
    WMVA: { codec: 'wmv3', name: 'Windows Media Video Advanced Profile' },
    WVC1: { codec: 'vc1', name: 'Windows Media Video 9 Advanced (VC-1)' }
  };

  var AUDIO_TAGS = {
    0x0001: { codec: 'pcm', name: 'PCM (uncompressed)' },
    0x0050: { codec: 'mp2', name: 'MPEG Audio Layer 2' },
    0x0055: { codec: 'mp3', name: 'MP3' },
    0x0160: { codec: 'wma1', name: 'Windows Media Audio 1' },
    0x0161: { codec: 'wma2', name: 'Windows Media Audio 2' },
    0x0162: { codec: 'wmapro', name: 'Windows Media Audio 9 Professional' },
    0x0163: { codec: 'wmalossless', name: 'Windows Media Audio 9 Lossless' },
    0x000a: { codec: 'wmavoice', name: 'Windows Media Audio Voice' },
    0x1610: { codec: 'aac', name: 'AAC (raw)' },
    0x1600: { codec: 'aac', name: 'AAC (ADTS)' },
    0xfffe: { codec: 'waveext', name: 'WAVEFORMATEXTENSIBLE' }
  };

  function msg(e) { return String((e && e.message) || e); }

  /* --------------------------------------------------------- small readers */

  function u8(d, p) { return d[p]; }
  function u16(d, p) { return d[p] | (d[p + 1] << 8); }
  function u32(d, p) {
    return (d[p] + (d[p + 1] << 8) + (d[p + 2] << 16) +
            (d[p + 3] * 16777216)) >>> 0;
  }
  function u64(d, p) {
    return (u32(d, p + 4) * 0x100000000 + u32(d, p));
  }

  /** Decode a UTF-16LE region, trailing NULs removed. */
  function utf16(d, p, nBytes) {
    if (nBytes <= 0) return '';
    try {
      return new TextDecoder('utf-16le').decode(d.subarray(p, p + nBytes))
        .replace(/\0+$/, '');
    } catch (e) {
      var s = '';
      for (var i = 0; i + 1 < nBytes; i += 2) s += String.fromCharCode(d[p + i]);
      return s.replace(/\0+$/, '');
    }
  }

  /** ASF property value types, shared by ECD and Metadata. */
  function typedValue(d, p, len, type) {
    switch (type) {
      case 0: return utf16(d, p, len);          // Unicode string
      case 1: return 'binary, ' + len + ' bytes';
      case 2: return len >= 4 ? !!u32(d, p) : !!u16(d, p); // Boolean
      case 3: return len >= 4 ? u32(d, p) : null;           // DWORD
      case 4: return len >= 8 ? u64(d, p) : null;           // QWORD
      case 5: return u16(d, p);                             // WORD
      default: return null;
    }
  }

  /* ==========================================================================
   * parse
   * ========================================================================*/

  function newResult() {
    return {
      formatId: 'asf',
      formatName: 'ASF / Windows Media',
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
    var d = ctx && ctx.data;
    if (!d || d.length < 30) {
      result.notes.push('File is too short to contain an ASF Header Object.');
      return result;
    }
    var br = new MA.ByteReader(d);
    var state = {
      d: d, br: br, result: result,
      streams: {},          // stream id -> track descriptor
      streamOrder: [],
      file: null,           // captured File Properties fields
      dataInfo: null        // { off, size, packets, payloadStart }
    };
    try {
      walkTopLevel(state);
      buildTracks(state);
    } catch (e) {
      result.notes.push('ASF parsing stopped early: ' + msg(e));
    }
    result.frames.sort(function (a, b) {
      if (a.offset !== b.offset) return a.offset - b.offset;
      return (a.dtsSec || 0) - (b.dtsSec || 0);
    });
    return result;
  }

  /* ----------------------------------------------------------- top level */

  function walkTopLevel(st) {
    var d = st.d, size = d.length;
    var p = 0, guard = 0;

    while (p + 24 <= size && guard++ < MAX_OBJECTS) {
      var g = st.br.guid(p);
      var osize = u64(d, p + 16);
      if (!osize || osize < 24 || p + osize > size) {
        st.result.notes.push('Object at ' + hex(p, 8) + ' has invalid size ' +
          osize + ' — top-level walk stopped.');
        break;
      }
      var body = p + 24, bodyEnd = p + osize;

      if (g === GUID.HEADER) {
        var headerNode = makeNode('box', 'header', 'ASF Header Object', p, osize);
        nodeField(headerNode, 'Object GUID', g, p, 16);
        nodeField(headerNode, 'Object Size', osize + ' bytes', p + 16, 8);
        var numChildren = u32(d, body);
        nodeField(headerNode, 'Number of Header Objects', numChildren, body, 4);
        // ffmpeg skips two bytes here (avio_rl32 + avio_r8 + avio_r8);
        // on-disk fixtures carry 0x01 0x02 before the first child object.
        nodeField(headerNode, 'Reserved1', '0x' + MA.pad(d[body + 4].toString(16), 2),
                  body + 4, 1);
        nodeField(headerNode, 'Reserved2', '0x' + MA.pad(d[body + 5].toString(16), 2),
                  body + 5, 1);
        st.result.structures.push(headerNode);
        walkChildren(st, body + 6, bodyEnd, headerNode, numChildren);
      } else if (g === GUID.DATA) {
        parseDataObject(st, p, osize);
      } else {
        var node = makeNode('box', g, OBJECT_NAMES[g] || ('ASF Object ' + g), p, osize);
        nodeField(node, 'Object GUID', g, p, 16);
        nodeField(node, 'Object Size', osize + ' bytes', p + 16, 8);
        if (bodyEnd - body >= 16) nodeField(node, 'Payload', (osize - 24) + ' bytes', body, osize - 24);
        node.expanded = false;
        st.result.structures.push(node);
      }
      p += osize;
    }
  }

  /** Walk the children of the Header Object (or Header Extension data). */
  function walkChildren(st, start, end, parent, declared) {
    var d = st.d;
    var p = start, n = 0, cap = Math.max(0, declared || 0) + 4;
    while (p + 24 <= end && n < cap && parent.children.length < MAX_CHILDREN) {
      var g = d.length >= p + 16 ? st.br.guid(p) : '';
      var osize = u64(d, p + 16);
      if (!osize || osize < 24 || p + osize > end) break;
      var node = makeNode('box', objectCode(g), OBJECT_NAMES[g] || ('ASF Object ' + g),
                          p, osize);
      nodeField(node, 'Object GUID', g, p, 16);
      nodeField(node, 'Object Size', osize + ' bytes', p + 16, 8);

      if (g === GUID.FILE_PROPERTIES) parseFileProperties(st, p, osize, node);
      else if (g === GUID.STREAM_PROPERTIES) parseStreamProperties(st, p, osize, node);
      else if (g === GUID.HEADER_EXTENSION) parseHeaderExtension(st, p, osize, node);
      else if (g === GUID.CODEC_LIST) parseCodecList(st, p, osize, node);
      else if (g === GUID.CONTENT_DESC) parseContentDesc(st, p, osize, node);
      else if (g === GUID.EXT_CONTENT_DESC) parseExtContentDesc(st, p, osize, node);
      else if (g === GUID.METADATA) parseMetadata(st, p, osize, node, true);
      else nodeNote(node, (osize - 24) + ' bytes (not decoded)');

      parent.children.push(node);
      p += osize;
      n++;
    }
    if (p < end) {
      parent.children.push(makeNode('box', 'gap', 'Remaining header data', p, end - p));
    }
  }

  function objectCode(g) {
    var map = {};
    map[GUID.FILE_PROPERTIES] = 'File Properties';
    map[GUID.STREAM_PROPERTIES] = 'Stream Properties';
    map[GUID.HEADER_EXTENSION] = 'Header Extension';
    map[GUID.CODEC_LIST] = 'Codec List';
    map[GUID.CONTENT_DESC] = 'Content Description';
    map[GUID.EXT_CONTENT_DESC] = 'Extended Content Description';
    map[GUID.METADATA] = 'Metadata';
    return map[g] || g.slice(0, 8);
  }

  /* ------------------------------------------------------- File Properties */

  function parseFileProperties(st, p, size, node) {
    var d = st.d;
    var b = p + 24;                                  // body offset
    nodeField(node, 'File ID', st.br.guid(b), b, 16);
    var fileSize = u64(d, b + 16);
    nodeField(node, 'File Size', formatSize(fileSize) + ' (' + fileSize + ' bytes)',
              b + 16, 8);
    var createTime = u64(d, b + 24);
    nodeField(node, 'Creation Time (FILETIME, 100ns since 1601)',
              createTime ? new Date((createTime - 116444736000000000) / 10000).toISOString()
                         : '(unset)', b + 24, 8);
    var dataPackets = u64(d, b + 32);
    nodeField(node, 'Data Packets Count', dataPackets, b + 32, 8);
    var playTime = u64(d, b + 40);
    nodeField(node, 'Play Duration', (playTime / 1e7).toFixed(3) + ' s', b + 40, 8);
    var sendTime = u64(d, b + 48);
    nodeField(node, 'Send Duration', (sendTime / 1e7).toFixed(3) + ' s', b + 48, 8);
    var preroll = u32(d, b + 56);
    nodeField(node, 'Preroll', preroll + ' ms', b + 56, 4);
    nodeField(node, 'Reserved (Ignore)', u32(d, b + 60), b + 60, 4);
    var flags = u32(d, b + 64);
    nodeField(node, 'Flags', '0x' + MA.pad(flags.toString(16), 8) +
      ' (broadcast=' + (flags & 1) + ', seekable=' + ((flags >> 1) & 1) + ')', b + 64, 4);
    var minPkt = u32(d, b + 68), maxPkt = u32(d, b + 72), maxBr = u32(d, b + 76);
    nodeField(node, 'Minimum Data Packet Size', minPkt + ' bytes', b + 68, 4);
    nodeField(node, 'Maximum Data Packet Size', maxPkt + ' bytes', b + 72, 4);
    nodeField(node, 'Maximum Bitrate', MA.formatBitrate(maxBr), b + 76, 4);

    st.file = {
      fileSize: fileSize, dataPackets: dataPackets,
      playTime: playTime, sendTime: sendTime, preroll: preroll,
      flags: flags, minPkt: minPkt, maxPkt: maxPkt, maxBitrate: maxBr
    };
  }

  /* ----------------------------------------------------- Stream Properties */

  function parseStreamProperties(st, p, size, node) {
    var d = st.d;
    var b = p + 24;
    var typeGuid = st.br.guid(b);
    var ecGuid = st.br.guid(b + 16);
    nodeField(node, 'Stream Type GUID', typeGuid, b, 16);
    nodeField(node, 'Error Correction Type GUID', ecGuid, b + 16, 16);
    nodeField(node, 'Time Offset', u64(d, b + 32) + ' (100ns)', b + 32, 8);
    var typeLen = u32(d, b + 40);
    var ecLen = u32(d, b + 44);
    nodeField(node, 'Type-Specific Data Length', typeLen + ' bytes', b + 40, 4);
    nodeField(node, 'Error Correction Data Length', ecLen + ' bytes', b + 44, 4);
    var flags = u16(d, b + 48);
    var streamId = flags & 0x7f;
    nodeField(node, 'Flags', '0x' + MA.pad(flags.toString(16), 4) +
      ' (stream #' + streamId + (flags & 0x80 ? ', encrypted)' : ')'), b + 48, 2);
    nodeField(node, 'Reserved2', u32(d, b + 50), b + 50, 4);

    var typeData = b + 54;
    var stream = {
      id: streamId,
      typeGuid: typeGuid,
      typeDataOff: typeData,
      typeDataLen: typeLen,
      ecOff: typeData + typeLen,
      ecLen: ecLen
    };

    if (typeGuid === GUID.STREAM_VIDEO) {
      parseVideoTypeData(st, stream, node);
    } else if (typeGuid === GUID.STREAM_AUDIO) {
      parseAudioTypeData(st, stream, node);
    } else {
      nodeField(node, 'Type-Specific Data', typeLen + ' bytes (unsupported stream type)',
                typeData, Math.min(typeLen, size - 24 - 54));
      stream.kind = 'other';
    }
    if (ecLen > 0 && stream.ecOff + ecLen <= p + size) {
      nodeField(node, 'Error Correction Data', MA.bytesToHexShort(d.subarray(stream.ecOff,
        Math.min(stream.ecOff + ecLen, stream.ecOff + 16))), stream.ecOff,
        Math.min(ecLen, 16));
    }

    st.streams[streamId] = stream;
    st.streamOrder.push(streamId);
  }

  /**
   * Video type-specific data: 11-byte ASF prefix then a BITMAPINFOHEADER
   * (ffmpeg asf_read_stream_properties).
   */
  function parseVideoTypeData(st, s, node) {
    var d = st.d;
    var p = s.typeDataOff;
    var encW = u32(d, p), encH = u32(d, p + 4);
    nodeField(node, 'Encoded Image Width', encW, p, 4);
    nodeField(node, 'Encoded Image Height', encH, p + 4, 4);
    nodeField(node, 'Reserved', '0x' + MA.pad(d[p + 8].toString(16), 2), p + 8, 1);
    nodeField(node, 'Reserved (u16)', u16(d, p + 9), p + 9, 2);

    var bih = p + 11;
    var biSize = u32(d, bih);
    nodeField(node, 'BITMAPINFOHEADER Size', biSize + ' bytes', bih, 4);
    var width = u32(d, bih + 4), height = u32(d, bih + 8);
    nodeField(node, 'Width', width, bih + 4, 4);
    nodeField(node, 'Height', height, bih + 8, 4);
    nodeField(node, 'Planes', u16(d, bih + 12), bih + 12, 2);
    var depth = u16(d, bih + 14);
    nodeField(node, 'Bit Count', depth, bih + 14, 2);
    var cc = st.br.fourcc(bih + 16);
    nodeField(node, 'Compression (FourCC)', cc, bih + 16, 4);
    nodeField(node, 'Image Size', u32(d, bih + 20) + ' bytes', bih + 20, 4);
    nodeField(node, 'X Pixels Per Meter', u32(d, bih + 24), bih + 24, 4);
    nodeField(node, 'Y Pixels Per Meter', u32(d, bih + 28), bih + 28, 4);
    nodeField(node, 'Colors Used', u32(d, bih + 32), bih + 32, 4);
    nodeField(node, 'Important Colors', u32(d, bih + 36), bih + 36, 4);

    var extraSize = 0;
    if (biSize > 40 && bih + biSize <= s.typeDataOff + s.typeDataLen) {
      extraSize = biSize - 40;
      nodeField(node, 'Codec Extra Data', extraSize + ' bytes',
                bih + 40, Math.min(extraSize, 32));
    }

    var info = VIDEO_FOURCC[cc] || { codec: cc.toLowerCase(), name: 'FourCC "' + cc + '"' };
    s.kind = 'video';
    s.codec = info.codec;
    s.codecName = info.name;
    s.width = width;
    s.height = height;
    s.depth = depth;
  }

  /** Audio type-specific data is a WAVEFORMATEX. */
  function parseAudioTypeData(st, s, node) {
    var d = st.d;
    var p = s.typeDataOff;
    var tag = u16(d, p);
    nodeField(node, 'wFormatTag', '0x' + MA.pad(tag.toString(16), 4), p, 2);
    var channels = u16(d, p + 2);
    nodeField(node, 'Channels', channels, p + 2, 2);
    var sampleRate = u32(d, p + 4);
    nodeField(node, 'Samples Per Second', sampleRate, p + 4, 4);
    var avgBytes = u32(d, p + 8);
    nodeField(node, 'Average Bytes Per Second', avgBytes, p + 8, 4);
    var blockAlign = u16(d, p + 12);
    nodeField(node, 'Block Alignment', blockAlign, p + 12, 2);
    var bits = u16(d, p + 14);
    nodeField(node, 'Bits Per Sample', bits, p + 14, 2);
    var cbSize = u16(d, p + 16);
    nodeField(node, 'Codec Specific Data Size (cbSize)', cbSize, p + 16, 2);
    if (cbSize > 0 && p + 18 + cbSize <= s.typeDataOff + s.typeDataLen) {
      nodeField(node, 'Codec Specific Data',
                MA.bytesToHexShort(d.subarray(p + 18, p + 18 + cbSize)),
                p + 18, Math.min(cbSize, 16));
    }

    var info = AUDIO_TAGS[tag] || { codec: 'tag0x' + tag.toString(16),
                                   name: 'WAVE tag 0x' + MA.pad(tag.toString(16), 4) };
    s.kind = 'audio';
    s.codec = info.codec;
    s.codecName = info.name;
    s.channels = channels;
    s.sampleRate = sampleRate;
    s.avgBytesPerSec = avgBytes;
    s.blockAlign = blockAlign;
    s.bitsPerSample = bits;
    s.formatTag = tag;
  }

  /* ------------------------------------------------------- Header Extension */

  function parseHeaderExtension(st, p, size, node) {
    var d = st.d;
    var b = p + 24;
    nodeField(node, 'Reserved GUID 1', st.br.guid(b), b, 16);
    nodeField(node, 'Reserved 2', u16(d, b + 16), b + 16, 2);
    var extLen = u32(d, b + 18);
    nodeField(node, 'Header Extension Data Length', extLen + ' bytes', b + 18, 4);
    var start = b + 22, end = Math.min(p + size, start + extLen);
    walkChildren(st, start, end, node, 16);
  }

  /* ------------------------------------------------------------- Codec List */

  function parseCodecList(st, p, size, node) {
    var d = st.d;
    var q = p + 24;
    nodeField(node, 'Reserved GUID', st.br.guid(q), q, 16);
    q += 16;
    var count = u32(d, q);
    nodeField(node, 'Codec Entries Count', count, q, 4);
    q += 4;
    var i;
    for (i = 0; i < count && q + 8 <= p + size; i++) {
      var eStart = q;
      // Every entry starts with a type word: 0x0001 = video, 0x0002 = audio.
      var codecType = u16(d, q); q += 2;
      var typeName = codecType === 1 ? 'video' : codecType === 2 ? 'audio' : 'type' + codecType;
      var nameLen = u16(d, q); q += 2;            // characters
      var name = q + nameLen * 2 <= p + size ? utf16(d, q, nameLen * 2) : '';
      q += nameLen * 2;
      var descLen = u16(d, q); q += 2;            // characters
      var desc = q + descLen * 2 <= p + size ? utf16(d, q, descLen * 2) : '';
      q += descLen * 2;
      var infoLen = u16(d, q); q += 2;            // bytes
      var infoHex = '';
      if (q + infoLen <= p + size) {
        infoHex = MA.bytesToHexShort(d.subarray(q, q + infoLen));
      }
      // Codec Information is a 4-byte FourCC for video, a 2-byte WAVE tag
      // for audio; lavf splits the codec name across name/description
      // ("h" + "263"), so concatenate them.
      nodeField(node, 'Codec #' + (i + 1) + ' [' + typeName + ']',
        JSON.stringify(name + desc) + (infoHex ? ' — ' + infoHex : ''),
        eStart, Math.max(2, Math.min(p + size - eStart, 8)));
      q += infoLen;
    }
    nodeNote(node, count + ' codec entr(y/ies)');
  }

  /* --------------------------------------------- Content / ECD / Metadata */

  function parseContentDesc(st, p, size, node) {
    var d = st.d;
    var q = p + 24, b = q;
    var lens = [u16(d, q), u16(d, q + 2), u16(d, q + 4), u16(d, q + 6), u16(d, q + 8)];
    var names = ['Title', 'Author', 'Copyright', 'Description', 'Rating'];
    q += 10;
    for (var i = 0; i < 5; i++) {
      var len = lens[i];
      if (len > 0 && q + len <= p + size) {
        var val = utf16(d, q, len);
        nodeField(node, names[i], JSON.stringify(val), q, len);
        st.result.metadata.push({ key: names[i], value: val });
      }
      q += len;
    }
    nodeNote(node, 'Content description, ' + (p + size - b) + ' bytes');
  }

  function parseExtContentDesc(st, p, size, node) {
    var d = st.d;
    var q = p + 24;
    var count = u16(d, q);
    nodeField(node, 'Content Descriptors Count', count, q, 2);
    q += 2;
    for (var i = 0; i < count && q + 8 <= p + size; i++) {
      var rawNameLen = u16(d, q); q += 2;
      // Lengths are in bytes; broken lavf versions wrote odd name lengths.
      var nameLen = rawNameLen % 2 ? rawNameLen + 1 : rawNameLen;
      var name = q + nameLen <= p + size ? utf16(d, q, nameLen) : '';
      q += nameLen;
      var type = u16(d, q); q += 2;
      var valLen = u16(d, q); q += 2;
      if ((type === 0 || type === 1) && valLen % 2 === 1) valLen++;
      var value = q + valLen <= p + size ? typedValue(d, q, valLen, type) : null;
      if (value != null) {
        nodeField(node, name, String(value), q, Math.min(valLen, 32));
        st.result.metadata.push({ key: name, value: value });
      }
      q += valLen;
    }
  }

  function parseMetadata(st, p, size, node, inExtension) {
    var d = st.d;
    var q = p + 24;
    if (!inExtension) {
      // Legacy Metadata Object carries a reserved u16 before the count.
      nodeField(node, 'Reserved', u16(d, q), q, 2);
      q += 2;
    }
    var count = u16(d, q);
    nodeField(node, 'Metadata Records Count', count, q, 2);
    q += 2;
    for (var i = 0; i < count && q + 12 <= p + size; i++) {
      var lang = u16(d, q); q += 2;
      var streamNum = u16(d, q); q += 2;
      var nameLen = u16(d, q); q += 2;              // bytes
      var type = u16(d, q); q += 2;
      var valLen = u32(d, q); q += 4;
      var name = q + nameLen <= p + size ? utf16(d, q, nameLen) : '';
      q += nameLen;
      var value = q + valLen <= p + size ? typedValue(d, q, valLen, type) : null;
      var target = streamNum ? ('stream #' + streamNum) : 'file';
      if (value != null) {
        nodeField(node, name + ' (' + target + ')', String(value), q, Math.min(valLen, 32));
        st.result.metadata.push({ key: name, value: value });
      }
      q += valLen;
    }
  }

  /* ============================================================== Data */

  function parseDataObject(st, p, size) {
    var d = st.d;
    var b = p + 24;
    var node = makeNode('box', 'data', 'ASF Data Object', p, size);
    nodeField(node, 'Object GUID', st.br.guid(p), p, 16);
    nodeField(node, 'Object Size', size + ' bytes', p + 16, 8);
    nodeField(node, 'File ID', st.br.guid(b), b, 16);
    var totalPackets = u64(d, b + 16);
    nodeField(node, 'Total Data Packets', totalPackets, b + 16, 8);
    nodeField(node, 'Reserved', u16(d, b + 24), b + 24, 2);
    st.result.structures.push(node);

    var packetStart = b + 26;
    st.dataInfo = { off: p, size: size, packetsDecl: totalPackets,
                    payloadStart: packetStart };

    var stats = walkPackets(st, packetStart, p + size);

    nodeField(node, 'Data Packets Parsed', stats.packets, packetStart, 0);
    nodeNote(node, stats.packets + ' packet(s), ' + stats.payloads +
      ' payload fragment(s), ' + stats.objects + ' media object(s)');
    st.result.extra.push({ label: 'ASF data packets', value: stats.packets });
    st.result.extra.push({ label: 'Payload fragments', value: stats.payloads });
    st.result.extra.push({ label: 'Reassembled media objects', value: stats.objects });
  }

  function do2bits(d, p, type, defval) {
    switch (type & 3) {
      case 3: return { v: u32(d, p), n: 4 };
      case 2: return { v: u16(d, p), n: 2 };
      case 1: return { v: d[p], n: 1 };
      default: return { v: defval, n: 0 };
    }
  }

  /**
   * Walk every data packet exactly like ffmpeg asf_get_packet +
   * asf_read_frame_header, collect payload fragments, reassemble media
   * objects and append frames.
   */
  function walkPackets(st, start, end) {
    var d = st.d;
    var stats = { packets: 0, payloads: 0, objects: 0 };
    var file = st.file;
    var packetSize = file && file.maxPkt ? file.maxPkt : 0;
    var preroll = file ? file.preroll : 0;

    var groups = {};        // stream:ts:seq -> { stream, ts, seq, key, parts:[] }
    var groupList = [];
    var bytesByStream = {};

    var p = start, guard = 0;
    while (p + 8 < end && guard++ < 5000000) {
      var pktStart = p;
      var q = p;
      var c = d[q++];
      // Error correction bytes.
      if (c & 0x80) {
        if (!(c & 0x60)) {
          q += 2;                                  // d, e (must be zero for 0x82)
          q += (c & 0xf) - 2;                      // adjustment length
        }
        if (q >= end) break;
        c = d[q++];
      }
      var flags = c;
      if (q >= end) break;
      var property = d[q++];

      var r;
      r = do2bits(d, q, flags >> 5, packetSize); q += r.n;
      var pktLen = r.v;
      r = do2bits(d, q, flags >> 1, 0); q += r.n;          // sequence, ignored
      r = do2bits(d, q, flags >> 3, 0); q += r.n;
      var padSize = r.v;

      if (!pktLen || pktLen >= (1 << 29) || pktStart + pktLen > end) break;
      var sendTime = u32(d, q); q += 4;
      var durationMs = u16(d, q); q += 2;

      var segments = 1, segSizeType = 0x80, hdrSize;
      if (flags & 1) {
        segSizeType = d[q++];
        segments = segSizeType & 0x3f;
      }
      hdrSize = q - pktStart;
      var left = pktLen - padSize - hdrSize;

      for (var s = 0; s < segments && q + 2 <= pktStart + pktLen; s++) {
        var fStart = q;
        var num = d[q++];
        var streamId = num & 0x7f, key = !!(num & 0x80);

        r = do2bits(d, q, property >> 4, 0); q += r.n;    // sequence (ignored)
        var seq = r.v;
        r = do2bits(d, q, property >> 2, 0); q += r.n;
        var fragOff = r.v;
        r = do2bits(d, q, property, 0); q += r.n;
        var replicSize = r.v;

        var fhdr = q - fStart;
        var objSize = 0, fragTs = sendTime, isMulti = false;
        var timeDelta = 0;
        if (replicSize >= 8) {
          objSize = u32(d, q);
          fragTs = u32(d, q + 4);
          q += replicSize;
          fhdr += replicSize;
        } else if (replicSize === 1) {
          // Compressed multipacket carrier: first byte is the time delta.
          timeDelta = d[q++];
          fhdr++;
          isMulti = true;
        } else if (replicSize !== 0) {
          q = pktStart + pktLen;
          break;
        }

        if (flags & 1) {
          r = do2bits(d, q, segSizeType >> 6, 0); q += r.n;
          fhdr += r.n;
        }
        var fragSize = (flags & 1) ? r.v : (left - fhdr);
        if (!isMulti) left -= fhdr;
        else left -= fhdr;

        if (isMulti) {
          // Chain of one-byte-sized subpayloads sharing this stream id.
          var timeStart = fragOff;
          var regionEnd = q + fragSize;
          while (q < regionEnd) {
            var subSize = d[q++];
            var subTs = sendTime + timeStart;
            timeStart += timeDelta;
            if (!subSize || q + subSize > regionEnd) break;
            addFragment(st, groups, groupList, streamId, subTs, seq, key, 0,
                        objSize || subSize, q, subSize, bytesByStream);
            stats.payloads++;
            q += subSize;
          }
          q = regionEnd;
        } else {
          if (fragSize > 0 && q + fragSize <= pktStart + pktLen + padSize) {
            addFragment(st, groups, groupList, streamId, fragTs, seq, key, fragOff,
                        objSize || fragSize, q, fragSize, bytesByStream);
            stats.payloads++;
          }
          q += fragSize;
        }
      }

      stats.packets++;
      p = pktStart + pktLen;
    }

    emitFrames(st, groupList, bytesByStream, preroll);
    stats.objects = groupList.length;
    return stats;
  }

  function addFragment(st, groups, groupList, streamId, ts, seq, key,
                       fragOff, objSize, off, size, bytesByStream) {
    var id = streamId + ':' + ts + ':' + seq;
    var g = groups[id];
    if (!g) {
      g = { stream: streamId, ts: ts, seq: seq, key: false,
            objSize: objSize, parts: [] };
      groups[id] = g;
      groupList.push(g);
    }
    g.key = g.key || key;
    if (objSize) g.objSize = objSize;
    g.parts.push({ off: off, size: size, fragOff: fragOff });
    bytesByStream[streamId] = (bytesByStream[streamId] || 0) + size;
  }

  /** Reassemble groups into frames. */
  function emitFrames(st, groupList, bytesByStream, preroll) {
    var d = st.d;
    // Preserve file-offset order: groups are created in packet order.
    for (var i = 0; i < groupList.length && st.result.frames.length < MAX_FRAMES; i++) {
      var g = groupList[i];
      var stream = st.streams[g.stream];
      g.parts.sort(function (a, b) { return a.fragOff - b.fragOff; });
      var first = g.parts[0];
      var total = g.parts.reduce(function (acc, x) { return acc + x.size; }, 0);
      var ptsSec = Math.max(0, (g.ts - preroll) / 1000);

      if (stream && stream.kind === 'video') {
        // ASF's per-fragment key bit is set for every part of a key object,
        // but the H.263 picture type is the authoritative I/P decision —
        // probe the reassembled bitstream (still resident in memory).
        var stitch = new Uint8Array(g.objSize || total);
        var contig = true, cursor = 0;
        for (var k = 0; k < g.parts.length; k++) {
          var pa = g.parts[k];
          if (pa.fragOff) { stitch.set(d.subarray(pa.off, pa.off + pa.size), pa.fragOff); contig = false; }
          else { stitch.set(d.subarray(pa.off, pa.off + pa.size), cursor); cursor += pa.size; }
        }
        var picType = null;
        var codecMod = stream.codec ? MA.getCodec(stream.codec) : null;
        if (codecMod && codecMod.probePicture) {
          try { picType = codecMod.probePicture(stitch); } catch (e) { picType = null; }
        }
        var isI = picType ? picType.type === 'I' : g.key;
        st.result.frames.push({
          track: g.stream, index: i + 1, type: 'video', kind: 'video',
          codec: stream.codec, offset: first.off, size: total,
          dtsSec: ptsSec, ptsSec: ptsSec, keyframe: isI,
          label: (picType ? picType.type : (g.key ? 'key' : 'inter')) + ' frame',
          syn: {
            codec: stream.codec, kind: 'raw',
            offset: first.off, base: first.off, size: total,
            parts: g.parts.map(function (x) { return { offset: x.off, size: x.size }; }),
            ctxKey: g.stream + ':' + stream.codec
          }
        });
      } else if (stream && stream.kind === 'audio') {
        st.result.frames.push({
          track: g.stream, index: i + 1, type: 'audio', kind: 'audio',
          codec: stream.codec, offset: first.off, size: total,
          dtsSec: ptsSec, ptsSec: ptsSec, keyframe: true,
          label: stream.codecName + ' frame',
          syn: {
            codec: stream.codec, kind: 'raw',
            offset: first.off, base: first.off, size: total,
            parts: g.parts.length > 1
              ? g.parts.map(function (x) { return { offset: x.off, size: x.size }; })
              : null
          }
        });
      } else {
        // Unknown / command / script stream — still list the object.
        st.result.frames.push({
          track: g.stream, index: i + 1, type: 'other', kind: 'other',
          codec: '', offset: first.off, size: total,
          dtsSec: ptsSec, ptsSec: ptsSec, keyframe: g.key,
          label: 'stream #' + g.stream + ' object'
        });
      }
    }
  }

  /* ---------------------------------------------------------------- tracks */

  function buildTracks(st) {
    var result = st.result;
    var frames = result.frames;
    var file = st.file;

    var sendDur = file ? file.sendTime : 0;
    var playDur = file ? file.playTime : 0;
    var preroll = file ? file.preroll : 0;
    var durationSec = sendDur ? sendDur / 1e7
      : (playDur ? Math.max(0, playDur / 1e7 - preroll / 1000) : null);
    result.durationSec = durationSec;

    st.streamOrder.forEach(function (id) {
      var s = st.streams[id];
      if (s.kind !== 'video' && s.kind !== 'audio') return;
      var trackFrames = frames.filter(function (f) { return f.track === id; });
      var sampleCount = trackFrames.length;
      var bytes = 0;
      for (var i = 0; i < trackFrames.length; i++) bytes += trackFrames[i].size;
      var lastPts = null;
      for (var j = 0; j < trackFrames.length; j++) {
        if (trackFrames[j].ptsSec != null) lastPts = trackFrames[j].ptsSec;
      }

      var track = {
        id: id,
        type: s.kind,
        codec: s.codec,
        codecName: s.codecName,
        profile: '',
        level: '',
        width: null,
        height: null,
        fps: null,
        sampleRate: null,
        channels: null,
        durationSec: durationSec,
        bitrate: durationSec > 0 && bytes > 0 ? Math.round(bytes * 8 / durationSec) : null,
        streamSize: bytes || null,
        sampleCount: sampleCount,
        language: '',
        extra: []
      };

      if (s.kind === 'video') {
        track.width = s.width;
        track.height = s.height;
        if (durationSec > 0 && sampleCount > 0) {
          track.fps = sampleCount / durationSec;
        }
        if (s.depth) track.extra.push({ label: 'Bit depth', value: s.depth });
      } else {
        track.sampleRate = s.sampleRate;
        track.channels = s.channels;
        track.channelLayout = s.channels === 1 ? 'mono'
          : s.channels === 2 ? 'stereo' : (s.channels ? s.channels + ' ch' : '');
        track.bitDepth = s.bitsPerSample;
        if (s.blockAlign) track.extra.push({ label: 'Block alignment', value: s.blockAlign });
        if (s.avgBytesPerSec) {
          var declared = s.avgBytesPerSec * 8;
          if (!track.bitrate) track.bitrate = declared;
        }
      }
      result.tracks.push(track);

      if (s.kind === 'video') {
        result.codecContexts[id + ':' + s.codec] = {
          width: s.width, height: s.height, codecName: s.codecName
        };
      }
    });

    if (file) {
      result.extra.push({ label: 'Preroll', value: preroll + ' ms' });
      result.extra.push({
        label: 'Flags',
        value: 'broadcast=' + (file.flags & 1 ? 'yes' : 'no') +
               ', seekable=' + ((file.flags >> 1) & 1 ? 'yes' : 'no')
      });
      if (file.maxBitrate) {
        result.bitrate = file.maxBitrate;
      } else if (durationSec > 0) {
        var total = result.tracks.reduce(function (a, t) { return a + (t.streamSize || 0); }, 0);
        result.bitrate = total > 0 ? Math.round(total * 8 / durationSec) : null;
      }
    }
    if (!result.tracks.length) {
      result.notes.push('No audio or video stream properties were found in the ASF header.');
    }

    fillDurations(frames);
  }

  /** Per-frame durations from the next frame of the same track. */
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
  }

  MA.registerParser({
    id: 'asf',
    name: 'ASF',
    extensions: ['asf', 'wma', 'wmv'],
    parse: parse
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
