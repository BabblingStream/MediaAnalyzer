/* ============================================================================
 * MediaAnalyzer — framesyntax.js
 *
 * Resolves a frame's lazy `syn` recipe into syntax tables.
 *
 * Why a recipe instead of a closure: the obvious implementation is
 *
 *     frame.buildSyntax = () => bytes.range(frame.offset, frame.size)
 *                                     .then(slice => parse(slice));
 *
 * but that closure captures whatever the parser had in scope — for TS it was
 * the reassembled PES payload, so a 131 MB stream kept ~170 MB of payloads
 * alive after parsing had finished. A recipe is a plain object of numbers and
 * strings; the app resolves it on demand, and the sample bytes are read from
 * the ByteSource, used, and dropped.
 *
 * Recipe shape (the `syn` property of a frame):
 *
 *   { codec   : 'h264' | 'h265' | 'h266' | 'vp8' | 'vp9' | 'av1' | 'av2'
 *             | 'aac' | 'flac' | 'mp3' | 'adts' | 'vorbis' | 'opus'
 *   , kind    : 'sample' | 'annexb' | 'raw' | 'adts' | 'flac-frame' | 'mp3-frame'
 *   , offset  : Number   absolute file offset of the sample
 *   , size    : Number   byte length of the sample
 *   , lengthSize : Number  NAL length prefix width (length-prefixed samples)
 *   , annexB  : Boolean    sample uses Annex B start codes
 *   , ctxKey  : String     key into result.codecContexts
 *   , off     : Number     alias for offset used by some codecs
 *   , index, type, label … free-form extras handed to the codec
 *   }
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  /**
   * Static table used when no codec module can decode the sample — subtitle
   * and timed-text tracks, playlist entries, and samples from a codec this
   * build does not implement. It still reports everything the container knew
   * about the sample, so the panel is never empty.
   */
  function rawTable(frame) {
    var rows = [];
    var add = function (name, value, note) {
      if (value == null || value === '') return;
      rows.push({ name: name, syntax: '', bits: '', value: value,
                  note: note || '', offset: frame.offset, depth: 0 });
    };
    add('track', frame.track);
    add('codec', frame.codec);
    add('sample_index', frame.index);
    add('file_offset', MA.hex(frame.offset, 8));
    add('length', MA.formatSize(frame.size) + ' (' + frame.size + ' bytes)');
    if (frame.keyframe != null) add('keyframe', frame.keyframe ? 'yes' : 'no');
    if (frame.ptsSec != null) add('pts', MA.formatDuration(frame.ptsSec) + ' (' + frame.ptsSec.toFixed(6) + ' s)');
    if (frame.dtsSec != null) add('dts', MA.formatDuration(frame.dtsSec) + ' (' + frame.dtsSec.toFixed(6) + ' s)');
    if (frame.durationSec) add('duration', MA.formatMs(frame.durationSec));

    // Frame-specific extras the parsers record (codec detail, chunk ids, …).
    var detail = frame.detail;
    if (detail && typeof detail === 'object') {
      Object.keys(detail).forEach(function (k) {
        if (k === 'syntax' || k === 'syn' || k === 'tables' || k === 'detail') return;
        var v = detail[k];
        if (v == null || typeof v === 'object') return;
        if (typeof v === 'number' && !isFinite(v)) return;
        add(k, MA.formatNum(v));
      });
    }

    rows.push({
      name: '', syntax: '', bits: '', value: '',
      note: 'No codec syntax is decoded for this sample type.', offset: frame.offset, depth: 0
    });

    return [MA.synSection('sample', frame.label ? frame.label + ' — ' + (frame.codec || '') : (frame.codec || ''),
                           rows)];
  }

  /**
   * Resolve the syntax tables for one frame.
   * @param {object} result  the parsed result (for `codecContexts`)
   * @param {object} frame
   * @param {object} bytes   ByteSource used to re-read the sample
   * @returns {Promise<Array>} tables (never rejects — errors become a table)
   */
  function buildFrameSyntax(result, frame, bytes) {
    // Header / config frames carry their tables eagerly; nothing to do.
    if (frame.tables && frame.tables.length) return Promise.resolve(frame.tables);

    var syn = frame.syn;
    if (!syn) return Promise.resolve(rawTable(frame));

    // Some recipes embed a precomputed table (raw streams parsed at load time).
    if (syn.tables) return Promise.resolve(syn.tables);

    var offset = syn.offset != null ? syn.offset : frame.offset;
    var size = syn.size != null ? syn.size : frame.size;

    return Promise.resolve()
      .then(function () {
        if (!bytes || typeof bytes.range !== 'function') {
          throw new Error('no byte source available');
        }
        // An elementary stream carried over MPEG-TS is not always contiguous in
        // the file: its 184-byte payloads are interleaved with other PIDs. In
        // that case the recipe lists the individual ranges and we stitch them.
        if (syn.parts && syn.parts.length) {
          return Promise.all(syn.parts.map(function (r) {
            return bytes.range(r.offset, r.size);
          })).then(MA.concatBytes);
        }
        return bytes.range(offset, size);
      })
      .then(function (payload) {
        return dispatch(result, frame, syn, payload);
      })
      .catch(function (err) {
        return [MA.synSection('Sample', frame.label || '', [
          { name: 'error', syntax: '', bits: '', value: String(err && err.message || err),
            note: 'the sample could not be read or decoded', offset: offset, depth: 0 },
          { name: 'file_offset', syntax: '', bits: '', value: MA.hex(offset, 8), note: '', offset: offset, depth: 0 },
          { name: 'length', syntax: '', bits: '', value: (size || 0) + ' bytes', note: '', offset: offset, depth: 0 }
        ])];
      });
  }

  function dispatch(result, frame, syn, payload) {
    var contexts = (result && result.codecContexts) || {};
    var cctx = syn.ctxKey != null ? contexts[syn.ctxKey] : null;
    var codec = MA.getCodec(syn.codec);
    var base = syn.base != null ? syn.base : syn.offset;

    switch (syn.kind) {
      case 'annexb':
        // An Annex-B sample may itself contain several NAL units (a whole
        // access unit) or exactly one (a TS PES payload carries one AU).
        if (codec && codec.buildSampleSyntax) {
          return codec.buildSampleSyntax(payload, {
            annexB: true, base: base, ctx: cctx, frame: frame
          });
        }
        break;

      case 'sample':
        if (codec && codec.buildSampleSyntax) {
          return codec.buildSampleSyntax(payload, {
            lengthSize: syn.lengthSize || 4,
            annexB: !!syn.annexB,
            base: base, ctx: cctx, frame: frame
          });
        }
        break;

      case 'adts':
        if (codec && codec.buildSampleSyntax) {
          return codec.buildSampleSyntax(payload, { base: base, ctx: cctx, frame: frame });
        }
        break;

      case 'flac-frame':
        if (codec && codec.parseFrame) {
          var res = codec.parseFrame(payload, 0, payload.length, cctx || {});
          return res.tables || rawTable(frame);
        }
        break;

      case 'mp3-frame':
        if (codec && codec.parseFrameHeader) {
          var m = codec.parseFrameHeader(payload, 0, base);
          return m && m.tables ? m.tables : rawTable(frame);
        }
        break;

      case 'ac3-syncframe':
        if (codec && codec.buildSampleSyntax) {
          var a = codec.buildSampleSyntax(payload, { base: base, ctx: cctx });
          if (a && a.length) {
            // The codec emitted offsets relative to the sample; move them onto
            // the file so the syntax rows link into the hex view.
            if (base) a.forEach(function (t) {
              t.rows.forEach(function (row) { if (row.offset != null) row.offset += base; });
            });
            return a;
          }
        }
        break;

      case 'obu':
        if (codec && codec.analyzeOBUs) return codec.analyzeOBUs(payload, base).tables;
        if (codec && codec.buildSampleSyntax) return codec.buildSampleSyntax(payload, { base: base });
        break;

      case 'raw':
      default:
        if (codec && codec.buildSampleSyntax) {
          return codec.buildSampleSyntax(payload, { base: base, ctx: cctx, frame: frame });
        }
        break;
    }
    return rawTable(frame);
  }

  MA.buildFrameSyntax = buildFrameSyntax;
})(typeof globalThis !== 'undefined' ? globalThis : this);
