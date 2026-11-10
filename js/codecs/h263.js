/* ============================================================================
 * MediaAnalyzer — codecs/h263.js
 *
 * ITU-T H.263 video ("H.263 baseline", H.263v1 — the codec used inside
 * Sorenson Spark / 3GPP .3gp / ASF "H263" streams).
 *
 * Unlike MPEG-2/4 there is no 00 00 01 prefix: every unit starts with a
 * 22-bit start code, 16 zero bits followed by six code bits. The next two
 * bits already belong to the payload (high bits of TR), so on disk:
 *   00 00 80..83  PSC (picture, 22-bit code 0x20)
 *   00 00 84..ef  GOB #1..#27 (22-bit code 0x21 .. 0x3b, third byte >> 2)
 *
 * Baseline picture header (MSB first, ITU-T H.263 §5.1.3):
 *   PSC(22) temporal_reference(8) marker(1)=1 zero(1)=0
 *   split_screen(1) document_camera(1) freeze_release(1)
 *   source_format(3) picture_coding_type(1) UMV(1) SAC(1) AP(1) PB(1)
 *   quantizer(5) CPM(1) [PSBI(2)] [if PB: TRB(3) DBQUANT(2)] PEI/PSUPP…
 *
 * source_format 7 means H.263+ PLUSPTYPE; 6 means custom CPFMT — both are
 * parsed best effort (the mandatory fields), the fixture is plain baseline.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  /** source_format resolution table (H.263 Table 1). */
  var SRC_FORMATS = {
    0: ['forbidden', null, null],
    1: ['sub-QCIF', 128, 96],
    2: ['QCIF', 176, 144],
    3: ['CIF', 352, 288],
    4: ['4CIF', 704, 576],
    5: ['16CIF', 1408, 1152],
    6: ['custom picture format (CPFMT)', null, null],
    7: ['extended PTYPE (H.263+ PLUSPTYPE)', null, null]
  };

  /** CPFMT pixel_aspect_ratio codes (H.263 Table 2). */
  var ASPECT_RATIOS = {
    0: 'forbidden', 1: '1:1', 2: '12:11 (CIF, 4:3)', 3: '10:11 (4CIF)',
    4: '16:11 (16:9)', 5: '40:33', 15: 'extended PAR (PARW/PARH follow)'
  };
  for (var ar = 6; ar <= 14; ar++) ASPECT_RATIOS[ar] = 'reserved';

  var PICTURE_TYPES = ['I', 'P'];

  var PLUS_PICTURE_TYPES = ['I', 'P', 'PB', 'B'];

  /* --------------------------------------------------------- unit scanner */

  /**
   * Scan H.263 22-bit start codes: 16 zero bits then six code bits.
   *
   * The third byte carries the six code bits in its MSBs plus TWO payload
   * bits (high bits of TR for a picture, GOB data otherwise) — so on disk
   * PSC 0x20 appears as 0x80..0x83 and GOB #n (0x20+n) as (0x20+n)<<2
   * set: GOB1 = 0x84..0x87 … GOB27 = 0xec..0xef. The code is `b >> 2`,
   * never `b & 0x3f` (that folds TR bits into the code).
   * Returns [{ off, code }] with code the 22-bit value (0x20 = picture).
   */
  function scanUnits(bytes, limit) {
    var units = [];
    var cap = limit || 64;
    for (var i = 0; i + 2 < bytes.length && units.length < cap; i++) {
      if (bytes[i] !== 0x00 || bytes[i + 1] !== 0x00) continue;
      var b = bytes[i + 2];
      var code = b >> 2;
      if (code < 0x20 || code > 0x3b) continue;
      units.push({ off: i, code: code });
      // Skip past the candidate so nested look-alikes are not re-reported.
      i += 2;
    }
    return units;
  }

  /* ------------------------------------------------------- picture header */

  /**
   * Decode the picture header at a PSC unit. Returns { rows, info } or null
   * when the bits do not validate as a picture header (used to reject random
   * 00 00 8x triples inside coded data).
   */
  function readPictureHeader(bytes, off, base) {
    var sr = new MA.SyntaxReader(bytes, { base: base, offset: off, epb: false });
    if (sr.bitsLeft() < 22 + 8 + 4 + 3 + 9) return null;

    var psc = sr.u('picture_start_code (PSC)', 22);
    sr.note('0x' + MA.pad(psc.toString(16), 6));
    if (psc !== 0x20) return null;

    var tr = sr.u('temporal_reference', 8);
    sr.note('frame ' + tr + ' (mod 256)');

    var marker = sr.u('marker_bit', 1);
    if (marker !== 1) return null;
    var ver = sr.u('zero_bit (H.263 version id)', 1);
    if (ver !== 0) return null;

    var split = sr.u('split_screen_indicator', 1);
    var camera = sr.u('document_camera_indicator', 1);
    var freeze = sr.u('full_picture_freeze_release', 1);

    var format = sr.u('source_format', 3);
    var fmtInfo = SRC_FORMATS[format] || ['reserved', null, null];
    sr.note(format + ' — ' + fmtInfo[0] + (fmtInfo[1] ? ' ' + fmtInfo[1] + '×' + fmtInfo[2] : ''));

    var info = { tr: tr, format: format, width: fmtInfo[1], height: fmtInfo[2],
                 type: null, quant: null };

    if (format === 7) {
      sr.cond('source_format == 7 (extended PTYPE / H.263+)');
      readPlusPType(sr, info);
      sr.endBlock();
    } else if (format === 6) {
      // Baseline PTYPE fields come first; CPFMT is read after them.
      sr.cond('source_format == 6 (custom picture format)');
      readBaselinePType(sr, info);
      readCpfmt(sr, info);
      sr.endBlock();
    } else {
      readBaselinePType(sr, info);
    }

    if (info.format === 7) {
      // H.263+: remaining fields (UUI, TR, frame indices…) are optional and
      // rarely needed; stop cleanly instead of risking a mis-parse.
      sr.rows.push({
        name: '…', syntax: '', bits: '', value: 'H.263+ optional fields',
        note: 'not decoded', offset: base + off + Math.floor(sr.bitPos() / 8), depth: 0
      });
    } else {
      // PEI / pspare: legacy spare-data loop (almost always pei = 0).
      if (sr.bitsLeft() >= 1) {
        var pei = sr.u('pei (spare data present)', 1);
        var guard = 0;
        while (pei === 1 && guard++ < 8 && sr.bitsLeft() >= 9) {
          sr.cond('pei == 1');
          sr.u('pspare bit 1 (always 1)', 1);
          sr.u('pspare data bits (7)', 7);
          pei = sr.u('pei', 1);
          sr.endBlock();
        }
      }
    }

    return { rows: sr.rows, info: info };
  }

  /** Baseline H.263 PTYPE tail shared by formats 0..6. */
  function readBaselinePType(sr, info) {
    var typeBit = sr.u('picture_coding_type', 1);
    var type = PICTURE_TYPES[typeBit] || '?';
    info.type = type;
    sr.note(type + ' frame (0=I, 1=P)');

    sr.u('unrestricted_motion_vector_mode (Annex D)', 1);
    sr.u('syntax_based_arithmetic_coding (Annex E)', 1);
    var ap = sr.u('advanced_prediction_mode (Annex F)', 1);
    var pb = sr.u('pb_frames_mode (Annex G)', 1);

    var quant = sr.u('quantizer (PQUANT)', 5);
    info.quant = quant;
    sr.note(quant === 0 ? 'forbidden' : 'QP ' + quant);

    var cpm = sr.u('continuous_presence_multipoint (CPM)', 1);
    if (cpm === 1) {
      sr.cond('continuous_presence_multipoint == 1');
      sr.u('psbi', 2);
      sr.endBlock();
    }
    if (pb === 1) {
      sr.cond('pb_frames_mode == 1');
      sr.u('temporal_reference_for_b_frames (TRB)', 3);
      var dbq = sr.u('dbquant (B-frame quant factor)', 2);
      sr.note(['5/4 (B)', '6/4 (B)', '7/4 (B)', '8/4 (EI/EP)'][dbq] || '');
      sr.endBlock();
    }
    if (ap) info.advancedPrediction = true;
  }

  /**
   * H.263+ (Annex I) PLUSPTYPE — the mandatory UFEP/OPPTYPE/MPPTYPE fields.
   * Layout per ffmpeg ff_h263_decode_picture_header.
   */
  function readPlusPType(sr, info) {
    var ufep = sr.u('ufep (update full extended PTYPE)', 3);
    sr.note(ufep === 1 ? '001 — full PTYPE update' : ('00' + ufep));

    if (ufep === 1) {
      sr.cond('ufep == 1 (full PTYPE update)');
      var fmt = sr.u('source_format (OPPTYPE)', 3);
      var f = SRC_FORMATS[fmt] || ['reserved', null, null];
      sr.note(fmt + ' — ' + f[0] + (f[1] ? ' ' + f[1] + '×' + f[2] : ''));
      info.format = fmt;
      info.width = f[1];
      info.height = f[2];

      var customPcf = sr.u('custom_picture_format (CPFMT)', 1);
      sr.u('unrestricted_motion_vector_mode (Annex D)', 1);
      sr.u('syntax_based_arithmetic_coding (Annex E)', 1);
      sr.u('advanced_prediction_mode (Annex F)', 1);
      sr.u('advanced_intra_coding (Annex I)', 1);
      sr.u('deblocking_filter_mode (Annex J)', 1);
      sr.u('slice_structured_mode (Annex K)', 1);
      sr.u('reference_picture_selection (Annex N)', 1);
      sr.u('independent_segment_decoding (Annex R)', 1);
      sr.u('alternate_inter_VLC (Annex S)', 1);
      sr.u('modified_quantization_mode (Annex T)', 1);

      if (customPcf === 1) {
        sr.cond('custom_picture_format == 1');
        readCpfmt(sr, info);
        sr.endBlock();
      }
      sr.endBlock();
    }

    var typeCode = sr.u('picture_type (MPPTYPE)', 3);
    var type = PLUS_PICTURE_TYPES[typeCode] || '?';
    info.type = type;
    sr.note(type + ' frame');

    sr.u('reference_picture_resampling_mode (Annex P)', 1);
    sr.u('reduced_resolution_update_mode (Annex Q)', 1);
    var rounding = sr.u('rounding_type', 1);
    sr.note(rounding ? 'round to nearest' : 'round to even');
    sr.u('reserved (4 "1" bits)', 4);

    var quant = sr.u('quantizer (PQUANT)', 5);
    info.quant = quant;
    sr.note(quant === 0 ? 'forbidden' : 'QP ' + quant);
  }

  /** Custom Picture Format block (H.263 §5.1.3). */
  function readCpfmt(sr, info) {
    var par = sr.u('pixel_aspect_ratio', 4);
    sr.note(ASPECT_RATIOS[par] || 'reserved');
    var wcode = sr.u('picture_width_indication', 9);
    sr.u('marker_bit', 1);
    var hcode = sr.u('picture_height_indication', 9);
    var width = (wcode + 1) * 4;
    var height = hcode * 4;
    info.width = width;
    info.height = height;
    sr.note(width + ' × ' + height);
    if (par === 15) {
      sr.cond('pixel_aspect_ratio == 15 (extended PAR)');
      sr.u('par_width', 8);
      sr.u('par_height', 8);
      sr.endBlock();
    }
    // Extended temporal reference (2 bits) + frame rate type/num follow;
    // the panel does not need them.
  }

  /** GOB header: group number lives in the start code itself. */
  function readGobHeader(unit, bytes, off, base) {
    var gn = unit.code - 0x20;
    var sr = new MA.SyntaxReader(bytes, { base: base, offset: off, epb: false });
    sr.u('group_start_code (GSC)', 22);
    sr.note('GOB #' + gn);
    if (sr.bitsLeft() < 5) {
      return [MA.synSection('GOB #' + gn, 'truncated', sr.rows)];
    }
    var gq = sr.u('gquant', 5);
    sr.note(gq === 0 ? 'extra header follows' : ('QP ' + gq));
    return [MA.synSection('group_of_block #' + gn, 'GQUANT ' + gq, sr.rows)];
  }

  /* ------------------------------------------------------------- assembly */

  /**
   * Syntax tables for one H.263 access unit (ASF sample, FLV Sorenson payloads
   * differ and are handled by flv.js itself).
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var base = spec.base || 0;
    var ctx = spec.ctx || (spec.ctx = {});
    var tables = [];

    var units = scanUnits(payload, 16);
    var shownPicture = false;

    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var ubase = base + u.off;
      try {
        if (u.code === 0x20) {
          var pic = readPictureHeader(payload, u.off, ubase);
          if (!pic) continue;                       // look-alike inside coded data
          if (!shownPicture) {
            var info = pic.info;
            ctx.picture = info;
            var sub = '';
            if (info.width) sub = info.width + ' × ' + info.height;
            tables.push(MA.synSection('picture_header',
              (info.type || '?') + ' frame' + (sub ? ', ' + sub : ''), pic.rows));
            shownPicture = true;
          } else {
            tables.push(MA.synSection('picture_header (later picture)',
              (pic.info.type || '?') + ' frame', pic.rows));
          }
        } else if (u.code >= 0x21 && u.code <= 0x3b) {
          tables.push.apply(tables, readGobHeader(u, payload, u.off, ubase));
        }
      } catch (e) {
        tables.push(MA.synSection('unit @ ' + MA.hex(ubase, 8), 'parse error', [{
          name: 'error', syntax: '', bits: '', value: String(e && e.message || e),
          note: '', offset: ubase, depth: 0
        }]));
      }
    }

    if (!tables.length) {
      tables.push(MA.synSection('sample', 'No H.263 picture start code was found.', [{
        name: 'payload', syntax: '', bits: '', value: payload.length + ' bytes',
        note: '', offset: base, depth: 0
      }]));
    }
    return tables;
  }

  /**
   * Decode the first valid picture header in `bytes` for containers that
   * need the frame type / geometry without rendering tables.
   * @returns {{type:string, width:?number, height:?number, tr:number,
   *            quant:number, format:number}|null}
   */
  function probePicture(bytes) {
    var units = scanUnits(bytes, 8);
    for (var i = 0; i < units.length; i++) {
      if (units[i].code !== 0x20) continue;
      try {
        var pic = readPictureHeader(bytes, units[i].off, units[i].off);
        if (pic) return pic.info;
      } catch (e) { /* skip look-alike */ }
    }
    return null;
  }

  /** Keyframe/type probe: 'I' | 'P' | 'B' | null. */
  function firstPictureType(bytes) {
    var info = probePicture(bytes);
    return info ? info.type : null;
  }

  MA.registerCodec('h263', {
    id: 'h263',
    name: 'ITU-T H.263',
    SRC_FORMATS: SRC_FORMATS,
    probePicture: probePicture,
    firstPictureType: firstPictureType,
    buildSampleSyntax: buildSampleSyntax
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
