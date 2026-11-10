/* ============================================================================
 * MediaAnalyzer — js/codecs/hdr-sei.js
 *
 * Shared HDR metadata decoders for the H.264 / H.265 / H.266 SEI payloads
 * whose numbering is identical across all three codecs (ITU-T H.274):
 *
 *   137  mastering_display_colour_volume   — SMPTE ST 2086 (MDCV)
 *   144  content_light_level_info          — CEA-861 CLLI (MaxCLL / MaxFALL)
 *   147  alternative_transfer_characteristics
 *   148  ambient_viewing_environment        — SMPTE ST 2086 companion
 *   149  content_colour_volume (CCV)
 *   4    user_data_registered_itu_t_t35    — carrier for:
 *          SMPTE ST 2094-10  Dolby SL-HDR1   (provider 0x0031, "GA94", type 0x09)
 *          ETSI TS 103 433  SL-HDR2/3       (provider 0x003A)
 *          SMPTE ST 2094-40 HDR10+          (provider 0x003C, app 0x04)
 *          GY/T 315        HDR Vivid        (country 0x26, provider 0x0004)
 *
 * ST 2084 (PQ) and HLG are *transfer characteristics*, signalled in the SPS
 * VUI (or SEI 147), not in a SEI of their own. There is no published
 * ST 2094-50 application; apps 10/20/30/40 (and CEA app 100) are the ones in
 * use. Every decoder below works on an already-emulation-prevention-stripped
 * RBSP payload and emits plain syntax rows {name,syntax,bits,value,note,
 * offset,depth} plus a compact `hdr` summary object.
 * ==========================================================================*/
