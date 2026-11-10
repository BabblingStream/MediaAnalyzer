/* ============================================================================
 * MediaAnalyzer — codecs/av1.js
 *
 * AV1 bitstream syntax (AV1 Bitstream & Decoding Process Specification v1.0.0
 * with Errata 1).
 *
 * AV1 streams are a sequence of Open Bitstream Units. The header is LSB-first,
 * so this module reads through MA.SyntaxReaderLSB. The sequence header and the
 * configuration record are decoded in full; the frame header is decoded up to
 * the point where it needs state from previously decoded frames.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var LSB = MA.SyntaxReaderLSB, syn = MA.synSection;

  /* AV1 §6.2.1 obu_type */
  var OBU_TYPES = {
    1: 'OBU_SEQUENCE_HEADER', 2: 'OBU_TEMPORAL_DELIMITER', 3: 'OBU_FRAME_HEADER',
    4: 'OBU_TILE_GROUP', 5: 'OBU_METADATA', 6: 'OBU_FRAME', 7: 'OBU_REDUNDANT_FRAME_HEADER',
    8: 'OBU_TILE_LIST', 15: 'OBU_PADDING'
  };
  function obuName(t) {
    return OBU_TYPES[t] || (t >= 9 && t <= 14 ? 'Reserved' : 'Reserved');
  }

  var FRAME_TYPES = { 0: 'KEY_FRAME', 1: 'INTER_FRAME', 2: 'INTRA_ONLY_FRAME', 3: 'SWITCH_FRAME' };
  var COLOR_PRIMARIES = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'Generic film', 9: 'BT.2020',
    10: 'SMPTE ST 428-1', 11: 'SMPTE RP 431-2 (DCI-P3)', 12: 'SMPTE EG 432-1 (P3 D65)',
    22: 'EBU Tech 3213-E'
  };
  var TRANSFER = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'Linear', 9: 'Logarithmic (100:1)',
    10: 'Logarithmic (316.22777:1)', 11: 'xvYCC', 12: 'BT.1361',
    13: 'sRGB', 14: 'BT.2020 (10-bit)', 15: 'BT.2020 (12-bit)',
    16: 'SMPTE ST 2084 (PQ)', 17: 'SMPTE ST 428-1', 18: 'ARIB STD-B67 (HLG)'
  };
  var MATRIX = {
    0: 'Identity (GBR)', 1: 'BT.709', 2: 'Unspecified', 4: 'FCC', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'YCgCo', 9: 'BT.2020 non-constant',
    10: 'BT.2020 constant', 11: 'SMPTE ST 2085', 12: 'Chromaticity-derived non-constant',
    13: 'Chromaticity-derived constant', 14: 'ICtCp'
  };

  /* ====================================================================== */

  /** LEB128 unsigned integer with a hard bound. */
  function leb128(data, pos, limit) {
    var v = 0, shift = 0, guard = 0;
    while (pos < limit && guard++ < 8) {
      var b = data[pos++];
      v += (b & 0x7f) * Math.pow(2, shift);
      if (!(b & 0x80)) break;
      shift += 7;
    }
    return { value: v, next: pos };
  }

  /**
   * Walk the OBUs of an AV1 stream.
   * @returns {Array} [{ offset, headerEnd, size, type, typeName, ext, payloadStart, payloadEnd }]
   */
  function scanOBUs(data, start, end, maxObus) {
    start = start || 0;
    end = end == null ? data.length : end;
    maxObus = maxObus || 4096;
    var out = [];
    var p = start;
    var guard = 0;
    while (p < end && guard++ < maxObus) {
      var obuStart = p;
      var h = data[p];
      if (h & 0x80) break;                                   // forbidden bit set
      var type = (h >> 3) & 0x0f;
      var extFlag = (h >> 2) & 1;
      var hasSize = (h >> 1) & 1;
      p += 1;
      var ext = null;
      if (extFlag && p < end) {
        var e = data[p++];
        ext = { temporalId: (e >> 5) & 7, spatialId: (e >> 3) & 7 };
      }
      var size = Infinity;
      if (hasSize) {
        var l = leb128(data, p, end);
        size = l.value;
        p = l.next;
      }
      var payloadStart = p;
      var payloadEnd = hasSize ? Math.min(end, p + size) : end;
      out.push({
        offset: obuStart, headerEnd: p, size: payloadEnd - payloadStart,
        type: type, typeName: obuName(type), ext: ext,
        payloadStart: payloadStart, payloadEnd: payloadEnd, hasSize: hasSize
      });
      if (!hasSize) break;                                   // the rest of the stream is this OBU
      p = payloadEnd;
    }
    return out;
  }

  /* ------------------------------------------------------- sequence header */

  function parseSequenceHeader(data, start, end, base) {
    var r = new LSB(data, { offset: start, length: end - start, base: base == null ? start : base });
    var info = {};
    try {
      r.depth++;
      r.group('sequence_header_obu()');
      var profile = r.f('seq_profile', 3);
      info.seqProfile = profile;
      r.note('profile ' + profile);
      var stillPicture = r.f('still_picture', 1);
      info.stillPicture = stillPicture === 1;
      var reduced = r.f('reduced_still_picture_header', 1);
      info.reducedStillPictureHeader = reduced === 1;
      r.note(reduced ? 'reduced header (still picture only)' : 'full header');

      if (reduced) {
        info.seqLevelIdx0 = r.f('seq_level_idx[0]', 5);
      } else {
        var timingPresent = r.f('timing_info_present_flag', 1);
        if (timingPresent) parseTimingInfo(r, info);
        var initialDisplay = r.f('initial_display_delay_present_flag', 1);
        var ops = r.f('operating_points_cnt_minus_1', 5) + 1;
        info.operatingPoints = ops;
        for (var i = 0; i < Math.min(ops, 32); i++) {
          var opId = r.f('operating_point_idc[' + i + ']', 12);
          var lvl = r.f('seq_level_idx[' + i + ']', 5);
          if (i === 0) info.seqLevelIdx0 = lvl;
          if (lvl > 7) r.f('seq_tier[' + i + ']', 1);
          if (initialDisplay) {
            if (r.f('initial_display_delay_present_for_op[' + i + ']', 1)) {
              r.f('initial_display_delay_minus_1[' + i + ']', 4);
            }
          }
          void opId;
        }
      }

      var wBits = r.f('frame_width_bits_minus_1', 4) + 1;
      var hBits = r.f('frame_height_bits_minus_1', 4) + 1;
      info.width = r.f('max_frame_width_minus_1', wBits) + 1;
      info.height = r.f('max_frame_height_minus_1', hBits) + 1;
      r.note(info.width + ' x ' + info.height);

      if (!reduced) {
        if (r.f('frame_id_numbers_present_flag', 1)) {
          r.f('delta_frame_id_length_minus_2', 4);
          r.f('additional_frame_id_length_minus_1', 3);
        }
      }
      r.f('use_128x128_superblock', 1);
      r.f('enable_filter_intra', 1);
      r.f('enable_intra_edge_filter', 1);
      if (!reduced) {
        r.f('enable_interintra_compound', 1);
        r.f('enable_masked_compound', 1);
        r.f('enable_warped_motion', 1);
        r.f('enable_dual_filter', 1);
        var orderHint = r.f('enable_order_hint', 1);
        if (orderHint) {
          r.f('enable_jnt_comp', 1);
          r.f('enable_ref_frame_mvs', 1);
        }
        if (r.f('seq_choose_screen_content_tools', 1)) {
          r.f('seq_force_screen_content_tools', 1);
        } else {
          info.forceScreenContentTools = r.f('seq_force_screen_content_tools', 2);
        }
        var forced = r.rows[r.rows.length - 1].value;
        if (forced > 0) r.f('seq_force_integer_mv', 1);
        if (orderHint) {
          info.orderHintBits = r.f('order_hint_bits_minus_1', 3) + 1;
        }
      }
      r.f('enable_superres', 1);
      r.f('enable_cdef', 1);
      r.f('enable_restoration', 1);

      parseColorConfig(r, info, profile);
      info.filmGrainParamsPresent = r.f('film_grain_params_present', 1) === 1;
      r.depth--;

      info.tables = [syn('sequence_header_obu()',
        'profile ' + profile + ', ' + info.width + 'x' + info.height +
        (info.bitDepth ? ', ' + info.bitDepth + '-bit' : ''), r.rows)];
      return { rows: r.rows, info: info };
    } catch (e) {
      info.error = String(e && e.message || e);
      return { rows: r.rows, info: info,
               tables: [syn('sequence_header_obu()', 'parse stopped early', r.rows)] };
    }
  }

  function parseTimingInfo(r, info) {
    r.depth++;
    r.group('timing_info()');
    var numUnits = r.f('num_units_in_display_tick', 32);
    var timeScale = r.f('time_scale', 32);
    if (numUnits > 0) info.fps = timeScale / numUnits;
    r.note(info.fps ? info.fps.toFixed(3) + ' fps' : '');
    r.f('equal_picture_interval', 1);
    if (r.rows[r.rows.length - 1].value) {
      var upt = uvlc(r);
      info.numTicksPerPicture = upt + 1;
      r.note('one picture every ' + (upt + 1) + ' ticks');
    }
    if (r.lsbFlag('decoder_model_info_present_flag')) {
      r.f('encoder_decoder_buffer_delay_length_minus_1', 5);
      r.f('num_units_in_decoding_tick', 32);
      r.f('buffer_removal_time_length_minus_1', 5);
      r.f('frame_presentation_time_length_minus_1', 5);
    }
    r.depth--;
  }

  /** uvLC() — AV1's unsigned variable-length code, read bit by bit. */
  function uvlc(r) {
    var value = 0, guard = 0;
    while (guard++ < 32) {
      var b = r.f('uvlc_bit', 1);
      if (!b) break;
      value++;
    }
    if (value === 0) return 0;
    var v = 0;
    for (var i = 0; i < value; i++) {
      v = (value === 1 ? v << 1 : (v << 1)) | r.f('uvlc_literal_bit', 1);
    }
    return Math.pow(2, value) - 1 + v;
  }

  function parseColorConfig(r, info, profile) {
    r.depth++;
    r.group('color_config()');
    var highBitdepth = r.f('high_bitdepth', 1);
    var bitDepth = 8, twelveBit = 0;
    if (profile === 2 && highBitdepth) {
      twelveBit = r.f('twelve_bit', 1);
      bitDepth = twelveBit ? 12 : 10;
    } else if (highBitdepth) {
      bitDepth = 10;
    }
    info.bitDepth = bitDepth;
    var mono = r.f('mono_chrome', 1);
    info.monochrome = mono === 1;
    info.colorDescriptionPresent = r.f('color_description_present_flag', 1) === 1;
    if (info.colorDescriptionPresent) {
      var cp = r.f('color_primaries', 8);
      var tc = r.f('transfer_characteristics', 8);
      var mc = r.f('matrix_coefficients', 8);
      info.colorPrimaries = COLOR_PRIMARIES[cp] || cp;
      info.transferCharacteristics = TRANSFER[tc] || tc;
      info.matrixCoefficients = MATRIX[mc] || mc;
    }
    if (mono) {
      info.colorRange = r.f('color_range', 1) === 1;
      info.chromaSubsampling = '4:0:0 (monochrome)';
    } else {
      var rgb = false;
      if (profile === 0 && bitDepth === 8 && !info.colorDescriptionPresent) {
        // profile 0 without an explicit colour description is implicitly
        // BT.709 4:2:0 with studio range, so no colour_range bit is coded.
        info.colorPrimaries = 'BT.709';
        info.chromaSubsampling = '4:2:0';
        rgb = false;
      } else {
        var cr = r.f('color_range', 1);
        info.colorRange = cr === 1;
        if (profile === 1) {
          info.chromaSubsampling = '4:4:4';
          rgb = true;
        } else if (profile === 0) {
          info.chromaSubsampling = '4:2:0';
        } else {
          var sx = r.f('subsampling_x', 1);
          var sy = r.f('subsampling_y', 1);
          if (sx && sy) info.chromaSubsampling = '4:2:0';
          else if (sx && !sy) info.chromaSubsampling = '4:2:2';
          else if (!sx && !sy) { info.chromaSubsampling = '4:4:4'; rgb = true; }
          else info.chromaSubsampling = '4:4:0';
        }
        if (!rgb && info.chromaSubsampling === '4:2:0') {
          info.chromaSamplePosition = r.f('chroma_sample_position', 2);
        }
      }
    }
    if (r.f('separate_uv_delta_q', 1)) info.separateUvDeltaQ = true;
    r.depth--;
  }

  /* -------------------------------------------------------- frame header */

  function parseFrameHeaderObu(data, start, end, base, ctx) {
    ctx = ctx || {};
    var r = new LSB(data, { offset: start, length: end - start, base: base == null ? start : base });
    var info = {};
    try {
      r.depth++;
      r.group('uncompressed_header()');
      var idPresent = ctx.frameIdNumbersPresent ? r.f('frame_id_numbers_present_flag', 1) : 0;
      if (ctx.frameIdNumbersPresent) {
        if (idPresent) r.f('display_frame_id', ctx.frameIdLength || 16);
      }
      var ft = r.f('frame_type', 2);
      info.frameType = FRAME_TYPES[ft] || '?';
      info.isKey = ft === 0;
      r.note(info.frameType);
      var showFrame = r.f('show_frame', 1);
      info.showFrame = showFrame === 1;
      if (showFrame) r.f('showable_frame', 1);
      if (ft === 3) r.f('error_resilient_mode', 1);
      else if (ft === 0) {
        info.errorResilient = true;
      } else {
        info.errorResilient = r.f('error_resilient_mode', 1) === 1;
      }
      r.f('disable_cdf_update', 1);
      if (ctx.screenContentTools) r.f('allow_screen_content_tools', 1);
      else info.allowScreenContentTools = r.f('allow_screen_content_tools', 1);
      if (info.allowScreenContentTools && ctx.forceIntegerMv) r.f('force_integer_mv', 1);

      if (info.isKey) info.refreshFrameFlags = 0xff;
      else info.refreshFrameFlags = r.f('refresh_frame_flags', 8);

      var wBits = r.f('frame_size_override_flag', 1);
      void wBits;

      info.orderHint = r.f('order_hint', ctx.orderHintBits || 8);
      // primary_ref_frame is only signalled for inter frames.
      if (ft !== 0) r.f('primary_ref_frame', 3);
      info.headerSizeBytes = Math.ceil(r.bitPos() / 8);
      r.depth--;

      return {
        tables: [syn('uncompressed_header()', info.frameType + (info.isKey ? ' (key)' : ''), r.rows)],
        info: info
      };
    } catch (e) {
      info.error = String(e && e.message || e);
      return { tables: [syn('uncompressed_header()', 'parse stopped early', r.rows)], info: info };
    }
  }

  /* ------------------------------------------------- configuration record */

  /** AV1CodecConfigurationRecord (av1C box, §2.3 of the AV1 ISOBMFF binding). */
  function parseAv1C(br, end, base) {
    var start = br.pos;
    if (base == null) base = br.base + start;
    var rows = [];
    var b0 = br.u8at(start), b1 = br.u8at(start + 1), b2 = br.u8at(start + 2), b3 = br.u8at(start + 3);
    var info = {};

    rows.push({ name: 'marker', syntax: 'f(1)', bits: 1, value: (b0 >> 7) & 1, note: 'must be 1', offset: base, depth: 0 });
    var version = b0 & 0x7f;
    rows.push({ name: 'version', syntax: 'f(7)', bits: 7, value: version, note: '1', offset: base, depth: 0 });

    var profile = (b1 >> 5) & 7, level = b1 & 0x1f;
    info.seqProfile = profile;
    info.seqLevelIdx0 = level;
    rows.push({ name: 'seq_profile', syntax: 'f(3)', bits: 3, value: profile, note: '', offset: base + 1, depth: 0 });
    rows.push({ name: 'seq_level_idx_0', syntax: 'f(5)', bits: 5, value: level, note: '', offset: base + 1, depth: 0 });

    var tier = (b2 >> 7) & 1;
    var high = (b2 >> 6) & 1, twelve = (b2 >> 5) & 1, mono = (b2 >> 4) & 1;
    var subX = (b2 >> 3) & 1, subY = (b2 >> 2) & 1, csp = b2 & 3;
    rows.push({ name: 'seq_tier_0', syntax: 'f(1)', bits: 1, value: tier, note: tier ? 'High tier' : 'Main tier', offset: base + 2, depth: 0 });
    rows.push({ name: 'high_bitdepth', syntax: 'f(1)', bits: 1, value: high, note: '', offset: base + 2, depth: 0 });
    rows.push({ name: 'twelve_bit', syntax: 'f(1)', bits: 1, value: twelve, note: '', offset: base + 2, depth: 0 });
    rows.push({ name: 'monochrome', syntax: 'f(1)', bits: 1, value: mono, note: '', offset: base + 2, depth: 0 });
    rows.push({ name: 'chroma_subsampling_x', syntax: 'f(1)', bits: 1, value: subX, note: '', offset: base + 2, depth: 0 });
    rows.push({ name: 'chroma_subsampling_y', syntax: 'f(1)', bits: 1, value: subY, note: '', offset: base + 2, depth: 0 });
    rows.push({ name: 'chroma_sample_position', syntax: 'f(2)', bits: 2, value: csp,
                note: ['UNKNOWN', 'VERTICAL', 'COLOCATED', 'RESERVED'][csp], offset: base + 2, depth: 0 });

    var bitDepth = twelve ? 12 : (high ? 10 : 8);
    info.bitDepth = bitDepth;
    info.monochrome = !!mono;
    info.chromaSubsampling = mono ? '4:0:0 (monochrome)'
      : subX && subY ? '4:2:0' : subX && !subY ? '4:2:2' : !subX && !subY ? '4:4:4' : '4:4:0';

    rows.push({ name: 'reserved', syntax: 'f(3)', bits: 3, value: (b3 >> 5) & 7, note: '', offset: base + 3, depth: 0 });
    var delayPresent = (b3 >> 4) & 1;
    rows.push({ name: 'initial_presentation_delay_present', syntax: 'f(1)', bits: 1, value: delayPresent, note: '', offset: base + 3, depth: 0 });
    if (delayPresent) {
      rows.push({ name: 'initial_presentation_delay_minus_one', syntax: 'f(4)', bits: 4, value: b3 & 0x0f, note: '', offset: base + 3, depth: 0 });
      info.initialPresentationDelay = (b3 & 0x0f) + 1;
    } else {
      rows.push({ name: 'reserved', syntax: 'f(4)', bits: 4, value: b3 & 0x0f, note: '', offset: base + 3, depth: 0 });
    }
    // Trailing configOBUs, if the record was built from a sequence header.
    var trailing = end - (start + 4);
    if (trailing > 0) {
      rows.push({ name: 'configOBUs', syntax: 'bytes(' + trailing + ')', bits: trailing * 8,
                  value: trailing + ' bytes', note: 'cached sequence header OBU(s)', offset: base + 4, depth: 0 });
      info.configObuBytes = trailing;
      // Peek at the cached sequence header so dimensions are available.
      try {
        var obus = scanOBUs(br.u8, start + 4, end, 16);
        for (var i = 0; i < obus.length; i++) {
          if (obus[i].type === 1) {
            var seq = parseSequenceHeader(br.u8, obus[i].payloadStart, obus[i].payloadEnd, obus[i].payloadStart);
            if (seq.info.width) {
              info.width = seq.info.width;
              info.height = seq.info.height;
              info.bitDepth = info.bitDepth || seq.info.bitDepth;
              info.chromaSubsampling = info.chromaSubsampling || seq.info.chromaSubsampling;
            }
            break;
          }
        }
      } catch (e) { /* the cached OBU is optional */ }
    }
    return { table: syn('AV1CodecConfigurationRecord', 'av1C box — profile ' + profile + ', level ' + level + ', ' + bitDepth + '-bit', rows), info: info };
  }

  function makeContext() {
    return { codec: 'av1', width: null, height: null, orderHintBits: 8,
             frameIdNumbersPresent: false, screenContentTools: false, forceIntegerMv: false };
  }

  /** Analyse a whole OBU stream (a raw .obu file or one AV1 sample). */
  function analyzeOBUs(data, base) {
    var obus = scanOBUs(data, 0, data.length, 4096);
    var tables = [];
    var info = { obuCount: obus.length, obuTypes: {} };
    var ctx = makeContext();

    obus.forEach(function (o, i) {
      info.obuTypes[o.typeName] = (info.obuTypes[o.typeName] || 0) + 1;
      if (o.type === 1) {
        var seq = parseSequenceHeader(data, o.payloadStart, o.payloadEnd, o.payloadStart);
        Object.assign(info, {
          seqProfile: seq.info.seqProfile, width: seq.info.width, height: seq.info.height,
          bitDepth: seq.info.bitDepth, chromaSubsampling: seq.info.chromaSubsampling,
          colorPrimaries: seq.info.colorPrimaries, transferCharacteristics: seq.info.transferCharacteristics,
          matrixCoefficients: seq.info.matrixCoefficients, fps: seq.info.fps,
          stillPicture: seq.info.stillPicture
        });
        if (i < 4) tables = tables.concat(seq.tables || [syn('sequence_header_obu()', '', seq.rows)]);
        if (seq.info.orderHintBits != null) ctx.orderHintBits = seq.info.orderHintBits;
      } else if (o.type === 3 || o.type === 6) {
        var fh = parseFrameHeaderObu(data, o.payloadStart, o.payloadEnd, o.payloadStart, ctx);
        if (i < 4) tables = tables.concat(fh.tables);
        info.frameType = fh.info.frameType;
        info.isKey = fh.info.isKey;
      } else if (i < 4) {
        tables.push(syn(o.typeName, o.size + ' bytes', [
          { name: 'obu_type', syntax: 'f(4)', bits: 4, value: o.type, note: o.typeName, offset: o.offset, depth: 0 },
          { name: 'obu_size', syntax: 'leb128()', bits: 0, value: o.size,
            note: o.hasSize ? '' : 'no size field — extends to the end of the stream', offset: o.headerEnd, depth: 0 }
        ]));
      }
    });

    if (!tables.length) {
      tables.push(syn('AV1 OBU stream', obus.length + ' OBU(s), none decodable', [
        { name: 'obu_count', syntax: '', bits: '', value: obus.length, note: '', offset: base || 0, depth: 0 }
      ]));
    }
    return { tables: tables, info: info, ctx: ctx, obus: obus };
  }

  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var res = analyzeOBUs(payload, spec.base || 0);
    if (spec.base) {
      res.tables.forEach(function (t) {
        t.rows.forEach(function (row) { if (row.offset != null) row.offset += spec.base; });
      });
    }
    return res.tables;
  }

  function analyzeIVF(data) {
    var res = MA.readIvf(data, 'AV01');
    if (!res) return null;
    var ctx = makeContext();
    var tables = [syn('IVF / AV1 stream', res.info.width + 'x' + res.info.height, [
      { name: 'fourcc', syntax: 'L(4)', bits: 32, value: "'AV01'", note: '', offset: 8, depth: 0 },
      { name: 'width', syntax: 'L(2)', bits: 16, value: res.info.width, note: '', offset: 12, depth: 0 },
      { name: 'height', syntax: 'L(2)', bits: 16, value: res.info.height, note: '', offset: 14, depth: 0 },
      { name: 'frame_count', syntax: 'L(4)', bits: 32, value: res.info.frameCount, note: '', offset: 24, depth: 0 }
    ])];
    if (res.frames.length) {
      var f0 = res.frames[0];
      var first = analyzeOBUs(data.subarray(f0.offset, f0.offset + f0.size), 0);
      tables = tables.concat(first.tables);
      Object.assign(res.info, {
        seqProfile: first.info.seqProfile, bitDepth: first.info.bitDepth,
        chromaSubsampling: first.info.chromaSubsampling
      });
      if (first.info.width) { ctx.width = first.info.width; ctx.height = first.info.height; }
    }
    res.frames.forEach(function (f) { f.codec = 'av1'; });
    return {
      tables: tables, frames: res.frames,
      track: { id: 1, type: 'video', codec: 'av1', codecName: 'AV1',
               width: res.info.width, height: res.info.height,
               fps: res.info.fps, sampleCount: res.frames.length,
               profile: 'Profile ' + (res.info.seqProfile != null ? res.info.seqProfile : '?') },
      info: res.info, ctx: ctx
    };
  }

  MA.registerCodec('av1', {
    id: 'av1',
    name: 'AV1',
    scanOBUs: scanOBUs,
    parseSequenceHeader: parseSequenceHeader,
    parseFrameHeader: parseFrameHeaderObu,
    parseAv1C: parseAv1C,
    analyzeOBUs: analyzeOBUs,
    buildSampleSyntax: buildSampleSyntax,
    makeContext: makeContext,
    analyzeIVF: analyzeIVF
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
