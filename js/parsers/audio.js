/* ============================================================================
 * MediaAnalyzer — parsers/audio.js
 *
 * Container-level parsers for the raw (headerless-container) audio formats:
 *   .mp3    MPEG-1/2/2.5 Audio Layer I-III, with ID3v2 at the front
 *   .aac    ADTS-framed AAC
 *   .flac   native FLAC stream
 *   .ac3    AC-3 / E-AC-3 sync-frame stream
 *
 * All three are thin adapters: the actual frame walking, header decoding and
 * syntax-table building live in js/codecs/{mp3,aac,flac}.js, which expose a
 * common `analyzeStream(data, ctx) -> {tables, frames, track, info}`. Keeping
 * one adapter here avoids three near-identical copies drifting apart.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  /**
   * Run a codec's stream analyser and lift its result into the standard
   * parser result shape.
   *
   * @param {object} ctx       the parser context
   * @param {string} codecId   key into MA.codecs
   * @param {object} opts      { formatId, formatName, structures }
   */
  function wrapStream(ctx, codecId, opts) {
    var codec = MA.getCodec(codecId);
    var base = {
      formatId: opts.formatId,
      formatName: opts.formatName,
      durationSec: null, bitrate: null,
      tracks: [], metadata: [], structures: [], frames: [],
      notes: [], codecContexts: {}
    };
    if (!codec || !codec.analyzeStream) {
      base.notes.push('The ' + codecId + ' codec module is not loaded.');
      return base;
    }

    var res;
    try {
      res = codec.analyzeStream(ctx.data, { maxFrames: 60000 });
    } catch (e) {
      base.notes.push('Stream analysis failed: ' + (e && e.message || e));
      return base;
    }

    var info = res.info || {};

    // ---- frames ------------------------------------------------------
    var frames = [];
    for (var i = 0; i < res.frames.length; i++) {
      var f = res.frames[i];
      frames.push({
        track: 1,
        index: f.index != null ? f.index + 1 : i + 1,
        type: 'audio',
        kind: 'audio',
        codec: codecId,
        offset: f.offset,
        size: f.size,
        ptsSec: f.ptsSec != null ? f.ptsSec : (f.timestamp != null ? f.timestamp : 0),
        dtsSec: f.ptsSec != null ? f.ptsSec : (f.timestamp != null ? f.timestamp : 0),
        durationSec: f.duration || f.durationSec || 0,
        keyframe: f.keyframe !== false,
        // The codec modules already hand back a lazy recipe under `syntax`.
        syn: f.syn || f.syntax || null,
        // Carry the codec-specific detail through for the frame detail panel.
        detail: f
      });
    }
    base.frames = frames;

    // ---- track -------------------------------------------------------
    if (res.track) {
      var t = res.track;
      base.tracks.push({
        id: 1,
        type: 'audio',
        codec: codecId,
        codecName: t.codecName || codecId,
        profile: t.profile || '',
        level: '',
        sampleRate: t.sampleRate || null,
        channels: t.channels || null,
        channelLayout: t.channelLayout || layoutName(t.channels),
        bitDepth: t.bitDepth || null,
        durationSec: t.durationSec || null,
        bitrate: t.bitrate || null,
        sampleCount: t.sampleCount || frames.length,
        language: '',
        extra: extraRows(t, info)
      });
      base.durationSec = t.durationSec || null;
      base.bitrate = t.bitrate || null;
    }

    // ---- metadata ----------------------------------------------------
    collectMetadata(base, info, res);

    // ---- structures --------------------------------------------------
    if (opts.structures) base.structures = opts.structures(ctx, res, base);
    else base.structures = defaultStructures(ctx, res, base);

    // ---- notes -------------------------------------------------------
    if (info.error) base.notes.push(String(info.error));
    if (info.note) base.notes.push(String(info.note));
    if (info.truncated) base.notes.push('The final frame is truncated by ' + info.truncated + ' bytes.');
    if (info.resyncs) base.notes.push('Resynchronised ' + info.resyncs + ' time(s) after a damaged frame.');
    if (info.frameCapReached) base.notes.push('Frame scan stopped at the internal cap.');
    if (base.frames.length >= 60000) base.notes.push('Frame list capped at 60000 frames.');

    return base;
  }

  function layoutName(ch) {
    if (!ch) return '';
    if (ch === 1) return '1 (mono)';
    if (ch === 2) return '2 (stereo)';
    if (ch === 6) return '6 (5.1)';
    if (ch === 8) return '8 (7.1)';
    return String(ch);
  }

  function extraRows(t, info) {
    var rows = [];
    if (t.vendor) rows.push({ label: 'Encoder / vendor', value: t.vendor });
    if (t.md5) rows.push({ label: 'MD5 signature', value: t.md5 });
    if (t.frameCount != null) rows.push({ label: 'Frames', value: String(t.frameCount) });
    if (info.bitsPerSample) rows.push({ label: 'Bits per sample', value: info.bitsPerSample });
    if (info.minBlockSize) rows.push({ label: 'Block size', value: info.minBlockSize + ' – ' + info.maxBlockSize });
    if (info.wastedBits) rows.push({ label: 'Wasted bits', value: String(info.wastedBits) });
    if (info.version) rows.push({ label: 'MPEG version', value: info.version });
    if (info.layer) rows.push({ label: 'Layer', value: String(info.layer) });
    if (info.isVbr != null) rows.push({ label: 'Bitrate mode', value: info.isVbr ? 'VBR' : 'CBR' });
    if (info.id3v2Size) rows.push({ label: 'ID3v2 tag', value: MA.formatSize(info.id3v2Size) });
    if (info.xing) {
      rows.push({ label: 'Xing/LAME header', value: info.xing.encoder || 'present' });
      if (info.xing.frameCount) rows.push({ label: 'Declared frames', value: String(info.xing.frameCount) });
    }
    return rows;
  }

  function collectMetadata(base, info, res) {
    var seen = {};
    function add(key, value) {
      if (value == null || value === '' || seen[key]) return;
      seen[key] = 1;
      base.metadata.push({ key: key, value: String(value) });
    }
    var m = res.metadata || info.metadata || {};
    if (Array.isArray(m)) {
      m.forEach(function (row) { add(row.key || row.k, row.value || row.v); });
    } else {
      Object.keys(m).forEach(function (k) { add(k, m[k]); });
    }
    // Vorbis-comment style entries the codecs keep on the track.
    if (res.track && res.track.extraMetadata) {
      Object.keys(res.track.extraMetadata).forEach(function (k) {
        add(k, res.track.extraMetadata[k]);
      });
    }
  }

  /** A minimal structure list: one node per metadata region plus the frames. */
  function defaultStructures(ctx, res, base) {
    var nodes = [];
    if (res.metadataBlocks && res.metadataBlocks.length) {
      res.metadataBlocks.forEach(function (b) {
        var n = MA.makeNode(b.kind || 'block', b.code || '', b.name || '', b.offset, b.size);
        (b.fields || []).forEach(function (f) {
          MA.nodeField(n, f.name, f.value, f.offset, f.size);
        });
        nodes.push(n);
      });
    }
    if (!nodes.length && res.info && res.info.id3v2Size) {
      var id3 = MA.makeNode('tag', 'ID3v2', 'ID3v2 tag', 0, res.info.id3v2Size);
      MA.nodeField(id3, 'size', MA.formatSize(res.info.id3v2Size), 0, 4);
      nodes.push(id3);
    }
    return nodes;
  }

  /* ====================================================================== */

  function parseMp3(ctx) {
    return wrapStream(ctx, 'mp3', {
      formatId: 'mp3',
      formatName: 'MP3 (MPEG Audio Layer III)'
    });
  }

  function parseAdts(ctx) {
    return wrapStream(ctx, 'aac', {
      formatId: 'adts',
      formatName: 'AAC (ADTS elementary stream)'
    });
  }

  function parseFlac(ctx) {
    return wrapStream(ctx, 'flac', {
      formatId: 'flac',
      formatName: 'FLAC (Free Lossless Audio Codec)'
    });
  }

  function parseAc3(ctx) {
    return wrapStream(ctx, 'ac3', {
      formatId: 'ac3',
      formatName: 'AC-3 / E-AC-3 elementary stream'
    });
  }

  MA.registerParser({ id: 'mp3', name: 'MP3', extensions: ['mp3', 'mp2', 'mpga', 'mpa'], parse: parseMp3 });
  MA.registerParser({ id: 'ac3', name: 'AC-3 / E-AC-3', extensions: ['ac3', 'ec3', 'eac3'], parse: parseAc3 });
  MA.registerParser({ id: 'adts', name: 'AAC (ADTS)', extensions: ['aac', 'adts'], parse: parseAdts });
  MA.registerParser({ id: 'flac', name: 'FLAC', extensions: ['flac'], parse: parseFlac });
})(typeof globalThis !== 'undefined' ? globalThis : this);
