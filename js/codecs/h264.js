/* ============================================================================
 * MediaAnalyzer — codecs/h264.js
 *
 * H.264 / AVC syntax parsing, ITU-T Rec. H.264 | ISO/IEC 14496-10.
 *
 * Every parsed structure is emitted as a syntax table whose rows mirror the
 * spec text (field / syntax / bits / value / meaning), so the frame panel can
 * show exactly what the bitstream says rather than a summary of it.
 *
 * Entry points
 *   parseAVCC(br, end)              AVCDecoderConfigurationRecord (avcC box)
 *   parseNAL(data, off, end, ctx)   one NAL unit -> { type, name, tables, info }
 *   parseSPS / parsePPS / parseSliceHeader / parseSEI
 *   analyzeAnnexB(data, ctx)        full raw .264 elementary stream
 *   buildSampleSyntax(payload, spec, ctx)  one MP4/MKV sample
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, unescapeRbsp = MA.unescapeRbsp, synSection = MA.synSection;

  /* ---------------------------------------------------------------- tables */

  var NAL_TYPES = {
    0: 'Unspecified', 1: 'Coded slice, non-IDR', 2: 'Coded slice data partition A',
    3: 'Coded slice data partition B', 4: 'Coded slice data partition C',
    5: 'Coded slice, IDR', 6: 'SEI', 7: 'SPS', 8: 'PPS', 9: 'AUD',
    10: 'End of sequence', 11: 'End of stream', 12: 'Filler data',
    13: 'SPS extension', 14: 'Prefix NAL unit', 15: 'Subset SPS',
    16: 'Depth parameter set', 17: 'Reserved', 18: 'Coded slice, auxiliary',
    19: 'Coded slice, extension', 20: 'Coded slice, depth view', 21: 'Coded slice, 3D-AVC'
  };
  function nalTypeName(t) { return NAL_TYPES[t] || (t >= 22 && t <= 23 ? 'Reserved' : (t >= 24 ? 'Unspecified' : 'Type ' + t)); }

  var PROFILES = {
    66: 'Baseline', 77: 'Main', 88: 'Extended', 100: 'High', 110: 'High 10',
    122: 'High 4:2:2', 244: 'High 4:4:4 Predictive', 44: 'CAVLC 4:4:4 Intra',
    83: 'Scalable Baseline', 86: 'Scalable High', 118: 'Stereo High',
    128: 'Multiview High', 138: 'Multiview Depth High', 139: 'Enhanced Multiview Depth High',
    134: 'High 10 Intra', 135: 'High 4:2:2 Intra', 136: 'High 4:4:4 Intra',
    74: 'High 10 (old)', 80: 'Scalable Baseline (old)'
  };
  // Table A-1: level_idc is 10 x the level for the "x.0" entries. Level 1b
  // shares level_idc 11 with level 1.1 and is distinguished by
  // constraint_set3_flag, which the SPS reader annotates separately.
  var LEVELS = {
    9: '1b', 10: '1', 11: '1.1', 12: '1.2', 13: '1.3', 20: '2', 21: '2.1',
    22: '2.2', 30: '3', 31: '3.1', 32: '3.2', 40: '4', 41: '4.1', 42: '4.2',
    50: '5', 51: '5.1', 52: '5.2', 60: '6', 61: '6.1', 62: '6.2'
  };
  var CHROMA_FORMAT = ['monochrome', '4:2:0', '4:2:2', '4:4:4'];

  /** profile_idc values that carry the full chroma/scaling-list extension. */
  var EXT_PROFILES = [100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135, 136, 74];

  var SLICE_TYPES = ['P', 'B', 'I', 'SP', 'SI'];
  function sliceTypeName(t) { return SLICE_TYPES[t % 5] || '?'; }

  var ASPECT_RATIO = {
    1: '1:1 (square)', 2: '12:11', 3: '10:11', 4: '16:11', 5: '40:33', 6: '24:11',
    7: '20:11', 8: '32:11', 9: '80:33', 10: '18:11', 11: '15:11', 12: '64:33',
    13: '160:99', 14: '4:3', 15: '3:2', 16: '2:1', 17: '255:100'
  };
  var VIDEO_FORMAT = { 0: 'Component', 1: 'PAL', 2: 'NTSC', 3: 'SECAM', 4: 'MAC', 5: 'Unspecified' };
  var COLOUR_PRIMARIES = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'SMPTE 170M', 7: 'SMPTE 240M', 8: 'Film', 9: 'BT.2020', 10: 'SMPTE ST 428-1',
    11: 'SMPTE RP 431-2 (DCI-P3)', 12: 'SMPTE EG 432-1 (P3 D65)', 22: 'EBU Tech 3213-E'
  };
  var TRANSFER_CHARACTERISTICS = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'Linear', 9: 'Logarithmic (100:1)',
    10: 'Logarithmic (316.22777:1)', 11: 'xvYCC', 12: 'BT.1361', 13: 'sRGB',
    14: 'BT.2020 (10-bit)', 15: 'BT.2020 (12-bit)', 16: 'SMPTE ST 2084 (PQ)',
    17: 'SMPTE ST 428-1', 18: 'ARIB STD-B67 (HLG)'
  };
  var MATRIX_COEFFICIENTS = {
    0: 'Identity (GBR)', 1: 'BT.709', 2: 'Unspecified', 4: 'FCC', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'YCgCo', 9: 'BT.2020 non-constant',
    10: 'BT.2020 constant', 11: 'SMPTE ST 2085', 12: 'Chromaticity-derived non-constant',
    13: 'Chromaticity-derived constant', 14: 'ICtCp'
  };
  var SEI_TYPE = {
    0: 'buffering_period', 1: 'pic_timing', 2: 'pan_scan_rect',
    3: 'filler_payload', 4: 'user_data_registered_itu_t_t35', 5: 'user_data_unregistered',
    6: 'recovery_point', 7: 'dec_ref_pic_marking_repetition',
    8: 'spare_pic', 9: 'scene_info', 10: 'sub_seq_info',
    11: 'sub_seq_layer_characteristics', 12: 'sub_seq_characteristics',
    13: 'full_frame_freeze', 14: 'full_frame_freeze_release', 15: 'full_frame_snapshot',
    16: 'progressive_refinement_segment_start', 17: 'progressive_refinement_segment_end',
    18: 'motion_constrained_slice_group_set', 19: 'film_grain_characteristics',
    20: 'deblocking_filter_display_preference', 21: 'stereo_video_info',
    22: 'post_filter_hint', 23: 'tone_mapping_info', 24: 'scalability_info',
    25: 'sub_pic_scalable_layer', 26: 'non_required_layer_rep', 27: 'priority_layer_info',
    28: 'layers_not_present', 29: 'layer_dependency_change', 30: 'scalable_nesting',
    31: 'base_layer_temporal_hrd', 32: 'quality_layer_integrity_check',
    33: 'redundant_pic_cnt', 34: 'tl0_dep_rep_index', 35: 'tl1_dep_rep_index',
    36: 'tl_switching_point', 37: 'parallel_decoding_info', 38: 'mvc_scalable_nesting',
    39: 'view_scalability_info', 40: 'multiview_scene_info', 41: 'multiview_acquisition_info',
    42: 'multiview_view_position', 43: 'alternative_depth_info', 44: 'sei_manifest',
    45: 'sei_prefix_indication', 46: 'layer_representation_info',
    47: 'depth_representation_info', 48: 'depth_sampling_info', 137: 'mastering_display_colour_volume',
    144: 'content_light_level_info', 145: 'dependent_rps', 147: 'alternative_transfer_characteristics',
    148: 'ambient_viewing_environment', 149: 'content_colour_volume', 150: 'equirectangular_projection',
    151: 'cubemap_projection', 154: 'sphere_rotation', 155: 'regionwise_packing',
    156: 'omni_viewport', 160: 'layers_not_present', 161: 'inter_layer_constraint',
    162: 'alpha_channel_info', 163: 'display_orientation', 164: 'colour_remapping_info',
    165: 'green_metadata', 168: 'frame_packing_arrangement', 176: 'decoded_picture_hash',
    177: 'scalable_nesting', 178: 'user_data_unregistered'
  };

  MA.h264Tables = { NAL_TYPES: NAL_TYPES, PROFILES: PROFILES, LEVELS: LEVELS };

  /* ======================================================================
   * seq_parameter_set_rbsp()
   * ====================================================================*/

  /** scaling_list() — the deltas are only interesting for their cumulative
   *  effect, so the table records the reconstructed values. */
  function scalingList(r, size, name) {
    var next = 8, last = 8, values = [];
    for (var j = 0; j < size; j++) {
      if (next !== 0) {
        var delta = r.se(name + '[' + j + ']');
        next = (last + delta + 256) % 256;
      }
      last = next === 0 ? last : next;
      values.push(last);
    }
    return values;
  }

  function parseVUI(r, info) {
    r.depth++;
    r.group('vui_parameters()');
    var ar = r.flag('aspect_ratio_info_present_flag');
    if (ar) {
      r.cond('aspect_ratio_info_present_flag');
      var idc = r.u('aspect_ratio_idc', 8);
      r.note(ASPECT_RATIO[idc] || (idc === 255 ? 'Extended_SAR' : 'Reserved'));
      if (idc === 255) {
        r.cond('aspect_ratio_idc == 255');
        var w = r.u('sar_width', 16), h = r.u('sar_height', 16);
        info.sar = w + ':' + h;
        r.note(w + ':' + h);
        r.endBlock();
      } else if (ASPECT_RATIO[idc]) info.sar = ASPECT_RATIO[idc];
      r.endBlock();
    }
    if (r.flag('overscan_info_present_flag')) {
      r.cond('overscan_info_present_flag');
      r.flag('overscan_appropriate_flag');
      r.endBlock();
    }
    if (r.flag('video_signal_type_present_flag')) {
      r.cond('video_signal_type_present_flag');
      var vf = r.u('video_format', 3); r.note(VIDEO_FORMAT[vf] || 'Reserved');
      var full = r.flag('video_full_range_flag'); r.note(full ? 'full range' : 'limited range');
      info.fullRange = !!full;
      if (r.flag('colour_description_present_flag')) {
        r.cond('colour_description_present_flag');
        var cp = r.u('colour_primaries', 8); r.note(COLOUR_PRIMARIES[cp] || 'Reserved');
        var tc = r.u('transfer_characteristics', 8); r.note(TRANSFER_CHARACTERISTICS[tc] || 'Reserved');
        var mc = r.u('matrix_coefficients', 8); r.note(MATRIX_COEFFICIENTS[mc] || 'Reserved');
        info.colour = { primaries: COLOUR_PRIMARIES[cp] || cp,
                        transfer: TRANSFER_CHARACTERISTICS[tc] || tc,
                        matrix: MATRIX_COEFFICIENTS[mc] || mc };
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
    if (r.flag('timing_info_present_flag')) {
      r.cond('timing_info_present_flag');
      var num = r.u('num_units_in_tick', 32);
      var scale = r.u('time_scale', 32);
      r.flag('fixed_frame_rate_flag');
      if (num > 0) {
        info.fps = scale / (2 * num);
        r.note('nominal ' + info.fps.toFixed(3) + ' fps');
      }
      info.timeScale = scale;
      r.endBlock();
    }
    // ---- hrd_parameters() ----
    var nalHrd = r.flag('nal_hrd_parameters_present_flag');
    if (nalHrd) { r.cond('nal_hrd_parameters_present_flag'); parseHRD(r, 'nal_hrd_parameters()', info); r.endBlock(); }
    var vclHrd = r.flag('vcl_hrd_parameters_present_flag');
    if (vclHrd) { r.cond('vcl_hrd_parameters_present_flag'); parseHRD(r, 'vcl_hrd_parameters()', info); r.endBlock(); }
    if (nalHrd || vclHrd) {
      r.cond('nal_hrd_parameters_present_flag || vcl_hrd_parameters_present_flag');
      r.flag('low_delay_hrd_flag');
      r.endBlock();
    }
    r.flag('pic_struct_present_flag');
    // ---- bitstream_restriction() ----
    if (r.flag('bitstream_restriction_flag')) {
      r.cond('bitstream_restriction_flag');
      r.depth++;
      r.group('bitstream_restriction()');
      r.flag('motion_vectors_over_pic_boundaries_flag');
      r.ue('max_bytes_per_pic_denom');
      r.ue('max_bits_per_mb_denom');
      r.ue('log2_max_mv_length_horizontal');
      r.ue('log2_max_mv_length_vertical');
      var maxRef = r.ue('max_num_reorder_frames');
      var maxDec = r.ue('max_dec_frame_buffering');
      info.maxNumReorderFrames = maxRef;
      info.maxDecFrameBuffering = maxDec;
      r.depth--;
      r.endBlock();
    }
    r.depth--;
  }

  function parseHRD(r, title, info) {
    r.depth++;
    r.group('hrd_parameters()  // ' + title);
    var cpbCnt = r.ue('cpb_cnt_minus1') + 1;
    r.u('bit_rate_scale', 4);
    r.u('cpb_size_scale', 4);
    for (var i = 0; i < Math.min(cpbCnt, 32); i++) {
      r.ue('bit_rate_value_minus1[' + i + ']');
      r.ue('cpb_size_value_minus1[' + i + ']');
      r.flag('cbr_flag[' + i + ']');
    }
    r.u('initial_cpb_removal_delay_length_minus1', 5);
    r.u('cpb_removal_delay_length_minus1', 5);
    r.u('dpb_output_delay_length_minus1', 5);
    r.u('time_offset_length', 5);
    r.depth--;
  }

  /**
   * @param {Uint8Array} rbsp  SPS payload (NAL header already stripped)
   * @param {number} base      absolute file offset of rbsp[0] (for hex linking)
   */
  function parseSPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      var profileIdc = r.u('profile_idc', 8);
      info.profileIdc = profileIdc;
      r.note(PROFILES[profileIdc] || 'Reserved / unknown');
      info.profile = PROFILES[profileIdc] || ('profile ' + profileIdc);

      var constraints = r.u('constraint_set0..5_flag + reserved_zero_2bits', 8);
      info.constraintFlags = constraints;
      var names = [];
      for (var ci = 0; ci < 6; ci++) if ((constraints >> (7 - ci)) & 1) names.push('set' + ci);
      if (names.length) r.note('constraint ' + names.join(', '));

      var levelIdc = r.u('level_idc', 8);
      info.levelIdc = levelIdc;
      info.level = LEVELS[levelIdc] || (levelIdc / 10).toFixed(1);
      r.note('Level ' + info.level);

      info.spsId = r.ue('seq_parameter_set_id');

      if (EXT_PROFILES.indexOf(profileIdc) >= 0) {
        r.cond('profile_idc specifies the chroma / scaling-list extension');
        var chroma = r.ue('chroma_format_idc');
        r.note(CHROMA_FORMAT[chroma] || 'Reserved');
        info.chromaFormatIdc = chroma;
        if (chroma === 3) {
          r.cond('chroma_format_idc == 3');
          r.flag('separate_colour_plane_flag');
          r.endBlock();
        }
        info.bitDepthLuma = r.ue('bit_depth_luma_minus8') + 8;
        info.bitDepthChroma = r.ue('bit_depth_chroma_minus8') + 8;
        r.flag('qpprime_y_zero_transform_bypass_flag');
        if (r.flag('seq_scaling_matrix_present_flag')) {
          r.cond('seq_scaling_matrix_present_flag');
          var count = chroma === 3 ? 12 : 8;
          for (var i = 0; i < count; i++) {
            if (r.flag('seq_scaling_list_present_flag[' + i + ']')) {
              r.cond('seq_scaling_list_present_flag[ ' + i + ' ]');
              scalingList(r, i < 6 ? 16 : 64, 'scaling_list_' + (i < 6 ? '4x4' : '8x8') + '[' + i + ']');
              r.endBlock();
            }
          }
          r.endBlock();
        }
        r.endBlock();
      } else {
        r.group('else {  /* implicit chroma_format_idc = 1, bit_depth = 8 */ }');
        info.chromaFormatIdc = 1;                 // implicit 4:2:0
        info.bitDepthLuma = 8; info.bitDepthChroma = 8;
      }

      info.log2MaxFrameNum = r.ue('log2_max_frame_num_minus4') + 4;
      var pocType = r.ue('pic_order_cnt_type');
      info.picOrderCntType = pocType;
      if (pocType === 0) {
        r.cond('pic_order_cnt_type == 0');
        info.log2MaxPocLsb = r.ue('log2_max_pic_order_cnt_lsb_minus4') + 4;
        r.endBlock();
      } else if (pocType === 1) {
        r.cond('pic_order_cnt_type == 1');
        info.deltaPicOrderAlwaysZero = r.flag('delta_pic_order_always_zero_flag');
        r.se('offset_for_non_ref_pic');
        r.se('offset_for_top_to_bottom_field');
        var n = r.ue('num_ref_frames_in_pic_order_cnt_cycle');
        for (var k = 0; k < Math.min(n, 256); k++) r.se('offset_for_ref_frame[' + k + ']');
        r.endBlock();
      }
      info.maxNumRefFrames = r.ue('max_num_ref_frames');
      r.flag('gaps_in_frame_num_value_allowed_flag');

      var wMbs = r.ue('pic_width_in_mbs_minus1') + 1;
      var hMapUnits = r.ue('pic_height_in_map_units_minus1') + 1;
      var frameMbsOnly = r.flag('frame_mbs_only_flag');
      info.frameMbsOnlyFlag = frameMbsOnly;
      if (!frameMbsOnly) {
        r.cond('!frame_mbs_only_flag');
        r.flag('mb_adaptive_frame_field_flag');
        r.endBlock();
      }
      r.flag('direct_8x8_inference_flag');

      var cropL = 0, cropR = 0, cropT = 0, cropB = 0;
      if (r.flag('frame_cropping_flag')) {
        r.cond('frame_cropping_flag');
        cropL = r.ue('frame_crop_left_offset');
        cropR = r.ue('frame_crop_right_offset');
        cropT = r.ue('frame_crop_top_offset');
        cropB = r.ue('frame_crop_bottom_offset');
        r.endBlock();
      }
      // Crop offsets are expressed in chroma sample units.
      var cf = info.chromaFormatIdc || 1;
      var subW = cf === 0 ? 1 : (cf === 1 ? 2 : 1);
      var subH = cf === 0 ? 1 : (cf === 1 ? 2 : 1);
      var cropUnitX = subW;
      var cropUnitY = subH * (2 - frameMbsOnly);
      info.width = wMbs * 16 - (cropL + cropR) * cropUnitX;
      info.height = hMapUnits * 16 * (2 - frameMbsOnly) - (cropT + cropB) * cropUnitY;
      info.codedWidth = wMbs * 16;
      info.codedHeight = hMapUnits * 16 * (2 - frameMbsOnly);

      info.vuiPresent = r.flag('vui_parameters_present_flag');
      if (info.vuiPresent) {
        r.cond('vui_parameters_present_flag');
        parseVUI(r, info);
        r.endBlock();
      }

      r.trailing('rbsp_trailing_bits()');
      // `incomplete` marks an SPS that ran out of bits before every declared
      // field was read — a truncated or synthetic parameter set. Container
      // parsers use it to decide whether the derived geometry is trustworthy.
      info.incomplete = !!r.overrun;
      return { rows: r.rows, info: info };
    } catch (e) {
      info.incomplete = true;
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * pic_parameter_set_rbsp()
   * ====================================================================*/

  function parsePPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      info.ppsId = r.ue('pic_parameter_set_id');
      info.spsId = r.ue('seq_parameter_set_id');
      var entropy = r.flag('entropy_coding_mode_flag');
      r.note(entropy ? 'CABAC' : 'CAVLC');
      info.entropyCodingModeFlag = entropy;
      info.bottomFieldPicOrderInFramePresent = r.flag('bottom_field_pic_order_in_frame_present_flag');

      var groups = r.ue('num_slice_groups_minus1');
      info.numSliceGroupsMinus1 = groups;
      if (groups > 0) {
        r.cond('num_slice_groups_minus1 > 0');
        var mapType = r.ue('slice_group_map_type');
        r.note(['interleaved', 'dispersed', 'foreground', 'box-out', 'raster',
                'wipe', 'explicit'][mapType] || 'reserved');
        info.sliceGroupMapType = mapType;
        if (mapType === 0) {
          r.cond('slice_group_map_type == 0');
          for (var i = 0; i <= groups; i++) r.ue('run_length_minus1[' + i + ']');
          r.endBlock();
        } else if (mapType === 2) {
          r.cond('slice_group_map_type == 2');
          for (var j = 0; j < groups; j++) { r.ue('top_left[' + j + ']'); r.ue('bottom_right[' + j + ']'); }
          r.endBlock();
        } else if (mapType === 3 || mapType === 4 || mapType === 5) {
          r.cond('slice_group_map_type == 3 || 4 || 5');
          r.flag('slice_group_change_direction_flag');
          r.ue('slice_group_change_rate_minus1');
          r.endBlock();
        } else if (mapType === 6) {
          r.cond('slice_group_map_type == 6');
          var n = r.ue('pic_size_in_map_units_minus1');
          var bits = Math.max(1, Math.ceil(Math.log(groups + 1) / Math.LN2));
          for (var k = 0; k <= Math.min(n, 4096); k++) r.u('slice_group_id[' + k + ']', bits);
          r.endBlock();
        }
        r.endBlock();
      }
      info.numRefIdxL0DefaultActive = r.ue('num_ref_idx_l0_default_active_minus1') + 1;
      info.numRefIdxL1DefaultActive = r.ue('num_ref_idx_l1_default_active_minus1') + 1;
      info.weightedPredFlag = r.flag('weighted_pred_flag');
      var bipred = r.u('weighted_bipred_idc', 2);
      r.note(['default', 'explicit', 'implicit'][bipred] || 'reserved');
      info.weightedBipredIdc = bipred;
      info.picInitQp = r.se('pic_init_qp_minus26') + 26;
      info.picInitQs = r.se('pic_init_qs_minus26') + 26;
      info.chromaQpIndexOffset = r.se('chroma_qp_index_offset');
      info.deblockingFilterControlPresent = r.flag('deblocking_filter_control_present_flag');
      info.constrainedIntraPred = r.flag('constrained_intra_pred_flag');
      info.redundantPicCntPresent = r.flag('redundant_pic_cnt_present_flag');

      // Optional trailing extension (the "more_rbsp_data" tail of the PPS).
      if (!r.overrun && r.bitsLeft() > 8) {
        r.depth++;
        r.group('// PPS extension (transform_8x8 / scaling lists)');
        info.transform8x8ModeFlag = r.flag('transform_8x8_mode_flag');
        var picScaling = r.flag('pic_scaling_matrix_present_flag');
        if (picScaling) {
          r.cond('pic_scaling_matrix_present_flag');
          var cnt = 6 + (info.transform8x8ModeFlag ? (info.chromaFormatIdc === 3 ? 6 : 2) : 0);
          for (var s = 0; s < Math.min(cnt, 12); s++) {
            if (r.flag('pic_scaling_list_present_flag[' + s + ']')) {
              r.cond('pic_scaling_list_present_flag[ ' + s + ' ]');
              scalingList(r, s < 6 ? 16 : 64, 'scaling_list[' + s + ']');
              r.endBlock();
            }
          }
          r.endBlock();
        }
        info.secondChromaQpIndexOffset = r.se('second_chroma_qp_index_offset');
        r.depth--;
      }
      r.trailing('rbsp_trailing_bits()');
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * slice_header() — needs the active SPS and PPS
   * ====================================================================*/

  function parseSliceHeader(rbsp, nal, sps, pps, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = { nalType: nal.type, nalRefIdc: nal.refIdc };
    var idr = nal.type === 5;
    sps = sps || {}; pps = pps || {};
    try {
      info.firstMbInSlice = r.ue('first_mb_in_slice');
      var st = r.ue('slice_type');
      info.sliceTypeIdx = st;
      info.sliceType = sliceTypeName(st);
      r.note(info.sliceType + ' slice' + (st > 4 ? ' (all slices in pic are ' + info.sliceType + ')' : ''));
      info.ppsId = r.ue('pic_parameter_set_id');

      var log2FrameNum = sps.log2MaxFrameNum || 4;
      info.frameNum = r.uv('frame_num', log2FrameNum, 'MaxFrameNum = ' + (1 << log2FrameNum));

      info.fieldPicFlag = 0;
      if (!sps.frameMbsOnlyFlag) {
        r.cond('!frame_mbs_only_flag');
        info.fieldPicFlag = r.flag('field_pic_flag');
        if (info.fieldPicFlag) {
          r.cond('field_pic_flag');
          info.bottomFieldFlag = r.flag('bottom_field_flag');
          r.endBlock();
        }
        r.endBlock();
      }
      if (idr) {
        r.cond('IdrPicFlag');
        info.idrPicId = r.ue('idr_pic_id');
        r.endBlock();
      }

      var pocType = sps.picOrderCntType == null ? 0 : sps.picOrderCntType;
      if (pocType === 0) {
        r.cond('pic_order_cnt_type == 0');
        var pocBits = sps.log2MaxPocLsb || 4;
        info.picOrderCntLsb = r.uv('pic_order_cnt_lsb', pocBits, 'MaxPicOrderCntLsb = ' + (1 << pocBits));
        if (pps.bottomFieldPicOrderInFramePresent && !info.fieldPicFlag)
          r.se('delta_pic_order_cnt_bottom');
        r.endBlock();
      } else if (pocType === 1 && !sps.deltaPicOrderAlwaysZero) {
        r.cond('pic_order_cnt_type == 1 && !delta_pic_order_always_zero_flag');
        r.se('delta_pic_order_cnt[0]');
        if (pps.bottomFieldPicOrderInFramePresent && !info.fieldPicFlag)
          r.se('delta_pic_order_cnt[1]');
        r.endBlock();
      }
      if (pps.redundantPicCntPresent) {
        r.cond('redundant_pic_cnt_present_flag');
        info.redundantPicCnt = r.ue('redundant_pic_cnt');
        r.endBlock();
      }
      if (info.sliceType === 'B') r.flag('direct_spatial_mv_pred_flag');

      if (info.sliceType === 'P' || info.sliceType === 'SP' || info.sliceType === 'B') {
        r.cond('slice_type in { P, SP, B }');
        var override = r.flag('num_ref_idx_active_override_flag');
        if (override) {
          r.cond('num_ref_idx_active_override_flag');
          info.numRefIdxL0 = r.ue('num_ref_idx_l0_active_minus1') + 1;
          if (info.sliceType === 'B') info.numRefIdxL1 = r.ue('num_ref_idx_l1_active_minus1') + 1;
          r.endBlock();
        } else {
          info.numRefIdxL0 = pps.numRefIdxL0DefaultActive || 1;
          info.numRefIdxL1 = pps.numRefIdxL1DefaultActive || 1;
        }
        // -------- ref_pic_list_modification() --------
        var modL0 = r.flag('ref_pic_list_modification_flag_l0');
        info.refPicListModL0 = modL0;
        if (modL0) {
          r.cond('ref_pic_list_modification_flag_l0');
          r.depth++;
          var e, guard = 0;
          do {
            e = r.ue('modification_of_pic_nums_idc');
            if (e === 0 || e === 1) r.ue('abs_diff_pic_num_minus1');
            else if (e === 2) r.ue('long_term_pic_num');
          } while (e !== 3 && ++guard < 256);
          r.depth--;
          r.endBlock();
        }
        if (info.sliceType === 'B') {
          var modL1 = r.flag('ref_pic_list_modification_flag_l1');
          info.refPicListModL1 = modL1;
          if (modL1) {
            r.cond('ref_pic_list_modification_flag_l1');
            r.depth++;
            var e2, guard2 = 0;
            do {
              e2 = r.ue('modification_of_pic_nums_idc');
              if (e2 === 0 || e2 === 1) r.ue('abs_diff_pic_num_minus1');
              else if (e2 === 2) r.ue('long_term_pic_num');
            } while (e2 !== 3 && ++guard2 < 256);
            r.depth--;
            r.endBlock();
          }
        }
        // -------- pred_weight_table() --------
        var needWeight =
          (pps.weightedPredFlag === 1 && (info.sliceType === 'P' || info.sliceType === 'SP')) ||
          (pps.weightedBipredIdc === 1 && info.sliceType === 'B');
        if (needWeight) {
          r.cond('weighted_pred_flag / weighted_bipred_idc requires weights');
          r.depth++;
          r.group('pred_weight_table()');
          r.ue('luma_log2_weight_denom');
          var cf = sps.chromaFormatIdc == null ? 1 : sps.chromaFormatIdc;
          if (cf !== 0) r.ue('chroma_log2_weight_denom');
          r.depth--;
          r.endBlock();
          info.weightTableTruncated = true;   // per-entry weights omitted for brevity
        }
        r.endBlock();
      }
      // -------- dec_ref_pic_marking() --------
      if (info.nalRefIdc !== 0) {
        r.cond('nal_ref_idc != 0');
        r.depth++;
        r.group('dec_ref_pic_marking()');
        if (idr) {
          r.flag('no_output_of_prior_pics_flag');
          r.flag('long_term_reference_flag');
        } else {
          var adaptive = r.flag('adaptive_ref_pic_marking_mode_flag');
          if (adaptive) {
            r.cond('adaptive_ref_pic_marking_mode_flag');
            var op, g3 = 0;
            do {
              op = r.ue('memory_management_control_operation');
              if (op === 1 || op === 3) r.ue('difference_of_pic_nums_minus1');
              if (op === 2) r.ue('long_term_pic_num');
              if (op === 3 || op === 6) r.ue('long_term_frame_idx');
              if (op === 4) r.ue('max_long_term_frame_idx_plus1');
            } while (op !== 0 && ++g3 < 256);
            r.endBlock();
          }
        }
        r.depth--;
        r.endBlock();
      }
      if (info.sliceType === 'SP' || info.sliceType === 'SI') {
        r.cond('slice_type in { SP, SI }');
        if (info.sliceType === 'SP') r.flag('sp_for_switch_flag');
        r.se('slice_qs_delta');
        r.endBlock();
      }
      if (pps.deblockingFilterControlPresent) {
        r.cond('deblocking_filter_control_present_flag');
        var dfc = r.ue('disable_deblocking_filter_idc');
        r.note(['filter enabled', 'filter disabled', 'disabled across slice boundaries'][dfc] || 'reserved');
        if (dfc !== 1) {
          r.cond('disable_deblocking_filter_idc != 1');
          r.se('slice_alpha_c0_offset_div2');
          r.se('slice_beta_offset_div2');
          r.endBlock();
        }
        r.endBlock();
      }
      if (pps.numSliceGroupsMinus1 > 0 && pps.sliceGroupMapType >= 3 && pps.sliceGroupMapType <= 5)
        r.ue('slice_group_change_cycle');

      info.sliceQpDelta = r.se('slice_qp_delta');
      r.note('SliceQPY = ' + ((pps.picInitQp || 26) + info.sliceQpDelta));
      r.trailing('rbsp_trailing_bits() // (slice data follows, coded in macroblocks)');
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e.message || e) };
    }
  }

  /* ======================================================================
   * sei_rbsp()
   * ====================================================================*/

  function parseSEI(rbsp, base) {
    var tables = [];
    var info = {};
    try {
      // SEI is a sequence of {payloadType, payloadSize, payload} triples.
      // Walk the raw bytes: types and sizes are 0xFF-continued varints.
      var p = 0, guard = 0;
      var r = new SR(rbsp, { base: base || 0 });
      while (p < rbsp.length - 1 && guard++ < 64) {
        var typeStart = p;
        var payloadType = 0;
        while (p < rbsp.length && rbsp[p] === 0xff) { payloadType += 255; p++; }
        if (p >= rbsp.length) break;
        payloadType += rbsp[p++];
        var sizeStart = p;
        var payloadSize = 0;
        while (p < rbsp.length && rbsp[p] === 0xff) { payloadSize += 255; p++; }
        if (p >= rbsp.length) break;
        payloadSize += rbsp[p++];
        var payloadStart = p;

        // Emit a row per SEI message with the type / size as syntax elements.
        var sub = new SR(rbsp.subarray(typeStart, Math.min(rbsp.length, payloadStart + payloadSize)),
                         { base: (base || 0) + typeStart });
        sub.u('payload_type', 8);
        if (payloadType >= 255) sub.note(SEI_TYPE[payloadType] || 'reserved');
        sub.u('payload_size', 8);
        var rows = sub.rows;
        rows[0].value = payloadType;
        rows[0].syntax = payloadSize >= 255 || payloadType >= 255 ? 'u(8)*' : 'u(8)';
        rows[0].note = SEI_TYPE[payloadType] || 'reserved';
        rows[1].value = payloadSize;

        // Decode the payloads that carry structured, useful data.
        var payloadInfo = decodeSEIPayload(rbsp, payloadStart, payloadSize, payloadType, base);
        if (payloadInfo.rows.length) rows = rows.concat(payloadInfo.rows);
        var pInfo = payloadInfo.info || {};
        var pInfoHdr = pInfo.hdr;
        delete pInfo.hdr;
        Object.assign(info, pInfo);
        if (pInfoHdr) info.hdr = MA.hdrSEI.merge(info.hdr, pInfoHdr);

        tables.push(synSection('sei_message(' + (tables.length) + ')',
          'payloadType = ' + payloadType + ' (' + (SEI_TYPE[payloadType] || 'reserved') + '), ' +
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
      if (type === 5) {                                   // user_data_unregistered
        var uuid = new MA.ByteReader(data).guid(start);
        rows.push({ name: 'uuid_iso_iec_11578', syntax: 'u(128)', bits: 128, value: uuid,
                    note: 'unregistered user data', offset: (base || 0) + start, depth: 0 });
        var text = '';
        for (var i = 16; i < size; i++) {
          var c = data[start + i];
          text += (c >= 32 && c < 127) ? String.fromCharCode(c) : (c === 0 ? '' : '.');
        }
        rows.push({ name: 'user_data_payload_byte[]', syntax: '', bits: (size - 16) * 8,
                    value: text.slice(0, 200), note: '', offset: (base || 0) + start + 16, depth: 0 });
        info.userData = text;
      } else if (type === 6) {                            // recovery_point
        var r = new SR(data, { offset: start, length: size, base: base || 0 });
        var frameCnt = r.ue('recovery_frame_cnt');
        r.flag('exact_match_flag');
        r.flag('broken_link_flag');
        r.u('changing_slice_group_idc', 2);
        rows = r.rows; info.recoveryFrameCnt = frameCnt;
      } else if (type === 1) {                            // pic_timing
        var r2 = new SR(data, { offset: start, length: size, base: base || 0 });
        r2.u('pic_struct', 4);
        r2.u('source_scan_type', 2);
        r2.flag('duplicate_flag');
        rows = r2.rows;
        info.hasPicTiming = true;
      } else if (type === 137 || type === 144 || type === 147 ||
                 type === 148 || type === 149 || type === 4) {
        // HDR-related payloads (ST 2086 MDCV, CLLI, alt transfer, ambient,
        // CCV, and the T.35 carrier for ST 2094-10/40, SL-HDR, HDR Vivid).
        var h = MA.hdrSEI.decodePayload(type, data, start, size, base || 0);
        rows = h.rows;
        if (h.hdr && Object.keys(h.hdr).length) info.hdr = h.hdr;
        if (h.hdr && h.hdr.mastering) {
          info.masteringLuminance = { max: h.hdr.mastering.maxLum, min: h.hdr.mastering.minLum };
        }
      } else if (type === 47) {                           // depth_representation_info
        var r5 = new SR(data, { offset: start, length: size, base: base || 0 });
        r5.flag('all_views_equal_flag');
        r5.ue('depth_max_value_minus1');
        r5.flag('depth_sampling_info_present_flag');
        rows = r5.rows;
      }
    } catch (e) { /* payload shorter than the structure it declares */ }
    return { rows: rows, info: info };
  }

  /* ======================================================================
   * NAL unit dispatch
   * ====================================================================*/

  var NAL_HEADER_ROWS = function (data, off, type, refIdc) {
    var h = data[off];
    return [
      { name: 'forbidden_zero_bit', syntax: 'u(1)', bits: 1, value: (h >> 7) & 1, note: '', offset: off, depth: 0 },
      { name: 'nal_ref_idc', syntax: 'u(2)', bits: 2, value: (h >> 5) & 3,
        note: refIdc === 0 ? 'not used for reference' : 'reference picture', offset: off, depth: 0 },
      { name: 'nal_unit_type', syntax: 'u(5)', bits: 5, value: type,
        note: nalTypeName(type), offset: off, depth: 0 }
    ];
  };

  /**
   * Parse one Annex-B style NAL unit.
   * @param {Uint8Array} data full buffer
   * @param {number} off   offset of the NAL header byte
   * @param {number} end   offset one past the last payload byte
   * @param {object} ctx   { sps, pps } active parameter sets (optional)
   */
  function parseNAL(data, off, end, ctx) {
    ctx = ctx || {};
    if (off >= end) return { type: -1, tables: [], info: {} };
    var h = data[off];
    var type = h & 0x1f, refIdc = (h >> 5) & 3;
    var rbsp = unescapeRbsp(data, off + 1, end);
    var base = off + 1;
    var rows = NAL_HEADER_ROWS(data, off, type, refIdc);
    var tables = [], info = { type: type, refIdc: refIdc, name: nalTypeName(type) };

    var body = null;
    if (type === 7 || type === 15) {
      var sps = parseSPS(rbsp, base);
      body = sps;
      info.kind = 'sps';
      Object.assign(info, sps.info);
      tables.push(synSection('seq_parameter_set_rbsp()',
        'NAL unit type ' + type + ' — ' + nalTypeName(type), rows.concat(sps.rows)));
    } else if (type === 8) {
      var pps = parsePPS(rbsp, base);
      body = pps;
      info.kind = 'pps';
      Object.assign(info, pps.info);
      tables.push(synSection('pic_parameter_set_rbsp()',
        'NAL unit type 8 — Picture Parameter Set', rows.concat(pps.rows)));
    } else if (type === 1 || type === 2 || type === 3 || type === 4 || type === 5 || type === 19 || type === 20) {
      var sl = parseSliceHeader(rbsp, { type: type, refIdc: refIdc }, ctx.sps, ctx.pps, base);
      body = sl;
      info.kind = 'slice';
      Object.assign(info, sl.info);
      tables.push(synSection('slice_header()',
        nalTypeName(type) + (sl.info.sliceType ? ', ' + sl.info.sliceType + ' slice' : '') +
        ', ' + (end - off) + ' bytes', rows.concat(sl.rows)));
    } else if (type === 6) {
      var sei = parseSEI(rbsp, base);
      info.kind = 'sei';
      Object.assign(info, sei.info);
      tables.push(synSection('sei_rbsp()', 'NAL unit type 6 — Supplemental Enhancement Information',
        rows.concat([{ name: '', syntax: '', bits: '', value: '', note: '', offset: base, depth: 0 }])));
      tables = tables.concat(sei.tables);
    } else if (type === 9) {
      var r = new SR(rbsp, { base: base });
      r.u('primary_pic_type', 3);
      r.note(['I', 'I,P', 'I,P,B', 'SI', 'SI,SP', 'I,SI', 'all', 'reserved'][r.rows[0].value] || '');
      r.trailing('rbsp_trailing_bits()');
      info.kind = 'aud';
      tables.push(synSection('access_unit_delimiter_rbsp()', 'NAL unit type 9 — picture boundary', rows.concat(r.rows)));
    } else if (type === 12) {
      info.kind = 'filler';
      tables.push(synSection('filler_data_rbsp()', 'NAL unit type 12 — ' + rbsp.length + ' filler bytes', rows));
    } else {
      info.kind = 'other';
      tables.push(synSection('nal_unit(' + type + ')', nalTypeName(type) + ', ' + (end - off) + ' bytes', rows));
    }
    return { type: type, refIdc: refIdc, name: nalTypeName(type), tables: tables, info: info, rows: rows };
  }

  /* ======================================================================
   * AVCDecoderConfigurationRecord (avcC)
   * ====================================================================*/

  /**
   * @param {MA.ByteReader} br reader positioned at the start of the record
   * @param {number} end    absolute end of the avcC payload
   * @param {number} base   absolute file offset of the record start
   */
  function parseAVCC(br, end, base) {
    var start = br.pos;
    if (base == null) base = br.base + start;
    var r = new SR(br.u8, { offset: start, length: end - start, epb: false, base: base });
    var out = { table: null, sps: [], pps: [], lengthSize: 4, info: {} };
    var rows = [];

    var version = r.u('configurationVersion', 8);
    var profile = r.u('AVCProfileIndication', 8);
    r.note(PROFILES[profile] || 'Reserved');
    var compat = r.u('profile_compatibility', 8);
    var level = r.u('AVCLevelIndication', 8);
    r.note('Level ' + (LEVELS[level] || (level / 10).toFixed(1)));
    r.u('reserved_zero_6bits', 6);
    var lsMinus1 = r.u('lengthSizeMinusOne', 2);
    out.lengthSize = lsMinus1 + 1;
    r.note(out.lengthSize + '-byte NAL length prefix');
    r.u('reserved_zero_3bits', 3);
    var numSps = r.u('numOfSequenceParameterSets', 5);
    r.note(numSps + ' SPS');
    var spsTables = [], ppsTables = [];
    for (var i = 0; i < numSps && i < 32; i++) {
      var len = r.u('sequenceParameterSetLength[' + i + ']', 16);
      var dataStart = r.bytePos();
      if (dataStart + len > end) break;
      var payload = br.u8.subarray(dataStart, dataStart + len);
      out.sps.push({ data: payload, offset: dataStart, nalHeader: payload[0] });
      // The stored set includes its NAL header byte — the RBSP starts after it.
      var sps = parseSPS(unescapeRbsp(payload, 1, payload.length), dataStart + 1);
      out.info = Object.assign(out.info, sps.info);
      spsTables.push(synSection('SPS[' + i + '] seq_parameter_set_rbsp()',
        'declared ' + len + ' bytes @ ' + MA.hex(dataStart, 8), sps.rows));
      r.skip(len * 8);
    }
    var numPps = r.u('numOfPictureParameterSets', 8);
    r.note(numPps + ' PPS');
    for (var j = 0; j < numPps && j < 64; j++) {
      var plen = r.u('pictureParameterSetLength[' + j + ']', 16);
      var pStart = r.bytePos();
      if (pStart + plen > end) break;
      var ppayload = br.u8.subarray(pStart, pStart + plen);
      out.pps.push({ data: ppayload, offset: pStart, nalHeader: ppayload[0] });
      var pps = parsePPS(unescapeRbsp(ppayload, 1, ppayload.length), pStart + 1);
      out.ppsInfo = pps.info;
      ppsTables.push(synSection('PPS[' + j + '] pic_parameter_set_rbsp()',
        'declared ' + plen + ' bytes @ ' + MA.hex(pStart, 8), pps.rows));
      r.skip(plen * 8);
    }
    // High-profile extension bytes, present for profile_idc in {100,110,122,144,...}
    if ((profile === 100 || profile === 110 || profile === 122 || profile === 144) &&
        r.bytePos() + 4 <= end) {
      r.u('chroma_format', 2);
      r.u('bit_depth_luma_minus8', 3);
      r.u('bit_depth_chroma_minus8', 3);
      var numSpsExt = r.u('numOfSequenceParameterSetExt', 8);
      for (var k = 0; k < numSpsExt && k < 16; k++) {
        var elen = r.u('sequenceParameterSetExtLength[' + k + ']', 16);
        if (r.bytePos() + elen > end) break;
        r.skip(elen * 8);
      }
    }

    out.table = synSection('AVCDecoderConfigurationRecord',
      'ISO/IEC 14496-15 §5.2.4.1 — avcC', rows.concat(r.rows));
    out.spsTables = spsTables;
    out.ppsTables = ppsTables;
    out.profile = profile; out.level = level; out.version = version; out.compat = compat;
    return out;
  }

  /* ======================================================================
   * Sample / elementary stream analysis
   * ====================================================================*/

  /** Collected parameter sets for a track, so slice headers can be decoded. */
  function makeContext() {
    return { sps: null, pps: null, spsById: {}, ppsById: {} };
  }

  function ctxFromAVCC(avcc) {
    var ctx = makeContext();
    avcc.sps.forEach(function (s, i) {
      try {
        var r = parseSPS(unescapeRbsp(s.data, 0, s.data.length), s.offset);
        if (i === 0 || r.info.spsId === 0) ctx.sps = r.info;
        ctx.spsById[r.info.spsId] = r.info;
      } catch (e) { /* ignore malformed set */ }
    });
    avcc.pps.forEach(function (p, i) {
      try {
        var r = parsePPS(unescapeRbsp(p.data, 0, p.data.length), p.offset);
        if (i === 0) ctx.pps = r.info;
        ctx.ppsById[r.info.ppsId] = r.info;
      } catch (e) { /* ignore */ }
    });
    return ctx;
  }

  /**
   * Syntax tables for one compressed video sample.
   * @param {Uint8Array} payload sample bytes (length-prefixed NALs, or Annex B)
   * @param {object} spec  { lengthSize, annexB, base, sps, pps }
   */
  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var ctx = spec.ctx || makeContext();
    var tables = [];
    var seen = {};
    var maxNals = 64;

    function handle(off, end, lenPrefix) {
      if (tables.length > 400 || maxNals-- <= 0) return;
      var res = parseNAL(payload, off, end, ctx);
      // A parameter set repeated in every sample would drown the panel.
      if (res.type === 7 || res.type === 8 || res.type === 15) {
        if (seen[res.type]) return;
        seen[res.type] = 1;
        ctx[res.type === 7 || res.type === 15 ? 'sps' : 'pps'] = res.info;
      }
      if (lenPrefix != null) {
        // Show the length prefix as the first syntax row — it is part of avcC framing.
        var pre = res.tables.length && res.tables[0].rows.length
          ? res.tables[0].rows[0] : null;
        var lenRow = {
          name: 'nalUnitLength', syntax: 'u(' + spec.lengthSize * 8 + ')',
          bits: spec.lengthSize * 8, value: end - off, note: 'length prefix',
          offset: (spec.base || 0) + 0, depth: 0
        };
        res.tables.forEach(function (t) {
          t.rows = [lenRow].concat(t.rows);
        });
      }
      res.tables.forEach(function (t) { tables.push(t); });
    }

    if (spec.annexB) {
      var units = MA.annexBUnits(payload, payload.length);
      for (var i = 0; i < units.length; i++) handle(units[i].start, units[i].end, null);
    } else {
      var nals = MA.splitLengthPrefixedNals(payload, spec.lengthSize || 4, 1, 0, payload.length);
      for (var j = 0; j < nals.length; j++) {
        if (nals[j].type < 0) continue;
        handle(nals[j].payloadOff, nals[j].payloadOff + nals[j].payloadLen,
               spec.lengthSize || 4);
      }
    }
    if (!tables.length) {
      tables.push(synSection('sample', 'No NAL unit could be extracted.', [
        { name: 'length', syntax: '', bits: payload.length * 8, value: payload.length + ' bytes',
          note: '', offset: spec.base || 0, depth: 0 }
      ]));
    }
    return tables;
  }

  /**
   * Analyse a complete raw H.264 Annex-B elementary stream (.264 / .h264).
   * @returns {{ tables, frames, track, info }}
   */
  function analyzeAnnexB(data, ctxIn) {
    var units = MA.annexBUnits(data, data.length);
    var ctx = ctxIn || makeContext();
    var tables = [];
    var frames = [];
    var info = { nalCount: units.length };
    var idrCount = 0, nonIdr = 0, seiCount = 0;

    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var h = data[u.start];
      if (h === undefined) continue;
      var type = h & 0x1f, refIdc = (h >> 5) & 3;

      if (type === 7 || type === 15) {
        var sps = parseSPS(unescapeRbsp(data, u.start + 1, u.end), u.start + 1);
        if (sps.info) { ctx.sps = sps.info; ctx.spsById[sps.info.spsId] = sps.info; }
        tables.push(synSection('SPS[' + i + '] seq_parameter_set_rbsp()',
          'NAL unit type 7 @ ' + MA.hex(u.sc, 8), sps.rows));
        Object.assign(info, {
          width: sps.info.width, height: sps.info.height,
          profile: sps.info.profile, level: sps.info.level,
          fps: sps.info.fps, chromaFormat: sps.info.chromaFormatIdc,
          colour: sps.info.colour
        });
      } else if (type === 8) {
        var pps = parsePPS(unescapeRbsp(data, u.start + 1, u.end), u.start + 1);
        if (pps.info) { ctx.pps = pps.info; ctx.ppsById[pps.info.ppsId] = pps.info; }
        tables.push(synSection('PPS[' + i + '] pic_parameter_set_rbsp()',
          '@ ' + MA.hex(u.sc, 8), pps.rows));
      } else if (type === 1 || type === 5) {
        var active = null;
        try {
          var probe = new MA.BitReader(unescapeRbsp(data, u.start + 1, u.end), 0, null, true);
          probe.ue(); probe.ue();
          active = ctx.ppsById[probe.ue()];
        } catch (e) { active = null; }
        var sl = parseSliceHeader(unescapeRbsp(data, u.start + 1, u.end),
          { type: type, refIdc: refIdc }, ctx.sps, active || ctx.pps, u.start + 1);
        if (type === 5) idrCount++; else nonIdr++;
        frames.push({
          index: frames.length,
          type: type === 5 ? 'I' : (sl.info.sliceType || '?'),
          keyframe: type === 5,
          codec: 'h264',
          offset: u.sc,
          size: u.len,
          nalType: type,
          frameNum: sl.info.frameNum,
          pocLsb: sl.info.picOrderCntLsb,
          sliceQp: sl.info.sliceQpDelta == null ? null : (active && active.picInitQp || 26) + sl.info.sliceQpDelta,
          syntax: {
            codec: 'h264', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len,
            _cached: synSection('slice_header()',
              nalTypeName(type) + (sl.info.sliceType ? ', ' + sl.info.sliceType + ' slice' : '') +
              ' @ ' + MA.hex(u.sc, 8), sl.rows)
          }
        });
      } else if (type === 6) {
        seiCount++;
        var sei = parseSEI(unescapeRbsp(data, u.start + 1, u.end), u.start + 1);
        if (sei.info && sei.info.hdr) info.hdr = MA.hdrSEI.merge(info.hdr, sei.info.hdr);
        frames.push({
          index: frames.length, type: 'SEI', keyframe: false, codec: 'h264',
          offset: u.sc, size: u.len, nalType: 6,
          syntax: { codec: 'h264', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len, _cached: sei.tables }
        });
      } else if (type === 9) {
        frames.push({
          index: frames.length, type: 'AUD', keyframe: false, codec: 'h264',
          offset: u.sc, size: u.len, nalType: 9,
          syntax: { codec: 'h264', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len }
        });
      }
    }
    info.idrCount = idrCount;
    info.nonIdrCount = nonIdr;
    info.seiCount = seiCount;
    var track = {
      id: 1, type: 'video', codec: 'h264', codecName: 'H.264 / AVC',
      profile: info.profile, level: info.level,
      width: info.width, height: info.height, fps: info.fps,
      sampleCount: frames.length,
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

  MA.registerCodec('h264', {
    id: 'h264',
    name: 'H.264 / AVC',
    nalTypeName: nalTypeName,
    profiles: PROFILES,
    levels: LEVELS,
    parseAVCC: parseAVCC,
    parseSPS: parseSPS,
    parsePPS: parsePPS,
    parseSliceHeader: parseSliceHeader,
    parseSEI: parseSEI,
    parseNAL: parseNAL,
    ctxFromAVCC: ctxFromAVCC,
    makeContext: makeContext,
    buildSampleSyntax: buildSampleSyntax,
    analyzeAnnexB: analyzeAnnexB
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
