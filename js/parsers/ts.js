/* ============================================================================
 * MediaAnalyzer — parsers/ts.js
 *
 * MPEG-2 Transport Stream (ISO/IEC 13818-1) — .ts, .m2ts, .mts, and the
 * segments referenced by an HLS playlist.
 *
 * Handles the three packet layouts seen in the wild:
 *   188 bytes  plain TS
 *   192 bytes  M2TS / BDAV — a 4-byte TP_extra_header in front of each packet
 *   204 bytes  RS-coded, 16 trailing Reed-Solomon parity bytes
 *
 * Details a naive implementation gets wrong, and which are handled here:
 *   - PES_packet_length == 0 means "unbounded": the payload runs to the next
 *     PUSI on that PID (or to EOF). Treating 0 as a literal length yields an
 *     empty payload for every video frame.
 *   - PSI sections may span packets, and one packet may hold the tail of one
 *     section followed by the head of the next. Sections are reassembled per
 *     PID rather than clamped to a single packet.
 *   - A PES payload is contiguous in the file only when nothing else was
 *     interleaved. That is checked while reassembling: when it holds we hand
 *     the syntax resolver a single [offset,size) range, otherwise a list of
 *     ranges it stitches back together.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var MAX_FRAMES = 60000;
  var MAX_PACKETS = 3000000;
  var MAX_ES_HEAD = 256 * 1024;    // contiguous bytes kept per PES for probing
  var MAX_PARTS = 2048;            // ranges allowed for one non-contiguous PES
  var MAX_NOTES = 40;
  var MAX_PACKET_NODES = 2000;     // per-packet structure nodes kept for the tree

  /** ISO/IEC 13818-1 Table 2-34 stream_type assignments. */
  var STREAM_TYPES = {
    0x01: { name: 'MPEG-1 Video', kind: 'video', codec: 'mpeg2' },
    0x02: { name: 'MPEG-2 Video', kind: 'video', codec: 'mpeg2' },
    0x03: { name: 'MPEG-1 Audio', kind: 'audio', codec: 'mp3' },
    0x04: { name: 'MPEG-2 Audio', kind: 'audio', codec: 'mp3' },
    0x05: { name: 'Private sections', kind: 'data', codec: null },
    0x06: { name: 'PES private data', kind: 'data', codec: null },
    0x0f: { name: 'AAC (ADTS)', kind: 'audio', codec: 'aac' },
    0x10: { name: 'MPEG-4 Visual', kind: 'video', codec: 'mpeg4' },
    0x11: { name: 'AAC (LATM)', kind: 'audio', codec: 'aac' },
    0x15: { name: 'Metadata', kind: 'data', codec: null },
    0x1b: { name: 'H.264 / AVC', kind: 'video', codec: 'h264' },
    0x1c: { name: 'AAC (raw)', kind: 'audio', codec: 'aac' },
    0x20: { name: 'H.264 / MVC', kind: 'video', codec: 'h264' },
    0x21: { name: 'JPEG 2000', kind: 'video', codec: null },
    0x24: { name: 'H.265 / HEVC', kind: 'video', codec: 'h265' },
    0x25: { name: 'H.265 / HEVC (temporal)', kind: 'video', codec: 'h265' },
    0x27: { name: 'H.266 / VVC', kind: 'video', codec: 'h266' },
    0x2a: { name: 'H.266 / VVC (sub-layer)', kind: 'video', codec: 'h266' },
    0x33: { name: 'H.266 / VVC (enhancement)', kind: 'video', codec: 'h266' },
    0x42: { name: 'AVS', kind: 'video', codec: null },
    0x81: { name: 'AC-3 (ATSC)', kind: 'audio', codec: 'ac3' },
    0x82: { name: 'DTS', kind: 'audio', codec: 'dts' },
    0x86: { name: 'SCTE-35', kind: 'data', codec: null },
    0x87: { name: 'E-AC-3', kind: 'audio', codec: 'ac3' }
  };

  var CODEC_NAMES = {
    h264: 'H.264 / AVC', h265: 'H.265 / HEVC', h266: 'H.266 / VVC',
    mpeg2: 'MPEG-2 Video', mpeg4: 'MPEG-4 Visual',
    aac: 'AAC (ADTS)', ac3: 'AC-3 / E-AC-3', mp3: 'MPEG Audio'
  };

  var ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050,
                    16000, 12000, 11025, 8000, 7350, 0, 0, 0];

  /* ====================================================================== */

  function parse(ctx) {
    var data = ctx.data;
    var layout = detectPacketSize(data);

    if (!layout) {
      return {
        formatId: 'ts', formatName: 'MPEG-TS', durationSec: null, bitrate: null,
        tracks: [], metadata: [], structures: [], frames: [], codecContexts: {},
        notes: ['No 188/192/204-byte sync pattern found — the file may be truncated or is not a transport stream.']
      };
    }

    var P = {
      data: data,
      stride: layout.stride,
      syncOffset: layout.syncOffset,
      packetCount: 0,
      psi: {},
      pes: {},
      streams: {},
      pcrPid: null,
      pmtPid: null,
      programNumber: null,
      serviceId: null,
      serviceName: '',
      serviceProvider: '',
      lastPcr: null,
      firstPcrSec: null,
      frames: [],
      notes: [],
      ccErrors: 0,
      trackConfigs: {},
      codecContexts: {},
      frameNodesDropped: 0,
      packetRecords: [],
      packetNodesDropped: 0
    };

    walkPackets(data, P);
    Object.keys(P.pes).forEach(function (pid) { flushPes(P, pid); });

    // Stamps were collected as raw 90 kHz ticks; turn them into seconds and
    // resolve the 33-bit wrap before anything reads them.
    normalizeTimestamps(P.frames);

    var tracks = buildTracks(P, ctx);

    var frames = P.frames;
    frames.sort(function (a, b) { return a.offset - b.offset; });
    if (frames.length > MAX_FRAMES) {
      frames.length = MAX_FRAMES;
      note(P, 'Frame list capped at ' + MAX_FRAMES + ' frames.');
    }
    frames.forEach(function (f, i) { f.listIndex = i + 1; });

    var durationSec = null;
    if (P.firstPcrSec != null && P.lastPcr != null && P.lastPcr - P.firstPcrSec > 0.05) {
      durationSec = P.lastPcr - P.firstPcrSec;
    }
    if (!durationSec) {
      var maxPts = 0;
      for (var i = 0; i < frames.length; i++) if (frames[i].ptsSec > maxPts) maxPts = frames[i].ptsSec;
      if (maxPts > 0) durationSec = maxPts + 0.04;
    }

    tracks.forEach(function (t) {
      if (!t.durationSec) t.durationSec = durationSec;
      if (t.durationSec > 0 && t.bytes > 0) t.bitrate = Math.round(t.bytes * 8 / t.durationSec);
      if (t.type === 'video' && t.durationSec > 0 && t.sampleCount) t.fps = t.sampleCount / t.durationSec;
      delete t.bytes;
    });

    var metadata = [
      { key: 'packet_size', value: layout.stride + ' bytes' + (layout.stride === 192 ? ' (M2TS)' : '') },
      { key: 'packets', value: String(P.packetCount) }
    ];
    if (P.pcrPid != null) metadata.push({ key: 'pcr_pid', value: '0x' + MA.pad(P.pcrPid.toString(16), 4, '0') });
    if (P.pmtPid != null) metadata.push({ key: 'pmt_pid', value: '0x' + MA.pad(P.pmtPid.toString(16), 4, '0') });
    if (P.programNumber != null) metadata.push({ key: 'program_number', value: String(P.programNumber) });
    if (P.serviceName) metadata.push({ key: 'service_name', value: P.serviceName });
    if (P.serviceProvider) metadata.push({ key: 'service_provider', value: P.serviceProvider });

    if (P.ccErrors) note(P, P.ccErrors + ' continuity counter discontinuities detected.');
    if (P.frameNodesDropped) {
      note(P, P.frameNodesDropped + ' frame nodes omitted from the structure tree (the frame list still lists them).');
    }
    if (P.packetNodesDropped) {
      note(P, P.packetNodesDropped + ' packet nodes omitted from the structure tree (capped at ' + MAX_PACKET_NODES + ').');
    }
    if (!tracks.length) note(P, 'No PMT was found, so no elementary streams could be identified.');

    return {
      formatId: 'ts',
      formatName: layout.stride === 192 ? 'MPEG-TS (M2TS / BDAV, 192-byte packets)'
                                       : 'MPEG-TS (' + layout.stride + '-byte packets)',
      durationSec: durationSec,
      bitrate: durationSec > 0 ? Math.round(ctx.size * 8 / durationSec) : null,
      tracks: tracks,
      metadata: metadata,
      structures: buildStructures(P),
      frames: frames,
      notes: P.notes,
      codecContexts: P.codecContexts
    };
  }

  function note(P, text) {
    if (P.notes.length < MAX_NOTES) P.notes.push(text);
  }

  /* ---------------------------------------------------------- packet layout */

  function detectPacketSize(data) {
    var candidates = [
      { stride: 188, syncOffset: 0 },
      { stride: 192, syncOffset: 4 },
      { stride: 204, syncOffset: 0 }
    ];
    for (var c = 0; c < candidates.length; c++) {
      var cand = candidates[c];
      var good = 0, trials = 0;
      for (var p = cand.syncOffset; p + cand.stride * 4 < data.length && trials < 8; p += cand.stride, trials++) {
        if (data[p] === 0x47) good++;
      }
      if (trials >= 3 && good === trials) return cand;
    }
    // A 192-byte stream sometimes starts mid-packet; search for the phase.
    for (var off = 0; off < 192 && off + 192 * 4 < data.length; off++) {
      var hits = 0, t2 = 0;
      for (var q = off; q + 192 * 4 < data.length && t2 < 6; q += 192, t2++) if (data[q] === 0x47) hits++;
      if (t2 >= 4 && hits === t2) return { stride: 192, syncOffset: 0, startOffset: off };
    }
    return null;
  }

  /* -------------------------------------------------------------- main loop */

  function walkPackets(data, P) {
    var stride = P.stride, sync = P.syncOffset;
    var p = 0;
    while (p + sync < data.length && data[p + sync] !== 0x47) p++;
    if (p > 0) note(P, 'Skipped ' + p + ' leading bytes before the first sync byte.');

    var guard = 0;
    while (p + stride <= data.length && ++guard < MAX_PACKETS) {
      var b = p + sync;
      if (data[b] !== 0x47) {
        var next = p + 1;
        var limit = Math.min(data.length - stride, p + stride * 8);
        while (next < limit && data[next + sync] !== 0x47) next++;
        if (next >= limit) break;
        note(P, 'Lost sync at ' + MA.hex(p, 8) + '; resynchronised at ' + MA.hex(next, 8) + '.');
        p = next;
        continue;
      }
      P.packetCount++;
      handlePacket(data, p, stride, sync, P);
      p += stride;
    }
    if (guard >= MAX_PACKETS) note(P, 'Stopped after ' + MAX_PACKETS + ' TS packets.');
  }

  function handlePacket(data, p, stride, sync, P) {
    var b = p + sync;
    var b1 = data[b + 1], b2 = data[b + 2], b3 = data[b + 3];
    var tei = (b1 & 0x80) !== 0;
    var pusi = (b1 & 0x40) !== 0;
    var prio = (b1 & 0x20) !== 0;
    var pid = ((b1 & 0x1f) << 8) | b2;
    var scrambling = (b3 >> 6) & 3;
    var afc = (b3 >> 4) & 3;
    var cc = b3 & 0x0f;

    var payloadStart = b + 4;
    var payloadEnd = stride === 204 ? p + 188 : p + stride;
    if (payloadEnd > data.length) payloadEnd = data.length;

    var pcr = null, afLen = 0, afFlags = 0;
    if (afc === 2 || afc === 3) {
      afLen = data[payloadStart];
      if (afLen > 0 && payloadStart + 1 < payloadEnd) {
        afFlags = data[payloadStart + 1];
        if ((afFlags & 0x10) && payloadStart + 7 < payloadEnd) {           // PCR_flag
          var base = data[payloadStart + 2] * 0x2000000 +
                     (data[payloadStart + 3] << 17) +
                     (data[payloadStart + 4] << 9) +
                     (data[payloadStart + 5] << 1) +
                     ((data[payloadStart + 6] >> 7) & 1);
          var ext = ((data[payloadStart + 6] & 1) << 8) | data[payloadStart + 7];
          pcr = base / 90000 + ext / 27000000;
        }
      }
      payloadStart += 1 + afLen;
    }

    /* Keep a raw header record per packet for the structure tree — capped, so
     * a multi-GB stream doesn't build millions of nodes. */
    if (P.packetRecords.length < MAX_PACKET_NODES) {
      P.packetRecords.push({
        offset: p, size: stride, index: P.packetCount,
        tei: tei, pusi: pusi, prio: prio, pid: pid,
        scrambling: scrambling, afc: afc, cc: cc,
        afLen: afLen, afFlags: afFlags, pcr: pcr,
        payload: (afc === 1 || afc === 3) ? Math.max(0, payloadEnd - payloadStart) : 0
      });
    } else {
      P.packetNodesDropped++;
    }

    if (afc === 0 || payloadStart >= payloadEnd) return;

    if (pid === 0) { assemblePsi(P, pid, payloadStart, payloadEnd, pusi, handlePat); return; }
    if (pid === 0x11) { assemblePsi(P, pid, payloadStart, payloadEnd, pusi, handleSdt); return; }
    if (P.pmtPid != null && pid === P.pmtPid) { assemblePsi(P, pid, payloadStart, payloadEnd, pusi, handlePmt); return; }

    var st = P.streams[pid];
    if (!st) return;

    if (pcr != null) {
      if (P.firstPcrSec == null) P.firstPcrSec = pcr;
      P.lastPcr = pcr;
    }

    if (st.lastCc != null && cc !== ((st.lastCc + 1) & 0x0f) && afc !== 2) P.ccErrors++;
    st.lastCc = cc;

    if (pusi) {
      flushPes(P, pid);
      startPes(P, pid, payloadStart, payloadEnd);
    } else if (P.pes[pid]) {
      appendPes(P, pid, payloadStart, payloadEnd);
    }
  }

  /* ---------------------------------------------------------- PSI sections */

  function assemblePsi(P, pid, start, end, pusi, handler) {
    var st = P.psi[pid] || (P.psi[pid] = { buf: null, expected: 0 });
    var p = start;

    if (pusi) {
      if (p >= end) return;
      var pointer = data8(P, p++);
      if (st.buf && st.buf.length && pointer > 0) {
        // The pointer spans the tail of an incomplete section — feed it in.
        appendBytes(st, P.data, p, Math.min(p + pointer, end));
        tryComplete(st, handler, P);
      } else {
        p += Math.min(pointer, end - p);
      }
      if (!st.buf) { st.buf = null; st.expected = 0; }
    } else if (!st.buf) {
      return;
    }

    while (p < end) {
      if (!st.buf) {
        if (end - p < 3) return;
        if (P.data[p] === 0xff) return;                     // stuffing
        st.buf = [];
        st.expected = 0;
      }
      if (!st.expected) {
        st.buf.push(P.data[p++]);
        if (st.buf.length >= 3) {
          var sectionLength = ((st.buf[1] & 0x0f) << 8) | st.buf[2];
          if (sectionLength <= 0 || sectionLength > 4096) { st.buf = null; return; }
          st.expected = 3 + sectionLength;
        }
        continue;
      }
      var need = st.expected - st.buf.length;
      var take = Math.min(need, end - p);
      for (var i = 0; i < take; i++) st.buf.push(P.data[p + i]);
      p += take;
      if (st.buf.length >= st.expected) {
        tryComplete(st, handler, P);
        st.buf = null; st.expected = 0;
      }
    }
  }

  function data8(P, p) { return P.data[p]; }

  function appendBytes(st, data, start, end) {
    if (!st.buf) return;
    for (var i = start; i < end && i < data.length; i++) st.buf.push(data[i]);
    if (!st.expected && st.buf.length >= 3) {
      var sectionLength = ((st.buf[1] & 0x0f) << 8) | st.buf[2];
      if (sectionLength > 0 && sectionLength <= 4096) st.expected = 3 + sectionLength;
    }
  }

  function tryComplete(st, handler, P) {
    if (!st.buf || st.buf.length < 3) return;
    if (st.expected && st.buf.length < st.expected) return;
    try {
      handler(new Uint8Array(st.buf), P);
    } catch (e) {
      note(P, 'Malformed PSI section: ' + (e && e.message || e));
    }
    st.buf = null; st.expected = 0;
  }

  function handlePat(buf, P) {
    if (buf.length < 12 || buf[0] !== 0x00) return;
    var sectionEnd = Math.min(buf.length, 3 + (((buf[1] & 0x0f) << 8) | buf[2]));
    var p = 8;
    while (p + 4 <= sectionEnd - 4) {
      var program = (buf[p] << 8) | buf[p + 1];
      var pid = ((buf[p + 2] & 0x1f) << 8) | buf[p + 3];
      if (program !== 0 && P.pmtPid == null) { P.pmtPid = pid; P.programNumber = program; }
      p += 4;
    }
  }

  function handlePmt(buf, P) {
    var sectionEnd = Math.min(buf.length, 3 + (((buf[1] & 0x0f) << 8) | buf[2]));
    if (sectionEnd < 16) return;
    P.pcrPid = ((buf[8] & 0x1f) << 8) | buf[9];
    var programInfoLength = ((buf[10] & 0x0f) << 8) | buf[11];
    var p = 12 + programInfoLength;
    var guard = 0;
    while (p + 5 <= sectionEnd - 4 && ++guard < 64) {
      var streamType = buf[p];
      var pid = ((buf[p + 1] & 0x1f) << 8) | buf[p + 2];
      var esInfoLength = ((buf[p + 3] & 0x0f) << 8) | buf[p + 4];
      if (!P.streams[pid]) {
        var info = STREAM_TYPES[streamType] ||
                   { name: 'Stream type 0x' + streamType.toString(16), kind: 'data', codec: null };
        var desc = parseDescriptors(buf, p + 5, Math.min(p + 5 + esInfoLength, sectionEnd));
        P.streams[pid] = {
          pid: pid, streamType: streamType, name: info.name, kind: info.kind,
          codec: info.codec, language: desc.language, descriptors: desc.list,
          frames: 0, bytes: 0, lastCc: null
        };
      }
      p += 5 + esInfoLength;
    }
  }

  function parseDescriptors(buf, start, end) {
    var out = { language: '', list: [] };
    var p = start, guard = 0;
    while (p + 2 <= end && ++guard < 64) {
      var tag = buf[p], len = buf[p + 1];
      if (p + 2 + len > end) break;
      var value = '';
      if (tag === 0x0a && len >= 3) {
        out.language = String.fromCharCode(buf[p + 2], buf[p + 3], buf[p + 4]);
        value = out.language + (len > 3 ? (buf[p + 5] & 1 ? ' (audio)' : '') : '');
      } else if (tag === 0x05 && len >= 4) {
        value = String.fromCharCode(buf[p + 2], buf[p + 3], buf[p + 4], buf[p + 5]);
      } else if (tag === 0x28 && len >= 1) {
        value = 'AVC video';
      } else if (tag === 0x2b && len >= 1) {
        value = 'VVC video';
      }
      out.list.push({ tag: tag, length: len, value: value });
      p += 2 + len;
    }
    return out;
  }

  function handleSdt(buf, P) {
    if (buf.length < 15) return;
    var sectionEnd = Math.min(buf.length, 3 + (((buf[1] & 0x0f) << 8) | buf[2]));
    var p = 11, guard = 0;
    while (p + 5 <= sectionEnd - 4 && ++guard < 32) {
      P.serviceId = (buf[p] << 8) | buf[p + 1];
      var loopEnd = p + 3 + (((buf[p + 2] & 0x0f) << 8) | buf[p + 3]);
      var q = p + 5;
      while (q + 2 <= loopEnd && q + 2 <= sectionEnd) {
        var tag = buf[q], len = buf[q + 1];
        if (q + 2 + len > sectionEnd) break;
        if (tag === 0x48 && len >= 3) {
          var r = q + 2;
          var plen = buf[r++];
          P.serviceProvider = readDvbString(buf, r, r + plen); r += plen;
          var slen = buf[r++];
          P.serviceName = readDvbString(buf, r, r + slen);
        }
        q += 2 + len;
      }
      if (loopEnd <= p) break;
      p = loopEnd;
    }
  }

  function readDvbString(buf, start, end) {
    var s = '';
    for (var i = start; i < end && i < buf.length; i++) {
      var c = buf[i];
      if (c >= 0x20 && c <= 0x7e) s += String.fromCharCode(c);   // ASCII printable only
    }
    return s.trim();
  }

  /* ------------------------------------------------------------------- PES */

  function startPes(P, pid, start, end) {
    var data = P.data;
    if (end - start < 6) return;
    if (data[start] !== 0 || data[start + 1] !== 0 || data[start + 2] !== 1) return;

    var streamId = data[start + 3];
    var pesLen = (data[start + 4] << 8) | data[start + 5];
    var esStart = start + 6;
    var esRemaining = Infinity;
    var ptsTicks = null, dtsTicks = null;

    // Stream ids 0xBC..0xFF (plus 0xF0/0xF1/0xFF/0xF2/0xF8) carry no PES
    // header extension — their payload starts right after PES_packet_length.
    var hasExt = !(streamId === 0xbc || streamId === 0xbe || streamId === 0xbf ||
                   streamId === 0xf0 || streamId === 0xf1 || streamId === 0xf2 ||
                   streamId === 0xf8 || streamId === 0xff);
    if (hasExt) {
      if (end - start < 9) return;
      var flags = data[start + 7];
      var headerLen = data[start + 8];
      esStart = start + 9 + headerLen;
      // PES_packet_length counts everything after the length field:
      // 3 header bytes + header_data_length + payload.
      if (pesLen > 0) esRemaining = Math.max(0, pesLen - 3 - headerLen);
      var ptsDtsFlags = (flags >> 6) & 3;
      // Stamps are kept as raw 90 kHz ticks; normalizeTimestamps() unwraps
      // them against a per-track reference once the whole file is walked.
      if ((ptsDtsFlags === 2 || ptsDtsFlags === 3) && start + 14 <= end) {
        ptsTicks = readTs90(data, start + 9);
        dtsTicks = ptsDtsFlags === 3 ? readTs90(data, start + 14) : ptsTicks;
      }
    } else if (pesLen > 0) {
      esRemaining = pesLen;
    }
    if (esStart > end) esStart = end;

    P.pes[pid] = {
      streamId: streamId,
      remain: esRemaining,
      ptsTicks: ptsTicks, dtsTicks: dtsTicks,
      parts: [],
      contiguous: true,
      lastEnd: end,
      bytes: 0,
      head: null,
      overflow: false
    };
    appendPes(P, pid, esStart, end);
  }

  function appendPes(P, pid, start, end) {
    var pes = P.pes[pid];
    if (!pes || pes.remain <= 0) return;
    var take = Math.min(end - start, pes.remain === Infinity ? end - start : pes.remain);
    if (take <= 0) return;

    if (pes.parts.length && start !== pes.lastEnd) pes.contiguous = false;
    if (pes.parts.length < MAX_PARTS) {
      pes.parts.push({ offset: start, size: take });
    } else {
      pes.contiguous = false;
      pes.overflow = true;
    }
    pes.lastEnd = start + take;
    pes.bytes += take;
    if (pes.remain !== Infinity) pes.remain -= take;
  }

  function readTs90(data, off) {
    return ((data[off] >> 1) & 0x07) * 0x40000000 +
           (data[off + 1] << 22) +
           ((data[off + 2] >> 1) << 15) +
           (data[off + 3] << 7) +
           (data[off + 4] >> 1);
  }

  var TS_WRAP = 0x200000000;              // 2^33 ticks
  var TS_HALF = 0x100000000;              // 2^32, half the wrap span

  /** Move `v` to the representation closest to `ref` across the 33-bit wrap. */
  function unwrapTs(v, ref) {
    while (v - ref > TS_HALF) v -= TS_WRAP;
    while (ref - v > TS_HALF) v += TS_WRAP;
    return v;
  }

  /**
   * Convert the raw 90 kHz stamps on every frame into seconds.
   *
   * The 33-bit PTS/DTS field wraps about every 26.5 hours, and a stream may
   * legitimately start with a stamp near the wrap point — most often for DTS,
   * which goes negative ahead of the first I frame in a B-frame sequence.
   * Each track is therefore referenced to its first PTS and every stamp is
   * unwrapped towards it. Without this a frame shows PTS 00:00.000 next to a
   * DTS of 26:30:43.
   */
  function normalizeTimestamps(frames) {
    var byTrack = {};
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (f._ptsTicks == null) continue;
      var ref = byTrack[f.track];
      if (ref == null) ref = byTrack[f.track] = f._ptsTicks;

      var pts = unwrapTs(f._ptsTicks, ref);
      var dts = f._dtsTicks == null ? pts : unwrapTs(f._dtsTicks, pts);

      // A gap beyond any legal reorder delay means the stamp itself is junk —
      // report the presentation time rather than an invented value.
      if (Math.abs(dts - pts) > 90000 * 3600) {
        dts = pts;
        f.dtsSuspect = true;
      }
      f.ptsSec = pts / 90000;
      f.dtsSec = dts / 90000;
    }
  }

  /**
   * Build a contiguous copy of the first bytes of a PES. All the frame-level
   * probing (parameter-set mining, keyframe detection) needs contiguous bytes,
   * and scanning the whole file per PES would be quadratic.
   */
  function collectHead(P, pes) {
    if (pes.head) return pes.head;
    var total = Math.min(pes.bytes, MAX_ES_HEAD);
    var out = new Uint8Array(total);
    var n = 0;
    for (var i = 0; i < pes.parts.length && n < total; i++) {
      var part = pes.parts[i];
      var take = Math.min(part.size, total - n);
      out.set(P.data.subarray(part.offset, part.offset + take), n);
      n += take;
    }
    pes.head = n === total ? out : out.subarray(0, n);
    return pes.head;
  }

  function flushPes(P, pid) {
    var pes = P.pes[pid];
    if (!pes) return;
    delete P.pes[pid];
    var st = P.streams[pid];
    if (!st || !pes.parts.length || pes.bytes <= 0) return;

    var esOffset = pes.parts[0].offset;
    var head = collectHead(P, pes);

    if (st.kind === 'video') handleVideoEs(P, st, pes, head, esOffset);
    else if (st.kind === 'audio') handleAudioEs(P, st, pes, head, esOffset);
  }

  /* ------------------------------------------------------------ video frames */

  function handleVideoEs(P, st, pes, head, esOffset) {
    var cfg = P.trackConfigs[st.pid] || (P.trackConfigs[st.pid] = {
      codec: st.codec, ctx: null, info: null
    });

    var units = MA.annexBUnits(head, head.length);
    if (!units.length) return;

    var isKey = false;
    var picType = null;
    var guard = 0;
    for (var i = 0; i < units.length && guard++ < 128; i++) {
      var u = units[i];
      var h = head[u.start];
      if (h === undefined) continue;
      if (st.codec === 'h264') {
        var t = h & 0x1f;
        if (t === 5) isKey = true;
        if (t === 7) mineH264(P, cfg, head, u);
      } else if (st.codec === 'h265') {
        var t2 = (h >> 1) & 0x3f;
        if (t2 >= 16 && t2 <= 23) isKey = true;
        if (t2 === 33) mineH265(P, cfg, head, u);
      } else if (st.codec === 'h266') {
        var t3 = (h >> 3) & 0x1f;
        if (t3 >= 7 && t3 <= 11) isKey = true;
      } else if (st.codec === 'mpeg2') {
        /* picture_start: picture_coding_type at bit 10 of the header body —
         * temporal_reference is b0(8) + top 2 bits of b1, then 3 bits of type. */
        if (h === 0x00 && u.start + 2 < head.length) {
          var pct = (head[u.start + 2] >> 3) & 0x07;
          if (pct === 1) isKey = true;
          if (picType == null) picType = ['?', 'I', 'P', 'B', 'D'][pct] || null;
        } else if (h === 0xB3) {
          mineMpeg2(P, cfg, head, u);
        }
      } else if (st.codec === 'mpeg4') {
        /* vop_start: vop_coding_type in the top two bits of the header body. */
        if (h === 0xB6 && u.start + 1 < head.length) {
          var vct = head[u.start + 1] >> 6;
          if (vct === 0) isKey = true;
          if (picType == null) picType = ['I', 'P', 'B', 'S'][vct] || null;
        } else if (h >= 0x20 && h <= 0x2F) {
          mineMpeg4(P, cfg, head, u);
        } else if (h === 0xB0 && u.start + 1 < head.length && !cfg.palName) {
          var m4 = MA.getCodec('mpeg4');
          if (m4 && m4.palName) cfg.palName = m4.palName(head[u.start + 1]);
        }
      }
    }
    if (!isKey && st.frames === 0) isKey = true;      // first AU is assumed to start a GOP

    if (st.frames >= MAX_FRAMES) return;

    var frame = {
      track: st.pid, index: ++st.frames,
      type: picType || (isKey ? 'I' : 'P/B'),
      kind: 'video',
      codec: st.codec || 'video',
      offset: esOffset, size: pes.bytes,
      _ptsTicks: pes.ptsTicks, _dtsTicks: pes.dtsTicks,
      keyframe: isKey
    };
    st.bytes += pes.bytes;

    if (st.codec && MA.getCodec(st.codec)) {
      var ctxKey = 'ts:' + st.pid;
      P.codecContexts[ctxKey] = cfg.ctx || null;
      frame.syn = {
        codec: st.codec, kind: 'annexb',
        offset: esOffset, size: pes.bytes, base: esOffset, ctxKey: ctxKey
      };
      // When the payload is not contiguous we hand over the exact ranges.
      if (!pes.contiguous && !pes.overflow && pes.parts.length <= MAX_PARTS) {
        frame.syn.parts = pes.parts.map(function (r) { return { offset: r.offset, size: r.size }; });
        frame.syn.offset = pes.parts[0].offset;
        frame.syn.size = pes.bytes;
      } else if (!pes.contiguous) {
        frame.syn = null;                    // too fragmented to re-read reliably
      }
    }
    P.frames.push(frame);
  }

  function mineH264(P, cfg, head, unit) {
    var codec = MA.getCodec('h264');
    if (!codec || cfg.info) return;
    try {
      var res = codec.parseSPS(MA.unescapeRbsp(head, unit.start + 1, unit.end), 0);
      if (!res.info) return;
      if (!cfg.ctx) cfg.ctx = codec.makeContext();
      cfg.ctx.sps = res.info;
      cfg.ctx.spsById[res.info.spsId] = res.info;
      cfg.info = res.info;
    } catch (e) { /* a damaged SPS must not abort the stream */ }
  }

  function mineH265(P, cfg, head, unit) {
    var codec = MA.getCodec('h265');
    if (!codec || !codec.parseSPS || cfg.info) return;
    try {
      var res = codec.parseSPS(MA.unescapeRbsp(head, unit.start + 2, unit.end), 0);
      if (res && res.info) {
        if (!cfg.ctx) cfg.ctx = codec.makeContext ? codec.makeContext() : {};
        cfg.ctx.sps = res.info;
        cfg.info = res.info;
      }
    } catch (e) { /* ignore */ }
  }

  /** MPEG-2: the sequence header carries the whole track geometry. */
  function mineMpeg2(P, cfg, head, unit) {
    var codec = MA.getCodec('mpeg2');
    if (!codec || cfg.info) return;
    try {
      var res = codec.parseSequenceHeader(head.subarray(unit.start + 1, unit.end), 0);
      if (res && res.info && res.info.width) cfg.info = res.info;
    } catch (e) { /* a damaged header must not abort the stream */ }
  }

  /**
   * MPEG-4: mine the VOL for geometry, and keep it on the shared codec
   * context — the width of every later VOP's time_increment field is derived
   * from vop_time_increment_resolution, which lives only in the VOL.
   */
  function mineMpeg4(P, cfg, head, unit) {
    var codec = MA.getCodec('mpeg4');
    if (!codec || cfg.volMined) return;
    try {
      var res = codec.parseVOL(head.subarray(unit.start + 1, unit.end), 0);
      if (res && res.info) {
        cfg.volMined = true;
        cfg.info = res.info;
        if (!cfg.ctx) cfg.ctx = {};
        cfg.ctx.vol = res.info;
      }
    } catch (e) { /* ignore */ }
  }

  /* ------------------------------------------------------------ audio frames */

  function handleAudioEs(P, st, pes, head, esOffset) {
    // Refine the codec when the PMT only said "private data".
    if (!st.codec) {
      if (head[0] === 0xff && (head[1] & 0xf6) === 0xf0) st.codec = 'aac';
      else if (head[0] === 0x0b && head[1] === 0x77) st.codec = 'ac3';
      else if ((head[0] & 0xe0) === 0xe0) st.codec = 'mp3';
    }

    var baseTicks = pes.ptsTicks != null ? pes.ptsTicks
                  : (pes.dtsTicks != null ? pes.dtsTicks : null);

    if (st.codec === 'aac') {
      // Read the first ADTS header for the track parameters regardless of
      // whether the PES is contiguous — the head buffer always starts there.
      if (!st.sampleRate && head.length >= 7 && head[0] === 0xff) {
        var hsr = ADTS_RATES[(head[2] >> 2) & 0x0f];
        var hch = ((head[2] & 1) << 2) | (head[3] >> 6);
        if (hsr) st.sampleRate = hsr;
        if (hch) st.channels = hch;
      }
      // One PES normally carries several ADTS frames. Enumerating them needs a
      // contiguous byte range per frame, so this only runs when the payload
      // really is back-to-back in the file.
      if (pes.contiguous && !pes.overflow && pes.parts.length) {
        var data = P.data;
        var start = pes.parts[0].offset;
        var end = start + pes.bytes;
        var p = start, count = 0, dur = st.sampleRate ? 1024 / st.sampleRate : 1024 / 48000;
        while (p + 7 <= end && count < 512 && st.frames < MAX_FRAMES) {
          if (data[p] !== 0xff || (data[p + 1] & 0xf6) !== 0xf0) break;
          var flen = ((data[p + 3] & 0x03) << 11) | (data[p + 4] << 3) | (data[p + 5] >> 5);
          if (flen < 7 || p + flen > end) break;
          var sr = ADTS_RATES[(data[p + 2] >> 2) & 0x0f];
          if (sr) { dur = 1024 / sr; st.sampleRate = sr; }
          var chCfg = ((data[p + 2] & 1) << 2) | (data[p + 3] >> 6);
          if (chCfg) st.channels = chCfg;
          P.frames.push({
            track: st.pid, index: ++st.frames, type: 'audio', kind: 'audio',
            codec: 'aac', offset: p, size: flen,
            // One ADTS frame is 1024 samples; convert that to 90 kHz ticks so
            // the timestamp stays integral until normalizeTimestamps().
            _ptsTicks: baseTicks == null ? null
                      : baseTicks + Math.round(count * 1024 * 90000 / (st.sampleRate || 48000)),
            _dtsTicks: null,
            durationSec: dur, keyframe: false,
            syn: { codec: 'aac', kind: 'adts', offset: p, size: flen, base: p }
          });
          st.bytes += flen;
          p += flen; count++;
        }
        if (count) return;
      }
    }

    if (st.frames >= MAX_FRAMES) return;
    var syn = null;
    if (st.codec && MA.getCodec(st.codec)) {
      syn = {
        codec: st.codec, kind: st.codec === 'aac' ? 'adts' : 'raw',
        offset: esOffset, size: pes.bytes, base: esOffset
      };
      // The access unit is spread over several TS packets here, so hand the
      // resolver the individual payload ranges to stitch back together.
      if (!pes.contiguous && !pes.overflow && pes.parts.length <= MAX_PARTS) {
        syn.parts = pes.parts.map(function (r) { return { offset: r.offset, size: r.size }; });
      }
    }
    P.frames.push({
      track: st.pid, index: ++st.frames, type: 'audio', kind: 'audio',
      codec: st.codec || 'audio',
      offset: esOffset, size: pes.bytes,
      _ptsTicks: baseTicks, _dtsTicks: null,
      keyframe: false,
      syn: syn
    });
    st.bytes += pes.bytes;
  }

  /* ------------------------------------------------------------ track build */

  function buildTracks(P, ctx) {
    var tracks = [];
    Object.keys(P.streams).forEach(function (pidStr) {
      var st = P.streams[pidStr];
      if (!st.frames) return;
      var cfg = P.trackConfigs[st.pid] || {};
      var info = cfg.info || {};
      var type = st.kind === 'video' ? 'video' : st.kind === 'audio' ? 'audio' : 'other';

      var track = {
        id: st.pid, type: type,
        codec: st.codec || String(st.streamType),
        codecName: CODEC_NAMES[st.codec] || st.name,
        profile: info.profile || cfg.palName || '', level: info.level || '',
        width: info.width || null, height: info.height || null,
        fps: info.fps || null,
        sampleRate: st.sampleRate || null,
        channels: st.channels || null,
        sampleCount: st.frames,
        bitrate: null, durationSec: null,
        language: st.language || '',
        extra: [
          { label: 'PID', value: '0x' + MA.pad(st.pid.toString(16), 4, '0') + ' (' + st.pid + ')' },
          { label: 'stream_type', value: '0x' + MA.pad(st.streamType.toString(16), 2, '0') + ' — ' + st.name }
        ],
        streamType: st.streamType, bytes: st.bytes
      };
      tracks.push(track);
    });
    return tracks;
  }

  /* -------------------------------------------------------------- structures */

  function buildStructures(P) {
    var roots = [];

    var patNode = MA.makeNode('table', 'PAT', 'Program Association Table', 0, 0);
    MA.nodeField(patNode, 'transport_stream_id', '—', 0, 0);
    MA.nodeField(patNode, 'program_number', P.programNumber != null ? String(P.programNumber) : '—', 0, 0);
    MA.nodeField(patNode, 'PMT PID', P.pmtPid != null ? '0x' + MA.pad(P.pmtPid.toString(16), 4, '0') : '—', 0, 0);
    MA.nodeField(patNode, 'packets scanned', String(P.packetCount), 0, 0);
    MA.nodeField(patNode, 'packet size', P.stride + ' bytes', 0, 0);
    if (P.lastPcr != null) MA.nodeField(patNode, 'last PCR', P.lastPcr.toFixed(3) + ' s', 0, 0);
    roots.push(patNode);

    Object.keys(P.streams).forEach(function (pidStr) {
      var st = P.streams[pidStr];
      var node = MA.makeNode('stream', 'PID 0x' + MA.pad(st.pid.toString(16), 4, '0'), st.name, 0, 0);
      MA.nodeField(node, 'stream_type', '0x' + MA.pad(st.streamType.toString(16), 2, '0'), 0, 0);
      MA.nodeField(node, 'kind', st.kind, 0, 0);
      if (st.language) MA.nodeField(node, 'language', st.language, 0, 0);
      MA.nodeField(node, 'frames', String(st.frames), 0, 0);
      MA.nodeField(node, 'payload bytes', MA.formatSize(st.bytes || 0), 0, 0);
      st.descriptors.forEach(function (d, i) {
        if (d.value) {
          MA.nodeField(node, 'descriptor[' + i + '] (tag 0x' + MA.pad(d.tag.toString(16), 2, '0') + ')',
                       d.value, 0, 0);
        }
      });
      roots.push(node);
    });

    if (P.serviceName || P.serviceProvider) {
      var sdt = MA.makeNode('table', 'SDT', 'Service Description Table', 0, 0);
      if (P.serviceId != null) MA.nodeField(sdt, 'service_id', String(P.serviceId), 0, 0);
      if (P.serviceName) MA.nodeField(sdt, 'service_name', P.serviceName, 0, 0);
      if (P.serviceProvider) MA.nodeField(sdt, 'service_provider', P.serviceProvider, 0, 0);
      roots.push(sdt);
    }

    /* ---- one node per TS packet (capped) — sync byte, header flags, PID,
     * continuity counter, adaptation field and PCR, payload size ---- */
    if (P.packetRecords.length) {
      var pkRoot = MA.makeNode('group', 'packets',
        'TS packets (' + P.packetRecords.length + ' of ' + P.packetCount + ')',
        P.packetRecords[0].offset, 0);
      P.packetRecords.forEach(function (r) {
        pkRoot.children.push(packetNode(P, r));
      });
      roots.push(pkRoot);
    }
    return roots;
  }

  var AFC_NAMES = ['reserved', 'payload only', 'adaptation field only',
                   'adaptation field + payload'];
  var SCRAMBLING_NAMES = ['not scrambled', 'reserved', 'scrambled (even key)',
                          'scrambled (odd key)'];

  function pidRole(P, pid) {
    if (pid === 0) return 'PAT';
    if (pid === 0x11) return 'SDT';
    if (pid === 0x1fff) return 'null stuffing';
    if (P.pmtPid != null && pid === P.pmtPid) return 'PMT';
    var st = P.streams[pid];
    if (st) return st.name;
    return '';
  }

  function packetNode(P, r) {
    var role = pidRole(P, r.pid);
    var pidText = '0x' + MA.pad(r.pid.toString(16), 4, '0') + ' (' + r.pid + ')' +
                  (role ? ' — ' + role : '');
    var node = MA.makeNode('packet', 'packet',
      '#' + r.index + '  PID ' + pidText, r.offset, r.size);
    var b = r.offset + P.syncOffset;
    MA.nodeField(node, 'sync_byte', '0x47', b, 1);
    MA.nodeField(node, 'transport_error_indicator', r.tei ? '1 (error!)' : '0', b + 1, 1);
    MA.nodeField(node, 'payload_unit_start_indicator', r.pusi ? '1 (PES/PSI start)' : '0', b + 1, 1);
    MA.nodeField(node, 'transport_priority', String(r.prio ? 1 : 0), b + 1, 1);
    MA.nodeField(node, 'PID', pidText, b + 1, 2);
    MA.nodeField(node, 'transport_scrambling_control', SCRAMBLING_NAMES[r.scrambling], b + 3, 1);
    MA.nodeField(node, 'adaptation_field_control', AFC_NAMES[r.afc], b + 3, 1);
    MA.nodeField(node, 'continuity_counter', String(r.cc), b + 3, 1);
    if (r.afc === 2 || r.afc === 3) {
      MA.nodeField(node, 'adaptation_field_length', String(r.afLen), b + 4, 1);
      if (r.afLen > 0) {
        var fl = [];
        if (r.afFlags & 0x80) fl.push('discontinuity');
        if (r.afFlags & 0x40) fl.push('random_access');
        if (r.afFlags & 0x20) fl.push('ES_priority');
        if (r.afFlags & 0x10) fl.push('PCR');
        if (r.afFlags & 0x08) fl.push('OPCR');
        if (r.afFlags & 0x04) fl.push('splicing_point');
        if (r.afFlags & 0x02) fl.push('private_data');
        if (r.afFlags & 0x01) fl.push('extension');
        MA.nodeField(node, 'adaptation_field_flags', fl.length ? fl.join(', ') : 'none', b + 5, 1);
        if (r.pcr != null) MA.nodeField(node, 'PCR', r.pcr.toFixed(6) + ' s', b + 6, 6);
      }
    }
    if (r.payload) MA.nodeField(node, 'payload', r.payload + ' bytes', b + 4 + (r.afc === 2 || r.afc === 3 ? 1 + r.afLen : 0), r.payload);
    return node;
  }

  MA.registerParser({
    id: 'ts',
    name: 'MPEG-TS',
    extensions: ['ts', 'm2ts', 'mts', 'm2t', 'tp', 'trp'],
    parse: parse
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