(function (global) {
  'use strict';
  var MA = global.MA || {};

  /* H.273 transfer characteristics (Table 3) — shared by VUI and SEI 147. */
  var TRANSFER = {
    1: 'BT.709', 2: 'Unspecified', 4: 'BT.470 System M', 5: 'BT.470 System B/G',
    6: 'BT.601', 7: 'SMPTE 240M', 8: 'Linear', 9: 'Logarithmic (100:1)',
    10: 'Logarithmic (316.2:1)', 11: 'xvYCC', 12: 'BT.1361', 13: 'sRGB',
    14: 'BT.2020 10-bit', 15: 'BT.2020 12-bit', 16: 'SMPTE ST 2084 (PQ)',
    17: 'SMPTE ST 428-1', 18: 'ARIB STD-B67 (HLG)'
  };
  var PRIMARIES_NAMES = ['R', 'G', 'B'];
  var SL_HDR1_BLOCK_NAMES = {
    1: 'Content Range (min/max/avg PQ)',
    2: 'Trim Pass (tone mapping)',
    3: 'PQ offsets',
    4: 'Transfer function PQ mean/stdev',
    5: 'Active area'
  };

  function transferName(v) { return TRANSFER[v] || ('reserved / unknown (' + v + ')'); }
  function isPQ(name) { return name && /ST 2084/.test(name); }
  function isHLG(name) { return name && /STD-B67|HLG/.test(name); }

  /* ------------------------------------------------------------------ */
  /* Bit cursor over a raw, already-unescaped RBSP payload.             */
  /* ------------------------------------------------------------------ */
  function Cursor(data, start, size, base) {
    this.d = data;
    this.s = start;
    this.e = start + Math.min(size, data.length - start);
    this.base = base || 0;
    this.p = 0;                         // bit offset inside the window
    this.rows = [];
  }
  Cursor.prototype.bit = function () {
    var idx = this.s + (this.p >> 3);
    if (idx >= this.e) throw new Error('SEI payload overrun');
    var v = (this.d[idx] >> (7 - (this.p & 7))) & 1;
    this.p++;
    return v;
  };
  Cursor.prototype.u = function (name, n, note) {
    var startBit = this.p;
    var v = 0;
    for (var i = 0; i < n; i++) v = (v << 1) | this.bit();
    this.rows.push({ name: name, syntax: 'u(' + n + ')', bits: n, value: v,
      note: note || '',
      offset: this.base + this.s + (startBit >> 3), depth: 0 });
    return v;
  };
  Cursor.prototype.flag = function (name, note) {
    var startBit = this.p;
    var v = this.bit();
    this.rows.push({ name: name, syntax: 'u(1)', bits: 1, value: v,
      note: note || (v ? 'true' : 'false'),
      offset: this.base + this.s + (startBit >> 3), depth: 0 });
    return v;
  };
  Cursor.prototype.ue = function (name, note) {
    var zeros = 0, pos = this.p;
    while (this.bit() === 0) { zeros++; if (zeros > 32) throw new Error('ue() overrun'); }
    var v = 1;
    for (var i = 0; i < zeros; i++) v = (v << 1) | this.bit();
    v -= 1;
    this.rows.push({ name: name, syntax: 'ue(v)', bits: this.p - pos, value: v,
      note: note || '', offset: this.base + this.s + (pos >> 3), depth: 0 });
    return v;
  };
  Cursor.prototype.note = function (text) {
    if (this.rows.length) this.rows[this.rows.length - 1].note = text;
    return text;
  };
  Cursor.prototype.absByte = function () {
    // Byte holding the field that begins at the current bit position.
    return this.base + this.s + (this.p >> 3);
  };
  Cursor.prototype.align = function (name) {
    var rem = (8 - (this.p & 7)) & 7;
    if (rem) {
      var v = 0;
      for (var i = 0; i < rem; i++) v = (v << 1) | this.bit();
      this.rows.push({ name: name || 'dm_alignment_zero_bits', syntax: 'u(' + rem + ')',
        bits: rem, value: v, note: 'byte alignment',
        offset: this.base + this.s + ((this.p - rem) >> 3), depth: 0 });
    }
  };
  Cursor.prototype.bitsLeft = function () { return (this.e - this.s) * 8 - this.p; };

  function fmt4(v) { return Number(v).toFixed(4); }

  /* ------------------------------------------------------------ MDCV */
  /* 137 — SMPTE ST 2086 mastering_display_colour_volume (24 bytes).   */
  function decodeMDCV(data, start, size, base) {
    var rows = [], hdr = {};
    var c = new Cursor(data, start, size, base);
    var prim = [];
    for (var i = 0; i < 3; i++) {
      var x = c.u('display_primaries_x[' + i + ']', 16);
      c.note(PRIMARIES_NAMES[i] + ' x = ' + fmt4(x / 50000) + ' CIE x');
      var y = c.u('display_primaries_y[' + i + ']', 16);
      c.note(PRIMARIES_NAMES[i] + ' y = ' + fmt4(y / 50000) + ' CIE y');
      prim.push([x / 50000, y / 50000]);
    }
    var wx = c.u('white_point_x', 16); c.note('D' + wx + ' — ' + fmt4(wx / 50000));
    var wy = c.u('white_point_y', 16); c.note(fmt4(wy / 50000));
    var maxL = c.u('max_display_mastering_luminance', 32);
    c.note(fmt4(maxL / 10000) + ' cd/m²');
    var minL = c.u('min_display_mastering_luminance', 32);
    c.note(fmt4(minL / 10000) + ' cd/m²');
    rows = c.rows;
    hdr.mastering = {
      primaries: prim, white: [wx / 50000, wy / 50000],
      maxLum: maxL / 10000, minLum: minL / 10000
    };
    return { rows: rows, hdr: hdr };
  }

  /* ------------------------------------------------------------ CLLI */
  /* 144 — content_light_level_info: MaxCLL + MaxFALL, u16 each.       */
  function decodeCLLI(data, start, size, base) {
    var c = new Cursor(data, start, size, base);
    var maxCLL = c.u('max_content_light_level', 16); c.note('MaxCLL ' + maxCLL + ' cd/m²');
    var maxFALL = c.u('max_pic_average_light_level', 16); c.note('MaxFALL ' + maxFALL + ' cd/m²');
    return { rows: c.rows, hdr: { maxCLL: maxCLL, maxFALL: maxFALL } };
  }

  /* SEI 147 — alternative_transfer_characteristics (1 byte).          */
  function decodeAltTransfer(data, start, size, base) {
    var c = new Cursor(data, start, size, base);
    var v = c.u('preferred_transfer_characteristics', 8);
    c.note(transferName(v));
    return { rows: c.rows, hdr: { altTransfer: { code: v, name: transferName(v) } } };
  }

  /* SEI 148 — ambient_viewing_environment (SMPTE ST 2086 §7).         */
  function decodeAmbient(data, start, size, base) {
    var c = new Cursor(data, start, size, base);
    var ill = c.u('ambient_illuminance', 32); c.note(fmt4(ill / 10000) + ' lux');
    var ax = c.u('ambient_light_x', 16); c.note(fmt4(ax / 50000) + ' CIE x');
    var ay = c.u('ambient_light_y', 16); c.note(fmt4(ay / 50000) + ' CIE y');
    return { rows: c.rows, hdr: { ambient: { illuminance: ill / 10000,
      x: ax / 50000, y: ay / 50000 } } };
  }

  /* SEI 149 — content_colour_volume (HEVC D.2.31).                    */
  function decodeCCV(data, start, size, base) {
    var rows = [], hdr = { ccv: {} };
    var c = new Cursor(data, start, size, base);
    var cancel = c.flag('ccv_cancel_flag');
    if (!cancel) {
      c.flag('ccv_persistence_flag');
      var pp = c.flag('ccv_primaries_present_flag');
      var minP = c.flag('ccv_min_luminance_value_present_flag');
      var maxP = c.flag('ccv_max_luminance_value_present_flag');
      var avgP = c.flag('ccv_avg_luminance_value_present_flag');
      c.u('reserved_zero_2bits', 2);
      if (pp) {
        var prim = [];
        for (var i = 0; i < 3; i++) {
          var x = c.u('ccv_primaries_x[' + i + ']', 16); c.note(fmt4(x / 50000));
          var y = c.u('ccv_primaries_y[' + i + ']', 16); c.note(fmt4(y / 50000));
          prim.push([x / 50000, y / 50000]);
        }
        hdr.ccv.primaries = prim;
      }
      if (minP) {
        var minV = c.u('ccv_min_luminance_value', 32); c.note(fmt4(minV / 1e7) + ' cd/m²');
        hdr.ccv.minLum = minV / 1e7;
      }
      if (maxP) {
        var maxV = c.u('ccv_max_luminance_value', 32); c.note(fmt4(maxV / 1e4) + ' cd/m²');
        hdr.ccv.maxLum = maxV / 1e4;
      }
      if (avgP) {
        var avgV = c.u('ccv_avg_luminance_value', 32); c.note(fmt4(avgV / 1e7) + ' cd/m²');
        hdr.ccv.avgLum = avgV / 1e7;
      }
    }
    rows = c.rows;
    return { rows: rows, hdr: hdr };
  }

  /* Printable preview of the bytes a decoder chose not to interpret.  */
  function dumpRest(data, start, pos, end, base, name) {
    var rows = [];
    if (pos < end) {
      var text = '';
      for (var j = pos; j < Math.min(end, pos + 32); j++) {
        var ch = data[j];
        text += (ch >= 32 && ch < 127) ? String.fromCharCode(ch) : '.';
      }
      rows.push({ name: name || 'itu_t_t35_payload_byte[]', syntax: '',
        bits: (end - pos) * 8, value: text, note: '',
        offset: (base || 0) + pos, depth: 0 });
    }
    return rows;
  }

  /* ------------------------------------------------------- ST 2094-40 */
  /* SMPTE ST 2094 Application 4 — HDR10+ dynamic metadata. The cursor  */
  /* starts at application_version; the T.35 identification was read by */
  /* the caller. Field order follows ffmpeg dynamic_hdr10_plus.c.       */
  function decodeST2094_40(c) {
    var hdr = { hdr10plus: {} };
    var version = c.u('application_version', 8);
    hdr.hdr10plus.version = version;
    var nw = c.u('num_windows', 2);
    hdr.hdr10plus.windows = nw;
    if (nw < 1 || nw > 3) throw new Error('bad num_windows');
    for (var w = 1; w < nw; w++) {
      c.u('window_upper_left_corner_x[' + w + ']', 16);
      c.u('window_upper_left_corner_y[' + w + ']', 16);
      c.u('window_lower_right_corner_x[' + w + ']', 16);
      c.u('window_lower_right_corner_y[' + w + ']', 16);
      c.u('center_of_ellipse_x[' + w + ']', 16);
      c.u('center_of_ellipse_y[' + w + ']', 16);
      c.u('rotation_angle[' + w + ']', 8);
      c.u('semimajor_axis_internal_ellipse[' + w + ']', 16);
      c.u('semimajor_axis_external_ellipse[' + w + ']', 16);
      c.u('semiminor_axis_external_ellipse[' + w + ']', 16);
      c.flag('overlap_process_option[' + w + ']');
    }
    var targetLum = c.u('targeted_system_display_maximum_luminance', 27);
    c.note(targetLum + ' cd/m²');
    hdr.hdr10plus.targetLum = targetLum;
    var tsdFlag = c.flag('targeted_system_display_actual_peak_luminance_flag');
    if (tsdFlag) {
      var rowsN = c.u('num_rows_targeted_system_display_actual_peak_luminance', 5);
      var colsN = c.u('num_cols_targeted_system_display_actual_peak_luminance', 5);
      for (var rr = 0; rr < rowsN; rr++) {
        for (var cc = 0; cc < colsN; cc++) {
          var v = c.u('targeted_system_display_actual_peak_luminance[' + rr + '][' + cc + ']', 4);
          c.note(fmt4(v / 15));
        }
      }
    }
    var w0 = null;
    for (var wi = 0; wi < nw; wi++) {
      var maxscl = [];
      for (var k = 0; k < 3; k++) {
        var ms = c.u('maxscl[' + wi + '][' + k + ']', 17);
        c.note(fmt4(ms / 10) + ' cd/m²');
        maxscl.push(ms / 10);
      }
      var avg = c.u('average_maxrgb[' + wi + ']', 17);
      c.note(fmt4(avg / 10) + ' cd/m²');
      var nd = c.u('num_distribution_maxrgb_percentiles[' + wi + ']', 4);
      var dist = [];
      for (var di = 0; di < nd; di++) {
        var pct = c.u('distribution_maxrgb_percentage[' + wi + '][' + di + ']', 7);
        c.note(pct + '%');
        var pv = c.u('distribution_maxrgb_percentile[' + wi + '][' + di + ']', 17);
        c.note(fmt4(pv / 10) + ' cd/m²');
        dist.push([pct, pv / 10]);
      }
      var frac = c.u('fraction_bright_pixels[' + wi + ']', 10);
      c.note(fmt4(frac / 1000));
      if (wi === 0) w0 = { maxscl: maxscl, avg: avg / 10, dist: dist, frac: frac / 1000 };
    }
    hdr.hdr10plus.window0 = w0;
    var masterFlag = c.flag('mastering_display_actual_peak_luminance_flag');
    if (masterFlag) {
      var mrows = c.u('num_rows_mastering_display_actual_peak_luminance', 5);
      var mcols = c.u('num_cols_mastering_display_actual_peak_luminance', 5);
      for (var mr = 0; mr < mrows; mr++) {
        for (var mc = 0; mc < mcols; mc++) {
          var mv = c.u('mastering_display_actual_peak_luminance[' + mr + '][' + mc + ']', 4);
          c.note(fmt4(mv / 15));
        }
      }
    }
    var tone = 0;
    for (var tw = 0; tw < nw; tw++) {
      var tm = c.flag('tone_mapping_flag[' + tw + ']');
      if (tm) {
        tone = 1;
        var kx = c.u('knee_point_x[' + tw + ']', 12); c.note(fmt4(kx / 4095));
        var ky = c.u('knee_point_y[' + tw + ']', 12); c.note(fmt4(ky / 4095));
        var nb = c.u('num_bezier_curve_anchors[' + tw + ']', 4);
        var anchors = [];
        for (var a = 0; a < nb; a++) {
          var av = c.u('bezier_curve_anchor[' + tw + '][' + a + ']', 10);
          c.note(fmt4(av / 1023));
          anchors.push(av);
        }
        if (tw === 0) {
          hdr.hdr10plus.knee = [kx, ky];
          hdr.hdr10plus.anchors = anchors;
        }
      }
      var csm = c.flag('color_saturation_mapping_flag[' + tw + ']');
      if (csm) {
        var cw = c.u('color_saturation_weight[' + tw + ']', 6); c.note(fmt4(cw / 8));
      }
    }
    hdr.hdr10plus.profile = tone ? 'B' : 'A';
    c.align();
    return hdr;
  }

  /* ------------------------------------------------------- ST 2094-10 */
  /* Dolby SL-HDR1 inside a GA94 user_data_type_code 0x09 payload. The  */
  /* cursor starts at app_identifier (Exp-Golomb syntax).               */
  function decodeST2094_10(c) {
    var hdr = { slHdr1: { blocks: [] } };
    var appId = c.ue('app_identifier');
    if (appId !== 1) return hdr;
    var ver = c.ue('app_version');
    hdr.slHdr1.version = ver;
    var refresh = c.flag('metadata_refresh_flag');
    if (refresh) {
      var n = c.ue('num_ext_blocks');
      if (n > 0) {
        c.align();
        for (var i = 0; i < n && c.bitsLeft() > 8; i++) {
          var len = c.ue('ext_block_length[' + i + ']');
          c.note(len + ' bytes');
          var level = c.u('ext_block_level[' + i + ']', 8);
          c.note(SL_HDR1_BLOCK_NAMES[level] || ('level ' + level));
          hdr.slHdr1.blocks.push(level);
          var endBit = c.p + len * 8;
          if (level === 1) {
            c.u('min_PQ[' + i + ']', 12); c.u('max_PQ[' + i + ']', 12); c.u('avg_PQ[' + i + ']', 12);
          } else if (level === 2) {
            c.u('target_max_PQ[' + i + ']', 12);
            c.u('trim_slope[' + i + ']', 12);
            c.u('trim_offset[' + i + ']', 12);
            c.u('trim_power[' + i + ']', 12);
            c.u('trim_chroma_weight[' + i + ']', 12);
            c.u('trim_saturation_gain[' + i + ']', 12);
            c.u('ms_weight[' + i + ']', 3);
          } else if (level === 3) {
            c.u('min_PQ_offset[' + i + ']', 12);
            c.u('max_PQ_offset[' + i + ']', 12);
            c.u('avg_PQ_offset[' + i + ']', 12);
          } else if (level === 4) {
            c.u('TF_PQ_mean[' + i + ']', 12);
            c.u('TF_PQ_stdev[' + i + ']', 12);
          } else if (level === 5) {
            c.u('active_area_left_offset[' + i + ']', 13);
            c.u('active_area_right_offset[' + i + ']', 13);
            c.u('active_area_top_offset[' + i + ']', 13);
            c.u('active_area_bottom_offset[' + i + ']', 13);
          }
          // Skip to the declared end of the block (unknown extensions).
          while (c.p < endBit && c.p + 8 <= endBit) c.u('ext_block_reserved[' + i + ']', 8);
          if (c.p < endBit) {
            var tail = endBit - c.p;
            for (var t = 0; t < tail; t++) c.bit();
          }
        }
      }
    }
    c.align();
    return hdr;
  }

  /* ETSI TS 103 433 SL-HDR (ST 2094-20 / ST 2094-30), provider 0x003A. */
  function decodeSLHDR(c) {
    var hdr = { slHdr: {} };
    var mode = c.u('sl_hdr_mode_value_minus1', 4);
    var major = c.u('sl_hdr_spec_major_version_idc', 4);
    var minor = c.u('sl_hdr_spec_minor_version_idc', 7);
    hdr.slHdr.mode = mode + 1;
    hdr.slHdr.specVersion = major + '.' + minor;
    var cancel = c.flag('sl_hdr_cancel_flag');
    if (!cancel) {
      c.flag('sl_hdr_persistence_flag');
      var coded = c.flag('coded_picture_info_present_flag');
      var target = c.flag('target_picture_info_present_flag');
      var src = c.flag('src_mdcv_info_present_flag');
      c.flag('sl_hdr_extension_present_flag');
      var pm = c.u('sl_hdr_payload_mode', 3);
      hdr.slHdr.payloadMode = pm;
      function picture(prefix) {
        c.u(prefix + '_picture_primaries', 8);
        c.u(prefix + '_picture_max_luminance', 16);
        c.u(prefix + '_picture_min_luminance', 16);
      }
      if (coded) picture('coded');
      if (target) picture('target');
      if (src) {
        for (var i = 0; i < 3; i++) {
          c.u('src_mdcv_primaries_x[' + i + ']', 16);
          c.u('src_mdcv_primaries_y[' + i + ']', 16);
        }
        c.u('src_mdcv_ref_white_x', 16);
        c.u('src_mdcv_ref_white_y', 16);
        c.u('src_mdcv_max_mastering_luminance', 16);
        c.u('src_mdcv_min_mastering_luminance', 16);
      }
      for (var m = 0; m < 4; m++) c.u('matrix_coefficient_value[' + m + ']', 16);
      for (var q = 0; q < 2; q++) c.u('chroma_to_luma_injection[' + q + ']', 16);
      for (var k = 0; k < 3; k++) c.u('k_coefficient_value[' + k + ']', 8);
    }
    return hdr;
  }

  /* ------------------------------------------------------------ T.35 */
  /* SEI 4 — user_data_registered_itu_t_t35. Dispatches the HDR dynamic */
  /* metadata standards; everything else (ATSC captions, AFD…) is only */
  /* identified and dumped as bytes.                                   */
  function decodeT35(data, start, size, base) {
    var rows = [], hdr = {};
    var p = start, end = start + size;
    function row(name, syntax, bits, value, note, off) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
        note: note || '', offset: off == null ? (base || 0) + p : off, depth: 0 });
    }
    var country = data[p++];
    var countryName = country === 0xb5 ? 'United States'
      : country === 0x26 ? 'China'
      : country === 0xff ? 'extended' : '';
    row('itu_t_t35_country_code', 'u(8)', 8, country, countryName, (base || 0) + start);
    if (country === 0xff) {
      row('itu_t_t35_country_code_extended_byte', 'u(8)', 8, data[p++], '',
        (base || 0) + p - 1);
    }
    function rd16() { var v = (data[p] << 8) | data[p + 1]; p += 2; return v; }
    function rd8() { return data[p++]; }
    function rd4() {
      var s = '';
      for (var i = 0; i < 4; i++) s += String.fromCharCode(data[p++]);
      return s;
    }
    try {
      if (country === 0xb5 && p + 2 <= end) {
        var provider = rd16();
        row('itu_t_t35_terminal_provider_code', 'u(16)', 16, provider,
          ({ 0x0031: 'Dolby (GA94/DTG1)', 0x003a: 'Philips/Technicolor (SL-HDR)',
             0x003c: 'Samsung (HDR10+)' })[provider] || '',
          (base || 0) + p - 2);
        if (provider === 0x0031 && p + 5 <= end) {
          var idOff = p, ident = rd4();
          row('terminal_provider_oriented_code', 'u(32)', 32, ident,
            ident === 'GA94' ? 'Dolby GA94 identifier'
            : ident === 'DTG1' ? 'DTV Active Format Description' : '',
            (base || 0) + idOff);
          if (ident === 'GA94' && p < end) {
            var udOff = p, udType = rd8();
            row('user_data_type_code', 'u(8)', 8, udType,
              udType === 0x09 ? 'SMPTE ST 2094-10 (SL-HDR1)'
              : udType === 0x03 ? 'DTVCC captions' : '', (base || 0) + udOff);
            if (udType === 0x09) {
              var c = new Cursor(data, p, end - p, base);
              var h = decodeST2094_10(c);
              rows = rows.concat(c.rows);
              p = c.s + (c.p >> 3);
              hdr = h;
            }
          }
        } else if (provider === 0x003a && p < end) {
          var pocA = rd8();
          row('itu_t_t35_terminal_provider_oriented_code', 'u(8)', 8, pocA,
            pocA === 0 ? 'SL-HDR (ETSI TS 103 433)'
            : pocA === 2 ? 'SL-HDR information' : '', (base || 0) + p - 1);
          if (pocA === 0) {
            var ca = new Cursor(data, p, end - p, base);
            var ha = decodeSLHDR(ca);
            rows = rows.concat(ca.rows);
            p = ca.s + (ca.p >> 3);
            hdr = ha;
          } else if (pocA === 2) {
            var cb = new Cursor(data, p, end - p, base);
            var spec = cb.u('ts_103_433_spec_version', 4);
            if (spec === 0) cb.u('ts_103_433_payload_mode', 4);
            else if (spec === 1) cb.u('sl_hdr_mode_support', 3);
            rows = rows.concat(cb.rows);
            p = cb.s + (cb.p >> 3);
          }
        } else if (provider === 0x003c && p + 2 <= end) {
          var poc = rd16();
          row('itu_t_t35_terminal_provider_oriented_code', 'u(16)', 16, poc,
            poc === 0x0001 || poc === 0x0003 ? 'HDR dynamic metadata' : '',
            (base || 0) + p - 2);
          if ((poc === 0x0001 || poc === 0x0003) && p < end) {
            var appOff = p, app = rd8();
            row('application_identifier', 'u(8)', 8, app,
              app === 4 ? 'SMPTE ST 2094-40 (HDR10+)' : '', (base || 0) + appOff);
            if (app === 4) {
              var cc = new Cursor(data, p, end - p, base);
              var hc = decodeST2094_40(cc);
              rows = rows.concat(cc.rows);
              p = cc.s + (cc.p >> 3);
              hdr = hc;
            }
          }
        }
      } else if (country === 0x26 && p + 2 <= end) {
        var cnProvider = rd16();
        row('itu_t_t35_terminal_provider_code', 'u(16)', 16, cnProvider,
          cnProvider === 0x0004 ? 'HDR Vivid (GY/T 315)' : '', (base || 0) + p - 2);
        if (cnProvider === 0x0004 && p + 2 <= end) {
          var cnPoc = rd16();
          row('itu_t_t35_terminal_provider_oriented_code', 'u(16)', 16, cnPoc,
            cnPoc === 0x0005 ? 'HDR Vivid version 1' : '', (base || 0) + p - 2);
          if (cnPoc === 0x0005) hdr.hdrVivid = true;
        }
      }
    } catch (e) { /* malformed dynamic metadata — keep identification rows */ }
    rows = rows.concat(dumpRest(data, start, p, end, base));
    return { rows: rows, hdr: hdr };
  }

  /** Dispatch one SEI payload. Always returns {rows, hdr}; hdr is {} when
   *  the type carries no HDR data. */
  function decodePayload(type, data, start, size, base) {
    var empty = { rows: [], hdr: {} };
    if (!data || start + size > data.length) return empty;
    try {
      switch (type) {
        case 137: return decodeMDCV(data, start, size, base);
        case 144: return decodeCLLI(data, start, size, base);
        case 147: return decodeAltTransfer(data, start, size, base);
        case 148: return decodeAmbient(data, start, size, base);
        case 149: return decodeCCV(data, start, size, base);
        case 4:   return decodeT35(data, start, size, base);
        default:  return empty;
      }
    } catch (e) {
      return empty;
    }
  }

  /** Merge per-message HDR summaries found across the NAL units of a track. */
  function merge(a, b) {
    a = a || {};
    b = b || {};
    var out = {};
    ['mastering', 'maxCLL', 'maxFALL', 'altTransfer', 'ambient', 'ccv',
     'hdr10plus', 'slHdr1', 'slHdr', 'hdrVivid'].forEach(function (k) {
      if (a[k] !== undefined) out[k] = a[k];
      if (b[k] !== undefined) out[k] = b[k];      // later message wins
    });
    return out;
  }

  /**
   * Build the human-facing track summary. `colour` is the SPS VUI colour
   * description ({primaries, transfer, matrix}) when present.
   * @returns {{formats: string[], extras: {label,value}[]}}
   */
  function summarize(hdr, colour) {
    hdr = hdr || {};
    var formats = [], extras = [];
    var transfer = (hdr.altTransfer && hdr.altTransfer.name) ||
                   (colour && colour.transfer) || '';
    if (hdr.slHdr1 || hdr.slHdr) transfer = transfer || 'SMPTE ST 2084 (PQ)';

    if (hdr.hdr10plus) {
      formats.push('HDR10+ Profile ' + hdr.hdr10plus.profile + ' (SMPTE ST 2094-40)');
    }
    if (isPQ(transfer) && (hdr.mastering || hdr.maxCLL != null || hdr.hdr10plus)) {
      formats.push('HDR10 (SMPTE ST 2084/ST 2086)');
    } else if (isHLG(transfer)) {
      formats.push('HLG (ARIB STD-B67)');
    }
    if (hdr.slHdr1) formats.push('SL-HDR1 (SMPTE ST 2094-10)');
    if (hdr.slHdr) {
      formats.push('SL-HDR' + hdr.slHdr.mode + ' (ETSI TS 103 433, ST 2094-20/30)');
    }
    if (hdr.hdrVivid) formats.push('HDR Vivid (GY/T 315)');
    if (!formats.length && hdr.mastering) formats.push('SMPTE ST 2086 mastering metadata');
    if (!formats.length && hdr.ccv) formats.push('Content colour volume (SEI 149)');

    if (formats.length) extras.push({ label: 'HDR format', value: formats.join(', ') });
    if (isPQ(transfer) || isHLG(transfer)) {
      extras.push({ label: 'EOTF / transfer', value: transfer });
    } else if (hdr.altTransfer) {
      extras.push({ label: 'Alternative transfer', value: transfer });
    }
    if (hdr.maxCLL != null || hdr.maxFALL != null) {
      extras.push({ label: 'MaxCLL / MaxFALL',
        value: (hdr.maxCLL != null ? hdr.maxCLL : '—') + ' / ' +
               (hdr.maxFALL != null ? hdr.maxFALL : '—') + ' cd/m²' });
    }
    if (hdr.mastering) {
      var m = hdr.mastering;
      extras.push({ label: 'Mastering luminance',
        value: fmt4(m.minLum) + ' – ' + fmt4(m.maxLum) + ' cd/m²' });
      if (m.primaries && m.white) {
        var names = ['R', 'G', 'B'];
        var pv = m.primaries.map(function (q, i) {
          return names[i] + '(' + fmt4(q[0]) + ',' + fmt4(q[1]) + ')';
        });
        pv.push('D65(' + fmt4(m.white[0]) + ',' + fmt4(m.white[1]) + ')');
        extras.push({ label: 'Mastering primaries', value: pv.join(' ') });
      }
    }
    if (hdr.ambient) {
      extras.push({ label: 'Ambient environment',
        value: fmt4(hdr.ambient.illuminance) + ' lux, (' +
               fmt4(hdr.ambient.x) + ',' + fmt4(hdr.ambient.y) + ')' });
    }
    if (hdr.hdr10plus) {
      var hp = hdr.hdr10plus;
      var val = 'target display ' + hp.targetLum + ' cd/m², ' + hp.windows + ' window(s)';
      if (hp.anchors) val += ', ' + hp.anchors.length + ' tone-mapping anchors';
      extras.push({ label: 'HDR10+ metadata', value: val });
    }
    if (hdr.slHdr1) {
      extras.push({ label: 'SL-HDR1',
        value: 'v' + hdr.slHdr1.version + ', blocks: ' +
               (hdr.slHdr1.blocks.map(function (l) { return SL_HDR1_BLOCK_NAMES[l] || ('L' + l); }).join('; ') || 'none') });
    }
    if (hdr.slHdr) {
      extras.push({ label: 'SL-HDR',
        value: 'SL-HDR' + hdr.slHdr.mode + ' spec ' + hdr.slHdr.specVersion +
               ', payload mode ' + hdr.slHdr.payloadMode });
    }
    return { formats: formats, extras: extras };
  }

  MA.hdrSEI = {
    decodePayload: decodePayload,
    merge: merge,
    summarize: summarize,
    transferName: transferName,
    TRANSFER_CHARACTERISTICS: TRANSFER
  };
  if (global.MA === undefined) global.MA = MA;
})(typeof globalThis !== 'undefined' ? globalThis : this);
