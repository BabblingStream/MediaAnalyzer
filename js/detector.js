/* ============================================================================
 * MediaAnalyzer — detector.js
 *
 * Format sniffing. Two independent signals are combined:
 *
 *   1. the first 4 KB of the file (magic numbers, structural probes)
 *   2. the file extension (a hint only — never trusted on its own, but it
 *      settles cases where the magic bytes are ambiguous, e.g. a raw .264
 *      elementary stream vs. a raw .h265 one, both of which start with a
 *      00 00 00 01 start code)
 *
 * `detect()` returns the best match with a confidence in [0,1]:
 *   1.00  unambiguous magic
 *   0.85  magic + matching extension
 *   0.60  structural probe only
 *   0.40  extension only
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var ext = MA.fileExt;

  /* ---------------------------------------------------------------------
   * Signature table — evaluated in order, first hit wins.
   * `test` gets (bytes, size, extension) and returns a confidence or 0.
   * ------------------------------------------------------------------- */
  var SIGNATURES = [
    {
      id: 'png', name: 'PNG', kinds: ['image'],
      exts: ['png', 'apng'],
      test: function (b) {
        return b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e &&
               b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a ? 1 : 0;
      }
    },
    {
      id: 'jpeg', name: 'JPEG', kinds: ['image'],
      exts: ['jpg', 'jpeg', 'jpe', 'jfif', 'mpo'],
      test: function (b) { return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 1 : 0; }
    },
    {
      id: 'gif', name: 'GIF', kinds: ['image'],
      exts: ['gif'],
      test: function (b) {
        if (b.length < 6) return 0;
        var s = String.fromCharCode(b[0], b[1], b[2], b[3], b[4], b[5]);
        return (s === 'GIF87a' || s === 'GIF89a') ? 1 : 0;
      }
    },
    {
      id: 'bmp', name: 'BMP', kinds: ['image'],
      exts: ['bmp', 'dib'],
      test: function (b) { return b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d ? 0.9 : 0; }
    },
    {
      id: 'webp', name: 'WebP', kinds: ['image'],
      exts: ['webp'],
      test: function (b) { return riffIs(b, 'WEBP') ? 1 : 0; }
    },
    {
      id: 'wav', name: 'WAV', kinds: ['audio'],
      exts: ['wav', 'wave'],
      test: function (b) { return riffIs(b, 'WAVE') ? 1 : 0; }
    },
    {
      id: 'avi', name: 'AVI', kinds: ['video'],
      exts: ['avi'],
      test: function (b) { return riffIs(b, 'AVI ') ? 1 : 0; }
    },
    {
      id: 'm3u8', name: 'HLS playlist', kinds: ['playlist'],
      exts: ['m3u8', 'm3u'],
      test: function (b) {
        var head = latin1Head(b, 64);
        if (!/^﻿?#EXTM3U/.test(head)) return 0;
        return /#EXT-X-(STREAM-INF|TARGETDURATION|MEDIA-SEQUENCE|VERSION|PLAYLIST-TYPE)/.test(latin1Head(b, 4096)) ? 1 : 0.8;
      }
    },
    {
      id: 'flv', name: 'FLV', kinds: ['video'],
      exts: ['flv', 'f4v'],
      test: function (b) {
        return b.length >= 9 && b[0] === 0x46 && b[1] === 0x4c && b[2] === 0x56 && b[3] === 0x01 ? 1 : 0;
      }
    },
    {
      id: 'asf', name: 'ASF / WMV', kinds: ['video', 'audio'],
      exts: ['asf', 'wma', 'wmv'],
      test: function (b) {
        // ASF Header Object GUID in its mixed-endian on-disk byte order.
        var M = [0x30, 0x26, 0xb2, 0x75, 0x8e, 0x66, 0xcf, 0x11,
                 0xa6, 0xd9, 0x00, 0xaa, 0x00, 0x62, 0xce, 0x6c];
        if (b.length < 16) return 0;
        for (var i = 0; i < 16; i++) if (b[i] !== M[i]) return 0;
        return 1;
      }
    },
    {
      id: 'matroska', name: 'Matroska / WebM', kinds: ['video'],
      exts: ['webm', 'mkv', 'mka', 'mks', 'mk3d'],
      test: function (b) {
        return b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3 ? 1 : 0;
      }
    },
    {
      id: 'ogg', name: 'Ogg', kinds: ['audio', 'video'],
      exts: ['ogg', 'oga', 'ogv', 'opus', 'spx'],
      test: function (b) {
        if (b.length < 4) return 0;
        return (b[0] === 0x4f && b[1] === 0x67 && b[2] === 0x67 && b[3] === 0x53) ? 1 : 0;
      }
    },
    {
      id: 'flac', name: 'FLAC', kinds: ['audio'],
      exts: ['flac'],
      test: function (b) {
        if (b.length < 4) return 0;
        return (b[0] === 0x66 && b[1] === 0x4c && b[2] === 0x61 && b[3] === 0x43) ? 1 : 0;
      }
    },
    {
      id: 'ivf', name: 'IVF (VP8/VP9/AV1)', kinds: ['video'],
      exts: ['ivf'],
      test: function (b) {
        if (b.length < 4) return 0;
        return (b[0] === 0x44 && b[1] === 0x4b && b[2] === 0x49 && b[3] === 0x46) ? 1 : 0;
      }
    },
    {
      id: 'mp4', name: 'MP4 (ISO BMFF)', kinds: ['video', 'audio', 'image'],
      exts: ['mp4', 'm4v', 'm4a', 'm4b', 'm4p', 'm4s', 'mov', 'qt', '3gp', '3g2',
             'f4a', 'f4b', 'f4p', 'f4v', 'dash', 'cmfv', 'cmfa', 'avif', 'heic', 'heif', 'mif1', 'isma'],
      test: function (b) { return isobmffScore(b); }
    },
    {
      id: 'ts', name: 'MPEG-TS', kinds: ['video'],
      exts: ['ts', 'm2ts', 'mts', 'm2t', 'tp', 'trp'],
      test: function (b) { return tsScore(b); }
    },
    {
      id: 'adts', name: 'AAC (ADTS)', kinds: ['audio'],
      exts: ['aac', 'adts'],
      test: function (b) {
        if (b.length < 2 || b[0] !== 0xff) return 0;
        if ((b[1] & 0xf6) !== 0xf0) return 0;
        // layer must be 0 (bits 2..1 of byte 1)
        if ((b[1] & 0x06) !== 0) return 0;
        return 1;
      }
    },
    {
      id: 'ac3', name: 'AC-3 / E-AC-3', kinds: ['audio'],
      exts: ['ac3', 'ec3', 'eac3'],
      test: function (b) { return b.length >= 2 && b[0] === 0x0b && b[1] === 0x77 ? 1 : 0; }
    },
    // A format may only appear here if a parser is registered for its id —
    // naming a format the tool cannot open just produces a dead end. AMR is
    // deliberately absent for that reason (see testmedia/regression.js, which
    // asserts this invariant).
    {
      id: 'mp3', name: 'MP3', kinds: ['audio'],
      exts: ['mp3', 'mp2', 'mpga', 'mpa'],
      test: function (b) { return mp3Score(b); }
    },
    {
      id: 'h264', name: 'H.264 / AVC (Annex B)', kinds: ['video'],
      exts: ['264', 'h264', 'avc', 'x264'],
      test: function (b, ext) { return annexBScore(b, ext, 'h264'); }
    },
    {
      id: 'h265', name: 'H.265 / HEVC (Annex B)', kinds: ['video'],
      exts: ['265', 'h265', 'hevc', 'x265'],
      test: function (b, ext) { return annexBScore(b, ext, 'h265'); }
    },
    {
      id: 'h266', name: 'H.266 / VVC (Annex B)', kinds: ['video'],
      exts: ['266', 'h266', 'vvc', 'x266'],
      test: function (b, ext) { return annexBScore(b, ext, 'h266'); }
    },
    {
      id: 'av1', name: 'AV1 (OBU stream)', kinds: ['video'],
      exts: ['obu', 'av1'],
      test: function (b, ext) { return obuScore(b, ext, 'av1'); }
    }
  ];

  /* ---------------------------------------------------------------------
   * probes
   * ------------------------------------------------------------------- */

  function ascii(b, off, n) {
    var s = '';
    for (var i = 0; i < n; i++) s += String.fromCharCode(b[off + i] || 0);
    return s;
  }
  function latin1Head(b, n) {
    var s = '';
    for (var i = 0; i < Math.min(n, b.length); i++) s += String.fromCharCode(b[i]);
    return s;
  }
  function riffIs(b, kind) {
    return b.length >= 12 && ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === kind;
  }

  /** ISO BMFF: a valid box header within the first bytes. */
  function isobmffScore(b) {
    if (b.length < 8) return 0;
    var known = { ftyp: 1, styp: 1, moov: 1, moof: 1, mdat: 1, free: 1, skip: 1,
                  wide: 1, sidx: 1, pnot: 1, junk: 1, uuid: 1, meta: 1, mfra: 1 };
    var type = ascii(b, 4, 4);
    if (!known[type]) return 0;
    var size = (b[0] * 16777216) + (b[1] * 65536) + (b[2] * 256) + b[3];
    if (size === 0 || size === 1 || size >= 8) return 1;
    return 0;
  }

  /**
   * MPEG-TS: 0x47 sync bytes at a fixed stride. Three layouts exist in the
   * wild and each has its own sync position:
   *   188  plain TS
   *   192  M2TS / BDAV — a 4-byte TP_extra_header in front of each packet
   *   204  RS-coded, 16 trailing parity bytes
   * The stride and the sync offset must be probed together: checking 0x47 at
   * offset 0 of a 192-byte stream looks at TP_extra_header bytes and never
   * matches.
   */
  var TS_LAYOUTS = [
    { stride: 188, sync: 0, score: 1 },
    { stride: 192, sync: 4, score: 0.95 },
    { stride: 204, sync: 0, score: 0.9 }
  ];

  function tsScore(b) {
    var best = 0;
    for (var s = 0; s < TS_LAYOUTS.length; s++) {
      var L = TS_LAYOUTS[s];
      if (b.length < L.sync + L.stride * 3) {
        // Too short to confirm by stride: two sync bytes are weak evidence.
        if (b.length >= L.sync + L.stride + 1 &&
            b[L.sync] === 0x47 && b[L.sync + L.stride] === 0x47) {
          best = Math.max(best, 0.6);
        }
        continue;
      }
      var hits = 0, trials = 0;
      for (var off = L.sync; off + L.stride * 4 < b.length && trials < 8; off += L.stride, trials++) {
        if (b[off] === 0x47) hits++;
      }
      if (trials >= 3 && hits === trials) best = Math.max(best, L.score);
      else if (trials >= 3 && hits >= trials - 1 && hits >= 3) best = Math.max(best, 0.7);
    }
    return best;
  }

  /**
   * MP3: an ID3v2 tag, or a chain of valid MPEG audio frame headers.
   * Validates the header fields rather than just the 11-bit sync so that
   * random binary (e.g. AAC ADTS) is not misclassified.
   */
  function mp3Score(b) {
    if (b.length >= 3 && b[0] === 0x49 && b[1] === 0x44 && b[2] === 0x33) {
      if (b[3] < 0xff && b[4] < 0xff) return 1;
    }
    if (b.length < 4) return 0;
    // Scan a few candidate frames near the start.
    for (var off = 0; off < Math.min(b.length - 4, 8192); off++) {
      if (b[off] !== 0xff || (b[off + 1] & 0xe0) !== 0xe0) continue;
      var ver = (b[off + 1] >> 3) & 3;
      var layer = (b[off + 1] >> 1) & 3;
      var brIdx = (b[off + 2] >> 4) & 0xf;
      var srIdx = (b[off + 2] >> 2) & 3;
      if (ver === 1 || layer === 0 || brIdx === 0 || brIdx === 15 || srIdx === 3) continue;
      // A single plausible header is far too weak a signal on its own — random
      // container bytes produce one about every few kilobytes. Require the
      // frame length to land on a second valid header.
      var flen = mpegFrameLength(b, off);
      if (flen > 0 && off + flen + 2 <= b.length) {
        var o2 = off + flen;
        if (b[o2] === 0xff && (b[o2 + 1] & 0xe0) === 0xe0 &&
            mpegFrameLength(b, o2) > 0) {
          return 1;
        }
      }
      return 0;
    }
    return 0;
  }

  /** MPEG-1/2/2.5 Audio frame length in bytes, or 0 when the header is invalid. */
  function mpegFrameLength(b, off) {
    var BITRATES = {
      '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
      '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
      '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
      '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
      '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
      '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160]
    };
    var SR = { 3: [44100, 48000, 32000], 2: [22050, 24000, 16000], 0: [11025, 12000, 8000] };
    var verBits = (b[off + 1] >> 3) & 3;
    var layerBits = (b[off + 1] >> 1) & 3;
    var layer = 4 - layerBits;
    var verKey = verBits === 3 ? '1' : '2';
    var brIdx = (b[off + 2] >> 4) & 0xf;
    var srIdx = (b[off + 2] >> 2) & 3;
    var pad = (b[off + 2] >> 1) & 1;
    var table = BITRATES[verKey + '-' + layer];
    if (!table || !SR[verBits]) return 0;
    var br = table[brIdx] * 1000;
    var sr = SR[verBits][srIdx];
    if (!br || !sr) return 0;
    if (layer === 1) return Math.floor((12 * br / sr + pad) * 4);
    return Math.floor(144 * br / sr + pad);   // layer 2/3 (ver 2 halves 144 to 72)
  }
  MA.mpegFrameLength = mpegFrameLength;

  /**
   * Annex-B elementary stream. Both AVC and HEVC/VVC start with the same
   * 00 00 00 01 start code, so the NAL header layout decides:
   *   AVC : forbidden(1) nal_ref_idc(2) nal_unit_type(5)
   *   HEVC: forbidden(1) nal_unit_type(6) nuh_layer_id(6) tid+1(3)
   *   VVC : forbidden(1) reserved(1) nal_unit_type(5) nuh_layer_id(6) tid+1(3)
   * AVC types 1/5/6/7/8/9 are dense; HEVC uses 32/33/34/19/20/21.
   */
  function annexBScore(b, ext, want) {
    var units = MA.annexBUnits(b, Math.min(b.length, 4096));
    if (!units.length) return 0;
    if (units[0].sc !== 0 && units[0].sc > 4) return 0;   // stream should start with a start code
    var avc = 0, hevc = 0, vvc = 0, n = 0;
    for (var i = 0; i < units.length && i < 16; i++) {
      var h = b[units[i].start];
      if (h === undefined) continue;
      n++;
      var avcType = h & 0x1f;
      var hevcType = (h >> 1) & 0x3f;
      var vvcType = (h >> 3) & 0x1f;
      if (avcType >= 1 && avcType <= 12) avc++;
      if (hevcType >= 0 && hevcType <= 40) hevc++;
      if (vvcType >= 0 && vvcType <= 12) vvc++;
      // VVC NAL header: forbidden_zero_bit=0, nuh_reserved_zero_bit=0
      if ((h & 0x80) === 0 && (h & 0x40) === 0 && vvcType <= 11) vvc++;
    }
    if (!n) return 0;

    var extBonus = { h264: ['264', 'h264', 'avc', 'x264'], h265: ['265', 'h265', 'hevc', 'x265'],
                     h266: ['266', 'h266', 'vvc', 'x266'] }[want] || [];
    var extHit = extBonus.indexOf(ext) >= 0;

    if (want === 'h264') {
      if (avc / n > 0.7 && hevc / n <= 0.7) return extHit ? 1 : 0.75;
      return 0;
    }
    if (want === 'h265') {
      if (hevc / n > 0.8 && avc / n < 0.8) return extHit ? 1 : 0.7;
      return 0;
    }
    if (want === 'h266') {
      if (vvc / n > 0.85) return extHit ? 1 : 0.7;
      return 0;
    }
    return 0;
  }

  /** Raw AV1 OBU stream (temporal delimiter / sequence header OBU). */
  function obuScore(b, ext, want) {
    if (b.length < 4) return 0;
    // Open Bitstream Unit header: forbidden(1) type(4) extension(1) has_size(1) reserved(1)
    for (var off = 0; off < 2; off++) {
      if (b[off] & 0x80) continue;
      var type = (b[off] >> 3) & 0xf;
      if (type === 1 || type === 2 || type === 6) {          // sequence header / TD
        var extHit = ['obu', 'av1'].indexOf(ext) >= 0;
        return extHit ? 0.9 : 0.55;
      }
    }
    return 0;
  }

  /* ---------------------------------------------------------------------
   * public API
   * ------------------------------------------------------------------- */

  var byId = {};
  SIGNATURES.forEach(function (s) { byId[s.id] = s; });

  /**
   * @param  {Uint8Array} head  first N bytes of the file (4 KB is plenty)
   * @param  {string}     name  file name, used only for the extension
   * @return {{ id, name, ext, confidence, source }}
   */
  function detect(head, name, totalSize) {
    var extension = ext(name);
    var best = null;

    for (var i = 0; i < SIGNATURES.length; i++) {
      var sig = SIGNATURES[i];
      var score = 0;
      try { score = sig.test(head, extension) || 0; } catch (e) { score = 0; }
      if (!score) continue;
      // A matching extension lifts confidence, a mismatch shaves a little off.
      if (sig.exts.indexOf(extension) >= 0) score = Math.min(1, score + 0.1);
      else if (extension) score -= 0.05;
      if (!best || score > best.confidence) {
        best = { id: sig.id, name: sig.name, ext: extension, confidence: score, source: 'magic' };
      }
    }

    if (best) return best;

    // Nothing matched — fall back to the extension alone.
    for (var j = 0; j < SIGNATURES.length; j++) {
      if (SIGNATURES[j].exts.indexOf(extension) >= 0) {
        return { id: SIGNATURES[j].id, name: SIGNATURES[j].name, ext: extension,
                 confidence: 0.4, source: 'extension' };
      }
    }

    return { id: 'unknown', name: 'Unknown', ext: extension, confidence: 0, source: 'none', size: totalSize };
  }

  MA.detect = detect;
  MA.formatSignatures = SIGNATURES;
})(typeof globalThis !== 'undefined' ? globalThis : this);
