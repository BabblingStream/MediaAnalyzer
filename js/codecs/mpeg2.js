/* ============================================================================
 * MediaAnalyzer — codecs/mpeg2.js
 *
 * MPEG-2 Video (ISO/IEC 13818-2, also covers MPEG-1 Video / 11172-2 — its
 * sequence, GOP and picture headers share the same layout; the extension
 * units simply never occur).
 *
 * The elementary stream is a sequence of start-code units
 * (0x000001 + one suffix byte), the same Annex-B style framing H.264 later
 * reused, so MA.annexBUnits() finds the units. Unlike H.264 there is no
 * emulation-prevention byte in MPEG-2, so units are read verbatim.
 *
 * Decoded per unit:
 *   picture_start (0x00)      temporal_reference, picture_coding_type, …
 *   slice        (0x01–0xAF)  reported with its vertical position
 *   user_data    (0xB2)       reported with its size
 *   sequence_header (0xB3)    dimensions, aspect, frame rate, bit rate, VBV
 *   extension_start (0xB5)    sequence / picture-coding / display extensions
 *   sequence_end (0xB7)
 *   group_start  (0xB8)       GOP time code, closed_gop, broken_link
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var UNIT_NAMES = {
    0x00: 'picture_start', 0xB2: 'user_data', 0xB3: 'sequence_header',
    0xB4: 'sequence_error', 0xB5: 'extension_start', 0xB7: 'sequence_end',
    0xB8: 'group_start'
  };

  var PICTURE_TYPES = ['forbidden', 'I', 'P', 'B', 'D', 'reserved', 'reserved', 'reserved'];

  var ASPECT_RATIOS = ['forbidden', '1:1 (square samples)', '4:3', '16:9', '2.21:1',
                       'reserved', 'reserved', 'reserved', 'reserved', 'reserved',
                       'reserved', 'reserved', 'reserved', 'reserved', 'reserved', 'reserved'];

  /** frame_rate_code -> frames per second. */
  var FRAME_RATES = [0, 24000 / 1001, 24, 25, 30000 / 1001, 30, 50, 60000 / 1001, 60,
                     0, 0, 0, 0, 0, 0, 0];

  var CHROMA_FORMATS = ['reserved', '4:2:0', '4:2:2', '4:4:4'];

  var EXT_NAMES = {
    0: 'sequence_display_extension', 1: 'sequence_extension',
    2: 'picture_display_extension', 3: 'quant_matrix_extension',
    4: 'copyright_extension', 5: 'sequence_scalable_extension',
    7: 'picture_pan_scan_extension', 8: 'picture_coding_extension',
    9: 'picture_spatial_scalable_extension',
    10: 'picture_temporal_scalable_extension',
    11: 'camera_parameters_extension', 12: 'itu_t_extension'
  };

  var PROFILES = { 1: 'High', 2: 'Spatially Scalable', 3: 'SNR Scalable',
                   4: 'Main', 5: 'Simple' };
  /* ISO/IEC 13818-2 Table 8-2: level_id — 4=High, 6=High-1440, 8=Main, 10=Low. */
  var LEVELS = { 4: 'High', 6: 'High-1440', 8: 'Main', 10: 'Low' };

  function unitName(code) {
    if (code >= 0x01 && code <= 0xAF) return 'slice';
    return UNIT_NAMES[code] || ('reserved_0x' + code.toString(16));
  }

  /* ----------------------------------------------------------- unit parsers */

  /** sequence_header: also used by containers to mine the track geometry. */
  function parseSequenceHeader(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var width = sr.u('horizontal_size_value', 12);
    var height = sr.u('vertical_size_value', 12);
    var aspect = sr.u('aspect_ratio_information', 4);
    sr.note(ASPECT_RATIOS[aspect] || 'reserved');
    var rateCode = sr.u('frame_rate_code', 4);
    var fps = FRAME_RATES[rateCode] || 0;
    sr.note(fps ? fps.toFixed(3).replace(/0+$/, '').replace(/\.$/, '') + ' fps' : 'reserved');
    var br = sr.u('bit_rate_value', 18);
    sr.note(br ? MA.formatNum(br * 400) + ' bps' : 'variable');
    sr.u('marker_bit', 1);
    var vbv = sr.u('vbv_buffer_size_value', 10);
    sr.note(MA.formatNum(vbv * 16 * 1024) + ' bits');
    sr.u('constrained_parameters_flag', 1);
    var loadIntra = sr.u('load_intra_quantiser_matrix', 1);
    if (loadIntra) {
      sr.cond('load_intra_quantiser_matrix');
      matrix(sr, 'intra_quantiser_matrix');
      sr.endBlock();
    }
    var loadNonIntra = sr.u('load_non_intra_quantiser_matrix', 1);
    if (loadNonIntra) {
      sr.cond('load_non_intra_quantiser_matrix');
      matrix(sr, 'non_intra_quantiser_matrix');
      sr.endBlock();
    }
    return {
      tables: [MA.synSection('sequence_header', width + ' × ' + height +
                             (fps ? ', ' + fps.toFixed(3) + ' fps' : ''), sr.rows)],
      info: { width: width, height: height, fps: fps || null,
              aspect: ASPECT_RATIOS[aspect] || null,
              bitrate: br ? br * 400 : null }
    };
  }

  function matrix(sr, name) {
    var vals = [];
    for (var i = 0; i < 64; i++) vals.push(sr.u(name + '[' + i + ']', 8));
    /* Collapse the 64 rows into one — the matrix is rarely the interesting part. */
    var first = sr.rows[sr.rows.length - 64];
    sr.rows.length = sr.rows.length - 64;
    sr.rows.push({
      name: name, syntax: 'u(8)[64]', bits: 512,
      value: '[' + vals.slice(0, 8).join(' ') + ' …]', note: '64 entries, 8×8 zig-zag order',
      offset: first.offset, depth: first.depth
    });
  }

  function parseGroupStart(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var drop = sr.u('drop_frame_flag', 1);
    var hh = sr.u('time_code_hours', 5);
    var mm = sr.u('time_code_minutes', 6);
    sr.u('marker_bit', 1);
    var ss = sr.u('time_code_seconds', 6);
    var pp = sr.u('time_code_pictures', 6);
    var closed = sr.u('closed_gop', 1);
    var broken = sr.u('broken_link', 1);
    var tc = MA.pad(hh, 2) + ':' + MA.pad(mm, 2) + ':' + MA.pad(ss, 2) +
             (drop ? ';' : ':') + MA.pad(pp, 2);
    return { tables: [MA.synSection('group_start', 'time code ' + tc +
             (closed ? ', closed' : '') + (broken ? ', broken link' : ''), sr.rows)] };
  }

  /** picture_start: returns the coding type too — containers need it for keyframes. */
  function parsePictureHeader(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var tref = sr.u('temporal_reference', 10);
    var typeCode = sr.u('picture_coding_type', 3);
    var typeName = PICTURE_TYPES[typeCode] || '?';
    sr.note(typeName + ' picture');
    sr.u('vbv_delay', 16, '0xFFFF means variable bit rate');
    if (typeCode === 2 || typeCode === 3) {
      sr.cond('picture_coding_type == P || picture_coding_type == B');
      sr.u('full_pel_forward_vector', 1);
      sr.u('forward_f_code', 3);
      sr.endBlock();
    }
    if (typeCode === 3) {
      sr.cond('picture_coding_type == B');
      sr.u('full_pel_backward_vector', 1);
      sr.u('backward_f_code', 3);
      sr.endBlock();
    }
    var guard = 0;
    while (sr.u('extra_bit_picture', 1) && guard++ < 32) {
      sr.u('extra_information_picture', 8);
    }
    return {
      tables: [MA.synSection('picture_start', typeName + ', temporal_reference ' + tref, sr.rows)],
      info: { type: typeName, temporalReference: tref }
    };
  }

  function parseExtension(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var id = sr.u('extension_start_code_identifier', 4);
    sr.note(EXT_NAMES[id] || ('extension ' + id));
    var name = EXT_NAMES[id] || ('extension ' + id);
    var info = null;

    if (id === 1) {                       /* sequence_extension */
      var pal = sr.u('profile_and_level_indication', 8);
      var prof = PROFILES[(pal >> 4) & 7] || ('profile ' + ((pal >> 4) & 7));
      var lvl = LEVELS[pal & 15] || ('level ' + (pal & 15));
      sr.note(prof + ' @ ' + lvl);
      var progressive = sr.u('progressive_sequence', 1);
      sr.note(progressive ? 'progressive' : 'interlaced');
      var cf = sr.u('chroma_format', 2);
      sr.note(CHROMA_FORMATS[cf] || 'reserved');
      sr.u('horizontal_size_extension', 2);
      sr.u('vertical_size_extension', 2);
      sr.u('bit_rate_extension', 12);
      sr.u('marker_bit', 1);
      sr.u('vbv_buffer_size_extension', 8);
      sr.u('low_delay', 1);
      var n = sr.u('frame_rate_extension_n', 2);
      var d = sr.u('frame_rate_extension_d', 5);
      sr.note('fps × ' + (n + 1) + ' / ' + (d + 1));
      info = { profile: prof, level: lvl };
    } else if (id === 8) {                /* picture_coding_extension */
      sr.u('f_code[0][0] (forward horizontal)', 4);
      sr.u('f_code[0][1] (forward vertical)', 4);
      sr.u('f_code[1][0] (backward horizontal)', 4);
      sr.u('f_code[1][1] (backward vertical)', 4);
      var dcPrec = sr.u('intra_dc_precision', 2);
      sr.note((8 + dcPrec) + ' bits');
      var ps = sr.u('picture_structure', 2);
      sr.note(['reserved', 'top field', 'bottom field', 'frame picture'][ps] || '');
      sr.u('top_field_first', 1);
      sr.u('frame_pred_frame_dct', 1);
      sr.u('concealment_motion_vectors', 1);
      sr.u('q_scale_type', 1);
      sr.u('intra_vlc_format', 1);
      sr.u('alternate_scan', 1);
      sr.u('repeat_first_field', 1);
      sr.u('chroma_420_type', 1);
      sr.u('progressive_frame', 1);
      var composite = sr.u('composite_display_flag', 1);
      if (composite) {
        sr.cond('composite_display_flag');
        sr.u('v_axis', 1);
        sr.u('field_sequence', 3);
        sr.u('sub_carrier', 1);
        sr.u('burst_amplitude', 7);
        sr.u('sub_carrier_phase', 8);
        sr.endBlock();
      }
    } else if (id === 2) {                /* picture_display_extension */
      for (var i = 0; i < 3 && !sr.overrun && sr.bitsLeft() >= 17; i++) {
        sr.u('frame_centre_horizontal_offset[' + i + ']', 16);
        sr.u('marker_bit', 1);
        sr.u('frame_centre_vertical_offset[' + i + ']', 16);
        sr.u('marker_bit', 1);
      }
    }
    /* Every other extension id: the identifier row above is all we decode. */
    return { tables: [MA.synSection(name, '', sr.rows)], info: info };
  }

  /* ------------------------------------------------------------- assembly */

  /**
   * Syntax tables for one access unit / PES payload of MPEG-1/2 video.
   * @param {Uint8Array} payload  start-code framed bytes
   * @param {object} spec         { base, ctx }
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var base = spec.base || 0;
    var ctx = spec.ctx || (spec.ctx = {});
    var tables = [];
    var units = MA.annexBUnits(payload, payload.length);
    var maxUnits = 64;

    for (var i = 0; i < units.length && maxUnits-- > 0; i++) {
      var u = units[i];
      var code = payload[u.start];
      if (code == null) continue;
      var name = unitName(code);
      var ubase = base + u.start;
      var body = payload.subarray(u.start + 1, u.end);
      var scRow = {
        name: 'start_code_prefix + suffix', syntax: 'f(24)+u(8)', bits: 32,
        value: '0x000001' + MA.pad(code.toString(16), 2),
        note: name, offset: base + u.sc, depth: 0
      };

      try {
        if (code === 0xB3) {
          var seq = parseSequenceHeader(body, ubase + 1);
          seq.tables[0].rows.unshift(scRow);
          ctx.seq = seq.info;
          tables.push(seq.tables[0]);
        } else if (code === 0x00) {
          var pic = parsePictureHeader(body, ubase + 1);
          pic.tables[0].rows.unshift(scRow);
          tables.push(pic.tables[0]);
        } else if (code === 0xB5) {
          var ext = parseExtension(body, ubase + 1);
          ext.tables[0].rows.unshift(scRow);
          if (ext.info) ctx.profile = ext.info.profile;
          tables.push(ext.tables[0]);
        } else if (code === 0xB8) {
          var gop = parseGroupStart(body, ubase + 1);
          gop.tables[0].rows.unshift(scRow);
          tables.push(gop.tables[0]);
        } else {
          /* slice / user_data / sequence_end / reserved — reported, not decoded. */
          tables.push(MA.synSection(name, '', [scRow, {
            name: name === 'slice' ? 'slice_vertical_position' : 'payload',
            syntax: '', bits: '',
            value: name === 'slice' ? code : (u.end - u.start - 1) + ' bytes',
            note: name === 'slice' ? '' : 'not decoded',
            offset: ubase + 1, depth: 0
          }]));
        }
      } catch (e) {
        tables.push(MA.synSection(name, 'parse error', [scRow, {
          name: 'error', syntax: '', bits: '', value: String(e && e.message || e),
          note: '', offset: ubase, depth: 0
        }]));
      }
    }
    if (!tables.length) {
      tables.push(MA.synSection('sample', 'No start-code unit could be extracted.', [{
        name: 'payload', syntax: '', bits: '', value: payload.length + ' bytes',
        note: '', offset: base, depth: 0
      }]));
    }
    return tables;
  }

  /**
   * Keyframe/type probe for containers: the picture_coding_type of the first
   * picture_start unit in `bytes` ('I' | 'P' | 'B' | 'D' | null).
   */
  function firstPictureType(bytes) {
    var units = MA.annexBUnits(bytes, bytes.length);
    for (var i = 0; i < units.length; i++) {
      if (bytes[units[i].start] !== 0x00) continue;
      var b = units[i].start + 1;
      if (b + 1 >= units[i].end || b + 1 >= bytes.length) continue;
      /* picture_coding_type sits at bit offset 10 of the picture header:
       * temporal_reference is b0(8) + top 2 bits of b1, then 3 bits of type. */
      var typeCode = (bytes[b + 1] >> 3) & 0x07;
      return PICTURE_TYPES[typeCode] || null;
    }
    return null;
  }

  MA.registerCodec('mpeg2', {
    id: 'mpeg2',
    name: 'MPEG-2 Video',
    parseSequenceHeader: parseSequenceHeader,
    parsePictureHeader: parsePictureHeader,
    firstPictureType: firstPictureType,
    buildSampleSyntax: buildSampleSyntax
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
