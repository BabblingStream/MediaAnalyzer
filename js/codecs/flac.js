/* ============================================================================
 * MediaAnalyzer — codecs/flac.js
 *
 * FLAC — Free Lossless Audio Codec, syntax per RFC 9639 (and the original
 * xiph.org format description it was derived from).
 *
 *   metadata block header      §8.1
 *   STREAMINFO                 §8.2
 *   PADDING / APPLICATION / SEEKTABLE / VORBIS_COMMENT / CUESHEET / PICTURE
 *   audio frame header         §9.1
 *   subframe header            §9.2
 *
 * Every parsed structure is emitted as a syntax table whose rows mirror the
 * spec text (field / syntax / bits / value / meaning), so the panel can show
 * exactly what the bitstream says. `offset` on a row is the absolute file
 * offset the element starts in, which is what the hex view links to; a row
 * with offset -1 has no byte to point at.
 *
 * `base` arguments are always "absolute file offset of data[0]" (pass the file
 * buffer and the true offset of its first byte, or a sub-buffer with the
 * absolute offset of that sub-buffer's first byte). Default is 0, which is
 * correct whenever the whole file is passed in.
 *
 * Entry points
 *   parseStreamInfo(block, base)                 34-byte STREAMINFO payload
 *   parseMetadataBlockHeader(data, off, base)    one 4-byte block header
 *   parseVorbisComment(block, base, start, end)
 *   parseSeekTable / parseCueSheet / parsePicture
 *   parseFrameHeader(data, off, base)            one frame header (+ CRC-8)
 *   parseFrame(data, off, end, ctx)              frame + first subframe header
 *   analyzeStream(data, ctx)                     whole .flac file
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, synSection = MA.synSection, BitReader = MA.BitReader;

  /* ---------------------------------------------------------------- tables */

  /** Metadata block types — RFC 9639 §8.1 (type 127 is forbidden by the spec). */
  var BLOCK_TYPES = {
    0: 'STREAMINFO', 1: 'PADDING', 2: 'APPLICATION', 3: 'SEEKTABLE',
    4: 'VORBIS_COMMENT', 5: 'CUESHEET', 6: 'PICTURE', 127: 'INVALID'
  };
  function blockTypeName(t) {
    if (BLOCK_TYPES[t]) return BLOCK_TYPES[t];
    return (t >= 7 && t <= 126) ? 'RESERVED' : 'INVALID';
  }

  /** RFC 9639 §9.1.2 — block size code. 6/7 read the real size at the header end. */
  var BLOCK_SIZE_CODES = {
    0: 'reserved',
    1: '192 samples', 2: '576 samples', 3: '1152 samples', 4: '2304 samples',
    5: '4608 samples', 6: '8-bit (blocksize-1) at end of header',
    7: '16-bit (blocksize-1) at end of header',
    8: '256 samples', 9: '512 samples', 10: '1024 samples', 11: '2048 samples',
    12: '4096 samples', 13: '8192 samples', 14: '16384 samples', 15: '32768 samples'
  };

  /** RFC 9639 §9.1.3 — sample rate code. 0 = STREAMINFO, 12/13/14 read at the end. */
  var SAMPLE_RATE_CODES = {
    0: 'from STREAMINFO',
    1: '88.2 kHz', 2: '176.4 kHz', 3: '192 kHz', 4: '8 kHz', 5: '16 kHz',
    6: '22.05 kHz', 7: '24 kHz', 8: '32 kHz', 9: '44.1 kHz', 10: '48 kHz',
    11: '96 kHz',
    12: '8-bit sample rate in kHz at end of header',
    13: '16-bit sample rate in Hz at end of header',
    14: '16-bit sample rate in tens of Hz at end of header',
    15: 'invalid (reserved, prevents sync-fooling)'
  };
  var SAMPLE_RATE_VALUES = {
    1: 88200, 2: 176400, 3: 192000, 4: 8000, 5: 16000, 6: 22050,
    7: 24000, 8: 32000, 9: 44100, 10: 48000, 11: 96000
  };

  /** RFC 9639 §9.1.4 — channel assignment. */
  var CHANNEL_ASSIGN = {
    8: 'left/side stereo (ch0 = left, ch1 = side)',
    9: 'right/side stereo (ch0 = side, ch1 = right)',
    10: 'mid/side stereo (ch0 = mid, ch1 = side)'
  };
  function channelAssignName(v) {
    if (v <= 7) return (v + 1) + ' independent channel' + (v ? 's' : '');
    return CHANNEL_ASSIGN[v] || 'reserved';
  }

  /** RFC 9639 §9.1.5 — sample size code (12 and 32 bit were added by the RFC). */
  var SAMPLE_SIZE_CODES = {
    0: 'from STREAMINFO', 1: '8 bits', 2: '12 bits', 3: 'reserved',
    4: '16 bits', 5: '20 bits', 6: '24 bits', 7: '32 bits'
  };
  var SAMPLE_SIZE_VALUES = { 1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32 };

  /** APIC / METADATA_BLOCK_PICTURE picture types. */
  var PICTURE_TYPES = [
    'Other', '32x32 pixels PNG icon', 'Other icon', 'Front cover', 'Back cover',
    'Leaflet', 'Media (e.g. label side)', 'Lead artist/performer/soloist',
    'Artist/performer', 'Conductor', 'Band/orchestra', 'Composer', 'Lyricist/text writer',
    'Recording location', 'During recording', 'During performance',
    'Movie/video screen capture', 'A bright coloured fish', 'Illustration',
    'Band/artist logotype', 'Publisher/studio logotype'
  ];

  /* Caps — a corrupt count must never be able to spin the parser. */
  var MAX_METADATA_BLOCKS = 256;
  var MAX_FRAMES = 200000;
  var MAX_FRAME_SCAN = 4 << 20;      // bytes searched for the next frame sync
  var MAX_COMMENTS = 512;
  var MAX_SEEK_POINTS = 512;
  var MAX_CUESHEET_TRACKS = 256;
  var MAX_CUESHEET_INDICES = 64;
  var SYNTAX_FRAME_LIMIT = 2;        // first N frames also get their syntax table

  /**
   * SyntaxReader over a byte range, with emulation-prevention removal disabled.
   * The EPB rule only exists inside H.26x RBSPs; leaving it on (the default)
   * would silently swallow 00 00 03 sequences in FLAC payloads and shift every
   * following row offset. `base` is the absolute file offset of data[0].
   */
  function reader(data, offset, length, base) {
    return new SR(data, {
      offset: offset || 0,
      length: length,
      epb: false,
      base: (base || 0) + (offset || 0)   // SyntaxReader wants the offset of its own byte 0
    });
  }

  /**
   * Record a field wider than 32 bits (total_samples is 36, seek points 64).
   * MA.BitReader.uLong() cannot be used on a SyntaxReader — it re-enters the
   * recording u() with a number where a field name belongs — so the halves are
   * read straight from the raw BitReader and recorded as one spec-shaped row.
   * Exact to 2^53, which no real FLAC field reaches (the 64-bit fields hold
   * 36-bit values).
   */
  function readWide(r, name, bits, note) {
    var before = r.bitPos();
    var v;
    if (bits <= 32) {
      v = BitReader.prototype.u.call(r, bits);
    } else {
      var hi = BitReader.prototype.u.call(r, bits - 32);
      var lo = BitReader.prototype.u.call(r, 32);
      v = hi * 0x100000000 + lo;
    }
    r.rows.push({
      name: name, syntax: 'u(' + bits + ')', bits: bits, value: v, note: note || '',
      offset: r.base + Math.floor(before / 8), depth: r.depth
    });
    return v;
  }

  /* ------------------------------------------------------------- CRC helper */

  var CRC8_TABLE = (function () {
    var t = new Uint8Array(256);
    for (var i = 0; i < 256; i++) {
      var c = i;
      for (var b = 0; b < 8; b++) c = (c & 0x80) ? (((c << 1) ^ 0x07) & 0xff) : ((c << 1) & 0xff);
      t[i] = c;
    }
    return t;
  })();

  /** CRC-8 (x^8 + x^2 + x^1 + x^0), initialised with 0 — RFC 9639 §9.1.7. */
  function crc8(data, start, end) {
    var c = 0;
    for (var i = start; i < end && i < data.length; i++) c = CRC8_TABLE[c ^ data[i]];
    return c;
  }

  /* ======================================================================
   * Metadata block header — RFC 9639 §8.1
   * ====================================================================*/

  /**
   * @param {Uint8Array} data full buffer (or a buffer starting at `off`)
   * @param {number} off  index of the header's first byte inside `data`
   * @param {number} base absolute file offset of data[0]
   * @returns {{table, info, isLast, type, length}}
   */
  function parseMetadataBlockHeader(data, off, base) {
    off = off || 0;
    var out = { table: null, info: { offset: off }, isLast: false, type: 0, length: 0, error: null };
    if (off + 4 > data.length) {
      out.error = 'truncated metadata block header';
      out.table = synSection('METADATA_BLOCK_HEADER', out.error, []);
      return out;
    }
    var r = reader(data, off, 4, base);
    var info = out.info;
    try {
      var isLast = r.flag('last_metadata_block_flag', '1 = last block before the audio frames');
      var type = r.u('block_type', 7);
      r.note(type + ' = ' + blockTypeName(type) +
        (type === 127 ? ' — forbidden by RFC 9639' : ''));
      if (type === 0) r.note('STREAMINFO — must be the first block and exactly 34 bytes');
      var length = r.u('metadata_block_length', 24, 'block body length in bytes');
      var absOff = (base || 0) + off;
      info.isLast = !!isLast;
      info.type = type;
      info.typeName = blockTypeName(type);
      info.length = length;
      info.bodyOffset = absOff + 4;
      info.bodyEnd = absOff + 4 + length;
      info.truncated = info.bodyEnd > ((base || 0) + data.length);
      out.isLast = !!isLast;
      out.type = type;
      out.length = length;
      out.table = synSection('METADATA_BLOCK_HEADER',
        blockTypeName(type) + (isLast ? ' (last), ' : ', ') + length + ' bytes', r.rows);
      return out;
    } catch (e) {
      out.error = String(e && e.message || e);
      out.table = synSection('METADATA_BLOCK_HEADER', 'partial — parse error', r.rows);
      return out;
    }
  }

  /* ======================================================================
   * STREAMINFO — RFC 9639 §8.2
   * ====================================================================*/

  /**
   * @param {Uint8Array} block the 34-byte STREAMINFO payload
   * @param {number} base  absolute file offset of block[0]
   * @returns {{table, rows, info}}
   */
  function parseStreamInfo(block, base) {
    base = base || 0;
    var r = reader(block, 0, Math.min(block.length, 34), base);
    var info = { offset: base };
    try {
      info.minBlockSize = r.u('min_block_size', 16, 'samples — must be >= 16');
      info.maxBlockSize = r.u('max_block_size', 16, 'samples — must be >= 16');
      info.minFrameSize = r.u('min_frame_size', 24, 'bytes — 0 = unknown, else >= 16');
      info.maxFrameSize = r.u('max_frame_size', 24, 'bytes — 0 = unknown, else >= 16');
      info.sampleRate = r.u('sample_rate', 20, '0 = unknown, the frame header carries it');
      r.note(info.sampleRate ? MA.formatHz(info.sampleRate) : 'unknown (0)');
      var chMinus1 = r.u('channels_minus1', 3);
      info.channels = chMinus1 + 1;
      r.note((chMinus1 + 1) + ' channel' + (chMinus1 ? 's' : ' (value 0 means 1 channel)'));
      var bpsMinus1 = r.u('bits_per_sample_minus1', 5);
      info.bitsPerSample = bpsMinus1 + 1;
      r.note((bpsMinus1 + 1) + ' bits/sample' +
        (bpsMinus1 + 1 < 4 ? ' — invalid, RFC 9639 requires >= 4' : ''));
      info.totalSamples = readWide(r, 'total_samples', 36, '0 = unknown');
      r.note(info.totalSamples ? info.totalSamples + ' samples' : 'unknown (0)');

      // MD5: 16 bytes, reported as a lowercase hex string for comparison.
      var md5RowIndex = r.rows.length;
      r.bytes('md5', 16, 'MD5 of the unencoded audio data (all zero = not computed)');
      var md5 = '';
      for (var i = 0; i < 16; i++) {
        var b = (18 + i < block.length) ? block[18 + i] : 0;
        md5 += (b < 16 ? '0' : '') + b.toString(16);
      }
      info.md5 = md5;
      if (r.rows[md5RowIndex]) {
        r.rows[md5RowIndex].value = md5;
        r.rows[md5RowIndex].note = /^0+$/.test(md5)
          ? 'MD5 of the unencoded audio data (not computed by the encoder)'
          : 'MD5 of the unencoded audio data';
      }

      info.durationSec = (info.sampleRate > 0 && info.totalSamples > 0)
        ? info.totalSamples / info.sampleRate : null;

      // ---- conformance notes (RFC 9639 §8.2) ----
      var notes = [];
      if (info.minBlockSize < 16) notes.push('min_block_size < 16 is invalid');
      if (info.maxBlockSize < 16) notes.push('max_block_size < 16 is invalid');
      if (info.minBlockSize > info.maxBlockSize) notes.push('min_block_size > max_block_size');
      if (info.minFrameSize !== 0 && info.minFrameSize < 16) notes.push('min_frame_size < 16 is invalid');
      if (info.maxFrameSize !== 0 && info.maxFrameSize < 16) notes.push('max_frame_size < 16 is invalid');
      if (info.bitsPerSample < 4) notes.push('bits_per_sample < 4 is invalid');
      if (info.minFrameSize > info.maxFrameSize) notes.push('min_frame_size > max_frame_size');
      info.conformanceNotes = notes;

      return {
        table: synSection('STREAMINFO',
          MA.formatHz(info.sampleRate) + ', ' + info.channels + ' ch, ' +
          info.bitsPerSample + ' bits, ' +
          (info.durationSec != null ? MA.formatDuration(info.durationSec) : 'length unknown'),
          r.rows),
        rows: r.rows,
        info: info
      };
    } catch (e) {
      return {
        table: synSection('STREAMINFO', 'partial — parse error', r.rows),
        rows: r.rows,
        info: info,
        error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * VORBIS_COMMENT — RFC 9639 §8.6 (little endian, inherited from Vorbis I)
   * ====================================================================*/

  /**
   * @param {Uint8Array} block buffer holding the block body
   * @param {number} base  absolute file offset of block[0]
   * @param {number} start offset of the block body inside `block`
   * @param {number} end   offset one past the block body
   * @returns {{table, rows, info}}
   */
  function parseVorbisComment(block, base, start, end) {
    base = base || 0;
    start = start || 0;
    end = end == null ? block.length : Math.min(end, block.length);
    var r = reader(block, start, Math.max(0, end - start), base);
    var info = { vendor: '', comments: [], metadata: {} };
    try {
      var vendorLen = r.ule('vendor_length', 4, 'little endian');
      var avail = Math.max(0, end - start - 8);
      if (vendorLen > avail) {
        r.note('vendor_length exceeds the block — clamped');
        vendorLen = avail;
      }
      var vendorStart = r.bytePos();
      info.vendor = latin1OrUtf8(block, vendorStart, vendorStart + vendorLen);
      r.skip(vendorLen * 8);
      r.rows.push({
        name: 'vendor_string', syntax: 'bytes(' + vendorLen + ')',
        bits: vendorLen * 8, value: truncate(info.vendor, 120),
        note: 'encoding application identification', offset: base + vendorStart, depth: r.depth
      });

      var count = r.ule('user_comment_list_length', 4, 'little endian');
      // Each comment needs at least its 4 length bytes, which bounds the count.
      var maxCount = Math.floor(Math.max(0, end - r.bytePos()) / 4);
      if (count > maxCount) {
        r.note('comment count ' + count + ' exceeds the block — clamped to ' + maxCount);
        count = maxCount;
      }
      var listed = 0;
      for (var i = 0; i < count && i < MAX_COMMENTS; i++) {
        var len = r.ule('comment[' + i + '].length', 4, 'little endian');
        var cStart = r.bytePos();
        if (cStart + len > end) {
          r.note('comment runs past the end of the block — stopped');
          break;
        }
        var text = latin1OrUtf8(block, cStart, cStart + len);
        var eq = text.indexOf('=');
        var key = eq > 0 ? text.slice(0, eq).toUpperCase() : '';
        var val = eq > 0 ? text.slice(eq + 1) : text;
        r.rows.push({
          name: 'comment[' + i + ']', syntax: 'bytes(' + len + ')', bits: len * 8,
          value: truncate(text, 160),
          note: eq > 0 ? key + ' = ' + truncate(val, 80) : 'no "=" separator',
          offset: base + cStart, depth: r.depth
        });
        r.skip(len * 8);
        listed++;
        if (key) {
          info.comments.push({ key: key, value: val });
          info.metadata[key] = val;
        }
      }
      info.commentCount = count;
      info.listedComments = listed;
      if (count > MAX_COMMENTS) info.commentCapReached = true;

      return {
        table: synSection('VORBIS_COMMENT',
          listed + ' of ' + count + ' comments, vendor "' + truncate(info.vendor, 48) + '"',
          r.rows),
        rows: r.rows,
        info: info
      };
    } catch (e) {
      return {
        table: synSection('VORBIS_COMMENT', 'partial — parse error', r.rows),
        rows: r.rows,
        info: info,
        error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * SEEKTABLE — RFC 9639 §8.5
   * ====================================================================*/

  /** 18 bytes per point: sample_number u(64), stream_offset u(64), frame_samples u(16). */
  function parseSeekTable(block, base, start, end) {
    base = base || 0;
    start = start || 0;
    end = end == null ? block.length : Math.min(end, block.length);
    var r = reader(block, start, Math.max(0, end - start), base);
    var info = { entries: [] };
    try {
      var total = Math.floor(Math.max(0, end - start) / 18);
      var count = Math.min(total, MAX_SEEK_POINTS);
      for (var i = 0; i < count; i++) {
        var sample = readWide(r, 'seek_point[' + i + '].sample_number', 64,
          'all ones = a placeholder point');
        var offset = readWide(r, 'seek_point[' + i + '].stream_offset', 64,
          'byte offset from the first frame');
        var fsamples = r.u('seek_point[' + i + '].frame_samples', 16,
          'samples in the frame containing this point');
        info.entries.push({ sampleNumber: sample, streamOffset: offset, frameSamples: fsamples });
      }
      info.count = total;
      info.listed = count;
      if (total > count) info.entryCapReached = true;
      return {
        table: synSection('SEEKTABLE',
          total + ' seek point' + (total === 1 ? '' : 's') + ' (18 bytes each)' +
          (total > count ? ' — showing the first ' + count : ''), r.rows),
        rows: r.rows,
        info: info
      };
    } catch (e) {
      return {
        table: synSection('SEEKTABLE', 'partial — parse error', r.rows),
        rows: r.rows, info: info, error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * CUESHEET — RFC 9639 §8.7
   * ====================================================================*/

  function parseCueSheet(block, base, start, end) {
    base = base || 0;
    start = start || 0;
    end = end == null ? block.length : Math.min(end, block.length);
    var r = reader(block, start, Math.max(0, end - start), base);
    var info = { tracks: [] };
    try {
      var catStart = r.bytePos();
      info.mediaCatalogNumber = latin1(block, catStart, catStart + 128);
      r.skip(128 * 8);
      r.rows.push({
        name: 'media_catalog_number', syntax: 'bytes(128)', bits: 128 * 8,
        value: truncate(info.mediaCatalogNumber, 64) || '(empty)',
        note: 'ASCII, NUL padded', offset: base + catStart, depth: r.depth
      });

      info.leadInSamples = readWide(r, 'lead_in_samples', 64,
        'samples added to every track and index offset');
      r.u('is_cd', 1, '1 = the CD-DA subset constraints apply');
      r.u('reserved', 7, 'must be zero');
      var numTracks = r.u('num_tracks', 8, '0 = this CUESHEET is a lead-out only');
      info.numTracks = numTracks;

      var listed = Math.min(numTracks, MAX_CUESHEET_TRACKS);
      for (var t = 0; t < listed; t++) {
        r.depth++;
        r.group('cuesheet_track[' + t + ']');
        var trackOffset = readWide(r, 'track[' + t + '].offset', 64, 'samples');
        var trackNumber = r.u('track[' + t + '].number', 8, '1..99 for CD-DA, 170 = lead-out');
        var isrcStart = r.bytePos();
        var isrc = latin1(block, isrcStart, isrcStart + 12);
        r.skip(12 * 8);
        r.rows.push({
          name: 'track[' + t + '].isrc', syntax: 'bytes(12)', bits: 96,
          value: isrc || '(empty)', note: 'ASCII, NUL padded',
          offset: base + isrcStart, depth: r.depth
        });
        r.u('track[' + t + '].is_audio', 1, '0 = a non-audio (data) track');
        r.u('track[' + t + '].pre_emphasis', 1);
        r.u('track[' + t + '].reserved', 6, 'must be zero');
        var numIndices = r.u('track[' + t + '].num_indices', 8);
        var idxListed = Math.min(numIndices, MAX_CUESHEET_INDICES);
        var track = { offset: trackOffset, number: trackNumber, isrc: isrc, indices: [] };
        for (var k = 0; k < idxListed; k++) {
          var idxOffset = readWide(r, 'track[' + t + '].index[' + k + '].offset', 64,
            'samples, relative to the track offset');
          var idxNum = r.u('track[' + t + '].index[' + k + '].number', 8,
            '0 = pre-gap, 1 = track start, higher = later points');
          r.u('track[' + t + '].index[' + k + '].reserved', 24, 'must be zero');
          track.indices.push({ offset: idxOffset, number: idxNum });
        }
        if (numIndices > idxListed) {
          r.group('// ' + (numIndices - idxListed) + ' further indices not listed (cap)');
        }
        info.tracks.push(track);
        r.depth--;
      }
      if (numTracks > listed) {
        info.trackCapReached = true;
        r.group('// ' + (numTracks - listed) + ' further tracks not listed (cap)');
      }
      return {
        table: synSection('CUESHEET',
          numTracks + ' track' + (numTracks === 1 ? '' : 's') + ', lead-in ' +
          info.leadInSamples + ' samples', r.rows),
        rows: r.rows, info: info
      };
    } catch (e) {
      return {
        table: synSection('CUESHEET', 'partial — parse error', r.rows),
        rows: r.rows, info: info, error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * PICTURE — RFC 9639 §8.8
   * ====================================================================*/

  function parsePicture(block, base, start, end) {
    base = base || 0;
    start = start || 0;
    end = end == null ? block.length : Math.min(end, block.length);
    var r = reader(block, start, Math.max(0, end - start), base);
    var info = {};
    try {
      var type = r.ule('picture_type', 4, 'little endian');
      info.type = type;
      info.typeName = PICTURE_TYPES[type] || ('type ' + type);
      r.note(info.typeName);

      var mimeLen = r.ule('mime_type_length', 4, 'little endian');
      if (mimeLen > Math.max(0, end - r.bytePos())) {
        mimeLen = Math.max(0, end - r.bytePos());
        r.note('length exceeds the block — clamped');
      }
      var mimeStart = r.bytePos();
      info.mimeType = latin1(block, mimeStart, mimeStart + mimeLen);
      r.skip(mimeLen * 8);
      r.rows.push({
        name: 'mime_type', syntax: 'bytes(' + mimeLen + ')', bits: mimeLen * 8,
        value: info.mimeType || '(empty)', note: 'ASCII, "->" means a URL',
        offset: base + mimeStart, depth: r.depth
      });

      var descLen = r.ule('description_length', 4, 'little endian');
      if (descLen > Math.max(0, end - r.bytePos())) {
        descLen = Math.max(0, end - r.bytePos());
        r.note('length exceeds the block — clamped');
      }
      var descStart = r.bytePos();
      info.description = latin1OrUtf8(block, descStart, descStart + descLen);
      r.skip(descLen * 8);
      r.rows.push({
        name: 'description', syntax: 'bytes(' + descLen + ')', bits: descLen * 8,
        value: truncate(info.description, 120) || '(empty)', note: 'UTF-8',
        offset: base + descStart, depth: r.depth
      });

      info.width = r.ule('width', 4, 'pixels');
      info.height = r.ule('height', 4, 'pixels');
      info.depth = r.ule('colour_depth', 4, 'bits per pixel');
      info.colours = r.ule('number_of_colours', 4, '0 = non-indexed image');
      info.dataLength = r.ule('data_length', 4, 'bytes of picture data');
      var dStart = r.bytePos();
      info.dataOffset = base + dStart;
      var avail = Math.max(0, end - dStart);
      info.dataTruncated = info.dataLength > avail;
      if (info.dataTruncated) r.note('declared ' + info.dataLength + ' bytes, ' + avail + ' available');
      // The picture bytes themselves are never listed row by row.
      r.rows.push({
        name: 'picture_data', syntax: 'bytes(' + info.dataLength + ')',
        bits: Math.min(info.dataLength, avail) * 8,
        value: MA.formatSize(Math.min(info.dataLength, avail)),
        note: info.dataTruncated ? 'truncated' : 'binary payload, not listed',
        offset: base + dStart, depth: r.depth
      });

      return {
        table: synSection('PICTURE',
          info.typeName + ', ' + (info.mimeType || '?') + ', ' + info.width + 'x' + info.height +
          ', ' + MA.formatSize(info.dataLength), r.rows),
        rows: r.rows, info: info
      };
    } catch (e) {
      return {
        table: synSection('PICTURE', 'partial — parse error', r.rows),
        rows: r.rows, info: info, error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * Frame header — RFC 9639 §9.1
   * ====================================================================*/

  /**
   * The UTF-8-like variable length coded number used for the frame or sample
   * number (RFC 9639 §9.1.6). Up to 7 bytes / 36 bits.
   */
  function readUtf8Number(r) {
    var b0 = BitReader.prototype.u.call(r, 8);
    var n, v;
    if (b0 < 0x80) return b0;
    if (b0 >= 0xfe) { n = 6; v = b0 & 0x01; }
    else if (b0 >= 0xfc) { n = 5; v = b0 & 0x03; }
    else if (b0 >= 0xf8) { n = 4; v = b0 & 0x07; }
    else if (b0 >= 0xf0) { n = 3; v = b0 & 0x0f; }
    else if (b0 >= 0xe0) { n = 2; v = b0 & 0x1f; }
    else if (b0 >= 0xc0) { n = 1; v = b0 & 0x3f; }
    else return -1;                                  // 0x80..0xBF: a lone continuation byte
    for (var i = 0; i < n; i++) v = v * 64 + (BitReader.prototype.u.call(r, 8) & 0x3f);
    return v;
  }

  function blockSizeOfCode(code) {
    if (code === 1) return 192;
    if (code >= 2 && code <= 5) return 576 * Math.pow(2, code - 2);
    if (code >= 8 && code <= 15) return 256 * Math.pow(2, code - 8);
    return 0;
  }

  /**
   * Full FLAC frame header, ending with the CRC-8.
   *
   * @param {Uint8Array} data full buffer
   * @param {number} off  index of the 0xFF sync byte
   * @param {number} base absolute file offset of data[0]
   * @returns {{table, rows, info, blockSize, sampleRate, channels}}
   */
  function parseFrameHeader(data, off, base) {
    off = off || 0;
    var out = { table: null, rows: null, info: { offset: (base || 0) + off },
                blockSize: 0, sampleRate: 0, channels: 0, error: null };
    // The header is at most 16 bytes long (15 + the CRC-8).
    var avail = Math.max(0, Math.min(data.length - off, 16));
    if (avail < 5) {
      out.error = 'buffer too short for a FLAC frame header';
      out.table = synSection('FRAME_HEADER', out.error, []);
      out.rows = [];
      return out;
    }
    var r = reader(data, off, avail, base);
    var info = out.info;
    out.rows = r.rows;
    try {
      var sync = r.u('sync_code', 14, 'must be 0b11111111111110 (0x3FFE)');
      if (sync !== 0x3ffe) {
        r.note('sync mismatch — not a FLAC frame header');
        out.table = synSection('FRAME_HEADER', 'sync mismatch', r.rows);
        out.error = 'bad FLAC frame sync ' + MA.hex(sync, 4);
        return out;
      }
      r.flag('reserved', 'must be 0');
      var blocking = r.flag('blocking_strategy',
        '0 = fixed block size, the coded number is a frame number; ' +
        '1 = variable block size, it is a sample number');
      var bsCode = r.u('block_size_code', 4);
      r.note(bsCode + ' = ' + (BLOCK_SIZE_CODES[bsCode] || 'reserved'));
      var srCode = r.u('sample_rate_code', 4);
      r.note(srCode + ' = ' + (SAMPLE_RATE_CODES[srCode] || 'reserved'));
      var chAssign = r.u('channel_assignment', 4);
      r.note(chAssign + ' = ' + channelAssignName(chAssign));
      var ssCode = r.u('sample_size_code', 3);
      r.note(ssCode + ' = ' + (SAMPLE_SIZE_CODES[ssCode] || 'reserved'));
      r.flag('reserved', 'must be 0');

      var numBitStart = r.bitPos();
      var number = readUtf8Number(r);
      r.rows.push({
        name: blocking ? 'sample_number' : 'frame_number',
        syntax: 'utf8(v)', bits: r.bitPos() - numBitStart,
        value: number < 0 ? 'invalid' : number,
        note: blocking
          ? 'UTF-8-like coded number of the first sample in this frame'
          : 'UTF-8-like coded frame number',
        offset: r.base + Math.floor(numBitStart / 8), depth: r.depth
      });
      info.frameNumber = blocking ? null : number;
      info.sampleNumber = blocking ? number : null;
      info.blockingStrategy = blocking ? 'variable' : 'fixed';
      info.blockingStrategyBit = blocking;

      /* ---- optional 8/16-bit block size and sample rate at the header end ---- */
      var blockSize = 0, sampleRate = 0;
      if (bsCode === 6) {
        blockSize = r.u('block_size (8-bit)', 8, 'blocksize - 1') + 1;
      } else if (bsCode === 7) {
        blockSize = r.u('block_size (16-bit)', 16, 'blocksize - 1') + 1;
      } else {
        blockSize = blockSizeOfCode(bsCode);
        if (bsCode === 0) r.group('// block_size_code 0 is reserved — blocksize unknown');
      }
      if (srCode === 12) {
        sampleRate = r.u('sample_rate (8-bit)', 8, 'in kHz') * 1000;
      } else if (srCode === 13) {
        sampleRate = r.u('sample_rate (16-bit)', 16, 'in Hz');
      } else if (srCode === 14) {
        sampleRate = r.u('sample_rate (16-bit)', 16, 'in tens of Hz') * 10;
      } else if (srCode === 15) {
        r.group('// sample_rate_code 15 is invalid — the frame must be rejected');
      } else {
        sampleRate = SAMPLE_RATE_VALUES[srCode] || 0;
      }

      var crcPos = r.bytePos();
      var computed = crc8(data, off, crcPos);
      var stored = crcPos < data.length ? data[crcPos] : -1;
      r.u('crc-8', 8, stored === computed
        ? 'CRC-8 valid over the header (0x' + hex2(computed) + ')'
        : 'CRC-8 mismatch: stored 0x' + hex2(stored < 0 ? 0 : stored) +
          ', computed 0x' + hex2(computed));
      info.crcOk = stored === computed;
      info.crcStored = stored;
      info.crcComputed = computed;

      info.blockSizeCode = bsCode;
      info.sampleRateCode = srCode;
      info.channelAssignment = chAssign;
      info.sampleSizeCode = ssCode;
      info.blockSize = blockSize;
      info.sampleRate = sampleRate;
      info.channels = chAssign <= 7 ? chAssign + 1 : (chAssign <= 10 ? 2 : 0);
      info.bitsPerSample = SAMPLE_SIZE_VALUES[ssCode] || 0;
      info.headerLength = r.bytePos();

      out.blockSize = blockSize;
      out.sampleRate = sampleRate;
      out.channels = info.channels;
      out.table = synSection('FRAME_HEADER',
        info.blockingStrategy + ' blocking, ' + (blockSize || '?') + ' samples, ' +
        (sampleRate ? MA.formatHz(sampleRate) : 'rate from STREAMINFO') + ', ' +
        info.channels + ' ch, ' + (info.crcOk ? 'CRC-8 ok' : 'CRC-8 bad'),
        r.rows);
      return out;
    } catch (e) {
      out.error = String(e && e.message || e);
      out.table = synSection('FRAME_HEADER', 'partial — parse error', r.rows);
      return out;
    }
  }

  /* ======================================================================
   * Subframes — RFC 9639 §9.2 (header only)
   * ====================================================================*/

  var SUBFRAME_TYPES = { 0: 'CONSTANT', 1: 'VERBATIM' };
  function subframeTypeName(t) {
    if (SUBFRAME_TYPES[t]) return SUBFRAME_TYPES[t];
    if (t >= 8 && t <= 12) return 'FIXED, order ' + (t - 8);
    if (t >= 32 && t <= 63) return 'LPC, order ' + (t - 31);
    return 'reserved (' + t + ')';
  }

  /**
   * Subframe header at the start of one subframe block.
   *
   * Only the header is decoded. Everything after it is either raw samples or
   * Rice-coded residuals which have no length prefix, so the following subframe
   * cannot be located without a full decoder — see the note emitted here and in
   * parseFrame().
   *
   * @param {Uint8Array} data full buffer
   * @param {number} byteOff index of the subframe's first byte
   * @param {number} end     index one past the frame
   * @param {number} base    absolute file offset of data[0]
   * @param {object} frameInfo decoded frame header info (bitsPerSample, blockSize)
   */
  function parseSubframeHeader(data, byteOff, end, base, frameInfo) {
    var r = reader(data, byteOff, Math.max(0, Math.min(end - byteOff, 64)), base);
    var info = { offset: (base || 0) + byteOff };
    try {
      r.flag('subframe_zero_padding', 'must be 0 — prevents a false sync pattern');
      var type = r.u('subframe_type', 6);
      r.note(type + ' = ' + subframeTypeName(type));
      info.type = type;
      info.typeName = subframeTypeName(type);

      var wastedFlag = r.flag('wasted_bits_flag',
        '1 = the low-order zero bits are not coded');
      var wasted = 0;
      if (wastedFlag) {
        // Unary coded: k-1 one bits followed by a zero.
        var startBit = r.bitPos();
        var ones = 0;
        while (ones < 32 && BitReader.prototype.u.call(r, 1) === 1) ones++;
        wasted = ones + 1;
        r.rows.push({
          name: 'wasted_bits_per_sample', syntax: 'unary(v)', bits: r.bitPos() - startBit,
          value: wasted, note: '(k-1) = ' + ones + ' one bits, so k = ' + wasted,
          offset: r.base + Math.floor(startBit / 8), depth: r.depth
        });
      }
      info.wastedBits = wasted;

      var effBps = frameInfo && frameInfo.bitsPerSample
        ? frameInfo.bitsPerSample - wasted : 0;
      var blockSize = (frameInfo && frameInfo.blockSize) || 0;

      if (type === 0) {
        r.group('// CONSTANT: one sample of ' + (effBps || 'bps') + ' bits');
        info.samples = 1;
      } else if (type === 1) {
        r.group('// VERBATIM: ' + (blockSize || 'blocksize') + ' samples of ' +
          (effBps || 'bps') + ' bits');
      } else if (type >= 8 && type <= 12) {
        var order = type - 8;
        info.order = order;
        r.group('// FIXED, order ' + order + ': ' + order + ' warm-up samples of ' +
          (effBps || 'bps') + ' bits');
        r.group('// residual coding (Rice partitioned) not decoded');
      } else if (type >= 32) {
        var lpcOrder = type - 31;
        info.order = lpcOrder;
        r.group('// LPC, order ' + lpcOrder + ': ' + lpcOrder + ' warm-up samples of ' +
          (effBps || 'bps') + ' bits');
        var precisionMinus1 = r.u('qlp_precision_in_bits_minus1', 4,
          '15 is invalid; precision = this + 1');
        info.qlpPrecision = precisionMinus1 === 15 ? 0 : precisionMinus1 + 1;
        if (precisionMinus1 === 15) r.note('15 is an invalid precision — the stream is corrupt');
        var shiftRow = r.rows.length;
        var shift = r.u('qlp_shift', 5, 'two\'s complement, negative shifts left');
        if (shift > 15) shift -= 32;
        r.rows[shiftRow].value = shift;
        info.qlpShift = shift;
        r.note('quantisation level shift ' + shift + ' (coefficients are ' +
          (info.qlpPrecision || '?') + ' bits each)');
        r.group('// residual coding (Rice partitioned) not decoded');
      } else {
        r.group('// reserved subframe type — not decoded');
      }

      r.group('// STOP: subframe 2..N cannot be located without decoding the ' +
        'Rice-coded residuals of this subframe — frame size comes from the next sync');
      info.headerBits = r.bitPos();
      return {
        table: synSection('SUBFRAME_HEADER',
          subframeTypeName(type) + (wasted ? ', ' + wasted + ' wasted bits' : ''), r.rows),
        rows: r.rows, info: info
      };
    } catch (e) {
      return {
        table: synSection('SUBFRAME_HEADER', 'partial — parse error', r.rows),
        rows: r.rows, info: info, error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * One frame: header + first subframe header
   * ====================================================================*/

  /**
   * @param {Uint8Array} data full buffer
   * @param {number} off  frame offset (the 0xFF sync byte)
   * @param {number} end  offset one past the frame (usually the next frame's sync)
   * @param {object} ctx  { streamInfo, sampleRate, channels, bitsPerSample }
   * @returns {{tables, info}}
   */
  function parseFrame(data, off, end, ctx) {
    ctx = ctx || {};
    end = end == null ? data.length : Math.min(end, data.length);
    var si = ctx.streamInfo || {};
    var tables = [], info = { offset: off, size: end - off };

    var fh = parseFrameHeader(data, off, 0);
    if (fh.table) tables.push(fh.table);
    info.header = fh.info;
    if (fh.error) {
      info.error = fh.error;
      return { tables: tables, info: info, error: fh.error };
    }
    // Fields the frame leaves out fall back to STREAMINFO.
    info.blockSize = fh.blockSize || si.maxBlockSize || 0;
    info.sampleRate = fh.sampleRate || si.sampleRate || 0;
    info.channels = fh.channels || si.channels || 0;
    info.bitsPerSample = fh.info.bitsPerSample || si.bitsPerSample || 0;
    info.frameNumber = fh.info.frameNumber;
    info.sampleNumber = fh.info.sampleNumber;
    info.blockingStrategy = fh.info.blockingStrategy;
    info.crcOk = fh.info.crcOk;

    var subOff = off + (fh.info.headerLength || 0);
    if (subOff < end) {
      var frameProbe = {
        bitsPerSample: fh.info.bitsPerSample || si.bitsPerSample || 0,
        blockSize: info.blockSize
      };
      var sf = parseSubframeHeader(data, subOff, end, 0, frameProbe);
      if (sf.table) tables.push(sf.table);
      info.firstSubframe = sf.info;
    }
    info.decoded = 'frame header + first subframe header';
    info.notDecoded = 'subframes 2..N and all residual coding';
    return { tables: tables, info: info };
  }

  /* ======================================================================
   * Whole file analysis
   * ====================================================================*/

  /**
   * Locate the next frame by scanning for a frame header that parses *and*
   * whose CRC-8 checks out. A FLAC frame carries no length, so this is the
   * only way to walk the frame chain without a full decoder. Returns the index
   * of the next sync, or -1 when none is found.
   */
  function findNextFrame(data, from) {
    var stop = Math.min(data.length - 1, from + MAX_FRAME_SCAN);
    var plausible = -1;
    for (var i = Math.max(0, from); i < stop; i++) {
      // 14-bit sync 0b11111111111110 -> 0xFF followed by 0xF8/0xF9.
      if (data[i] !== 0xff || (data[i + 1] & 0xfc) !== 0xf8) continue;
      var fh = parseFrameHeader(data, i, 0);
      if (fh.error || !fh.info.headerLength) continue;
      if (fh.info.crcOk) return i;
      if (plausible < 0) plausible = i;      // keep a fallback for a bad-CRC file
    }
    return plausible;
  }

  /**
   * Walk a whole .flac file: the metadata blocks as structure, then the frames.
   * @returns {{tables, frames, track, info}}
   */
  function analyzeStream(data, ctx) {
    ctx = ctx || {};
    var tables = [], frames = [], info = { metadataBlocks: [] };
    var si = null, vendor = null, comments = null, seekTable = null, cueSheet = null;
    var pictures = [];

    if (data.length < 4 || data[0] !== 0x66 || data[1] !== 0x4c ||
        data[2] !== 0x61 || data[3] !== 0x43) {
      info.error = 'missing "fLaC" stream marker';
      return { tables: tables, frames: frames, track: null, info: info };
    }
    tables.push(synSection('fLaC stream marker',
      'RFC 9639 §8 — native FLAC stream', [{
        name: 'marker', syntax: 'bytes(4)', bits: 32, value: 'fLaC',
        note: '"fLaC" ASCII, identifies a native FLAC stream', offset: 0, depth: 0
      }]));

    var p = 4;
    var guard = 0;
    while (p + 4 <= data.length && guard++ < MAX_METADATA_BLOCKS) {
      var h = parseMetadataBlockHeader(data, p, 0);
      var t = h.type, len = h.length;
      var body = p + 4;
      var bodyEnd = Math.min(data.length, body + len);
      info.metadataBlocks.push({
        index: guard - 1, type: t, name: h.info.typeName, offset: p,
        size: 4 + len, length: len, isLast: h.isLast, truncated: h.info.truncated
      });
      if (h.table) tables.push(h.table);

      try {
        if (t === 0) {
          var s = parseStreamInfo(data.subarray(body, bodyEnd), body);
          si = s.info;
          tables.push(s.table);
          if (s.error) info.streamInfoError = s.error;
        } else if (t === 4) {
          var vc = parseVorbisComment(data, 0, body, bodyEnd);
          vendor = vc.info.vendor;
          comments = vc.info;
          tables.push(vc.table);
        } else if (t === 3) {
          var st = parseSeekTable(data, 0, body, bodyEnd);
          seekTable = st.info;
          tables.push(st.table);
        } else if (t === 5) {
          var cs = parseCueSheet(data, 0, body, bodyEnd);
          cueSheet = cs.info;
          tables.push(cs.table);
        } else if (t === 6) {
          var pic = parsePicture(data, 0, body, bodyEnd);
          pictures.push(pic.info);
          tables.push(pic.table);
        } else if (t === 2) {
          var appId = '';
          for (var a = 0; a < 4 && body + a < bodyEnd; a++)
            appId += String.fromCharCode(data[body + a]);
          tables.push(synSection('APPLICATION',
            'registered application ID "' + appId + '", ' + len + ' bytes', [{
              name: 'application_id', syntax: 'bytes(4)', bits: 32, value: appId,
              note: 'registered in the FLAC format registry', offset: body, depth: 0
            }, {
              name: 'application_data', syntax: 'bytes(' + Math.max(0, len - 4) + ')',
              bits: Math.max(0, len - 4) * 8, value: MA.formatSize(Math.max(0, len - 4)),
              note: 'not listed', offset: body + 4, depth: 0
            }]));
        }
        // PADDING (1) is a run of zero bytes — nothing worth a table.
      } catch (e) { /* one bad block must not stop the file walk */ }

      p = body + len;
      if (h.isLast) break;
      if (len === 0 && t !== 1) {
        // A zero length block advances by 4 and cannot spin the loop.
      }
    }

    /* ---- audio frames ---- */
    var audioStart = p;
    var chained = 0, capped = false;
    var pos = findNextFrame(data, audioStart);
    if (pos > audioStart) info.skippedBytes = pos - audioStart;
    while (pos >= 0 && pos < data.length && frames.length < MAX_FRAMES) {
      var next = findNextFrame(data, pos + 2);
      var flen = (next > pos) ? next - pos : (data.length - pos);
      var fr = parseFrame(data, pos, pos + flen, {
        streamInfo: si || {},
        sampleRate: si && si.sampleRate,
        channels: si && si.channels,
        bitsPerSample: si && si.bitsPerSample
      });
      var syntax = { codec: 'flac', kind: 'frame', base: pos, offset: pos, size: flen };
      if (frames.length < SYNTAX_FRAME_LIMIT) syntax._cached = fr.tables;
      var sampleRate = fr.info.sampleRate || (si && si.sampleRate) || 0;
      frames.push({
        index: frames.length,
        type: 'audio',
        keyframe: true,                    // every FLAC frame is independently decodable
        codec: 'flac',
        offset: pos,
        size: flen,
        sampleRate: sampleRate,
        channels: fr.info.channels,
        blockSize: fr.info.blockSize,
        bitsPerSample: fr.info.bitsPerSample,
        frameNumber: fr.info.frameNumber,
        sampleNumber: fr.info.sampleNumber,
        duration: sampleRate > 0 ? (fr.info.blockSize || 0) / sampleRate : 0,
        crcOk: fr.info.crcOk,
        syntax: syntax
      });
      if (!(next > pos)) break;
      pos = next;
    }
    if (frames.length >= MAX_FRAMES && pos < data.length) capped = true;
    for (var i = 0; i + 1 < frames.length; i++) {
      if (frames[i].offset + frames[i].size === frames[i + 1].offset) chained++;
    }

    var totalDuration = 0, frameBytes = 0;
    for (var k = 0; k < frames.length; k++) {
      totalDuration += frames[k].duration || 0;
      frameBytes += frames[k].size;
    }
    var duration = (si && si.durationSec != null) ? si.durationSec : totalDuration;

    info.frameCount = frames.length;
    info.chainedFrames = chained;
    info.frameCapReached = capped;
    info.audioStart = audioStart;
    info.streamInfo = si;
    info.vendor = vendor;
    info.comments = comments;
    info.seekTable = seekTable;
    info.cueSheet = cueSheet;
    info.pictures = pictures;
    info.md5 = si && si.md5;
    info.sampleRate = si && si.sampleRate;
    info.channels = si && si.channels;
    info.bitsPerSample = si && si.bitsPerSample;
    info.totalSamples = si && si.totalSamples;
    info.durationFromStreamInfo = si ? si.durationSec : null;
    info.durationFromFrames = totalDuration;
    info.durationSec = duration;
    info.bitrate = duration > 0
      ? Math.round(((data.length - audioStart) * 8) / duration) : null;
    info.conformanceNotes = si ? si.conformanceNotes : [];
    if (!frames.length) info.note = 'no audio frames follow the metadata blocks';

    var track = null;
    if (si) {
      track = {
        id: 1, type: 'audio', codec: 'flac',
        codecName: 'FLAC (Free Lossless Audio Codec)',
        sampleRate: si.sampleRate,
        channels: si.channels,
        channelLayout: si.channels === 1 ? '1 (mono)'
          : si.channels === 2 ? '2 (stereo)' : String(si.channels),
        bitDepth: si.bitsPerSample,
        sampleCount: si.totalSamples || null,
        frameCount: frames.length,
        durationSec: duration || null,
        bitrate: info.bitrate,
        md5: si.md5,
        vendor: vendor || ''
      };
    }
    return { tables: tables, frames: frames, track: track, info: info };
  }

  /* ------------------------------------------------------------------ utils */

  /** UTF-8 decode that stops at the first NUL (Vorbis comments and PICTURE
   *  strings are NUL-free in practice, but a stray NUL must not leak through). */
  function latin1OrUtf8(data, start, end) {
    if (end <= start) return '';
    var s = '';
    try {
      s = new TextDecoder('utf-8').decode(data.subarray(start, end));
    } catch (e) {
      return latin1(data, start, end);
    }
    var nul = s.indexOf('\0');
    return nul >= 0 ? s.slice(0, nul) : s;
  }

  function latin1(data, start, end) {
    var s = '';
    for (var i = start; i < end && i < data.length; i++) {
      var c = data[i];
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }

  function truncate(s, n) {
    s = String(s == null ? '' : s);
    return s.length > n ? s.slice(0, n) + '…' : s;
  }

  function hex2(n) { return MA.pad((n & 0xff).toString(16).toUpperCase(), 2); }

  /* ======================================================================
   * Registration
   * ====================================================================*/

  MA.registerCodec('flac', {
    id: 'flac',
    name: 'FLAC',
    blockTypes: BLOCK_TYPES,
    pictureTypes: PICTURE_TYPES,
    blockTypeName: blockTypeName,
    subframeTypeName: subframeTypeName,
    crc8: crc8,
    parseMetadataBlockHeader: parseMetadataBlockHeader,
    parseStreamInfo: parseStreamInfo,
    parseVorbisComment: parseVorbisComment,
    parseSeekTable: parseSeekTable,
    parseCueSheet: parseCueSheet,
    parsePicture: parsePicture,
    parseFrameHeader: parseFrameHeader,
    parseFrame: parseFrame,
    analyzeStream: analyzeStream
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
