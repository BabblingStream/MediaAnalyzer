/* ============================================================================
 * MediaAnalyzer — codecs/ac3.js
 *
 * AC-3 and E-AC-3 (Dolby Digital / Dolby Digital Plus), ATSC A/52 and A/52B.
 *
 * Both are sync-frame formats like MPEG audio: every frame carries a complete
 * header, so the frame list can be built by walking sync words and the header
 * is decoded in full here.
 *
 * The two variants share the 0x0B77 sync word and are told apart by `bsid`:
 * bsid <= 8 is AC-3, bsid 11..16 is E-AC-3. Their headers differ completely
 * after that point, so the parser branches on it immediately.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, syn = MA.synSection;

  var MAX_FRAMES = 60000;

  var SAMPLE_RATES = [48000, 44100, 32000];
  var EAC3_SAMPLE_RATES = [48000, 44100, 32000, 0];   // 3 = half rate, see fscod2
  var BITRATE_KBP_S = [32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224,
                       256, 320, 384, 448, 512, 576, 640];

  /**
   * A/52 Table 5.18 — sync-frame size in 16-bit words, indexed by frmsizecod.
   * Every entry covers two consecutive frmsizecod values. The 44.1/32 kHz
   * column is the one the standard tabulates separately; 32 kHz uses the same
   * column as 44.1 kHz.
   */
  var FRAME_WORDS_48 = [64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384,
                        448, 512, 640, 768, 896, 1024, 1152, 1280];
  var FRAME_WORDS_44 = [69, 87, 104, 121, 139, 174, 208, 243, 278, 348, 417,
                        487, 557, 696, 835, 975, 1114, 1253, 1393];

  var ACMOD_NAMES = [
    '1+1 (dual mono)', '1/0 (mono)', '2/0 (stereo)', '3/0',
    '2/1', '3/1', '2/2', '3/2'
  ];
  var ACMOD_CHANNELS = [2, 1, 2, 3, 3, 4, 4, 5];

  var BSID_NAMES = {
    0: 'AC-3 (pre-standard)', 1: 'AC-3', 2: 'AC-3', 3: 'AC-3', 4: 'AC-3',
    5: 'AC-3', 6: 'AC-3 (alternate)', 7: 'AC-3 (alternate)',
    8: 'AC-3', 9: 'AC-3 (reserved)', 10: 'AC-3 (reserved)',
    11: 'E-AC-3', 12: 'E-AC-3', 13: 'E-AC-3', 14: 'E-AC-3', 15: 'E-AC-3',
    16: 'E-AC-3', 17: 'E-AC-3 (reserved)'
  };

  /* ====================================================================== */

  function bitrateFor(frmsizecod) {
    return BITRATE_KBP_S[frmsizecod >> 1] || 0;
  }

  /** @returns {number} frame length in bytes, or 0 when unknown. */
  function frameBytes(bsid, fscod, frmsizecod) {
    var idx = frmsizecod >> 1;
    if (fscod === 0) return (FRAME_WORDS_48[idx] || 0) * 2;
    if (fscod === 1 || fscod === 2) return (FRAME_WORDS_44[idx] || 0) * 2;
    return 0;
  }

  /* ---------------------------------------------------------------- AC-3 */

  function parseAc3Header(data, off, end, base) {
    var r = new SR(data, { offset: off, length: end - off, epb: false, base: base == null ? off : base });
    var info = { variant: 'ac3' };
    try {
      var sync = r.u('syncword', 16);
      info.syncOk = sync === 0x0b77;
      r.note(sync === 0x0b77 ? '0x0B77 — valid AC-3 sync frame' : 'unexpected sync word');
      r.u('crc1', 16);

      var fscod = r.u('fscod', 2);
      info.sampleRate = SAMPLE_RATES[fscod] || null;
      r.note(info.sampleRate ? info.sampleRate + ' Hz' : 'reserved');
      var frmsizecod = r.u('frmsizecod', 6);
      info.bitrate = bitrateFor(frmsizecod) * 1000;
      r.note(info.bitrate ? (info.bitrate / 1000) + ' kbps nominal' : 'invalid');
      info.frameBytes = frameBytes(0, fscod, frmsizecod);
      info.frameWords = info.frameBytes / 2;

      var bsid = r.u('bsid', 5);
      info.bsid = bsid;
      info.variant = bsid > 10 ? 'eac3' : 'ac3';
      r.note(BSID_NAMES[bsid] || 'reserved');
      r.u('bsmod', 3);
      var acmod = r.u('acmod', 3);
      info.acmod = acmod;
      info.channels = ACMOD_CHANNELS[acmod] || 2;
      r.note(ACMOD_NAMES[acmod] || 'reserved');

      // The surround-mode fields are present only for certain channel layouts.
      if ((acmod & 0x1) && acmod !== 0x1) r.u('cmixlev', 2);
      if (acmod & 0x4) r.u('surmixlev', 2);
      if (acmod === 0x2) r.u('dsurmod', 2);

      var lfeon = r.u('lfeon', 1);
      info.lfe = !!lfeon;
      if (lfeon) info.channels++;
      r.note(lfeon ? 'LFE channel present' : '');

      r.u('dialnorm', 5);
      r.note('dialogue level ' + (-r.rows[r.rows.length - 1].value) + ' dB');
      if (r.flag('compre')) r.u('compr', 8);

      if (acmod === 0) {
        if (r.flag('langcode')) r.u('langcod', 8);
        if (r.flag('langcod')) r.rows.pop();
      } else if (acmod !== 0) {
        if (r.flag('langcode')) r.u('langcod', 8);
      }
      if (r.flag('audprodie')) {
        r.u('mixlevel', 5);
        r.u('roomtyp', 2);
      }
      if (acmod === 0) {
        if (r.flag('dialnorm2')) r.u('dialnorm2', 5);
        if (r.flag('compr2e')) { r.u('compr2', 8); r.u('compre2_flag', 0); r.rows.pop(); }
        if (r.flag('langcod2e')) r.u('langcod2', 8);
        if (r.flag('audprodi2e')) { r.u('mixlevel2', 5); r.u('roomtyp2', 2); }
      }
      r.flag('copyrightb');
      r.flag('origbs');
      if (r.flag('timecod1e')) r.u('timecod1', 14);
      if (r.flag('timecod2e')) r.u('timecod2', 14);
      if (r.flag('addbsie')) {
        var addbsil = r.u('addbsil', 6);
        for (var i = 0; i <= addbsil && i < 16; i++) r.u('addbsi[' + i + ']', 8);
      }
      info.headerBits = r.bitPos();

      return {
        tables: [syn('ac3_syncframe()', describe(info), r.rows)],
        info: info, headerBytes: Math.ceil(r.bitPos() / 8)
      };
    } catch (e) {
      info.error = String(e && e.message || e);
      return { tables: [syn('ac3_syncframe()', 'parse stopped early', r.rows)], info: info };
    }
  }

  /* -------------------------------------------------------------- E-AC-3 */

  function parseEac3Header(data, off, end, base) {
    var r = new SR(data, { offset: off, length: end - off, epb: false, base: base == null ? off : base });
    var info = { variant: 'eac3' };
    try {
      var sync = r.u('syncword', 16);
      info.syncOk = sync === 0x0b77;
      r.note(sync === 0x0b77 ? '0x0B77 — valid E-AC-3 sync frame' : 'unexpected sync word');

      var strmtyp = r.u('strmtyp', 2);
      r.note(['independent', 'dependent', 'independent (reserved)', 'reserved'][strmtyp] || '');
      info.streamType = strmtyp;
      info.substreamId = r.u('substreamid', 3);
      var frmsiz = r.u('frmsiz', 11);
      info.frameBytes = (frmsiz + 1) * 2;
      r.note(info.frameBytes + ' bytes');

      var fscod = r.u('fscod', 2);
      if (fscod === 3) {
        var fscod2 = r.u('fscod2', 2);
        info.sampleRate = fscod2 === 3 ? null : (EAC3_SAMPLE_RATES[fscod2] / 2);
        r.flag('numblkscod_absent');
        info.blocksPerFrame = 6;
        r.note('half rate: ' + (info.sampleRate || 'reserved'));
      } else {
        info.sampleRate = EAC3_SAMPLE_RATES[fscod] || null;
        var numblkscod = r.u('numblkscod', 2);
        info.blocksPerFrame = [1, 2, 3, 6][numblkscod];
        r.note((info.sampleRate || '?') + ' Hz, ' + info.blocksPerFrame + ' blocks/frame');
      }

      var acmod = r.u('acmod', 3);
      info.acmod = acmod;
      info.channels = ACMOD_CHANNELS[acmod] || 2;
      r.note(ACMOD_NAMES[acmod] || 'reserved');
      var lfeon = r.u('lfeon', 1);
      info.lfe = !!lfeon;
      if (lfeon) info.channels++;

      var bsid = r.u('bsid', 5);
      info.bsid = bsid;
      r.note(BSID_NAMES[bsid] || 'reserved');
      r.u('dialnorm', 5);
      if (r.flag('compre')) r.u('compr', 8);
      if (acmod === 0) {
        if (r.flag('dialnorm2')) r.u('dialnorm2', 5);
        if (r.flag('compr2e')) r.u('compr2', 8);
      }
      if (strmtyp === 1) r.flag('chanmape');

      info.headerBits = r.bitPos();
      return {
        tables: [syn('eac3_syncframe()', describe(info), r.rows)],
        info: info, headerBytes: Math.ceil(r.bitPos() / 8)
      };
    } catch (e) {
      info.error = String(e && e.message || e);
      return { tables: [syn('eac3_syncframe()', 'parse stopped early', r.rows)], info: info };
    }
  }

  function describe(info) {
    var parts = [info.variant === 'eac3' ? 'E-AC-3' : 'AC-3'];
    if (info.sampleRate) parts.push(info.sampleRate + ' Hz');
    if (info.channels) parts.push(info.channels + ' ch' + (info.lfe ? ' + LFE' : ''));
    if (info.bitrate) parts.push((info.bitrate / 1000) + ' kbps');
    if (info.frameBytes) parts.push(info.frameBytes + ' B/frame');
    return parts.join(', ');
  }

  /* ------------------------------------------------------------- dispatch */

  /**
   * Decide which header layout applies.
   *
   * `bsid` occupies the same bit position in both: after the 16-bit sync word,
   * a 16-bit CRC (AC-3) or 2+3+11 bits of stream/frame-size fields (E-AC-3),
   * then 2+2 bits, then acmod and lfeon — 40 bits either way. So bsid is the
   * top 5 bits of byte 5, and its value alone selects the layout:
   * 0..10 is AC-3, 11..16 is E-AC-3.
   */
  function sniffVariant(data, off) {
    if (off + 6 > data.length) return 'ac3';
    var bsid = (data[off + 5] >> 3) & 0x1f;
    return bsid > 10 ? 'eac3' : 'ac3';
  }

  function parseFrame(data, off, end, ctx) {
    var variant = sniffVariant(data, off);
    return variant === 'eac3' ? parseEac3Header(data, off, end, off)
                              : parseAc3Header(data, off, end, off);
  }

  function parseFrameHeader(data, off, base) {
    return parseFrame(data, off, data.length, base);
  }

  /* --------------------------------------------------------- stream walk */

  function analyzeStream(data, ctx) {
    ctx = ctx || {};
    var tables = [], frames = [];
    var info = {};
    var pos = 0;

    // Find the first sync word.
    while (pos + 2 < data.length && !(data[pos] === 0x0b && data[pos + 1] === 0x77)) pos++;
    if (pos + 2 >= data.length) {
      info.error = 'no AC-3 sync word (0x0B77) found';
      return { tables: tables, frames: frames, track: null, info: info };
    }
    if (pos > 0) info.skippedBytes = pos;

    var firstHeader = null;
    var sampleRate = null, channels = null, bitrate = null, lfe = false;
    var resyncs = 0, totalBytes = 0;

    while (pos + 6 < data.length && frames.length < MAX_FRAMES) {
      if (!(data[pos] === 0x0b && data[pos + 1] === 0x77)) {
        resyncs++;
        var next = pos + 2;
        while (next + 2 < data.length && !(data[next] === 0x0b && data[next + 1] === 0x77)) next++;
        if (next + 2 >= data.length) break;
        pos = next;
        continue;
      }

      var res = parseFrame(data, pos, data.length, null);
      if (!firstHeader) firstHeader = res;
      var fi = res.info;
      var len = fi.frameBytes;

      if (!len || pos + len > data.length) {
        // Fall back to the distance to the next sync word.
        var n2 = pos + 2;
        while (n2 + 2 < data.length && !(data[n2] === 0x0b && data[n2 + 1] === 0x77)) n2++;
        len = n2 - pos;
        if (len <= 2) break;
        info.estimatedFrameSizes = true;
      }

      if (!sampleRate && fi.sampleRate) sampleRate = fi.sampleRate;
      if (!channels && fi.channels) channels = fi.channels;
      if (!bitrate && fi.bitrate) bitrate = fi.bitrate;
      if (fi.lfe) lfe = true;

      // Samples per frame: 1536 for AC-3, 256 x blocks for E-AC-3.
      var samples = fi.variant === 'eac3'
        ? 256 * (fi.blocksPerFrame || 6)
        : 1536;
      var dur = (sampleRate || fi.sampleRate) ? samples / (sampleRate || fi.sampleRate) : 0;

      frames.push({
        index: frames.length,
        type: 'audio',
        keyframe: true,
        codec: fi.variant,
        offset: pos,
        size: len,
        sampleRate: fi.sampleRate,
        channels: fi.channels,
        duration: dur,
        syntax: { codec: fi.variant, kind: 'ac3-syncframe', base: pos, offset: pos, size: len }
      });
      totalBytes += len;
      pos += len;
    }

    var duration = 0;
    for (var i = 0; i < frames.length; i++) duration += frames[i].duration || 0;

    var track = null;
    if (frames.length) {
      var variantName = (firstHeader && firstHeader.info.variant === 'eac3')
        ? 'E-AC-3 (Dolby Digital Plus)' : 'AC-3 (Dolby Digital)';
      track = {
        id: 1, type: 'audio', codec: firstHeader.info.variant,
        codecName: variantName,
        profile: BSID_NAMES[firstHeader.info.bsid] || '',
        sampleRate: sampleRate,
        channels: channels,
        channelLayout: channels === 1 ? '1 (mono)'
                     : channels === 2 ? '2 (stereo)'
                     : channels === 6 ? '6 (5.1)' : String(channels),
        bitDepth: null,
        sampleCount: frames.length,
        frameCount: frames.length,
        durationSec: duration || null,
        bitrate: bitrate || (duration > 0 ? Math.round(totalBytes * 8 / duration) : null)
      };
    }

    info.sampleRate = sampleRate;
    info.channels = channels;
    info.bitrate = bitrate;
    info.durationSec = duration || null;
    if (resyncs) info.resyncs = resyncs;
    if (!frames.length) info.note = 'no complete frames follow the sync word';

    // The header of the first frame is the most useful table to show eagerly.
    if (firstHeader) tables = firstHeader.tables;

    return { tables: tables, frames: frames, track: track, info: info };
  }

  /** Called by framesyntax.js for a per-frame recipe. */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    return parseFrame(payload, 0, payload.length, null).tables;
  }

  function makeContext() { return { codec: 'ac3' }; }

  MA.registerCodec('ac3', {
    id: 'ac3',
    name: 'AC-3 / E-AC-3',
    parseAc3Header: parseAc3Header,
    parseEac3Header: parseEac3Header,
    parseFrameHeader: parseFrameHeader,
    parseFrame: parseFrame,
    buildSampleSyntax: buildSampleSyntax,
    analyzeStream: analyzeStream,
    makeContext: makeContext
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
