/* ============================================================================
 * MediaAnalyzer — codecs/mpeg4p2.js
 *
 * MPEG-4 Part 2 Visual (ISO/IEC 14496-2 — DivX/Xvid-era "MPEG-4").
 *
 * The stream is start-code framed exactly like MPEG-2 video:
 * 0x000001 followed by one suffix byte identifying the unit:
 *   0x00–0x1F  video_object_start
 *   0x20–0x2F  video_object_layer_start   — the VOL header: geometry + timing
 *   0xB0       visual_object_sequence_start — profile_and_level_indication
 *   0xB1       visual_object_sequence_end
 *   0xB2       user_data                  — often the encoder tag ("XviD…")
 *   0xB3       group_of_vop_start         — GOV time code
 *   0xB5       visual_object_start
 *   0xB6       vop_start                  — one coded picture (I/P/B/S)
 *
 * A VOP header's time_increment field width depends on the VOL's
 * vop_time_increment_resolution, so the VOL info is kept on the shared
 * context (`spec.ctx.vol`) the container hands to every sample.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var VOP_TYPES = ['I', 'P', 'B', 'S'];

  var ASPECT_RATIOS = ['forbidden', '1:1 (square)', '12:11', '10:11', '16:11', '40:33',
                       'reserved', 'reserved', 'reserved', 'reserved', 'reserved',
                       'reserved', 'reserved', 'reserved', 'reserved', 'extended PAR'];

  var SHAPES = ['rectangular', 'binary', 'binary only', 'grayscale'];

  var OBJECT_TYPES = { 1: 'video', 2: 'still texture', 3: 'mesh', 4: 'face' };

  /** profile_and_level_indication (high nibble = profile, low = level). */
  var PAL_PROFILES = {
    0x1: 'Simple', 0x2: 'Simple Scalable', 0x3: 'Core', 0x4: 'Main',
    0x5: 'N-bit', 0x6: 'Scalable Texture', 0x7: 'Simple Face',
    0x8: 'Basic Animated Texture', 0x9: 'Hybrid', 0xA: 'Advanced Real-Time Simple',
    0xB: 'Core Scalable', 0xC: 'Advanced Coding Efficiency',
    0xD: 'Advanced Core', 0xE: 'Advanced Scalable Texture', 0xF: 'Advanced Simple'
  };

  function palName(pal) {
    var prof = PAL_PROFILES[pal >> 4] || ('profile ' + (pal >> 4));
    return prof + ' Profile @ L' + (pal & 15);
  }

  /* ------------------------------------------------------------ VOL header */

  /**
   * video_object_layer: geometry, timing and shape. The bit layout that trips
   * implementations up is the order — vop_time_increment_resolution sits
   * between the shape field and the width/height, not after them.
   */
  function parseVOL(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    sr.u('random_accessible_vol', 1);
    var objType = sr.u('video_object_type_indication', 8);
    sr.note(OBJECT_TYPES[objType] || '');
    var hasId = sr.u('is_object_layer_identifier', 1);
    var verid = 1;
    if (hasId) {
      sr.cond('is_object_layer_identifier');
      verid = sr.u('video_object_layer_verid', 4);
      sr.u('video_object_layer_priority', 3);
      sr.endBlock();
    }
    var par = sr.u('aspect_ratio_info', 4);
    sr.note(ASPECT_RATIOS[par] || 'reserved');
    if (par === 15) {
      sr.cond('aspect_ratio_info == 15 (extended PAR)');
      sr.u('par_width', 8);
      sr.u('par_height', 8);
      sr.endBlock();
    }
    var hasCtl = sr.u('vol_control_parameters', 1);
    if (hasCtl) {
      sr.cond('vol_control_parameters');
      var cf = sr.u('chroma_format', 2);
      sr.note(['reserved', '4:2:0', '4:2:2', '4:4:4'][cf] || '');
      sr.u('low_delay', 1);
      var hasVbv = sr.u('vbv_parameters', 1);
      if (hasVbv) {
        sr.cond('vbv_parameters');
        sr.u('first_half_bit_rate', 15); sr.u('marker_bit', 1);
        sr.u('latter_half_bit_rate', 15); sr.u('marker_bit', 1);
        sr.u('first_half_vbv_buffer_size', 15); sr.u('marker_bit', 1);
        sr.u('latter_half_vbv_buffer_size', 3);
        sr.u('first_half_vbv_occupancy', 11); sr.u('marker_bit', 1);
        sr.u('latter_half_vbv_occupancy', 15); sr.u('marker_bit', 1);
        sr.endBlock();
      }
      sr.endBlock();
    }
    var shape = sr.u('video_object_layer_shape', 2);
    sr.note(SHAPES[shape] || '');
    if (shape === 3 && verid !== 1) {
      sr.cond('video_object_layer_shape == 3 && video_object_layer_verid != 1');
      sr.u('video_object_layer_shape_extension', 4);
      sr.endBlock();
    }
    sr.u('marker_bit', 1);
    var tir = sr.u('vop_time_increment_resolution', 16);
    sr.note(tir + ' ticks/s');
    sr.u('marker_bit', 1);
    var fixedRate = sr.u('fixed_vop_rate', 1);
    var timeIncBits = 0;
    while ((1 << timeIncBits) < tir) timeIncBits++;
    if (fixedRate && timeIncBits) {
      sr.cond('fixed_vop_rate');
      sr.u('fixed_vop_time_increment', timeIncBits);
      sr.endBlock();
    }

    var width = null, height = null, interlaced = null;
    if (shape !== 2) {                     /* not "binary only" */
      sr.cond('video_object_layer_shape != 2 (binary only)');
      if (shape === 0) {
        sr.cond('video_object_layer_shape == 0 (rectangular)');
        sr.u('marker_bit', 1);
        width = sr.u('video_object_layer_width', 13);
        sr.u('marker_bit', 1);
        height = sr.u('video_object_layer_height', 13);
        sr.u('marker_bit', 1);
        sr.endBlock();
      }
      interlaced = sr.u('interlaced', 1);
      sr.u('obmc_disable', 1);
      var sprite = verid === 1 ? sr.u('sprite_usage', 1) : sr.u('sprite_usage', 2);
      if ((sprite === 1 || sprite === 2) && shape !== 0) {
        sr.cond('sprite_usage && shape != rectangular');
        sr.u('sprite_width', 13); sr.u('marker_bit', 1);
        sr.u('sprite_height', 13); sr.u('marker_bit', 1);
        sr.u('sprite_left_coordinate', 13); sr.u('marker_bit', 1);
        sr.u('sprite_top_coordinate', 13); sr.u('marker_bit', 1);
        sr.endBlock();
      }
      sr.endBlock();
    }
    return {
      tables: [MA.synSection('video_object_layer',
        (width ? width + ' × ' + height : SHAPES[shape] || '') +
        (tir ? ', ' + tir + ' ticks/s' : '') +
        (interlaced ? ', interlaced' : ''),
        sr.rows)],
      info: {
        width: width, height: height,
        timeIncrementResolution: tir,
        timeIncrementBits: timeIncBits,
        fixedVopRate: !!fixedRate,
        interlaced: interlaced
      }
    };
  }

  /* ------------------------------------------------------------ VOP header */

  /**
   * vop_start: coding type plus the timestamp fields. Everything past
   * vop_coded depends on VOL flags the panel usually doesn't care about, so
   * the parse stops there and says so.
   */
  function parseVop(bytes, base, vol) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var typeCode = sr.u('vop_coding_type', 2);
    var typeName = VOP_TYPES[typeCode] || '?';
    sr.note(typeName + ' VOP');
    var modulo = 0, guard = 0;
    while (sr.bitsLeft() > 0 && sr.u('modulo_time_base', 1) && guard++ < 64) modulo++;
    if (guard) sr.note('modulo base ' + modulo);
    sr.u('marker_bit', 1);
    var incBits = vol && vol.timeIncrementBits != null ? vol.timeIncrementBits : 0;
    if (incBits) {
      var inc = sr.u('time_increment', incBits);
      if (vol.timeIncrementResolution) {
        sr.note('+' + (inc / vol.timeIncrementResolution).toFixed(3) + ' s');
      }
    } else {
      sr.rows.push({
        name: 'time_increment', syntax: 'u(v)', bits: 0,
        value: '—', note: 'width unknown — no VOL seen yet',
        offset: base + Math.floor(sr.bitPos() / 8), depth: 0
      });
    }
    sr.u('marker_bit', 1);
    var coded = sr.u('vop_coded', 1);
    if (!coded) sr.note('not coded (skipped VOP)');
    return {
      tables: [MA.synSection('vop_start', typeName + ' VOP', sr.rows)],
      info: { type: typeName }
    };
  }

  function parseGov(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var tc = sr.u('time_code', 18);
    var hh = tc >> 12, mm = (tc >> 6) & 0x3F, ss = tc & 0x3F;
    sr.note(MA.pad(hh, 2) + ':' + MA.pad(mm, 2) + ':' + MA.pad(ss, 2));
    sr.u('closed_gov', 1);
    sr.u('broken_link', 1);
    return { tables: [MA.synSection('group_of_vop_start', '', sr.rows)] };
  }

  function parseVosStart(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var pal = sr.u('profile_and_level_indication', 8);
    sr.note(palName(pal));
    return {
      tables: [MA.synSection('visual_object_sequence_start', palName(pal), sr.rows)],
      info: { pal: pal, profile: palName(pal) }
    };
  }

  function parseVisualObject(bytes, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, epb: false });
    var hasId = sr.u('is_visual_object_identifier', 1);
    if (hasId) {
      sr.u('visual_object_verid', 4);
      sr.u('visual_object_priority', 3);
    }
    var t = sr.u('visual_object_type', 4);
    sr.note(OBJECT_TYPES[t] || '');
    return { tables: [MA.synSection('visual_object', '', sr.rows)] };
  }

  /* ------------------------------------------------------------- assembly */

  function unitName(code) {
    if (code <= 0x1F) return 'video_object_start';
    if (code >= 0x20 && code <= 0x2F) return 'video_object_layer_start';
    switch (code) {
      case 0xB0: return 'visual_object_sequence_start';
      case 0xB1: return 'visual_object_sequence_end';
      case 0xB2: return 'user_data';
      case 0xB3: return 'group_of_vop_start';
      case 0xB5: return 'visual_object';
      case 0xB6: return 'vop_start';
      default: return 'reserved_0x' + code.toString(16);
    }
  }

  /**
   * Syntax tables for one MPEG-4 Visual access unit. Works for both TS PES
   * payloads and MP4/MKV samples — the sample content is start-code framed in
   * every container, so `spec.lengthSize`/`spec.annexB` are ignored.
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var base = spec.base || 0;
    var ctx = spec.ctx || (spec.ctx = {});
    var tables = [];
    var units = MA.annexBUnits(payload, payload.length);
    var maxUnits = 64;
    var seenVol = false;

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
        if (code === 0xB6) {
          var vop = parseVop(body, ubase + 1, ctx.vol);
          vop.tables[0].rows.unshift(scRow);
          tables.push(vop.tables[0]);
        } else if (code >= 0x20 && code <= 0x2F) {
          var vol = parseVOL(body, ubase + 1);
          vol.tables[0].rows.unshift(scRow);
          if (!seenVol) {                     /* one VOL per panel is enough */
            seenVol = true;
            ctx.vol = vol.info;
            tables.push(vol.tables[0]);
          }
        } else if (code === 0xB0) {
          var vos = parseVosStart(body, ubase + 1);
          vos.tables[0].rows.unshift(scRow);
          ctx.profile = vos.info.profile;
          tables.push(vos.tables[0]);
        } else if (code === 0xB3) {
          var gov = parseGov(body, ubase + 1);
          gov.tables[0].rows.unshift(scRow);
          tables.push(gov.tables[0]);
        } else if (code === 0xB5) {
          var vis = parseVisualObject(body, ubase + 1);
          vis.tables[0].rows.unshift(scRow);
          tables.push(vis.tables[0]);
        } else if (code === 0xB2) {
          /* user_data: encoders sign here — show it as text when printable. */
          var text = '';
          for (var k = 0; k < body.length && k < 64; k++) {
            var c = body[k];
            if (c >= 0x20 && c <= 0x7e) text += String.fromCharCode(c);
            else if (c !== 0) { text = ''; break; }
          }
          tables.push(MA.synSection('user_data', '', [scRow, {
            name: 'user_data', syntax: '', bits: '',
            value: text ? '"' + text + '"' : (body.length + ' bytes'),
            note: '', offset: ubase + 1, depth: 0
          }]));
        } else {
          tables.push(MA.synSection(name, '', [scRow, {
            name: 'payload', syntax: '', bits: '',
            value: (u.end - u.start - 1) + ' bytes', note: 'not decoded',
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
   * Keyframe/type probe for containers: the vop_coding_type of the first
   * vop_start unit in `bytes` ('I' | 'P' | 'B' | 'S' | null).
   */
  function firstVopType(bytes) {
    var units = MA.annexBUnits(bytes, bytes.length);
    for (var i = 0; i < units.length; i++) {
      if (bytes[units[i].start] !== 0xB6) continue;
      var b = units[i].start + 1;
      if (b >= units[i].end || b >= bytes.length) continue;
      return VOP_TYPES[bytes[b] >> 6] || null;
    }
    return null;
  }

  MA.registerCodec('mpeg4', {
    id: 'mpeg4',
    name: 'MPEG-4 Visual',
    palName: palName,
    parseVOL: parseVOL,
    parseVop: parseVop,
    firstVopType: firstVopType,
    buildSampleSyntax: buildSampleSyntax
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
