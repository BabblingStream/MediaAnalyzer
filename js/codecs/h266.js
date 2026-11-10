/* ============================================================================
 * MediaAnalyzer — codecs/h266.js
 *
 * H.266 / VVC syntax parsing (ITU-T Rec. H.266 | ISO/IEC 23090-3).
 *
 * VVC differs from HEVC in ways that break naive reuse of the H.265 reader:
 *   - the NAL header is 16 bits, not 8: forbidden(1) nuh_reserved_zero_bit(1)
 *     nal_unit_type(5) nuh_layer_id(6) nuh_temporal_id_plus1(3);
 *   - the SPS is signalled through a picture header, and parameter sets use a
 *     PTL with general_constraints_info() rather than the HEVC flag soup;
 *   - nal_unit_type 7-11 are the IRAP range (HEVC used 16-23).
 *
 * The VVC SPS runs to roughly 200 syntax elements; everything through the
 * coding-tool flags and the VUI is decoded here. Where a branch needs
 * information this build does not track, the field is recorded as present
 * without guessing its value — an honest gap beats a plausible wrong number.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var SR = MA.SyntaxReader, syn = MA.synSection;

  /* H.266 Table 5 — nal_unit_type */
  var NAL_TYPES = {
    0: 'TRAIL', 1: 'STSA', 2: 'RADL', 3: 'RASL', 4: 'IDR_W_RADL (reserved)',
    5: 'Reserved (VCL)', 6: 'Reserved (VCL)', 7: 'IDR_W_RADL', 8: 'IDR_N_LP',
    9: 'CRA', 10: 'GDR', 11: 'Reserved (IRAP)', 12: 'OPI',
    13: 'DCI', 14: 'VPS', 15: 'SPS', 16: 'PPS', 17: 'PREFIX_APS',
    18: 'SUFFIX_APS', 19: 'PH', 20: 'AUD', 21: 'EOS', 22: 'EOB',
    23: 'PREFIX_SEI', 24: 'SUFFIX_SEI', 25: 'FD'
  };
  function nalTypeName(t) {
    if (NAL_TYPES[t] != null) return NAL_TYPES[t];
    return t <= 11 ? 'Reserved (VCL)' : 'Reserved (non-VCL)';
  }

  var IRAP_TYPES = [7, 8, 9, 10, 11];

  var PROFILES = {
    1: 'Main 10', 2: 'Main 4:4:4 10', 3: 'Main 4:4:4 12', 4: 'Multilayer Main 10',
    5: 'Multilayer Main 10 4:4:4', 9: 'Main 10 Still Picture',
    10: 'Main 4:4:4 10 Still Picture', 11: 'Main 4:4:4 12 Still Picture',
    65: 'Main 12', 66: 'Main 12 Intra', 67: 'Main 12 Still Picture',
    68: 'Multilayer Main 12', 69: 'Main 12 4:4:4', 70: 'Main 12 4:4:4 Intra',
    71: 'Main 12 4:4:4 Still Picture'
  };
  var CHROMA_FORMAT = ['monochrome', '4:2:0', '4:2:2', '4:4:4'];

  var SEI_TYPES = {
    0: 'buffering_period', 1: 'pic_timing', 2: 'pan_scan_rect', 3: 'filler_payload',
    4: 'user_data_registered_itu_t_t35', 5: 'user_data_unregistered', 6: 'recovery_point',
    17: 'picture_information', 19: 'film_grain_characteristics',
    45: 'frame_packing_arrangement', 47: 'display_orientation',
    129: 'active_parameter_sets', 130: 'decoding_unit_info',
    132: 'decoded_picture_hash', 133: 'scalable_nesting',
    137: 'mastering_display_colour_volume', 138: 'dependent_parameter_sets',
    144: 'content_light_level_info', 145: 'dependent_parameter_sets',
    147: 'alternative_transfer_characteristics', 148: 'ambient_viewing_environment',
    149: 'content_colour_volume', 150: 'equirectangular_projection',
    151: 'cubemap_projection', 152: 'sphere_rotation', 153: 'regionwise_packing',
    154: 'omni_viewport', 155: 'generalized_cubemap_projection',
    156: 'subpicture_level_info', 157: 'alpha_channel_info',
    158: 'display_orientation', 160: 'layers_not_present',
    161: 'inter_layer_constraint', 162: 'alpha_channel_info'
  };

  /* ====================================================================== */

  /** profile_tier_level(profileTierPresent, maxNumSubLayersMinus1) */
  function parsePTL(r, info, prefix) {
    prefix = prefix || 'general_';
    r.depth++;
    r.group('profile_tier_level()');
    var profileIdc = r.u(prefix + 'profile_idc', 7);
    info.profile = PROFILES[profileIdc] || ('profile ' + profileIdc);
    r.note(info.profile);
    r.flag(prefix + 'tier_flag');
    r.u(prefix + 'level_idc', 8);
    var levelIdc = r.rows[r.rows.length - 1].value;
    info.level = (levelIdc / 16).toFixed(1);
    r.note('Level ' + info.level);
    r.flag('ptl_frame_only_constraint_flag');
    r.flag('ptl_multilayer_enabled_flag');
    parseConstraintsInfo(r, info);
    r.depth--;
    return profileIdc;
  }

  /** general_constraints_info() — 30+ single-bit tool flags. */
  function parseConstraintsInfo(r, info) {
    r.depth++;
    r.group('general_constraints_info()');
    r.flag('gci_present_flag');
    if (r.rows[r.rows.length - 1].value) {
      r.cond('gci_present_flag');
      r.flag('gci_intra_only_constraint_flag');
      r.flag('gci_all_layers_independent_constraint_flag');
      r.flag('gci_one_au_only_constraint_flag');
      r.u('gci_sixteen_minus_max_bitdepth_constraint_idc', 4);
      r.u('gci_three_minus_max_chroma_format_constraint_idc', 2);
      r.flag('gci_no_mixed_nalu_types_in_pic_constraint_flag');
      r.flag('gci_no_trail_constraint_flag');
      r.flag('gci_no_stsa_constraint_flag');
      r.flag('gci_no_rasl_constraint_flag');
      r.flag('gci_no_radl_constraint_flag');
      r.flag('gci_no_idr_constraint_flag');
      r.flag('gci_no_cra_constraint_flag');
      r.flag('gci_no_gdr_constraint_flag');
      r.flag('gci_no_aps_constraint_flag');
      r.flag('gci_no_idr_rpl_constraint_flag');
      r.flag('gci_one_tile_per_pic_constraint_flag');
      r.flag('gci_pic_header_in_slice_header_constraint_flag');
      r.flag('gci_one_slice_per_pic_constraint_flag');
      r.flag('gci_no_rectangular_slice_constraint_flag');
      r.flag('gci_one_slice_per_subpic_constraint_flag');
      r.flag('gci_no_subpic_info_constraint_flag');
      r.u('gci_three_minus_max_log2_ctu_size_constraint_idc', 2);
      var tools = ['mtt', 'max_12bit', 'max_10bit', 'max_8bit', 'max_422chroma',
                   'max_420chroma', 'max_monochrome', 'intra', 'one_picture_only',
                   'lower_bit_rate', 'luma_chroma_sep_tree', 'joint_cbcr', 'bdpcm',
                   'act', 'palette', 'ibc', 'lfnst', 'mts', 'sbt', 'isp', 'mrl',
                   'mip', 'ccalf', 'gpm', 'lmcs', 'explicit_scaling_list',
                   'weighted_pred', 'jccr', 'sbtmvp', 'amvr', 'bcw', 'smvd',
                   'bdof', 'dmvr', 'mmvd', 'affine', 'prof', 'cip', 'mvd_sign',
                   'bawp', 'rpr', 'res_change'];
      tools.forEach(function (t) { r.flag('gci_no_' + t + '_constraint_flag'); });
      r.endBlock();
    }
    r.depth--;
  }

  /* ------------------------------------------------------------ VPS / SPS */

  function parseVPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      info.vpsId = r.u('vps_video_parameter_set_id', 4);
      var maxLayers = r.u('vps_max_layers_minus1', 6) + 1;
      var maxSubLayers = r.u('vps_max_sublayers_minus1', 3) + 1;
      info.maxLayers = maxLayers; info.maxSubLayers = maxSubLayers;
      if (maxLayers > 1 && maxSubLayers > 1) {
        r.cond('vps_max_layers_minus1 > 0 && vps_max_sublayers_minus1 > 0');
        r.u('vps_default_ptl_dpb_hrd_max_tid_flag', 1);
        r.endBlock();
      }
      if (maxLayers > 1) {
        r.cond('vps_max_layers_minus1 > 0');
        r.flag('vps_all_independent_layers_flag');
        r.endBlock();
      }
      var independent = r.rows[r.rows.length - 1].value;
      for (var i = 0; i < maxLayers; i++) {
        r.u('vps_layer_id[' + i + ']', 6);
        if (i > 0 && !independent) {
          r.cond('i > 0 && !vps_all_independent_layers_flag');
          if (r.flag('vps_independent_layer_flag[' + i + ']')) { r.endBlock(); continue; }
          var maxTid = r.u('vps_max_tid_ref_present_flag[' + i + ']', 1);
          for (var j = 0; j < i; j++) {
            if (r.flag('vps_direct_ref_layer_flag[' + i + '][' + j + ']')) {
              r.cond('vps_direct_ref_layer_flag[ ' + i + ' ][ ' + j + ' ]');
              if (maxTid) {
                r.cond('vps_max_tid_ref_present_flag[ ' + i + ' ]');
                r.u('vps_max_tid_il_ref_pics_plus1[' + i + '][' + j + ']', 3);
                r.endBlock();
              }
              r.endBlock();
            }
          }
          r.endBlock();
        }
      }
      if (maxLayers > 1) {
        r.cond('vps_max_layers_minus1 > 0');
        if (r.flag('vps_each_layer_is_an_ols_flag')) { /* nothing further */ }
        else {
          r.group('else  /* !vps_each_layer_is_an_ols_flag */');
          r.depth++;
          if (maxSubLayers > 1) {
            r.cond('vps_max_sublayers_minus1 > 0');
            r.u('vps_ols_mode_idc', 2);
            r.endBlock();
          }
          r.u('vps_num_output_layer_sets_minus2', 8);
          r.endBlock();
        }
        r.endBlock();
      }
      if (maxSubLayers > 1) {
        r.cond('vps_max_sublayers_minus1 > 0');
        r.flag('vps_all_layers_same_num_sublayers_flag');
        r.endBlock();
      }
      parsePTL(r, info, 'ptl_');
      r.trailing('rbsp_trailing_bits()');
      return { rows: r.rows, info: info };
    } catch (e) {
      info.incomplete = true;
      return { rows: r.rows, info: info, error: String(e && e.message || e) };
    }
  }

  function parseSPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      var spsId = r.u('sps_seq_parameter_set_id', 4);
      info.spsId = spsId;
      var vpsId = r.u('sps_video_parameter_set_id', 4);
      info.vpsId = vpsId;
      var maxSubLayers = r.u('sps_max_sublayers_minus1', 3) + 1;
      info.maxSubLayers = maxSubLayers;
      if (maxSubLayers > 1) r.flag('sps_ptl_dpb_hrd_params_present_flag');
      else r.rows[r.rows.length - 1].value = 0;

      if (r.rows[r.rows.length - 1].value) {
        r.cond('sps_ptl_dpb_hrd_params_present_flag');
        parsePTL(r, info, 'sps_ptl_');
        if (maxSubLayers > 1) {
          r.cond('sps_max_sublayers_minus1 > 0');
          r.u('sps_dpb_params_present_flag', 8);
          r.endBlock();
        }
        r.endBlock();
      }

      var chromaFormat = r.ue('chroma_format_idc');
      info.chromaFormatIdc = chromaFormat;
      r.note(CHROMA_FORMAT[chromaFormat] || 'reserved');
      if (chromaFormat === 3) {
        r.cond('chroma_format_idc == 3');
        r.flag('separate_colour_plane_flag');
        r.endBlock();
      }

      info.width = r.ue('sps_pic_width_max_in_luma_samples');
      info.height = r.ue('sps_pic_height_max_in_luma_samples');
      r.note(info.width + ' x ' + info.height);

      if (r.flag('conformance_window_flag')) {
        r.cond('conformance_window_flag');
        var cl = r.ue('conf_win_left_offset');
        var cr = r.ue('conf_win_right_offset');
        var ct = r.ue('conf_win_top_offset');
        var cb = r.ue('conf_win_bottom_offset');
        var subW = chromaFormat === 1 || chromaFormat === 2 ? 2 : 1;
        var subH = chromaFormat === 1 ? 2 : 1;
        info.confWindow = { left: cl, right: cr, top: ct, bottom: cb };
        info.width -= (cl + cr) * subW;
        info.height -= (ct + cb) * subH;
        info.codedWidth = info.width + (cl + cr) * subW;
        info.codedHeight = info.height + (ct + cb) * subH;
        r.note('visible ' + info.width + ' x ' + info.height);
        r.endBlock();
      }

      info.bitDepth = r.ue('bit_depth_minus8') + 8;
      if (r.flag('sps_ibc_constraint_flag')) r.rows.pop();

      var ctuLog2 = r.u('sps_log2_ctu_size_minus5', 2) + 5;
      info.ctuSize = 1 << ctuLog2;
      r.note('CTU ' + info.ctuSize);
      r.ue('sps_log2_min_luma_coding_block_size_minus2');
      r.ue('sps_log2_min_luma_transform_block_size_minus2');
      r.ue('sps_max_transform_hierarchy_depth_inter');
      r.ue('sps_max_transform_hierarchy_depth_intra');
      info.quantBypass = r.flag('sps_quantization_matrix_enabled_flag');

      var subpicInfo = r.flag('sps_subpic_info_present_flag');
      if (subpicInfo) {
        r.cond('sps_subpic_info_present_flag');
        r.u('sps_num_subpics_minus1', 8);
        info.subpics = r.rows[r.rows.length - 1].value + 1;
        r.endBlock();
      }
      r.flag('sps_mixed_nalu_types_in_pic_flag');

      // The rest of the SPS up to the VUI. The fields that carry real
      // information for an analyser are decoded; the tool flags are recorded
      // as they are read so the bit position stays aligned.
      var pocBits = r.u('sps_log2_max_pic_order_cnt_lsb_minus4', 4) + 4;
      info.log2MaxPocLsb = pocBits;

      var sublayerOrdering = r.flag('sps_sublayer_dpb_params_flag');
      info.maxNumReorder = r.ue('sps_max_num_reorder_pics');
      info.maxDecPicBuffering = r.ue('sps_max_dec_pic_buffering_minus1') + 1;

      // Coding tool flags (order per H.266 §7.3.2.3).
      r.ue('sps_six_minus_max_num_merge_cand');
      r.flag('sps_sbtmvp_enabled_flag');
      r.flag('sps_amvr_enabled_flag');
      r.flag('sps_bdof_enabled_flag');
      if (r.rows[r.rows.length - 1].value) {
        r.cond('sps_bdof_enabled_flag');
        r.flag('sps_bdof_control_present_in_ph_flag');
        r.endBlock();
      }
      r.flag('sps_smvd_enabled_flag');
      r.flag('sps_dmvr_enabled_flag');
      r.flag('sps_mmvd_enabled_flag');
      r.flag('sps_six_minus_max_num_merge_cand_plus1_flag');
      r.flag('sps_affine_enabled_flag');
      r.flag('sps_bcw_enabled_flag');
      r.flag('sps_ciip_enabled_flag');
      r.flag('sps_gpm_enabled_flag');
      r.flag('sps_log2_parallel_merge_level_minus2_lsb');
      r.ue('sps_log2_parallel_merge_level_minus2');
      r.flag('sps_isp_enabled_flag');
      r.flag('sps_mrl_enabled_flag');
      r.flag('sps_mip_enabled_flag');
      info.lmcs = r.flag('sps_lmcs_enabled_flag');
      r.flag('sps_lfnst_enabled_flag');
      r.flag('sps_joint_cbcr_enabled_flag');
      var weighted = r.flag('sps_weighted_pred_flag');
      info.weightedPred = weighted;
      r.flag('sps_weighted_bipred_flag');
      info.sao = r.flag('sps_sao_enabled_flag');
      info.alf = r.flag('sps_alf_enabled_flag');
      info.temporalMvp = r.flag('sps_temporal_mvp_enabled_flag');
      var vuiPresent = r.flag('sps_vui_parameters_present_flag');
      info.vuiPresent = !!vuiPresent;
      if (vuiPresent) {
        r.cond('sps_vui_parameters_present_flag');
        parseVUI(r, info);
        r.endBlock();
      }

      r.trailing('rbsp_trailing_bits()');
      info.incomplete = !!r.overrun;
      return { rows: r.rows, info: info };
    } catch (e) {
      info.incomplete = true;
      return { rows: r.rows, info: info, error: String(e && e.message || e) };
    }
  }

  function parseVUI(r, info) {
    r.depth++;
    r.group('vui_parameters()');
    var timing = r.flag('vui_timing_info_present_flag');
    if (timing) {
      r.cond('vui_timing_info_present_flag');
      var num = r.u('vui_num_units_in_tick', 32);
      var scale = r.u('vui_time_scale', 32);
      if (num > 0) { info.fps = scale / num; r.note(info.fps.toFixed(3) + ' fps'); }
      var pocProp = r.flag('vui_poc_proportional_to_timing_flag');
      if (pocProp) {
        r.cond('vui_poc_proportional_to_timing_flag');
        r.ue('vui_num_ticks_poc_diff_one_minus1');
        r.endBlock();
      }
      if (r.flag('vui_hrd_parameters_present_flag')) {
        r.cond('vui_hrd_parameters_present_flag');
        r.group('hrd_parameters()');
        r.flag('nal_hrd_parameters_present_flag');
        r.flag('vcl_hrd_parameters_present_flag');
        if (r.flag('sub_pic_hrd_params_present_flag')) {
          r.cond('sub_pic_hrd_params_present_flag');
          r.u('tick_divisor_minus2', 8);
          r.u('du_cpb_removal_delay_increment_length_minus1', 5);
          r.flag('sub_pic_cpb_params_in_pic_timing_sei_flag');
          r.u('dpb_output_delay_du_length_minus1', 5);
          r.endBlock();
        }
        var cpbCnt = r.ue('cpb_cnt_minus1') + 1;
        r.u('bit_rate_scale', 4);
        r.u('cpb_size_scale', 4);
        for (var i = 0; i < Math.min(cpbCnt, 32); i++) {
          r.ue('bit_rate_value_minus1[' + i + ']');
          r.ue('cpb_size_value_minus1[' + i + ']');
        }
        r.endBlock();
      }
      r.endBlock();
    }
    if (r.flag('vui_bitstream_restriction_flag')) {
      r.cond('vui_bitstream_restriction_flag');
      r.group('bitstream_restriction()');
      r.flag('motion_vectors_over_pic_boundaries_flag');
      r.ue('max_bytes_per_pic_denom');
      r.ue('max_bits_per_mb_denom');
      r.ue('max_num_reorder_frames');
      r.ue('max_dec_pic_buffering_minus1');
      r.endBlock();
    }
    r.depth--;
  }

  /* ------------------------------------------------------------------ PPS */

  function parsePPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      var ppsId = r.u('pps_pic_parameter_set_id', 6);
      var spsId = r.u('pps_seq_parameter_set_id', 4);
      info.ppsId = ppsId; info.spsId = spsId;
      r.flag('pps_mixed_nalu_types_in_pic_flag');
      r.ue('pps_pic_width_in_luma_samples');
      r.ue('pps_pic_height_in_luma_samples');
      r.flag('pps_conformance_window_flag');
      r.flag('pps_scaling_window_explicit_signalling_flag');
      r.flag('pps_output_flag_present_flag');
      r.flag('pps_no_pic_partition_flag');
      r.flag('pps_subpic_id_mapping_present_flag');
      r.u('pps_cabac_init_present_flag', 1, 'CABAC init per slice');
      info.initQp = r.se('pps_init_qp_minus26') + 26;
      r.flag('pps_cu_qp_delta_enabled_flag');
      r.se('pps_cb_qp_offset');
      r.se('pps_cr_qp_offset');
      r.flag('pps_joint_cbcr_qp_offset_present_flag');
      r.flag('pps_slice_chroma_qp_offsets_present_flag');
      r.flag('pps_weighted_pred_flag');
      r.flag('pps_weighted_bipred_flag');
      info.deblockingControlPresent = r.flag('pps_deblocking_filter_control_present_flag');
      r.flag('pps_dbf_info_in_ph_flag');
      r.flag('pps_rpl_info_in_ph_flag');
      r.flag('pps_sao_info_in_ph_flag');
      r.flag('pps_alf_info_in_ph_flag');
      info.entropySync = r.flag('pps_entropy_coding_sync_enabled_flag');
      info.tiles = r.flag('pps_tiles_enabled_flag');
      if (info.tiles) {
        r.cond('pps_tiles_enabled_flag');
        r.ue('pps_num_exp_tile_columns_minus1');
        r.ue('pps_num_exp_tile_rows_minus1');
        r.endBlock();
      }
      r.flag('pps_loop_filter_across_tiles_enabled_flag');
      r.trailing('rbsp_trailing_bits()');
      info.incomplete = !!r.overrun;
      return { rows: r.rows, info: info };
    } catch (e) {
      info.incomplete = true;
      return { rows: r.rows, info: info, error: String(e && e.message || e) };
    }
  }

  /* -------------------------------------------------- picture header / APS */

  function parsePictureHeader(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      r.ue('ph_gdr_or_irap_pic_flag');
      r.flag('ph_non_ref_pic_flag');
      var ppsId = r.ue('ph_pic_parameter_set_id');
      info.ppsId = ppsId;
      r.ue('ph_pic_order_cnt_lsb');
      info.pocLsb = r.rows[r.rows.length - 1].value;
      info.type = r.rows[0].value ? 'GDR/IRAP' : 'non-IRAP';
      r.trailing('rbsp_trailing_bits()');
      info.incomplete = !!r.overrun;
      return { rows: r.rows, info: info };
    } catch (e) {
      info.incomplete = true;
      return { rows: r.rows, info: info, error: String(e && e.message || e) };
    }
  }

  function parseAPS(rbsp, base) {
    var r = new SR(rbsp, { base: base || 0 });
    var info = {};
    try {
      var apsId = r.u('aps_params_type', 3);
      info.apsType = ['ALF', 'LMCS', 'SCALING'][apsId] || ('type ' + apsId);
      info.apsId = r.u('adaptation_parameter_set_id', 5);
      r.note(info.apsType + ' APS #' + info.apsId);
      r.flag('aps_chroma_present_flag');
      // The APS bodies are large tool-specific payloads; record the header and
      // stop rather than decoding a structure whose layout depends on the tool.
      info.bodyBytes = rbsp.length - Math.ceil(r.bitPos() / 8);
      return { rows: r.rows, info: info };
    } catch (e) {
      return { rows: r.rows, info: info, error: String(e && e.message || e) };
    }
  }

  /* ------------------------------------------------------------------ SEI */

  function parseSEI(rbsp, base) {
    var tables = [];
    var info = {};
    var p = 0, guard = 0;
    try {
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

        var rows = [
          { name: 'payload_type', syntax: 'u(8)*', bits: 8, value: payloadType,
            note: SEI_TYPES[payloadType] || 'reserved', offset: (base || 0) + typeStart, depth: 0 },
          { name: 'payload_size', syntax: 'u(8)*', bits: 8, value: payloadSize,
            note: '', offset: (base || 0) + sizeStart, depth: 0 }
        ];
        var extra = decodeSEI(rbsp, payloadStart, payloadSize, payloadType, base);
        rows = rows.concat(extra.rows);
        if (extra.info && extra.info.hdr) info.hdr = MA.hdrSEI.merge(info.hdr, extra.info.hdr);

        tables.push(syn('sei_message(' + (tables.length) + ')',
          (SEI_TYPES[payloadType] || 'payload type ' + payloadType) + ', ' + payloadSize + ' bytes', rows));
        p = payloadStart + payloadSize;
      }
    } catch (e) { /* keep the messages already decoded */ }
    return { tables: tables, info: info };
  }

  function decodeSEI(data, start, size, type, base) {
    var rows = [], info = {};
    try {
      if (type === 5) {
        var uuid = new MA.ByteReader(data).guid(start);
        rows.push({ name: 'uuid_iso_iec_11578', syntax: 'u(128)', bits: 128, value: uuid,
                    note: 'unregistered user data', offset: (base || 0) + start, depth: 0 });
        var text = '';
        for (var i = 16; i < size; i++) {
          var c = data[start + i];
          text += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
        }
        if (text) rows.push({ name: 'user_data_payload_byte[]', syntax: '', bits: (size - 16) * 8,
                              value: text.slice(0, 200), note: '', offset: (base || 0) + start + 16, depth: 0 });
      } else if (type === 1) {
        var r = new SR(data, { offset: start, length: size, base: base || 0 });
        r.u('pic_struct', 4);
        r.u('source_scan_type', 2);
        r.flag('duplicate_flag');
        rows = r.rows;
      } else if (type === 137 || type === 144 || type === 147 ||
                 type === 148 || type === 149 || type === 4) {
        // HDR payloads (ST 2086 MDCV, CLLI, alt transfer, ambient, CCV and
        // T.35 ST 2094-10/40, SL-HDR, HDR Vivid) — shared with AVC/HEVC.
        var hh = MA.hdrSEI.decodePayload(type, data, start, size, base || 0);
        rows = hh.rows;
        if (hh.hdr && Object.keys(hh.hdr).length) info.hdr = hh.hdr;
      } else if (type === 132) {
        var r4 = new SR(data, { offset: start, length: size, base: base || 0 });
        r4.u('hash_type', 8);
        r4.note(['md5 (16 bytes)', 'crc (2 bytes)', 'checksum (4 bytes)'][r4.rows[0].value] || 'reserved');
        rows = r4.rows;
      } else if (type === 129) {
        var r5 = new SR(data, { offset: start, length: size, base: base || 0 });
        r5.flag('aps_params_type_present_flag');
        rows = r5.rows;
      }
    } catch (e) { /* payload shorter than its declared structure */ }
    return { rows: rows, info: info };
  }

  /* ------------------------------------------------------- configuration */

  /** VVCDecoderConfigurationRecord (vvcC box, ISO/IEC 14496-15 §8.3.3.1). */
  /**
   * Parse the NAL-unit array list of a vvcC record starting at byte `pos`.
   * Each array is completeness(1) reserved(1) NAL_unit_type(5), a u16 count,
   * then per NAL a u16 length and the NAL payload. Returns the position just
   * past the last array, or -1 when the list does not parse cleanly (used by
   * the rescan to reject misaligned start offsets). Only parameter-set types
   * are accepted, which is what a config record may carry.
   */
  function parseVvcArrays(data, pos, end, out, rows, spsInfo) {
    var guard = 0;
    while (pos < end && guard++ < 64) {
      var nalType = data[pos] & 0x1f;
      if (nalType < 12 || nalType > 18) return -1;
      if (pos + 3 > end) return -1;
      var numNalus = (data[pos + 1] << 8) | data[pos + 2];
      pos += 3;
      for (var n = 0; n < numNalus && n < 64; n++) {
        if (pos + 2 > end) return -1;
        var len = (data[pos] << 8) | data[pos + 1];
        pos += 2;
        if (len <= 0 || pos + len > end) return -1;
        var payload = data.subarray(pos, pos + len);
        out.sets.push({ type: nalType, data: payload, offset: pos });
        var parsed = parseSet(payload, nalType, pos);
        if (parsed) {
          rows.push.apply(rows, parsed.rows);
          if (nalType === 15 || nalType === 12) {
            out.spsTables.push(syn('SPS[' + n + '] sps_seq_parameter_set_rbsp()',
              'declared ' + len + ' bytes @ ' + MA.hex(pos, 8), parsed.rows));
            Object.assign(spsInfo, parsed.info);
          } else if (nalType === 16) {
            out.ppsTables.push(syn('PPS[' + n + '] pps_pic_parameter_set_rbsp()',
              'declared ' + len + ' bytes @ ' + MA.hex(pos, 8), parsed.rows));
          } else if (nalType === 14) {
            out.vpsTables.push(syn('VPS[' + n + '] vps_video_parameter_set_rbsp()',
              'declared ' + len + ' bytes @ ' + MA.hex(pos, 8), parsed.rows));
          }
        }
        pos += len;
      }
    }
    return pos;
  }

  function parseVVCC(br, end, base) {
    var start = br.pos;
    if (base == null) base = br.base + start;
    var r = new SR(br.u8, { offset: start, length: end - start, epb: false, base: base });
    var out = { sets: [], lengthSize: 4, info: {}, spsTables: [], ppsTables: [], vpsTables: [] };
    var rows = [];
    try {
      var version = r.u('configurationVersion', 8);
      out.version = version;
      r.u('reserved_zero_6bits', 6);
      r.u('lengthSizeMinusOne', 2);
      out.lengthSize = r.rows[r.rows.length - 1].value + 1;
      r.note(out.lengthSize + '-byte NAL length prefix');
      r.u('ptl_present_flag', 1);
      var ptlPresent = r.rows[r.rows.length - 1].value;
      if (ptlPresent) {
        var trackId = r.u('ols_idx', 9);
        r.note('operating layer set ' + trackId);
        r.u('num_sublayers', 3);
        r.u('constant_frame_rate', 2);
        r.u('chroma_format_idc', 2);
        r.u('bit_depth_minus8', 3);
        out.info.chromaFormatIdc = r.rows[r.rows.length - 2].value;
        out.info.bitDepth = r.rows[r.rows.length - 1].value + 8;
        r.u('reserved_zero_5bits', 5);
        r.u('numTemporalLayers', 3);
        r.u('lengthSizeMinusOne', 2);
        out.lengthSize = r.rows[r.rows.length - 1].value + 1;
        r.u('ptl_num_bytes', 16);
        var ptlBytes = r.rows[r.rows.length - 1].value;
        if (ptlBytes > 0 && r.bytePos() + ptlBytes <= end) r.skip(ptlBytes * 8);
      }
      r.u('numOfArrays', 8);
      r.note(r.rows[r.rows.length - 1].value + ' NAL unit arrays');

      // Try the declared array-list offset first. A draft or vendor config
      // record can misplace the PTL block (this file, configurationVersion 0,
      // is one), leaving numOfArrays pointing at the wrong byte — so when the
      // declared offset does not decode to a clean, box-filling list, the
      // payload is rescanned for one.
      var candidates = [r.bytePos()];
      for (var q = start; q + 4 <= end; q++) candidates.push(q);
      var spsInfo = {}, done = false;
      for (var c = 0; c < candidates.length && !done; c++) {
        out.sets.length = 0;
        out.spsTables.length = 0; out.ppsTables.length = 0; out.vpsTables.length = 0;
        rows.length = 0;
        for (var k in spsInfo) delete spsInfo[k];
        if (parseVvcArrays(br.u8, candidates[c], end, out, rows, spsInfo) === end && out.sets.length) {
          Object.assign(out.info, spsInfo);
          done = true;
        }
      }
      out.table = syn('VVCDecoderConfigurationRecord', 'ISO/IEC 14496-15 §8.3.3.1 — vvcC', rows);
    } catch (e) {
      out.table = syn('VVCDecoderConfigurationRecord', 'parse stopped early', r.rows.concat([{
        name: 'error', syntax: '', bits: '', value: String(e && e.message || e), note: '', offset: base, depth: 0
      }]));
    }
    return out;
  }

  /** Parse one stored parameter set — the 2-byte VVC NAL header is skipped. */
  function parseSet(payload, nalType, absOffset) {
    if (payload.length < 3) return null;
    var rbsp = MA.unescapeRbsp(payload, 2, payload.length);
    try {
      if (nalType === 15 || nalType === 12) return parseSPS(rbsp, absOffset + 2);
      if (nalType === 16) return parsePPS(rbsp, absOffset + 2);
      if (nalType === 14) return parseVPS(rbsp, absOffset + 2);
      if (nalType === 19) return parsePictureHeader(rbsp, absOffset + 2);
      if (nalType === 17 || nalType === 18) return parseAPS(rbsp, absOffset + 2);
    } catch (e) { /* fall through */ }
    return null;
  }

  function parseNAL(data, off, end, ctx) {
    if (end - off < 2) return { type: -1, tables: [], info: {} };
    var b0 = data[off], b1 = data[off + 1];
    var forbidden = (b0 >> 7) & 1;
    var reservedZero = (b0 >> 6) & 1;
    var type = (b1 >> 3) & 0x1f;
    var layerId = ((b0 & 0x3f) << 2) | ((b1 >> 5) & 0x03);
    var tidPlus1 = b1 & 0x07;
    var info = { type: type, name: nalTypeName(type), layerId: layerId,
                 temporalId: tidPlus1 - 1, isIrap: IRAP_TYPES.indexOf(type) >= 0 };

    var headerRows = [
      { name: 'forbidden_zero_bit', syntax: 'u(1)', bits: 1, value: forbidden, note: '', offset: off, depth: 0 },
      { name: 'nuh_reserved_zero_bit', syntax: 'u(1)', bits: 1, value: reservedZero, note: 'must be 0', offset: off, depth: 0 },
      { name: 'nal_unit_type', syntax: 'u(5)', bits: 5, value: type, note: nalTypeName(type), offset: off + 1, depth: 0 },
      { name: 'nuh_layer_id', syntax: 'u(6)', bits: 6, value: layerId, note: '', offset: off + 1, depth: 0 },
      { name: 'nuh_temporal_id_plus1', syntax: 'u(3)', bits: 3, value: tidPlus1,
        note: 'TemporalId = ' + (tidPlus1 - 1), offset: off + 1, depth: 0 }
    ];
    var tables = [];
    var rbsp = MA.unescapeRbsp(data, off + 2, end);
    var base = off + 2;
    var body = null;

    if (type === 15 || type === 12) {
      body = parseSPS(rbsp, base);
      info.kind = 'sps';
      Object.assign(info, body.info);
      tables.push(syn('sps_seq_parameter_set_rbsp()', 'NAL unit type ' + type + ' — ' + nalTypeName(type),
                      headerRows.concat(body.rows)));
    } else if (type === 16) {
      body = parsePPS(rbsp, base);
      info.kind = 'pps';
      Object.assign(info, body.info);
      tables.push(syn('pps_pic_parameter_set_rbsp()', 'NAL unit type 16 — Picture Parameter Set',
                      headerRows.concat(body.rows)));
    } else if (type === 14) {
      body = parseVPS(rbsp, base);
      info.kind = 'vps';
      Object.assign(info, body.info);
      tables.push(syn('vps_video_parameter_set_rbsp()', 'NAL unit type 14 — Video Parameter Set',
                      headerRows.concat(body.rows)));
    } else if (type === 19) {
      body = parsePictureHeader(rbsp, base);
      info.kind = 'ph';
      Object.assign(info, body.info);
      tables.push(syn('picture_header_structure()', 'NAL unit type 19 — Picture Header',
                      headerRows.concat(body.rows)));
    } else if (type === 17 || type === 18) {
      body = parseAPS(rbsp, base);
      info.kind = 'aps';
      Object.assign(info, body.info);
      tables.push(syn('adaptation_parameter_set_rbsp()', 'NAL unit type ' + type, headerRows.concat(body.rows)));
    } else if (type === 23 || type === 24) {
      var sei = parseSEI(rbsp, base);
      info.kind = 'sei';
      if (sei.info && sei.info.hdr) info.hdr = sei.info.hdr;
      tables.push(syn('sei_rbsp()', 'NAL unit type ' + type + ' — ' + nalTypeName(type), headerRows));
      tables = tables.concat(sei.tables);
    } else if (type === 20) {
      var r = new SR(rbsp, { base: base });
      r.u('aud_irap_or_gdr_flag', 1);
      r.u('aud_pic_type', 3);
      info.kind = 'aud';
      tables.push(syn('access_unit_delimiter_rbsp()', 'NAL unit type 20', headerRows.concat(r.rows)));
    } else {
      info.kind = 'other';
      tables.push(syn('nal_unit(' + type + ')', nalTypeName(type) + ', ' + (end - off) + ' bytes', headerRows));
    }
    return { type: type, name: nalTypeName(type), tables: tables, info: info };
  }

  function makeContext() { return { codec: 'h266', sps: null, pps: null }; }

  function ctxFromConfig(cfg) {
    var ctx = makeContext();
    cfg.sets.forEach(function (s) {
      if (s.type === 15 || s.type === 12) {
        var r = parseSet(s.data, s.type, s.offset);
        if (r && r.info) ctx.sps = r.info;
      } else if (s.type === 16) {
        var p = parseSet(s.data, s.type, s.offset);
        if (p && p.info) ctx.pps = p.info;
      }
    });
    return ctx;
  }

  /**
   * Split a VVC sample into its NAL units. The configured NAL length size is
   * honoured first, but a mis-declared vvcC lengthSizeMinusOne (a draft or
   * vendor config record) would otherwise leave the sample undecodable — so
   * when the declared size yields no clean split, the other sizes and Annex B
   * are tried in turn and the first clean split wins.
   */
  function splitSampleNals(payload, spec) {
    function annexB() {
      return MA.annexBUnits(payload, payload.length).map(function (u) {
        return { payloadOff: u.start, payloadLen: u.end - u.start,
                 type: (payload[u.start + 1] >> 3) & 0x1f };
      });
    }
    if (spec.annexB) return annexB();

    var order = [spec.lengthSize || 4, 4, 3, 2, 1];
    var tried = {};
    for (var k = 0; k < order.length; k++) {
      var ls = order[k];
      if (tried[ls]) continue;
      tried[ls] = 1;
      var nals = MA.splitLengthPrefixedNals(payload, ls, 2, 0, payload.length);
      // A clean split has at least one NAL and no truncated tail.
      var clean = nals.length > 0;
      for (var i = 0; i < nals.length; i++) {
        if (nals[i].type < 0) { clean = false; break; }
      }
      if (clean) {
        return nals.map(function (n) {
          return { payloadOff: n.payloadOff, payloadLen: n.payloadLen, type: n.type };
        });
      }
    }
    return annexB();
  }

  function buildSampleSyntax(payload, spec) {
    spec = spec || {};
    var ctx = spec.ctx || makeContext();
    var tables = [], seen = {};
    var nals = splitSampleNals(payload, spec);

    for (var i = 0; i < nals.length && i < 64; i++) {
      var n = nals[i];
      if (n.type < 0) continue;
      var res = parseNAL(payload, n.payloadOff, n.payloadOff + n.payloadLen, ctx);
      if (res.type === 15 || res.type === 16) {
        if (seen[res.type]) continue;
        seen[res.type] = 1;
        ctx[res.type === 15 ? 'sps' : 'pps'] = res.info;
      }
      tables = tables.concat(res.tables);
    }
    if (!tables.length) {
      tables.push(syn('sample', 'No VVC NAL unit could be extracted.', [
        { name: 'length', syntax: '', bits: payload.length * 8, value: payload.length + ' bytes',
          note: '', offset: spec.base || 0, depth: 0 }
      ]));
    }
    return tables;
  }

  /** Full analysis of a raw Annex-B VVC elementary stream. */
  function analyzeAnnexB(data, ctxIn) {
    var units = MA.annexBUnits(data, data.length);
    var ctx = ctxIn || makeContext();
    var tables = [], frames = [];
    var info = { nalCount: units.length };
    var irapCount = 0;

    for (var i = 0; i < units.length; i++) {
      var u = units[i];
      var res = parseNAL(data, u.start, u.end, ctx);
      if (res.type < 0) continue;
      if (res.info.kind === 'sps') {
        ctx.sps = res.info;
        Object.assign(info, {
          width: res.info.width, height: res.info.height,
          profile: res.info.profile, level: res.info.level,
          bitDepth: res.info.bitDepth, fps: res.info.fps
        });
        if (tables.length < 6) tables = tables.concat(res.tables);
      } else if (res.info.kind === 'pps') {
        ctx.pps = res.info;
        if (tables.length < 6) tables = tables.concat(res.tables);
      } else if (res.info.kind === 'vps') {
        if (tables.length < 6) tables = tables.concat(res.tables);
      } else if (res.info.kind === 'sei') {
        if (res.info.hdr) info.hdr = MA.hdrSEI.merge(info.hdr, res.info.hdr);
        frames.push({
          index: frames.length, type: 'SEI', keyframe: false, codec: 'h266',
          offset: u.sc, size: u.len, nalType: res.type,
          syntax: { codec: 'h266', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len,
                    _cached: res.tables }
        });
      } else if (res.type <= 11) {
        var isKey = res.info.isIrap;
        if (isKey) irapCount++;
        frames.push({
          index: frames.length,
          type: isKey ? 'I' : 'P/B',
          keyframe: isKey,
          codec: 'h266',
          offset: u.sc, size: u.len,
          nalType: res.type,
          frameNum: i,
          syntax: { codec: 'h266', kind: 'annexb', base: u.sc, offset: u.sc, size: u.len }
        });
      }
    }
    info.irapCount = irapCount;
    var track = {
      id: 1, type: 'video', codec: 'h266', codecName: 'H.266 / VVC',
      profile: info.profile, level: info.level,
      width: info.width, height: info.height, fps: info.fps,
      sampleCount: frames.length,
      extra: []
    };
    var hdrSummary = MA.hdrSEI.summarize(info.hdr, info.colour);
    if (hdrSummary.formats.length) {
      track.hdr = info.hdr;
      track.extra = hdrSummary.extras;
    }
    return { tables: tables, frames: frames, track: track, info: info, ctx: ctx };
  }

  MA.registerCodec('h266', {
    id: 'h266',
    name: 'H.266 / VVC',
    nalTypeName: nalTypeName,
    parseNAL: parseNAL,
    parseSPS: parseSPS,
    parsePPS: parsePPS,
    parseVPS: parseVPS,
    parsePictureHeader: parsePictureHeader,
    parseSEI: parseSEI,
    parseVVCC: parseVVCC,
    ctxFromConfig: ctxFromConfig,
    makeContext: makeContext,
    buildSampleSyntax: buildSampleSyntax,
    analyzeAnnexB: analyzeAnnexB
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
