/* ============================================================================
 * MediaAnalyzer — codecs/av2.js
 *
 * AV2 (AOMedia's successor to AV1).
 *
 * IMPORTANT — read before extending this file:
 * The AV2 bitstream specification was still in draft when this module was
 * written. The OBU framing is stable and follows the same shape as AV1, and
 * the configuration record is an evolution of av1C, so both are decoded here.
 * The *sequence header* internals are still moving: field names, order and
 * widths have changed between draft revisions.
 *
 * Rather than guess, this module:
 *   - decodes the OBU framing exactly (it is well defined);
 *   - records every sequence-header field it reads with the note
 *     "AV2 draft — field name provisional", so a reader can see what was
 *     assumed;
 *   - stops cleanly at the first field whose width it cannot vouch for,
 *     marking the table incomplete.
 *
 * A wrong-but-plausible number is worse than an honest gap, so the tables here
 * say what they know and no more.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var LSB = MA.SyntaxReaderLSB, syn = MA.synSection;

  var DRAFT = 'AV2 draft — field name provisional';

  /* AV2 obu_type assignments (draft). Values 9-14 are reserved as in AV1. */
  var OBU_TYPES = {
    1: 'OBU_SEQUENCE_HEADER', 2: 'OBU_TEMPORAL_DELIMITER', 3: 'OBU_FRAME_HEADER',
    4: 'OBU_TILE_GROUP', 5: 'OBU_METADATA', 6: 'OBU_FRAME', 7: 'OBU_REDUNDANT_FRAME_HEADER',
    8: 'OBU_TILE_LIST', 15: 'OBU_PADDING'
  };
  function obuName(t) { return OBU_TYPES[t] || 'Reserved'; }

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

  /* ====================================================================== */

  /** OBU framing is the same shape as AV1 and is well defined. */
  function scanOBUs(data, start, end, maxObus) {
    start = start || 0;
    end = end == null ? data.length : end;
    maxObus = maxObus || 4096;
    var out = [];
    var p = start, guard = 0;
    while (p < end && guard++ < maxObus) {
      var obuStart = p;
      var h = data[p];
      if (h & 0x80) break;
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
      if (!hasSize) break;
      p = payloadEnd;
    }
    return out;
  }

  /**
   * Best-effort sequence header read. Every row is tagged as provisional and
   * the table reports how far the parse was trusted.
   */
  function parseSequenceHeader(data, start, end, base) {
    var r = new LSB(data, { offset: start, length: end - start, base: base == null ? start : base });
    var info = { draft: true };
    try {
      r.depth++;
      r.group('sequence_header_obu()  // ' + DRAFT);

      // seq_profile is 3 bits in every AV2 draft revision seen so far.
      var profile = r.f('seq_profile', 3);
      info.seqProfile = profile;
      r.note(DRAFT);

      var still = r.f('still_picture', 1);
      info.stillPicture = still === 1;
      r.note(r.rows[r.rows.length - 1].note + '; ' + (still ? 'still picture' : 'sequence'));

      var reduced = r.f('reduced_still_picture_header', 1);
      info.reducedStillPictureHeader = reduced === 1;

      // Anything past this point depends on draft field widths. Record the
      // ambiguity and stop instead of inventing dimensions.
      r.depth--;
      var used = r.rows.length;
      info.tables = [syn('sequence_header_obu()',
        'profile ' + profile + ' — ' + used + ' fields read before the draft layout diverges', r.rows)];
      info.dimensionsUnknown = true;
      info.note = 'The AV2 sequence header layout is not finalised; only the profile and ' +
                  'still-picture flags are reported.';
      r.depth--;
      return { rows: r.rows, info: info };
    } catch (e) {
      info.error = String(e && e.message || e);
      info.incomplete = true;
      return { rows: r.rows, info: info,
               tables: [syn('sequence_header_obu()', 'parse stopped early', r.rows)] };
    }
  }

  /* ------------------------------------------------- configuration record */

  /** AV2CodecConfigurationRecord — an evolution of the AV1 av1C box. */
  function parseAv2C(br, end, base) {
    var start = br.pos;
    if (base == null) base = br.base + start;
    var rows = [];
    var info = { draft: true };
    if (start + 4 > end) {
      return { table: syn('AV2CodecConfigurationRecord', 'record too short', []), info: info };
    }
    var b0 = br.u8at(start), b1 = br.u8at(start + 1), b2 = br.u8at(start + 2), b3 = br.u8at(start + 3);

    rows.push({ name: 'marker', syntax: 'f(1)', bits: 1, value: (b0 >> 7) & 1,
                note: 'must be 1 — ' + DRAFT, offset: base, depth: 0 });
    var version = b0 & 0x7f;
    rows.push({ name: 'version', syntax: 'f(7)', bits: 7, value: version, note: DRAFT, offset: base, depth: 0 });
    var profile = (b1 >> 5) & 7, level = b1 & 0x1f;
    info.seqProfile = profile;
    info.seqLevelIdx0 = level;
    rows.push({ name: 'seq_profile', syntax: 'f(3)', bits: 3, value: profile, note: DRAFT, offset: base + 1, depth: 0 });
    rows.push({ name: 'seq_level_idx_0', syntax: 'f(5)', bits: 5, value: level, note: DRAFT, offset: base + 1, depth: 0 });

    var tier = (b2 >> 7) & 1;
    var high = (b2 >> 6) & 1, twelve = (b2 >> 5) & 1, mono = (b2 >> 4) & 1;
    var subX = (b2 >> 3) & 1, subY = (b2 >> 2) & 1, csp = b2 & 3;
    var bitDepth = twelve ? 12 : (high ? 10 : 8);
    info.bitDepth = bitDepth;
    info.monochrome = !!mono;
    info.chromaSubsampling = mono ? '4:0:0 (monochrome)'
      : subX && subY ? '4:2:0' : subX && !subY ? '4:2:2' : !subX && !subY ? '4:4:4' : '4:4:0';

    rows.push({ name: 'seq_tier_0', syntax: 'f(1)', bits: 1, value: tier, note: DRAFT, offset: base + 2, depth: 0 });
    rows.push({ name: 'high_bitdepth', syntax: 'f(1)', bits: 1, value: high, note: DRAFT, offset: base + 2, depth: 0 });
    rows.push({ name: 'twelve_bit', syntax: 'f(1)', bits: 1, value: twelve, note: DRAFT, offset: base + 2, depth: 0 });
    rows.push({ name: 'monochrome', syntax: 'f(1)', bits: 1, value: mono, note: DRAFT, offset: base + 2, depth: 0 });
    rows.push({ name: 'chroma_subsampling_x', syntax: 'f(1)', bits: 1, value: subX, note: DRAFT, offset: base + 2, depth: 0 });
    rows.push({ name: 'chroma_subsampling_y', syntax: 'f(1)', bits: 1, value: subY, note: DRAFT, offset: base + 2, depth: 0 });
    rows.push({ name: 'chroma_sample_position', syntax: 'f(2)', bits: 2, value: csp,
                note: ['UNKNOWN', 'VERTICAL', 'COLOCATED', 'RESERVED'][csp] + ' — ' + DRAFT, offset: base + 2, depth: 0 });

    rows.push({ name: 'reserved', syntax: 'f(3)', bits: 3, value: (b3 >> 5) & 7, note: DRAFT, offset: base + 3, depth: 0 });
    var delayPresent = (b3 >> 4) & 1;
    rows.push({ name: 'initial_presentation_delay_present', syntax: 'f(1)', bits: 1, value: delayPresent, note: DRAFT, offset: base + 3, depth: 0 });
    if (delayPresent) {
      rows.push({ name: 'initial_presentation_delay_minus_one', syntax: 'f(4)', bits: 4, value: b3 & 0x0f, note: DRAFT, offset: base + 3, depth: 0 });
    } else {
      rows.push({ name: 'reserved', syntax: 'f(4)', bits: 4, value: b3 & 0x0f, note: DRAFT, offset: base + 3, depth: 0 });
    }

    var trailing = end - (start + 4);
    if (trailing > 0) {
      rows.push({ name: 'configOBUs', syntax: 'bytes(' + trailing + ')', bits: trailing * 8,
                  value: trailing + ' bytes', note: 'cached sequence header OBU(s)', offset: base + 4, depth: 0 });
      info.configObuBytes = trailing;
    }

    return {
      table: syn('AV2CodecConfigurationRecord',
        'profile ' + profile + ', level ' + level + ', ' + bitDepth + '-bit (draft layout)', rows),
      info: info
    };
  }

  function makeContext() { return { codec: 'av2', width: null, height: null, draft: true }; }

  function analyzeOBUs(data, base) {
    var obus = scanOBUs(data, 0, data.length, 4096);
    var tables = [];
    var info = { draft: true, obuCount: obus.length, obuTypes: {} };
    var ctx = makeContext();

    obus.forEach(function (o, i) {
      info.obuTypes[o.typeName] = (info.obuTypes[o.typeName] || 0) + 1;
      if (i >= 6) return;
      if (o.type === 1) {
        var seq = parseSequenceHeader(data, o.payloadStart, o.payloadEnd, o.payloadStart);
        Object.assign(info, { seqProfile: seq.info.seqProfile, stillPicture: seq.info.stillPicture });
        tables = tables.concat(seq.tables || [syn('sequence_header_obu()', '', seq.rows)]);
      } else {
        tables.push(syn(o.typeName, o.size + ' bytes', [
          { name: 'obu_type', syntax: 'f(4)', bits: 4, value: o.type, note: o.typeName + ' — ' + DRAFT,
            offset: o.offset, depth: 0 },
          { name: 'obu_size', syntax: 'leb128()', bits: 0, value: o.size,
            note: o.hasSize ? '' : 'no size field — extends to the end of the stream',
            offset: o.headerEnd, depth: 0 }
        ]));
      }
    });

    if (!tables.length) {
      tables.push(syn('AV2 OBU stream', obus.length + ' OBU(s), none decodable', [
        { name: 'obu_count', syntax: '', bits: '', value: obus.length, note: DRAFT, offset: base || 0, depth: 0 }
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
    var res = MA.readIvf(data, 'AV02');
    if (!res) return null;
    var ctx = makeContext();
    var tables = [syn('IVF / AV2 stream', res.info.width + 'x' + res.info.height, [
      { name: 'fourcc', syntax: 'L(4)', bits: 32, value: "'AV02'", note: DRAFT, offset: 8, depth: 0 },
      { name: 'width', syntax: 'L(2)', bits: 16, value: res.info.width, note: '', offset: 12, depth: 0 },
      { name: 'height', syntax: 'L(2)', bits: 16, value: res.info.height, note: '', offset: 14, depth: 0 },
      { name: 'frame_count', syntax: 'L(4)', bits: 32, value: res.info.frameCount, note: '', offset: 24, depth: 0 }
    ])];
    if (res.frames.length) {
      var f0 = res.frames[0];
      var first = analyzeOBUs(data.subarray(f0.offset, f0.offset + f0.size), 0);
      tables = tables.concat(first.tables);
    }
    res.frames.forEach(function (f) { f.codec = 'av2'; });
    return {
      tables: tables, frames: res.frames,
      track: { id: 1, type: 'video', codec: 'av2', codecName: 'AV2 (draft)',
               width: res.info.width, height: res.info.height,
               fps: res.info.fps, sampleCount: res.frames.length },
      info: res.info, ctx: ctx
    };
  }

  MA.registerCodec('av2', {
    id: 'av2',
    name: 'AV2',
    scanOBUs: scanOBUs,
    parseSequenceHeader: parseSequenceHeader,
    parseAv2C: parseAv2C,
    analyzeOBUs: analyzeOBUs,
    buildSampleSyntax: buildSampleSyntax,
    makeContext: makeContext,
    analyzeIVF: analyzeIVF
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
