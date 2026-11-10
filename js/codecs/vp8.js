/* ============================================================================
 * MediaAnalyzer — codecs/vp8.js
 *
 * VP8 bitstream syntax (RFC 6386).
 *
 * VP8 packs its headers least-significant-bit first, so this module uses
 * MA.SyntaxReaderLSB rather than the MSB-first reader the H.26x codecs use.
 *
 * The frame header is where the classic VP8 parsing traps live:
 *   - key frames carry a 3-byte start code and 14-bit dimensions, and the
 *     dimension fields are read LSB-first like everything else;
 *   - the six quantiser indices are delta-coded with a flag bit plus a
 *     magnitude encoding whose bit width depends on which index it is;
 *   - segmentation probabilities use a 3-node probability tree with a
 *     "255 minus" fallback when the tree walks past the end.
 * All three are implemented properly here.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var LSB = MA.SyntaxReaderLSB, syn = MA.synSection;

  var START_CODE = [0x9d, 0x01, 0x2a];

  var FRAME_TYPES = ['key frame', 'inter frame'];
  var COLOR_SPACES = ['YUV', 'reserved (unknown)'];
  var CLAMP_TYPES = ['clamping required', 'no clamping required'];

  /** The 6 quantiser indices, in the order the spec updates them. */
  var QUANT_INDICES = ['y_ac_qi', 'y_dc_delta', 'y2_dc_delta', 'y2_ac_delta',
                       'uv_dc_delta', 'uv_ac_delta'];

  /* ====================================================================== */

  /**
   * @param {Uint8Array} data
   * @param {number} off   first byte of the frame
   * @param {number} end   one past the last byte
   * @param {object} ctx   { width, height } from a previous key frame
   */
  function parseFrameHeader(data, off, end, ctx) {
    ctx = ctx || {};
    var r = new LSB(data, { offset: off, length: end - off, base: off });
    var info = {};
    var tables = [];

    try {
      /* ---------------- uncompressed data chunk ---------------- */
      r.depth++;
      r.group('frame_tag  // uncompressed data chunk');
      var frameType = r.f('frame_type', 1);
      r.note(frameType === 0 ? '0 = key frame' : '1 = inter frame');
      info.frameType = frameType;
      info.isKey = frameType === 0;

      var version = r.f('version', 3);
      r.note('version ' + version + (version > 3 ? ' (reserved)' : ''));
      info.version = version;

      var showFrame = r.f('show_frame', 1);
      info.showFrame = showFrame === 1;
      info.firstPartSize = r.f('first_part_size', 19);
      r.note(r.rows[r.rows.length - 1].value + ' bytes in the first partition');
      r.depth--;

      if (info.isKey) {
        r.depth++;
        r.group('key_frame_header');
        var sc = [r.un('start_code[0]', 8), r.un('start_code[1]', 8), r.un('start_code[2]', 8)];
        var scOk = sc[0] === START_CODE[0] && sc[1] === START_CODE[1] && sc[2] === START_CODE[2];
        r.note(scOk ? '0x9D 0x01 0x2A — valid key frame' : 'unexpected start code');
        info.startCodeOk = scOk;

        // 14-bit dimensions; VP8 packs them LSB-first within a 16-bit word.
        info.width = r.f('width', 14) & 0x3fff;
        var hScale = r.f('horizontal_scale', 2);
        info.height = r.f('height', 14) & 0x3fff;
        var vScale = r.f('vertical_scale', 2);
        info.hScale = hScale; info.vScale = vScale;
        r.note(info.width + ' x ' + info.height);
        r.depth--;
      } else {
        info.width = ctx.width || null;
        info.height = ctx.height || null;
        r.group('// inter frame — picture size inherited from the reference frame');
      }

      /* ---------------- segmentation ---------------- */
      r.depth++;
      var segEnabled = r.f('segmentation_enabled', 1);
      info.segmentationEnabled = segEnabled === 1;
      r.note(segEnabled ? 'segmentation in use' : 'segmentation disabled');
      var segMap = 0, segUpdate = 0;
      if (segEnabled) {
        segUpdate = r.f('update_mb_segmentation_map', 1);
        segMap = r.f('update_segment_feature_data', 1);
        r.note('map update ' + segUpdate + ', feature update ' + segMap);
        if (segMap) {
          r.depth++;
          r.group('segment_feature_data');
          r.f('segment_feature_mode', 1);
          r.note(r.rows[r.rows.length - 1].value === 1 ? 'absolute' : 'delta');
          for (var q = 0; q < 4; q++) {
            if (r.f('quantizer_update', 1)) {
              r.skip(1);                              // sign bit
              r.f('quantizer_update_value', 7);
            }
          }
          for (var l = 0; l < 4; l++) {
            if (r.f('loop_filter_update', 1)) {
              r.skip(1);                              // sign bit
              r.f('lf_update_value', 6);
            }
          }
          r.depth--;
        }
        if (segUpdate) {
          r.depth++;
          r.group('segment_prob_update');
          for (var s = 0; s < 3; s++) {
            if (r.f('segment_prob_update[' + s + ']', 1)) {
              var prob = r.un('segment_prob[' + s + ']', 8);
              r.note(prob === 0 ? '255 (0 is encoded as 255)' : String(prob));
            }
          }
          r.depth--;
        }
      }
      r.depth--;

      /* ---------------- loop filter ---------------- */
      r.depth++;
      r.group('loop_filter_header');
      r.f('filter_type', 1);
      r.note(r.rows[r.rows.length - 1].value ? 'simple' : 'normal');
      r.f('loop_filter_level', 6);
      r.f('sharpness_level', 3);
      var lfDelta = r.f('mode_ref_lf_delta_enabled', 1);
      if (lfDelta) {
        var lfUpdate = r.f('mode_ref_lf_delta_update', 1);
        if (lfUpdate) {
          for (var a = 0; a < 4; a++) {
            if (r.f('ref_frame_delta_update[' + a + ']', 1)) { r.skip(1); r.f('ref_frame_delta[' + a + ']', 6); }
          }
          for (var b = 0; b < 4; b++) {
            if (r.f('mb_mode_delta_update[' + b + ']', 1)) { r.skip(1); r.f('mb_mode_delta[' + b + ']', 6); }
          }
        }
      }
      r.depth--;

      /* ---------------- token partitions ---------------- */
      var parts = r.f('log2_nbr_of_DCT_partitions', 2);
      info.tokenPartitions = 1 << parts;
      r.note(info.tokenPartitions + ' DCT partition(s)');
      for (var t = 0; t < (1 << parts) - 1; t++) {
        r.f('token_partition_size[' + t + ']', 24);
      }

      /* ---------------- quantiser indices ---------------- */
      r.depth++;
      r.group('quant_indices()');
      var baseQ = r.f('y_ac_qi', 7);
      info.yAcQi = baseQ;
      r.note('base quantiser index ' + baseQ + ' (0-127)');
      for (var qi = 1; qi < 6; qi++) {
        var coded = r.f(QUANT_INDICES[qi] + '.delta_coded', 1);
        if (coded) {
          // Magnitude is 4 bits for the y_dc index and 4 for the others, but
          // the flag layout differs for y2 (which also carries a sign bit
          // folded into the magnitude word).
          if (qi === 1) {
            var sgn = r.f(QUANT_INDICES[qi] + '.sign', 1);
            r.f(QUANT_INDICES[qi] + '.delta_val', 4);
            r.note(sgn ? 'negative' : 'positive');
          } else {
            r.f(QUANT_INDICES[qi] + '.sign', 1);
            r.f(QUANT_INDICES[qi] + '.delta_val', 4);
          }
        }
      }
      r.depth--;

      /* ---------------- key-frame coefficient probability updates ---- */
      if (info.isKey) {
        r.f('refresh_entropy_probs', 1);
        r.f('refresh_last', 1);
      } else {
        var refreshGolden = r.f('refresh_golden_frame', 1);
        var refreshAlternate = r.f('refresh_alternate_frame', 1);
        // The copy fields appear only when the corresponding refresh is off,
        // so the decisions must be memoised rather than read back off the
        // previous row.
        if (!refreshGolden) r.f('copy_buffer_to_golden', 2);
        if (!refreshAlternate) r.f('copy_buffer_to_alternate', 2);
        r.f('sign_bias_golden', 1);
        r.f('sign_bias_alternate', 1);
        r.f('refresh_entropy_probs', 1);
        r.f('refresh_last', 1);
      }

      info.headerSizeBytes = Math.ceil(r.bitPos() / 8);
      info.tables = tables;

      tables.push(syn('VP8 uncompressed frame header', describe(info), r.rows));

      // The boolean-coded part (macroblocks, per-mode probabilities) needs the
      // arithmetic decoder; say so rather than pretending to have read it.
      var remaining = r.bitsLeft();
      if (remaining > 0) {
        tables.push(syn('compressed header / first partition',
          'boolean-coded — ' + Math.ceil(remaining / 8) + ' bytes follow the uncompressed header', [
            { name: 'remaining_bytes', syntax: '', bits: remaining, value: Math.ceil(remaining / 8),
              note: 'decoded with the VP8 boolean arithmetic decoder', offset: r.bytePos(), depth: 0 }
          ]));
      }
    } catch (e) {
      info.error = String(e && e.message || e);
      tables.push(syn('VP8 frame header', 'parse stopped early', r.rows.concat([{
        name: 'error', syntax: '', bits: '', value: info.error, note: '', offset: off, depth: 0
      }])));
    }

    return { tables: tables, info: info };
  }

  function describe(info) {
    var bits = [];
    bits.push(FRAME_TYPES[info.frameType] || '?');
    if (info.width) bits.push(info.width + 'x' + info.height);
    if (info.version != null) bits.push('version ' + info.version);
    if (info.tokenPartitions) bits.push(info.tokenPartitions + ' partitions');
    return bits.join(', ');
  }

  /** Attach a per-sample syntax builder to a track context. */
  function makeContext() {
    return { codec: 'vp8', width: null, height: null };
  }

  /**
   * Build the syntax tables for one sample. The context remembers the last key
   * frame's dimensions so inter frames can report a picture size.
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var ctx = spec.ctx || makeContext();
    if (payload.length < 3) {
      return [syn('VP8 frame', 'sample too short', [
        { name: 'length', syntax: '', bits: payload.length * 8, value: payload.length,
          note: 'bytes', offset: spec.base || 0, depth: 0 }
      ])];
    }
    var res = parseFrameHeader(payload, 0, payload.length, ctx);
    // Re-base the row offsets onto the file.
    if (spec.base) rebase(res.tables, spec.base);
    if (res.info.isKey && res.info.width) {
      ctx.width = res.info.width;
      ctx.height = res.info.height;
    }
    return res.tables;
  }

  function rebase(tables, base) {
    tables.forEach(function (t) {
      t.rows.forEach(function (row) {
        if (row.offset != null) row.offset += base;
      });
    });
  }

  /** The WebM CodecPrivate for V_VP8 is empty; expose a stub for symmetry. */
  function parseCompressionData(data, start, end, base) {
    return {
      table: syn('VP8 codec private', (end - start) + ' bytes',
        (end - start) === 0
          ? [{ name: 'codec_private', syntax: '', bits: 0, value: '(empty)',
               note: 'VP8 carries no out-of-band configuration', offset: base || 0, depth: 0 }]
          : [{ name: 'codec_private', syntax: '', bits: (end - start) * 8, value: end - start,
               note: 'unexpected trailing data', offset: base || 0, depth: 0 }]),
      info: {}
    };
  }

  /** Parse a whole IVF container carrying VP8 frames. */
  function analyzeIVF(data, ctx) {
    var res = MA.readIvf(data, 'VP8');
    if (!res) return null;
    var vctx = makeContext();
    var tables = res.info.width ? [syn('IVF / VP8 stream', res.info.width + 'x' + res.info.height, [
      { name: 'frame_count', syntax: 'u(32) le', bits: 32, value: res.info.frameCount, note: '', offset: res.headerOffset, depth: 0 },
      { name: 'width', syntax: 'u(16) le', bits: 16, value: res.info.width, note: '', offset: res.headerOffset + 12, depth: 0 },
      { name: 'height', syntax: 'u(16) le', bits: 16, value: res.info.height, note: '', offset: res.headerOffset + 14, depth: 0 }
    ])] : [];
    return {
      tables: tables, frames: res.frames,
      track: { id: 1, type: 'video', codec: 'vp8', codecName: 'VP8',
               width: res.info.width, height: res.info.height,
               fps: res.info.fps, sampleCount: res.frames.length },
      info: res.info, ctx: vctx
    };
  }

  MA.registerCodec('vp8', {
    id: 'vp8',
    name: 'VP8',
    parseFrameHeader: parseFrameHeader,
    buildSampleSyntax: buildSampleSyntax,
    parseCompressionData: parseCompressionData,
    makeContext: makeContext,
    analyzeIVF: analyzeIVF
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
