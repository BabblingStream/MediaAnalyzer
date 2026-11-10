/* ============================================================================
 * MediaAnalyzer — codecs/mp3.js
 *
 * MPEG-1 / MPEG-2 / MPEG-2.5 Audio Layer I, II and III.
 *
 *   ISO/IEC 11172-3   MPEG-1 audio frame header, side information, CRC
 *   ISO/IEC 13818-3   MPEG-2 (LSF) audio frame header, side information
 *   id3.org           ID3v2.2 / v2.3 / v2.4 tags and the ID3v1 tail tag
 *   Xing / Info + LAME extension, Fraunhofer VBRI header
 *
 * Every parsed structure is emitted as a syntax table whose rows mirror the
 * spec text (field / syntax / bits / value / meaning), so the frame panel can
 * show exactly what the bitstream says. `offset` on a row is the absolute file
 * offset the element starts in, which is what the hex view links to; a row
 * with offset -1 has no byte to point at.
 *
 * `base` arguments are always "absolute file offset of data[0]" (0 when the
 * whole file is passed in).
 *
 * Entry points
 *   parseFrameHeader(data, off, base)          one MPEG audio frame header
 *   parseSideInfo(data, off, header, base)     Layer III side information
 *   parseID3v2(data, off, base)                ID3v2 tag + frame list
 *   parseID3v1(data, base)                     ID3v1 (128 byte tail)
 *   parseXing(data, off, base)                 Xing / Info / LAME / VBRI
 *   analyzeStream(data, ctx)                   whole .mp3 file
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, synSection = MA.synSection;

  /* ---------------------------------------------------------------- tables */

  /** version bits (11..10): 0 = MPEG-2.5 (unofficial extension), 1 = reserved. */
  var VERSION_NAME = { 0: 'MPEG-2.5', 1: 'reserved', 2: 'MPEG-2', 3: 'MPEG-1' };
  var VERSION_SHORT = { 3: 'MPEG-1', 2: 'MPEG-2', 0: 'MPEG-2.5' };

  /** layer bits (9..8): 0 = reserved, 1 = Layer III, 2 = Layer II, 3 = Layer I. */
  var LAYER_BITS_NAME = { 0: 'reserved', 1: 'Layer III', 2: 'Layer II', 3: 'Layer I' };

  /**
   * bitrate_index -> kbps, per (version family, layer number).
   * Index 0 = "free format", index 15 = invalid. Key is `versionKey-layer`.
   * Version key '1' = MPEG-1, '2' = MPEG-2 and MPEG-2.5 (the LSF tables).
   */
  var BITRATES = {
    '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448, 0],
    '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384, 0],
    '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0],
    '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256, 0],
    '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0],
    '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]
  };

  /** sampling_frequency (2 bits) per version. */
  var SAMPLE_RATES = {
    3: [44100, 48000, 32000],
    2: [22050, 24000, 16000],
    0: [11025, 12000, 8000]
  };

  var CHANNEL_MODES = [
    'Stereo', 'Joint stereo', 'Dual channel (two independent mono channels)',
    'Single channel (mono)'
  ];
  var MODE_EXT_L12 = [
    'bound = 4 (subbands 4-31 in intensity stereo)',
    'bound = 8 (subbands 8-31 in intensity stereo)',
    'bound = 12 (subbands 12-31 in intensity stereo)',
    'bound = 16 (subbands 16-31 in intensity stereo)'
  ];
  var EMPHASIS = ['none', '50/15 ms', 'reserved', 'CCITT J.17'];
  var BLOCK_TYPES = ['normal (long blocks)', 'start block', 'three short blocks (window switching)',
    'end block'];
  var SCFSI_NAMES = ['scalefactors from granule 0', 'scalefactors shared with granule 0'];

  /** ID3v1 genre list (0..191; 148..191 are the Winamp extensions). */
  var GENRES = [
    'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop',
    'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock',
    'Techno', 'Industrial', 'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack',
    'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance',
    'Classical', 'Instrumental', 'Acid', 'House', 'Game', 'Sound Clip', 'Gospel', 'Noise',
    'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop',
    'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial', 'Electronic',
    'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta',
    'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret',
    'New Wave', 'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal',
    'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock',
    'Folk', 'Folk-Rock', 'National Folk', 'Swing', 'Fast Fusion', 'Bebob', 'Latin',
    'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock',
    'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus',
    'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music',
    'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam',
    'Club', 'Tango', 'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul',
    'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House',
    'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House', 'Hardcore Techno', 'Terror',
    'Indie', 'BritPop', 'Negerpunk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap',
    'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian', 'Christian Rock',
    'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'Jpop', 'Synthpop', 'Abstract',
    'Art Rock', 'Baroque', 'Bhangra', 'Big Beat', 'Breakbeat', 'Chillout', 'Downtempo',
    'Dub', 'EBM', 'Eclectic', 'Electro', 'Electroclash', 'Emo', 'Experimental', 'Garage',
    'Global', 'IDM', 'Illbient', 'Industro-Goth', 'Jam Band', 'Krautrock', 'Leftfield',
    'Lounge', 'Math Rock', 'New Romantic', 'Nu-Breakz', 'Post-Punk', 'Post-Rock',
    'Psytrance', 'Shoegaze', 'Space Rock', 'Trop Rock', 'World Music', 'Neoclassical',
    'Audiobook', 'Audio Theatre', 'Neue Deutsche Welle', 'Podcast', 'Indie Rock',
    'G-Funk', 'Dubstep', 'Garage Rock', 'Psybient'
  ];
  function genreName(g) {
    if (g === 255) return 'none';
    return GENRES[g] || ('genre ' + g);
  }

  /** LAME "VBR method" nibble from the info tag. */
  var VBR_METHODS = {
    0: 'unknown', 1: 'CBR', 2: 'ABR', 3: 'VBR (old/rh)', 4: 'VBR (new/mtrh)',
    5: 'VBR (mt)', 6: 'VBR (rh, 2 pass)', 7: 'VBR (mtrh, 2 pass)',
    8: 'CBR (2 pass)', 9: 'ABR (2 pass)'
  };

  /* Caps — a corrupt count must never be able to spin the parser. */
  var MAX_FRAMES = 400000;
  var SYNTAX_FRAME_LIMIT = 8;      // first N frames keep their syntax tables
  var MAX_ID3_FRAMES = 32;         // frames listed from an ID3v2 tag
  var SYNC_SCAN = 1 << 20;         // bytes searched for the first / next sync

  /**
   * SyntaxReader over a byte range, with emulation-prevention removal disabled.
   * The EPB rule only exists inside H.26x RBSPs; leaving it on (the default)
   * would silently swallow 00 00 03 sequences in MPEG payloads and shift every
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

  /* ======================================================================
   * Frame header — ISO/IEC 11172-3 §2.4.1.3 / 13818-3 §2.4.3
   * ====================================================================*/

  /** Samples per frame: Layer I 384, Layer II 1152, Layer III 1152 (LSF: 576). */
  function samplesPerFrame(versionBit, layer) {
    if (layer === 1) return 384;
    if (layer === 2) return 1152;
    return versionBit === 3 ? 1152 : 576;
  }

  /**
   * Frame length in bytes.
   *
   * util.js ships MA.mpegFrameLength() (js/detector.js), which agrees with this
   * for MPEG-1 but (a) accepts the reserved version bits 11 and (b) always uses
   * the MPEG-1 "144" factor, so MPEG-2/2.5 Layer III frames come out twice too
   * large there. This is the spec-correct version, used as the primary value
   * with MA.mpegFrameLength() only as a cross-check note for MPEG-1:
   *   Layer I       N = (12 * bitrate / sampleRate + padding) * 4   (4-byte slots)
   *   Layer II/III  N = samplesPerFrame / 8 * bitrate / sampleRate + padding
   */
  function computeFrameLength(versionBit, layer, bitrateKbps, sampleRate, padding) {
    if (!bitrateKbps || !sampleRate) return 0;
    var br = bitrateKbps * 1000;
    if (layer === 1) return Math.floor((12 * br / sampleRate + padding) * 4);
    return Math.floor(samplesPerFrame(versionBit, layer) / 8 * br / sampleRate) + padding;
  }

  function sideInfoBytes(versionBit, channelMode) {
    var mono = channelMode === 3;
    if (versionBit === 3) return mono ? 17 : 32;
    return mono ? 9 : 17;
  }

  function modeExtensionName(layer, v) {
    if (layer === 3) {
      return 'intensity stereo ' + ((v & 1) ? 'on' : 'off') +
             ', MS stereo ' + ((v & 2) ? 'on' : 'off');
    }
    return MODE_EXT_L12[v] || 'reserved';
  }

  /** Table select / Huffman codebook name; 4 and 14 are reserved. */
  function codebookName(t) {
    if (t === 0) return 'codebook 0 (all zero)';
    if (t === 4 || t === 14) return 'codebook ' + t + ' (reserved)';
    return 'codebook ' + t;
  }

  /**
   * @param {Uint8Array} data full buffer
   * @param {number} off  index of the first sync byte
   * @param {number} base absolute file offset of data[0]
   * @returns {{table, rows, info}}
   */
  function parseFrameHeader(data, off, base) {
    off = off || 0;
    var avail = Math.max(0, Math.min(data.length - off, 6));
    var out = { table: null, rows: null, info: { offset: (base || 0) + off }, error: null };
    if (avail < 4) {
      out.error = 'buffer too short for a frame header';
      out.rows = [];
      out.table = synSection('MPEG audio frame header()', out.error, []);
      return out;
    }
    var r = reader(data, off, avail, base);
    var info = out.info;
    out.rows = r.rows;
    try {
      var sync = r.u('syncword', 11, 'must be 0b11111111111');
      if (sync !== 0x7ff) {
        r.note('sync mismatch — not an MPEG audio frame header');
        out.table = synSection('MPEG audio frame header()', 'sync mismatch', r.rows);
        out.error = 'bad MPEG audio sync ' + MA.hex(sync, 3);
        return out;
      }
      var versionBit = r.u('version (ID)', 2);
      var versionName = VERSION_NAME[versionBit];
      r.note(versionName + (versionBit === 1 ? ' — invalid' : ''));
      // detector.js's mpegFrameLength() does not reject the reserved value.
      if (versionBit === 1) {
        out.error = 'reserved MPEG version bits (11) — the frame must be rejected';
        out.table = synSection('MPEG audio frame header()', out.error, r.rows);
        return out;
      }
      var layerBits = r.u('layer', 2);
      var layer = 4 - layerBits;                     // 1 = Layer I, 2 = II, 3 = III
      r.note(LAYER_BITS_NAME[layerBits] + (layerBits === 0 ? ' — invalid' : ''));
      if (layerBits === 0) {
        out.error = 'reserved layer bits (00) — the frame must be rejected';
        out.table = synSection('MPEG audio frame header()', out.error, r.rows);
        return out;
      }
      var protectionBit = r.flag('protection_bit',
        '0 = CRC-16 (16 bits) follows the header, 1 = no CRC');
      var brIdx = r.u('bitrate_index', 4);
      var versionKey = versionBit === 3 ? '1' : '2';
      var brTable = BITRATES[versionKey + '-' + layer];
      var bitrate = brTable ? brTable[brIdx] : 0;
      r.note(brIdx === 0 ? 'free format (bitrate must be found from the frame size)'
        : brIdx === 15 ? 'invalid'
        : bitrate + ' kbps');
      if (brIdx === 0 || brIdx === 15) {
        out.error = brIdx === 0 ? 'free format bitrate is not supported'
                                : 'invalid bitrate index (1111)';
        out.info.bitrateIndex = brIdx;
        out.table = synSection('MPEG audio frame header()', out.error, r.rows);
        // keep going for the note, but the frame cannot be sized
      }
      var srIdx = r.u('sampling_frequency', 2);
      var srTable = SAMPLE_RATES[versionBit] || [];
      var sampleRate = srTable[srIdx] || 0;
      r.note(srIdx === 3 ? 'reserved' : MA.formatHz(sampleRate));
      var padding = r.flag('padding_bit', layer === 1 ? 'extra 4-byte slot'
                                                      : 'extra byte (must be 0 for MPEG-2.5)');
      r.flag('private_bit');
      var channelMode = r.u('channel_mode', 2);
      r.note(CHANNEL_MODES[channelMode]);
      var modeExt = r.u('mode_extension', 2);
      r.note(channelMode === 1 ? modeExtensionName(layer, modeExt) : 'not meaningful here');
      var copyright = r.flag('copyright');
      var original = r.flag('original');
      var emphasis = r.u('emphasis', 2);
      r.note(EMPHASIS[emphasis]);

      var spf = samplesPerFrame(versionBit, layer);
      var frameLength = srIdx === 3 ? 0
        : computeFrameLength(versionBit, layer, bitrate, sampleRate, padding);

      var lengthRow = r.rows.length;
      r.group('// derived from the header fields');
      r.rows.push({
        name: 'frame_length', syntax: '', bits: '', value: frameLength + ' bytes',
        note: layer === 1
          ? 'floor((12 * ' + bitrate + '000 / ' + sampleRate + ' + ' + padding + ') * 4)'
          : 'floor(' + (spf / 8) + ' * ' + bitrate + '000 / ' + sampleRate + ') + ' + padding,
        offset: (base || 0) + off, depth: r.depth
      });
      r.rows.push({
        name: 'samples_per_frame', syntax: '', bits: '', value: spf,
        note: layer === 3 && versionBit !== 3 ? 'MPEG-2/2.5 Layer III (LSF)'
          : 'Layer ' + (layer === 1 ? 'I' : layer === 2 ? 'II' : 'III'),
        offset: -1, depth: r.depth
      });
      // Cross-check against the helper util.js exports (js/detector.js).
      if (typeof MA.mpegFrameLength === 'function' && versionBit === 3 && frameLength) {
        var ref = MA.mpegFrameLength(data, off);
        r.rows.push({
          name: 'MA.mpegFrameLength() cross-check', syntax: '', bits: '', value: ref,
          note: ref === frameLength ? 'agrees' :
            'differs — that helper always applies the MPEG-1 factor and does not ' +
            'reject the reserved version bits',
          offset: -1, depth: r.depth
        });
      }
      void lengthRow;

      info.versionBits = versionBit;
      info.version = VERSION_SHORT[versionBit] || versionName;
      info.versionName = versionName;
      info.layerBits = layerBits;
      info.layer = layer;
      info.layerName = LAYER_BITS_NAME[layerBits];
      info.protection = protectionBit ? 'none' : 'CRC-16';
      info.crc = !protectionBit;
      info.bitrateIndex = brIdx;
      info.bitrateKbps = bitrate;
      info.bitrate = bitrate * 1000;
      info.sampleRateIndex = srIdx;
      info.sampleRate = sampleRate;
      info.padding = padding;
      info.channelMode = channelMode;
      info.channelModeName = CHANNEL_MODES[channelMode];
      info.channels = channelMode === 3 ? 1 : 2;
      info.modeExtension = modeExt;
      info.modeExtensionName = modeExtensionName(layer, modeExt);
      info.copyright = !!copyright;
      info.original = !!original;
      info.emphasis = EMPHASIS[emphasis];
      info.samplesPerFrame = spf;
      info.frameLength = frameLength;
      info.headerLength = 4 + (crc ? 0 : 0);        // 4 bytes; the CRC is 2 more
      info.crcBytes = protectionBit ? 0 : 2;
      info.sideInfoBytes = layer === 3 ? sideInfoBytes(versionBit, channelMode) : 0;
      info.duration = sampleRate > 0 ? spf / sampleRate : 0;
      info.bitrateBps = sampleRate > 0 && frameLength
        ? Math.round(frameLength * 8 / (spf / sampleRate)) : bitrate * 1000;

      out.table = synSection('MPEG audio frame header()',
        info.version + ' ' + info.layerName + ', ' +
        (bitrate ? bitrate + ' kbps' : 'bitrate N/A') + ', ' +
        MA.formatHz(sampleRate) + ', ' + info.channelModeName + ', ' +
        frameLength + ' bytes',
        r.rows);
      return out;
    } catch (e) {
      out.error = String(e && e.message || e);
      out.table = synSection('MPEG audio frame header()', 'partial — parse error', r.rows);
      return out;
    }
  }

  /* ======================================================================
   * Layer III side information
   * ====================================================================*/

  /**
   * side_info() — ISO/IEC 11172-3 §2.4.3.2 (MPEG-1, 2 granules) and
   * ISO/IEC 13818-3 §2.4.3.2 (MPEG-2/2.5 LSF, 1 granule, 9-bit
   * scalefac_compress, no scfsi, no preflag).
   *
   * @param {Uint8Array} data full buffer
   * @param {number} off  index of the first side-info byte (header + CRC)
   * @param {object} h    parsed frame header info
   * @param {number} base absolute file offset of data[0]
   * @returns {{table, rows, info}}
   */
  function parseSideInfo(data, off, h, base) {
    var nch = h.channels === 1 ? 1 : 2;
    var mpeg1 = h.versionBits === 3;
    var granules = mpeg1 ? 2 : 1;
    var bytes = sideInfoBytes(h.versionBits, h.channelMode);
    var r = reader(data, off, Math.max(0, Math.min(data.length - off, bytes)), base);
    var info = { offset: (base || 0) + off, mpeg1: mpeg1, granules: granules,
                 channels: nch, sideInfoBytes: bytes, granules_info: [] };
    try {
      r.depth++;
      r.group('side_info()' + (mpeg1 ? '' : '  // MPEG-2/2.5 LSF layout'));
      info.mainDataBegin = r.u('main_data_begin', mpeg1 ? 9 : 8,
        'bytes of main data that belong to this frame but precede it');
      r.note((info.mainDataBegin ? info.mainDataBegin + ' bytes from earlier frames — ' : '') +
        'reservoir start');
      r.u('private_bits', mpeg1 ? (nch === 1 ? 5 : 3) : (nch === 1 ? 1 : 2));

      if (mpeg1) {
        r.depth++;
        r.group('scfsi[ch][band] — scalefactor selection information');
        info.scfsi = [];
        for (var c = 0; c < nch; c++) {
          var row = [];
          for (var b = 0; b < 4; b++) {
            row.push(r.flag('scfsi[' + c + '][' + b + ']', SCFSI_NAMES[0]));
          }
          info.scfsi.push(row);
        }
        r.depth--;
      }

      for (var gr = 0; gr < granules; gr++) {
        r.depth++;
        r.group(mpeg1 ? 'granule ' + gr : 'granule 0 (LSF: one 576-sample granule)');
        for (var ch = 0; ch < nch; ch++) {
          r.depth++;
          r.group('channel ' + ch);
          var gi = { granule: gr, channel: ch };
          gi.part2_3_length = r.u('part2_3_length', 12,
            'bits of scalefactors and Huffman data for this channel');
          gi.big_values = r.u('big_values', 9, 'pairs of spectral values coded from the codebooks');
          r.note(gi.big_values * 2 + ' values');
          gi.global_gain = r.u('global_gain', 8);
          r.note('2^(global_gain-210)/4 quantiser step');
          gi.scalefac_compress = r.u('scalefac_compress', mpeg1 ? 4 : 9,
            mpeg1 ? 'selects the scalefactor band table' : 'LSF: up to 4 scalefactor sets');
          var wsf = r.flag('window_switching_flag');
          gi.window_switching = !!wsf;
          if (wsf) {
            gi.block_type = r.u('block_type', 2);
            r.note(BLOCK_TYPES[gi.block_type] || 'reserved');
            gi.mixed_block_flag = r.flag('mixed_block_flag',
              'short blocks 0-1 stay long (MPEG-1 only)');
            gi.table_select = [
              r.u('table_select[0]', 5), r.u('table_select[1]', 5)
            ];
            for (var ts = 0; ts < 2; ts++) {
              r.note('region ' + ts + ': ' + codebookName(gi.table_select[ts]));
            }
            gi.subblock_gain = [
              r.u('subblock_gain[0]', 3), r.u('subblock_gain[1]', 3),
              r.u('subblock_gain[2]', 3)
            ];
            for (var sg = 0; sg < 3; sg++) r.note('window ' + sg + ' gain');
            // With window switching the region counts are implied, not coded.
            gi.region0_count = (gi.block_type === 2 && !gi.mixed_block_flag) ? 8 : 7;
            gi.region1_count = 20 - gi.region0_count;
          } else {
            gi.table_select = [
              r.u('table_select[0]', 5), r.u('table_select[1]', 5), r.u('table_select[2]', 5)
            ];
            for (var t2 = 0; t2 < 3; t2++) {
              r.note('region ' + t2 + ': ' + codebookName(gi.table_select[t2]));
            }
            gi.region0_count = r.u('region0_count', 4);
            gi.region1_count = r.u('region1_count', 3);
          }
          if (mpeg1) {
            gi.preflag = r.flag('preflag', 'high frequency scalefactor pre-emphasis');
            gi.scalefac_scale = r.flag('scalefac_scale',
              '1 = scalefactors have a factor of 1 instead of 0.5');
          } else {
            gi.scalefac_scale = r.flag('scalefac_scale',
              '1 = scalefactors have a factor of 1 instead of 0.5');
            gi.preflag = 1;                          // implied for LSF
          }
          gi.count1table_select = r.flag('count1table_select',
            '1 = table B (2-bit quadruples)');
          info.granules_info.push(gi);
          r.depth--;
        }
        r.depth--;
      }

      if (!r.bitsLeft() || r.overrun) r.note('side info truncated');
      info.decodedBits = r.bitPos();

      return {
        table: synSection('side_info()',
          (mpeg1 ? 'MPEG-1, 2 granules' : 'MPEG-2/2.5 LSF, 1 granule') +
          ', ' + nch + ' ch, ' + bytes + ' bytes',
          r.rows),
        rows: r.rows, info: info
      };
    } catch (e) {
      return {
        table: synSection('side_info()', 'partial — parse error', r.rows),
        rows: r.rows, info: info, error: String(e && e.message || e)
      };
    }
  }

  /**
   * Frame header + Layer III side info in one call (what the panel shows for a
   * frame that is not the first one).
   */
  function parseFrame(data, off, end, ctx) {
    ctx = ctx || {};
    end = end == null ? data.length : Math.min(end, data.length);
    var tables = [], info = { offset: off, size: end - off };
    var h = parseFrameHeader(data, off, 0);
    if (h.table) tables.push(h.table);
    info.header = h.info;
    if (h.error) {
      info.error = h.error;
      return { tables: tables, info: info, error: h.error };
    }
    if (h.info.layer === 3 && h.info.frameLength) {
      var siOff = off + 4 + h.info.crcBytes;
      if (siOff + h.info.sideInfoBytes <= end) {
        var si = parseSideInfo(data, siOff, h.info, 0);
        if (si.table) tables.push(si.table);
        info.sideInfo = si.info;
      }
    }
    return { tables: tables, info: info };
  }

  /* ======================================================================
   * ID3v2 — id3.org specification (v2.2 / v2.3 / v2.4)
   * ====================================================================*/

  /** Syncsafe u(28): 4 bytes, 7 significant bits each. */
  function syncsafe(b0, b1, b2, b3) {
    return ((b0 & 0x7f) << 21) | ((b1 & 0x7f) << 14) | ((b2 & 0x7f) << 7) | (b3 & 0x7f);
  }
  function syncsafeValid(b0, b1, b2, b3) {
    return !(b0 & 0x80) && !(b1 & 0x80) && !(b2 & 0x80) && !(b3 & 0x80);
  }

  /** Undo the ID3v2 unsynchronisation scheme: FF 00 -> FF. */
  function deUnsynchronise(data, start, end) {
    var out = new Uint8Array(Math.max(0, end - start));
    var n = 0;
    for (var i = start; i < end; i++) {
      out[n++] = data[i];
      if (data[i] === 0xff && data[i + 1] === 0x00) i++;
    }
    return out.subarray(0, n);
  }

  /**
   * Strict decode helper: returns null when the bytes are not valid in `enc`.
   * TextDecoder is always present (browsers and Node >= 11).
   */
  function strictDecode(bytes, enc) {
    try {
      return new TextDecoder(enc, { fatal: true }).decode(bytes);
    } catch (e) {
      return null;
    }
  }

  /**
   * Decode a tag string that the specs call "ISO-8859-1". In practice
   * Chinese-authored MP3s write GBK into ID3v1 fields and into ID3v2
   * encoding-0 frames, so plain Latin-1 turns "克罗地亚狂想曲" into mojibake.
   *
   * Order: pure ASCII → as-is; valid UTF-8 → UTF-8; valid GBK with at least
   * one CJK char → GBK; otherwise Latin-1 (keeps é/ü tags intact).
   */
  function decodeTagBytes(data, start, end) {
    var stop = start;
    while (stop < end && data[stop] !== 0) stop++;
    if (stop <= start) return '';
    var ascii = true;
    for (var i = start; i < stop; i++) {
      if (data[i] >= 0x80) { ascii = false; break; }
    }
    if (ascii) return latin1(data, start, stop);

    var bytes = data.subarray(start, stop);
    var utf8 = strictDecode(bytes, 'utf-8');
    if (utf8 != null) return utf8;

    var gbk = strictDecode(bytes, 'gbk');
    if (gbk == null) gbk = strictDecode(bytes, 'gb18030');
    if (gbk != null && /[\u3400-\u9fff]/.test(gbk)) return gbk;

    return latin1(data, start, stop);
  }

  /** Decode a text frame body given its encoding byte (0 latin1, 1 UTF-16+BOM, 2 UTF-16BE, 3 UTF-8). */
  function decodeText(data, start, end, encoding) {
    if (end <= start) return '';
    var s = '';
    try {
      if (encoding === 0) return decodeTagBytes(data, start, end);
      if (encoding === 3) {
        s = new TextDecoder('utf-8').decode(data.subarray(start, end));
      } else if (encoding === 2) {
        s = new TextDecoder('utf-16be').decode(data.subarray(start, end));
      } else {
        var le = data[start] === 0xff && data[start + 1] === 0xfe;
        var be = data[start] === 0xfe && data[start + 1] === 0xff;
        var body = (le || be) ? data.subarray(start + 2, end) : data.subarray(start, end);
        s = new TextDecoder(be ? 'utf-16be' : 'utf-16le').decode(body);
      }
    } catch (e) { return ''; }
    var nul = s.indexOf('\0');
    return nul >= 0 ? s.slice(0, nul) : s;
  }

  /** Length of a NUL-terminated string at `start` for the given encoding. */
  function terminatorLength(data, start, end, encoding) {
    if (encoding === 0 || encoding === 3) {
      for (var i = start; i < end; i++) if (data[i] === 0) return 1;
      return 0;
    }
    for (var j = start; j + 1 < end; j += 2) {
      if (data[j] === 0 && data[j + 1] === 0) return 2;
    }
    return 0;
  }

  var TEXT_FRAME_KEYS = {
    TIT2: 'title', TT2: 'title', TPE1: 'artist', TP1: 'artist', TPE2: 'albumArtist',
    TP2: 'albumArtist', TALB: 'album', TAL: 'album', TYER: 'year', TYE: 'year',
    TDRC: 'year', TCON: 'genre', TCO: 'genre', TRCK: 'track', TRK: 'track',
    TCOM: 'composer', TCM: 'composer', TCOP: 'copyright', TCR: 'copyright',
    TPUB: 'publisher', TPB: 'publisher', TSSE: 'encoderSettings', TSS: 'encoderSettings',
    TENC: 'encodedBy', TEN: 'encodedBy'
  };

  /**
   * ID3v2 tag at `off`. Decodes the header, the extended header, the frame list
   * and the text of the frames whose encoding byte allows it.
   *
   * @param {Uint8Array} data full buffer
   * @param {number} off  index of the 'I' of "ID3"
   * @param {number} base absolute file offset of data[0]
   * @returns {{table, tables, rows, info}}
   */
  function parseID3v2(data, off, base) {
    off = off || 0;
    base = base || 0;
    var info = { offset: base + off, metadata: {}, frames: [] };
    var out = { table: null, tables: null, rows: null, info: info, error: null };
    if (off + 10 > data.length) {
      out.error = 'truncated ID3v2 header';
      out.rows = [];
      out.table = synSection('ID3v2 tag', out.error, []);
      out.tables = [out.table];
      return out;
    }
    var r = reader(data, off, 10, base);
    out.rows = r.rows;
    try {
      var idRow = r.rows.length;
      r.bytes('identifier', 3);
      r.rows[idRow].value = 'ID3';
      r.rows[idRow].note = 'magic "ID3"';
      var major = r.u('version', 8);
      var revision = r.u('revision', 8);
      r.note('2.' + major + '.' + revision);
      var flags = r.u('flags', 8, '');
      var unsync = (flags >> 7) & 1;
      var extHeader = (flags >> 6) & 1;
      var experimental = (flags >> 5) & 1;
      var footer = major >= 4 ? (flags >> 4) & 1 : 0;
      r.note('unsynchronisation ' + (unsync ? 'ON' : 'off') +
        ', extended header ' + (extHeader ? 'present' : 'absent') +
        ', experimental ' + (experimental ? 'yes' : 'no') +
        (major >= 4 ? ', footer ' + (footer ? 'present' : 'absent') : '') +
        (flags & 0x0f ? ', low bits reserved but set!' : ''));
      var size = r.u('size (syncsafe)', 28, 'tag size excluding the 10-byte header');
      var sizeOk = syncsafeValid(data[off + 6], data[off + 7], data[off + 8], data[off + 9]);
      if (!sizeOk) r.note('syncsafe bytes have their high bit set — the tag is damaged');
      info.version = '2.' + major + '.' + revision;
      info.major = major;
      info.revision = revision;
      info.flags = flags;
      info.unsynchronisation = !!unsync;
      info.extendedHeader = !!extHeader;
      info.experimental = !!experimental;
      info.footer = !!footer;
      info.size = size;
      info.totalSize = 10 + size + (footer ? 10 : 0);
      info.sizeValid = sizeOk;

      // The tag body may be unsynchronised; every offset below stays on the
      // original file positions, so only the *content* is de-unsynchronised.
      var body = off + 10;
      var bodyEnd = Math.min(data.length, body + size);
      if (bodyEnd <= body) {
        info.truncated = true;
        out.table = synSection('ID3v2 tag', info.version + ', empty', r.rows);
        out.tables = [out.table];
        return out;
      }
      var view = data;
      if (unsync) {
        view = deUnsynchronise(data, body, bodyEnd);
        r.group('// unsynchronisation applied: FF 00 -> FF over ' + (bodyEnd - body) + ' bytes');
      }

      var p = 0;                                   // offset inside `view`
      var viewEnd = view.length;

      /* ---- extended header ---- */
      if (extHeader && p + 6 <= viewEnd) {
        r.depth++;
        r.group('extended header');
        var extSize = major >= 4
          ? syncsafe(view[p], view[p + 1], view[p + 2], view[p + 3])
          : readU32(view, p);
        r.rows.push({
          name: 'extended_header_size', syntax: major >= 4 ? 'u(28) syncsafe' : 'u(32)',
          bits: 32, value: extSize, note: 'v2.4 includes itself, v2.3 does not',
          offset: base + body + p, depth: r.depth
        });
        var extBytes = major >= 4 ? extSize : extSize + 4;
        if (major >= 4) {
          var numFlagBytes = view[p + 4];
          r.rows.push({
            name: 'num_flag_bytes', syntax: 'u(8)', bits: 8, value: numFlagBytes,
            note: 'always 1 in v2.4', offset: base + body + p + 4, depth: r.depth
          });
          if (numFlagBytes > 0 && p + 6 <= viewEnd) {
            r.rows.push({
              name: 'extended_flags', syntax: 'u(8)', bits: 8, value: view[p + 5],
              note: 'tag is an update / CRC present / restrictions present',
              offset: base + body + p + 5, depth: r.depth
            });
          }
        } else if (p + 10 <= viewEnd) {
          r.rows.push({
            name: 'extended_flags', syntax: 'u(16)', bits: 16, value: (view[p + 4] << 8) | view[p + 5],
            note: 'CRC present / padding size present', offset: base + body + p + 4, depth: r.depth
          });
        }
        info.extendedHeaderSize = extBytes;
        p += Math.max(0, Math.min(extBytes, viewEnd - p));
        r.depth--;
      }

      /* ---- frame list ---- */
      r.depth++;
      r.group('frames');
      var idLen = major === 2 ? 3 : 4;
      var hdrLen = major === 2 ? 6 : 10;
      var guard = 0;
      while (p + hdrLen <= viewEnd && guard < 4096) {
        guard++;
        // The frame id is padded with NULs; a zero id means padding starts here.
        if (view[p] === 0) break;
        var id = '';
        for (var i = 0; i < idLen; i++) {
          var c = view[p + i];
          if (c < 32 || c > 126) { id = ''; break; }
          id += String.fromCharCode(c);
        }
        if (!id) break;
        var fsize, fflags = 0;
        if (major === 2) {
          fsize = (view[p + 3] << 16) | (view[p + 4] << 8) | view[p + 5];
        } else if (major === 4) {
          fsize = syncsafe(view[p + 4], view[p + 5], view[p + 6], view[p + 7]);
          fflags = (view[p + 8] << 8) | view[p + 9];
        } else {
          fsize = readU32(view, p + 4);
          fflags = (view[p + 8] << 8) | view[p + 9];
        }
        var bodyStart = p + hdrLen;
        if (fsize <= 0 || bodyStart + fsize > viewEnd) {
          r.rows.push({
            name: id, syntax: 'frame', bits: '', value: fsize + ' bytes',
            note: 'declared size runs past the tag — stopped', offset: base + body + p,
            depth: r.depth
          });
          break;
        }
        var listed = info.frames.length < MAX_ID3_FRAMES;
        var note = fsize + ' bytes';
        if (fflags) note += ', flags 0x' + MA.pad(fflags.toString(16), 4);
        if (listed) {
          var decoded = decodeFrame(view, bodyStart, bodyStart + fsize, id, info);
          if (decoded.text) note += ' — ' + truncate(decoded.text, 120);
          else if (decoded.note) note += ' — ' + decoded.note;
        } else {
          note += ' (not decoded)';
        }
        r.rows.push({
          name: id, syntax: 'frame', bits: fsize * 8,
          value: (MA.formatSize(fsize) || fsize + ' B'),
          note: note, offset: base + body + p, depth: r.depth
        });
        if (listed) {
          info.frames.push({ id: id, size: fsize, flags: fflags, offset: base + body + p,
                             text: decodeFrame(view, bodyStart, bodyStart + fsize, id, {}).text || null });
        }
        p = bodyStart + fsize;
      }
      r.depth--;
      if (guard >= 4096) info.frameCapReached = true;

      info.frameCount = info.frames.length;
      out.table = synSection('ID3v2 tag',
        info.version + ', ' + info.frames.length + ' frames, ' + size + ' bytes' +
        (unsync ? ', unsynchronised' : ''), r.rows);
      out.tables = [out.table];
      return out;
    } catch (e) {
      out.error = String(e && e.message || e);
      out.table = synSection('ID3v2 tag', 'partial — parse error', r.rows);
      out.tables = [out.table];
      return out;
    }
  }

  /** Decode one ID3v2 frame body into `meta.metadata` where meaningful. */
  function decodeFrame(view, start, end, id, meta) {
    var res = { text: '', note: '' };
    if (end <= start) return res;
    var enc = view[start];
    var meta0 = meta && meta.metadata ? meta.metadata : null;
    try {
      if (id.charAt(0) === 'T' && id !== 'TXXX') {
        res.text = decodeText(view, start + 1, end, enc);
        var key = TEXT_FRAME_KEYS[id] || id;
        if (meta0 && res.text) meta0[key] = res.text;
        return res;
      }
      if (id === 'TXXX') {
        var txxx = decodeText(view, start + 1, end, enc);
        res.text = txxx;
        if (meta0 && txxx) meta0['TXXX'] = txxx;
        return res;
      }
      if (id === 'COMM') {
        var lang = String.fromCharCode(view[start + 1], view[start + 2], view[start + 3]);
        var t1 = terminatorLength(view, start + 4, end, enc);
        var d = t1 ? decodeText(view, start + 4, end, enc) : '';
        var after = start + 4 + (t1 ? t1 + (d.length ? 0 : 0) : 0);
        // The description is NUL terminated; the text follows it.
        var descEnd = start + 4;
        while (descEnd < end) {
          if (enc === 0 || enc === 3) { if (view[descEnd] === 0) { descEnd++; break; } descEnd++; }
          else { if (view[descEnd] === 0 && view[descEnd + 1] === 0) { descEnd += 2; break; } descEnd += 2; }
        }
        res.text = decodeText(view, descEnd, end, enc);
        res.note = 'COMM [' + lang + ']';
        if (meta0 && res.text && !meta0.comment) meta0.comment = res.text;
        void after;
        return res;
      }
      if (id === 'APIC' || id === 'PIC') {
        var mime, picStart;
        if (id === 'PIC') {
          mime = '';
          for (var m = 0; m < 3; m++) mime += String.fromCharCode(view[start + 1 + m]);
          picStart = start + 4;
        } else {
          var ms = start + 1, me = ms;
          while (me < end && view[me] !== 0) me++;
          mime = latin1(view, ms, me);
          picStart = me + 1;
        }
        var picType = view[picStart];
        var dEnd = picStart + 1;
        while (dEnd < end) {
          if (view[dEnd] === 0) { dEnd++; break; }
          dEnd++;
        }
        var dataBytes = Math.max(0, end - dEnd);
        res.note = 'APIC ' + mime + ', picture type ' + picType + ', ' + MA.formatSize(dataBytes);
        res.text = mime;
        if (meta0) { meta0.coverMime = mime; meta0.coverBytes = dataBytes; }
        return res;
      }
      if (id === 'WXXX' || id.charAt(0) === 'W') {
        res.text = latin1(view, start, end);
        return res;
      }
      if (id === 'USLT') {
        var lang2 = String.fromCharCode(view[start + 1], view[start + 2], view[start + 3]);
        res.note = 'USLT [' + lang2 + ']';
        res.text = decodeText(view, start + 4, end, enc);
        return res;
      }
      res.note = 'binary or unsupported frame';
      return res;
    } catch (e) {
      res.note = 'decode error';
      return res;
    }
  }

  function readU32(data, p) {
    return (data[p] * 0x1000000) + (data[p + 1] << 16) + (data[p + 2] << 8) + data[p + 3];
  }

  /* ======================================================================
   * ID3v1 — 128 byte tail tag
   * ====================================================================*/

  /**
   * @param {Uint8Array} data full buffer
   * @param {number} base absolute file offset of data[0]
   * @returns {{table, rows, info, present}}
   */
  function parseID3v1(data, base) {
    base = base || 0;
    var off = data.length - 128;
    var out = { table: null, rows: null, info: null, present: false, error: null };
    if (off < 0 || data[off] !== 0x54 || data[off + 1] !== 0x41 || data[off + 2] !== 0x47) {
      out.error = 'no ID3v1 tag in the last 128 bytes';
      return out;
    }
    var r = reader(data, off, 128, base);
    var info = { offset: base + off, metadata: {} };
    out.rows = r.rows;
    try {
      var idRow = r.rows.length;
      r.bytes('identifier', 3);
      r.rows[idRow].value = 'TAG';
      r.rows[idRow].note = 'magic "TAG"';
      info.title = trimTag(data, off + 3, off + 33);
      r.rows.push(textRow('title', data, off + 3, 30, base, r.depth));
      info.artist = trimTag(data, off + 33, off + 63);
      r.rows.push(textRow('artist', data, off + 33, 30, base, r.depth));
      info.album = trimTag(data, off + 63, off + 93);
      r.rows.push(textRow('album', data, off + 63, 30, base, r.depth));
      info.year = trimTag(data, off + 93, off + 97);
      r.rows.push(textRow('year', data, off + 93, 4, base, r.depth));
      // ID3v1.1: a zero byte at comment[28] turns comment[29] into the track.
      var v11 = data[off + 125] === 0 && data[off + 126] !== 0;
      info.comment = trimTag(data, off + 97, off + (v11 ? 125 : 127));
      r.rows.push(textRow('comment', data, off + 97, v11 ? 28 : 30, base, r.depth));
      if (v11) {
        info.track = data[off + 126];
        r.rows.push({
          name: 'track', syntax: 'u(8)', bits: 8, value: info.track,
          note: 'ID3v1.1 — byte 28 of the comment field is zero',
          offset: base + off + 126, depth: r.depth
        });
      }
      var genre = data[off + 127];
      info.genreId = genre;
      info.genre = genreName(genre);
      r.rows.push({
        name: 'genre', syntax: 'u(8)', bits: 8, value: genre, note: info.genre,
        offset: base + off + 127, depth: r.depth
      });
      info.metadata = {
        title: info.title, artist: info.artist, album: info.album, year: info.year,
        comment: info.comment, genre: info.genre, track: info.track
      };
      out.info = info;
      out.present = true;
      out.table = synSection('ID3v1 tag',
        '128 bytes at the end of the file, by ' + (info.artist || '?'), r.rows);
      return out;
    } catch (e) {
      out.error = String(e && e.message || e);
      out.info = info;
      out.table = synSection('ID3v1 tag', 'partial — parse error', r.rows);
      return out;
    }
  }

  function textRow(name, data, off, len, base, depth) {
    return {
      name: name, syntax: 'bytes(' + len + ')', bits: len * 8,
      value: trimTag(data, off, off + len),
      note: 'Latin-1 / GBK fallback, NUL/space padded', offset: base + off, depth: depth
    };
  }

  function trimTag(data, start, end) {
    return decodeTagBytes(data, start, end).replace(/[\s\0]+$/, '');
  }

  /* ======================================================================
   * Xing / Info / LAME / VBRI
   * ====================================================================*/

  /**
   * VBR headers. `off` is the offset of the 4-byte signature:
   *   "Xing"/"Info"  frame start + 4 (+2 CRC) + side info
   *   "VBRI"         frame start + 4 + 32 (fixed)
   *
   * @returns {{table, tables, info}}
   */
  function parseXing(data, off, base) {
    off = off || 0;
    base = base || 0;
    var out = { table: null, tables: [], info: { kind: null, offset: base + off } };
    if (off < 0 || off + 8 > data.length) return out;
    var info = out.info;
    var sig = latin1(data, off, off + 4);

    if (sig === 'Xing' || sig === 'Info') {
      var r = reader(data, off, Math.min(data.length - off, 160), base);
      r.bytes('xing_identifier', 4);
      r.rows[0].value = sig;
      r.rows[0].note = sig === 'Xing' ? 'VBR (variable bitrate) stream' : 'CBR (constant bitrate) stream';
      var flags = r.u('flags', 32, '');
      var hasFrames = !!(flags & 1), hasBytes = !!(flags & 2),
          hasToc = !!(flags & 4), hasQuality = !!(flags & 8);
      r.note('frames ' + (hasFrames ? 'yes' : 'no') + ', bytes ' + (hasBytes ? 'yes' : 'no') +
        ', TOC ' + (hasToc ? 'yes' : 'no') + ', quality ' + (hasQuality ? 'yes' : 'no'));
      info.kind = sig;
      info.flags = flags;
      if (hasFrames) {
        info.frames = r.u('frames', 32, 'number of frames in the stream, this header frame included');
      }
      if (hasBytes) info.bytes = r.u('bytes', 32, 'total stream length in bytes');
      if (hasToc) {
        var table = r.bytes('toc', 100, 'seek table: 100 positions in 1/256ths of the stream');
        table.bits = 800;
        info.toc = data.subarray(r.bytePos() - 100, r.bytePos());
      }
      if (hasQuality) info.quality = r.u('quality', 8, 'quality indicator, 0..100');

      // ---- LAME / Lavc / GOGO extension ----
      var stop = Math.min(data.length, off + 0x78 + 40);
      var candidates = [];
      if (r.bytePos() + 40 <= stop) candidates.push(r.bytePos());
      if (off + 0x78 + 40 <= data.length) candidates.push(off + 0x78);
      var encStart = -1, enc = '';
      for (var ci = 0; ci < candidates.length; ci++) {
        var candidate = latin1(data, candidates[ci], candidates[ci] + 9);
        if (/^(LAME|L3\.|Lavc|Lavf|GOGO|iTunes|Xing)/i.test(candidate)) {
          encStart = candidates[ci];
          enc = candidate;
          break;
        }
      }
      if (encStart >= 0) {
        info.encoder = enc;
        info.lameTagOffset = base + encStart;
        var lame = { encoder: enc };
        var lp = encStart + 9;
        var revVbr = data[lp];
        lame.revision = (revVbr >> 4) & 0x0f;
        lame.vbrMethod = revVbr & 0x0f;
        lame.vbrMethodName = VBR_METHODS[lame.vbrMethod] || 'unknown';
        lame.lowpass = data[lp + 1] * 100;
        lame.peak = readFloat32(data, lp + 2);
        lame.radioGain = readI16(data, lp + 6) / 10;
        lame.radioPeak = readI16(data, lp + 8);
        lame.audiophileGain = readI16(data, lp + 10) / 10;
        lame.audiophilePeak = readI16(data, lp + 12);
        var encFlags = data[lp + 14];
        lame.athType = encFlags & 0x0f;
        lame.encodingFlags = (encFlags >> 4) & 0x0f;
        lame.minimumBitrate = data[lp + 15];
        var d0 = data[lp + 16], d1 = data[lp + 17], d2 = data[lp + 18];
        lame.delay = (d0 << 4) | (d1 >> 4);
        lame.padding = ((d1 & 0x0f) << 8) | d2;
        lame.misc = data[lp + 19];
        lame.mp3Gain = data[lp + 20];
        lame.surroundPreset = (data[lp + 21] << 8) | data[lp + 22];
        lame.musicLength = readU32(data, lp + 23);
        lame.musicCrc = (data[lp + 27] << 8) | data[lp + 28];
        lame.tagCrc = (data[lp + 29] << 8) | data[lp + 30];
        info.lame = lame;

        // Rows for the extension, at the same positions used above.
        r.depth++;
        r.group('LAME extension (offsets relative to the encoder string)');
        var lameRows = [
          ['encoder_string', 0, 9, enc],
          ['info_tag_revision + vbr_method', 9, 1, 'revision ' + lame.revision + ', ' +
            lame.vbrMethod + ' = ' + lame.vbrMethodName],
          ['lowpass_filter', 10, 1, lame.lowpass + ' Hz'],
          ['peak_signal_amplitude', 11, 4, String(lame.peak)],
          ['radio_replay_gain', 15, 2, lame.radioGain + ' dB'],
          ['radio_replay_gain_peak', 17, 2, String(lame.radioPeak)],
          ['audiophile_replay_gain', 19, 2, lame.audiophileGain + ' dB'],
          ['audiophile_replay_gain_peak', 21, 2, String(lame.audiophilePeak)],
          ['encoding_flags + ath_type', 23, 1, 'ATH type ' + lame.athType +
            ', flags 0x' + lame.encodingFlags.toString(16)],
          ['minimum_bitrate', 24, 1, lame.minimumBitrate + ' kbps'],
          ['encoder_delay', 25, 3, lame.delay + ' samples'],
          ['encoder_padding', 25, 3, lame.padding + ' samples'],
          ['misc', 28, 1, String(lame.misc)],
          ['mp3_gain', 29, 1, (lame.mp3Gain > 127 ? lame.mp3Gain - 256 : lame.mp3Gain) / 4 + ' dB'],
          ['preset_and_surround', 30, 2, '0x' + MA.pad(lame.surroundPreset.toString(16), 4)],
          ['music_length', 32, 4, lame.musicLength + ' bytes of source audio'],
          ['music_crc', 36, 2, '0x' + MA.pad(lame.musicCrc.toString(16), 4)],
          ['tag_crc', 38, 2, '0x' + MA.pad(lame.tagCrc.toString(16), 4)]
        ];
        for (var li = 0; li < lameRows.length; li++) {
          var lr = lameRows[li];
          r.rows.push({
            name: lr[0], syntax: 'bytes(' + lr[2] + ')', bits: lr[2] * 8,
            value: lr[3], note: lr[0] === 'encoder_delay'
              ? '12 bits delay + 12 bits padding packed in 3 bytes'
              : 'LAME info tag, +' + lr[1] + ' from the encoder string',
            offset: base + encStart + lr[1], depth: r.depth
          });
        }
        r.depth--;
      } else if (r.bytePos() + 4 <= data.length) {
        info.encoder = latin1(data, r.bytePos(), r.bytePos() + 9);
      }

      out.table = synSection('Xing / Info VBR header',
        sig + ', ' + (info.frames != null ? info.frames + ' frames, ' : '') +
        (info.bytes != null ? MA.formatSize(info.bytes) : '') +
        (info.encoder ? ', encoder "' + info.encoder + '"' : ''), r.rows);
      out.tables = [out.table];
      return out;
    }

    if (sig === 'VBRI') {
      var v = reader(data, off, Math.min(data.length - off, 26), base);
      v.bytes('vbri_identifier', 4);
      v.rows[0].value = 'VBRI';
      v.rows[0].note = 'Fraunhofer VBRI header, always 32 bytes after the frame header';
      info.kind = 'VBRI';
      info.version = v.u('version', 16);
      info.delay = v.u('delay', 16, 'encoder delay in samples (float in some encoders)');
      info.quality = v.u('quality', 16);
      info.bytes = v.u('bytes', 32);
      info.frames = v.u('frames', 32);
      info.tocEntries = v.u('toc_entries', 16);
      info.tocScale = v.u('toc_scale', 16);
      info.tocEntrySize = v.u('toc_entry_size', 16, 'bytes per TOC entry, 1..4');
      info.framesPerEntry = v.u('frames_per_toc_entry', 16);
      out.table = synSection('VBRI header',
        info.frames + ' frames, ' + MA.formatSize(info.bytes) + ', ' +
        info.tocEntries + ' TOC entries', v.rows);
      out.tables = [out.table];
      return out;
    }

    return out;
  }

  function readU16(data, p) { return (data[p] << 8) | data[p + 1]; }
  function readI16(data, p) { var v = readU16(data, p); return v > 0x7fff ? v - 0x10000 : v; }
  function readFloat32(data, p) {
    var v = readU32(data, p);
    var sign = (v >>> 31) ? -1 : 1;
    var exp = (v >>> 23) & 0xff;
    var frac = v & 0x7fffff;
    if (exp === 0) return sign * frac * Math.pow(2, -149);
    if (exp === 255) return frac ? NaN : sign * Infinity;
    return sign * (1 + frac / 0x800000) * Math.pow(2, exp - 127);
  }

  /* ======================================================================
   * Whole file analysis
   * ====================================================================*/

  /** Cheap validity test used by the resync scan (no table allocation). */
  function headerAt(data, off, end) {
    if (off + 4 > end) return null;
    if (data[off] !== 0xff || (data[off + 1] & 0xe0) !== 0xe0) return null;
    var versionBit = (data[off + 1] >> 3) & 3;
    var layerBits = (data[off + 1] >> 1) & 3;
    if (versionBit === 1 || layerBits === 0) return null;   // reserved
    var brIdx = (data[off + 2] >> 4) & 0xf;
    var srIdx = (data[off + 2] >> 2) & 3;
    if (brIdx === 0 || brIdx === 15 || srIdx === 3) return null;
    var layer = 4 - layerBits;
    var bitrate = BITRATES[(versionBit === 3 ? '1' : '2') + '-' + layer][brIdx];
    var sampleRate = SAMPLE_RATES[versionBit][srIdx];
    var padding = (data[off + 2] >> 1) & 1;
    var frameLength = computeFrameLength(versionBit, layer, bitrate, sampleRate, padding);
    if (!frameLength) return null;
    return {
      versionBit: versionBit, layer: layer, bitrate: bitrate, sampleRate: sampleRate,
      padding: padding, frameLength: frameLength,
      channelMode: (data[off + 3] >> 6) & 3
    };
  }

  /**
   * Find the next frame whose successor is also a valid frame — that two-sided
   * test is what keeps random 0xFF bytes from being accepted as a sync.
   */
  function findFrameSync(data, from, end) {
    var stop = Math.min(end - 4, from + SYNC_SCAN);
    var plausible = -1;
    for (var i = Math.max(0, from); i < stop; i++) {
      if (data[i] !== 0xff || (data[i + 1] & 0xe0) !== 0xe0) continue;
      var h = headerAt(data, i, end);
      if (!h) continue;
      var n = headerAt(data, i + h.frameLength, end);
      if (n) return i;
      if (plausible < 0) plausible = i;
    }
    return plausible;
  }

  /**
   * Walk a whole .mp3 file: ID3v2 tag (if present), every audio frame, the
   * Xing/Info header of the first frame and the ID3v1 tail tag (if present).
   *
   * The syntax tables are attached only to the first SYNTAX_FRAME_LIMIT frames
   * — a long file would otherwise keep a row set per frame alive in memory.
   *
   * @returns {{tables, frames, track, info}}
   */
  function analyzeStream(data, ctx) {
    ctx = ctx || {};
    var tables = [], frames = [], info = {};
    var p = ctx.start || 0;

    /* ---- ID3v2 ---- */
    if (p + 3 <= data.length && data[p] === 0x49 && data[p + 1] === 0x44 && data[p + 2] === 0x33) {
      var tag = parseID3v2(data, p, 0);
      if (tag.tables) tables = tables.concat(tag.tables);
      info.id3v2 = tag.info;
      info.metadata = tag.info.metadata;
      info.id3v2Present = true;
      if (tag.error) info.id3v2Error = tag.error;
      if (tag.info.totalSize > 0) p += tag.info.totalSize;
    }

    /* ---- ID3v1 tail (audio data must stop before it) ---- */
    var dataEnd = data.length;
    var id3v1 = parseID3v1(data, 0);
    if (id3v1.present) {
      dataEnd = data.length - 128;
      info.id3v1 = id3v1.info;
      info.id3v1Present = true;
      info.metadata = info.metadata || {};
      for (var mk in id3v1.info.metadata) {
        if (id3v1.info.metadata[mk] && !info.metadata[mk]) info.metadata[mk] = id3v1.info.metadata[mk];
      }
    }

    /* ---- first frame ---- */
    var first = findFrameSync(data, p, dataEnd);
    if (first < 0) {
      info.error = 'no MPEG audio frame sync found';
      return { tables: tables, frames: frames, track: null, info: info };
    }
    if (first > p) info.skippedBytes = first - p;
    info.firstFrameOffset = first;

    /* ---- Xing / Info / VBRI on the first frame ---- */
    var fh0 = parseFrameHeader(data, first, 0);
    var xing = { info: { kind: null } };
    if (!fh0.error && fh0.info.frameLength) {
      var h0 = fh0.info;
      var candidates = [];
      candidates.push(first + 4 + h0.crcBytes + h0.sideInfoBytes);   // Xing / Info
      candidates.push(first + 4 + 32);                               // VBRI (fixed)
      for (var ci = 0; ci < candidates.length && !xing.info.kind; ci++) {
        var cand = candidates[ci];
        if (cand + 4 > dataEnd) continue;
        var sig = latin1(data, cand, cand + 4);
        if (sig === 'Xing' || sig === 'Info' || sig === 'VBRI') {
          xing = parseXing(data, cand, 0);
        }
      }
    }
    if (xing.info.kind) {
      tables = tables.concat(xing.tables);
      info.xing = xing.info;
      info.hasXing = true;
      info.vbr = xing.info.kind === 'Xing' || xing.info.kind === 'VBRI';
    }

    /* ---- frame walk ---- */
    var pos = first, chained = 0, truncated = 0, resyncs = 0;
    var totalBytes = 0, totalDuration = 0, sampleRate = 0, channels = 0;
    var bitrateSum = 0, bitrateCount = 0;
    while (pos + 4 <= dataEnd && frames.length < MAX_FRAMES) {
      var h = headerAt(data, pos, dataEnd);
      if (!h) {
        var nextSync = findFrameSync(data, pos + 1, dataEnd);
        if (nextSync < 0) break;
        resyncs++;
        pos = nextSync;
        continue;
      }
      var flen = h.frameLength;
      if (pos + flen > dataEnd) {
        truncated = dataEnd - pos;
        flen = dataEnd - pos;
      }
      var isXingFrame = (xing.info.kind && xing.info.offset === (pos + 4 + h.crcBytes + h.sideInfoBytes + 0) -
        0) ? true : false;
      // The offset stored by parseXing is relative to the parser base used
      // there (the Xing signature site), so compare against it directly.
      info.void1 = isXingFrame;

      var duration = h.sampleRate > 0 ? samplesPerFrame(h.versionBit, h.layer) / h.sampleRate : 0;
      totalBytes += flen;
      totalDuration += duration;
      if (!sampleRate) sampleRate = h.sampleRate;
      if (!channels) channels = h.channelMode === 3 ? 1 : 2;
      bitrateSum += h.bitrate;
      bitrateCount++;
      if (!info.layer) {
        info.layer = h.layer;
        info.layerName = LAYER_BITS_NAME[4 - h.layer];
        info.versionName = VERSION_NAME[h.versionBit];
        info.versionBits = h.versionBit;
      }

      var syntax = { codec: 'mp3', kind: 'frame', base: pos, offset: pos, size: flen };
      if (frames.length < SYNTAX_FRAME_LIMIT) {
        var fp = parseFrame(data, pos, pos + flen, {});
        syntax._cached = fp.tables;
        info.firstFrameHeader = fp.info.header;
      }
      frames.push({
        index: frames.length,
        type: 'audio',
        keyframe: frames.length === 0,
        codec: 'mp3',
        offset: pos,
        size: flen,
        bitrate: h.bitrate * 1000,
        bitrateKbps: h.bitrate,
        sampleRate: h.sampleRate,
        channels: h.channelMode === 3 ? 1 : 2,
        padding: h.padding,
        samplesPerFrame: samplesPerFrame(h.versionBit, h.layer),
        duration: duration,
        isVbrHeader: !!(xing.info.kind && xing.info.offset === pos + 4 + h.crcBytes + h.sideInfoBytes),
        syntax: syntax
      });
      pos += flen;
      if (truncated) break;
    }

    for (var i = 0; i + 1 < frames.length; i++) {
      if (frames[i].offset + frames[i].size === frames[i + 1].offset) chained++;
    }
    if (frames.length >= MAX_FRAMES && pos + 4 <= dataEnd) info.frameCapReached = true;

    // Prefer the Xing frame count / byte count for the stream summary: the last
    // frames may be missing from a truncated file, the header knows better.
    var declaredFrames = xing.info.kind ? xing.info.frames : null;
    var declaredBytes = xing.info.kind ? xing.info.bytes : null;
    var duration = totalDuration;
    if (declaredFrames && sampleRate) {
      duration = declaredFrames * samplesPerFrame(info.versionBits === 3 ? 3 : info.versionBits,
        info.layer) / sampleRate;
      // Recompute per the actual version when it is MPEG-2/2.5.
      duration = declaredFrames * (info.layer === 3 && info.versionBits !== 3 ? 576 :
        info.layer === 1 ? 384 : 1152) / sampleRate;
    }

    info.frameCount = frames.length;
    info.framesWalked = frames.length;
    info.declaredFrameCount = declaredFrames;
    info.chainedFrames = chained;
    info.resyncs = resyncs;
    info.trailingBytes = truncated;
    info.totalBytes = totalBytes;
    info.declaredBytes = declaredBytes;
    info.sampleRate = sampleRate;
    info.channels = channels;
    info.bitrateKbps = bitrateCount ? Math.round(bitrateSum / bitrateCount) : 0;
    info.durationSec = duration;
    info.bitrate = duration > 0
      ? Math.round((declaredBytes || totalBytes) * 8 / duration)
      : (bitrateCount ? Math.round(bitrateSum / bitrateCount) * 1000 : null);
    info.audioStart = first;
    info.audioEnd = pos;
    info.syntaxTablesCached = Math.min(frames.length, SYNTAX_FRAME_LIMIT);

    var track = {
      id: 1, type: 'audio',
      codec: info.layer === 3 ? 'mp3' : info.layer === 2 ? 'mp2' : 'mp1',
      codecName: (info.versionName || 'MPEG') + ' ' + (info.layerName || ''),
      sampleRate: sampleRate,
      channels: channels,
      channelLayout: channels === 1 ? '1 (mono)' : '2 (stereo)',
      bitDepth: null,
      sampleCount: declaredFrames
        ? declaredFrames * (info.layer === 3 && info.versionBits !== 3 ? 576 : info.layer === 1 ? 384 : 1152)
        : null,
      frameCount: frames.length,
      declaredFrameCount: declaredFrames,
      durationSec: duration || null,
      bitrate: info.bitrate,
      vbr: !!info.vbr,
      encoder: xing.info.encoder || null
    };
    return { tables: tables, frames: frames, track: track, info: info };
  }

  /* ------------------------------------------------------------------ utils */

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

  /* ======================================================================
   * Registration
   * ====================================================================*/

  MA.registerCodec('mp3', {
    id: 'mp3',
    name: 'MPEG audio (MP1 / MP2 / MP3)',
    bitrates: BITRATES,
    sampleRates: SAMPLE_RATES,
    channelModes: CHANNEL_MODES,
    genres: GENRES,
    samplesPerFrame: samplesPerFrame,
    computeFrameLength: computeFrameLength,
    sideInfoBytes: sideInfoBytes,
    parseFrameHeader: parseFrameHeader,
    parseSideInfo: parseSideInfo,
    parseFrame: parseFrame,
    parseID3v2: parseID3v2,
    parseID3v1: parseID3v1,
    parseXing: parseXing,
    analyzeStream: analyzeStream
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
