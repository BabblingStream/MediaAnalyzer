/* ============================================================================
 * MediaAnalyzer — parsers/ogg.js
 *
 * Ogg container — RFC 3533 encapsulation with the Xiph codec mappings.
 *
 *   - page loop with capture pattern validation and forward resynchronisation
 *   - packet assembly: a segment of 255 bytes means "the packet continues",
 *     anything below terminates it, and an open packet is carried into the
 *     next page of the same logical stream (the continued flag)
 *   - codec sniffing from the BOS packet: Vorbis, Opus, FLAC, Theora, Speex,
 *     Skeleton, plus the comment/setup headers that follow
 *   - one frame per completed packet, PTS derived from the page granule
 *
 * The result follows the container contract of js/util.js. Frames never keep
 * the payload: a packet held inside a single page carries a lazy `syn` recipe
 * ({codec, kind, offset, size, lengthSize, annexB, ctxKey}) that the app
 * resolves later through MA.buildFrameSyntax(). A packet that spans pages has
 * no contiguous file range, so it carries a small eager table that lists its
 * fragments instead. Only the few header packets get eager `tables`.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField;
  var synSection = MA.synSection, hex = MA.hex, safeCount = MA.safeCount;

  /* ------------------------------------------------------------- limits */

  var MAX_FRAMES = 200000;            // hard cap on frames per stream
  var MAX_PAGES = 2000000;            // iteration guard for the page loop
  var MAX_PAGE_NODES = 20000;         // structure tree nodes for pages
  var MAX_HEADER_PACKET = 4 * 1024 * 1024;   // a bigger header is not assembled
  var MAX_PACKET_FRAGMENTS = 4096;    // a packet split over more pages is dropped

  var PAGE_HEADER = 27;               // fixed part of an Ogg page header

  /* ==========================================================================
   * Little endian readers — Ogg is little endian throughout
   * ========================================================================*/

  function u16le(d, o) { return d[o] | (d[o + 1] << 8); }
  function u32le(d, o) {
    return (d[o] | (d[o + 1] << 8) | (d[o + 2] << 16) | (d[o + 3] << 24)) >>> 0;
  }
  function i32le(d, o) {
    var v = u32le(d, o);
    return v > 0x7fffffff ? v - 0x100000000 : v;
  }
  /** 64 bit granule position; the high word is signed (pages use -1 = "none"). */
  function i64le(d, o) { return u32le(d, o) + i32le(d, o + 4) * 4294967296; }

  function str(d, s, e, utf8) {
    if (e <= s) return '';
    try {
      if (utf8) return new TextDecoder('utf-8').decode(d.subarray(s, e)).replace(/\0+$/, '');
      var out = '';
      for (var i = s; i < e; i++) {
        var c = d[i];
        out += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      return out;
    } catch (err) { return ''; }
  }

  function hasTag(d, s, t) {
    if (s + t.length > d.length) return false;
    for (var i = 0; i < t.length; i++) if (d[s + i] !== t[i]) return false;
    return true;
  }

  function msg(e) { return String((e && e.message) || e); }

  /** Copy the packet's fragments into one buffer (header packets only). */
  function concat(data, pieces) {
    var total = 0, i;
    for (i = 0; i < pieces.length; i++) total += pieces[i].size;
    var buf = new Uint8Array(total), off = 0;
    for (i = 0; i < pieces.length; i++) {
      buf.set(data.subarray(pieces[i].offset, pieces[i].offset + pieces[i].size), off);
      off += pieces[i].size;
    }
    return buf;
  }

  function packetSize(pieces) {
    var t = 0;
    for (var i = 0; i < pieces.length; i++) t += pieces[i].size;
    return t;
  }

  /* ==========================================================================
   * Codec identification headers
   *
   * Each builder takes the assembled packet plus its absolute file offset and
   * returns { codec, codecName, kind, headerCount, table, info, fields } — or
   * null when the packet belongs to another codec. Row offsets are base + i.
   * ========================================================================*/

  function row(name, syntax, bits, value, note, offset, depth) {
    return { name: name, syntax: syntax, bits: bits, value: value,
             note: note || '', offset: offset, depth: depth || 0 };
  }

  var VORBIS_BLOCKS = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

  /** 0x01 "vorbis" — identification header (Vorbis I §4.2.2). */
  function vorbisId(buf, base) {
    if (buf.length < 30) return null;
    if (buf[0] !== 0x01 || !hasTag(buf, 1, [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])) return null;
    var rows = [];
    rows.push(row('packet_type', 'u(8)', 8, buf[0], '0x01 = identification header', base));
    rows.push(row('vorbis_magic', 'bytes(6)', 48, 'vorbis', '', base + 1));
    var ver = u32le(buf, 7);
    rows.push(row('vorbis_version', 'u(32) le', 32, ver, ver === 0 ? '' : 'must be 0', base + 7));
    var channels = buf[11];
    rows.push(row('audio_channels', 'u(8)', 8, channels, MA.formatChannels(channels), base + 11));
    var rate = u32le(buf, 12);
    rows.push(row('audio_sample_rate', 'u(32) le', 32, rate, MA.formatHz(rate), base + 12));
    var bitMax = i32le(buf, 16), bitNom = i32le(buf, 20), bitMin = i32le(buf, 24);
    rows.push(row('bitrate_maximum', 'i(32) le', 32, bitMax, bitMax > 0 ? MA.formatBitrate(bitMax) : 'unset', base + 16));
    rows.push(row('bitrate_nominal', 'i(32) le', 32, bitNom, bitNom > 0 ? MA.formatBitrate(bitNom) : 'unset', base + 20));
    rows.push(row('bitrate_minimum', 'i(32) le', 32, bitMin, bitMin > 0 ? MA.formatBitrate(bitMin) : 'unset', base + 24));
    var bs = buf[28];
    rows.push(row('blocksize_0', 'u(4)', 4, (bs >> 4) & 0x0f,
      'short window 2^' + ((bs >> 4) & 0x0f) + ' = ' + (VORBIS_BLOCKS[(bs >> 4) & 0x0f] || '?') + ' samples', base + 28));
    rows.push(row('blocksize_1', 'u(4)', 4, bs & 0x0f,
      'long window 2^' + (bs & 0x0f) + ' = ' + (VORBIS_BLOCKS[bs & 0x0f] || '?') + ' samples', base + 28));
    rows.push(row('framing_flag', 'u(1)', 1, buf[29] & 1, (buf[29] & 1) ? 'must be 1' : 'invalid', base + 29));
    return {
      codec: 'vorbis', codecName: 'Vorbis', kind: 'audio', headerCount: 3,
      table: synSection('Vorbis identification header',
        'Vorbis I §4.2.2 — ' + buf.length + ' bytes', rows),
      info: {
        sampleRate: rate, channels: channels,
        blocksize0: VORBIS_BLOCKS[(bs >> 4) & 0x0f], blocksize1: VORBIS_BLOCKS[bs & 0x0f],
        bitrateNominal: bitNom > 0 ? bitNom : null,
        bitrateMax: bitMax > 0 ? bitMax : null,
        bitrateMin: bitMin > 0 ? bitMin : null
      },
      fields: [['Codec', 'Vorbis (Xiph)'], ['Sample rate', MA.formatHz(rate)],
               ['Channels', MA.formatChannels(channels)],
               ['Blocksizes', VORBIS_BLOCKS[(bs >> 4) & 0x0f] + ' / ' + VORBIS_BLOCKS[bs & 0x0f] + ' samples'],
               ['Nominal bitrate', bitNom > 0 ? MA.formatBitrate(bitNom) : '(unset)']]
    };
  }

  /** 0x03 "vorbis" — comment header. */
  function vorbisComment(buf, base) {
    if (buf.length < 7) return null;
    if (buf[0] !== 0x03 || !hasTag(buf, 1, [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])) return null;
    var rows = [];
    rows.push(row('packet_type', 'u(8)', 8, buf[0], '0x03 = comment header', base));
    rows.push(row('vorbis_magic', 'bytes(6)', 48, 'vorbis', '', base + 1));
    var p = 7, vendor = '', comments = [];
    var vendorLen = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 1);
    rows.push(row('vendor_length', 'u(32) le', 32, vendorLen, '', base + p));
    p += 4;
    vendor = str(buf, p, Math.min(p + vendorLen, buf.length), true);
    rows.push(row('vendor_string', 'utf8(' + vendorLen + ')', vendorLen * 8, vendor, '', base + p));
    p += vendorLen;
    if (p + 4 <= buf.length) {
      var count = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 4);
      rows.push(row('user_comment_list_length', 'u(32) le', 32, count, '', base + p));
      p += 4;
      for (var i = 0; i < count && p + 4 <= buf.length; i++) {
        var len = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 1);
        var off = p;
        p += 4;
        var text = str(buf, p, Math.min(p + len, buf.length), true);
        rows.push(row('comment[' + i + ']', 'utf8(' + len + ')', len * 8, text, '', base + off));
        if (text) comments.push(text);
        p += len;
      }
    }
    return {
      table: synSection('Vorbis comment header',
        'vendor: ' + vendor + ' — ' + comments.length + ' comment(s)', rows),
      vendor: vendor, comments: comments
    };
  }

  /** 0x05 "vorbis" — setup header (codebooks, floors, residues, mappings, modes). */
  function vorbisSetup(buf, base) {
    if (buf.length < 7) return null;
    if (buf[0] !== 0x05 || !hasTag(buf, 1, [0x76, 0x6f, 0x72, 0x62, 0x69, 0x73])) return null;
    return {
      table: synSection('Vorbis setup header',
        'Vorbis I §4.2.4 — ' + buf.length + ' bytes', [
          row('codebooks / floors / residues / mappings / modes', '', buf.length * 8,
            buf.length + ' bytes', 'codebook and mode tables — not decoded', base)
        ])
    };
  }

  var VORBIS_LAYOUT = { 1: 'mono', 2: 'stereo', 3: '2.1', 4: 'quad', 5: '5.0',
                        6: '5.1 (Vorbis order)', 7: '6.1', 8: '7.1 (Vorbis order)' };

  /** "OpusHead" — RFC 7845 §5.1. */
  function opusHead(buf, base) {
    if (buf.length < 19 || !hasTag(buf, 0, [0x4F, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64])) return null;
    var rows = [];
    rows.push(row('magic', 'bytes(8)', 64, 'OpusHead', '', base));
    var version = buf[8];
    rows.push(row('version', 'u(8)', 8, version, version > 15 ? 'invalid (top 4 bits must be 0)' : '', base + 8));
    var channels = buf[9];
    rows.push(row('channelCount', 'u(8)', 8, channels, MA.formatChannels(channels), base + 9));
    var preSkip = u16le(buf, 10);
    rows.push(row('preSkip', 'u(16) le', 16, preSkip,
      (preSkip / 48000 * 1000).toFixed(2) + ' ms at 48 kHz — subtracted from every granule', base + 10));
    var inputRate = u32le(buf, 12);
    rows.push(row('inputSampleRate', 'u(32) le', 32, inputRate,
      'the original rate; playback is ALWAYS 48000 Hz', base + 12));
    var raw = u16le(buf, 16);
    var gain = (raw > 0x7fff ? raw - 0x10000 : raw) / 256;
    rows.push(row('outputGain', 'i(16) le', 16, gain.toFixed(2) + ' dB', 'Q7.8 fixed point gain', base + 16));
    var family = buf[18];
    rows.push(row('channelMappingFamily', 'u(8)', 8, family,
      family === 0 ? 'mono/stereo (stream count implied)' : 'streams listed; Vorbis channel order', base + 18));
    var info = { sampleRate: 48000, channels: channels, preSkip: preSkip,
                 inputSampleRate: inputRate, gain: gain, mappingFamily: family };
    if (family !== 0 && buf.length >= 21) {
      info.streamCount = buf[19];
      info.coupledCount = buf[20];
      rows.push(row('streamCount', 'u(8)', 8, buf[19], '', base + 19));
      rows.push(row('coupledCount', 'u(8)', 8, buf[20], '', base + 20));
      var n = safeCount(channels, Math.max(0, buf.length - 21), 1);
      var map = [];
      for (var i = 0; i < n; i++) {
        map.push(buf[21 + i]);
        rows.push(row('channelMapping[' + i + ']', 'u(8)', 8, buf[21 + i], '', base + 21 + i));
      }
      info.channelMapping = map.join(' ');
    }
    return {
      codec: 'opus', codecName: 'Opus', kind: 'audio', headerCount: 2,
      table: synSection('OpusHead', 'RFC 7845 §5.1 — ' + buf.length + ' bytes', rows),
      info: info,
      fields: [['Codec', 'Opus'], ['Channels', MA.formatChannels(channels)],
               ['Playback sample rate', '48000 Hz'],
               ['Input sample rate', inputRate ? MA.formatHz(inputRate) : '(unset)'],
               ['Pre-skip', preSkip + ' samples (' + (preSkip / 480).toFixed(2) + ' ms)'],
               ['Channel mapping family', family]]
    };
  }

  /** "OpusTags" — RFC 7845 §5.2. */
  function opusTags(buf, base) {
    if (buf.length < 12 || !hasTag(buf, 0, [0x4F, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73])) return null;
    var rows = [row('magic', 'bytes(8)', 64, 'OpusTags', '', base)];
    var p = 8, comments = [];
    var vendorLen = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 1);
    rows.push(row('vendor_length', 'u(32) le', 32, vendorLen, '', base + p));
    p += 4;
    var vendor = str(buf, p, Math.min(p + vendorLen, buf.length), true);
    rows.push(row('vendor_string', 'utf8(' + vendorLen + ')', vendorLen * 8, vendor, '', base + p));
    p += vendorLen;
    if (p + 4 <= buf.length) {
      var count = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 4);
      rows.push(row('user_comment_list_length', 'u(32) le', 32, count, '', base + p));
      p += 4;
      for (var i = 0; i < count && p + 4 <= buf.length; i++) {
        var len = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 1);
        var off = p;
        p += 4;
        var text = str(buf, p, Math.min(p + len, buf.length), true);
        rows.push(row('comment[' + i + ']', 'utf8(' + len + ')', len * 8, text, '', base + off));
        if (text) comments.push(text);
        p += len;
      }
    }
    return {
      table: synSection('OpusTags', 'vendor: ' + vendor + ' — ' + comments.length + ' comment(s)', rows),
      vendor: vendor, comments: comments
    };
  }

  /** 0x7F "FLAC" — the BOS packet carries the STREAMINFO block. */
  function flacHeader(buf, base) {
    if (buf.length < 13 || buf[0] !== 0x7f || !hasTag(buf, 1, [0x46, 0x4C, 0x41, 0x43])) return null;
    var rows = [row('packet_type', 'u(8)', 8, buf[0], '0x7F = Ogg FLAC mapping header', base),
                row('flac_magic', 'bytes(4)', 32, 'FLAC', '', base + 1)];
    rows.push(row('mapping_version_major', 'u(8)', 8, buf[5], '', base + 5));
    rows.push(row('mapping_version_minor', 'u(8)', 8, buf[6], '', base + 6));
    var nHeaders = u16le(buf, 7);
    rows.push(row('n_header_packets', 'u(16) be', 16, nHeaders,
      'metadata packets that follow this one', base + 7));
    rows.push(row('native_flac_magic', 'bytes(4)', 32, str(buf, 9, 13, false),
      'the embedded "fLaC" marker', base + 9));
    var p = 13, blocks = 0, info = {};
    while (p + 4 <= buf.length && blocks < 64) {
      var b = buf[p];
      var last = (b & 0x80) !== 0, type = b & 0x7f;
      var len = (buf[p + 1] << 16) | (buf[p + 2] << 8) | buf[p + 3];
      rows.push(row('metadata_block_header[' + blocks + ']', 'u(8) u(24)', 32,
        (last ? 'last ' : '') + flacBlockName(type), 'length ' + len, base + p));
      p += 4;
      if (p + len > buf.length) len = buf.length - p;
      if (type === 0 && len >= 34) info = flacStreamInfo(buf, p, info, rows, base);
      p += len;
      blocks++;
      if (last) break;
    }
    return {
      codec: 'flac', codecName: 'FLAC', kind: 'audio', headerCount: 1 + Math.max(1, blocks),
      table: synSection('FLAC header', 'Ogg FLAC mapping — ' + buf.length + ' bytes', rows),
      info: info,
      fields: [['Codec', 'FLAC (Ogg FLAC mapping)'],
               ['Sample rate', info.sampleRate ? MA.formatHz(info.sampleRate) : '(unknown)'],
               ['Channels', info.channels ? MA.formatChannels(info.channels) : '(unknown)'],
               ['Bits per sample', info.bitDepth ? info.bitDepth + ' bit' : '(unknown)'],
               ['Total samples', info.totalSamples != null ? info.totalSamples : '(unknown)']]
    };
  }

  function flacBlockName(t) {
    return { 0: 'STREAMINFO', 1: 'PADDING', 2: 'APPLICATION', 3: 'SEEKTABLE',
             4: 'VORBIS_COMMENT', 5: 'CUESHEET', 6: 'PICTURE' }[t] || ('type ' + t);
  }

  /** 34 byte FLAC STREAMINFO body (FLAC format §8.2). */
  function flacStreamInfo(buf, s, info, rows, base) {
    var minBlock = (buf[s] << 8) | buf[s + 1];
    var maxBlock = (buf[s + 2] << 8) | buf[s + 3];
    var minFrame = (buf[s + 4] << 16) | (buf[s + 5] << 8) | buf[s + 6];
    var maxFrame = (buf[s + 7] << 16) | (buf[s + 8] << 8) | buf[s + 9];
    rows.push(row('minBlockSize', 'u(16)', 16, minBlock, '', base + s));
    rows.push(row('maxBlockSize', 'u(16)', 16, maxBlock, '', base + s + 2));
    rows.push(row('minFrameSize', 'u(24)', 24, minFrame, '', base + s + 4));
    rows.push(row('maxFrameSize', 'u(24)', 24, maxFrame, '', base + s + 7));
    var b = s + 10;
    var samplesPerBlock = 0;
    void samplesPerBlock;
    var sampleRate = (buf[b] << 12) | (buf[b + 1] << 4) | (buf[b + 2] >> 4);
    var channels = ((buf[b + 2] >> 1) & 0x07) + 1;
    var bits = (((buf[b + 2] & 0x01) << 4) | (buf[b + 3] >> 4)) + 1;
    var total = (buf[b + 3] & 0x0f) * 4294967296 + u32le(buf, b + 4);
    rows.push(row('sampleRate', 'u(20)', 20, sampleRate, MA.formatHz(sampleRate), base + b));
    rows.push(row('channels', 'u(3)', 3, channels - 1,
      MA.formatChannels(channels) + ' (stored as n-1)', base + b + 2));
    rows.push(row('bitsPerSample', 'u(5)', 5, bits - 1, bits + ' bit (stored as n-1)', base + b + 2));
    rows.push(row('totalSamples', 'u(36)', 36, total, '', base + b + 3));
    var md5 = '';
    for (var i = 0; i < 16; i++) md5 += (buf[b + 8 + i] < 16 ? '0' : '') + buf[b + 8 + i].toString(16);
    rows.push(row('MD5', 'u(128)', 128, md5.toUpperCase(), 'MD5 of the unencoded audio', base + b + 8));
    return { sampleRate: sampleRate, channels: channels, bitDepth: bits, totalSamples: total,
             minBlockSize: minBlock, maxBlockSize: maxBlock };
  }

  /** A FLAC metadata packet that follows the STREAMINFO one (VORBIS_COMMENT). */
  function flacComment(buf, base) {
    if (buf.length < 4) return null;
    var b = buf[0], type = b & 0x7f;
    var len = (buf[1] << 16) | (buf[2] << 8) | buf[3];
    var rows = [row('metadata_block_header', 'u(8) u(24)', 32,
      ((b & 0x80) ? 'last ' : '') + flacBlockName(type), 'length ' + len, base)];
    var vendor = '', comments = [];
    if (type === 4 && buf.length >= 8) {
      var p = 4;
      var vlen = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 1);
      rows.push(row('vendor_length', 'u(32) le', 32, vlen, '', base + p));
      p += 4;
      vendor = str(buf, p, Math.min(p + vlen, buf.length), true);
      rows.push(row('vendor_string', 'utf8(' + vlen + ')', vlen * 8, vendor, '', base + p));
      p += vlen;
      if (p + 4 <= buf.length) {
        var count = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 4);
        rows.push(row('user_comment_list_length', 'u(32) le', 32, count, '', base + p));
        p += 4;
        for (var i = 0; i < count && p + 4 <= buf.length; i++) {
          var cl = safeCount(u32le(buf, p), Math.max(0, buf.length - p - 4), 1);
          var off = p;
          p += 4;
          var text = str(buf, p, Math.min(p + cl, buf.length), true);
          rows.push(row('comment[' + i + ']', 'utf8(' + cl + ')', cl * 8, text, '', base + off));
          if (text) comments.push(text);
          p += cl;
        }
      }
    } else {
      rows.push(row('block', '', len * 8, len + ' bytes', 'not decoded', base + 4));
    }
    return {
      table: synSection('FLAC ' + flacBlockName(type),
        'vendor: ' + vendor + ' — ' + comments.length + ' comment(s)', rows),
      vendor: vendor, comments: comments
    };
  }

  /** 0x80 "theora" — identification header (Theora I §6.2). */
  function theoraHeader(buf, base) {
    if (buf.length < 42 || buf[0] !== 0x80 ||
        !hasTag(buf, 1, [0x74, 0x68, 0x65, 0x6f, 0x72, 0x61])) return null;
    var rows = [];
    rows.push(row('packet_type', 'u(8)', 8, buf[0], '0x80 = Theora header packet', base));
    rows.push(row('theora_magic', 'bytes(6)', 48, 'theora', '', base + 1));
    rows.push(row('VMAJ', 'u(8)', 8, buf[7], 'bitstream version major', base + 7));
    rows.push(row('VMIN', 'u(8)', 8, buf[8], 'bitstream version minor', base + 8));
    rows.push(row('VREV', 'u(8)', 8, buf[9], 'bitstream version revision', base + 9));
    var fmbw = (buf[10] << 8) | buf[11];
    var fmbh = (buf[12] << 8) | buf[13];
    rows.push(row('FMBW', 'u(16) be', 16, fmbw, 'frame width in 16 pixel units = ' + (fmbw * 16) + ' px', base + 10));
    rows.push(row('FMBH', 'u(16) be', 16, fmbh, 'frame height in 16 pixel units = ' + (fmbh * 16) + ' px', base + 12));
    var picw = (buf[14] << 16) | (buf[15] << 8) | buf[16];
    var pich = (buf[17] << 16) | (buf[18] << 8) | buf[19];
    rows.push(row('PICW', 'u(24) be', 24, picw, 'picture width = ' + picw + ' px', base + 14));
    rows.push(row('PICH', 'u(24) be', 24, pich, 'picture height = ' + pich + ' px', base + 17));
    rows.push(row('PICX', 'u(8)', 8, buf[20], 'picture x offset', base + 20));
    rows.push(row('PICY', 'u(8)', 8, buf[21], 'picture y offset', base + 21));
    var frn = u32le(buf, 22), frd = u32le(buf, 26);
    rows.push(row('FRN', 'u(32) be', 32, frn, 'frame rate numerator', base + 22));
    rows.push(row('FRD', 'u(32) be', 32, frd, 'frame rate denominator', base + 26));
    var fps = frd > 0 ? frn / frd : 0;
    rows.push(row('PARN', 'u(24) be', 24, (buf[30] << 16) | (buf[31] << 8) | buf[32], 'pixel aspect numerator', base + 30));
    rows.push(row('PARD', 'u(24) be', 24, (buf[33] << 16) | (buf[34] << 8) | buf[35], 'pixel aspect denominator', base + 33));
    var cs = buf[36];
    rows.push(row('CS', 'u(8)', 8, cs & 0x0f, 'granule position shift = ' + (cs & 0x0f) + ' bits', base + 36));
    var nombr = (buf[37] << 16) | (buf[38] << 8) | buf[39];
    rows.push(row('NOMBR', 'u(24) be', 24, nombr, 'nominal bitrate ' + MA.formatBitrate(nombr), base + 37));
    var q = buf[40] | (buf[41] << 8);
    rows.push(row('QUAL', 'u(6)', 6, (q >> 10) & 0x3f, 'nominal quality', base + 40));
    rows.push(row('KFGSHIFT', 'u(5)', 5, (q >> 5) & 0x1f, 'keyframe granule shift', base + 40));
    rows.push(row('PF', 'u(2)', 2, q & 0x03, 'pixel format', base + 40));
    return {
      codec: 'theora', codecName: 'Theora', kind: 'video', headerCount: 3,
      table: synSection('Theora identification header',
        'Theora I §6.2 — ' + buf.length + ' bytes', rows),
      info: { width: picw, height: pich, fps: fps, frameWidth: fmbw * 16,
              frameHeight: fmbh * 16, granuleShift: cs & 0x0f, nominalBitrate: nombr },
      fields: [['Codec', 'Theora'], ['Picture size', picw + ' x ' + pich],
               ['Frame size (macro blocks)', fmbw + ' x ' + fmbh + ' (16 px units)'],
               ['Frame rate', fps ? MA.formatFps(fps) + ' (' + frn + '/' + frd + ')' : '(unknown)'],
               ['Pixel aspect',
                ((buf[30] << 16) | (buf[31] << 8) | buf[32]) + ':' +
                ((buf[33] << 16) | (buf[34] << 8) | buf[35])]]
    };
  }

  /** "Speex   " — Speex header (RFC 5574 §2.1). */
  function speexHeader(buf, base) {
    if (buf.length < 80 || !hasTag(buf, 0, [0x53, 0x70, 0x65, 0x65, 0x78, 0x20, 0x20, 0x20])) return null;
    var rows = [row('speex_string', 'bytes(8)', 64, 'Speex   ', '', base)];
    var ver = str(buf, 8, 28, false);
    rows.push(row('speex_version', 'bytes(20)', 160, ver, '', base + 8));
    rows.push(row('speex_version_id', 'u(32) le', 32, u32le(buf, 28), '', base + 28));
    var headerSize = u32le(buf, 32);
    rows.push(row('header_size', 'u(32) le', 32, headerSize, 'bytes in this header', base + 32));
    var rate = u32le(buf, 36);
    rows.push(row('rate', 'u(32) le', 32, rate, MA.formatHz(rate), base + 36));
    var mode = u32le(buf, 40);
    rows.push(row('mode', 'u(32) le', 32, mode,
      ['narrowband', 'wideband', 'ultra-wideband'][mode] || '', base + 40));
    rows.push(row('mode_bitstream_version', 'u(32) le', 32, u32le(buf, 44), '', base + 44));
    var channels = u32le(buf, 48);
    rows.push(row('nb_channels', 'u(32) le', 32, channels, MA.formatChannels(channels), base + 48));
    var bitrate = i32le(buf, 52);
    rows.push(row('bitrate', 'i(32) le', 32, bitrate, bitrate > 0 ? MA.formatBitrate(bitrate) : 'unset', base + 52));
    var frameSize = u32le(buf, 56);
    rows.push(row('frame_size', 'u(32) le', 32, frameSize, 'samples per frame', base + 56));
    var vbr = u32le(buf, 60);
    rows.push(row('vbr', 'u(32) le', 32, vbr, vbr ? 'VBR' : 'CBR', base + 60));
    rows.push(row('frames_per_packet', 'u(32) le', 32, u32le(buf, 64), '', base + 64));
    var extra = u32le(buf, 68);
    rows.push(row('extra_headers', 'u(32) le', 32, extra, 'additional header packets', base + 68));
    rows.push(row('reserved1', 'u(32) le', 32, u32le(buf, 72), '', base + 72));
    rows.push(row('reserved2', 'u(32) le', 32, u32le(buf, 76), '', base + 76));
    var headers = safeCount(extra, Math.max(0, buf.length), 1);
    return {
      codec: 'speex', codecName: 'Speex', kind: 'audio', headerCount: 2 + headers,
      table: synSection('Speex header', 'RFC 5574 §2.1 — ' + buf.length + ' bytes', rows),
      info: { sampleRate: rate || 8000, channels: channels, frameSize: frameSize,
              bitrate: bitrate > 0 ? bitrate : null, extraHeaders: extra },
      fields: [['Codec', 'Speex'], ['Version', ver], ['Sample rate', MA.formatHz(rate)],
               ['Channels', MA.formatChannels(channels)],
               ['Mode', ['narrowband', 'wideband', 'ultra-wideband'][mode] || String(mode)],
               ['Bitrate', bitrate > 0 ? MA.formatBitrate(bitrate) : '(unset)'],
               ['Extra headers', extra]]
    };
  }

  /** "fishead\0" / "fisbone\0" — Skeleton, used to describe multiplexed streams. */
  function skeletonHeader(buf, base) {
    if (buf.length < 8 || !hasTag(buf, 0, [0x66, 0x69, 0x73])) return null;
    var isHead = hasTag(buf, 0, [0x66, 0x69, 0x73, 0x68, 0x65, 0x61, 0x64, 0x00]);
    var isBone = hasTag(buf, 0, [0x66, 0x69, 0x73, 0x62, 0x6f, 0x6e, 0x65, 0x00]);
    if (!isHead && !isBone) return null;
    var rows = [row('magic', 'bytes(8)', 64, isHead ? 'fishead' : 'fisbone', '', base)];
    if (isHead && buf.length >= 64) {
      rows.push(row('version_major', 'u(16) le', 16, u16le(buf, 8), '', base + 8));
      rows.push(row('version_minor', 'u(16) le', 16, u16le(buf, 10), '', base + 10));
      rows.push(row('presentationtime', 'i(64) le', 64, i64le(buf, 12), '', base + 12));
      rows.push(row('basetime', 'i(64) le', 64, i64le(buf, 20), '', base + 20));
      rows.push(row('UTC', 'i(64) le', 64, i64le(buf, 44), 'nanoseconds since 2000-01-01', base + 44));
    }
    return {
      codec: 'skeleton', codecName: 'Skeleton', kind: 'other', headerCount: 1,
      table: synSection('Skeleton header', 'Skeleton (Xiph) — ' + buf.length + ' bytes', rows),
      info: {},
      fields: [['Codec', 'Skeleton'], ['Kind', isHead ? 'fishead' : 'fisbone']]
    };
  }

  var BUILDERS = [vorbisId, opusHead, flacHeader, theoraHeader, speexHeader, skeletonHeader];

  /** Identify the codec of a BOS packet; null when nothing matches. */
  function identify(buf, base) {
    for (var i = 0; i < BUILDERS.length; i++) {
      try {
        var r = BUILDERS[i](buf, base);
        if (r) return r;
      } catch (e) { /* try the next candidate */ }
    }
    return null;
  }

  /** A follow-up header packet of an already identified stream. */
  function parseHeaderPacket(state, buf, base) {
    try {
      if (state.codec === 'vorbis') {
        return vorbisComment(buf, base) || vorbisSetup(buf, base);
      }
      if (state.codec === 'opus') return opusTags(buf, base);
      if (state.codec === 'flac') return flacComment(buf, base);
    } catch (e) {
      return {
        table: synSection('Header packet', 'could not be parsed: ' + msg(e),
          [row('packet', '', buf.length * 8, buf.length + ' bytes', 'raw header packet', base)])
      };
    }
    return null;
  }

  /* ==========================================================================
   * parse()
   * ========================================================================*/

  function parse(ctx) {
    var data = ctx.data;
    var size = data ? data.length : 0;
    var result = {
      formatId: 'ogg',
      formatName: 'Ogg',
      durationSec: null,
      bitrate: null,
      tracks: [],
      metadata: [],
      structures: [],
      frames: [],
      notes: [],
      codecContexts: {}
    };

    function note(text) { result.notes.push(text); }

    if (!data || size < PAGE_HEADER) {
      note('File is too small to contain an Ogg page.');
      return result;
    }

    var frames = result.frames;
    var streams = {};                 // serial -> stream state
    var order = [];                   // streams in BOS order
    var p = 0, pages = 0, pageNodes = 0, resynced = false, truncated = false;
    var pagesNode = makeNode('group', 'pages', 'Ogg pages', 0, 0);

    while (p + PAGE_HEADER <= size && pages < MAX_PAGES) {
      /* ---- a real page starts with "OggS" and version 0 ---- */
      if (!(data[p] === 0x4F && data[p + 1] === 0x67 && data[p + 2] === 0x67 &&
            data[p + 3] === 0x53 && data[p + 4] === 0)) {
        var np = findCapture(data, p + 1);
        if (np < 0) {
          if (pages) {
            note((size - p) + ' trailing byte(s) at ' + hex(p, 8) + ' are not an Ogg page.');
          }
          break;
        }
        if (!resynced) {
          resynced = true;
          note('Resynchronised at ' + hex(np, 8) + ' (' + (np - p) +
            ' byte(s) that are not a page header).');
        }
        p = np;
        continue;
      }

      var headerType = data[p + 5];
      var granule = i64le(data, p + 6);
      var serial = u32le(data, p + 14);
      var seq = u32le(data, p + 18);
      var crc = u32le(data, p + 22);
      var nSeg = data[p + 26];
      if (p + PAGE_HEADER + nSeg > size) {
        note('Page at ' + hex(p, 8) + ' is truncated inside its segment table.');
        truncated = true;
        break;
      }
      var payloadStart = p + PAGE_HEADER + nSeg;
      var payloadLen = 0;
      for (var s = 0; s < nSeg; s++) payloadLen += data[p + PAGE_HEADER + s];
      var pageEnd = payloadStart + payloadLen;
      if (pageEnd > size) {
        note('Page at ' + hex(p, 8) + ' declares ' + payloadLen +
          ' payload byte(s) but the file ends after ' + (size - payloadStart) +
          ' — the last page is truncated.');
        pageEnd = size;
        truncated = true;
      }

      var isBOS = (headerType & 0x02) !== 0;
      var isEOS = (headerType & 0x04) !== 0;
      var isCont = (headerType & 0x01) !== 0;

      /* ---- structure node for the page ---- */
      if (pageNodes < MAX_PAGE_NODES) {
        var pn = makeNode('page', 'OggS',
          'Page ' + seq + ' @ ' + hex(p, 8) + ' (serial ' + serial + ')', p, pageEnd - p);
        nodeField(pn, 'Capture pattern', 'OggS', p, 4);
        nodeField(pn, 'Version', data[p + 4], p + 4, 1);
        nodeField(pn, 'Header type',
          ((isCont ? 'continued' : '') + (isBOS ? ' BOS' : '') + (isEOS ? ' EOS' : '')).trim() ||
          '0x00 (normal)', p + 5, 1);
        nodeField(pn, 'Granule position', granule < 0 ? '(none)' : granule, p + 6, 8);
        nodeField(pn, 'Serial number', serial, p + 14, 4);
        nodeField(pn, 'Page sequence', seq, p + 18, 4);
        nodeField(pn, 'CRC checksum', hex(crc, 8), p + 22, 4);
        nodeField(pn, 'Page segments', nSeg, p + 26, 1);
        if (nSeg) nodeField(pn, 'Segment table', segmentTableText(data, p + PAGE_HEADER, nSeg),
          p + PAGE_HEADER, nSeg);
        nodeField(pn, 'Payload', MA.formatSize(payloadLen), payloadStart, Math.min(payloadLen, 64));
        pagesNode.children.push(pn);
        pageNodes++;
      } else if (pageNodes === MAX_PAGE_NODES) {
        pageNodes++;
        note('The structure tree lists the first ' + MAX_PAGE_NODES +
          ' pages only — packet extraction continues to the end of the file.');
      }

      /* ---- packet assembly for this logical stream ---- */
      var state = streams[serial];
      if (!state) {
        state = streams[serial] = newStream(serial);
        state.order = order.length;
        order.push(state);
      }

      var pieces;
      if (isCont) {
        pieces = (state.carry && state.carry.length) ? state.carry : [];
        if (!pieces.length) {
          note('Page ' + seq + ' (serial ' + serial + ') is flagged "continued" but the ' +
            'start of that packet was never seen — the first packet of the page is dropped.');
        }
      } else {
        if (state.carry && state.carry.length) {
          note('Page ' + seq + ' (serial ' + serial + ') is not flagged "continued" but a ' +
            'packet was still open — that unterminated packet is dropped.');
        }
        pieces = [];
      }
      state.carry = [];

      var completed = [];
      var seg = payloadStart;
      for (var i = 0; i < nSeg; i++) {
        var l = data[p + PAGE_HEADER + i];
        if (pieces.length < MAX_PACKET_FRAGMENTS) {
          pieces.push({ offset: seg, size: Math.min(l, pageEnd - seg) });
        }
        seg += l;
        if (l < 255) { completed.push(pieces); pieces = []; }
      }
      state.carry = pieces;

      /* ---- granule -> PTS for the packets that complete on this page ---- */
      var n = completed.length;
      if (n > 0 && granule >= 0) {
        var prev = state.lastGranule == null ? 0 : state.lastGranule;
        var step = (granule - prev) / n;          // granule units per packet
        for (var k = 0; k < n; k++) {
          handlePacket(data, state, completed[k], granule - (n - 1 - k) * step, step, note);
        }
        state.lastGranule = granule;
      } else {
        for (var k2 = 0; k2 < n; k2++) handlePacket(data, state, completed[k2], null, 0, note);
        if (granule >= 0) state.lastGranule = granule;
      }

      state.pages++;
      if (isEOS) state.eos = true;
      p = pageEnd;
      pages++;
    }

    if (pages >= MAX_PAGES) note('The page loop stopped after ' + MAX_PAGES + ' pages.');

    var dangling = 0;
    for (var si = 0; si < order.length; si++) {
      if (order[si].carry && order[si].carry.length) dangling++;
    }
    if (dangling) {
      note(dangling + ' stream(s) end with a packet that was never terminated ' +
        '(truncated file or a lost page).');
    }
    for (var u = 0; u < order.length; u++) {
      var us = order[u];
      if (!us.codec) {
        note('Serial ' + us.serial + ' starts with ' +
          (us.firstMagic ? '"' + us.firstMagic + '"' : ('a ' + us.firstSize + ' byte packet')) +
          ' — not a known Ogg codec header.');
      }
    }

    if (pagesNode.children.length) result.structures.push(pagesNode);
    finishStreams(data, order, result, note);

    /* ---- frames in file order ---- */
    frames.sort(function (a, b) {
      return (a.offset - b.offset) || ((a.ptsSec || 0) - (b.ptsSec || 0));
    });
    for (var fi = 0; fi < frames.length; fi++) frames[fi].index = fi;

    result.metadata.unshift({ key: 'Pages', value: pages });
    result.metadata.unshift({ key: 'Logical streams', value: order.length });
    if (truncated) note('The file appears to be truncated.');

    if (!pages) note(formatHint(data));
    else if (!frames.length) note('No media packets could be assembled from the pages.');

    result.bitrate = (result.durationSec > 0) ? Math.round(size * 8 / result.durationSec) : null;
    if (result.durationSec == null && frames.length)
      note('Duration could not be derived — no page carried a usable granule position.');
    return result;
  }

  /** A short printable snippet so a renamed file of another type explains itself. */
  function formatHint(data) {
    var head = str(data, 0, Math.min(200, data.length), true).trim();
    if (/^<\?xml/i.test(head) || /^<(!doctype|html)/i.test(head)) {
      return 'This is not an Ogg stream — the file starts with markup text: "' +
        head.replace(/\s+/g, ' ').slice(0, 120) + '"';
    }
    return 'No Ogg page ("OggS" with version 0) was found in the file.';
  }

  function segmentTableText(data, off, n) {
    var out = [], max = Math.min(n, 24);
    for (var i = 0; i < max; i++) out.push(data[off + i]);
    return out.join(',') + (n > max ? ',… (' + n + ' segments)' : '');
  }

  /** Scan forward for the next "OggS"; -1 when there is none. */
  function findCapture(data, from) {
    var last = data.length - 4;
    var p = from;
    while (p <= last) {
      p = data.indexOf(0x4F, p);              // 'O' of "OggS"
      if (p < 0 || p > last) return -1;
      if (data[p + 1] === 0x67 && data[p + 2] === 0x67 && data[p + 3] === 0x53) return p;
      p++;
    }
    return -1;
  }

  /* ==========================================================================
   * Per stream state and packet handling
   * ========================================================================*/

  function newStream(serial) {
    return {
      serial: serial, order: 0,
      codec: null, codecName: '', kind: 'other', headerCount: 1,
      sampleRate: 0, channels: 0, preSkip: 0, info: null, idFields: null,
      vendor: '', comments: [],
      pages: 0, packets: 0, headersSeen: 0, headerDone: false,
      dataPackets: 0, bytes: 0, frameCount: 0, carry: [], eos: false,
      lastGranule: null, lastEnd: null, headerFiles: [], headerFrames: 0,
      firstMagic: '', firstSize: 0, frames: [], lastKey: true
    };
  }

  /** One completed packet: a header frame while headers are pending, else media. */
  function handlePacket(data, state, pieces, granule, stepGranule, note) {
    if (!pieces.length) return;
    var total = packetSize(pieces);
    var first = pieces[0].offset;
    state.packets++;

    /* ---- first packet of the logical stream identifies the codec ---- */
    if (!state.codec && !state.headerDone) {
      state.firstSize = total;
      if (total > 0 && total <= MAX_HEADER_PACKET) {
        var buf = concat(data, pieces);
        state.firstMagic = str(buf, 0, Math.min(8, total), false);
        var id = identify(buf, first);
        if (id) {
          state.codec = id.codec;
          state.codecName = id.codecName;
          state.kind = id.kind;
          state.headerCount = Math.max(1, id.headerCount || 1);
          state.info = id.info || {};
          state.idFields = id.fields || null;
          state.sampleRate = (id.info && id.info.sampleRate) || 0;
          state.channels = (id.info && id.info.channels) || 0;
          state.preSkip = (id.info && id.info.preSkip) || 0;
          addHeaderFrame(state, pieces, 'Identification header', id.table, first, total);
          state.headersSeen = 1;
          state.headerDone = state.headersSeen >= state.headerCount;
          return;
        }
      }
      // Not recognised: keep the file analysable, show the packet as it is.
      state.codec = 'unknown';
      state.codecName = 'Unknown Ogg stream';
      state.kind = 'other';
      state.headerCount = 1;
      addRawHeaderFrame(state, pieces, 'First packet (unrecognised)', first, total);
      state.headerDone = true;
      return;
    }

    /* ---- the remaining header packets ---- */
    if (!state.headerDone) {
      var label = headerLabel(state, state.headersSeen);
      var hdr = (total <= MAX_HEADER_PACKET) ? parseHeaderPacket(state, concat(data, pieces), first) : null;
      if (hdr) {
        if (hdr.vendor) state.vendor = hdr.vendor;
        if (hdr.comments && hdr.comments.length) state.comments = hdr.comments;
        addHeaderFrame(state, pieces, label, hdr.table, first, total);
      } else {
        addRawHeaderFrame(state, pieces, label, first, total);
      }
      state.headersSeen++;
      if (state.headersSeen >= state.headerCount) state.headerDone = true;
      return;
    }

    /* ---- media packet ---- */
    if (!total) { state.dataPackets++; return; }        // empty packet (Theora EOS marker)
    if (state.frameCount >= MAX_FRAMES) {
      if (!state.frameCapNoted) {
        state.frameCapNoted = true;
        note('Frame list truncated at ' + MAX_FRAMES + ' packets for serial ' + state.serial + '.');
      }
      return;
    }

    var pts = null, dur = null, rate = state.sampleRate || 48000;
    if (state.kind === 'video') {
      // A Theora granule encodes the distance to the previous keyframe, not a
      // plain frame number, so the timeline is rebuilt from the frame rate.
      if (state.info && state.info.fps > 0) {
        pts = state.frameCount / state.info.fps;
        dur = 1 / state.info.fps;
      }
    } else if (state.kind === 'audio' && granule != null) {
      pts = (granule - (state.preSkip || 0)) / rate;
      if (stepGranule > 0) dur = stepGranule / rate;
    }

    var frame = {
      track: state.serial,
      index: 0,
      type: state.kind === 'video' ? (state.lastKey ? 'I' : 'P')
          : (state.kind === 'audio' ? 'audio' : 'packet'),
      kind: state.kind === 'video' ? 'video' : (state.kind === 'audio' ? 'audio' : 'other'),
      codec: state.codec,
      offset: first,
      size: total,
      ptsSec: pts,
      dtsSec: pts,
      keyframe: state.kind === 'video' ? state.lastKey : true,
      label: pieces.length > 1 ? ('packet over ' + pieces.length + ' page fragments') : undefined
    };
    if (dur != null && isFinite(dur) && dur > 0) frame.durationSec = dur;

    if (state.kind === 'video' && total > 0) {
      // Theora data packet: bit 7 set = data, bit 6 = 0 for a keyframe.
      var b0 = data[first];
      if (b0 & 0x80) {
        frame.keyframe = (b0 & 0x40) === 0;
        frame.type = frame.keyframe ? 'I' : 'P';
      }
      state.lastKey = frame.keyframe;
    }

    if (pieces.length === 1) {
      frame.syn = {
        codec: state.codec, kind: 'sample', offset: first, size: total,
        lengthSize: 0, annexB: false, ctxKey: null
      };
    } else {
      // Several page fragments: there is no single contiguous file range, so
      // hand out the fragment list instead of a range that would be wrong.
      var rows = [];
      for (var i = 0; i < pieces.length; i++) {
        rows.push(row('fragment[' + i + ']', '', pieces[i].size * 8, pieces[i].size + ' bytes',
          'page fragment', pieces[i].offset));
      }
      frame.tables = [synSection('Packet',
        'assembled from ' + pieces.length + ' page fragments, ' + total + ' bytes', rows)];
    }

    state.frames.push(frame);
    state.dataPackets++;
    state.bytes += total;
    state.frameCount++;
    if (pts != null) {
      var end = pts + (frame.durationSec || 0);
      if (state.lastEnd == null || end > state.lastEnd) state.lastEnd = end;
    }
  }

  function headerLabel(state, seen) {
    if (state.codec === 'vorbis') return seen === 1 ? 'Comment header' : 'Setup header';
    if (state.codec === 'theora') return seen === 1 ? 'Comment header' : 'Setup header';
    if (state.codec === 'opus') return 'OpusTags';
    if (state.codec === 'speex') return 'Comment header';
    if (state.codec === 'flac') return 'Metadata packet';
    return 'Header packet';
  }

  function addHeaderFrame(state, pieces, label, table, offset, total) {
    if (!table) { addRawHeaderFrame(state, pieces, label, offset, total); return; }
    state.frames.push({
      track: state.serial, index: 0, type: 'header', kind: 'header',
      codec: state.codec, offset: offset, size: total,
      ptsSec: 0, dtsSec: 0, keyframe: true, label: label, tables: [table]
    });
    state.headerFiles.push(table);
    state.headerFrames++;
  }

  function addRawHeaderFrame(state, pieces, label, offset, total) {
    var rows = [];
    for (var i = 0; i < pieces.length && i < 8; i++) {
      rows.push(row('fragment[' + i + ']', '', pieces[i].size * 8, pieces[i].size + ' bytes',
        '', pieces[i].offset));
    }
    rows.push(row('packet', '', total * 8, total + ' bytes', 'header packet', offset));
    state.frames.push({
      track: state.serial, index: 0, type: 'header', kind: 'header',
      codec: state.codec || 'unknown', offset: offset, size: total,
      ptsSec: 0, dtsSec: 0, keyframe: true, label: label,
      tables: [synSection(label, total + ' bytes — not decoded', rows)]
    });
    state.headerFrames++;
  }

  /* ---- per stream: structure node, track object, duration ---- */
  function finishStreams(data, order, result, note) {
    for (var i = 0; i < order.length; i++) {
      var s = order[i];

      // hand the stream's frames (headers first, then media) to the result
      for (var f = 0; f < s.frames.length; f++) result.frames.push(s.frames[f]);

      var node = makeNode('stream', 'stream',
        'Stream ' + (i + 1) + ' — ' + (s.codecName || 'unknown') + ' (serial ' + s.serial + ')',
        s.frames.length ? s.frames[0].offset : 0, 0);
      nodeField(node, 'Serial number', s.serial, 0, 0);
      nodeField(node, 'Pages', s.pages, 0, 0);
      nodeField(node, 'Packets', s.packets + ' (' + s.dataPackets + ' media)', 0, 0);
      if (s.idFields) {
        for (var d = 0; d < s.idFields.length; d++)
          nodeField(node, s.idFields[d][0], s.idFields[d][1], s.frames.length ? s.frames[0].offset : 0, 0);
      }
      if (s.vendor) nodeField(node, 'Vendor', s.vendor, 0, 0);
      for (var c = 0; c < s.comments.length && c < 16; c++)
        nodeField(node, 'Comment', s.comments[c], 0, 0);
      for (var h = 0; h < s.headerFiles.length; h++)
        nodeField(node, 'Header packet ' + (h + 1), s.headerFiles[h].title, 0, 0);
      if (s.eos) nodeField(node, 'EOS', 'last page of the stream seen', 0, 0);
      result.structures.push(node);

      if (!s.codec || s.codec === 'unknown') continue;

      var duration = null;
      if (s.kind === 'video') {
        if (s.info && s.info.fps > 0) duration = s.frameCount / s.info.fps;
      } else if (s.lastGranule != null && s.sampleRate) {
        duration = (s.lastGranule - (s.preSkip || 0)) / s.sampleRate;
      }
      if (!(duration > 0)) duration = null;

      var track = {
        id: s.serial,
        type: s.kind === 'video' ? 'video' : (s.kind === 'audio' ? 'audio' : 'other'),
        codec: s.codec,
        codecName: s.codecName,
        profile: null,
        level: null,
        width: s.kind === 'video' && s.info ? (s.info.width || null) : null,
        height: s.kind === 'video' && s.info ? (s.info.height || null) : null,
        fps: s.kind === 'video' && s.info && s.info.fps ? s.info.fps : null,
        sampleRate: s.kind === 'video' ? null : (s.sampleRate || null),
        channels: s.kind === 'video' ? null : (s.channels || null),
        channelLayout: null,
        bitDepth: s.info && s.info.bitDepth ? s.info.bitDepth : null,
        durationSec: duration,
        bitrate: null,
        sampleCount: s.dataPackets,
        language: '',
        handlerName: s.vendor || '',
        extra: []
      };
      if (track.channels) {
        track.channelLayout = (s.codec === 'opus' && s.info && s.info.mappingFamily)
          ? (VORBIS_LAYOUT[track.channels] || (track.channels + ' channels (Vorbis order)'))
          : (track.channels === 1 ? 'mono' : track.channels === 2 ? 'stereo'
             : track.channels + ' channels');
      }
      if (duration > 0 && s.bytes) track.bitrate = Math.round(s.bytes * 8 / duration);
      else if (s.info && s.info.bitrateNominal) track.bitrate = s.info.bitrateNominal;
      else if (s.info && s.info.bitrate) track.bitrate = s.info.bitrate;

      var ex = track.extra;
      ex.push({ label: 'Serial number', value: s.serial + ' (0x' + hex(s.serial, 8) + ')' });
      ex.push({ label: 'Logical stream', value: '#' + (i + 1) + ' of ' + order.length });
      ex.push({ label: 'Pages', value: s.pages });
      ex.push({ label: 'Packets', value: s.packets + ' (' + s.dataPackets + ' media, ' +
        s.headerFrames + ' header)' });
      ex.push({ label: 'Payload bytes', value: MA.formatSize(s.bytes) });
      if (s.vendor) ex.push({ label: 'Vendor', value: s.vendor });
      for (var cc = 0; cc < s.comments.length && cc < 24; cc++)
        ex.push({ label: 'Comment', value: s.comments[cc] });

      if (s.codec === 'opus') {
        ex.push({ label: 'Playback sample rate', value: '48000 Hz — Opus is always decoded at 48 kHz' });
        if (s.info && s.info.inputSampleRate)
          ex.push({ label: 'Input sample rate', value: MA.formatHz(s.info.inputSampleRate) });
        if (s.preSkip) ex.push({ label: 'Pre-skip', value: s.preSkip + ' samples (' +
          (s.preSkip / 480).toFixed(2) + ' ms) subtracted from every granule' });
        if (s.info && s.info.mappingFamily != null)
          ex.push({ label: 'Channel mapping family', value: s.info.mappingFamily +
            (s.info.channelMapping ? ' (map ' + s.info.channelMapping + ')' : '') });
        if (s.info && s.info.gain)
          ex.push({ label: 'Output gain', value: s.info.gain.toFixed(2) + ' dB' });
      }
      if (s.codec === 'vorbis' && s.info) {
        if (s.info.blocksize0)
          ex.push({ label: 'Blocksizes', value: s.info.blocksize0 + ' / ' + s.info.blocksize1 + ' samples' });
        if (s.info.bitrateNominal) ex.push({ label: 'Nominal bitrate', value: MA.formatBitrate(s.info.bitrateNominal) });
        if (s.info.bitrateMax) ex.push({ label: 'Maximum bitrate', value: MA.formatBitrate(s.info.bitrateMax) });
        if (s.info.bitrateMin) ex.push({ label: 'Minimum bitrate', value: MA.formatBitrate(s.info.bitrateMin) });
      }
      if (s.codec === 'theora' && s.info) {
        if (s.info.frameWidth)
          ex.push({ label: 'Frame size (macro blocks)', value: s.info.frameWidth + ' x ' + s.info.frameHeight });
        if (s.info.nominalBitrate)
          ex.push({ label: 'Nominal bitrate', value: MA.formatBitrate(s.info.nominalBitrate) });
        ex.push({ label: 'Timestamps', value: 'rebuilt from the frame rate — a Theora granule encodes ' +
          'the keyframe distance, not a frame number' });
      }
      if (s.codec === 'speex' && s.info) {
        if (s.info.frameSize) ex.push({ label: 'Frame size', value: s.info.frameSize + ' samples' });
        if (s.info.extraHeaders) ex.push({ label: 'Extra headers', value: s.info.extraHeaders });
      }
      if (s.codec === 'flac' && s.info) {
        if (s.info.totalSamples != null) ex.push({ label: 'Total samples', value: s.info.totalSamples });
        if (s.info.minBlockSize)
          ex.push({ label: 'Blocksize', value: s.info.minBlockSize + '…' + s.info.maxBlockSize + ' samples' });
      }
      if (s.carry && s.carry.length)
        ex.push({ label: 'Unterminated packet', value: s.carry.length + ' fragment(s) at end of file' });

      result.tracks.push(track);
      if (duration != null && (result.durationSec == null || duration > result.durationSec))
        result.durationSec = duration;
      result.metadata.push({ key: 'Stream ' + (i + 1), value: s.codecName +
        ' (serial ' + s.serial + ')' });
      if (s.sampleRate) result.metadata.push({ key: 'Stream ' + (i + 1) + ' sample rate', value: MA.formatHz(s.sampleRate) });
      if (s.channels) result.metadata.push({ key: 'Stream ' + (i + 1) + ' channels', value: MA.formatChannels(s.channels) });
    }

    var names = [];
    for (var n2 = 0; n2 < order.length; n2++) {
      if (order[n2].codec && order[n2].codec !== 'unknown') names.push(order[n2].codecName);
    }
    if (names.length) result.formatName = 'Ogg (' + names.join(' + ') + ')';

    for (var v = 0; v < order.length; v++) {
      if (order[v].vendor) { result.metadata.push({ key: 'Vendor', value: order[v].vendor }); break; }
    }
    for (var w = 0; w < order.length; w++) {
      for (var q = 0; q < order[w].comments.length; q++) {
        var text = order[w].comments[q];
        var eq = text.indexOf('=');
        result.metadata.push(eq > 0
          ? { key: text.slice(0, eq), value: text.slice(eq + 1) }
          : { key: 'Comment', value: text });
      }
    }
  }

  MA.registerParser({ id: 'ogg', name: 'Ogg', parse: parse });
})(typeof globalThis !== 'undefined' ? globalThis : this);
