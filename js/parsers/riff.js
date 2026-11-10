/* ============================================================================
 * MediaAnalyzer — parsers/riff.js
 *
 * RIFF containers:
 *   WAVE  — .wav / .wave, including WAVE_FORMAT_EXTENSIBLE and the common
 *           metadata chunks (LIST/INFO, bext, fact, cue, smpl, id3)
 *   AVI   — .avi, hdrl/strl stream headers plus the movi chunk stream, which
 *           is where the actual frames live
 *
 * RIFF rules that matter here: chunk payloads are word aligned (an odd size is
 * followed by a pad byte), and the chunk id is case sensitive.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var MAX_CHUNKS = 20000;
  var MAX_AVI_FRAMES = 60000;
  var MAX_ROWS = 32;

  /* ------------------------------------------------------------ WAVE */

  var FMT_TAGS = {
    0x0001: 'PCM (integer)', 0x0002: 'Microsoft ADPCM', 0x0003: 'IEEE float',
    0x0006: 'ITU G.711 A-law', 0x0007: 'ITU G.711 µ-law',
    0x0011: 'IMA ADPCM', 0x0016: 'ITU G.723 ADPCM', 0x0031: 'GSM 6.10',
    0x0050: 'MPEG (MP2/MP3)', 0x0055: 'MPEG Layer 3 (MP3)',
    0x0064: 'ITU G.721 ADPCM', 0x0070: 'Vorbis', 0xfffe: 'Extensible',
    0x2000: 'AC-3', 0x2001: 'DTS', 0x000a: 'Windows Media Audio'
  };

  var CHANNEL_MASK = {
    0x00001: 'Front Left', 0x00002: 'Front Right', 0x00004: 'Front Center',
    0x00008: 'Low Frequency', 0x00010: 'Back Left', 0x00020: 'Back Right',
    0x00040: 'Front Left of Center', 0x00080: 'Front Right of Center',
    0x00100: 'Back Center', 0x00200: 'Side Left', 0x00400: 'Side Right',
    0x00800: 'Top Center', 0x01000: 'Top Front Left', 0x02000: 'Top Front Center',
    0x04000: 'Top Front Right', 0x08000: 'Top Back Left', 0x10000: 'Top Back Center',
    0x20000: 'Top Back Right'
  };

  var INFO_TAGS = {
    INAM: 'title', IART: 'artist', ICMT: 'comment', ICOP: 'copyright',
    ICRD: 'date', IGNR: 'genre', ISFT: 'software', ISBJ: 'subject',
    IENG: 'engineer', ITCH: 'technician', IPRD: 'product', ISRC: 'source',
    ICMS: 'commissioned', IKEY: 'keywords', IMED: 'medium', ILGT: 'lightness'
  };

  /** Walk the top level chunk list of a RIFF file. */
  function walkChunks(ctx, onChunk) {
    var data = ctx.data;
    if (data.length < 12) return false;
    var declared = readU32(data, 4);
    var end = Math.min(data.length, 8 + declared);
    var p = 12;                                   // skip "RIFF" + size + form type
    var guard = 0;
    while (p + 8 <= end && ++guard < MAX_CHUNKS) {
      var id = fourcc(data, p);
      var size = readU32(data, p + 4);
      var body = p + 8;
      if (body + size > data.length) {
        // Tolerate a truncated final chunk rather than losing the whole file.
        onChunk(id, body, data.length, size, p, true);
        break;
      }
      onChunk(id, body, body + size, size, p, false);
      p = body + size + (size & 1);               // word alignment
    }
    return true;
  }

  function fourcc(data, p) {
    return String.fromCharCode(data[p] || 0, data[p + 1] || 0, data[p + 2] || 0, data[p + 3] || 0);
  }
  function readU16(data, p) { return (data[p] | (data[p + 1] << 8)) >>> 0; }
  function readU32(data, p) {
    return (data[p] | (data[p + 1] << 8) | (data[p + 2] << 16) | (data[p + 3] << 24)) >>> 0;
  }
  function readI32(data, p) {
    var v = readU32(data, p);
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
  function readStr(data, p, n) {
    var s = '';
    for (var i = 0; i < n && p + i < data.length; i++) {
      if (data[p + i] === 0) break;
      s += String.fromCharCode(data[p + i]);
    }
    return s;
  }

  /* ================================================================ WAVE */

  function parseWav(ctx) {
    var data = ctx.data;
    var result = {
      formatId: 'wav', formatName: 'WAVE (RIFF)', durationSec: null, bitrate: null,
      tracks: [], metadata: [], structures: [], frames: [], notes: [], codecContexts: {}
    };
    if (fourcc(data, 8) !== 'WAVE') {
      result.notes.push('The RIFF form type is not "WAVE".');
      return result;
    }

    var root = MA.makeNode('riff', 'RIFF', 'RIFF WAVE', 0, Math.min(data.length, 8 + readU32(data, 4)));
    MA.nodeField(root, 'ChunkSize', readU32(data, 4), 4, 4);
    MA.nodeField(root, 'FormType', "'WAVE'", 8, 4);

    var fmt = null;
    var fmtNode = null;
    var dataChunk = null;
    var factSamples = null;

    walkChunks(ctx, function (id, body, end, size, chunkStart, truncated) {
      var node = MA.makeNode('chunk', id, chunkNameWav(id), chunkStart, 8 + size);
      MA.nodeField(node, 'ckID', "'" + id + "'", chunkStart, 4);
      MA.nodeField(node, 'ckSize', size, chunkStart + 4, 4);

      if (id === 'fmt ') {
        fmt = parseFmt(data, body, end, node);
        fmtNode = node;
      } else if (id === 'data') {
        dataChunk = { offset: body, size: end - body };
        MA.nodeField(node, 'data', MA.formatSize(end - body), body, 4);
      } else if (id === 'fact') {
        factSamples = readU32(data, body);
        MA.nodeField(node, 'dwSampleLength', factSamples, body, 4);
      } else if (id === 'LIST') {
        parseListInfo(data, body, end, node, result);
      } else if (id === 'bext') {
        parseBext(data, body, end, node, result);
      } else if (id === 'id3 ' || id === 'ID3 ') {
        MA.nodeField(node, 'ID3 tag', (end - body) + ' bytes', body, end - body);
        result.notes.push('An ID3 tag is embedded in the WAVE file.');
      } else if (id === 'cue ') {
        var cuePoints = readU32(data, body);
        MA.nodeField(node, 'dwCuePoints', cuePoints, body, 4);
      } else if (id === 'smpl') {
        var loops = readU32(data, body + 28);
        MA.nodeField(node, 'dwSampleLoops', loops, body + 28, 4);
      }
      if (truncated) MA.nodeNote(node, 'Chunk is truncated — only ' + (end - body) + ' of ' + size + ' bytes are present.');
      root.children.push(node);
    });

    result.structures = [root];

    if (fmt) {
      var duration = null;
      if (fmt.byteRate > 0 && dataChunk) duration = dataChunk.size / fmt.byteRate;
      else if (fmt.sampleRate > 0 && factSamples) duration = factSamples / fmt.sampleRate;

      result.tracks.push({
        id: 1, type: 'audio',
        codec: 'wav', codecName: fmt.formatName,
        profile: '', level: '',
        sampleRate: fmt.sampleRate,
        channels: fmt.channels,
        channelLayout: fmt.channelLayout,
        bitDepth: fmt.bitsPerSample,
        durationSec: duration,
        bitrate: fmt.byteRate > 0 ? fmt.byteRate * 8 : null,
        sampleCount: factSamples || (fmt.blockAlign > 0 && dataChunk ? Math.round(dataChunk.size / fmt.blockAlign) : null),
        language: 'PCM',
        extra: fmt.extra
      });
      result.durationSec = duration;
      result.bitrate = fmt.byteRate > 0 ? fmt.byteRate * 8 : null;
    } else {
      result.notes.push('No "fmt " chunk was found, so the audio parameters are unknown.');
    }

    // WAV has no frame table — one entry describing the audio data region.
    if (dataChunk) {
      result.frames.push({
        track: 1, index: 1, type: 'audio', kind: 'audio',
        codec: 'wav', offset: dataChunk.offset, size: dataChunk.size,
        ptsSec: 0, dtsSec: 0, durationSec: result.durationSec || 0,
        keyframe: true, label: 'PCM data',
        tables: [MA.synSection('audio_data', (fmt ? fmt.formatName : 'WAVE') + ' payload', [
          { name: 'data_offset', syntax: '', bits: '', value: MA.hex(dataChunk.offset, 8), note: '', offset: dataChunk.offset, depth: 0 },
          { name: 'data_size', syntax: '', bits: '', value: MA.formatSize(dataChunk.size) + ' (' + dataChunk.size + ' bytes)', note: '', offset: dataChunk.offset, depth: 0 },
          { name: 'block_align', syntax: 'u(16)', bits: 16, value: fmt ? fmt.blockAlign : '—', note: 'bytes per sample frame', offset: dataChunk.offset, depth: 0 },
          { name: 'sample_frames', syntax: '', bits: '', value: fmt && fmt.blockAlign ? Math.floor(dataChunk.size / fmt.blockAlign) : '—', note: '', offset: dataChunk.offset, depth: 0 }
        ])]
      });
    }
    return result;
  }

  function chunkNameWav(id) {
    var m = {
      'fmt ': 'Format Chunk', 'data': 'Data Chunk', 'fact': 'Fact Chunk',
      'LIST': 'List Chunk', 'cue ': 'Cue Points', 'smpl': 'Sample Loop',
      'bext': 'Broadcast Audio Extension', 'iXML': 'iXML Metadata',
      'axml': 'ADM Metadata', 'id3 ': 'ID3 Tag', 'ID3 ': 'ID3 Tag',
      'JUNK': 'Junk', 'PAD ': 'Padding', 'PEAK': 'Peak Envelope',
      'inst': 'Instrument', 'ltxt': 'Labeled Text', 'note': 'Note',
      'labl': 'Cue Label', 'adtl': 'Associated Data List'
    };
    return m[id] || '';
  }

  function parseFmt(data, body, end, node) {
    var fmt = { extra: [] };
    fmt.formatTag = readU16(data, body);
    fmt.channels = readU16(data, body + 2);
    fmt.sampleRate = readU32(data, body + 4);
    fmt.byteRate = readU32(data, body + 8);
    fmt.blockAlign = readU16(data, body + 12);
    fmt.bitsPerSample = readU16(data, body + 14);
    fmt.formatName = FMT_TAGS[fmt.formatTag] || ('Format 0x' + fmt.formatTag.toString(16));

    MA.nodeField(node, 'wFormatTag', '0x' + MA.pad(fmt.formatTag.toString(16), 4, '0') + ' (' + fmt.formatName + ')', body, 2);
    MA.nodeField(node, 'nChannels', fmt.channels, body + 2, 2);
    MA.nodeField(node, 'nSamplesPerSec', fmt.sampleRate, body + 4, 4);
    MA.nodeField(node, 'nAvgBytesPerSec', fmt.byteRate, body + 8, 4);
    MA.nodeField(node, 'nBlockAlign', fmt.blockAlign, body + 12, 2);
    MA.nodeField(node, 'wBitsPerSample', fmt.bitsPerSample, body + 14, 2);

    // WAVE_FORMAT_EXTENSIBLE: cbSize, valid bits, channel mask, sub-format GUID.
    if (fmt.formatTag === 0xfffe && body + 40 <= end) {
      var cbSize = readU16(data, body + 16);
      MA.nodeField(node, 'cbSize', cbSize, body + 16, 2);
      var validBits = readU16(data, body + 18);
      var mask = readU32(data, body + 20);
      var subFormat = readU16(data, body + 24);
      MA.nodeField(node, 'wValidBitsPerSample', validBits, body + 18, 2);
      MA.nodeField(node, 'dwChannelMask', '0x' + MA.pad(mask.toString(16), 8, '0'), body + 20, 4);
      MA.nodeField(node, 'SubFormat (first 2 bytes)', '0x' + MA.pad(subFormat.toString(16), 4, '0') + ' (' + (FMT_TAGS[subFormat] || 'unknown') + ')', body + 24, 2);
      MA.nodeField(node, 'GUID remainder', guidString(data, body + 26), body + 26, 14);

      var speakers = [];
      Object.keys(CHANNEL_MASK).forEach(function (bit) {
        if (mask & Number(bit)) speakers.push(CHANNEL_MASK[bit]);
      });
      if (speakers.length) MA.nodeField(node, 'channel mask', speakers.join(', '), body + 20, 4);
      fmt.channelLayout = speakers.length ? speakers.join(' + ') : null;
      fmt.validBits = validBits || null;
      if (speakers.length) fmt.extra.push({ label: 'Speaker layout', value: speakers.join(', ') });
      fmt.formatName = (FMT_TAGS[subFormat] || 'Extensible') + ' (extensible)';
    } else if (body + 18 <= end) {
      var cb = readU16(data, body + 16);
      if (cb > 0) MA.nodeField(node, 'cbSize', cb, body + 16, 2);
    }

    if (!fmt.channelLayout) {
      fmt.channelLayout = fmt.channels === 1 ? '1 (mono)'
                        : fmt.channels === 2 ? '2 (stereo)' : String(fmt.channels);
    }
    if (fmt.sampleRate) fmt.extra.push({ label: 'Sample format', value: fmt.bitsPerSample + '-bit' + (fmt.validBits && fmt.validBits !== fmt.bitsPerSample ? ' (valid ' + fmt.validBits + ')' : '') });
    return fmt;
  }

  function guidString(data, p) {
    var s = [];
    for (var i = 0; i < 14 && p + i < data.length; i++) s.push(MA.pad(data[p + i].toString(16), 2, '0').toUpperCase());
    return s.join(' ');
  }

  function parseListInfo(data, body, end, node, result) {
    var listType = fourcc(data, body);
    MA.nodeField(node, 'listType', "'" + listType + "'", body, 4);
    if (listType !== 'INFO') return;
    var p = body + 4;
    var guard = 0;
    while (p + 8 <= end && ++guard < MAX_ROWS * 4) {
      var id = fourcc(data, p);
      var size = readU32(data, p + 4);
      var val = readStr(data, p + 8, Math.min(size, end - (p + 8)));
      MA.nodeField(node, INFO_TAGS[id] || id, val, p + 8, size);
      if (val) result.metadata.push({ key: INFO_TAGS[id] || id, value: val });
      p += 8 + size + (size & 1);
    }
  }

  function parseBext(data, body, end, node, result) {
    var rows = [
      ['Description', 0, 256], ['Originator', 256, 32], ['OriginatorReference', 288, 32],
      ['OriginationDate', 320, 10], ['OriginationTime', 330, 8]
    ];
    rows.forEach(function (r) {
      if (body + r[1] + r[2] <= end) {
        var v = readStr(data, body + r[1], r[2]);
        MA.nodeField(node, r[0], v || '(empty)', body + r[1], r[2]);
        if (v && (r[0] === 'Description' || r[0] === 'Originator')) {
          result.metadata.push({ key: r[0].toLowerCase(), value: v });
        }
      }
    });
    if (body + 344 <= end) {
      var low = readU32(data, body + 338);
      var high = readU32(data, body + 342);
      MA.nodeField(node, 'TimeReference', high * 0x100000000 + low, body + 338, 8);
    }
    if (body + 348 <= end) MA.nodeField(node, 'Version', readU16(data, body + 346), body + 346, 2);
  }

  /* ================================================================= AVI */

  function parseAvi(ctx) {
    var data = ctx.data;
    var result = {
      formatId: 'avi', formatName: 'AVI (RIFF)', durationSec: null, bitrate: null,
      tracks: [], metadata: [], structures: [], frames: [], notes: [], codecContexts: {}
    };
    if (fourcc(data, 8) !== 'AVI ') {
      result.notes.push('The RIFF form type is not "AVI " (it may be AVIX or a non-AVI RIFF file).');
      return result;
    }

    var root = MA.makeNode('riff', 'RIFF', 'RIFF AVI', 0, Math.min(data.length, 8 + readU32(data, 4)));
    MA.nodeField(root, 'ChunkSize', readU32(data, 4), 4, 4);
    MA.nodeField(root, 'FormType', "'AVI '", 8, 4);
    result.structures = [root];

    var streams = [];
    var avih = null;
    var moviChunks = [];
    var moviStart = 0;

    walkChunks(ctx, function (id, body, end, size, chunkStart, truncated) {
      if (id === 'LIST') {
        var listType = fourcc(data, body);
        var listNode = MA.makeNode('list', listType, listName(listType), chunkStart, 8 + size);
        MA.nodeField(listNode, 'listType', "'" + listType + "'", body, 4);
        root.children.push(listNode);

        if (listType === 'hdrl') parseHdrl(data, body + 4, end, listNode, result, streams, function (v) { avih = v; });
        else if (listType === 'INFO') parseListInfo(data, body, end, listNode, result);
        else if (listType === 'movi') {
          moviStart = body + 4;
          collectMovi(data, body + 4, end, listNode, moviChunks);
        }
      } else if (id === 'idx1') {
        var count = Math.floor((end - body) / 16);
        var idxNode = MA.makeNode('chunk', 'idx1', 'AVI Index', chunkStart, 8 + size);
        MA.nodeField(idxNode, 'entry_count', count, body, 4);
        root.children.push(idxNode);
      } else if (id === 'JUNK') {
        /* padding — not interesting */
      } else {
        var n = MA.makeNode('chunk', id, '', chunkStart, 8 + size);
        MA.nodeField(n, 'ckSize', size, chunkStart + 4, 4);
        root.children.push(n);
      }
      void truncated;
    });

    // ---- streams -> tracks + frames ---------------------------------
    // Bitrates need the byte totals that only exist after the movi walk.
    streams.forEach(function (st) {
      if (!st.bitrate && st.durationSec > 0 && st.bytes > 0) {
        st.bitrate = Math.round(st.bytes * 8 / st.durationSec);
      }
      var track = {
        id: st.number, type: st.kind,
        codec: st.codec, codecName: st.codecName,
        profile: '', level: '',
        width: st.width || null, height: st.height || null,
        fps: st.fps || null,
        sampleRate: st.sampleRate || null,
        channels: st.channels || null,
        channelLayout: st.channels === 1 ? '1 (mono)' : st.channels === 2 ? '2 (stereo)' : (st.channels ? String(st.channels) : null),
        bitDepth: st.bitDepth || null,
        durationSec: st.durationSec || null,
        bitrate: st.bitrate || null,
        sampleCount: st.frameCount || 0,
        language: st.language || '',
        extra: st.extra || []
      };
      result.tracks.push(track);
    });

    // movi chunks -> frames, in file order (which is already interleaved).
    var perTrackIndex = {};
    moviChunks.forEach(function (c) {
      if (c.streamNumber == null) return;
      var st = streams[c.streamNumber - 1];
      if (!st) return;
      perTrackIndex[st.number] = (perTrackIndex[st.number] || 0) + 1;
      var isKey = c.id.charAt(3) === 'b' || c.id.charAt(3) === 'B' || perTrackIndex[st.number] === 1;
      result.frames.push({
        track: st.number,
        index: perTrackIndex[st.number],
        type: st.kind === 'video' ? (isKey ? 'I' : 'P/B') : 'audio',
        kind: st.kind,
        codec: st.codec,
        offset: c.offset, size: c.size,
        ptsSec: st.fps > 0 && st.kind === 'video' ? (perTrackIndex[st.number] - 1) / st.fps : 0,
        dtsSec: st.fps > 0 && st.kind === 'video' ? (perTrackIndex[st.number] - 1) / st.fps : 0,
        keyframe: isKey,
        label: c.id,
        tables: [MA.synSection('avi_chunk', c.id + ' — ' + (st.codecName || st.kind) + ' sample', [
          { name: 'ckID', syntax: '', bits: '', value: "'" + c.id + "'", note: '', offset: c.offset - 8, depth: 0 },
          { name: 'ckSize', syntax: 'u(32) le', bits: 32, value: c.size, note: '', offset: c.offset - 4, depth: 0 },
          { name: 'stream', syntax: '', bits: '', value: st.number, note: st.codecName || '', offset: c.offset - 8, depth: 0 }
        ])]
      });
      st.bytes = (st.bytes || 0) + c.size;
    });

    if (result.frames.length > MAX_AVI_FRAMES) {
      result.frames.length = MAX_AVI_FRAMES;
      result.notes.push('Frame list capped at ' + MAX_AVI_FRAMES + ' chunks.');
    }
    result.frames.forEach(function (f, i) { f.listIndex = i + 1; });

    if (avih) {
      result.durationSec = avih.durationSec;
      result.bitrate = avih.bitrate;
      if (avih.width && !result.tracks.some(function (t) { return t.width; })) {
        result.notes.push('The main AVI header declares ' + avih.width + 'x' + avih.height + '.');
      }
    }
    if (!moviChunks.length) {
      result.notes.push('No "movi" chunks were found — the AVI index may point at data stored elsewhere.');
    }
    return result;
  }

  function listName(t) {
    var m = { hdrl: 'Header List', strl: 'Stream List', movi: 'Movie Data List',
              INFO: 'Info List', odml: 'OpenDML Extension', 'strl': 'Stream List' };
    return m[t] || '';
  }

  function parseHdrl(data, start, end, parentNode, result, streams, setAvih) {
    var p = start;
    var guard = 0;
    while (p + 8 <= end && ++guard < 4096) {
      var id = fourcc(data, p);
      var size = readU32(data, p + 4);
      var body = p + 8;
      if (body + size > end) break;

      if (id === 'LIST' && fourcc(data, body) === 'strl') {
        var n = MA.makeNode('list', 'strl', 'Stream List', p, 8 + size);
        parentNode.children.push(n);
        parseStrl(data, body + 4, body + size, n, streams);
      } else if (id === 'avih') {
        var a = parseAvih(data, body, n0(parentNode, p, size), result);
        setAvih(a);
      } else if (id === 'LIST' && fourcc(data, body) === 'odml') {
        var odml = MA.makeNode('list', 'odml', 'OpenDML Extension', p, 8 + size);
        parseOdml(data, body + 4, body + size, odml, result);
        parentNode.children.push(odml);
      }
      p = body + size + (size & 1);
    }
  }

  function n0(parent, p, size) {
    var n = MA.makeNode('chunk', 'avih', 'Main AVI Header', p, 8 + size);
    parent.children.push(n);
    return n;
  }

  function parseAvih(data, body, node, result) {
    var microPerFrame = readU32(data, body);
    var maxBytesPerSec = readU32(data, body + 4);
    var totalFrames = readU32(data, body + 16);
    var width = readU32(data, body + 32);
    var height = readU32(data, body + 36);

    MA.nodeField(node, 'dwMicroSecPerFrame', microPerFrame, body, 4);
    MA.nodeField(node, 'dwMaxBytesPerSec', maxBytesPerSec, body + 4, 4);
    MA.nodeField(node, 'dwPaddingGranularity', readU32(data, body + 8), body + 8, 4);
    MA.nodeField(node, 'dwFlags', '0x' + MA.pad(readU32(data, body + 12).toString(16), 8, '0'), body + 12, 4);
    MA.nodeField(node, 'dwTotalFrames', totalFrames, body + 16, 4);
    MA.nodeField(node, 'dwInitialFrames', readU32(data, body + 20), body + 20, 4);
    MA.nodeField(node, 'dwStreams', readU32(data, body + 24), body + 24, 4);
    MA.nodeField(node, 'dwSuggestedBufferSize', readU32(data, body + 28), body + 28, 4);
    MA.nodeField(node, 'dwWidth', width, body + 32, 4);
    MA.nodeField(node, 'dwHeight', height, body + 36, 4);

    var fps = microPerFrame > 0 ? 1000000 / microPerFrame : 0;
    if (fps) MA.nodeField(node, 'frame rate', MA.formatFps(fps), body, 0);
    var durationSec = fps > 0 && totalFrames ? totalFrames / fps : null;
    if (durationSec) MA.nodeField(node, 'duration', MA.formatDuration(durationSec), body, 0);

    return { width: width, height: height, totalFrames: totalFrames, fps: fps,
             durationSec: durationSec, bitrate: maxBytesPerSec * 8 || null };
  }

  function parseOdml(data, start, end, node, result) {
    var p = start, guard = 0;
    while (p + 8 <= end && ++guard < 256) {
      var id = fourcc(data, p);
      var size = readU32(data, p + 4);
      var body = p + 8;
      if (body + size > end) break;
      if (id === 'dmlh') {
        var total = readU32(data, body);
        MA.nodeField(node, 'dwTotalFrames', total, body, 4);
        result.notes.push('OpenDML index declares ' + total + ' frames in total.');
      }
      p = body + size + (size & 1);
    }
  }

  function parseStrl(data, start, end, parentNode, streams) {
    var st = { number: streams.length + 1, kind: 'other', extra: [] };
    var p = start, guard = 0;
    while (p + 8 <= end && ++guard < 512) {
      var id = fourcc(data, p);
      var size = readU32(data, p + 4);
      var body = p + 8;
      if (body + size > end) break;

      var node = MA.makeNode('chunk', id, id === 'strh' ? 'Stream Header' : (id === 'strf' ? 'Stream Format' : ''), p, 8 + size);
      parentNode.children.push(node);

      if (id === 'strh') parseStrh(data, body, size, node, st);
      else if (id === 'strf') parseStrf(data, body, size, node, st);
      else if (id === 'strn') {
        var nm = readStr(data, body, Math.min(size, 64));
        MA.nodeField(node, 'stream name', nm, body, size);
        st.name = nm;
      }
      p = body + size + (size & 1);
    }
    // The stream number is the zero-based index in the hdrl list order.
    st.number = streams.length + 1;
    streams.push(st);
  }

  function parseStrh(data, body, size, node, st) {
    if (size < 48) return;
    var fccType = fourcc(data, body);
    var fccHandler = fourcc(data, body + 4);
    var scale = readU32(data, body + 20);
    var rate = readU32(data, body + 24);
    var length = readU32(data, body + 32);
    var sampleSize = readU32(data, body + 40);
    var rcFrame = [readU16(data, body + 44), readU16(data, body + 46),
                   readU16(data, body + 48), readU16(data, body + 50)];

    MA.nodeField(node, 'fccType', "'" + fccType + "'", body, 4);
    MA.nodeField(node, 'fccHandler', "'" + fccHandler + "'", body + 4, 4);
    MA.nodeField(node, 'dwScale', scale, body + 20, 4);
    MA.nodeField(node, 'dwRate', rate, body + 24, 4);
    MA.nodeField(node, 'dwStart', readU32(data, body + 28), body + 28, 4);
    MA.nodeField(node, 'dwLength', length, body + 32, 4);
    MA.nodeField(node, 'dwSuggestedBufferSize', readU32(data, body + 36), body + 36, 4);
    MA.nodeField(node, 'dwSampleSize', sampleSize, body + 40, 4);
    if (size >= 52) MA.nodeField(node, 'rcFrame', rcFrame.join(', '), body + 44, 8);

    st.fccType = fccType;
    st.fccHandler = fccHandler;
    st.scale = scale; st.rate = rate; st.length = length;
    st.kind = fccType === 'vids' ? 'video' : fccType === 'auds' ? 'audio'
            : fccType === 'txts' ? 'subtitle' : 'other';
    if (scale > 0 && rate > 0) {
      st.ratePerSec = rate / scale;
      if (st.kind === 'video') st.fps = st.ratePerSec;
    }
    st.frameCount = length;
    if (st.kind === 'video' && rcFrame[2] && rcFrame[3]) {
      st.width = rcFrame[2];
      st.height = rcFrame[3];
    }
  }

  function parseStrf(data, body, size, node, st) {
    if (st.kind === 'audio' && size >= 16) {
      // WAVEFORMATEX — same layout as the WAVE "fmt " chunk.
      var tag = readU16(data, body);
      st.sampleRate = readU32(data, body + 4);
      st.byteRate = readU32(data, body + 8);
      st.blockAlign = readU16(data, body + 12);
      st.bitDepth = readU16(data, body + 14);
      st.channels = readU16(data, body + 2);
      st.codec = tag === 0x0055 ? 'mp3' : tag === 0x0001 ? 'pcm' : 'wav';
      st.codecName = FMT_TAGS[tag] || ('Format 0x' + tag.toString(16));
      MA.nodeField(node, 'wFormatTag', '0x' + MA.pad(tag.toString(16), 4, '0') + ' (' + st.codecName + ')', body, 2);
      MA.nodeField(node, 'nChannels', st.channels, body + 2, 2);
      MA.nodeField(node, 'nSamplesPerSec', st.sampleRate, body + 4, 4);
      MA.nodeField(node, 'nAvgBytesPerSec', st.byteRate, body + 8, 4);
      MA.nodeField(node, 'nBlockAlign', st.blockAlign, body + 12, 2);
      MA.nodeField(node, 'wBitsPerSample', st.bitDepth, body + 14, 2);
      if (st.ratePerSec && st.ratePerSec > 0) {
        // In AVI audio streams dwRate/dwScale give the sample rate.
        st.sampleRate = st.ratePerSec;
        MA.nodeField(node, 'sample rate (from strh)', st.sampleRate, body, 0);
      }
      st.durationSec = st.sampleRate > 0 && st.frameCount ? st.frameCount / st.sampleRate : null;
    } else if (st.kind === 'video' && size >= 40) {
      // BITMAPINFOHEADER
      var biSize = readU32(data, body);
      var w = readI32(data, body + 4);
      var h = readI32(data, body + 8);
      var bitCount = readU16(data, body + 14);
      var compression = fourcc(data, body + 16);
      st.width = w; st.height = Math.abs(h);
      st.bitDepth = bitCount;
      st.codec = compression === 'H264' ? 'h264' : compression === 'XVID' || compression === 'DIVX' ? 'mpeg4'
               : compression === 'MJPG' ? 'mjpeg' : (compression || 'rgb');
      st.codecName = aviVideoCodecName(compression);
      MA.nodeField(node, 'biSize', biSize, body, 4);
      MA.nodeField(node, 'biWidth', w, body + 4, 4);
      MA.nodeField(node, 'biHeight', h + (h < 0 ? ' (top-down)' : ''), body + 8, 4);
      MA.nodeField(node, 'biPlanes', readU16(data, body + 12), body + 12, 2);
      MA.nodeField(node, 'biBitCount', bitCount, body + 14, 2);
      MA.nodeField(node, 'biCompression', "'" + compression + "' (" + st.codecName + ')', body + 16, 4);
      MA.nodeField(node, 'biSizeImage', readU32(data, body + 20), body + 20, 4);
      MA.nodeField(node, 'biXPelsPerMeter', readI32(data, body + 24), body + 24, 4);
      MA.nodeField(node, 'biYPelsPerMeter', readI32(data, body + 28), body + 28, 4);
      MA.nodeField(node, 'biClrUsed', readU32(data, body + 32), body + 32, 4);
      MA.nodeField(node, 'biClrImportant', readU32(data, body + 36), body + 36, 4);
    } else {
      MA.nodeNote(node, 'Unrecognised stream format (' + size + ' bytes).');
    }
    st.durationSec = st.durationSec || (st.fps > 0 && st.frameCount ? st.frameCount / st.fps : null);
    if (st.durationSec && st.bytes) st.bitrate = Math.round(st.bytes * 8 / st.durationSec);
  }

  function aviVideoCodecName(cc) {
    var m = {
      'DIB ': 'Uncompressed RGB', 'RGB ': 'Uncompressed RGB', 'MJPG': 'Motion JPEG',
      'H264': 'H.264 / AVC', 'XVID': 'MPEG-4 ASP (Xvid)', 'DIVX': 'MPEG-4 ASP (DivX)',
      'DX50': 'MPEG-4 ASP (DivX 5)', 'MP42': 'MPEG-4 v2', 'MP43': 'MPEG-4 v3',
      'MP4V': 'MPEG-4 Visual', 'VP80': 'VP8', 'VP90': 'VP9', 'AV01': 'AV1',
      'HFYU': 'HuffYUV', 'LAGS': 'Lagarith', 'FFV1': 'FFV1', 'CVID': 'Cinepak',
      'IV50': 'Indeo 5', 'SVQ3': 'Sorenson 3', 'WMV3': 'Windows Media 9'
    };
    return m[cc] || ('FourCC "' + cc + '"');
  }

  /** Collect the movi chunk list. AVI chunk ids encode "<stream><type>". */
  function collectMovi(data, start, end, parentNode, out) {
    var p = start, guard = 0;
    while (p + 8 <= end && ++guard < MAX_CHUNKS * 4) {
      var id = fourcc(data, p);
      var size = readU32(data, p + 4);
      var body = p + 8;

      if (id === 'LIST') {
        // Nested rec  lists group chunks but do not change the numbering.
        var sub = fourcc(data, body);
        var subEnd = Math.min(end, body + size);
        var subNode = MA.makeNode('list', sub, listName(sub) || sub, p, 8 + size);
        parentNode.children.push(subNode);
        if (sub === 'rec ') {
          collectMovi(data, body + 4, subEnd, subNode, out);
        } else if (sub === 'movi') {
          collectMovi(data, body + 4, subEnd, subNode, out);
        }
        p = body + size + (size & 1);
        continue;
      }
      if (body + size > end) break;

      if (/^\d\d(..)$/.test(id)) {
        var streamNumber = parseInt(id.slice(0, 2), 10);
        out.push({ id: id, streamNumber: streamNumber, offset: body, size: size });
        if (out.length <= MAX_ROWS) {
          var n = MA.makeNode('chunk', id, 'stream ' + streamNumber + ' chunk', p, 8 + size);
          MA.nodeField(n, 'ckID', "'" + id + "'", p, 4);
          MA.nodeField(n, 'ckSize', size, p + 4, 4);
          parentNode.children.push(n);
        }
      }
      p = body + size + (size & 1);
      if (out.length >= MAX_AVI_FRAMES * 2) break;
    }
  }

  MA.registerParser({ id: 'wav', name: 'WAVE', extensions: ['wav', 'wave'], parse: parseWav });
  MA.registerParser({ id: 'avi', name: 'AVI', extensions: ['avi'], parse: parseAvi });
})(typeof globalThis !== 'undefined' ? globalThis : this);
