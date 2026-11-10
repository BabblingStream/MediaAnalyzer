/* ============================================================================
 * MediaAnalyzer — codecs/aac.js
 *
 * AAC / MPEG-4 Audio syntax parsing.
 *   ISO/IEC 14496-3 §1.6.2.1   AudioSpecificConfig() / GASpecificConfig()
 *   ISO/IEC 14496-3 §1.A.3.2   adts_fixed_header() / adts_variable_header()
 *   ISO/IEC 13818-7            ADTS transport of the MPEG-2 AAC profile
 *
 * Every parsed structure is emitted as a syntax table whose rows mirror the
 * spec text (field / syntax / bits / value / meaning), so the frame panel can
 * show exactly what the bitstream says rather than a summary of it. `offset`
 * on a row is the absolute file offset the element starts in, which is what
 * the hex view links to.
 *
 * Entry points
 *   parseAudioSpecificConfig(data, start, len, base)  esds / FLV / CodecPrivate
 *   parseADTSHeader(data, off, end, base)             one ADTS frame header
 *   parseADTSStream(data, ctx)                        whole raw .aac file
 *   buildSampleSyntax(payload, spec)                  one MP4/MKV access unit
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, synSection = MA.synSection;

  /* ---------------------------------------------------------------- tables */

  /** samplingFrequencyIndex (Table 1.18) — index 15 escapes to an explicit u(24). */
  var SAMPLE_RATES = [
    96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
    16000, 12000, 11025, 8000, 7350
  ];

  /** audioObjectType (Table 1.17). 31 is the escape value, 32+ is the extension range. */
  var AOT_NAMES = {
    0: 'Null', 1: 'AAC Main', 2: 'AAC LC', 3: 'AAC SSR', 4: 'AAC LTP',
    5: 'SBR (HE-AAC)', 6: 'AAC Scalable', 7: 'TwinVQ', 8: 'CELP', 9: 'HVXC',
    10: 'reserved', 11: 'reserved', 12: 'TTSI', 13: 'Main Synthetic',
    14: 'Wavetable Synthesis', 15: 'General MIDI',
    16: 'Algorithmic Synthesis and Audio FX',
    17: 'ER AAC LC', 18: 'reserved', 19: 'ER AAC LTP', 20: 'ER AAC Scalable',
    21: 'ER TwinVQ', 22: 'ER BSAC', 23: 'ER AAC LD', 24: 'ER CELP',
    25: 'ER HVXC', 26: 'ER HILN', 27: 'ER Parametric', 28: 'SSC',
    29: 'PS (HE-AAC v2)', 30: 'MPEG Surround', 31: 'escape (31 + u(6))',
    32: 'Layer-1 (MP3on4)', 33: 'Layer-2 (MP3on4)', 34: 'Layer-3 (MP3on4)',
    35: 'DST', 36: 'ALS (lossless)', 37: 'SLS', 38: 'SLS non-core',
    39: 'ER AAC ELD', 40: 'SMR Simple', 41: 'SMR Main', 42: 'USAC (xHE-AAC)',
    43: 'SAOC', 44: 'LD MPEG Surround', 45: 'SAOC-DE', 46: 'Audio Sync'
  };
  function aotName(aot) {
    if (aot == null) return '?';
    return AOT_NAMES[aot] || ('Audio Object Type ' + aot);
  }

  /** channelConfiguration (Table 1.19) — 0..7 plus the 7.1 / 22.2 extensions. */
  var CHANNEL_CONFIG = {
    0: 'defined in AOT specific config (PCE)',
    1: 'mono (C)',
    2: 'stereo (L, R)',
    3: '3.0 (C, L, R)',
    4: '4.0 (C, L, R, Cs)',
    5: '5.0 (C, L, R, Ls, Rs)',
    6: '5.1 (C, L, R, Ls, Rs, LFE)',
    7: '7.1 (C, Lc, Rc, L, R, Ls, Rs, LFE)',
    11: '7.1 (C, L, R, Ls, Rs, Lrs, Rrs, LFE)',
    12: '22.2 (24 channels)',
    14: '7.1 (C, L, R, Ls, Rs, Lb, Rb, LFE)'
  };
  function channelConfigName(cfg) {
    return CHANNEL_CONFIG[cfg] || (cfg + ' channels (reserved)');
  }
  /** channelConfiguration -> loudspeaker count (0 means "see PCE"). */
  function channelsOf(cfg) {
    if (cfg === 0) return 0;
    if (cfg >= 1 && cfg <= 7) return cfg;
    if (cfg === 11 || cfg === 14) return 8;
    if (cfg === 12) return 24;
    return 0;
  }

  /** The ER object types whose AudioSpecificConfig carries an epConfig field. */
  var EP_CONFIG_AOTS = [17, 19, 20, 23];

  /** GASpecificConfig() applies to these object types (14496-3 §1.6.2.1). */
  var GA_AOTS = [1, 2, 3, 4, 6, 7, 17, 19, 20, 21, 22, 23];

  var MPEG_VERSION = { 0: 'MPEG-4 (14496-3)', 1: 'MPEG-2 (13818-7)' };
  var ADTS_PROFILE = ['Main', 'LC', 'SSR', 'LTP'];

  /* Caps — a damaged stream must never be able to spin the parser. */
  var MAX_FRAMES = 200000;         // hard stop for the frame list
  var SYNTAX_FRAME_LIMIT = 4;      // first N frames also get their header table
  var RESYNC_WINDOW = 1 << 20;     // bytes searched for the next sync after damage

  /**
   * SyntaxReader over a byte range, with emulation-prevention removal disabled.
   * The EPB rule only exists inside H.26x RBSPs; leaving it on (the default)
   * would silently swallow 00 00 03 sequences in the AAC payload and shift
   * every following row offset. `base` is the absolute file offset of data[0]
   * and defaults to 0, which is correct whenever the whole file is passed in.
   */
  function reader(data, offset, length, base) {
    return new SR(data, {
      offset: offset || 0,
      length: length,
      epb: false,
      base: (base || 0) + (offset || 0)   // SyntaxReader wants the offset of its own byte 0
    });
  }

  /* ======================================================================
   * AudioSpecificConfig() — ISO/IEC 14496-3 §1.6.2.1
   * ====================================================================*/

  /** GetAudioObjectType(): u(5), escaping at 31 to 32 + u(6). */
  function getAudioObjectType(r) {
    var v = r.u('audioObjectType', 5);
    if (v === 31) {
      var ext = r.u('audioObjectTypeExt', 6, 'audioObjectType = 32 + this value');
      v = 32 + ext;
      r.note('escaped object type -> ' + aotName(v));
    } else {
      r.note(aotName(v));
    }
    return v;
  }

  /** Reads a samplingFrequencyIndex + optional explicit frequency. */
  function samplingFrequency(r, name, explicitName) {
    var idx = r.u(name, 4);
    var hz = 0;
    if (idx === 0x0f) {
      hz = r.u(explicitName || 'samplingFrequency', 24, 'explicit frequency, index 15');
      r.note(MA.formatHz(hz));
    } else if (SAMPLE_RATES[idx]) {
      hz = SAMPLE_RATES[idx];
      r.note(MA.formatHz(hz));
    } else {
      r.note('reserved index ' + idx);
    }
    return { index: idx, hz: hz };
  }

  /**
   * GASpecificConfig() — the tail that AAC Main/LC/SSR/LTP/Scalable and the ER
   * variants share. Returns the frame length in samples (1024 or 960).
   */
  function gaSpecificConfig(r, aot, channelConfig, info) {
    r.depth++;
    r.group('GASpecificConfig()');
    var frameLengthFlag = r.flag('frameLengthFlag', '0 = 1024 samples/frame, 1 = 960 samples/frame');
    var frameLength = frameLengthFlag ? 960 : 1024;
    var dependsOnCoreCoder = r.flag('dependsOnCoreCoder');
    if (dependsOnCoreCoder) {
      info.coreCoderDelay = r.u('coreCoderDelay', 14, 'core coder delay in samples');
    }
    var extensionFlag = r.flag('extensionFlag');
    if (!channelConfig) {
      // The channel layout lives in a program_config_element() in this case;
      // it is a nested, self-sized structure — noted, not decoded.
      r.depth++;
      r.group('program_config_element()', 'not decoded — channelConfiguration == 0, layout is in-band');
      r.depth--;
    }
    if (aot === 6 || aot === 20) r.u('layerNr', 3);
    if (extensionFlag && !r.overrun && r.bitsLeft() >= 8) {
      if (aot === 22) {
        r.u('numOfSubFrame', 5);
        r.u('layer_length', 11);
      }
      if (aot === 17 || aot === 19 || aot === 20 || aot === 23) {
        r.flag('aacSectionDataResilienceFlag');
        r.flag('aacScalefactorDataResilienceFlag');
        r.flag('aacSpectralDataResilienceFlag');
      }
      var ext3 = r.flag('extensionFlag3', 'reserved, must be 0');
      if (ext3) r.group('// extensionFlag3 tail is "tbd" in 14496-3 — not decoded');
    } else if (extensionFlag) {
      r.group('// extensionFlag set but no bits left — tail not decoded');
    }
    r.depth--;
    return frameLength;
  }

  /**
   * @param {Uint8Array} data  buffer holding the config (esds DecoderSpecificInfo,
   *                           FLV/Matroska CodecPrivate, …)
   * @param {number} start     offset of the config inside `data`
   * @param {number} len       config length in bytes (default: to the end)
   * @param {number} base      absolute file offset of data[0] (default 0)
   * @returns {{table, rows, info}}
   */
  function parseAudioSpecificConfig(data, start, len, base) {
    start = start || 0;
    var end = len == null ? data.length : Math.min(data.length, start + len);
    var r = reader(data, start, Math.max(0, end - start), base || 0);
    var info = { configBytes: Math.max(0, end - start) };
    try {
      info.audioObjectType = getAudioObjectType(r);
      var sr = samplingFrequency(r, 'samplingFrequencyIndex', 'samplingFrequency');
      info.samplingFrequencyIndex = sr.index;
      info.sampleRate = sr.hz;

      var chCfg = r.u('channelConfiguration', 4);
      r.note(channelConfigName(chCfg));
      info.channelConfiguration = chCfg;
      info.channels = channelsOf(chCfg);
      info.channelLayout = channelConfigName(chCfg);

      info.extensionAudioObjectType = 0;
      info.sbrPresentFlag = false;
      info.psPresentFlag = false;
      info.extensionSampleRate = 0;

      var aot = info.audioObjectType;

      /* ---- SBR / PS explicit signalling + backward compatible re-config ---- */
      if (aot === 5 || aot === 29) {
        r.depth++;
        r.group('// SBR (and PS) explicit signalling');
        // extensionAudioObjectType / sbrPresentFlag / psPresentFlag are implied
        // by the object type here; only the sampling rate is on the wire.
        info.extensionAudioObjectType = 5;
        info.sbrPresentFlag = true;
        if (aot === 29) info.psPresentFlag = true;
        var extSr = samplingFrequency(r, 'extensionSamplingFrequencyIndex',
          'extensionSamplingFrequency');
        info.extensionSampleRate = extSr.hz;
        info.extensionSamplingFrequencyIndex = extSr.index;
        aot = getAudioObjectType(r);
        info.effectiveAudioObjectType = aot;
        if (aot === 22) r.u('extensionChannelConfiguration', 4);
        r.depth--;
      } else {
        info.effectiveAudioObjectType = aot;
      }

      /* ---- object type specific config ---- */
      if (GA_AOTS.indexOf(aot) >= 0) {
        info.frameLength = gaSpecificConfig(r, aot, chCfg, info);
      } else if (aot === 8) {
        r.depth++;
        r.group('CELPSpecificConfig()', 'not decoded — CELP excitation is signalled per frame');
        r.depth--;
        info.frameLength = 0;
      } else if (aot === 39) {
        r.depth++;
        r.group('// ER AAC ELD config (14496-3 §1.6.2.1 ELDSpecificConfig) — not decoded');
        r.depth--;
        info.frameLength = 512;
      } else if (aot === 42) {
        r.depth++;
        r.group('// USACConfig() — not decoded');
        r.depth--;
        info.frameLength = 0;
      } else {
        r.depth++;
        r.group('// no specific config decoded for ' + aotName(aot));
        r.depth--;
        info.frameLength = 1024;
      }

      /* ---- epConfig, present for the ER object types only ---- */
      if (EP_CONFIG_AOTS.indexOf(aot) >= 0 && !r.overrun && r.bitsLeft() >= 2) {
        r.depth++;
        r.group('// error protection config (aot ' + aot + ')');
        var ep = r.u('epConfig', 2);
        r.note(['no error protection', 'reserved', 'error protection (ErrorProtectionSpecificConfig)',
                'error protection + directMapping'][ep] || '');
        if (ep === 2 || ep === 3) {
          r.group('ErrorProtectionSpecificConfig()', 'not decoded');
        }
        if (ep === 3) r.u('directMapping', 1);
        r.depth--;
        info.epConfig = ep;
      }

      /* ---- trailing sync extension: implicit SBR / PS signalling ---- */
      if (!r.overrun && r.bitsLeft() >= 16) {
        var syncExt = r.u('syncExtensionType', 11, '0x2B7 signals backward compatible SBR/PS');
        r.note(syncExt === 0x2b7 ? '0x2B7 — backward compatible SBR/PS extension'
                                 : 'unknown extension, ignored');
        if (syncExt === 0x2b7) {
          r.depth++;
          var extAot = getAudioObjectType(r);
          info.extensionAudioObjectType = extAot;
          if (extAot === 5) {
            var sbr = r.flag('sbrPresentFlag');
            info.sbrPresentFlag = !!sbr;
            if (sbr) {
              var esr = samplingFrequency(r, 'extensionSamplingFrequencyIndex',
                'extensionSamplingFrequency');
              info.extensionSamplingFrequencyIndex = esr.index;
              info.extensionSampleRate = esr.hz;
              if (!r.overrun && r.bitsLeft() >= 12) {
                var psSync = r.u('syncExtensionType', 11, '0x548 signals PS');
                r.note(psSync === 0x548 ? '0x548 — PS extension' : 'unknown, ignored');
                if (psSync === 0x548) info.psPresentFlag = !!r.flag('psPresentFlag');
              }
            }
          }
          r.depth--;
        }
      }

      info.sampleRate = info.sampleRate || 0;
      info.outputSampleRate = info.extensionSampleRate || info.sampleRate;
      info.presentedChannels = info.channels || channelsOf(chCfg);
      info.aotName = aotName(info.audioObjectType) +
        (info.psPresentFlag ? ' + PS' : (info.sbrPresentFlag ? ' + SBR' : ''));

      return {
        table: synSection('AudioSpecificConfig()',
          'ISO/IEC 14496-3 §1.6.2.1 — ' + info.aotName +
          (info.configBytes ? ', ' + info.configBytes + ' bytes' : ''), r.rows),
        rows: r.rows,
        info: info
      };
    } catch (e) {
      return {
        table: synSection('AudioSpecificConfig()', 'partial — parse error', r.rows),
        rows: r.rows,
        info: info,
        error: String(e && e.message || e)
      };
    }
  }

  /* ======================================================================
   * ADTS transport header — ISO/IEC 14496-3 §1.A.3.2
   * ====================================================================*/

  /**
   * adts_fixed_header() + adts_variable_header() + adts_error_check().
   *
   * @param {Uint8Array} data full buffer
   * @param {number} off  offset of the first sync byte
   * @param {number} end  offset one past the last readable byte (default: EOF)
   * @param {number} base absolute file offset of data[0] (default 0)
   * @returns {{table, info, headerLength, frameLength}}
   */
  function parseADTSHeader(data, off, end, base) {
    off = off || 0;
    end = end == null ? data.length : Math.min(end, data.length);
    var avail = Math.max(0, Math.min(end - off, 9));    // 7 (or 9 with CRC) bytes max
    var out = { table: null, info: {}, headerLength: 7, frameLength: 0, error: null };
    if (avail < 7) {
      out.error = 'buffer too short for an ADTS header (' + avail + ' bytes)';
      out.table = synSection('adts_fixed_header()', out.error, [
        { name: 'bytes_available', syntax: '', bits: avail * 8, value: avail,
          note: 'need at least 7', offset: off, depth: 0 }
      ]);
      return out;
    }
    var r = reader(data, off, avail, base || 0);
    var info = out.info;
    try {
      var sync = r.u('syncword', 12, 'must be 0xFFF');
      if (sync !== 0xfff) {
        r.note('sync mismatch — not an ADTS header');
        out.table = synSection('adts_fixed_header()', 'sync mismatch', r.rows);
        out.error = 'bad ADTS syncword ' + MA.hex(sync, 3);
        return out;
      }
      var id = r.flag('ID', '0 = MPEG-4 (14496-3), 1 = MPEG-2 (13818-7)');
      info.mpegVersion = id ? 'MPEG-2' : 'MPEG-4';
      var layer = r.u('layer', 2, 'must be 0b00 for AAC');
      if (layer !== 0) r.note('non-zero layer — not an AAC ADTS header');
      var protectionAbsent = r.flag('protection_absent', '1 = no CRC, 0 = adts_error_check() follows');
      info.protectionAbsent = !!protectionAbsent;
      var profile = r.u('profile', 2);
      var aot = profile + 1;
      r.note(profile + ' -> audioObjectType ' + aot + ' (' + aotName(aot) + ')');
      info.profile = profile;
      info.audioObjectType = aot;
      info.aotName = aotName(aot);

      var sr = samplingFrequency(r, 'sampling_frequency_index', 'sampling_frequency');
      info.samplingFrequencyIndex = sr.index;
      info.sampleRate = sr.hz;
      if (!sr.hz) r.note('reserved/invalid index — ADTS has no explicit rate field');

      r.flag('private_bit');
      var chCfg = r.u('channel_configuration', 3);
      r.note(channelConfigName(chCfg));
      info.channelConfiguration = chCfg;
      info.channels = channelsOf(chCfg);
      info.channelLayout = channelConfigName(chCfg);
      r.flag('original_copy');
      r.flag('home');

      /* ---- adts_variable_header() ---- */
      info.copyrightIdentificationBit = r.flag('copyright_identification_bit');
      info.copyrightIdentificationStart = r.flag('copyright_identification_start');
      var frameLength = r.u('aac_frame_length', 13, 'whole frame, header bytes included');
      var fullness = r.u('adts_buffer_fullness', 11,
        '0x7FF = VBR, 0 = CBR with a full buffer, else buffer level');
      info.bufferFullness = fullness;
      info.vbr = fullness === 0x7ff;
      var rawBlocks = r.u('number_of_raw_data_blocks_in_frame', 2, '0 means one raw_data_block()');
      info.rawDataBlocks = rawBlocks + 1;
      if (!protectionAbsent) {
        r.depth++;
        r.group('adts_error_check()');
        r.u('crc_check', 16, 'CRC over the header and the raw data blocks');
        r.depth--;
      }

      info.frameLength = frameLength;
      info.blocks = rawBlocks + 1;
      info.headerLength = 7 + (protectionAbsent ? 0 : 2);
      info.samplesPerFrame = 1024;
      // The duration of a frame is 1024 samples per raw_data_block; for an SBR
      // (HE-AAC) stream represented by this core rate the output is twice that.
      info.duration = info.sampleRate > 0
        ? info.blocks * 1024 / info.sampleRate : 0;

      out.headerLength = info.headerLength;
      out.frameLength = frameLength;
      out.table = synSection('adts_frame_header()',
        info.mpegVersion + ' ' + info.aotName + ', ' + MA.formatHz(info.sampleRate) +
        ', ' + channelConfigName(chCfg) + ', ' + frameLength + ' bytes',
        r.rows);
      return out;
    } catch (e) {
      out.error = String(e && e.message || e);
      out.table = synSection('adts_frame_header()', 'partial — parse error', r.rows);
      return out;
    }
  }

  /** Scan for the next plausible ADTS sync at or after `from` (bounded). */
  function findSync(data, from, end) {
    var limit = Math.min(end - 1, from + RESYNC_WINDOW);
    for (var i = Math.max(0, from); i < limit; i++) {
      // 12-bit syncword 0xFFF plus the mandatory layer == 00.
      if (data[i] === 0xff && (data[i + 1] & 0xf6) === 0xf0) return i;
    }
    return -1;
  }

  /**
   * Walk a whole ADTS elementary stream (.aac).
   *
   * Frames are chained on aac_frame_length; a damaged header triggers a bounded
   * resync scan instead of a resynchronisation storm.
   *
   * @returns {{tables, frames, track, info}}
   */
  function analyzeStream(data, ctx) {
    ctx = ctx || {};
    var tables = [], frames = [], info = {};
    var start = ctx.start || 0;

    // Some encoders put an ID3v2 tag in front of the ADTS stream.
    if (data.length > start + 10 &&
        data[start] === 0x49 && data[start + 1] === 0x44 && data[start + 2] === 0x33) {
      var tagSize = ((data[start + 6] & 0x7f) << 21) | ((data[start + 7] & 0x7f) << 14) |
                    ((data[start + 8] & 0x7f) << 7) | (data[start + 9] & 0x7f);
      info.id3v2Size = 10 + tagSize;
      start = Math.min(data.length, start + 10 + tagSize);
    }

    var pos = findSync(data, start, data.length);
    if (pos < 0) {
      info.error = 'no ADTS syncword found';
      return { tables: tables, frames: frames, track: null, info: info };
    }
    if (pos > start) info.skippedBytes = pos - start;

    var resyncs = 0, truncated = 0, chained = 0;
    var sampleRate = 0, channels = 0, aot = 0, chCfg = 0;
    var totalBytes = 0, totalDuration = 0;

    while (pos + 7 <= data.length && frames.length < MAX_FRAMES) {
      var h = parseADTSHeader(data, pos, data.length, 0);
      var flen = h.frameLength;
      if (h.error || flen < h.headerLength || flen <= 0) {
        var next = findSync(data, pos + 1, data.length);
        if (next < 0) break;
        resyncs++;
        pos = next;
        continue;
      }
      if (pos + flen > data.length) {
        truncated = flen - (data.length - pos);
        flen = data.length - pos;              // keep the tail as a short frame
      }
      var fi = h.info;
      if (!sampleRate && fi.sampleRate) sampleRate = fi.sampleRate;
      if (!channels && fi.channels) channels = fi.channels;
      if (!chCfg && fi.channelConfiguration) chCfg = fi.channelConfiguration;
      if (!aot) aot = fi.audioObjectType;
      var duration = fi.duration || 0;
      totalBytes += flen;
      totalDuration += duration;

      var syntax = { codec: 'aac', kind: 'adts', base: pos, offset: pos, size: flen };
      if (h.table && tables.length < SYNTAX_FRAME_LIMIT) {
        syntax._cached = h.table;
        tables.push(h.table);
      }

      frames.push({
        index: frames.length,
        type: 'audio',
        keyframe: true,                        // every ADTS frame is self contained
        codec: 'aac',
        offset: pos,
        size: flen,
        sampleRate: fi.sampleRate,
        channels: fi.channels,
        blocks: fi.blocks,
        duration: duration,
        bitrate: duration > 0 ? Math.round(flen * 8 / duration) : null,
        syntax: syntax
      });
      pos += flen;
      if (truncated) break;
    }

    // Verify the chain: offset + size must land exactly on the next frame.
    for (var i = 0; i + 1 < frames.length; i++) {
      if (frames[i].offset + frames[i].size === frames[i + 1].offset) chained++;
    }

    if (frames.length >= MAX_FRAMES && pos + 7 <= data.length) {
      info.frameCapReached = true;
    }

    info.frameCount = frames.length;
    info.chainedFrames = chained;
    info.resyncs = resyncs;
    info.truncatedBytes = truncated;
    info.totalBytes = totalBytes;
    info.sampleRate = sampleRate;
    info.channels = channels;
    info.channelConfiguration = chCfg;
    info.channelLayout = channelConfigName(chCfg);
    info.audioObjectType = aot;
    info.aotName = aotName(aot);
    info.durationSec = totalDuration;
    info.bitrate = totalDuration > 0 ? Math.round(totalBytes * 8 / totalDuration) : null;

    var track = {
      id: 1, type: 'audio', codec: 'aac',
      codecName: 'AAC (ADTS)',
      profile: aotName(aot),
      sampleRate: sampleRate,
      channels: channels,
      channelLayout: channelConfigName(chCfg),
      bitDepth: null,
      sampleCount: frames.length * 1024,
      frameCount: frames.length,
      durationSec: totalDuration,
      bitrate: info.bitrate
    };
    return { tables: tables, frames: frames, track: track, info: info };
  }

  // The task-facing name for the whole-file .aac walk.
  var parseADTSStream = analyzeStream;

  /* ======================================================================
   * Sample syntax for container-delivered access units
   * ====================================================================*/

  /**
   * Syntax table(s) for one AAC access unit out of MP4/MKV/FLV.
   *
   * AAC has no per-frame header. Everything after the AudioSpecificConfig is a
   * raw_data_block() whose element types (SCE/CPE/CCE/LFE/DSE/PCE/FIL) and
   * Huffman codebooks live inside the entropy-coded payload, so there is no
   * field list to show without a full decoder. Rather than inventing fields,
   * this reports the access-unit boundary and echoes the out-of-band
   * configuration that actually governs the payload.
   *
   * @param {Uint8Array} payload sample bytes
   * @param {object} spec { base, size, asc, ascBase, ascInfo, sampleRate,
   *                        channels, frameLength, blocks }
   * @returns {Array} tables
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var base = spec.base || 0;
    var n = payload ? payload.length : 0;
    var rows = [];
    var cfg = spec.ascInfo || spec.info || {};
    var i;

    rows.push({
      name: 'access_unit()', syntax: '', bits: '', value: '',
      note: 'one AAC access unit as framed by the container (no in-band header)',
      offset: base, depth: 0, group: true
    });
    rows.push({
      name: 'access_unit_size', syntax: '', bits: n * 8, value: n + ' bytes',
      note: 'from the container sample table (stsz/stts, BlockAdditions, …)',
      offset: base, depth: 1
    });
    rows.push({
      name: 'raw_data_block()', syntax: '', bits: '', value: '',
      note: 'entropy coded: SCE/CPE/CCE/LFE/DSE/PCE/FIL elements are id_syn_ele coded ' +
            'in the bitstream — not decodable without a full AAC decoder',
      offset: base, depth: 1, group: true
    });

    // Enumerate the configuration values that are known out of band.
    var cfgRows = [
      ['audioObjectType', cfg.audioObjectType, aotName(cfg.audioObjectType)],
      ['samplingFrequencyIndex', cfg.samplingFrequencyIndex,
        cfg.sampleRate ? MA.formatHz(cfg.sampleRate) : ''],
      ['channelConfiguration', cfg.channelConfiguration,
        channelConfigName(cfg.channelConfiguration)],
      ['frameLengthFlag', cfg.frameLength === 960 ? 1 : (cfg.frameLength ? 0 : undefined),
        cfg.frameLength ? cfg.frameLength + ' samples/frame' : '']
    ];
    var shown = false;
    for (i = 0; i < cfgRows.length; i++) {
      var row = cfgRows[i];
      if (row[1] == null) continue;
      if (!shown) {
        rows.push({
          name: '// AudioSpecificConfig (out of band)', syntax: '', bits: '', value: '',
          note: 'carried by esds/CodecPrivate, not by this sample', offset: -1,
          depth: 1, group: true
        });
        shown = true;
      }
      rows.push({
        name: 'AudioSpecificConfig.' + row[0], syntax: '', bits: '', value: row[1],
        note: row[2] || '', offset: -1, depth: 2
      });
    }
    if (!shown) {
      rows.push({
        name: '// AudioSpecificConfig', syntax: '', bits: '', value: '',
        note: 'not supplied — pass spec.asc / spec.ascInfo to decode it here',
        offset: -1, depth: 1, group: true
      });
    }

    var tables = [synSection('raw_data_block()',
      'AAC access unit, ' + n + ' bytes — no per-frame syntax elements to show', rows)];

    // When the container also hands us the config bytes, decode them alongside.
    if (spec.asc && spec.asc.length) {
      var asc = parseAudioSpecificConfig(spec.asc, 0, spec.asc.length,
        spec.ascBase == null ? -1 : spec.ascBase);
      asc.table.title = 'AudioSpecificConfig() (out of band)';
      tables.push(asc.table);
    }
    return tables;
  }

  /* ======================================================================
   * Registration
   * ====================================================================*/

  MA.registerCodec('aac', {
    id: 'aac',
    name: 'AAC (MPEG-4 Audio)',
    sampleRates: SAMPLE_RATES,
    objectTypes: AOT_NAMES,
    channelConfig: CHANNEL_CONFIG,
    aotName: aotName,
    channelConfigName: channelConfigName,
    parseAudioSpecificConfig: parseAudioSpecificConfig,
    parseADTSHeader: parseADTSHeader,
    parseADTSStream: parseADTSStream,
    analyzeStream: analyzeStream,
    buildSampleSyntax: buildSampleSyntax
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
