/* ============================================================================
 * MediaAnalyzer — codecs/h265.js
 *
 * H.265 / HEVC syntax parsing, ITU-T Rec. H.265 | ISO/IEC 23008-2.
 *
 * Every parsed structure is emitted as a syntax table whose rows mirror the
 * spec text (field / syntax / bits / value / meaning), so the frame panel can
 * show exactly what the bitstream says rather than a summary of it. Row
 * offsets are absolute file offsets, which is what lets the hex view follow a
 * syntax row.
 *
 * Entry points
 *   parseHVCC(br, end, base)             HEVCDecoderConfigurationRecord (hvcC)
 *   parseNAL(data, off, end, ctx)        one NAL unit -> { type, name, tables, info }
 *   parseVPS / parseSPS / parsePPS / parseSliceSegmentHeader / parseSEI
 *   analyzeAnnexB(data, ctx)             full raw .265 elementary stream
 *   buildSampleSyntax(payload, spec)     one MP4/MKV sample
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, unescapeRbsp = MA.unescapeRbsp, synSection = MA.synSection;
  var safeCount = MA.safeCount;

  /* ---------------------------------------------------------------- tables */

  /** nal_unit_type — H.265 Table 7-1 (0..63). */
  var NAL_TYPES = {
    0: 'TRAIL_N', 1: 'TRAIL_R', 2: 'TSA_N', 3: 'TSA_R', 4: 'STSA_N', 5: 'STSA_R',
    6: 'RADL_N', 7: 'RADL_R', 8: 'RASL_N', 9: 'RASL_R',
    10: 'RSV_VCL_N10', 11: 'RSV_VCL_R11', 12: 'RSV_VCL_N12', 13: 'RSV_VCL_R13',
    14: 'RSV_VCL_N14', 15: 'RSV_VCL_R15',
    16: 'BLA_W_LP', 17: 'BLA_W_RADL', 18: 'BLA_N_LP', 19: 'IDR_W_RADL',
    20: 'IDR_N_LP', 21: 'CRA_NUT', 22: 'RSV_IRAP_VCL22', 23: 'RSV_IRAP_VCL23',
    24: 'RSV_VCL24', 25: 'RSV_VCL25', 26: 'RSV_VCL26', 27: 'RSV_VCL27',
    28: 'RSV_VCL28', 29: 'RSV_VCL29', 30: 'RSV_VCL30', 31: 'RSV_VCL31',
    32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 36: 'EOS', 37: 'EOB',
    38: 'FD', 39: 'PREFIX_SEI', 40: 'SUFFIX_SEI',
    41: 'RSV_NVCL41', 42: 'RSV_NVCL42', 43: 'RSV_NVCL43', 44: 'RSV_NVCL44',
    45: 'RSV_NVCL45', 46: 'RSV_NVCL46', 47: 'RSV_NVCL47',
    48: 'UNSPEC48', 49: 'UNSPEC49', 50: 'UNSPEC50', 51: 'UNSPEC51',
    52: 'UNSPEC52', 53: 'UNSPEC53', 54: 'UNSPEC54', 55: 'UNSPEC55',
    56: 'UNSPEC56', 57: 'UNSPEC57', 58: 'UNSPEC58', 59: 'UNSPEC59',
    60: 'UNSPEC60', 61: 'UNSPEC61', 62: 'UNSPEC62', 63: 'UNSPEC63'
  };
  function nalTypeName(t) { return NAL_TYPES[t] || ('Type ' + t); }
  /** VCL types carry slice segment data (0..31). */
  function isVCL(t) { return t >= 0 && t <= 31; }
  /** IRAP pictures — BLA / IDR / CRA (H.265 §7.4.2.2). */
  function isIRAP(t) { return t >= 16 && t <= 23; }
  function isIDR(t) { return t === 19 || t === 20; }
  /** Types whose slice headers may carry a POC LSB / RPS. */
  function hasRps(t) { return !isIDR(t) && t !== 19 && t !== 20; }

  var SLICE_TYPES = ['B', 'P', 'I'];

  /** general_profile_idc — H.265 Table A.2 (the Rext sub-profile comes from
   *  the constraint flags, see rextSubProfile()). */
  var PROFILES = {
    1: 'Main', 2: 'Main 10', 3: 'Main Still Picture',
    4: 'Format range extensions', 5: 'High Throughput',
    9: 'Screen Content Coding', 10: 'Screen Content Coding Extensions',
    11: 'High Throughput Screen Content Coding'
  };
  /** Profile space 0 names, indexed by general_profile_compatibility_flag. */
  var COMPAT_NAMES = {
    1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'RExt',
    5: 'High Throughput', 6: 'RExt 6', 7: 'RExt 7', 8: 'RExt 8',
    9: 'SCC', 10: 'SCC Ext', 11: 'HT SCC'
  };
  /** Level limits — H.265 Table A.1 (level_idc -> level name, MaxLumaPs, MaxLumaSr main tier). */
  var LEVELS = {
    30:  { name: '1',   lumaPs: 36864,    lumaSr: 552960 },
    60:  { name: '2',   lumaPs: 122880,   lumaSr: 3686400 },
    63:  { name: '2.1', lumaPs: 245760,   lumaSr: 7372800 },
    90:  { name: '3',   lumaPs: 552960,   lumaSr: 16588800 },
    93:  { name: '3.1', lumaPs: 983040,   lumaSr: 33177600 },
    120: { name: '4',   lumaPs: 2228224,  lumaSr: 66846720 },
    123: { name: '4.1', lumaPs: 2228224,  lumaSr: 133693440 },
    150: { name: '5',   lumaPs: 8912896,  lumaSr: 267386880 },
    153: { name: '5.1', lumaPs: 8912896,  lumaSr: 534773760 },
    156: { name: '5.2', lumaPs: 8912896,  lumaSr: 1069547520 },
    180: { name: '6',   lumaPs: 35651584, lumaSr: 1069547520 },
    183: { name: '6.1', lumaPs: 35651584, lumaSr: 2139095040 },
    186: { name: '6.2', lumaPs: 35651584, lumaSr: 4278190080 },
    255: { name: '8.5', lumaPs: 0, lumaSr: 0 }
  };
  function levelName(idc) {
    var e = LEVELS[idc];
    if (e) return e.name;
    return (Math.floor(idc / 30)) + '.' + (idc % 30);
  }
  function tierName(t) { return t ? 'High tier' : 'Main tier'; }

  var CHROMA_FORMAT = ['monochrome', '4:2:0', '4:2:2', '4:4:4'];
  /** SubWidthC / SubHeightC per chroma_format_idc (H.265 Table 6-1). */
  function chromaSub(cf) {
    return cf === 1 ? [2, 2] : cf === 2 ? [2, 1] : [1, 1];
  }
  /** ChromaArrayType is 0 for monochrome and for separate colour planes. */
  function chromaArrayType(sps) {
    if (!sps) return 1;
    if (sps.separateColourPlaneFlag) return 0;
    return sps.chromaFormatIdc == null ? 1 : sps.chromaFormatIdc;
  }

  var ASPECT_RATIO = {
    1: '1:1 (square)', 2: '12:11', 3: '10:11', 4: '16:11', 5: '40:33', 6: '24:11',
    7: '20:11', 8: '32:11', 9: '80:33', 10: '18:11', 11: '15:11', 12: '64:33',
    13: '160:99', 14: '4:3', 15: '3:2', 16: '2:1', 17: '255:100',
    255: 'Extended_SAR'
  };
  var VIDEO_FORMAT = { 0: 'Component', 1: 'PAL', 2: 'NTSC', 3: 'SECAM', 4: 'MAC', 5: 'Unspecified' };
  var COLOUR_PRIMARIES = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'SMPTE 170M', 7: 'SMPTE 240M', 8: 'Film', 9: 'BT.2020', 10: 'SMPTE ST 428-1',
    11: 'SMPTE RP 431-2 (DCI-P3)', 12: 'SMPTE EG 432-1 (P3 D65)',
    22: 'EBU Tech 3213-E'
  };
  var TRANSFER_CHARACTERISTICS = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'Linear', 9: 'Logarithmic (100:1)',
    10: 'Logarithmic (316.22777:1)', 11: 'xvYCC', 12: 'BT.1361',
    13: 'sRGB / sYCC', 14: 'BT.2020 (10-bit)', 15: 'BT.2020 (12-bit)',
    16: 'SMPTE ST 2084 (PQ)', 17: 'SMPTE ST 428-1', 18: 'ARIB STD-B67 (HLG)'
  };
  var MATRIX_COEFFICIENTS = {
    0: 'Identity (GBR)', 1: 'BT.709', 2: 'Unspecified', 4: 'FCC', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'YCgCo', 9: 'BT.2020 non-constant',
    10: 'BT.2020 constant', 11: 'SMPTE ST 2085',
    12: 'Chromaticity-derived non-constant', 13: 'Chromaticity-derived constant',
    14: 'ICtCp'
  };
  /** SEI payload types — H.265 Table D.1. The numbering is shared with H.264
   *  (and H.266), so one type always means the same message. */
  var SEI_TYPE = {
    0: 'buffering_period', 1: 'pic_timing', 2: 'pan_scan_rect',
    3: 'filler_payload', 4: 'user_data_registered_itu_t_t35',
    5: 'user_data_unregistered', 6: 'recovery_point',
    9: 'scene_info', 15: 'full_frame_snapshot',
    16: 'progressive_refinement_segment_start', 17: 'progressive_refinement_segment_end',
    19: 'film_grain_characteristics', 22: 'post_filter_hint', 23: 'tone_mapping_info',
    45: 'frame_packing_arrangement', 47: 'display_orientation',
    128: 'sop_description (structure_of_pictures_info)',
    129: 'active_parameter_sets', 130: 'decoding_unit_info',
    131: 'temporal_sub_layer_zero_idx', 132: 'decoded_picture_hash',
    133: 'scalable_nesting', 134: 'region_refresh_info', 135: 'no_display',
    136: 'time_code', 137: 'mastering_display_colour_volume',
    144: 'content_light_level_info', 145: 'dependent_rps',
    147: 'alternative_transfer_characteristics', 148: 'ambient_viewing_environment',
    149: 'content_colour_volume', 150: 'equirectangular_projection',
    151: 'cubemap_projection', 154: 'sphere_rotation', 155: 'regionwise_packing',
    156: 'omni_viewport', 157: 'regional_nesting', 165: 'alpha_channel_info',
    200: 'sei_manifest', 201: 'sei_prefix_indication', 202: 'annotated_regions',
    203: 'subpicture_level_information', 204: 'sample_aspect_ratio_information',
    205: 'shutter_interval_info'
  };
  function seiName(t) { return SEI_TYPE[t] || 'reserved / unknown'; }

  var PIC_STRUCT = ['frame', 'top field', 'bottom field', 'top+bottom field',
                    'top, bottom, top field', 'top, bottom, top rep.',
                    'top, bottom, top rep., bottom', 'top, bottom, top+bottom rep.',
                    'top rep., bottom', 'top rep., bottom rep.', 'frame doubling',
                    'frame tripling'];
  var SCAN_TYPE = { 0: 'progressive', 1: 'interlaced', 2: 'unknown', 3: 'reserved' };
  var HASH_TYPE = { 0: 'MD5 (16 bytes)', 1: 'CRC (2 bytes)', 2: 'checksum (4 bytes)' };
  var FP_TYPE = ['checkerboard', 'column interleaving', 'row interleaving',
                 'side-by-side', 'top-bottom', 'frame sequential',
                 'reserved (6)', 'reserved (7)'];

  MA.h265Tables = {
    NAL_TYPES: NAL_TYPES, PROFILES: PROFILES, LEVELS: LEVELS,
    CHROMA_FORMAT: CHROMA_FORMAT, SEI_TYPE: SEI_TYPE
  };

  /* ======================================================================
   * profile_tier_level()  —  H.265 §7.3.3
   * ====================================================================*/

  /** bit `i` (0 = MSB) of a `width` bit value. */
  function bitAt(v, i, width) {
    return Math.floor(v / Math.pow(2, width - 1 - i)) % 2;
  }
  /** A synthetic syntax row (for values decoded out of a packed field). */
  function synRow(name, syntax, bits, value, note, offset, depth) {
    return { name: name, syntax: syntax, bits: bits, value: value, note: note || '',
             offset: offset || 0, depth: depth || 0 };
  }
  /** general_profile_idc in the range that carries the 43 constraint bits. */
  function hasConstraintBits(idc, compat) {
    if (idc >= 4 && idc <= 11) return true;
    for (var j = 4; j <= 11; j++) if (bitAt(compat, j, 32)) return true;
    return false;
  }
  function has14BitFlag(idc, compat) {
    var wide = [5, 9, 10, 11];
    if (wide.indexOf(idc) >= 0) return true;
    for (var k = 0; k < wide.length; k++) if (bitAt(compat, wide[k], 32)) return true;
    return false;
  }
  /**
   * ISO/IEC 23008-2 Table A.2 — the RExt profile names are selected by the
   * constraint flags, e.g. {max_12bit, max_4:2:2, intra} -> "Main 4:2:2 12 Intra".
   */
  function rextSubProfile(f) {
    var depth = f.max12 ? '12' : f.max10 ? '10' : f.max8 ? '8' : '16';
    var intra = f.intra ? ' Intra' : '';
    if (f.mono) return 'Monochrome ' + depth + intra;
    if (!f.max420 && !f.max422) return 'Main 4:4:4 ' + depth + intra;
    if (f.max422 && !f.max420) return 'Main 4:2:2 ' + depth + intra;
    if (f.max422 && f.max420) return 'Main ' + depth + intra;
    return 'Main ' + depth + intra;
  }
  /** Human readable profile annotation for a profile_idc / flags pair. */
  function profileNote(idc, f) {
    if (idc === 4) return PROFILES[4] + (f ? ' — ' + rextSubProfile(f) : '');
    return PROFILES[idc] || ('Reserved / unknown (profile_idc = ' + idc + ')');
  }
  /** Which of the 32 compatibility flags are set, listed by profile name. */
  function compatNote(v) {
    var out = [];
    for (var j = 0; j < 32; j++) {
      if (bitAt(v, j, 32)) out.push('flag[' + j + ']' + (COMPAT_NAMES[j] ? ' (' + COMPAT_NAMES[j] + ')' : ''));
    }
    return out.length ? out.join(', ') : 'no compatibility flag set';
  }

  /** general_profile_space / tier / idc / compatibility / constraint block. */
  function readProfileBlock(r, sfx, info, store) {
    function pn(base) {
      return sfx == null ? 'general_' + base : 'sub_layer_' + base + '[' + sfx + ']';
    }
    var space = r.u(pn('profile_space'), 2);
    r.note(space ? 'Profile space ' + space : 'Profile space 0 (default)');
    var tier = r.flag(pn('tier_flag'));
    r.note(tierName(tier));
    var idc = r.u(pn('profile_idc'), 5);
    var compat = r.u(pn('profile_compatibility_flag') + '[0..31]', 32);
    r.note(compatNote(compat));
    var f = {
      progressive: r.flag(pn('progressive_source_flag')),
      interlaced: r.flag(pn('interlaced_source_flag')),
      nonPacked: r.flag(pn('non_packed_constraint_flag')),
      frameOnly: r.flag(pn('frame_only_constraint_flag'))
    };
    r.note((f.interlaced ? 'interlaced source allowed' : 'progressive source only') + ', ' +
           (f.frameOnly ? 'frames only' : 'fields allowed') + ', ' +
           (f.nonPacked ? 'no packed frames' : 'packed frames allowed'));
    if (hasConstraintBits(idc, compat)) {
      r.cond('hasConstraintBits( profile_idc, compatibility )');
      f.max12 = r.flag(pn('max_12bit_constraint_flag'));
      f.max10 = r.flag(pn('max_10bit_constraint_flag'));
      f.max8 = r.flag(pn('max_8bit_constraint_flag'));
      f.max422 = r.flag(pn('max_422chroma_constraint_flag'));
      f.max420 = r.flag(pn('max_420chroma_constraint_flag'));
      f.mono = r.flag(pn('max_monochrome_constraint_flag'));
      f.intra = r.flag(pn('intra_constraint_flag'));
      f.onePicture = r.flag(pn('one_picture_only_constraint_flag'));
      f.lowerBitRate = r.flag(pn('lower_bit_rate_constraint_flag'));
      if (has14BitFlag(idc, compat)) {
        r.cond('has14BitFlag( profile_idc, compatibility )');
        f.max14 = r.flag(pn('max_14bit_constraint_flag'));
        r.u(pn('reserved_zero_33bits'), 33);
        r.endBlock();
      } else {
        r.u(pn('reserved_zero_34bits'), 34);
      }
      var bits = [];
      if (f.max14) bits.push('14-bit');
      if (f.max12) bits.push('12-bit');
      if (f.max10) bits.push('10-bit');
      if (f.max8) bits.push('8-bit');
      if (f.onePicture) bits.push('one picture only');
      if (f.lowerBitRate) bits.push('lower bit rate');
      r.note(bits.length || f.intra ? (f.intra ? 'intra only, ' : '') + (bits.join(', ') || 'no depth/rate limit')
                                     : 'no depth/rate limit');
      r.endBlock();
    } else {
      r.u(pn('reserved_zero_43bits'), 43);
    }
    // general_inbld_flag is present for the defined profiles (1..11), otherwise
    // the bit is reserved_zero_bit — both are one bit, so parsing stays aligned.
    var known = (idc >= 1 && idc <= 11);
    if (!known) for (var j = 1; j <= 11; j++) if (bitAt(compat, j, 32)) known = true;
    if (known) r.flag(pn('inbld_flag'));
    else r.u(pn('reserved_zero_bit'), 1);
    r.note(profileNote(idc, f));
    if (store && info) {
      info.generalProfileSpace = space;
      info.generalTierFlag = tier;
      info.generalProfileIdc = idc;
      info.generalProfile = profileNote(idc, f);
      info.generalCompatFlags = compat;
      info.constraintFlags = f;
      if (sfx == null) info.profile = info.generalProfile;
    }
  }

  /**
   * profile_tier_level( profilePresentFlag, maxNumSubLayersMinus1 )
   * @param {number} maxSub number of sub-layer entries (the spec's minus1 value)
   */
  function profileTierLevel(r, profilePresent, maxSub, info) {
    maxSub = Math.max(0, Math.min(maxSub | 0, 7));
    r.depth++;
    r.group('profile_tier_level( profilePresentFlag = ' + (profilePresent ? 1 : 0) +
            ', maxNumSubLayersMinus1 = ' + maxSub + ' )');
    if (profilePresent) readProfileBlock(r, null, info, true);
    var lvl = r.u('general_level_idc', 8);
    var lim = LEVELS[lvl];
    r.note('Level ' + levelName(lvl) + ', ' + tierName(info && info.generalTierFlag) +
           (lim && lim.lumaPs ? ', max ' + lim.lumaPs + ' luma samples/pic' : ''));
    if (info) { info.levelIdc = lvl; info.level = levelName(lvl); }
    var subProfile = [], subLevel = [], i;
    for (i = 0; i < maxSub; i++) {
      subProfile[i] = r.flag('sub_layer_profile_present_flag[' + i + ']');
      subLevel[i] = r.flag('sub_layer_level_present_flag[' + i + ']');
    }
    // reserved_zero_2bits pads the (up to 8) sub-layer flag pairs.
    for (i = maxSub; i < 8; i++) r.u('reserved_zero_2bits[' + i + ']', 2);
    for (i = 0; i < maxSub; i++) {
      if (subProfile[i]) {
        r.cond('sub_layer_profile_present_flag[ ' + i + ' ]');
        readProfileBlock(r, i, null, false);
        r.endBlock();
      }
      if (subLevel[i]) {
        r.cond('sub_layer_level_present_flag[ ' + i + ' ]');
        var sl = r.u('sub_layer_level_idc[' + i + ']', 8);
        r.note('Level ' + levelName(sl) + ' (temporal sub-layer ' + (i + 1) + ')');
        r.endBlock();
      }
    }
    r.depth--;
  }

  /* ======================================================================
   * hrd_parameters()  —  H.265 §E.2.2
   * ====================================================================*/

  function hrdParameters(r, commonPresent, maxSub, info) {
    r.depth++;
    r.group('hrd_parameters( commonInfPresentFlag = ' + (commonPresent ? 1 : 0) +
            ', maxNumSubLayersMinus1 = ' + maxSub + ' )');
    var nalHrd = 0, vclHrd = 0, subPic = 0;
    if (commonPresent) {
      r.cond('commonInfPresentFlag');
      nalHrd = r.flag('nal_hrd_parameters_present_flag');
      vclHrd = r.flag('vcl_hrd_parameters_present_flag');
      if (nalHrd || vclHrd) {
        r.cond('nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag');
        subPic = r.flag('sub_pic_hrd_params_present_flag');
        if (subPic) {
          r.cond('sub_pic_hrd_params_present_flag');
          r.u('tick_divisor_minus2', 8);
          r.u('du_cpb_removal_delay_increment_length_minus1', 5);
          r.flag('sub_pic_cpb_params_in_pic_timing_sei_flag');
          r.u('dpb_output_delay_du_length_minus1', 5);
          r.endBlock();
        }
        r.u('bit_rate_scale', 4);
        r.u('cpb_size_scale', 4);
        if (subPic) r.u('cpb_size_du_scale', 4);
        r.u('initial_cpb_removal_delay_length_minus1', 5);
        r.u('au_cpb_removal_delay_length_minus1', 5);
        r.u('dpb_output_delay_length_minus1', 5);
        r.endBlock();
      }
      if (info) { info.nalHrd = !!nalHrd; info.vclHrd = !!vclHrd; }
      r.endBlock();
    }
    for (var i = 0; i <= maxSub && i < 8; i++) {
      var fixedGeneral = r.flag('fixed_pic_rate_general_flag[' + i + ']');
      var fixed = fixedGeneral;
      if (!fixedGeneral) {
        r.cond('!fixed_pic_rate_general_flag[ ' + i + ' ]');
        fixed = r.flag('fixed_pic_rate_within_cvs_flag[' + i + ']');
        r.endBlock();
      }
      var cpbCnt = 0;
      var lowDelay = 0;
      if (fixed) {
        r.cond('fixed_pic_rate[ ' + i + ' ]');
        var dur = r.ue('elemental_duration_in_tc_minus1[' + i + ']');
        r.note('elemental duration = ' + (dur + 1));
        r.endBlock();
      } else {
        lowDelay = r.flag('low_delay_hrd_flag[' + i + ']');
      }
      if (!lowDelay) {
        r.cond('!low_delay_hrd_flag[ ' + i + ' ]');
        cpbCnt = r.ue('cpb_cnt_minus1[' + i + ']') + 1;
        r.note(cpbCnt + ' CPB' + (cpbCnt === 1 ? '' : 's'));
        r.endBlock();
      }
      // sub_layer_hrd_parameters( i ) — only when the common flags ask for it.
      if (nalHrd || vclHrd) {
        var cap = Math.min(cpbCnt, 32);
        if (cap > 0) {
          r.cond('nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag');
          r.group('sub_layer_hrd_parameters( ' + i + ' )' + (cpbCnt > cap ? ' — first ' + cap + ' of ' + cpbCnt : ''));
          for (var c = 0; c < cap; c++) {
            r.ue('bit_rate_value_minus1[' + i + '][' + c + ']');
            r.ue('cpb_size_value_minus1[' + i + '][' + c + ']');
            if (subPic) {
              r.cond('sub_pic_hrd_params_present_flag');
              r.ue('cpb_size_du_value_minus1[' + i + '][' + c + ']');
              r.ue('bit_rate_du_value_minus1[' + i + '][' + c + ']');
              r.endBlock();
            }
            r.flag('cbr_flag[' + i + '][' + c + ']');
          }
          r.endBlock();
        } else if (subPic) {
          /* no CPB entries — nothing to read */
        }
      }
    }
    r.depth--;
  }

  /* ======================================================================
   * scaling_list_data()  —  H.265 §7.3.4
   * ====================================================================*/

  function scalingListData(r) {
    r.depth++;
    r.group('scaling_list_data()');
    for (var sizeId = 0; sizeId < 4; sizeId++) {
      var matrices = sizeId === 3 ? 2 : 6;
      for (var matrixId = 0; matrixId < matrices; matrixId++) {
        var pred = r.flag('scaling_list_pred_mode_flag[' + sizeId + '][' + matrixId + ']');
        if (!pred) {
          r.cond('!scaling_list_pred_mode_flag[ ' + sizeId + ' ][ ' + matrixId + ' ]');
          r.ue('scaling_list_pred_matrix_id_delta[' + sizeId + '][' + matrixId + ']');
          r.endBlock();
        } else {
          r.cond('scaling_list_pred_mode_flag[ ' + sizeId + ' ][ ' + matrixId + ' ]');
          var nextCoef = 8;
          var coefNum = Math.min(64, 1 << (4 + (sizeId << 1)));
          if (sizeId > 1) {
            r.cond('sizeId > 1');
            var dc = r.se('scaling_list_dc_coef_minus8[' + (sizeId - 2) + '][' + matrixId + ']');
            nextCoef = (dc + 8 + 256) % 256;
            r.note('DC coefficient = ' + nextCoef);
            r.endBlock();
          }
          for (var i = 0; i < coefNum; i++) {
            var d = r.se('scaling_list_delta_coef[' + sizeId + '][' + matrixId + '][' + i + ']');
            nextCoef = (nextCoef + d + 256) % 256;
          }
          r.note('reconstructed to ' + nextCoef + ' (+deltas, ' + coefNum + ' coefficients)');
          r.endBlock();
        }
      }
    }
    r.depth--;
  }

  /* ======================================================================
   * vui_parameters()  —  H.265 §E.2.1
   * ====================================================================*/

  function vuiParameters(r, info, maxSub) {
    r.depth++;
    r.group('vui_parameters()');
    if (r.flag('aspect_ratio_info_present_flag')) {
      r.cond('aspect_ratio_info_present_flag');
      var ar = r.u('aspect_ratio_idc', 8);
      r.note(ASPECT_RATIO[ar] || (ar === 255 ? 'Extended_SAR' : 'Reserved'));
      if (ar === 255) {
        r.cond('aspect_ratio_idc == 255');
        var w = r.u('sar_width', 16), h = r.u('sar_height', 16);
        r.note('sample aspect ratio ' + w + ':' + h);
        if (info) info.sar = w + ':' + h;
        r.endBlock();
      } else if (ASPECT_RATIO[ar] && info) info.sar = ASPECT_RATIO[ar];
      r.endBlock();
    }
    if (r.flag('overscan_info_present_flag')) {
      r.cond('overscan_info_present_flag');
      var ap = r.flag('overscan_appropriate_flag');
      r.note(ap ? 'overscan is appropriate (display should crop)' : 'overscan is not appropriate');
      r.endBlock();
    }
    if (r.flag('video_signal_type_present_flag')) {
      r.cond('video_signal_type_present_flag');
      var vf = r.u('video_format', 3);
      r.note(VIDEO_FORMAT[vf] || 'Reserved');
      var full = r.flag('video_full_range_flag');
      r.note(full ? 'full range' : 'limited range');
      if (info) info.fullRange = !!full;
      if (r.flag('colour_description_present_flag')) {
        r.cond('colour_description_present_flag');
        var cp = r.u('colour_primaries', 8); r.note(COLOUR_PRIMARIES[cp] || 'Reserved');
        var tc = r.u('transfer_characteristics', 8); r.note(TRANSFER_CHARACTERISTICS[tc] || 'Reserved');
        var mc = r.u('matrix_coeffs', 8); r.note(MATRIX_COEFFICIENTS[mc] || 'Reserved');
        if (info) info.colour = {
          primaries: COLOUR_PRIMARIES[cp] || cp,
          transfer: TRANSFER_CHARACTERISTICS[tc] || tc,
          matrix: MATRIX_COEFFICIENTS[mc] || mc
        };
        r.endBlock();
      }
      r.endBlock();
    }
    if (r.flag('chroma_loc_info_present_flag')) {
      r.cond('chroma_loc_info_present_flag');
      r.ue('chroma_sample_loc_type_top_field');
      r.ue('chroma_sample_loc_type_bottom_field');
      r.endBlock();
    }
    var neutral = r.flag('neutral_chroma_indication_flag');
    r.note(neutral ? 'chroma samples are neutral grey' : '');
    var fieldSeq = r.flag('field_seq_flag');
    r.note(fieldSeq ? 'the CVS carries fields, not frames' : 'the CVS carries frames');
    if (info) info.fieldSeq = !!fieldSeq;
    var ffi = r.flag('frame_field_info_present_flag');
    r.note(ffi ? 'pic_struct/source_scan_type are present in pic_timing' : '');
    if (r.flag('default_display_window_flag')) {
      r.cond('default_display_window_flag');
      var dl = r.ue('def_disp_win_left_offset');
      var dr = r.ue('def_disp_win_right_offset');
      var dt = r.ue('def_disp_win_top_offset');
      var db = r.ue('def_disp_win_bottom_offset');
      r.note('display window: left ' + dl + ', right ' + dr + ', top ' + dt + ', bottom ' + db);
      r.endBlock();
    }
    if (r.flag('vui_timing_info_present_flag')) {
      r.cond('vui_timing_info_present_flag');
      var num = r.u('vui_num_units_in_tick', 32);
      var scale = r.u('vui_time_scale', 32);
      if (info) info.timeScale = scale;
      if (num > 0 && info) {
        info.fps = scale / num;
        r.note('nominal ' + info.fps.toFixed(3) + ' fps');
      }
      if (r.flag('vui_poc_proportional_to_timing_flag')) {
        r.cond('vui_poc_proportional_to_timing_flag');
        var nt = r.ue('vui_num_ticks_poc_diff_one_minus1');
        r.note((nt + 1) + ' ticks per POC unit');
        r.endBlock();
      }
      if (r.flag('vui_hrd_parameters_present_flag')) {
        r.cond('vui_hrd_parameters_present_flag');
        hrdParameters(r, 1, maxSub, info);
        r.endBlock();
      }
      r.endBlock();
    }
    if (r.flag('bitstream_restriction_flag')) {
      r.cond('bitstream_restriction_flag');
      r.group('bitstream_restriction()');
      var tileFixed = r.flag('tiles_fixed_structure_flag');
      r.note(tileFixed ? 'tile structure is fixed for the whole CVS' : '');
      r.flag('motion_vectors_over_pic_boundaries_flag');
      r.flag('restricted_ref_pic_lists_flag');
      r.ue('min_spatial_segmentation_idc');
      var mbp = r.ue('max_bytes_per_pic_denom');
      r.ue('max_bits_per_min_cu_denom');
      r.ue('log2_max_mv_length_horizontal');
      r.ue('log2_max_mv_length_vertical');
      r.note('max bytes per picture = 1/' + (1 << Math.min(mbp, 16)) + ' of the picture size');
      r.endBlock();
    }
    r.depth--;
  }

  /* ======================================================================
   * st_ref_pic_set()  —  H.265 §7.3.7
   * ====================================================================*/

  /**
   * @param {number} idx      stRpsIdx
   * @param {number} numSets  num_short_term_ref_pic_sets (slice header passes it)
   * @param {Array}  deltaArr NumDeltaPocs[] of the previous sets (may be null)
   * @returns {number} the number of delta POCs of this set (best effort)
   */
  function stRefPicSet(r, idx, numSets, deltaArr) {
    r.depth++;
    r.group('st_ref_pic_set( stRpsIdx = ' + idx + ' )');
    var interPred = 0;
    if (idx !== 0) {
      r.cond('stRpsIdx != 0');
      interPred = r.flag('inter_ref_pic_set_prediction_flag[' + idx + ']');
      r.note(interPred ? 'predicted from an earlier set' : 'explicitly coded');
      r.endBlock();
    }
    var numDelta = 0;
    if (interPred) {
      r.cond('inter_ref_pic_set_prediction_flag[ ' + idx + ' ]');
      var deltaIdx = 0;
      if (idx === numSets) {
        r.cond('stRpsIdx == num_short_term_ref_pic_sets');
        deltaIdx = r.ue('delta_idx_minus1') + 1;
        r.endBlock();
      }
      var sign = r.flag('delta_rps_sign');
      var absDelta = r.ue('abs_delta_rps_minus1') + 1;
      r.note('delta RPS = ' + (sign ? '-' : '+') + absDelta);
      var refIdx = idx - deltaIdx;
      var refCount = (deltaArr && deltaArr[refIdx] != null) ? deltaArr[refIdx] : null;
      var flags;
      if (refCount == null) {
        // The referenced set is unknown (corrupt or out-of-order stream):
        // bound the loop by the bits that are actually left (1 bit minimum
        // per flag) so a broken count cannot spin here.
        flags = Math.min(Math.floor(r.bitsLeft()), 64);
        r.note('reference set ' + refIdx + ' unknown — at most ' + flags + ' flags');
      } else {
        flags = Math.min(refCount, 64);
      }
      for (var j = 0; j <= flags && r.bitsLeft() > 0; j++) {
        var used = r.flag('used_by_curr_pic_flag[' + j + ']');
        if (used) numDelta++;
        else if (r.flag('use_delta_flag[' + j + ']')) numDelta++;
      }
      r.endBlock();
    } else {
      r.group('else  /* !inter_ref_pic_set_prediction_flag */');
      r.depth++;
      var numNeg = r.ue('num_negative_pics');
      var numPos = r.ue('num_positive_pics');
      // Each entry costs at least two syntax elements (ue + flag), so bound by
      // the remaining bits as well as by the spec limit (<= 32 delta POCs).
      var maxNeg = safeCount(numNeg, Math.floor(r.bitsLeft() / 2) + 1, 1);
      maxNeg = Math.min(maxNeg, 32);
      var maxPos = safeCount(numPos, Math.floor(r.bitsLeft() / 2) + 1, 1);
      maxPos = Math.min(maxPos, 32);
      if (maxNeg !== numNeg || maxPos !== numPos) r.note('counts clamped to the remaining bits');
      r.note(numNeg + ' negative / ' + numPos + ' positive pictures');
      var i;
      for (i = 0; i < maxNeg; i++) {
        r.ue('delta_poc_s0_minus1[' + i + ']');
        if (r.flag('used_by_curr_pic_s0_flag[' + i + ']')) numDelta++;
      }
      for (i = 0; i < maxPos; i++) {
        r.ue('delta_poc_s1_minus1[' + i + ']');
        if (r.flag('used_by_curr_pic_s1_flag[' + i + ']')) numDelta++;
      }
      numDelta = 0;
      for (i = 0; i < maxNeg; i++) numDelta += 0;   // (counted above, kept explicit)
      r.endBlock();
    }
    r.depth--;
    return numDelta;
  }

  /* ======================================================================
   * vps_video_parameter_set_rbsp()  —  H.265 §7.3.2.1
   * ====================================================================*/

  function parseVPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      info.vpsId = r.u('vps_video_parameter_set_id', 4);
      r.u('vps_base_layer_internal_flag', 1);
      r.u('vps_base_layer_available_flag', 1);
      info.maxLayersMinus1 = r.u('vps_max_layers_minus1', 6);
      var maxSub = r.u('vps_max_sub_layers_minus1', 3);
      info.maxSubLayers = maxSub + 1;
      r.note((maxSub + 1) + ' temporal sub-layers');
      r.flag('vps_temporal_id_nesting_flag');
      r.u('vps_reserved_0xffff_16bits', 16);
      profileTierLevel(r, 1, maxSub, info);

      var ordering = r.flag('vps_sub_layer_ordering_info_present_flag');
      for (var i = (ordering ? 0 : maxSub); i <= maxSub && i < 8; i++) {
        var bufs = r.ue('vps_max_dec_pic_buffering_minus1[' + i + ']') + 1;
        r.note(bufs + ' picture buffers');
        r.ue('vps_max_num_reorder_pics[' + i + ']');
        r.ue('vps_max_latency_increase_plus1[' + i + ']');
      }
      var maxLayerId = r.u('vps_max_layer_id', 6);
      info.maxLayerId = maxLayerId;
      var numLayerSets = r.ue('vps_num_layer_sets_minus1');
      var sets = Math.min(numLayerSets, Math.floor(r.bitsLeft() / Math.max(1, maxLayerId + 1)));
      sets = Math.min(sets, 64);
      if (numLayerSets > 0 && sets !== numLayerSets) r.note('layer sets clamped to ' + sets);
      for (var s = 1; s <= sets; s++) {
        for (var j = 0; j <= maxLayerId && j < 64; j++) {
          r.flag('layer_id_included_flag[' + s + '][' + j + ']');
        }
      }
      if (r.flag('vps_timing_info_present_flag')) {
        r.cond('vps_timing_info_present_flag');
        r.u('vps_num_units_in_tick', 32);
        var scale = r.u('vps_time_scale', 32);
        info.timeScale = scale;
        if (r.flag('vps_poc_proportional_to_timing_flag')) {
          r.cond('vps_poc_proportional_to_timing_flag');
          r.ue('vps_num_ticks_poc_diff_one_minus1');
          r.endBlock();
        }
        var numHrd = r.ue('vps_num_hrd_parameters');
        var hrdCnt = Math.min(numHrd, 64);
        for (var h = 0; h < hrdCnt; h++) {
          r.ue('hrd_layer_set_idx[' + h + ']');
          var cprms = h > 0 ? r.flag('cprms_present_flag[' + h + ']') : 1;
          hrdParameters(r, cprms, maxSub, info);
        }
        if (numHrd > hrdCnt) r.note('HRD entries clamped to ' + hrdCnt);
        r.endBlock();
      }
      if (r.flag('vps_extension_flag')) {
        r.cond('vps_extension_flag');
        var n = 0;
        while (r.bitsLeft() > 8 && n++ < 256) r.flag('vps_extension_data_flag');
        r.note('extension data ignored (' + n + ' bits)');
        r.endBlock();
      }
      r.trailing('rbsp_trailing_bits()');
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * sps_seq_parameter_set_rbsp()  —  H.265 §7.3.2.2
   * ====================================================================*/

  function parseSPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = { deltaPocs: [] };
    try {
      info.vpsId = r.u('sps_video_parameter_set_id', 4);
      var maxSub = r.u('sps_max_sub_layers_minus1', 3);
      info.maxSubLayers = maxSub + 1;
      r.note((maxSub + 1) + ' temporal sub-layers');
      info.temporalIdNesting = r.flag('sps_temporal_id_nesting_flag');
      profileTierLevel(r, 1, maxSub, info);

      info.spsId = r.ue('sps_seq_parameter_set_id');
      var cf = r.ue('chroma_format_idc');
      info.chromaFormatIdc = cf;
      r.note(CHROMA_FORMAT[cf] || 'Reserved');
      if (cf === 3) {
        r.cond('chroma_format_idc == 3');
        info.separateColourPlaneFlag = r.flag('separate_colour_plane_flag');
        r.endBlock();
      }
      var w = r.ue('pic_width_in_luma_samples');
      var h = r.ue('pic_height_in_luma_samples');
      info.codedWidth = w;
      info.codedHeight = h;
      var cl = 0, cr = 0, ct = 0, cb = 0;
      if (r.flag('conformance_window_flag')) {
        r.cond('conformance_window_flag');
        cl = r.ue('conf_win_left_offset');
        cr = r.ue('conf_win_right_offset');
        ct = r.ue('conf_win_top_offset');
        cb = r.ue('conf_win_bottom_offset');
        r.endBlock();
      }
      var sub = chromaSub(cf);
      info.width = w - (cl + cr) * sub[0];
      info.height = h - (ct + cb) * sub[1];
      if (cl || cr || ct || cb) {
        r.note('cropped to ' + info.width + 'x' + info.height +
               ' (coded ' + w + 'x' + h + ')');
      } else {
        r.note(w + 'x' + h);
      }
      info.bitDepthLuma = r.ue('bit_depth_luma_minus8') + 8;
      info.bitDepthChroma = r.ue('bit_depth_chroma_minus8') + 8;
      r.note(info.bitDepthLuma + '-bit luma / ' + info.bitDepthChroma + '-bit chroma');

      info.log2MaxPocLsb = r.ue('log2_max_pic_order_cnt_lsb_minus4') + 4;
      r.note('MaxPicOrderCntLsb = ' + (1 << info.log2MaxPocLsb));

      var ordering = r.flag('sps_sub_layer_ordering_info_present_flag');
      info.dpb = [];
      for (var i = (ordering ? 0 : maxSub); i <= maxSub && i < 8; i++) {
        var bufs = r.ue('sps_max_dec_pic_buffering_minus1[' + i + ']') + 1;
        var reorder = r.ue('sps_max_num_reorder_pics[' + i + ']');
        var latency = r.ue('sps_max_latency_increase_plus1[' + i + ']');
        info.dpb.push({ subLayer: i, buffers: bufs, reorder: reorder, latency: latency });
        r.note(bufs + ' pictures in the DPB, ' + reorder + ' reordered' +
               (latency ? ', latency +' + (latency - 1) : ''));
      }

      var log2MinCb = r.ue('log2_min_luma_coding_block_size_minus3') + 3;
      var diffCb = r.ue('log2_diff_max_min_luma_coding_block_size');
      info.log2MinLumaCb = Math.max(3, Math.min(log2MinCb, 6));
      info.log2DiffMaxMinLumaCb = Math.max(0, Math.min(diffCb, 6));
      var ctbLog2 = Math.min(info.log2MinLumaCb + info.log2DiffMaxMinLumaCb, 8);
      info.ctbSize = 1 << ctbLog2;
      r.note('CTB size = ' + info.ctbSize + 'x' + info.ctbSize);
      var log2MinTb = r.ue('log2_min_luma_transform_block_size_minus2') + 2;
      var diffTb = r.ue('log2_diff_max_min_luma_transform_block_size');
      info.log2MinLumaTb = Math.max(2, Math.min(log2MinTb, 5));
      info.log2MaxLumaTb = Math.min(info.log2MinLumaTb + Math.max(0, Math.min(diffTb, 5)), 6);
      r.note('transform blocks ' + (1 << info.log2MinLumaTb) + '..' + (1 << info.log2MaxLumaTb));
      info.maxTransformHierarchyInter = r.ue('max_transform_hierarchy_depth_inter');
      info.maxTransformHierarchyIntra = r.ue('max_transform_hierarchy_depth_intra');

      if (r.flag('scaling_list_enabled_flag')) {
        r.cond('scaling_list_enabled_flag');
        if (r.flag('sps_scaling_list_data_present_flag')) {
          r.cond('sps_scaling_list_data_present_flag');
          scalingListData(r);
          r.endBlock();
        }
        r.endBlock();
      }
      info.ampEnabled = r.flag('amp_enabled_flag');
      info.saoEnabled = r.flag('sample_adaptive_offset_enabled_flag');
      info.pcmEnabled = r.flag('pcm_enabled_flag');
      if (info.pcmEnabled) {
        r.cond('pcm_enabled_flag');
        var pcmL = r.u('pcm_sample_bit_depth_luma_minus1', 4) + 1;
        var pcmC = r.u('pcm_sample_bit_depth_chroma_minus1', 4) + 1;
        r.note(pcmL + '-bit PCM luma, ' + pcmC + '-bit PCM chroma');
        var pcmLog2Min = r.ue('log2_min_pcm_luma_coding_block_size_minus3') + 3;
        var pcmLog2Diff = r.ue('log2_diff_max_min_pcm_luma_coding_block_size');
        r.note('PCM block ' + (1 << pcmLog2Min) + '..' + (1 << (pcmLog2Min + pcmLog2Diff)));
        r.flag('pcm_loop_filter_disabled_flag');
        r.endBlock();
      }

      var numStrps = r.ue('num_short_term_ref_pic_sets');
      info.numShortTermRefPicSets = numStrps;
      r.note(numStrps + ' short-term RPS in the SPS');
      var maxSets = Math.min(numStrps, Math.floor(r.bitsLeft() / 2) + 1, 64);
      if (maxSets !== numStrps) r.note('RPS count clamped to ' + maxSets);
      info.deltaPocs = [];
      for (var s = 0; s < maxSets; s++) {
        info.deltaPocs[s] = stRefPicSet(r, s, numStrps, info.deltaPocs);
      }
      info.longTermRefPicsPresent = r.flag('long_term_ref_pics_present_flag');
      if (info.longTermRefPicsPresent) {
        r.cond('long_term_ref_pics_present_flag');
        var numLt = r.ue('num_long_term_ref_pics_sps');
        info.numLongTermRefPicsSps = numLt;
        var ltCnt = Math.min(numLt, Math.floor(r.bitsLeft() / (info.log2MaxPocLsb + 1)) + 1, 32);
        if (ltCnt !== numLt) r.note('long-term count clamped to ' + ltCnt);
        for (var l = 0; l < ltCnt; l++) {
          r.uv('lt_ref_pic_poc_lsb_sps[' + l + ']', info.log2MaxPocLsb,
               'u(v), v = log2_max_pic_order_cnt_lsb_minus4 + 4 = ' + info.log2MaxPocLsb);
          r.flag('used_by_curr_pic_lt_sps_flag[' + l + ']');
        }
        r.endBlock();
      }
      info.temporalMvpEnabled = r.flag('sps_temporal_mvp_enabled_flag');
      info.strongIntraSmoothing = r.flag('strong_intra_smoothing_enabled_flag');
      info.vuiPresent = r.flag('vui_parameters_present_flag');
      if (info.vuiPresent) {
        r.cond('vui_parameters_present_flag');
        vuiParameters(r, info, maxSub);
        r.endBlock();
      }

      // Optional extension tail (only present when more RBSP data follows).
      if (r.bitsLeft() > 8) {
        r.depth++;
        r.group('sps extension tail (more_rbsp_data())');
        var ext = r.flag('sps_extension_present_flag');
        info.extensionPresent = ext;
        if (ext) {
          r.cond('sps_extension_present_flag');
          var rangeExt = r.flag('sps_range_extension_flag');
          var multiExt = r.flag('sps_multilayer_extension_flag');
          var ext3d = r.flag('sps_3d_extension_flag');
          var sccExt = r.flag('sps_scc_extension_flag');
          r.u('sps_extension_4bits', 4);
          if (rangeExt || multiExt || ext3d || sccExt) {
            r.note('SPS extensions present (' +
                   [rangeExt ? 'range' : null, multiExt ? 'multilayer' : null,
                    ext3d ? '3d' : null, sccExt ? 'scc' : null].filter(Boolean).join(', ') +
                   ') — extension bodies are not parsed');
          }
          r.endBlock();
        }
        r.depth--;
      }
      r.trailing('rbsp_trailing_bits()');
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * pps_pic_parameter_set_rbsp()  —  H.265 §7.3.2.3
   * ====================================================================*/

  function parsePPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      info.ppsId = r.ue('pps_pic_parameter_set_id');
      info.spsId = r.ue('pps_seq_parameter_set_id');
      info.dependentSliceSegmentsEnabled = r.flag('dependent_slice_segments_enabled_flag');
      info.outputFlagPresent = r.flag('output_flag_present_flag');
      info.numExtraSliceHeaderBits = r.u('num_extra_slice_header_bits', 3);
      info.signDataHidingEnabled = r.flag('sign_data_hiding_enabled_flag');
      info.cabacInitPresent = r.flag('cabac_init_present_flag');
      info.numRefIdxL0DefaultActive = r.ue('num_ref_idx_l0_default_active_minus1') + 1;
      info.numRefIdxL1DefaultActive = r.ue('num_ref_idx_l1_default_active_minus1') + 1;
      r.note(info.numRefIdxL0DefaultActive + ' L0 / ' + info.numRefIdxL1DefaultActive + ' L1 default refs');
      info.initQpMinus26 = r.se('init_qp_minus26');
      r.note('picture init QP = ' + (26 + info.initQpMinus26));
      info.constrainedIntraPred = r.flag('constrained_intra_pred_flag');
      info.transformSkipEnabled = r.flag('transform_skip_enabled_flag');
      info.cuQpDeltaEnabled = r.flag('cu_qp_delta_enabled_flag');
      if (info.cuQpDeltaEnabled) {
        r.cond('cu_qp_delta_enabled_flag');
        info.diffCuQpDeltaDepth = r.ue('diff_cu_qp_delta_depth');
        r.endBlock();
      }
      info.ppsCbQpOffset = r.se('pps_cb_qp_offset');
      info.ppsCrQpOffset = r.se('pps_cr_qp_offset');
      r.note('Cb ' + info.ppsCbQpOffset + ' / Cr ' + info.ppsCrQpOffset);
      info.ppsSliceChromaQpOffsetsPresent = r.flag('pps_slice_chroma_qp_offsets_present_flag');
      info.weightedPredFlag = r.flag('weighted_pred_flag');
      info.weightedBipredFlag = r.flag('weighted_bipred_flag');
      info.transquantBypassEnabled = r.flag('transquant_bypass_enabled_flag');
      info.tilesEnabled = r.flag('tiles_enabled_flag');
      info.entropyCodingSyncEnabled = r.flag('entropy_coding_sync_enabled_flag');
      if (info.tilesEnabled) {
        r.cond('tiles_enabled_flag');
        var cols = r.ue('num_tile_columns_minus1') + 1;
        var rows = r.ue('num_tile_rows_minus1') + 1;
        info.numTileColumns = cols;
        info.numTileRows = rows;
        r.note(cols + ' columns x ' + rows + ' rows of tiles');
        var uniform = r.flag('uniform_spacing_flag');
        info.uniformSpacing = !!uniform;
        if (!uniform) {
          r.cond('!uniform_spacing_flag');
          var cc = Math.min(cols - 1, Math.floor(r.bitsLeft() / 8) + 1, 64);
          for (var c = 0; c < cc; c++) r.ue('column_width_minus1[' + c + ']');
          var rc = Math.min(rows - 1, Math.floor(r.bitsLeft() / 8) + 1, 64);
          for (var w = 0; w < rc; w++) r.ue('row_height_minus1[' + w + ']');
          r.endBlock();
        }
        r.flag('loop_filter_across_tiles_enabled_flag');
        r.endBlock();
      }
      info.ppsLoopFilterAcrossSlicesEnabled = r.flag('pps_loop_filter_across_slices_enabled_flag');
      info.deblockingFilterControlPresent = r.flag('deblocking_filter_control_present_flag');
      if (info.deblockingFilterControlPresent) {
        r.cond('deblocking_filter_control_present_flag');
        info.deblockingFilterOverrideEnabled = r.flag('deblocking_filter_override_enabled_flag');
        info.ppsDeblockingFilterDisabled = r.flag('pps_deblocking_filter_disabled_flag');
        if (!info.ppsDeblockingFilterDisabled) {
          r.cond('!pps_deblocking_filter_disabled_flag');
          info.ppsBetaOffsetDiv2 = r.se('pps_beta_offset_div2');
          info.ppsTcOffsetDiv2 = r.se('pps_tc_offset_div2');
          r.note('beta ' + info.ppsBetaOffsetDiv2 + ', tc ' + info.ppsTcOffsetDiv2);
          r.endBlock();
        } else {
          r.note('deblocking disabled unless a slice overrides it');
        }
        r.endBlock();
      }
      if (r.flag('pps_scaling_list_data_present_flag')) {
        r.cond('pps_scaling_list_data_present_flag');
        scalingListData(r);
        r.endBlock();
      }
      info.listsModificationPresent = r.flag('lists_modification_present_flag');
      info.log2ParallelMergeLevel = r.ue('log2_parallel_merge_level_minus2') + 2;
      info.sliceSegmentHeaderExtensionPresent = r.flag('slice_segment_header_extension_present_flag');

      if (r.bitsLeft() > 8) {
        r.depth++;
        r.group('pps extension tail (more_rbsp_data())');
        var ext = r.flag('pps_extension_present_flag');
        info.extensionPresent = ext;
        if (ext) {
          r.cond('pps_extension_present_flag');
          var rangeExt = r.flag('pps_range_extension_flag');
          var multiExt = r.flag('pps_multilayer_extension_flag');
          var ext3d = r.flag('pps_3d_extension_flag');
          var sccExt = r.flag('pps_scc_extension_flag');
          r.u('pps_extension_4bits', 4);
          if (rangeExt || multiExt || ext3d || sccExt) {
            r.note('PPS extensions present (' +
                   [rangeExt ? 'range' : null, multiExt ? 'multilayer' : null,
                    ext3d ? '3d' : null, sccExt ? 'scc' : null].filter(Boolean).join(', ') +
                   ') — extension bodies are not parsed');
          }
          r.endBlock();
        }
        r.depth--;
      }
      r.trailing('rbsp_trailing_bits()');
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * slice_segment_header()  —  H.265 §7.3.6.1
   * ====================================================================*/

  /** ref_pic_lists_modification() — §7.3.6.2 */
  function refPicListsModification(r, info, numPicTotalCurr) {
    r.depth++;
    r.group('ref_pic_lists_modification()');
    var bits = 1;
    while ((1 << bits) < Math.max(numPicTotalCurr, 2)) bits++;
    bits = Math.min(bits, 15);
    r.note('list_entry width assumes NumPicTotalCurr = ' + numPicTotalCurr);
    var l0 = r.flag('ref_pic_list_modification_flag_l0');
    info.refPicListModL0 = l0;
    if (l0) {
      r.cond('ref_pic_list_modification_flag_l0');
      var n0 = Math.min((info.numRefIdxL0Active || 1), 32);
      for (var i = 0; i < n0; i++) {
        r.uv('list_entry_l0[' + i + ']', bits,
             'u(v), v = Ceil(Log2(NumPicTotalCurr)) = ' + bits);
      }
      r.endBlock();
    }
    if (info.sliceType === 'B') {
      r.cond('slice_type == B');
      var l1 = r.flag('ref_pic_list_modification_flag_l1');
      info.refPicListModL1 = l1;
      if (l1) {
        r.cond('ref_pic_list_modification_flag_l1');
        var n1 = Math.min((info.numRefIdxL1Active || 1), 32);
        for (var j = 0; j < n1; j++) {
          r.uv('list_entry_l1[' + j + ']', bits,
               'u(v), v = Ceil(Log2(NumPicTotalCurr)) = ' + bits);
        }
        r.endBlock();
      }
      r.endBlock();
    }
    r.depth--;
  }

  /** pred_weight_table() — §7.3.6.3 */
  function predWeightTable(r, info, sps) {
    r.depth++;
    r.group('pred_weight_table()');
    r.ue('luma_log2_weight_denom');
    var chroma = chromaArrayType(sps) !== 0;
    if (chroma) {
      r.cond('ChromaArrayType != 0');
      r.se('delta_chroma_log2_weight_denom');
      r.endBlock();
    }
    var lists = info.sliceType === 'B' ? 2 : 1;
    var i, l;
    for (l = 0; l < lists; l++) {
      var n = Math.min((l === 0 ? info.numRefIdxL0Active : info.numRefIdxL1Active) || 1, 16);
      var lumaFlag = [], chromaFlag = [];
      for (i = 0; i < n; i++) lumaFlag[i] = r.flag('luma_weight_l' + l + '_flag[' + i + ']');
      if (chroma) for (i = 0; i < n; i++) chromaFlag[i] = r.flag('chroma_weight_l' + l + '_flag[' + i + ']');
      for (i = 0; i < n; i++) {
        if (lumaFlag[i]) {
          r.cond('luma_weight_l' + l + '_flag[ ' + i + ' ]');
          r.se('delta_luma_weight_l' + l + '[' + i + ']');
          r.se('luma_offset_l' + l + '[' + i + ']');
          r.endBlock();
        }
        if (chroma && chromaFlag[i]) {
          r.cond('chroma_weight_l' + l + '_flag[ ' + i + ' ]');
          for (var j = 0; j < 2; j++) {
            r.se('delta_chroma_weight_l' + l + '[' + i + '][' + j + ']');
            r.se('delta_chroma_offset_l' + l + '[' + i + '][' + j + ']');
          }
          r.endBlock();
        }
      }
      if (n < ((l === 0 ? info.numRefIdxL0Active : info.numRefIdxL1Active) || 1)) {
        r.group('… remaining L' + l + ' weights omitted');
      }
    }
    r.depth--;
  }

  /**
   * @param {Uint8Array} rbsp  payload after the 2-byte NAL header
   * @param {object} nal       { type, layerId, tid }
   * @param {object} sps / pps active parameter sets (from the context)
   */
  function parseSliceSegmentHeader(rbsp, nal, sps, pps, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = { nalType: nal.type, sliceType: '?' };
    var ir = isIRAP(nal.type);
    var idr = isIDR(nal.type);
    sps = sps || {};
    pps = pps || {};
    try {
      info.firstSliceSegmentInPic = r.flag('first_slice_segment_in_pic_flag');
      if (ir) {
        r.cond('IRAP picture (nal_unit_type 16..23)');
        r.flag('no_output_of_prior_pics_flag');
        r.endBlock();
      }
      info.ppsId = r.ue('slice_pic_parameter_set_id');
      var dependent = false;
      if (!info.firstSliceSegmentInPic) {
        r.cond('!first_slice_segment_in_pic_flag');
        if (pps.dependentSliceSegmentsEnabled) {
          r.cond('dependent_slice_segments_enabled_flag');
          dependent = r.flag('dependent_slice_segment_flag');
          r.endBlock();
        }
        // slice_segment_address has Ceil(Log2(PicSizeInCtbsY)) bits.
        var ctb = sps.ctbSize || 64;
        var ctbsY = Math.max(1,
          Math.ceil((sps.codedWidth || sps.width || ctb) / ctb) *
          Math.ceil((sps.codedHeight || sps.height || ctb) / ctb));
        var addrBits = Math.max(1, Math.ceil(Math.log(ctbsY) / Math.LN2));
        info.sliceSegmentAddress = r.uv('slice_segment_address', addrBits,
          'u(v), v = Ceil(Log2(PicSizeInCtbsY = ' + ctbsY + ')) = ' + addrBits);
        r.endBlock();
      }
      if (!dependent) {
        r.cond('!dependent_slice_segment_flag');
        var extra = Math.min(pps.numExtraSliceHeaderBits || 0, 8);
        for (var e = 0; e < extra; e++) r.flag('slice_reserved_flag[' + e + ']');
        var st = r.ue('slice_type');
        info.sliceTypeIdx = st;
        info.sliceType = SLICE_TYPES[st] || '?';
        r.note(info.sliceType + ' slice');
        if (pps.outputFlagPresent) {
          r.cond('output_flag_present_flag');
          info.picOutputFlag = r.flag('pic_output_flag');
          r.endBlock();
        }
        if (sps.separateColourPlaneFlag) {
          r.cond('separate_colour_plane_flag');
          var cp = r.u('colour_plane_id', 2);
          r.note(['Y', 'Cb', 'Cr', 'reserved'][cp]);
          r.endBlock();
        }
        if (!idr) {
          r.cond('!IDR picture');
          var pocBits = sps.log2MaxPocLsb || 8;
          info.picOrderCntLsb = r.uv('slice_pic_order_cnt_lsb', pocBits,
            'u(v), v = log2_max_pic_order_cnt_lsb_minus4 + 4 = ' + pocBits);
          var nSets = sps.numShortTermRefPicSets || 0;
          if (nSets > 0) {
            r.cond('num_short_term_ref_pic_sets > 0');
            var fromSps = r.flag('short_term_ref_pic_set_sps_flag');
            if (!fromSps) {
              r.cond('!short_term_ref_pic_set_sps_flag');
              info.stRpsIdx = nSets;
              stRefPicSet(r, nSets, nSets, sps.deltaPocs);
              r.endBlock();
            } else if (nSets > 1) {
              r.cond('short_term_ref_pic_set_sps_flag && num_short_term_ref_pic_sets > 1');
              var idxBits = Math.max(1, Math.ceil(Math.log(nSets) / Math.LN2));
              info.stRpsIdx = r.uv('short_term_ref_pic_set_idx', idxBits,
                'u(v), v = Ceil(Log2(num_short_term_ref_pic_sets = ' + nSets + ')) = ' + idxBits);
              r.endBlock();
            }
            r.endBlock();
          }
          if (sps.longTermRefPicsPresent) {
            r.cond('long_term_ref_pics_present_flag');
            var nSpsLt = sps.numLongTermRefPicsSps || 0;
            var numLtSps = 0;
            if (nSpsLt > 0) numLtSps = r.ue('num_long_term_sps');
            var numLtPics = r.ue('num_long_term_pics');
            info.numLongTermSps = numLtSps;
            info.numLongTermPics = numLtPics;
            var totalLt = Math.min(numLtSps + numLtPics, 64);
            if (numLtSps + numLtPics > totalLt) r.note('long-term entries clamped to ' + totalLt);
            var idxBitsLt = Math.max(1, Math.ceil(Math.log(Math.max(nSpsLt, 2)) / Math.LN2));
            info.usedByCurrLt = 0;
            for (var k = 0; k < totalLt; k++) {
              if (k < numLtSps) {
                if (nSpsLt > 1) {
                  r.uv('lt_idx_sps[' + k + ']', idxBitsLt,
                       'u(v), v = Ceil(Log2(num_long_term_ref_pics_sps)) = ' + idxBitsLt);
                }
              } else {
                r.uv('poc_lsb_lt[' + k + ']', pocBits, 'u(v), v = ' + pocBits);
                if (r.flag('used_by_curr_pic_lt_flag[' + k + ']')) info.usedByCurrLt++;
              }
              if (r.flag('delta_poc_msb_present_flag[' + k + ']')) {
                r.cond('delta_poc_msb_present_flag[ ' + k + ' ]');
                r.ue('delta_poc_msb_cycle_lt[' + k + ']');
                r.endBlock();
              }
            }
            r.endBlock();
          }
          if (sps.temporalMvpEnabled) {
            r.cond('sps_temporal_mvp_enabled_flag');
            info.temporalMvp = r.flag('slice_temporal_mvp_enabled_flag');
            r.endBlock();
          }
          r.endBlock();
        }
        if (sps.saoEnabled) {
          r.cond('sample_adaptive_offset_enabled_flag');
          info.saoLuma = r.flag('slice_sao_luma_flag');
          if (chromaArrayType(sps) !== 0) info.saoChroma = r.flag('slice_sao_chroma_flag');
          r.endBlock();
        }
        if (info.sliceType === 'P' || info.sliceType === 'B') {
          r.cond('slice_type == P || slice_type == B');
          var override = r.flag('num_ref_idx_active_override_flag');
          if (override) {
            r.cond('num_ref_idx_active_override_flag');
            info.numRefIdxL0Active = r.ue('num_ref_idx_l0_active_minus1') + 1;
            if (info.sliceType === 'B') info.numRefIdxL1Active = r.ue('num_ref_idx_l1_active_minus1') + 1;
            r.endBlock();
          } else {
            info.numRefIdxL0Active = pps.numRefIdxL0DefaultActive || 1;
            info.numRefIdxL1Active = pps.numRefIdxL1DefaultActive || 1;
          }
          r.note('L0 ' + info.numRefIdxL0Active +
                 (info.sliceType === 'B' ? ' / L1 ' + info.numRefIdxL1Active : '') + ' active refs');
          if (pps.listsModificationPresent) {
            // NumPicTotalCurr needs a full RPS derivation; the parsed RPS gives
            // a usable estimate that is reported in the rows.
            r.cond('lists_modification_present_flag');
            var est = (info.usedByCurrLt || 0) + 1;
            refPicListsModification(r, info, est);
            r.endBlock();
          }
          if (info.sliceType === 'B') {
            r.cond('slice_type == B');
            info.mvdL1Zero = r.flag('mvd_l1_zero_flag');
            r.endBlock();
          }
          if (pps.cabacInitPresent) {
            r.cond('cabac_init_present_flag');
            info.cabacInit = r.flag('cabac_init_flag');
            r.endBlock();
          }
          if (info.temporalMvp) {
            r.cond('slice_temporal_mvp_enabled_flag');
            var colFromL0 = info.sliceType === 'B' ? r.flag('collocated_from_l0_flag') : 1;
            r.note(colFromL0 ? 'collocated picture comes from L0' : 'collocated picture comes from L1');
            if ((colFromL0 && (info.numRefIdxL0Active || 1) > 1) ||
                (!colFromL0 && (info.numRefIdxL1Active || 1) > 1)) {
              r.cond('collocated ref list has more than one entry');
              r.ue('collocated_ref_idx');
              r.endBlock();
            }
            r.endBlock();
          }
          if ((pps.weightedPredFlag && info.sliceType === 'P') ||
              (pps.weightedBipredFlag && info.sliceType === 'B')) {
            r.cond('( weighted_pred_flag && slice_type == P ) || ( weighted_bipred_flag && slice_type == B )');
            predWeightTable(r, info, sps);
            r.endBlock();
          }
          var five = r.ue('five_minus_max_num_merge_cand');
          info.maxNumMergeCand = 5 - five;
          r.note('MaxNumMergeCand = ' + info.maxNumMergeCand);
          r.endBlock();
        }
        info.sliceQpDelta = r.se('slice_qp_delta');
        r.note('SliceQpY = ' + (26 + (pps.initQpMinus26 || 0) + info.sliceQpDelta));
        if (pps.ppsSliceChromaQpOffsetsPresent) {
          r.cond('pps_slice_chroma_qp_offsets_present_flag');
          info.sliceCbQpOffset = r.se('slice_cb_qp_offset');
          info.sliceCrQpOffset = r.se('slice_cr_qp_offset');
          r.endBlock();
        }
        if (pps.deblockingFilterOverrideEnabled) {
          r.cond('deblocking_filter_override_enabled_flag');
          info.deblockingOverride = r.flag('slice_deblocking_filter_override_flag');
          r.endBlock();
        }
        if (info.deblockingOverride) {
          r.cond('slice_deblocking_filter_override_flag');
          info.deblockingDisabled = r.flag('slice_deblocking_filter_disabled_flag');
          if (!info.deblockingDisabled) {
            r.cond('!slice_deblocking_filter_disabled_flag');
            info.betaOffsetDiv2 = r.se('slice_beta_offset_div2');
            info.tcOffsetDiv2 = r.se('slice_tc_offset_div2');
            r.note('beta ' + info.betaOffsetDiv2 + ', tc ' + info.tcOffsetDiv2);
            r.endBlock();
          }
          r.endBlock();
        } else {
          info.deblockingDisabled = pps.ppsDeblockingFilterDisabled;
          info.betaOffsetDiv2 = pps.ppsBetaOffsetDiv2;
          info.tcOffsetDiv2 = pps.ppsTcOffsetDiv2;
          r.note('from PPS (no slice override)');
        }
        if (pps.ppsLoopFilterAcrossSlicesEnabled &&
            (info.saoLuma || info.saoChroma || !info.deblockingDisabled)) {
          r.cond('pps_loop_filter_across_slices_enabled_flag && ( sao || deblocking enabled )');
          r.flag('slice_loop_filter_across_slices_enabled_flag');
          r.endBlock();
        }
        r.endBlock();
      }
      if (pps.tilesEnabled || pps.entropyCodingSyncEnabled) {
        r.cond('tiles_enabled_flag || entropy_coding_sync_enabled_flag');
        var nEpo = r.ue('num_entry_point_offsets');
        info.numEntryPointOffsets = nEpo;
        if (nEpo > 0) {
          r.cond('num_entry_point_offsets > 0');
          var offLen = r.ue('offset_len_minus1') + 1;
          info.offsetLenMinus1 = offLen - 1;
          var cap = Math.min(nEpo, Math.max(1, Math.floor(r.bitsLeft() / offLen)), 1024);
          for (var p = 0; p < cap; p++) {
            r.uv('entry_point_offset_minus1[' + p + ']', offLen, 'u(v), v = offset_len_minus1 + 1');
          }
          if (cap < nEpo) r.group('… ' + (nEpo - cap) + ' more entry point offsets omitted');
          r.endBlock();
        }
        r.endBlock();
      }
      if (pps.sliceSegmentHeaderExtensionPresent) {
        r.cond('slice_segment_header_extension_present_flag');
        var len = r.ue('slice_segment_header_extension_length');
        var cap2 = Math.min(len, Math.floor(r.bitsLeft() / 8), 512);
        for (var b = 0; b < cap2; b++) r.u('slice_segment_header_extension_data_byte[' + b + ']', 8);
        if (cap2 < len) r.group('… ' + (len - cap2) + ' more extension bytes omitted');
        r.endBlock();
      }
      r.trailing('byte_alignment() // slice_segment_data() follows');
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * sei_rbsp() — H.265 Annex D
   * ====================================================================*/

  function parseSEI(rbsp, base) {
    var tables = [];
    var info = {};
    try {
      // SEI is a run of {payloadType, payloadSize, payload} triples; both
      // lengths are 0xFF-continued varints.
      var p = 0, guard = 0;
      while (p < rbsp.length - 1 && guard++ < 64) {
        var typeStart = p;
        var payloadType = 0;
        while (p < rbsp.length && rbsp[p] === 0xff) { payloadType += 255; p++; }
        if (p >= rbsp.length) break;
        payloadType += rbsp[p++];
        var payloadSize = 0;
        while (p < rbsp.length && rbsp[p] === 0xff) { payloadSize += 255; p++; }
        if (p >= rbsp.length) break;
        payloadSize += rbsp[p++];
        var payloadStart = p;
        if (payloadStart + payloadSize > rbsp.length) {
          payloadSize = rbsp.length - payloadStart;
        }

        var sub = new SR(rbsp.subarray(typeStart, Math.min(rbsp.length, payloadStart + payloadSize)),
                         { base: (base || 0) + typeStart, epb: false });
        sub.u('payload_type', 8);
        sub.u('payload_size', 8);
        var rows = sub.rows;
        rows[0].value = payloadType;
        rows[0].syntax = payloadType >= 255 ? 'u(8)*' : 'u(8)';
        rows[0].note = seiName(payloadType);
        rows[1].value = payloadSize;
        rows[1].syntax = payloadSize >= 255 ? 'u(8)*' : 'u(8)';

        var extra = decodeSEIPayload(rbsp, payloadStart, payloadSize, payloadType, base);
        if (extra.rows.length) rows = rows.concat(extra.rows);
        var xInfo = extra.info || {};
        var xHdr = xInfo.hdr;
        delete xInfo.hdr;
        Object.assign(info, xInfo);
        if (xHdr) info.hdr = MA.hdrSEI.merge(info.hdr, xHdr);

        tables.push(synSection('sei_message(' + (tables.length) + ')',
          'payloadType = ' + payloadType + ' (' + seiName(payloadType) + '), ' +
          payloadSize + ' bytes', rows));
        p = payloadStart + payloadSize;
      }
    } catch (e) { /* keep whatever was decoded */ }
    return { tables: tables, info: info };
  }

  /** Structured decode for the SEI payload types that carry real information. */
  function decodeSEIPayload(data, start, size, type, base) {
    var rows = [], info = {};
    try {
      var r;
      if (type === 5) {                                   // user_data_unregistered
        var uuid = new MA.ByteReader(data).guid(start);
        rows.push(synRow('uuid_iso_iec_11578', 'u(128)', 128, uuid,
                         'unregistered user data identifier', (base || 0) + start));
        var text = '';
        for (var i = 16; i < size; i++) {
          var c = data[start + i];
          text += (c >= 32 && c < 127) ? String.fromCharCode(c) : (c === 0 ? '' : '.');
        }
        rows.push(synRow('user_data_payload_byte[]', '', (size - 16) * 8, text.slice(0, 200), '',
                         (base || 0) + start + 16));
        info.userData = text;
      } else if (type === 6) {                            // recovery_point
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        var cnt = r.ue('recovery_poc_cnt');
        r.flag('exact_match_flag');
        r.flag('broken_link_flag');
        rows = r.rows;
        info.recoveryPocCnt = cnt;
      } else if (type === 1) {                            // pic_timing
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        // The cpb/dpb delay fields only exist when HRD parameters are active;
        // without them (the common case) H.265 codes pic_struct first.
        if (size * 8 >= 7) {
          var ps = r.u('pic_struct', 4);
          r.note(PIC_STRUCT[ps] || 'reserved');
          var sst = r.u('source_scan_type', 2);
          r.note(SCAN_TYPE[sst] || 'reserved');
          r.flag('duplicate_flag');
          info.picStruct = ps;
        } else {
          rows = [synRow('pic_timing()', 'u(v)', size * 8, size + ' bytes',
                         'shorter than pic_struct — HRD fields absent', (base || 0) + start)];
        }
        rows = r.rows.length ? r.rows : rows;
        info.hasPicTiming = true;
      } else if (type === 137 || type === 144 || type === 147 ||
                 type === 148 || type === 149 || type === 4) {
        // HDR payloads: ST 2086 MDCV, CLLI, alt transfer, ambient, CCV and
        // the T.35 carrier (ST 2094-10/40, SL-HDR, HDR Vivid) — shared code.
        var hh = MA.hdrSEI.decodePayload(type, data, start, size, base || 0);
        rows = hh.rows;
        if (hh.hdr && Object.keys(hh.hdr).length) info.hdr = hh.hdr;
        if (hh.hdr && hh.hdr.mastering) {
          info.masteringLuminance = { max: hh.hdr.mastering.maxLum, min: hh.hdr.mastering.minLum };
        }
      } else if (type === 45) {                           // frame_packing_arrangement
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        r.ue('frame_packing_arrangement_id');
        if (!r.flag('frame_packing_arrangement_cancel_flag')) {
          var fpt = r.u('frame_packing_arrangement_type', 3);
          r.note(FP_TYPE[fpt] || 'reserved');
          var q = r.flag('quincunx_sampling_flag');
          r.note(q ? 'quincunx sampling' : '');
          var cit = r.u('content_interpretation_type', 6);
          r.note(cit === 0 ? 'unspecified' : cit === 1 ? 'stereo, left first' :
                 cit === 2 ? 'stereo, right first' : 'reserved');
          r.u('frame0_grid_position_x', 2);
          r.u('frame0_grid_position_y', 2);
          r.u('frame1_grid_position_x', 2);
          r.u('frame1_grid_position_y', 2);
          r.u('frame_packing_arrangement_reserved_byte', 8);
          r.ue('frame_packing_arrangement_repetition_period');
        }
        r.flag('frame_packing_arrangement_extension_flag');
        rows = r.rows;
        info.framePacking = true;
      } else if (type === 47) {                           // display_orientation
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        if (!r.flag('display_orientation_cancel_flag')) {
          var hf = r.flag('hor_flip');
          var vf = r.flag('ver_flip');
          var rot = r.u('anticlockwise_rotation', 16);
          var deg = rot * 360 / 65536;
          r.note('rotate ' + deg.toFixed(2) + '° anticlockwise' +
                 (hf ? ', horizontally flipped' : '') + (vf ? ', vertically flipped' : ''));
          r.ue('display_orientation_repetition_period');
        }
        r.flag('display_orientation_extension_flag');
        rows = r.rows;
      } else if (type === 129) {                          // active_parameter_sets
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        var numSps = r.ue('num_sps_ids_minus1');
        r.note((numSps + 1) + ' active SPS');
        var ns = Math.min(numSps + 1, Math.floor(r.bitsLeft() / 8) + 1, 64);
        for (var s = 0; s < ns; s++) r.ue('active_seq_parameter_set_id[' + s + ']');
        rows = r.rows;
        // The following layer_sps_idx[] loop needs vps_max_layer_id from the VPS.
        rows.push(synRow('layer_sps_idx[]', 'ue(v)', 0, '—',
                         'present only when the active VPS defines layers', (base || 0) + start));
      } else if (type === 132) {                          // decoded_picture_hash
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        var ht = r.u('hash_type', 8);
        r.note(HASH_TYPE[ht] || 'reserved');
        var bytes = ht === 0 ? 16 : ht === 1 ? 2 : 4;
        var comps = (size - 1) / bytes;
        r.note(comps + ' component hash' + (comps === 1 ? '' : 'es') + ', ' + bytes + ' bytes each');
        rows = r.rows;
        for (var ci = 0; ci < Math.min(comps, 3); ci++) {
          var hex = '';
          for (var b = 0; b < bytes; b++) {
            var v = data[start + 1 + ci * bytes + b];
            hex += (v < 16 ? '0' : '') + v.toString(16);
          }
          rows.push(synRow('picture_hash[' + ci + ']', 'u(' + (bytes * 8) + ')', bytes * 8,
                           hex.toUpperCase(), decodeHashName(ci, comps), (base || 0) + start + 1 + ci * bytes));
        }
      } else if (type === 133) {                          // scalable_nesting
        r = new SR(data, { offset: start, length: size, base: base || 0, epb: false });
        var sn = r.flag('scalable_nesting_extension_flag');
        r.note(sn ? 'extension reserved' : '');
        var sop = r.flag('sn_sub_pic_flag');
        r.note(sop ? 'applies to a sub-picture' : 'applies to a picture');
        var all = r.flag('sn_all_layers_flag');
        var bits = 1;
        if (!all) {
          var maxL = r.ue('sn_max_layer_id');
          bits = Math.max(1, Math.ceil(Math.log(Math.max(maxL, 2)) / Math.LN2));
          r.note('max layer id ' + maxL);
        }
        r.note(all ? 'all layers' : 'per-layer flags');
        rows = r.rows;
        if (!all) {
          rows.push(synRow('sn_layer_id[]', 'u(' + bits + ')', 0, '…',
                           'one layer_id per nested SEI message', (base || 0) + start));
        }
      }
    } catch (e) { /* payload shorter than the structure it declares */ }
    return { rows: rows, info: info };
  }

  function decodeHashName(ci, comps) {
    if (comps === 1) return 'whole picture';
    return ['luma (Y)', 'chroma (Cb)', 'chroma (Cr)'][ci] || ('component ' + ci);
  }

  /* ======================================================================
   * NAL unit dispatch
   * ====================================================================*/

  /** nal_unit_header() — H.265 §7.3.1.2 (2 bytes). */
  function nalHeaderRows(data, off, type, layerId, tidPlus1) {
    var b0 = data[off], b1 = data[off + 1];
    return [
      synRow('forbidden_zero_bit', 'f(1)', 1, (b0 >> 7) & 1, 'shall be 0', off),
      synRow('nal_unit_type', 'u(6)', 6, type, nalTypeName(type), off),
      synRow('nuh_layer_id', 'u(6)', 6, layerId,
             layerId === 0 ? 'base layer' : 'layer ' + layerId, off),
      synRow('nuh_temporal_id_plus1', 'u(3)', 3, tidPlus1,
             'TemporalId = ' + (tidPlus1 - 1) + (tidPlus1 === 0 ? ' (invalid, shall be > 0)' : ''),
             off + 1)
    ];
  }

  /**
   * Parse one Annex-B style NAL unit.
   * @param {Uint8Array} data full buffer
   * @param {number} off   offset of the first NAL header byte
   * @param {number} end   offset one past the last payload byte
   * @param {object} ctx   { sps, pps } active parameter sets (optional)
   */
  function parseNAL(data, off, end, ctx) {
    ctx = ctx || {};
    if (off + 1 >= end) return { type: -1, tables: [], info: {} };
    var b0 = data[off], b1 = data[off + 1];
    var type = (b0 >> 1) & 0x3f;
    var layerId = ((b0 & 1) << 5) | (b1 >> 3);
    var tidPlus1 = b1 & 7;
    var rbsp = unescapeRbsp(data, off + 2, end);
    var base = off + 2;
    var rows = nalHeaderRows(data, off, type, layerId, tidPlus1);
    var tables = [];
    var info = { type: type, layerId: layerId, temporalId: tidPlus1 - 1, name: nalTypeName(type) };

    if (type === 32) {
      var vps = parseVPS(rbsp, base);
      info.kind = 'vps';
      Object.assign(info, vps.info);
      tables.push(synSection('vps_video_parameter_set_rbsp()',
        'NAL unit type 32 — Video Parameter Set', rows.concat(vps.rows)));
    } else if (type === 33) {
      var sps = parseSPS(rbsp, base);
      info.kind = 'sps';
      Object.assign(info, sps.info);
      tables.push(synSection('sps_seq_parameter_set_rbsp()',
        'NAL unit type 33 — Sequence Parameter Set', rows.concat(sps.rows)));
    } else if (type === 34) {
      var pps = parsePPS(rbsp, base);
      info.kind = 'pps';
      Object.assign(info, pps.info);
      tables.push(synSection('pps_pic_parameter_set_rbsp()',
        'NAL unit type 34 — Picture Parameter Set', rows.concat(pps.rows)));
    } else if (isVCL(type)) {
      var sl = parseSliceSegmentHeader(rbsp, { type: type, layerId: layerId, tid: tidPlus1 - 1 },
                                       ctx.sps, ctx.pps, base);
      info.kind = 'slice';
      Object.assign(info, sl.info);
      tables.push(synSection('slice_segment_header()',
        nalTypeName(type) + (sl.info.sliceType ? ', ' + sl.info.sliceType + ' slice' : '') +
        ', ' + (end - off) + ' bytes', rows.concat(sl.rows)));
    } else if (type === 39 || type === 40) {
      var sei = parseSEI(rbsp, base);
      info.kind = 'sei';
      Object.assign(info, sei.info);
      tables.push(synSection('sei_rbsp()',
        'NAL unit type ' + type + ' — ' + nalTypeName(type), rows));
      tables = tables.concat(sei.tables);
    } else if (type === 35) {
      var ra = new SR(rbsp, { base: base });
      var pt = ra.u('pic_type', 3);
      ra.note(['I only', 'I, P', 'I, P, B'][pt] || 'reserved');
      ra.trailing('rbsp_trailing_bits()');
      info.kind = 'aud';
      tables.push(synSection('access_unit_delimiter_rbsp()',
        'NAL unit type 35 — picture boundary', rows.concat(ra.rows)));
    } else if (type === 36 || type === 37) {
      var re = new SR(rbsp, { base: base });
      re.trailing('rbsp_trailing_bits()');
      info.kind = type === 36 ? 'eos' : 'eob';
      tables.push(synSection(type === 36 ? 'end_of_seq_rbsp()' : 'end_of_bitstream_rbsp()',
        'NAL unit type ' + type + ' — ' + nalTypeName(type), rows.concat(re.rows)));
    } else if (type === 38) {
      info.kind = 'filler';
      tables.push(synSection('filler_data_rbsp()',
        'NAL unit type 38 — ' + rbsp.length + ' filler bytes', rows));
    } else {
      info.kind = 'other';
      tables.push(synSection('nal_unit(' + type + ')',
        nalTypeName(type) + ', ' + (end - off) + ' bytes', rows));
    }
    return { type: type, layerId: layerId, temporalId: tidPlus1 - 1,
             name: nalTypeName(type), tables: tables, info: info, rows: rows };
  }

  /* ======================================================================
   * HEVCDecoderConfigurationRecord (hvcC) — ISO/IEC 14496-15 §8.3.3.1
   * ====================================================================*/

  /** Emit the individual flags packed into the 48-bit constraint field. */
  function constraintRows(r, word, idc, offset) {
    function b(i) { return bitAt(word, i, 48); }
    var rows = [];
    var names = [
      ['general_progressive_source_flag', 0, b(0) ? 'progressive source' : ''],
      ['general_interlaced_source_flag', 1, b(1) ? 'interlaced source allowed' : ''],
      ['general_non_packed_constraint_flag', 2, b(2) ? 'no frame packing' : ''],
      ['general_frame_only_constraint_flag', 3, b(3) ? 'frames only' : 'fields allowed'],
      ['general_max_12bit_constraint_flag', 4, b(4) ? '<= 12-bit samples' : ''],
      ['general_max_10bit_constraint_flag', 5, b(5) ? '<= 10-bit samples' : ''],
      ['general_max_8bit_constraint_flag', 6, b(6) ? '<= 8-bit samples' : ''],
      ['general_max_422chroma_constraint_flag', 7, b(7) ? 'no 4:2:2 or 4:4:4' : ''],
      ['general_max_420chroma_constraint_flag', 8, b(8) ? 'no chroma above 4:2:0' : ''],
      ['general_max_monochrome_constraint_flag', 9, b(9) ? 'monochrome only' : ''],
      ['general_intra_constraint_flag', 10, b(10) ? 'intra only' : ''],
      ['general_one_picture_only_constraint_flag', 11, b(11) ? 'one coded picture' : ''],
      ['general_lower_bit_rate_constraint_flag', 12, b(12) ? 'lower bit rate bound' : '']
    ];
    var i;
    for (i = 0; i < names.length; i++) {
      rows.push(synRow(names[i][0], 'u(1)', 1, names[i][1], names[i][2], offset, 1));
    }
    if (idc === 5 || idc === 9 || idc === 10 || idc === 11) {
      rows.push(synRow('general_max_14bit_constraint_flag', 'u(1)', 1, b(13),
                       b(13) ? '<= 14-bit samples' : '', offset, 1));
      rows.push(synRow('general_reserved_zero_33bits', 'u(33)', 33, 0, '', offset, 1));
    } else {
      rows.push(synRow('general_reserved_zero_34bits', 'u(34)', 34, 0, '', offset, 1));
    }
    rows.push(synRow('general_inbld_flag', 'u(1)', 1, b(47),
                     b(47) ? 'in-band parameter sets' : '', offset, 1));
    return rows;
  }

  /**
   * @param {MA.ByteReader} br reader positioned at the record start
   * @param {number} end    absolute end of the hvcC payload
   * @param {number} base   absolute file offset of the record start
   */
  function parseHVCC(br, end, base) {
    var start = br.pos;
    if (base == null) base = br.base + start;
    var r = new SR(br.u8, { offset: start, length: end - start, epb: false, base: base });
    var out = { table: null, sets: [], lengthSize: 4, info: {}, spsTables: [], ppsTables: [], vpsTables: [] };

    var version = r.u('configurationVersion', 8);
    var space = r.u('general_profile_space', 2);
    var tier = r.flag('general_tier_flag');
    r.note(tierName(tier));
    var idc = r.u('general_profile_idc', 5);
    var compat = r.u('general_profile_compatibility_flags', 32);
    r.note(compatNote(compat));
    var constOffset = r.base + Math.floor(r.bitPos() / 8);
    var cword = r.raw('general_constraint_indicator_flags', 6);
    var levelIdc = r.u('general_level_idc', 8);
    r.note('Level ' + levelName(levelIdc) + ', ' + tierName(tier));
    // Decode the 48 bits into the named flags the spec defines.
    var flags = {
      max12: bitAt(cword, 4, 48), max10: bitAt(cword, 5, 48), max8: bitAt(cword, 6, 48),
      max422: bitAt(cword, 7, 48), max420: bitAt(cword, 8, 48), mono: bitAt(cword, 9, 48),
      intra: bitAt(cword, 10, 48), onePicture: bitAt(cword, 11, 48),
      lowerBitRate: bitAt(cword, 12, 48)
    };
    var cRows = constraintRows(r, cword, idc, constOffset);
    var profile = profileNote(idc, flags);

    r.u('reserved', 4);
    var minSpatialSeg = r.u('min_spatial_segmentation_idc', 12);
    r.note(minSpatialSeg === 0 ? 'unknown' : minSpatialSeg + ' (shortest spatial segment)');
    r.u('reserved', 6);
    var parType = r.u('parallelismType', 2);
    r.note(['unknown', 'slice', 'tile', 'wavefront'][parType] || 'reserved');
    r.u('reserved', 6);
    var chromaFmt = r.u('chromaFormat', 2);
    r.note(CHROMA_FORMAT[chromaFmt] || 'reserved');
    r.u('reserved', 5);
    var bdLuma = r.u('bitDepthLumaMinus8', 3) + 8;
    r.u('reserved', 5);
    var bdChroma = r.u('bitDepthChromaMinus8', 3) + 8;
    r.note(bdLuma + '-bit luma / ' + bdChroma + '-bit chroma');
    var avgFrameRate = r.u('avgFrameRate', 16);
    r.note(avgFrameRate === 0 ? 'unspecified' : (avgFrameRate / 256).toFixed(3) + ' fps');
    var cfr = r.u('constantFrameRate', 2);
    r.note(['unknown', 'constant frame rate', 'each temporal layer is CFR'][cfr] || 'reserved');
    var numTemporalLayers = r.u('numTemporalLayers', 3);
    var temporalIdNested = r.flag('temporalIdNested');
    var lsMinus1 = r.u('lengthSizeMinusOne', 2);
    out.lengthSize = lsMinus1 + 1;
    r.note(out.lengthSize + '-byte NAL length prefix');

    var numArrays = r.u('numOfArrays', 8);
    var arrayCount = Math.min(numArrays, 64);
    if (arrayCount !== numArrays) r.note('array count clamped to ' + arrayCount);
    for (var j = 0; j < arrayCount; j++) {
      var complete = r.flag('array_completeness');
      r.note(complete ? 'all NAL units of this type are in the record' : 'parameter sets may follow in-band');
      r.u('reserved', 1);
      var nalType = r.u('NAL_unit_type', 6);
      r.note(nalTypeName(nalType));
      var numNalus = r.u('numNalus', 16);
      var nalCount = safeCount(numNalus, Math.floor((end - r.bytePos()) / 3), 3);
      nalCount = Math.min(nalCount, 64);
      for (var i = 0; i < nalCount; i++) {
        var len = r.u('nalUnitLength[' + i + ']', 16);
        var dataStart = r.bytePos();
        if (dataStart + len > end) break;
        var payload = br.u8.subarray(dataStart, dataStart + len);
        out.sets.push({ type: nalType, data: payload, offset: dataStart });
        var sub = null;
        if (nalType === 33) sub = parseSPS(unescapeRbsp(payload, 0, payload.length), dataStart);
        else if (nalType === 34) sub = parsePPS(unescapeRbsp(payload, 0, payload.length), dataStart);
        else if (nalType === 32) sub = parseVPS(unescapeRbsp(payload, 0, payload.length), dataStart);
        if (sub) {
          if (nalType === 33) {
            out.info = Object.assign(out.info, sub.info);
            out.spsTables.push(synSection('SPS[' + (out.spsTables.length) + '] sps_seq_parameter_set_rbsp()',
              'declared ' + len + ' bytes @ ' + MA.hex(dataStart, 8), sub.rows));
          } else if (nalType === 34) {
            out.ppsTables.push(synSection('PPS[' + (out.ppsTables.length) + '] pps_pic_parameter_set_rbsp()',
              'declared ' + len + ' bytes @ ' + MA.hex(dataStart, 8), sub.rows));
          } else {
            out.vpsTables.push(synSection('VPS[' + (out.vpsTables.length) + '] vps_video_parameter_set_rbsp()',
              'declared ' + len + ' bytes @ ' + MA.hex(dataStart, 8), sub.rows));
          }
        }
        r.skip(len * 8);
      }
    }

    out.table = synSection('HEVCDecoderConfigurationRecord',
      'ISO/IEC 14496-15 §8.3.3.1 — hvcC', r.rows.slice(0, r.rows.length - 1)
        .concat(cRows).concat(r.rows.slice(r.rows.length - 1)));
    // The constraint rows belong right after the 48-bit field: rebuild the row
    // list in the order the record is written.
    var head = [], tail = [], seenConstraint = false;
    for (var k = 0; k < r.rows.length; k++) {
      var row = r.rows[k];
      if (row.name === 'general_constraint_indicator_flags') {
        head.push(row);
        head = head.concat(cRows);
      } else head.push(row);
    }
    void tail; void seenConstraint;
    out.table = synSection('HEVCDecoderConfigurationRecord',
      'ISO/IEC 14496-15 §8.3.3.1 — hvcC', head);

    out.version = version;
    out.profileSpace = space;
    out.tier = tier;
    out.profileIdc = idc;
    out.profile = profile;
    out.compat = compat;
    out.constraintFlags = flags;
    out.levelIdc = levelIdc;
    out.level = levelName(levelIdc);
    out.info.profile = profile;
    out.info.level = levelName(levelIdc);
    out.info.minSpatialSegmentationIdc = minSpatialSeg;
    out.info.parallelismType = parType;
    out.info.chromaFormatIdc = chromaFmt;
    out.info.bitDepthLuma = bdLuma;
    out.info.bitDepthChroma = bdChroma;
    out.info.avgFrameRate = avgFrameRate / 256;
    out.info.constantFrameRate = cfr;
    out.info.numTemporalLayers = numTemporalLayers;
    out.info.temporalIdNested = !!temporalIdNested;
    out.info.numArrays = numArrays;
    return out;
  }

  /* ======================================================================
   * Sample / elementary stream analysis
   * ====================================================================*/

  /** Collected parameter sets for a track, so slice headers can be decoded. */
  function makeContext() {
    return { vps: null, sps: null, pps: null,
             vpsById: {}, spsById: {}, ppsById: {}, info: {} };
  }

  /** Build a context from a parsed hvcC record. */
  function ctxFromConfig(cfg) {
    var ctx = makeContext();
    if (!cfg) return ctx;
    (cfg.sets || []).forEach(function (s) {
      try {
        var raw = unescapeRbsp(s.data, 0, s.data.length);
        if (s.type === 32) {
          var v = parseVPS(raw, s.offset);
          ctx.vpsById[v.info.vpsId] = v.info;
          if (!ctx.vps) ctx.vps = v.info;
        } else if (s.type === 33) {
          var sp = parseSPS(raw, s.offset);
          ctx.spsById[sp.info.spsId] = sp.info;
          if (!ctx.sps) ctx.sps = sp.info;
        } else if (s.type === 34) {
          var p = parsePPS(raw, s.offset);
          ctx.ppsById[p.info.ppsId] = p.info;
          if (!ctx.pps) ctx.pps = p.info;
        }
      } catch (e) { /* ignore malformed set */ }
    });
    return ctx;
  }

  /**
   * Syntax tables for one compressed video sample.
   * @param {Uint8Array} payload sample bytes (length-prefixed NALs, or Annex B)
   * @param {object} spec { lengthSize, annexB, base, ctx }
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var ctx = spec.ctx || makeContext();
    var tables = [];
    var seen = {};
    var maxNals = 64;
    var ls = spec.lengthSize || 4;

    function handle(off, end, withPrefix) {
      if (tables.length > 400 || maxNals-- <= 0) return;
      var res = parseNAL(payload, off, end, ctx);
      // Parameter sets repeated in every sample would drown the panel.
      if (res.type === 32 || res.type === 33 || res.type === 34) {
        if (seen[res.type]) return;
        seen[res.type] = 1;
        if (res.type === 32) ctx.vps = res.info;
        else if (res.type === 33) ctx.sps = res.info;
        else ctx.pps = res.info;
      }
      if (withPrefix) {
        var lenRow = synRow('nalUnitLength', 'u(' + (ls * 8) + ')', ls * 8, end - off,
                            'length prefix (' + (end - off) + ' bytes)', off - ls);
        var hdr = res.tables.length && res.tables[0].rows.length ? res.tables[0].rows[0] : null;
        void hdr;
        res.tables.forEach(function (t) { t.rows = [lenRow].concat(t.rows); });
      }
      res.tables.forEach(function (t) { tables.push(t); });
    }

    if (spec.annexB) {
      var units = MA.annexBUnits(payload, payload.length);
      for (var i = 0; i < units.length; i++) handle(units[i].start, units[i].end, false);
    } else {
      // splitLengthPrefixedNals() reports the HEVC 6-bit type from the first
      // byte; the layer id / temporal id live in the remaining bits.
      var nals = MA.splitLengthPrefixedNals(payload, ls, 2, 0, payload.length);
      for (var j = 0; j < nals.length; j++) {
        if (nals[j].type < 0) continue;
        handle(nals[j].payloadOff, nals[j].payloadOff + nals[j].payloadLen, true);
      }
    }
    if (!tables.length) {
      tables.push(synSection('sample', 'No NAL unit could be extracted.', [
        synRow('length', '', payload.length * 8, payload.length + ' bytes', '', spec.base || 0)
      ]));
    }
    return tables;
  }

  /**
   * Analyse a complete raw H.265 Annex-B elementary stream (.265 / .h265).
   * @returns {{ tables, frames, track, info, ctx }}
   */
  function analyzeAnnexB(data, ctxIn) {
    var units = MA.annexBUnits(data, data.length);
    var ctx = ctxIn || makeContext();
    var tables = [];
    var frames = [];
    var info = { nalCount: units.length };
    var idrCount = 0, irapCount = 0, seiCount = 0, vclCount = 0;

    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      if (u.start + 1 >= u.end) continue;
      var b0 = data[u.start], b1 = data[u.start + 1];
      var type = (b0 >> 1) & 0x3f;
      var layerId = ((b0 & 1) << 5) | (b1 >> 3);
      var tid = (b1 & 7) - 1;

      if (type === 32) {
        var vps = parseVPS(unescapeRbsp(data, u.start + 2, u.end), u.start + 2);
        ctx.vps = vps.info;
        ctx.vpsById[vps.info.vpsId] = vps.info;
        tables.push(synSection('VPS[' + i + '] vps_video_parameter_set_rbsp()',
          'NAL unit type 32 @ ' + MA.hex(u.sc, 8), vps.rows));
      } else if (type === 33) {
        var sps = parseSPS(unescapeRbsp(data, u.start + 2, u.end), u.start + 2);
        if (sps.info) { ctx.sps = sps.info; ctx.spsById[sps.info.spsId] = sps.info; }
        tables.push(synSection('SPS[' + i + '] sps_seq_parameter_set_rbsp()',
          'NAL unit type 33 @ ' + MA.hex(u.sc, 8), sps.rows));
        Object.assign(info, {
          width: sps.info.width, height: sps.info.height,
          profile: sps.info.profile, level: sps.info.level,
          fps: sps.info.fps, chromaFormat: sps.info.chromaFormatIdc,
          bitDepthLuma: sps.info.bitDepthLuma, bitDepthChroma: sps.info.bitDepthChroma,
          colour: sps.info.colour
        });
      } else if (type === 34) {
        var pps = parsePPS(unescapeRbsp(data, u.start + 2, u.end), u.start + 2);
        if (pps.info) { ctx.pps = pps.info; ctx.ppsById[pps.info.ppsId] = pps.info; }
        tables.push(synSection('PPS[' + i + '] pps_pic_parameter_set_rbsp()',
          'NAL unit type 34 @ ' + MA.hex(u.sc, 8), pps.rows));
      } else if (isVCL(type)) {
        // Resolve the PPS the slice names before parsing it.
        var active = null;
        try {
          var probe = new MA.BitReader(unescapeRbsp(data, u.start + 2, u.end), 0, null, true);
          probe.bit();                       // first_slice_segment_in_pic_flag
          if (isIRAP(type)) probe.bit();     // no_output_of_prior_pics_flag
          active = ctx.ppsById[probe.ue()];
        } catch (e) { active = null; }
        var sl = parseSliceSegmentHeader(unescapeRbsp(data, u.start + 2, u.end),
          { type: type, layerId: layerId, tid: tid }, ctx.sps, active || ctx.pps, u.start + 2);
        vclCount++;
        if (isIDR(type)) idrCount++;
        if (isIRAP(type)) irapCount++;
        frames.push({
          index: frames.length,
          type: isIRAP(type) ? 'I' : (sl.info.sliceType || '?'),
          keyframe: isIRAP(type),
          codec: 'h265',
          offset: u.sc,
          size: u.len,
          nalType: type,
          nalName: nalTypeName(type),
          layerId: layerId,
          temporalId: tid,
          pocLsb: sl.info.picOrderCntLsb,
          sliceQp: sl.info.sliceQpDelta == null ? null
            : 26 + ((active && active.initQpMinus26) || 0) + sl.info.sliceQpDelta,
          syntax: {
            codec: 'h265', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len,
            _cached: synSection('slice_segment_header()',
              nalTypeName(type) + (sl.info.sliceType ? ', ' + sl.info.sliceType + ' slice' : '') +
              ' @ ' + MA.hex(u.sc, 8), sl.rows)
          }
        });
      } else if (type === 39 || type === 40) {
        seiCount++;
        var sei = parseSEI(unescapeRbsp(data, u.start + 2, u.end), u.start + 2);
        if (sei.info && sei.info.hdr) info.hdr = MA.hdrSEI.merge(info.hdr, sei.info.hdr);
        frames.push({
          index: frames.length, type: 'SEI', keyframe: false, codec: 'h265',
          offset: u.sc, size: u.len, nalType: type, nalName: nalTypeName(type),
          syntax: { codec: 'h265', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len,
                    _cached: sei.tables }
        });
      } else if (type === 35) {
        frames.push({
          index: frames.length, type: 'AUD', keyframe: false, codec: 'h265',
          offset: u.sc, size: u.len, nalType: 35, nalName: 'AUD',
          syntax: { codec: 'h265', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len }
        });
      }
    }
    info.idrCount = idrCount;
    info.irapCount = irapCount;
    info.seiCount = seiCount;
    info.vclCount = vclCount;
    var track = {
      id: 1, type: 'video', codec: 'h265', codecName: 'H.265 / HEVC',
      profile: info.profile, level: info.level,
      width: info.width, height: info.height, fps: info.fps,
      bitDepth: info.bitDepthLuma,
      sampleCount: frames.length,
      vpsCount: Object.keys(ctx.vpsById).length,
      spsCount: Object.keys(ctx.spsById).length,
      ppsCount: Object.keys(ctx.ppsById).length,
      extra: []
    };
    var hdrSummary = MA.hdrSEI.summarize(info.hdr, info.colour);
    if (hdrSummary.formats.length) {
      track.hdr = info.hdr;
      track.extra = hdrSummary.extras;
    }
    return { tables: tables, frames: frames, track: track, info: info, ctx: ctx };
  }

  MA.registerCodec('h265', {
    id: 'h265',
    name: 'H.265 / HEVC',
    nalTypeName: nalTypeName,
    isIRAP: isIRAP,
    profiles: PROFILES,
    levels: LEVELS,
    seiTypes: SEI_TYPE,
    parseHVCC: parseHVCC,
    parseVPS: parseVPS,
    parseSPS: parseSPS,
    parsePPS: parsePPS,
    parseSliceSegmentHeader: parseSliceSegmentHeader,
    parseSEI: parseSEI,
    parseNAL: parseNAL,
    ctxFromConfig: ctxFromConfig,
    ctxFromHVCC: ctxFromConfig,
    makeContext: makeContext,
    buildSampleSyntax: buildSampleSyntax,
    analyzeAnnexB: analyzeAnnexB
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
