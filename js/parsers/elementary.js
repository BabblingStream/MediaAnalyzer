/* ============================================================================
 * MediaAnalyzer — parsers/elementary.js
 *
 * Raw elementary streams — the formats with no container around them:
 *
 *   h264 / h265 / h266 : Annex-B NAL units (00 00 01 start codes)
 *   av1                : a bare OBU stream
 *   ivf                : the tiny IVF container (VP8 / VP9 / AV1 / AV2)
 *
 * The detector recognises all five, so each one needs a parser or the app
 * reports "unrecognized format". Every codec module is looked up through
 * MA.getCodec() and every lookup is guarded: the codec files are developed in
 * parallel, and a missing module must degrade to a structural scan plus a
 * clear note rather than throw.
 *
 * Frames carry the small `syn` recipe from js/framesyntax.js — never a
 * closure over the payload.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField, nodeNote = MA.nodeNote;
  var synSection = MA.synSection, hex = MA.hex, formatSize = MA.formatSize;

  /* ------------------------------------------------------------------ caps */

  var MAX_NAL_NODES = 20000;    // structure nodes for NAL units
  var MAX_OBU_NODES = 20000;    // structure nodes for OBUs
  var MAX_IVF_NODES = 20000;    // structure nodes for IVF frames
  var MAX_FRAMES = 60000;

  function msg(e) { return String((e && e.message) || e); }

  /* ---------------------------------------------------------------- tables */

  var AVC_NAL = {
    0: 'Unspecified', 1: 'Coded slice, non-IDR', 2: 'Coded slice data partition A',
    3: 'Coded slice data partition B', 4: 'Coded slice data partition C',
    5: 'Coded slice, IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD',
    10: 'End of sequence', 11: 'End of stream', 12: 'Filler data',
    13: 'SPS extension', 14: 'Prefix NAL unit', 15: 'Subset SPS',
    16: 'Depth parameter set', 19: 'Coded slice, extension',
    20: 'Coded slice, depth view', 21: 'Coded slice, 3D-AVC'
  };

  var HEVC_NAL = {
    0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R',
    6: 'RADL_N', 7: 'RADL_R', 8: 'RASL_N', 9: 'RASL_R',
    16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP', 19: 'IDR_W_RADL',
    20: 'IDR_N_LP', 21: 'CRA_NUT',
    32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 36: 'EOS', 37: 'EOB',
    38: 'Filler data', 39: 'Prefix SEI', 40: 'Suffix SEI'
  };

  /* H.266 Table 5 — note that 12..16 are OPI/DCI/VPS/SPS/PPS, not the SEI codes. */
  var VVC_NAL = {
    0: 'TRAIL', 1: 'STSA', 2: 'RADL', 3: 'RASL', 4: 'IDR_W_RADL', 5: 'IDR_N_LP',
    6: 'CRA', 7: 'GDR', 8: 'RSV_IRAP_VCL_8', 9: 'RSV_IRAP_VCL_9',
    10: 'RSV_IRAP_VCL_10', 11: 'RSV_IRAP_VCL_11',
    12: 'OPI', 13: 'DCI', 14: 'VPS', 15: 'SPS', 16: 'PPS',
    17: 'PREFIX_APS', 18: 'SUFFIX_APS', 19: 'PH', 20: 'AUD', 21: 'EOS', 22: 'EOB',
    23: 'PREFIX_SEI', 24: 'SUFFIX_SEI', 25: 'FD'
  };

  /** Parameter-set / SEI / slice roles per standard (VVC differs from HEVC). */
  var NAL_ROLE = {
    h264: { vps: -1, sps: 7, pps: 8, sei: [6, 39], aud: 9 },
    h265: { vps: 32, sps: 33, pps: 34, sei: [39, 40], aud: 35 },
    h266: { vps: 14, sps: 15, pps: 16, sei: [23, 24], aud: 20 }
  };

  var OBU_TYPE = {
    1: 'OBU_SEQUENCE_HEADER', 2: 'OBU_TEMPORAL_DELIMITER', 3: 'OBU_FRAME_HEADER',
    4: 'OBU_TILE_GROUP', 5: 'OBU_METADATA', 6: 'OBU_FRAME',
    7: 'OBU_REDUNDANT_FRAME_HEADER', 8: 'OBU_TILE_LIST', 15: 'OBU_PADDING'
  };

  var IVF_FOURCC = {
    VP80: { codec: 'vp8', name: 'VP8' },
    VP81: { codec: 'vp8', name: 'VP8 (later revision)' },
    VP90: { codec: 'vp9', name: 'VP9' },
    AV01: { codec: 'av1', name: 'AV1' },
    AV02: { codec: 'av2', name: 'AV2' }
  };

  /* Codec lookup that never throws — the modules land in parallel with this one. */
  function codec(id) {
    try { return MA.getCodec(id); } catch (e) { return null; }
  }

  function nalTypeName(codecId, type) {
    if (codecId === 'h264') {
      var h264 = codec('h264');
      if (h264 && h264.nalTypeName) return h264.nalTypeName(type);
      return AVC_NAL[type] || ('type ' + type);
    }
    if (codecId === 'h265') return HEVC_NAL[type] || (type >= 10 && type <= 15 ? 'Reserved (VCL)' :
      (type >= 41 && type <= 47 ? 'Reserved (non-VCL)' : 'Reserved / unspecified'));
    if (codecId === 'h266') return VVC_NAL[type] || 'Reserved / unspecified';
    return 'type ' + type;
  }

  function newResult(formatId, formatName) {
    return {
      formatId: formatId,
      formatName: formatName,
      durationSec: null,
      bitrate: null,
      tracks: [],
      metadata: [],
      structures: [],
      frames: [],
      notes: [],
      codecContexts: {},
      extra: []
    };
  }

  /* ==========================================================================
   * Annex B — h264 / h265 / h266
   * ========================================================================*/

  /**
   * First bytes of a NAL unit; all three standards start with 00 00 01.
   *   AVC : forbidden(1) nal_ref_idc(2) nal_unit_type(5)          — 1 byte
   *   HEVC: forbidden(1) nal_unit_type(6) layer_id(6) tid+1(3)    — 2 bytes
   *   VVC : forbidden(1) reserved(1) layer_id(6)
   *         nal_unit_type(5) nuh_temporal_id_plus1(3)             — 2 bytes
   */
  function readNalHeader(data, off, codecId) {
    var h = data[off];
    if (codecId === 'h264') {
      return { type: h & 0x1f, refIdc: (h >> 5) & 3, headerLen: 1, second: 0,
               layerId: 0, temporalId: 0 };
    }
    var second = off + 1 < data.length ? data[off + 1] : 0;
    if (codecId === 'h266') {
      return {
        type: (second >> 3) & 0x1f,
        refIdc: 0,
        headerLen: 2,
        second: second,
        layerId: h & 0x3f,
        temporalId: (second & 0x07) - 1
      };
    }
    return {
      type: (h >> 1) & 0x3f,
      refIdc: 0,
      headerLen: 2,
      second: second,
      layerId: ((h & 0x01) << 5) | ((second >> 3) & 0x1f),
      temporalId: (second & 0x07) - 1
    };
  }

  function isKeyframeNal(codecId, type) {
    if (codecId === 'h264') return type === 5;
    if (codecId === 'h265') return type >= 16 && type <= 21;              // BLA / IDR / CRA
    if (codecId === 'h266') return type >= 4 && type <= 11;              // IRAP set
    return false;
  }

  function isSliceNal(codecId, type) {
    if (codecId === 'h264') return type === 1 || type === 2 || type === 5 || type === 19;
    if (codecId === 'h265') return type <= 31;
    if (codecId === 'h266') return type <= 11;
    return false;
  }

  function parseAnnexB(ctx, codecId, formatName) {
    var result = newResult(codecId, formatName);
    var data = ctx && ctx.data;
    if (!data || !data.length) {
      result.notes.push('Empty elementary stream.');
      return result;
    }

    var mod = codec(codecId);
    var analyzed = null;
    if (mod && typeof mod.analyzeAnnexB === 'function') {
      try {
        var cctx = null;
        if (typeof mod.makeContext === 'function') {
          try { cctx = mod.makeContext(); } catch (e) { cctx = null; }
        }
        analyzed = mod.analyzeAnnexB(data, cctx);
      } catch (e) {
        result.notes.push('The ' + codecId + ' analyzer failed (' + msg(e) +
          ') — falling back to a structural Annex-B scan.');
        analyzed = null;
      }
    } else {
      result.notes.push('The ' + codecId + ' codec module is not loaded — this is a structural ' +
        'Annex-B scan only; per-NAL syntax needs js/codecs/' + codecId + '.js.');
    }

    var units;
    try {
      units = MA.annexBUnits(data, data.length);
    } catch (e) {
      result.notes.push('Annex-B scan failed: ' + msg(e));
      return result;
    }
    if (!units.length) {
      result.notes.push('No Annex-B start code (00 00 01) was found — this does not look like a ' +
        codecId.toUpperCase() + ' elementary stream.');
      return result;
    }

    var streamNode = makeNode('group', 'stream', 'Annex B NAL units', 0, data.length);
    streamNode.expanded = false;
    result.structures.push(streamNode);

    var ctxKey = '1:' + codecId;
    var info = (analyzed && analyzed.info) || {};
    var role = NAL_ROLE[codecId];
    var counts = { sps: 0, pps: 0, vps: 0, sei: 0, idr: 0, slice: 0, other: 0 };
    var bytes = 0;
    var frames = [];
    var firstSps = null, firstPps = null, firstVps = null;
    var nodeCap = false;

    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.start >= u.end) continue;
      var hdr = readNalHeader(data, u.start, codecId);
      var name = nalTypeName(codecId, hdr.type);
      bytes += u.len;

      if (hdr.type === role.sps) {
        counts.sps++;
        if (!firstSps) firstSps = { unit: u, hdr: hdr };
      } else if (hdr.type === role.pps) {
        counts.pps++;
        if (!firstPps) firstPps = { unit: u, hdr: hdr };
      } else if (role.vps >= 0 && hdr.type === role.vps) {
        counts.vps++;
        if (!firstVps) firstVps = { unit: u, hdr: hdr };
      } else if (role.sei.indexOf(hdr.type) >= 0) {
        counts.sei++;
      } else if (isSliceNal(codecId, hdr.type)) {
        if (isKeyframeNal(codecId, hdr.type)) counts.idr++; else counts.slice++;
      } else {
        counts.other++;
      }

      /* ---- structure node ---- */
      if (streamNode.children.length < MAX_NAL_NODES) {
        var node = makeNode('element', 'NAL', name, u.sc, u.len);
        node.expanded = false;
        nodeField(node, 'start_code', u.scLen === 4 ? '00 00 00 01' : '00 00 01', u.sc, u.scLen);
        nodeField(node, 'nal_unit_type', hdr.type + ' (' + name + ')', u.start, hdr.headerLen);
        if (codecId === 'h264') {
          nodeField(node, 'nal_ref_idc', hdr.refIdc, u.start, 1);
        } else {
          nodeField(node, 'nuh_layer_id', hdr.layerId, u.start, hdr.headerLen);
          nodeField(node, 'nuh_temporal_id_plus1', (hdr.temporalId + 1), u.start, hdr.headerLen);
        }
        nodeNote(node, formatSize(u.len) + ' at ' + hex(u.sc, 8) +
          (isSliceNal(codecId, hdr.type) ? (isKeyframeNal(codecId, hdr.type) ? ' — keyframe' : '') : ''));
        streamNode.children.push(node);
      } else if (!nodeCap) {
        nodeCap = true;
        nodeNote(streamNode, '… further NAL nodes omitted (structure tree capped at ' +
          MAX_NAL_NODES + ' units)');
        result.notes.push('Structure tree capped at ' + MAX_NAL_NODES + ' NAL units.');
      }
    }

    /* ---- header frames: the first parameter sets carry their syntax eagerly ---- */
    if (firstVps) frames.push(headerFrame(data, firstVps, mod, codecId, ctxKey, 'VPS'));
    if (firstSps) frames.push(headerFrame(data, firstSps, mod, codecId, ctxKey, 'SPS'));
    if (firstPps) frames.push(headerFrame(data, firstPps, mod, codecId, ctxKey, 'PPS'));

    /* ---- sample frames ---- */
    var raws = (analyzed && analyzed.frames) || null;
    if (raws && raws.length) {
      for (var f = 0; f < raws.length && frames.length < MAX_FRAMES; f++) {
        frames.push(frameFromAnalyzer(raws[f], f, codecId, ctxKey));
      }
      if (raws.length > MAX_FRAMES) {
        result.notes.push('Frame list capped at ' + MAX_FRAMES + ' entries.');
      }
    } else {
      for (var k = 0; k < units.length && frames.length < MAX_FRAMES; k++) {
        var uu = units[k];
        if (uu.start >= uu.end) continue;
        var hh = readNalHeader(data, uu.start, codecId);
        if (!isSliceNal(codecId, hh.type)) continue;
        frames.push({
          track: 1,
          index: frames.length + 1,
          type: isKeyframeNal(codecId, hh.type) ? 'I' : 'P/B',
          kind: 'video',
          codec: codecId,
          offset: uu.sc,
          size: uu.len,
          ptsSec: null,
          dtsSec: null,
          durationSec: null,
          keyframe: isKeyframeNal(codecId, hh.type),
          label: nalTypeName(codecId, hh.type),
          syn: { codec: codecId, kind: 'annexb', offset: uu.sc, size: uu.len, base: uu.sc,
                 ctxKey: ctxKey }
        });
      }
    }

    /* ---- context for the lazy slice-header parse ---- */
    if (analyzed && analyzed.ctx) result.codecContexts[ctxKey] = analyzed.ctx;

    /* ---- track ---- */
    var at = (analyzed && analyzed.track) || {};
    var fps = info.fps || null;
    var sampleCount = 0;
    for (var s = 0; s < frames.length; s++) if (frames[s].kind === 'video') sampleCount++;
    var durationSec = (fps && sampleCount) ? sampleCount / fps : null;
    var track = {
      id: 1,
      type: 'video',
      codec: codecId,
      codecName: codecNameOf(codecId),
      profile: at.profile || info.profile || '',
      level: at.level || info.level || '',
      width: at.width || info.width || null,
      height: at.height || info.height || null,
      fps: fps,
      sampleRate: null,
      channels: null,
      bitDepth: null,
      durationSec: durationSec,
      bitrate: (durationSec && durationSec > 0) ? Math.round(bytes * 8 / durationSec) : null,
      sampleCount: sampleCount,
      language: '',
      extra: []
    };
    if (analyzed && analyzed.track && analyzed.track.spsCount != null) {
      track.extra.push({ label: 'Parameter sets',
        value: 'SPS ' + (analyzed.track.spsCount || 0) + ', PPS ' + (analyzed.track.ppsCount || 0) });
    }
    if (fps) {
      track.extra.push({ label: 'Duration', value: 'estimated from ' + sampleCount +
        ' coded pictures at ' + MA.formatFps(fps) });
    } else {
      track.extra.push({ label: 'Duration', value: 'not signalled — a raw elementary stream ' +
        'carries no timestamps' });
    }
    if (info.chromaFormat != null) {
      track.extra.push({ label: 'Chroma format', value: String(info.chromaFormat) });
    }
    if (firstVps) track.extra.push({ label: 'VPS present', value: 'yes' });
    if (info.hdr && MA.hdrSEI) {
      var hdrSummary = MA.hdrSEI.summarize(info.hdr, info.colour || (at && at.colour) || null);
      if (hdrSummary.formats.length) {
        track.hdr = info.hdr;
        hdrSummary.extras.forEach(function (row) { track.extra.push(row); });
      }
    }
    result.tracks.push(track);

    /* ---- container-level extras and notes ---- */
    result.extra.push({ label: 'NAL units', value: String(units.length) });
    result.extra.push({ label: 'Stream bytes', value: formatSize(bytes) });
    if (counts.sps || counts.pps) {
      result.extra.push({ label: 'SPS / PPS', value: counts.sps + ' / ' + counts.pps });
    }
    if (counts.idr || counts.slice) {
      result.extra.push({ label: 'Coded slices', value: counts.idr + ' keyframe, ' + counts.slice + ' non-key' });
    }
    if (counts.sei) result.extra.push({ label: 'SEI NAL units', value: String(counts.sei) });
    if (!counts.sps) {
      result.notes.push('No SPS was found — the stream may be truncated, or it is not really ' +
        codecId.toUpperCase() + '.');
    }
    if (info.width && info.height) {
      result.extra.push({ label: 'Resolution', value: info.width + ' x ' + info.height });
    }

    frames.sort(function (a, b) { return a.offset - b.offset; });
    result.frames = frames;
    fillDurations(result.frames);
    return result;
  }

  function codecNameOf(codecId) {
    var mod = codec(codecId);
    if (mod && mod.name) return mod.name;
    if (codecId === 'h264') return 'H.264 / AVC';
    if (codecId === 'h265') return 'H.265 / HEVC';
    if (codecId === 'h266') return 'H.266 / VVC';
    if (codecId === 'av1') return 'AV1';
    return codecId;
  }

  /** One of the first VPS/SPS/PPS units, decoded eagerly so it can be opened. */
  function headerFrame(data, entry, mod, codecId, ctxKey, label) {
    var u = entry.unit;
    var tables = null;
    if (mod && typeof mod.parseNAL === 'function') {
      try {
        var cctx = null;
        if (mod.ctxFromAVCC) { /* not applicable to raw streams */ }
        var res = mod.parseNAL(data, u.start, u.end, null);
        if (res && res.tables && res.tables.length) tables = res.tables;
      } catch (e) { tables = null; }
    }
    if (!tables) {
      // No codec module (or it refused the unit): describe what the header says
      // and, for HEVC, recover the picture size from the SPS by hand.
      var rows = [];
      var hdr = readNalHeader(data, u.start, codecId);
      rows.push({ name: 'start_code', syntax: '', bits: u.scLen * 8,
                  value: u.scLen === 4 ? '00 00 00 01' : '00 00 01', note: '', offset: u.sc, depth: 0 });
      rows.push({ name: 'nal_unit_type', syntax: 'u(' + (hdr.headerLen === 1 ? 5 : 6) + ')',
                  bits: hdr.headerLen === 1 ? 5 : 6, value: hdr.type,
                  note: nalTypeName(codecId, hdr.type), offset: u.start, depth: 0 });
      if (codecId === 'h265' && label === 'SPS') {
        var sps = hevcSpsFallback(data, u);
        if (sps) {
          rows.push({ name: 'sps_video_parameter_set_id', syntax: 'u(4)', bits: 4,
                      value: sps.vpsId, note: '', offset: u.start + 2, depth: 1 });
          rows.push({ name: 'sps_max_sub_layers_minus1', syntax: 'u(3)', bits: 3,
                      value: sps.maxSubLayersMinus1, note: '', offset: u.start + 2, depth: 1 });
          rows.push({ name: 'sps_temporal_id_nesting_flag', syntax: 'u(1)', bits: 1,
                      value: sps.nesting, note: '', offset: u.start + 2, depth: 1 });
          rows.push({ name: 'general_profile_idc', syntax: 'u(5)', bits: 5,
                      value: sps.profileIdc, note: HEVC_PROFILE[sps.profileIdc] || '', offset: u.start + 3, depth: 1 });
          rows.push({ name: 'general_level_idc', syntax: 'u(8)', bits: 8,
                      value: sps.levelIdc, note: 'Level ' + (sps.levelIdc / 30).toFixed(1), offset: u.start + 7, depth: 1 });
          rows.push({ name: 'chroma_format_idc', syntax: 'ue(v)', bits: 0,
                      value: sps.chromaFormatIdc, note: ['monochrome', '4:2:0', '4:2:2', '4:4:4'][sps.chromaFormatIdc] || '', offset: u.start + 8, depth: 1 });
          rows.push({ name: 'pic_width_in_luma_samples', syntax: 'ue(v)', bits: 0,
                      value: sps.codedWidth, note: '', offset: u.start + 8, depth: 1 });
          rows.push({ name: 'pic_height_in_luma_samples', syntax: 'ue(v)', bits: 0,
                      value: sps.codedHeight, note: '', offset: u.start + 8, depth: 1 });
          rows.push({ name: 'conformance_window_flag', syntax: 'u(1)', bits: 1,
                      value: sps.cropFlag ? 1 : 0,
                      note: sps.cropFlag ? ('crop ' + sps.cropLeft + ',' + sps.cropRight + ',' +
                        sps.cropTop + ',' + sps.cropBottom) : 'no cropping',
                      offset: u.start + 8, depth: 1 });
          rows.push({ name: 'decoded width / height', syntax: '', bits: '', value: sps.width + ' x ' + sps.height,
                      note: 'hand-decoded fallback', offset: u.start + 8, depth: 0 });
        }
      }
      tables = [synSection(label + ' (structural)', nalTypeName(codecId, entry.hdr.type) +
        ' @ ' + hex(u.sc, 8) + ', ' + u.len + ' bytes', rows)];
    }
    return {
      track: 1,
      index: 0,
      type: 'header',
      kind: 'header',
      codec: codecId,
      offset: u.sc,
      size: u.len,
      ptsSec: null,
      dtsSec: null,
      durationSec: null,
      keyframe: false,
      label: label + ' (' + nalTypeName(codecId, entry.hdr.type) + ')',
      tables: tables,
      syn: undefined
    };
  }

  /** Convert a codec-module frame (analyzeAnnexB) into the app's frame shape. */
  function frameFromAnalyzer(f, index, codecId, ctxKey) {
    var type = f.type || 'frame';
    var aux = type === 'SEI' || type === 'AUD' || type === 'filler';
    return {
      track: 1,
      index: index + 1,
      type: aux ? type : (f.keyframe ? 'I' : type),
      kind: aux ? 'other' : 'video',
      codec: codecId,
      offset: f.offset,
      size: f.size,
      ptsSec: null,
      dtsSec: null,
      durationSec: null,
      keyframe: !!f.keyframe,
      label: labelForNal(codecId, f),
      syn: { codec: codecId, kind: 'annexb', offset: f.offset, size: f.size, base: f.offset,
             ctxKey: ctxKey }
    };
  }

  function labelForNal(codecId, f) {
    var name = nalTypeName(codecId, f.nalType != null ? f.nalType : -1);
    if (f.nalType === 6) return 'SEI';
    if (f.nalType === 9) return 'AUD';
    return name;
  }

  /* --------------------------------------------------- HEVC SPS fallback */

  var HEVC_PROFILE = { 1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'RExt' };
  var HEVC_CHROMA = ['monochrome', '4:2:0', '4:2:2', '4:4:4'];

  /**
   * Minimal HEVC seq_parameter_set_rbsp reader: enough of profile_tier_level()
   * to reach pic_width/height_in_luma_samples and the conformance window.
   * Used only when js/codecs/h265.js is unavailable.
   */
  function hevcSpsFallback(data, unit) {
    try {
      var rbsp = MA.unescapeRbsp(data, unit.start + 2, unit.end);
      var bit = new MA.BitReader(rbsp, 0, rbsp.length, false);
      var vpsId = bit.u(4);
      var maxSubLayersMinus1 = bit.u(3);
      var nesting = bit.u(1);

      // profile_tier_level(profilePresentFlag = 1, maxSubLayersMinus1)
      var tierFlag = bit.u(1);                       // general_tier_flag
      var profileIdc = bit.u(5);
      bit.u(32);                                     // general_profile_compatibility_flags
      for (var ci = 0; ci < 6; ci++) bit.u(8);       // general_constraint_indicator_flags
      var levelIdc = bit.u(8);                       // general_level_idc

      var subProfile = [], subLevel = [];
      var i;
      for (i = 0; i < maxSubLayersMinus1 && i < 8; i++) {
        subProfile.push(bit.u(1));
        subLevel.push(bit.u(1));
      }
      if (maxSubLayersMinus1 > 0) {
        for (i = maxSubLayersMinus1; i < 8; i++) bit.u(2);   // reserved_zero_2bits
      }
      for (i = 0; i < maxSubLayersMinus1 && i < 8; i++) {
        if (subProfile[i]) {
          bit.u(2); bit.u(1); bit.u(5); bit.u(32);
          for (var cj = 0; cj < 6; cj++) bit.u(8);
        }
        if (subLevel[i]) bit.u(8);
      }

      var spsId = bit.ue();
      var chromaFormatIdc = bit.ue();
      if (chromaFormatIdc === 3) bit.u(1);           // separate_colour_plane_flag
      var codedWidth = bit.ue();
      var codedHeight = bit.ue();
      var cropFlag = bit.u(1);
      var cropLeft = 0, cropRight = 0, cropTop = 0, cropBottom = 0;
      if (cropFlag) {
        cropLeft = bit.ue(); cropRight = bit.ue();
        cropTop = bit.ue(); cropBottom = bit.ue();
      }
      if (bit.overrun || !codedWidth || !codedHeight) return null;
      var subW = (chromaFormatIdc === 1 || chromaFormatIdc === 2) ? 2 : 1;
      var subH = (chromaFormatIdc === 1) ? 2 : 1;
      return {
        vpsId: vpsId, maxSubLayersMinus1: maxSubLayersMinus1, nesting: nesting,
        tierFlag: tierFlag, profileIdc: profileIdc, levelIdc: levelIdc, spsId: spsId,
        chromaFormatIdc: chromaFormatIdc,
        codedWidth: codedWidth, codedHeight: codedHeight,
        cropFlag: cropFlag, cropLeft: cropLeft, cropRight: cropRight,
        cropTop: cropTop, cropBottom: cropBottom,
        width: codedWidth - subW * (cropLeft + cropRight),
        height: codedHeight - subH * (cropTop + cropBottom)
      };
    } catch (e) {
      return null;
    }
  }

  /* ==========================================================================
   * AV1 — raw OBU stream
   * ========================================================================*/

  /** LEB128 (obu_size). Returns { value, bytes } or null when truncated. */
  function leb128(data, p, end) {
    var v = 0, shift = 0, n = 0;
    for (;;) {
      if (p + n >= end || n >= 8) return null;
      var b = data[p + n];
      n++;
      v += (b & 0x7f) * Math.pow(2, shift);
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return { value: v, bytes: n };
  }

  function parseOBUStream(ctx, formatName) {
    var result = newResult('av1', formatName);
    var data = ctx && ctx.data;
    if (!data || !data.length) {
      result.notes.push('Empty OBU stream.');
      return result;
    }
    var group = makeNode('group', 'OBU', 'Open Bitstream Units', 0, data.length);
    group.expanded = false;
    result.structures.push(group);

    var p = 0, count = 0, bytes = 0, nodeCap = false;
    var frames = [];
    var seqTables = null;
    var seqInfo = null;
    var counts = {};

    while (p < data.length && count < MAX_OBU_NODES * 4) {
      var start = p;
      var hdr = data[p];
      if (hdr === 0 && p + 1 < data.length && data[p + 1] === 0) {
        // A run of zeros is padding between OBUs in some muxers.
        while (p < data.length && data[p] === 0) p++;
        continue;
      }
      var forbidden = (hdr >> 7) & 1;
      var obuType = (hdr >> 3) & 0x0f;
      var extFlag = (hdr >> 2) & 1;
      var hasSize = (hdr >> 1) & 1;
      var reserved = hdr & 1;
      var headerLen = 1;
      var q = p + 1;
      var temporalId = null, spatialId = null;

      if (extFlag) {
        if (q >= data.length) break;
        var ext = data[q];
        temporalId = (ext >> 5) & 0x07;
        spatialId = (ext >> 3) & 0x03;
        q++; headerLen++;
      }
      var size = 0, sizeBytes = 0;
      if (hasSize) {
        var leb = leb128(data, q, data.length);
        if (!leb) {
          result.notes.push('OBU #' + (count + 1) + ' at ' + hex(start, 8) +
            ' has a truncated obu_size — stopping the walk.');
          break;
        }
        size = leb.value;
        sizeBytes = leb.bytes;
        headerLen += sizeBytes;
      } else {
        // No size field: the OBU runs to the end of the stream.
        size = data.length - q;
      }
      var payloadStart = q + sizeBytes;
      var payloadEnd = Math.min(data.length, payloadStart + size);
      if (payloadStart > data.length || size > data.length - payloadStart) {
        result.notes.push('OBU #' + (count + 1) + ' at ' + hex(start, 8) + ' declares ' + size +
          ' bytes but only ' + Math.max(0, data.length - payloadStart) + ' remain — truncated.');
        payloadEnd = data.length;
      }
      var obuLen = payloadEnd - start;
      var typeName = OBU_TYPE[obuType] || ('OBU type ' + obuType + ' (reserved)');
      counts[obuType] = (counts[obuType] || 0) + 1;
      bytes += obuLen;

      if (group.children.length < MAX_OBU_NODES) {
        var node = makeNode('element', 'OBU', typeName, start, obuLen);
        nodeField(node, 'forbidden_bit', forbidden, start, 1);
        nodeField(node, 'obu_type', obuType + ' (' + typeName + ')', start, 1);
        nodeField(node, 'extension_flag', extFlag, start, 1);
        nodeField(node, 'has_size_field', hasSize, start, 1);
        if (extFlag) {
          nodeField(node, 'temporal_id', temporalId, p + 1, 1);
          nodeField(node, 'spatial_id', spatialId, p + 1, 1);
        }
        if (hasSize) nodeField(node, 'obu_size', size, q, sizeBytes);
        nodeNote(node, obuLen + ' bytes, payload @ ' + hex(payloadStart, 8));
        group.children.push(node);
      } else if (!nodeCap) {
        nodeCap = true;
        nodeNote(group, '… further OBU nodes omitted (capped at ' + MAX_OBU_NODES + ').');
        result.notes.push('Structure tree capped at ' + MAX_OBU_NODES + ' OBUs.');
      }

      var shortName = typeName.replace(/^OBU_/, '').toLowerCase();

      if (obuType === 1 && !seqTables) {
        var av1 = codec('av1');
        if (av1 && typeof av1.parseSequenceHeader === 'function') {
          try {
            var res = av1.parseSequenceHeader(data, payloadStart, payloadEnd);
            if (res) {
              seqInfo = res.info || res;
              if (res.tables) seqTables = res.tables;
              else if (res.table) seqTables = [res.table];
              else if (res.sections) seqTables = res.sections;
            }
          } catch (e) {
            result.notes.push('The AV1 sequence header at ' + hex(payloadStart, 8) +
              ' could not be decoded: ' + msg(e));
          }
        } else {
          result.notes.push('OBU_SEQUENCE_HEADER found but the AV1 codec module is not loaded — ' +
            'the sequence header (' + size + ' bytes @ ' + hex(payloadStart, 8) + ') is listed but not decoded.');
        }
        frames.push({
          track: 1, index: frames.length + 1, type: 'header', kind: 'header', codec: 'av1',
          offset: start, size: obuLen, ptsSec: null, dtsSec: null,
          keyframe: false, label: 'sequence header',
          tables: seqTables || [synSection('OBU_SEQUENCE_HEADER (undecoded)',
            hex(payloadStart, 8) + ', ' + size + ' bytes', [{
              name: 'obu_size', syntax: 'leb128', bits: sizeBytes * 8, value: size,
              note: '', offset: q, depth: 0
            }])]
        });
      } else if (obuType === 6 || obuType === 3 || obuType === 4) {
        if (frames.length < MAX_FRAMES) {
          frames.push({
            track: 1,
            index: frames.length + 1,
            type: obuType === 6 ? 'frame' : (obuType === 3 ? 'frame header' : 'tile group'),
            kind: 'video',
            codec: 'av1',
            offset: start,
            size: obuLen,
            ptsSec: null,
            dtsSec: null,
            durationSec: null,
            keyframe: obuType === 6 && frames.length === 0 ? true : undefined,
            label: typeName,
            // The sample handed to the codec starts at the OBU header, not at the
            // payload — analyzeOBUs() needs the header to know what it is looking at.
            syn: { codec: 'av1', kind: 'obu', offset: start, size: obuLen, base: start }
          });
        }
      } else if (seqTables && obuType === 2) {
        // Temporal delimiter: nothing to decode, but it marks a frame boundary.
        if (frames.length < MAX_FRAMES) {
          frames.push({
            track: 1, index: frames.length + 1, type: 'td', kind: 'other', codec: 'av1',
            offset: start, size: obuLen, ptsSec: null, dtsSec: null, durationSec: null,
            keyframe: false, label: typeName,
            tables: [synSection('OBU_TEMPORAL_DELIMITER', 'marks the start of a temporal unit', [{
              name: 'obu_size', syntax: 'leb128', bits: sizeBytes * 8, value: size,
              note: '', offset: q, depth: 0
            }])]
          });
        }
      }

      if (!hasSize) break;                 // ran to EOF
      p = payloadStart + size;
      if (p <= start) break;               // defensive: never loop forever
      count++;
    }

    if (count >= MAX_OBU_NODES * 4) {
      result.notes.push('OBU walk stopped after ' + count + ' units.');
    }
    if (!frames.length) {
      result.notes.push('No complete OBU was found — the file may not be a raw AV1 OBU stream.');
    }

    var w = seqInfo ? (seqInfo.width || seqInfo.maxFrameWidth || seqInfo.max_frame_width) : null;
    var h = seqInfo ? (seqInfo.height || seqInfo.maxFrameHeight || seqInfo.max_frame_height) : null;
    var track = {
      id: 1, type: 'video', codec: 'av1', codecName: 'AV1',
      profile: seqInfo ? (seqInfo.seqProfile != null ? 'profile ' + seqInfo.seqProfile :
                          (seqInfo.profile || '')) : '',
      level: seqInfo ? (seqInfo.seqLevelIdx != null ? 'level ' + seqInfo.seqLevelIdx :
                        (seqInfo.level || '')) : '',
      width: w || null, height: h || null, fps: null,
      sampleRate: null, channels: null, bitDepth: null,
      durationSec: null, bitrate: null,
      sampleCount: frames.length,
      language: '',
      extra: []
    };
    if (seqInfo && seqInfo.bitDepth != null) {
      track.bitDepth = seqInfo.bitDepth;
      track.extra.push({ label: 'Bit depth', value: String(seqInfo.bitDepth) });
    }
    if (seqInfo && seqInfo.monoChrome != null) {
      track.extra.push({ label: 'Monochrome', value: seqInfo.monoChrome ? 'yes' : 'no' });
    }
    track.extra.push({ label: 'OBUs', value: String(count + 1) });
    track.extra.push({ label: 'Stream bytes', value: formatSize(bytes) });
    result.tracks.push(track);

    result.extra.push({ label: 'OBUs', value: String(count + 1) });
    var names = [];
    Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).forEach(function (t) {
      names.push((OBU_TYPE[t] ? OBU_TYPE[t].replace('OBU_', '') : 'type ' + t) + '=' + counts[t]);
    });
    if (names.length) result.extra.push({ label: 'OBU mix', value: names.join(', ') });
    if (!seqTables) {
      result.notes.push('No decodable sequence header was found — dimensions and profile are ' +
        'unknown for this OBU stream.');
    }

    frames.sort(function (a, b) { return a.offset - b.offset; });
    result.frames = frames;
    return result;
  }

  /* ==========================================================================
   * IVF
   * ========================================================================*/

  function parseIvf(ctx) {
    var data = ctx && ctx.data;
    var headerFourcc = '';
    if (data && data.length >= 4) {
      headerFourcc = String.fromCharCode(data[0], data[1], data[2], data[3]);
    }
    var inner = IVF_FOURCC[headerFourcc] || null;
    var formatName = 'IVF' + (inner ? ' (' + inner.name + ')' : '');
    var result = newResult('ivf', formatName);

    if (!data || data.length < 32) {
      result.notes.push('File is too short to hold a 32-byte IVF header.');
      return result;
    }
    if (headerFourcc !== 'DKIF') {
      result.notes.push('Signature is "' + headerFourcc + '", not "DKIF" — continuing anyway.');
    }

    var br = new MA.ByteReader(data);
    var version = br.u16le();           // 2
    var headerSize = br.u16le();        // 4
    var fourcc = br.fourcc(8);          // 12
    var width = br.u16le();             // 16
    var height = br.u16le();            // 18
    var rateNum = br.u32le();           // 20  timebase numerator
    var rateDen = br.u32le();           // 24  timebase denominator
    var frameCount = br.u32le();        // 28
    br.u32le();                         // 32  unused

    if (headerSize < 32 || headerSize > data.length) {
      result.notes.push('IVF header size ' + headerSize + ' is out of range — assuming 32 bytes.');
      headerSize = 32;
    }

    var hdr = makeNode('header', 'DKIF', 'IVF File Header', 0, headerSize);
    nodeField(hdr, 'signature', "'" + headerFourcc + "'", 0, 4);
    nodeField(hdr, 'version', version, 4, 2);
    nodeField(hdr, 'header_size', headerSize, 6, 2);
    nodeField(hdr, 'fourcc', "'" + fourcc + "'", 8, 4);
    nodeField(hdr, 'width', width, 12, 2);
    nodeField(hdr, 'height', height, 14, 2);
    nodeField(hdr, 'timebase_denominator', rateDen, 16, 4);
    nodeField(hdr, 'timebase_numerator', rateNum, 20, 4);
    nodeField(hdr, 'frame_count', frameCount, 24, 4);
    nodeField(hdr, 'unused', 0, 28, 4);
    result.structures.push(hdr);
    result.extra.push({ label: 'FourCC', value: "'" + fourcc + "'" + (inner ? ' — ' + inner.name : ' — unknown codec') });
    result.extra.push({ label: 'Header size', value: headerSize + ' bytes' });
    result.extra.push({ label: 'Timebase', value: rateNum + ' / ' + rateDen + ' s' });

    var codecId = inner ? inner.codec : '';
    var codecName = inner ? inner.name : (fourcc || 'unknown');
    var mod = codecId ? codec(codecId) : null;
    var fps = (rateNum > 0 && rateDen > 0) ? rateDen / rateNum : null;
    var durationSec = null;

    /* ---- frames ---- */
    var framesGroup = makeNode('group', 'frames', 'IVF Frames', headerSize, data.length - headerSize);
    framesGroup.expanded = false;
    result.structures.push(framesGroup);

    var declared = MA.safeCount(frameCount, Math.max(0, data.length - headerSize), 12);
    var maxFrames = Math.min(declared, MAX_FRAMES);
    var frames = [];
    if (declared < frameCount) {
      result.notes.push('The IVF header declares ' + frameCount + ' frames but only ' +
        declared + ' fit in the file — the rest are ignored.');
    }

    var p = headerSize;
    var made = 0;
    var totalBytes = 0;
    var lastTs = 0;
    var capNote = false;
    for (var i = 0; i < maxFrames && p + 12 <= data.length; i++) {
      var size = ((data[p + 3] << 24) | (data[p + 2] << 16) | (data[p + 1] << 8) | data[p]) >>> 0;
      var ts = data[p + 4] + data[p + 5] * 256 + data[p + 6] * 65536 + data[p + 7] * 16777216 +
               data[p + 8] * 4294967296 + data[p + 9] * 1099511627776 +
               data[p + 10] * 281474976710656 + data[p + 11] * 72057594037927936;
      var payloadStart = p + 12;
      var payloadEnd = payloadStart + size;
      if (payloadEnd > data.length) {
        result.notes.push('Frame #' + (i + 1) + ' at ' + hex(p, 8) + ' declares ' + size +
          ' bytes but only ' + (data.length - payloadStart) + ' remain — stopping.');
        break;
      }
      var ptsSec = fps ? ts / fps : null;
      if (ptsSec != null && ptsSec > lastTs) lastTs = ptsSec;
      totalBytes += size;

      var fr = {
        track: 1,
        index: i + 1,
        type: 'frame',
        kind: 'video',
        codec: codecId || fourcc,
        offset: payloadStart,
        size: size,
        ptsSec: ptsSec,
        dtsSec: ptsSec,
        durationSec: fps ? 1 / fps : null,
        keyframe: i === 0 ? true : undefined,
        label: (codecName) + ' frame'
      };
      if (codecId) {
        fr.syn = {
          codec: codecId,
          kind: (codecId === 'av1' || codecId === 'av2') ? 'obu' : 'raw',
          offset: payloadStart,
          size: size,
          base: payloadStart
        };
      }
      frames.push(fr);

      if (framesGroup.children.length < MAX_IVF_NODES) {
        var node = makeNode('frame', 'FR', 'IVF frame #' + (i + 1), p, 12 + size);
        nodeField(node, 'frame_size', size, p, 4);
        nodeField(node, 'timestamp', ts, p + 4, 8);
        nodeNote(node, 'payload @ ' + hex(payloadStart, 8) + ', ' + formatSize(size) +
          (ptsSec != null ? ', ' + MA.formatMs(ptsSec) : ''));
        framesGroup.children.push(node);
      } else if (!capNote) {
        capNote = true;
        nodeNote(framesGroup, '… further frame nodes omitted (capped at ' + MAX_IVF_NODES + ').');
        result.notes.push('Structure tree capped at ' + MAX_IVF_NODES + ' frames.');
      }

      made++;
      p = payloadEnd;
    }

    if (made < frameCount && made === maxFrames && p + 12 > data.length) {
      result.notes.push('Only ' + made + ' of the ' + frameCount + ' declared frames are present.');
    }

    if (fps && (lastTs || made)) {
      durationSec = made ? (lastTs + 1 / fps) : null;
    }

    var track = {
      id: 1,
      type: 'video',
      codec: codecId || fourcc,
      codecName: codecName,
      profile: '',
      level: '',
      width: width || null,
      height: height || null,
      fps: fps,
      sampleRate: null,
      channels: null,
      bitDepth: null,
      durationSec: durationSec,
      bitrate: durationSec ? Math.round(totalBytes * 8 / durationSec) : null,
      sampleCount: made,
      language: '',
      extra: []
    };
    track.extra.push({ label: 'FourCC', value: fourcc });
    track.extra.push({ label: 'Timebase', value: rateNum + ' / ' + rateDen });
    track.extra.push({ label: 'Frame bytes', value: formatSize(totalBytes) });
    if (!mod) {
      track.extra.push({ label: 'Per-frame syntax',
        value: 'needs js/codecs/' + (codecId || 'vpx') + '.js (not loaded)' });
      result.notes.push('The ' + (codecId || fourcc) + ' codec module is not loaded — ' +
        'each IVF frame is listed by offset and size, but its syntax cannot be decoded.');
    }
    result.tracks.push(track);

    result.durationSec = durationSec;
    result.extra.push({ label: 'Frames in file', value: made + (made !== frameCount ? ' of ' + frameCount + ' declared' : '') });
    if (fps) result.extra.push({ label: 'Frame rate', value: MA.formatFps(fps) });
    if (p < data.length) {
      result.extra.push({ label: 'Trailing bytes', value: (data.length - p) + ' after the last frame' });
    }
    if (!made) result.notes.push('No IVF frame could be read after the header.');

    frames.sort(function (a, b) { return a.offset - b.offset; });
    result.frames = frames;
    return result;
  }

  /* ==========================================================================
   * Shared post-processing
   * ========================================================================*/

  /** Fill per-frame durations from the next frame (same track) when known. */
  function fillDurations(frames) {
    var last = {};
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      var prev = last[f.track];
      if (prev && f.dtsSec != null && prev.dtsSec != null && f.dtsSec > prev.dtsSec) {
        prev.durationSec = f.dtsSec - prev.dtsSec;
      }
      last[f.track] = f;
    }
  }

  /* ==========================================================================
   * Registration
   * ========================================================================*/

  /**
   * Last line of defence: a parser throwing must not take the page down, so the
   * wrapper catches, notes the failure and leaves the user with a raw unit map.
   */
  function safe(fn, id, name) {
    var wrapped = function (ctx) {
      try {
        return fn(ctx);
      } catch (e) {
        var result = newResult(id, name);
        result.notes.push('Parsing failed: ' + msg(e));
        try {
          var data = ctx && ctx.data;
          if (data && data.length && NAL_ROLE[id]) {
            var group = makeNode('group', 'scan', 'Annex B NAL units', 0, data.length);
            var units = MA.annexBUnits(data, Math.min(data.length, 4 * 1024 * 1024));
            for (var i = 0; i < units.length && i < 2000; i++) {
              var u = units[i];
              var hdr = readNalHeader(data, u.start, id);
              var node = makeNode('element', 'NAL', nalTypeName(id, hdr.type), u.sc, u.len);
              nodeField(node, 'start_code', u.scLen === 4 ? '00 00 00 01' : '00 00 01',
                u.sc, u.scLen);
              nodeField(node, 'nal_unit_type', hdr.type + ' (' + nalTypeName(id, hdr.type) + ')',
                u.start, hdr.headerLen);
              group.children.push(node);
            }
            result.structures.push(group);
          }
        } catch (e2) { /* nothing more we can do */ }
        return result;
      }
    };
    return wrapped;
  }

  MA.registerParser({
    id: 'h264',
    name: 'H.264 / AVC (Annex B)',
    extensions: ['264', 'h264', 'avc', 'x264'],
    parse: safe(function (ctx) {
      return parseAnnexB(ctx, 'h264', 'H.264 / AVC (Annex B)');
    }, 'h264', 'H.264 / AVC (Annex B)')
  });
  MA.registerParser({
    id: 'h265',
    name: 'H.265 / HEVC (Annex B)',
    extensions: ['265', 'h265', 'hevc', 'x265'],
    parse: safe(function (ctx) {
      return parseAnnexB(ctx, 'h265', 'H.265 / HEVC (Annex B)');
    }, 'h265', 'H.265 / HEVC (Annex B)')
  });
  MA.registerParser({
    id: 'h266',
    name: 'H.266 / VVC (Annex B)',
    extensions: ['266', 'h266', 'vvc', 'x266'],
    parse: safe(function (ctx) {
      return parseAnnexB(ctx, 'h266', 'H.266 / VVC (Annex B)');
    }, 'h266', 'H.266 / VVC (Annex B)')
  });
  MA.registerParser({
    id: 'av1',
    name: 'AV1 (OBU stream)',
    extensions: ['obu', 'av1'],
    parse: safe(function (ctx) {
      return parseOBUStream(ctx, 'AV1 (OBU stream)');
    }, 'av1', 'AV1 (OBU stream)')
  });
  MA.registerParser({
    id: 'ivf',
    name: 'IVF (VP8/VP9/AV1)',
    extensions: ['ivf'],
    parse: safe(function (ctx) {
      return parseIvf(ctx);
    }, 'ivf', 'IVF')
  });

  MA.elementary = {
    parseAnnexB: parseAnnexB,
    parseOBUStream: parseOBUStream,
    parseIvf: parseIvf,
    hevcSpsFallback: hevcSpsFallback,
    readNalHeader: readNalHeader
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
