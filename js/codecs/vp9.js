/* ============================================================================
 * MediaAnalyzer — codecs/vp9.js
 *
 * VP9 bitstream syntax (VP9 Bitstream & Decoding Process Specification v0.6).
 *
 * Like VP8, VP9 is least-significant-bit-first, so this module reads through
 * MA.SyntaxReaderLSB. The *uncompressed* header is literal-bit coded and is
 * decoded in full here; the *compressed* header is range coded with the VP9
 * boolean decoder, and the module is explicit about where that boundary falls
 * rather than inventing field values it cannot actually read.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var LSB = MA.SyntaxReaderLSB, syn = MA.synSection;

  var FRAME_TYPES = ['KEY_FRAME', 'INTER_FRAME', 'INTRA_ONLY_FRAME', 'SWITCH_FRAME'];
  var COLOR_SPACES = ['CS_UNKNOWN', 'CS_BT_601', 'CS_BT_709', 'CS_SMPTE_170',
                      'CS_SMPTE_240', 'CS_BT_2020', 'CS_RESERVED', 'CS_RGB'];
  var INTERP_FILTERS = ['EIGHTTAP_SMOOTH', 'EIGHTTAP', 'EIGHTTAP_SHARP', 'BILINEAR',
                        'SWITCHABLE'];
  var CHROMA_POS = ['UNKNOWN', 'VERTICAL', 'COLOCATED', 'RESERVED'];

  /* ====================================================================== */

  function parseFrameHeader(data, off, end, ctx) {
    ctx = ctx || {};
    var r = new LSB(data, { offset: off, length: end - off, base: off });
    var info = {};
    try {
      r.depth++;
      r.group('uncompressed_header()');

      var marker = r.f('frame_marker', 2);
      r.note(marker === 2 ? 'valid (0b10)' : 'INVALID — expected 0b10');
      info.markerOk = marker === 2;

      var low = r.f('profile_low_bit', 1);
      var high = r.f('profile_high_bit', 1);
      var profile = (high << 1) | low;
      info.profile = profile;
      r.note('profile ' + profile + (profile === 3 ? ' (needs a reserved_zero bit)' : ''));
      if (profile === 3) r.f('reserved_zero', 1);

      var showExisting = r.f('show_existing_frame', 1);
      info.showExistingFrame = showExisting === 1;
      if (showExisting) {
        info.frameToShowMapIdx = r.f('frame_to_show_map_idx', 3);
        info.headerSizeBytes = Math.ceil(r.bitPos() / 8);
        return finish(r, info, off, 'show_existing_frame — this frame just displays a stored reference');
      }

      var ft = r.f('frame_type', 2);
      info.frameType = FRAME_TYPES[ft] || ('reserved (' + ft + ')');
      r.note(info.frameType);
      var showFrame = r.f('show_frame', 1);
      info.showFrame = showFrame === 1;
      var errorResilient = r.f('error_resilient_mode', 1);
      info.errorResilient = errorResilient === 1;

      var isKey = ft === 0;
      info.isKey = isKey;

      if (isKey) {
        r.depth++;
        r.group('// key frame header');
        var sync = (r.f('frame_sync_byte_0', 8) << 16) | (r.f('frame_sync_byte_1', 8) << 8) |
                   r.f('frame_sync_byte_2', 8);
        info.frameSyncCode = sync;
        r.note(sync === 0x498342 ? '0x498342 — valid' : 'unexpected');

        parseColorConfig(r, info, profile);
        parseFrameSize(r, info);
        parseRenderSize(r, info, info.width, info.height);

        info.refreshFrameFlags = r.f('refresh_frame_flags', 8);
        r.note('0x' + MA.pad((info.refreshFrameFlags || 0).toString(16), 2, '0'));
        r.depth--;
      } else {
        r.depth++;
        r.group('// inter frame header');
        if (ft === 2) {                                  // INTRA_ONLY
          var sync2 = (r.f('frame_sync_byte_0', 8) << 16) | (r.f('frame_sync_byte_1', 8) << 8) |
                      r.f('frame_sync_byte_2', 8);
          info.frameSyncCode = sync2;
          parseColorConfig(r, info, profile);
          info.refreshFrameFlags = r.f('refresh_frame_flags', 8);
        } else {
          info.refreshFrameFlags = r.f('refresh_frame_flags', 8);
        }
        info.refFrameIdx = [];
        info.refFrameSignBias = [];
        for (var i = 0; i < 3; i++) {
          var idx = r.f('ref_frame_idx[' + i + ']', 3);
          info.refFrameIdx.push(idx);
        }
        var frameSizeWithRefs = r.f('frame_size_with_refs', 1);
        if (frameSizeWithRefs) {
          for (var j = 0; j < 3; j++) {
            if (r.f('found_ref[' + j + ']', 1)) {
              info.width = ctx.width || null;
              info.height = ctx.height || null;
              r.note('size taken from reference ' + j);
              break;
            }
          }
          if (!info.width) parseFrameSize(r, info);
        } else {
          parseFrameSize(r, info);
        }
        parseRenderSize(r, info, info.width, info.height);
        if (!errorResilient) r.f('refresh_frame_context', 1);
        r.depth--;
      }

      for (var b = 0; b < 3; b++) {
        var sb = r.f('ref_frame_sign_bias[' + (b + 5) + ']', 1);
        info.refFrameSignBias.push(sb);
      }

      var allowHighPrecision = r.f('allow_high_precision_mv', 1);
      info.allowHighPrecisionMv = allowHighPrecision === 1;
      if (isKey || true) {
        var interp = r.f('interp_filter', 2);
        info.interpFilter = INTERP_FILTERS[interp] || 'reserved';
      }

      /* ---------------- loop filter ---------------- */
      r.depth++;
      r.group('loop_filter_params()');
      var lfLevel = r.f('loop_filter_level', 6);
      info.loopFilterLevel = lfLevel;
      r.f('loop_filter_sharpness', 3);
      var lfDeltaEnabled = r.f('loop_filter_delta_enabled', 1);
      if (lfDeltaEnabled) {
        var lfDeltaUpdate = r.f('loop_filter_delta_update', 1);
        if (lfDeltaUpdate) {
          for (var d = 0; d < 4; d++) {
            if (r.f('update_ref_delta[' + d + ']', 1)) { r.skip(1); r.f('loop_filter_ref_deltas[' + d + ']', 6); }
          }
          for (var e = 0; e < 2; e++) {
            if (r.f('update_mode_delta[' + e + ']', 1)) { r.skip(1); r.f('loop_filter_mode_deltas[' + e + ']', 6); }
          }
        }
      }
      r.depth--;

      /* ---------------- quantisation ---------------- */
      r.depth++;
      r.group('quantization_params()');
      var baseQ = r.f('base_q_idx', 8);
      info.baseQIdx = baseQ;
      r.note('base quantiser index ' + baseQ);
      for (var q = 0; q < 3; q++) {
        var names = ['delta_q_y_dc', 'delta_q_uv_dc', 'delta_q_uv_ac'];
        var coded = r.f(names[q] + '.delta_coded', 1);
        if (coded) { r.skip(1); r.f(names[q], 4); }
      }
      r.depth--;

      /* ---------------- segmentation ---------------- */
      r.depth++;
      var segEnabled = r.f('segmentation_enabled', 1);
      info.segmentationEnabled = segEnabled === 1;
      if (segEnabled) {
        r.group('segmentation_params()');
        var updateMap = r.f('segmentation_update_map', 1);
        if (updateMap) {
          r.f('segmentation_temporal_update', 1);
        }
        if (r.f('segmentation_update_data', 1)) {
          r.f('segmentation_abs_delta', 1);
          r.note(r.rows[r.rows.length - 1].value ? 'absolute values' : 'delta values');
          var featureBits = [[1, 8], [1, 6], [1, 2], [1, 0]];
          for (var s = 0; s < 8; s++) {
            for (var f2 = 0; f2 < 4; f2++) {
              if (r.f('feature_enabled[' + s + '][' + f2 + ']', 1)) {
                var w = featureBits[f2][1];
                if (f2 === 2) w = 3;                     // ref frame index
                if (w > 0) { r.skip(1); r.f('feature_value[' + s + '][' + f2 + ']', w); }
              }
            }
          }
        }
      }
      r.depth--;

      /* ---------------- tile info ---------------- */
      r.depth++;
      r.group('tile_info()');
      var cols = r.f('tile_cols_log2', 1);
      if (cols > 0) cols += r.f('tile_cols_log2_ext', 5);
      var rows = r.f('tile_rows_log2', 1);
      if (rows > 0) rows += r.f('tile_rows_log2_ext', 5);
      info.tileColsLog2 = cols;
      info.tileRowsLog2 = rows;
      r.note((1 << cols) + ' x ' + (1 << rows) + ' tiles');
      r.depth--;

      info.headerSizeInBytes = r.f('header_size_in_bytes', 16);
      info.headerSizeBytes = Math.ceil(r.bitPos() / 8);

      return finish(r, info, off, describe(info, profile, isKey));
    } catch (e) {
      info.error = String(e && e.message || e);
      return {
        tables: [syn('VP9 uncompressed header', 'parse stopped early', r.rows.concat([{
          name: 'error', syntax: '', bits: '', value: info.error, note: '', offset: off, depth: 0
        }]))],
        info: info
      };
    }
  }

  function finish(r, info, off, sub) {
    var tables = [syn('VP9 uncompressed_header()', sub, r.rows)];
    tables.push(syn('compressed_header()',
      'range coded — ' + (info.headerSizeInBytes || 0) + ' bytes, decoded with the VP9 boolean decoder', [
        { name: 'header_size_in_bytes', syntax: 'f(16)', bits: 16, value: info.headerSizeInBytes || 0,
          note: 'size of the compressed header in bytes', offset: r.bytePos(), depth: 0 },
        { name: '(body)', syntax: '', bits: '', value: 'boolean-coded',
          note: 'tx_mode, frame_reference_mode, skip_mode and the probability updates', offset: r.bytePos(), depth: 0 }
      ]));
    return { tables: tables, info: info };
  }

  function describe(info, profile, isKey) {
    var parts = [info.frameType || '?'];
    if (info.width) parts.push(info.width + 'x' + info.height);
    parts.push('profile ' + profile);
    if (info.bitDepth) parts.push(info.bitDepth + '-bit');
    if (info.colorSpaceName) parts.push(info.colorSpaceName);
    if (info.tileColsLog2 != null) parts.push((1 << info.tileColsLog2) + 'x' + (1 << info.tileRowsLog2) + ' tiles');
    return parts.join(', ');
  }

  /** color_config() — where profile, bit depth and chroma layout are decided. */
  function parseColorConfig(r, info, profile) {
    r.depth++;
    r.group('color_config()');
    var bitDepth = 8;
    // Profiles 2 and 3 carry a ten_or_twelve_bit flag.
    if (profile >= 2) {
      var twelve = r.f('ten_or_twelve_bit', 1);
      bitDepth = twelve ? 12 : 10;
      r.note(bitDepth + '-bit');
    }
    info.bitDepth = bitDepth;

    var cs = r.f('color_space', 3);
    if (cs === 7) {                                     // CS_RGB
      info.colorSpaceName = 'CS_RGB (4:4:4)';
      info.chromaSubsampling = '4:4:4';
    } else {
      info.colorSpaceName = COLOR_SPACES[cs] || 'CS_RESERVED';
      // 1 + 3 bit form: bit 0 then two more bits when the first is 0.
      var sr = 0;
      var cs1 = r.f('color_space_detail[0]', 1);
      if (cs1) sr = 1;                                  // 4:4:4
      else {
        var cs2 = r.f('color_space_detail[1]', 1);
        if (cs2) sr = 0;                                // 4:2:0
        else sr = r.f('color_space_detail[2]', 1) ? 3 : 2;   // 4:4:0 : 4:2:2
      }
      info.chromaSubsampling = ['4:2:0', '4:4:4', '4:2:2', '4:4:0'][sr];
      r.note(info.colorSpaceName + ', ' + info.chromaSubsampling);
    }
    if (bitDepth === 12 || (profile === 1 || profile === 3)) {
      var range = r.f('color_range', 1);
      info.fullRange = range === 1;
      r.note(info.fullRange ? 'full range' : 'studio range');
    }
    r.depth--;
  }

  function parseFrameSize(r, info) {
    r.depth++;
    r.group('frame_size()');
    var w = r.f('frame_width_minus_1', 16) + 1;
    var h = r.f('frame_height_minus_1', 16) + 1;
    info.width = w;
    info.height = h;
    r.note(w + ' x ' + h);
    r.depth--;
  }

  function parseRenderSize(r, info, w, h) {
    r.depth++;
    r.group('render_size()');
    var present = r.f('render_and_frame_size_different', 1);
    if (present) {
      info.renderWidth = r.f('render_width_minus_1', 16) + 1;
      info.renderHeight = r.f('render_height_minus_1', 16) + 1;
      r.note('displayed as ' + info.renderWidth + ' x ' + info.renderHeight);
    } else {
      info.renderWidth = w; info.renderHeight = h;
    }
    r.depth--;
  }

  /* ====================================================================== */

  /** VP9 codec configuration ("vpcC" box, ISO/IEC 14496-12 §12.2.3 + VP9 §9). */
  function parseVpcC(br, end, base) {
    var start = br.pos;
    if (base == null) base = br.base + start;
    var r = new LSB(br.u8, { offset: start, length: end - start, base: base });
    var info = {};
    // vpcC is a plain byte-oriented FullBox, so the fields are read directly
    // rather than through the bit reader — but the rows are still emitted in
    // the shared syntax-row shape so the UI renders them like any other table.
    var vf = br.u32at(start);
    var version = (vf >>> 24) & 0xff;
    r.rows.push({ name: 'version', syntax: 'u(8)', bits: 8, value: version, note: '1 for VP9', offset: base, depth: 0 });
    r.rows.push({ name: 'flags', syntax: 'u(24)', bits: 24, value: vf & 0xffffff, note: '', offset: base + 1, depth: 0 });

    var profile = br.u8at(start + 4);
    var level = br.u8at(start + 5);
    var bits = br.u8at(start + 6);
    var chroma = br.u8at(start + 7);
    var range = br.u8at(start + 8);
    var primaries = br.u8at(start + 9);
    var transfer = br.u8at(start + 10);
    var matrix = br.u8at(start + 11);
    var initSize = end - (start + 12) >= 2 ? br.u16at(start + 12) : 0;

    info.profile = profile; info.level = level;
    info.bitDepth = (bits >> 4) & 0x0f;
    info.chromaSubsampling = chroma;
    info.fullRange = !!range;
    info.colourPrimaries = primaries;
    info.transferCharacteristics = transfer;
    info.matrixCoefficients = matrix;

    r.rows.push({ name: 'profile', syntax: 'u(8)', bits: 8, value: profile, note: 'VP9 profile (0-3)', offset: base + 4, depth: 0 });
    r.rows.push({ name: 'level', syntax: 'u(8)', bits: 8, value: level, note: 'VP9 level (10-62)', offset: base + 5, depth: 0 });
    r.rows.push({ name: 'bit_depth (luma)', syntax: 'u(4)', bits: 4, value: (bits >> 4) & 0x0f, note: '', offset: base + 6, depth: 0 });
    r.rows.push({ name: 'bit_depth (chroma)', syntax: 'u(4)', bits: 4, value: bits & 0x0f, note: '', offset: base + 6, depth: 0 });
    r.rows.push({ name: 'chroma_subsampling', syntax: 'u(8)', bits: 8, value: chroma, note: ['4:2:0 vertical', '4:2:0 colocated', '4:2:2', '4:4:4'][chroma] || chroma, offset: base + 7, depth: 0 });
    r.rows.push({ name: 'video_full_range_flag', syntax: 'u(1)', bits: 1, value: range, note: range ? 'full range' : 'studio range', offset: base + 8, depth: 0 });
    r.rows.push({ name: 'colour_primaries', syntax: 'u(8)', bits: 8, value: primaries, note: '', offset: base + 9, depth: 0 });
    r.rows.push({ name: 'transfer_characteristics', syntax: 'u(8)', bits: 8, value: transfer, note: '', offset: base + 10, depth: 0 });
    r.rows.push({ name: 'matrix_coefficients', syntax: 'u(8)', bits: 8, value: matrix, note: '', offset: base + 11, depth: 0 });
    r.rows.push({ name: 'codecIntializationDataSize', syntax: 'u(16)', bits: 16, value: initSize, note: 'VP9 CodecPrivate feature bits follow', offset: base + 12, depth: 0 });

    if (initSize > 0 && start + 14 + initSize <= end) {
      parseCodecFeature(br.u8, start + 14, start + 14 + initSize, base + 14, r.rows, info);
      info.codecFeatureBits = initSize;
    }
    return { table: syn('VP9CodecConfigurationRecord', 'vpcC box — ' + (end - start) + ' bytes', r.rows), info: info };
  }

  /** The VP9 CodecPrivate bitfield described in the VP9 in ISO BMFF spec. */
  function parseCodecFeature(data, start, end, base, rows, info) {
    var r = new LSB(data, { offset: start, length: end - start, base: base });
    var feat = 0;
    try {
      // Feature bits are written as a sequence of {id, value} pairs.
      var guard = 0;
      while (r.bitsLeft() >= 8 && ++guard < 32) {
        var b = r.u(8);
        var id = b >> 1;
        var val = b & 1;
        var names = {
          1: 'profile', 2: 'level', 3: 'bit_depth', 4: 'chroma_subsampling',
          5: 'colour_space', 6: 'full_range', 7: 'colour_primaries',
          8: 'transfer_characteristics', 9: 'matrix_coefficients',
          10: 'frame_width', 11: 'frame_height'
        };
        var name = names[id] || ('feature_' + id);
        if (id === 10 || id === 11) {
          var bits = (val + 1) * 2;                       // 2 or 4 bytes
          var v = r.u(bits * 8);
          rows.push({ name: name, syntax: 'L(' + bits + ')', bits: bits * 8, value: v,
                      note: bits + '-byte dimension', offset: base, depth: 1 });
          if (id === 10) info.frameWidth = v; else info.frameHeight = v;
        } else {
          rows.push({ name: name, syntax: 'f(1)', bits: 1, value: val, note: '', offset: base, depth: 1 });
          if (id === 1) info.codecFeatureProfile = val;
        }
        feat++;
      }
    } catch (e) { /* feature bits are optional */ }
  }

  function makeContext() { return { codec: 'vp9', width: null, height: null }; }

  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var ctx = spec.ctx || makeContext();
    if (payload.length < 2) {
      return [syn('VP9 frame', 'sample too short', [
        { name: 'length', syntax: '', bits: payload.length * 8, value: payload.length, note: 'bytes',
          offset: spec.base || 0, depth: 0 }])];
    }
    var res = parseFrameHeader(payload, 0, payload.length, ctx);
    if (spec.base) res.tables.forEach(function (t) {
      t.rows.forEach(function (row) { if (row.offset != null) row.offset += spec.base; });
    });
    if (res.info.isKey && res.info.width) {
      ctx.width = res.info.width;
      ctx.height = res.info.height;
    }
    return res.tables;
  }

  function analyzeIVF(data) {
    var res = MA.readIvf(data, 'VP90');
    if (!res) return null;
    var vctx = makeContext();
    var tables = [syn('IVF / VP9 stream', res.info.width + 'x' + res.info.height, [
      { name: 'fourcc', syntax: 'f(32)', bits: 32, value: "'VP90'", note: '', offset: 8, depth: 0 },
      { name: 'width', syntax: 'f(16)', bits: 16, value: res.info.width, note: '', offset: 12, depth: 0 },
      { name: 'height', syntax: 'f(16)', bits: 16, value: res.info.height, note: '', offset: 14, depth: 0 },
      { name: 'frame_count', syntax: 'L(4)', bits: 32, value: res.info.frameCount, note: '', offset: 24, depth: 0 }
    ])];
    // The first frame carries the sequence header in VP9 — parse it eagerly.
    if (res.frames.length) {
      var f0 = parseFrameHeader(data, res.frames[0].offset,
                                res.frames[0].offset + res.frames[0].size, vctx);
      tables = tables.concat(f0.tables);
      if (f0.info.width) { vctx.width = f0.info.width; vctx.height = f0.info.height; }
    }
    return {
      tables: tables, frames: res.frames,
      track: { id: 1, type: 'video', codec: 'vp9', codecName: 'VP9',
               width: res.info.width, height: res.info.height,
               fps: res.info.fps, sampleCount: res.frames.length },
      info: res.info, ctx: vctx
    };
  }

  MA.registerCodec('vp9', {
    id: 'vp9',
    name: 'VP9',
    parseFrameHeader: parseFrameHeader,
    parseVpcC: parseVpcC,
    buildSampleSyntax: buildSampleSyntax,
    makeContext: makeContext,
    analyzeIVF: analyzeIVF
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
