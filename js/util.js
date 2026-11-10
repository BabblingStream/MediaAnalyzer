/* ============================================================================
 * MediaAnalyzer — util.js
 * Core low-level helpers shared by every parser.
 *
 *   - formatting helpers (size / duration / bitrate / frequency / hex)
 *   - ByteReader   : random access big- & little-endian byte reader
 *   - BitReader    : MSB-first bit reader with Exp-Golomb + EPB removal
 *   - SyntaxReader : BitReader that records every syntax element as a row,
 *                    producing tables that look like the spec text
 *   - ByteSource   : lazy random access over File / Blob / HTTP / memory
 *   - NAL helpers  : Annex-B scan, length-prefixed walk, RBSP unescape
 *   - structure tree helpers (makeNode / nodeField)
 *
 * Everything hangs off the global `MA` namespace. No modules/bundler is used
 * so that the page keeps working when opened straight from `file://`.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  /* ==========================================================================
   * Formatting
   * ========================================================================*/

  function pad(n, w, ch) {
    var s = String(n);
    ch = ch || '0';
    while (s.length < w) s = ch + s;
    return s;
  }

  /** 0x-prefixed upper case hex, zero padded to `w` digits. */
  function hex(n, w) {
    if (typeof n !== 'number' || !isFinite(n)) return '0x—';
    return '0x' + pad(Math.floor(n).toString(16).toUpperCase(), w || 0);
  }

  function formatSize(bytes) {
    if (bytes == null || isNaN(bytes)) return '—';
    var neg = bytes < 0;
    if (neg) bytes = -bytes;
    var out;
    if (bytes < 1024) out = bytes + ' B';
    else {
      var units = ['KB', 'MB', 'GB', 'TB'];
      var v = bytes, i = -1;
      do { v /= 1024; i++; } while (v >= 1024 && i < units.length - 1);
      out = v.toFixed(v >= 100 ? 0 : v >= 10 ? 1 : 2) + ' ' + units[i];
    }
    return (neg ? '-' : '') + out;
  }

  /** Seconds -> HH:MM:SS.mmm (hours dropped when zero). */
  function formatDuration(sec) {
    if (sec == null || !isFinite(sec) || sec < 0) return '—';
    var h = Math.floor(sec / 3600);
    var m = Math.floor((sec % 3600) / 60);
    var s = sec % 60;
    var ss = (s < 10 ? '0' : '') + s.toFixed(3);
    return (h ? pad(h, 2) + ':' : '') + pad(m, 2) + ':' + ss;
  }

  /** Milliseconds of a single duration value. */
  function formatMs(sec) {
    if (sec == null || !isFinite(sec)) return '—';
    return (sec * 1000).toFixed(1) + ' ms';
  }

  function formatBitrate(bps) {
    if (bps == null || !isFinite(bps) || bps <= 0) return '—';
    if (bps >= 1e6) return (bps / 1e6).toFixed(2) + ' Mbps';
    if (bps >= 1e3) return (bps / 1e3).toFixed(1) + ' kbps';
    return Math.round(bps) + ' bps';
  }

  function formatHz(hz) {
    if (hz == null || !isFinite(hz) || hz <= 0) return '—';
    if (hz >= 1000) {
      var k = hz / 1000;
      return (Number.isInteger(k) ? k : k.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')) + ' kHz';
    }
    return Math.round(hz) + ' Hz';
  }

  /** Compact number: integers plain, floats trimmed to 3 decimals. */
  function formatNum(v) {
    if (v == null) return '—';
    if (typeof v !== 'number') return String(v);
    if (!isFinite(v)) return String(v);
    if (Number.isInteger(v)) return String(v);
    return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '');
  }

  function formatFps(v) {
    if (v == null || !isFinite(v) || v <= 0) return '—';
    return (v >= 100 ? v.toFixed(1) : v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')) + ' fps';
  }

  function formatChannels(n) {
    if (!n) return '—';
    return n + (n === 1 ? ' (mono)' : n === 2 ? ' (stereo)' : '');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

  /** Human readable byte count for a bit length. */
  function bitsToBytes(bits) { return Math.ceil((bits || 0) / 8); }

  /* ==========================================================================
   * ByteReader — random access, big endian by default
   * ========================================================================*/

  function ByteReader(buf, baseOffset) {
    this.u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
    this.dv = new DataView(this.u8.buffer, this.u8.byteOffset, this.u8.byteLength);
    this.base = baseOffset || 0;   // logical offset of u8[0] within the whole file
    this.length = this.u8.byteLength;
    this.pos = 0;
  }

  ByteReader.prototype = {
    seek: function (p) { this.pos = p; return this; },
    skip: function (n) { this.pos += n; return this; },
    eof: function () { return this.pos >= this.length; },
    remaining: function () { return this.length - this.pos; },
    /** Absolute (file) position corresponding to the current cursor. */
    abs: function () { return this.base + this.pos; },

    /* ---- unsigned, big endian ---- */
    u8v:  function () { return this.u8[this.pos++]; },
    u16v: function () { var v = this.dv.getUint16(this.pos); this.pos += 2; return v; },
    u24v: function () {
      var b = this.u8, p = this.pos; this.pos += 3;
      return (b[p] * 65536 + b[p + 1] * 256 + b[p + 2]) >>> 0;
    },
    u32v: function () { var v = this.dv.getUint32(this.pos); this.pos += 4; return v; },
    /** 64-bit read that loses no precision below 2^53 (enough for media sizes). */
    u64v: function () {
      var hi = this.dv.getUint32(this.pos), lo = this.dv.getUint32(this.pos + 4);
      this.pos += 8;
      return hi * 0x100000000 + lo;
    },
    /** 64-bit read returned as a BigInt, for full precision (mtime, etc.). */
    u64big: function () {
      var v = this.dv.getBigUint64(this.pos); this.pos += 8; return v;
    },

    /* ---- signed ---- */
    i8v:  function () { var v = this.u8[this.pos++]; return v > 127 ? v - 256 : v; },
    i16v: function () { var v = this.u16v(); return v > 0x7fff ? v - 0x10000 : v; },
    i32v: function () { return this.dv.getInt32((this.pos += 4) - 4); },

    /* ---- little endian ---- */
    u16le: function () { var v = this.dv.getUint16(this.pos, true); this.pos += 2; return v; },
    u24le: function () {
      var b = this.u8, p = this.pos; this.pos += 3;
      return (b[p] + b[p + 1] * 256 + b[p + 2] * 65536) >>> 0;
    },
    u32le: function () { var v = this.dv.getUint32(this.pos, true); this.pos += 4; return v; },
    u64le: function () {
      var lo = this.dv.getUint32(this.pos, true), hi = this.dv.getUint32(this.pos + 4, true);
      this.pos += 8;
      return hi * 0x100000000 + lo;
    },

    /* ---- random access without moving the cursor ---- */
    u8at:  function (p) { return this.u8[p]; },
    u16at: function (p) { return this.dv.getUint16(p); },
    u32at: function (p) { return this.dv.getUint32(p); },
    u64at: function (p) {
      return this.dv.getUint32(p) * 0x100000000 + this.dv.getUint32(p + 4);
    },

    /* ---- bulk ---- */
    bytes: function (n) {
      var v = this.u8.subarray(this.pos, this.pos + n);
      this.pos += n;
      return v;
    },
    /** Copy of n bytes (backed by a fresh buffer, safe to keep). */
    slice: function (p, n) { return this.u8.slice(p, p + n); },
    sub: function (p, n) { return new ByteReader(this.u8.subarray(p, p + n), this.base + p); },

    /** Fixed length ASCII, non printable bytes become '.'. Cursor advances. */
    str: function (n) {
      var s = '', end = Math.min(this.pos + n, this.length);
      for (var i = this.pos; i < end; i++) {
        var c = this.u8[i];
        s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      this.pos = end;
      return s;
    },
    /** Four character code at `p` (defaults to the cursor, cursor unchanged). */
    fourcc: function (p) {
      if (p == null) p = this.pos;
      var s = '';
      for (var i = 0; i < 4; i++) {
        var c = this.u8[p + i];
        s += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      return s;
    },
    /** UTF-8 string of `n` bytes (or until the reader ends / a NUL). Cursor advances. */
    utf8: function (n) {
      var end = n == null ? this.length : Math.min(this.pos + n, this.length);
      var stop = this.pos;
      if (n != null) { while (stop < end && this.u8[stop] !== 0) stop++; }
      var out = '';
      try { out = new TextDecoder('utf-8').decode(this.u8.subarray(this.pos, stop)); }
      catch (e) { out = ''; }
      this.pos = end;
      return out;
    },
    /** Latin-1 string of `n` bytes, NUL trimmed — byte preserving, binary safe. */
    latin1: function (n) {
      var s = '', end = Math.min(this.pos + n, this.length);
      for (var i = this.pos; i < end; i++) s += String.fromCharCode(this.u8[i]);
      this.pos = end;
      return s.replace(/\0+$/, '');
    },
    /** MPEG 5-bit packed ISO-639-2 language code. */
    lang: function () {
      var v = this.u16v();
      return String.fromCharCode(
        0x60 + ((v >> 10) & 0x1f),
        0x60 + ((v >> 5) & 0x1f),
        0x60 + (v & 0x1f));
    },
    /** 16.16 fixed point. */
    fixed16: function () { return this.u32v() / 65536; },
    fixed8:  function () { return this.u16v() / 256; },

    /** ISO BMFF / Matroska variable length integer (7 bits per byte, MSB = cont). */
    vint: function () {
      var v = 0, b, guard = 0;
      do {
        b = this.u8v();
        v = v * 128 + (b & 0x7f);
      } while ((b & 0x80) && ++guard < 8);
      return v;
    },

    /** Read a GUID / UUID in canonical 8-4-4-4-12 form, cursor unchanged. */
    guid: function (p) {
      if (p == null) p = this.pos;
      var b = this.u8, o = '';
      var seg = [
        [3, 2, 1, 0], [5, 4], [7, 6], [8, 9], [10, 11, 12, 13, 14, 15]
      ];
      var parts = seg.map(function (idx) {
        return idx.map(function (i) { return pad(b[p + i].toString(16), 2); }).join('');
      });
      return parts.join('-');
    }
  };

  /* ==========================================================================
   * BitReader — MSB first, optional emulation prevention byte removal
   *
   * `epb` mode implements the H.26x/AV1 rule: inside the payload a 0x03 byte
   * directly following two 0x00 bytes is a stuffing byte and is skipped.
   * ========================================================================*/

  function BitReader(bytes, offset, length, epb) {
    this.u8 = bytes;
    this.start = offset || 0;
    this.end = length != null ? this.start + length : bytes.length;
    this.epb = !!epb;
    this.reset();
  }

  BitReader.prototype = {
    reset: function () {
      this.p = this.start;
      this._bits = 0;    // buffered bits
      this._n = 0;       // valid bit count in _bits
      this._zeros = 0;   // consecutive zero bytes, for EPB detection
      this.overrun = false;
    },

    /** Current position as an absolute bit index from the start of the stream. */
    bitPos: function () { return (this.p - this.start) * 8 - this._n; },
    /** Bits still available (approximate when EPB is active). */
    bitsLeft: function () { return (this.end - this.p) * 8 + this._n; },
    bytePos: function () { return this.start + Math.floor(this.bitPos() / 8); },

    _nextByte: function () {
      if (this.p >= this.end) { this.overrun = true; return -1; }
      var b = this.u8[this.p++];
      if (this.epb && b === 0x03 && this._zeros >= 2) {
        // emulation_prevention_three_byte — drop it and read the real byte
        this._zeros = 0;
        if (this.p >= this.end) { this.overrun = true; return -1; }
        b = this.u8[this.p++];
      }
      this._zeros = b === 0 ? this._zeros + 1 : 0;
      return b;
    },

    /** Read n bits (MSB first). n must be <= 32. Overrun yields what was read. */
    u: function (n) {
      if (n <= 0) return 0;
      var v = 0, left = n;
      while (left > 0) {
        if (this._n === 0) {
          var b = this._nextByte();
          if (b < 0) return v;              // past the end: keep the bits we got
          this._bits = b; this._n = 8;
        }
        var take = left < this._n ? left : this._n;
        v = v * Math.pow(2, take) + (this._bits >>> (this._n - take));
        this._n -= take;
        this._bits &= (1 << this._n) - 1;
        left -= take;
      }
      return v;
    },

    /** Read n bits where n may exceed 32 (chunked, no BigInt needed). */
    uLong: function (n) {
      if (n <= 32) return BitReader.prototype.u.call(this, n);
      var hi = BitReader.prototype.u.call(this, n - 32);
      return hi * 0x100000000 + BitReader.prototype.u.call(this, 32);
    },

    // NOTE: the bit-level primitives below always call the base prototype
    // explicitly. SyntaxReader overrides `u`/`ue`/`se` to record rows, and a
    // plain `this.u(...)` inside the base class would dispatch into that
    // override — consuming zero bits and corrupting every Exp-Golomb read.
    bit: function () { return BitReader.prototype.u.call(this, 1); },

    /** Skip n bits without materialising the value. Mirrors u()'s refill rule. */
    skip: function (n) {
      var left = n;
      while (left > 0) {
        if (this._n === 0) {
          var b = this._nextByte();
          if (b < 0) { this.overrun = true; return; }
          this._bits = b; this._n = 8;
        }
        var take = left < this._n ? left : this._n;
        this._n -= take;
        this._bits &= (1 << this._n) - 1;
        left -= take;
      }
    },

    /** Unsigned Exp-Golomb ue(v). */
    ue: function () {
      var zeros = 0;
      while (BitReader.prototype.bit.call(this) === 0) {
        if (++zeros > 31) { this.overrun = true; return 0; }
      }
      if (zeros === 0) return 0;
      return Math.pow(2, zeros) - 1 + BitReader.prototype.u.call(this, zeros);
    },

    /** Signed Exp-Golomb se(v). */
    se: function () {
      var k = BitReader.prototype.ue.call(this);
      return (k & 1) ? (k + 1) / 2 : -(k / 2);
    },

    /** Discard buffered bits so the next read starts on a byte boundary.
     *  Returns the number of bits dropped. */
    align: function () {
      var dropped = this._n;
      this._n = 0; this._bits = 0;
      return dropped;
    },

    /** Consume rbsp_trailing_bits(): the stop bit plus alignment zeros. */
    trailing: function () {
      if (this._n === 0 && this.p < this.end) { this._bits = this._nextByte(); this._n = 8; }
      var stop = this._n ? (this._bits >>> (this._n - 1)) & 1 : 0;
      this.align();
      return stop;
    },

    /** Snapshot / restore, used for speculative parsing. */
    mark: function () {
      return { p: this.p, bits: this._bits, n: this._n, zeros: this._zeros };
    },
    restore: function (m) {
      this.p = m.p; this._bits = m.bits; this._n = m.n; this._zeros = m.zeros;
    }
  };

  // `ep` kept as an alias — some call sites read better with the short name.
  BitReader.prototype.readBits = BitReader.prototype.u;

  /* ==========================================================================
   * SyntaxReader — a BitReader that records each syntax element
   *
   * Every read produces one row:
   *   { name, syntax, bits, value, note, offset, depth }
   * which is exactly what the frame-syntax panel renders (field / syntax /
   * bits / value / meaning). `offset` is the absolute file offset of the byte
   * the element starts in, so the UI can jump from a syntax row to the hex
   * view — hence `base` (absolute offset of byte 0 of this RBSP).
   * ========================================================================*/

  function SyntaxReader(bytes, opt) {
    opt = opt || {};
    BitReader.call(this, bytes, opt.offset, opt.length, opt.epb !== false);
    this.base = opt.base || 0;    // absolute file offset of bytes[0]
    this.rows = [];
    this.depth = 0;
  }
  SyntaxReader.prototype = Object.create(BitReader.prototype);
  SyntaxReader.prototype.constructor = SyntaxReader;

  SyntaxReader.prototype._rec = function (name, syntax, bits, value, note) {
    var bitStart = this.bitPos() - bits;
    this.rows.push({
      name: name,
      syntax: syntax,
      bits: bits,
      value: value,
      note: note || '',
      offset: this.base + Math.floor(bitStart / 8),
      depth: this.depth
    });
    return value;
  };

  /** u(n) */
  SyntaxReader.prototype.u = function (name, n, note) {
    var v = BitReader.prototype.u.call(this, n);
    return this._rec(name, 'u(' + n + ')', n, v, note);
  };
  /** u(1) */
  SyntaxReader.prototype.flag = function (name, note) {
    var v = BitReader.prototype.u.call(this, 1);
    return this._rec(name, 'u(1)', 1, v, note);
  };
  /** ue(v) */
  SyntaxReader.prototype.ue = function (name, note) {
    var before = this.bitPos();
    var v = BitReader.prototype.ue.call(this);
    return this._rec(name, 'ue(v)', this.bitPos() - before, v, note);
  };
  /** se(v) */
  SyntaxReader.prototype.se = function (name, note) {
    var before = this.bitPos();
    var v = BitReader.prototype.se.call(this);
    return this._rec(name, 'se(v)', this.bitPos() - before, v, note);
  };
  /** Variable-length u(v) whose width is derived from earlier syntax. */
  SyntaxReader.prototype.uv = function (name, n, note) {
    var v = BitReader.prototype.u.call(this, n);
    return this._rec(name, 'u(v) v=' + n, n, v, note);
  };
  /** Raw n-byte field read through the bit stream. */
  SyntaxReader.prototype.raw = function (name, nBytes, note) {
    var bits = nBytes * 8;
    var v = BitReader.prototype.uLong.call(this, bits);
    return this._rec(name, 'u(' + bits + ')', bits, v, note);
  };
  /** Little-endian fixed width field (RIFF / GIF / WebP style). */
  SyntaxReader.prototype.ule = function (name, nBytes, note) {
    var v = 0;
    for (var i = 0; i < nBytes; i++) v += BitReader.prototype.u.call(this, 8) * Math.pow(2, 8 * i);
    return this._rec(name, 'u(' + (nBytes * 8) + ') le', nBytes * 8, v, note);
  };
  /** Arbitrary byte sequence (magic, UUID, …). */
  SyntaxReader.prototype.bytes = function (name, n, note) {
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) out[i] = BitReader.prototype.u.call(this, 8);
    return this._rec(name, 'bytes(' + n + ')', n * 8, bytesToHexShort(out), note);
  };
  /** Consume and record rbsp_trailing_bits() / byte_alignment(). */
  SyntaxReader.prototype.trailing = function (name) {
    var before = this.bitPos();
    var stop = BitReader.prototype.trailing.call(this);
    return this._rec(name || 'rbsp_trailing_bits()', 'ae(v)', this.bitPos() - before, stop, '');
  };

  /** A structural header row such as `if (frame_mbs_only_flag) {`. */
  SyntaxReader.prototype.group = function (name, note) {
    this.rows.push({
      name: name, syntax: '', bits: '', value: '', note: note || '',
      offset: this.base + Math.floor(this.bitPos() / 8), depth: this.depth, group: true
    });
  };

  /**
   * Start a conditional block following the spec pseudocode: emits a
   * `if ( condition ) {` group row at the current depth and pushes one
   * indentation level. Pair with `endBlock()` to close it.
   */
  SyntaxReader.prototype.cond = function (condition) {
    this.rows.push({
      name: 'if ( ' + condition + ' ) {', syntax: '', bits: '', value: '', note: '',
      offset: this.base + Math.floor(this.bitPos() / 8), depth: this.depth, group: true, cond: true
    });
    this.depth++;
  };

  /**
   * Close a block opened by `cond()` (or `group()` + manual depth++).
   * Named `endBlock` rather than `end` because BitReader instances carry an
   * `end` property (buffer end offset) which would shadow a prototype `end`.
   */
  SyntaxReader.prototype.endBlock = function () {
    if (this.depth > 0) this.depth--;
    this.rows.push({
      name: '}', syntax: '', bits: '', value: '', note: '',
      offset: this.base + Math.floor(this.bitPos() / 8), depth: this.depth, group: true, closing: true
    });
  };

  /** Overwrite the note of the most recent row (value known only after the read). */
  SyntaxReader.prototype.note = function (text) {
    if (this.rows.length) this.rows[this.rows.length - 1].note = text;
    return text;
  };
  /** Overwrite the value of the most recent row after post-processing. */
  SyntaxReader.prototype.value = function (v) {
    if (this.rows.length) this.rows[this.rows.length - 1].value = v;
    return v;
  };

  function bytesToHexShort(b) {
    var s = '';
    for (var i = 0; i < b.length && i < 16; i++) s += pad(b[i].toString(16), 2).toUpperCase();
    if (b.length > 16) s += '…';
    return s;
  }
  MA.bytesToHexShort = bytesToHexShort;

  /* ==========================================================================
   * BitReaderLSB — least-significant-bit-first reader
   *
   * VP8, VP9, AV1 and AV2 all pack their headers LSB-first, the opposite of
   * the H.26x family, so they need their own reader rather than a mode flag on
   * BitReader (which would make every H.26x call site pay for the branch).
   *
   * VP9/AV1 'f(n)' literal reads and VP8's little-endian 16/24/32-bit reads
   * are all expressed in terms of u(n).
   * ========================================================================*/

  function BitReaderLSB(bytes, offset, length) {
    this.u8 = bytes;
    this.start = offset || 0;
    this.end = length != null ? this.start + length : bytes.length;
    this.reset();
  }

  BitReaderLSB.prototype = {
    reset: function () { this.p = this.start; this._bits = 0; this._n = 0; this.overrun = false; },

    /** Bit position counted from the start of the stream. */
    bitPos: function () { return (this.p - this.start) * 8 - this._n; },
    bitsLeft: function () { return (this.end - this.p) * 8 + this._n; },
    bytePos: function () { return this.start + Math.floor(this.bitPos() / 8); },

    /** Read n bits, least significant bit first. */
    u: function (n) {
      if (n <= 0) return 0;
      while (this._n < n) {
        if (this.p >= this.end) { this.overrun = true; break; }
        this._bits |= this.u8[this.p++] << this._n;
        this._n += 8;
      }
      var take = Math.min(n, this._n);
      var v = take >= 32 ? (this._bits >>> 0) : ((this._bits & ((1 << take) - 1)) >>> 0);
      this._bits = take >= 32 ? 0 : (this._bits >>> take);
      this._n -= take;
      return v;
    },

    /** f(n) — a literal bit field (VP9/AV1 notation). */
    f: function (n) { return this.u(n); },

    flag: function () { return this.u(1); },

    skip: function (n) {
      var left = n;
      while (left > 0) {
        if (this._n === 0) {
          if (this.p >= this.end) { this.overrun = true; return; }
          this._bits = this.u8[this.p++]; this._n = 8;
        }
        var take = Math.min(left, this._n);
        this._bits >>>= take; this._n -= take; left -= take;
      }
    },

    /** Little-endian fixed-width read, expressed through the bit reader. */
    le: function (nBytes) {
      var v = 0;
      for (var i = 0; i < nBytes; i++) v += this.u(8) * Math.pow(2, 8 * i);
      return v;
    },

    align: function () { var d = this._n; this._n = 0; this._bits = 0; return d; },

    mark: function () { return { p: this.p, bits: this._bits, n: this._n }; },
    restore: function (m) { this.p = m.p; this._bits = m.bits; this._n = m.n; }
  };

  /**
   * LSB-first reader that records every read as a syntax row, mirroring the
   * MSB-first SyntaxReader so both feed the same UI table.
   */
  function SyntaxReaderLSB(bytes, opt) {
    opt = opt || {};
    BitReaderLSB.call(this, bytes, opt.offset, opt.length);
    this.base = opt.base || 0;
    this.rows = [];
    this.depth = 0;
  }
  SyntaxReaderLSB.prototype = Object.create(BitReaderLSB.prototype);
  SyntaxReaderLSB.prototype.constructor = SyntaxReaderLSB;

  SyntaxReaderLSB.prototype._rec = function (name, syntax, bits, value, note) {
    var bitStart = this.bitPos() - bits;
    this.rows.push({
      name: name, syntax: syntax, bits: bits, value: value, note: note || '',
      offset: this.base + Math.floor(bitStart / 8), depth: this.depth
    });
    return value;
  };

  /** f(n) — a literal field. */
  SyntaxReaderLSB.prototype.f = function (name, n, note) {
    var v = BitReaderLSB.prototype.u.call(this, n);
    return this._rec(name, 'f(' + n + ')', n, v, note);
  };
  /** u(n) — an unsigned value (VP8 notation). */
  SyntaxReaderLSB.prototype.un = function (name, n, note) {
    var v = BitReaderLSB.prototype.u.call(this, n);
    return this._rec(name, 'u(' + n + ')', n, v, note);
  };
  SyntaxReaderLSB.prototype.lsbFlag = function (name, note) {
    var v = BitReaderLSB.prototype.u.call(this, 1);
    return this._rec(name, 'f(1)', 1, v, note);
  };
  /** L(n) / le(n) — little-endian multi-byte literal. */
  SyntaxReaderLSB.prototype.le = function (name, nBytes, note) {
    var v = BitReaderLSB.prototype.le.call(this, nBytes);
    return this._rec(name, 'L(' + nBytes + ')', nBytes * 8, v, note);
  };
  /** L(n) in VP9/AV1 notation is the same little-endian literal. */
  SyntaxReaderLSB.prototype.L = SyntaxReaderLSB.prototype.le;

  SyntaxReaderLSB.prototype.group = function (name, note) {
    this.rows.push({
      name: name, syntax: '', bits: '', value: '', note: note || '',
      offset: this.base + Math.floor(this.bitPos() / 8), depth: this.depth, group: true
    });
  };
  SyntaxReaderLSB.prototype.cond = function (condition) {
    this.rows.push({
      name: 'if ( ' + condition + ' ) {', syntax: '', bits: '', value: '', note: '',
      offset: this.base + Math.floor(this.bitPos() / 8), depth: this.depth, group: true, cond: true
    });
    this.depth++;
  };
  SyntaxReaderLSB.prototype.endBlock = function () {
    if (this.depth > 0) this.depth--;
    this.rows.push({
      name: '}', syntax: '', bits: '', value: '', note: '',
      offset: this.base + Math.floor(this.bitPos() / 8), depth: this.depth, group: true, closing: true
    });
  };
  SyntaxReaderLSB.prototype.note = function (text) {
    if (this.rows.length) this.rows[this.rows.length - 1].note = text;
    return text;
  };
  SyntaxReaderLSB.prototype.value = function (v) {
    if (this.rows.length) this.rows[this.rows.length - 1].value = v;
    return v;
  };

  /** A section of a syntax panel: heading + spec-style rows. */
  function syntaxTable(title, sub, rows) {
    return { title: title || '', sub: sub || '', rows: rows || [] };
  }
  function synSection(title, sub, rows) { return syntaxTable(title, sub, rows); }

  /* ==========================================================================
   * RBSP / NAL helpers
   * ========================================================================*/

  /** Remove emulation_prevention_three_byte (00 00 03 -> 00 00). */
  function unescapeRbsp(data, start, end) {
    start = start || 0;
    end = end == null ? data.length : end;
    // Fast path: nothing to strip.
    var has = false;
    for (var k = start; k + 2 < end; k++) {
      if (data[k] === 0 && data[k + 1] === 0 && data[k + 2] === 3) { has = true; break; }
    }
    if (!has) return data.subarray(start, end);
    var out = new Uint8Array(end - start);
    var n = 0;
    for (var i = start; i < end; i++) {
      if (i + 2 < end && data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 3) {
        out[n++] = 0; out[n++] = 0; i += 2;
      } else out[n++] = data[i];
    }
    return out.subarray(0, n);
  }

  /**
   * Locate Annex-B NAL units. Returns [{ sc, scLen, start, end, len }] where
   * `start` is the first header byte and `sc` the first start-code byte.
   * All offsets are relative to `data`.
   */
  function annexBUnits(data, limit) {
    var max = limit != null ? Math.min(limit, data.length) : data.length;
    var marks = [];
    for (var i = 0; i + 2 < max; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue;
      if (data[i + 2] === 1) { marks.push({ sc: i, scLen: 3, start: i + 3 }); i += 2; }
      else if (data[i + 2] === 0 && i + 3 < max && data[i + 3] === 1) {
        marks.push({ sc: i, scLen: 4, start: i + 4 }); i += 3;
      }
    }
    for (var k = 0; k < marks.length; k++) {
      marks[k].end = k + 1 < marks.length ? marks[k + 1].sc : max;
      marks[k].len = marks[k].end - marks[k].sc;
    }
    return marks;
  }

  function walkAnnexB(data, cb, limit) {
    var units = annexBUnits(data, limit);
    for (var i = 0; i < units.length; i++) cb(units[i].start, units[i].end, units[i].scLen, units[i]);
  }

  /**
   * Split a length-prefixed sample (MP4/MKV style) into NAL units.
   * `headerLen` is 1 for AVC, 2 for HEVC/VVC.
   * Returns [{ offset, size, payloadOff, payloadLen, header, type, ... }].
   */
  function splitLengthPrefixedNals(data, lengthSize, headerLen, start, end) {
    start = start || 0;
    end = end == null ? data.length : end;
    headerLen = headerLen == null ? 1 : headerLen;
    var ls = clamp(lengthSize | 0, 1, 4);
    var nals = [], p = start;
    var guard = 0;
    while (p + ls <= end && guard++ < 100000) {
      var len = 0;
      for (var i = 0; i < ls; i++) len = len * 256 + data[p + i];
      var payloadOff = p + ls;
      if (len <= 0 || payloadOff + len > end) {
        // A truncated tail is common in damaged files — report it once.
        if (payloadOff < end) {
          nals.push({
            offset: p, size: end - p, payloadOff: payloadOff, payloadLen: end - payloadOff,
            header: data[payloadOff] || 0, type: -1, truncated: true
          });
        }
        break;
      }
      var first = data[payloadOff];
      var type, refIdc = 0;
      if (headerLen === 1) {                 // AVC: forbidden(1) ref_idc(2) type(5)
        type = first & 0x1f;
        refIdc = (first >> 5) & 3;
      } else {                               // HEVC/VVC: forbidden(1) type(6) layer(6) tid(3)
        type = (first >> 1) & 0x3f;
      }
      nals.push({
        offset: p, size: len + ls, payloadOff: payloadOff, payloadLen: len,
        header: first, type: type, refIdc: refIdc
      });
      p = payloadOff + len;
    }
    return nals;
  }

  /** Walk a length-prefixed NAL stream, invoking `cb(payloadOff, payloadEnd)`. */
  function walkLengthPrefixed(data, start, end, lengthSize, cb) {
    var nals = splitLengthPrefixedNals(data, lengthSize, 1, start, end);
    for (var i = 0; i < nals.length; i++) {
      if (nals[i].type < 0) continue;
      cb(nals[i].payloadOff, nals[i].payloadOff + nals[i].payloadLen, nals[i]);
    }
  }

  /** First start-code position per NAL (used to keep exact file offsets). */
  function findNalStarts(data, limit) {
    return annexBUnits(data, limit).map(function (u) { return u.start; });
  }

  /* ==========================================================================
   * Structure tree
   * ========================================================================*/

  /**
   * One node of the container structure tree (MP4 box, TS packet, PNG chunk …).
   *  type     'box' | 'tag' | 'chunk' | 'packet' | 'element' | 'entry' | 'frame'
   *  code     short identifier shown in the tree (e.g. 'ftyp')
   *  name     spec name (e.g. 'File Type Box')
   *  offset   absolute file offset
   *  size     byte length
   *  fields   [{ name, value, offset, size }] — offset links to the hex view
   *  children nested nodes
   */
  function makeNode(type, code, name, offset, size) {
    return {
      type: type || 'node',
      code: code || '',
      name: name || '',
      offset: offset == null ? 0 : offset,
      size: size == null ? 0 : size,
      fields: [],
      children: [],
      expanded: false
    };
  }

  function nodeField(node, name, value, offset, size) {
    node.fields.push({
      name: name,
      value: value,
      offset: offset == null ? node.offset : offset,
      size: size || 0
    });
  }

  /** Append a textual note row to a node (rendered without a byte link). */
  /**
   * Append a textual note to a node. `offset: null` marks the row as having no
   * byte location, so the UI never renders it as a jump link and the model
   * keeps the invariant that every non-null field offset is inside the file.
   */
  function nodeNote(node, text) {
    node.fields.push({ name: '', value: text, offset: null, size: 0, note: true });
  }

  /* ==========================================================================
   * Byte sources
   *
   * The whole point is that a 2 GB file must not stay resident. Two layers:
   *   - an optional in-memory buffer used during parsing (fast, sync access)
   *   - a backing File/Blob or HTTP URL used afterwards for lazy range reads
   * `release()` drops the memory buffer; from then on `range()` streams from
   * disk/network, which is what makes the hex view cheap on big files.
   * ========================================================================*/

  function makeByteSource(data, blob) {
    var mem = data instanceof Uint8Array ? data : (data ? new Uint8Array(data) : null);
    var file = blob || null;

    return {
      get length() { return mem ? mem.length : (file ? file.size : 0); },
      get name() { return file && file.name ? file.name : ''; },

      /** True while the whole file is still in memory (sync reads possible). */
      hasMemory: function () { return !!mem; },

      /** Synchronous read — only valid before release(). */
      rangeSync: function (start, len) {
        if (!mem) throw new Error('ByteSource: in-memory buffer already released');
        var end = Math.min(mem.length, start + len);
        if (start >= end) return new Uint8Array(0);
        return mem.subarray(start, end);
      },

      /** Promise<Uint8Array>; falls back to the Blob once memory is released. */
      range: function (start, len) {
        if (mem) {
          var end = Math.min(mem.length, start + len);
          return Promise.resolve(start >= end ? new Uint8Array(0) : mem.subarray(start, end));
        }
        if (file) {
          if (start >= file.size) return Promise.resolve(new Uint8Array(0));
          var stop = Math.min(file.size, start + len);
          return file.slice(start, stop).arrayBuffer().then(function (b) {
            return new Uint8Array(b);
          });
        }
        return Promise.reject(new Error('ByteSource: no data source available'));
      },

      /** Drop the in-memory copy — all later reads go back to the source. */
      release: function () { mem = null; },

      /** A Blob covering the whole source (used for <img>/<audio>/<video> previews). */
      asBlob: function (type) {
        if (file) return file;
        if (mem) return new Blob([mem], type ? { type: type } : undefined);
        return null;
      }
    };
  }

  /**
   * HTTP(S) source using Range requests. Small remote files are fetched in one
   * go; larger ones are read per range so the browser tab stays lean.
   */
  function makeHttpSource(url) {
    var src = {
      url: url,
      size: -1,
      acceptRanges: false,
      _buf: null,
      name: ''
    };
    try {
      var u = new URL(url, root.location && root.location.href);
      src.name = decodeURIComponent((u.pathname.split('/').pop() || '') || url);
    } catch (e) { src.name = url; }

    src.init = function () {
      return fetch(url, { headers: { Range: 'bytes=0-0' } }).then(function (res) {
        if (!res.ok && res.status !== 206) throw new Error('HTTP ' + res.status);
        var cr = res.headers.get('Content-Range');           // "bytes 0-0/12345"
        src.acceptRanges = res.status === 206 && !!cr;
        if (cr) {
          var m = /\/(\d+)\s*$/.exec(cr);
          if (m) src.size = parseInt(m[1], 10);
        }
        if (src.size < 0) {
          var cl = res.headers.get('Content-Length');
          if (cl) src.size = parseInt(cl, 10);
        }
        // Whole-content mode for anything small enough to hold comfortably.
        if (src.acceptRanges && src.size >= 0 && src.size <= 64 * 1024 * 1024) {
          return fetch(url, { headers: { Range: 'bytes=0-' + (src.size - 1) } })
            .then(function (r) { return r.arrayBuffer(); })
            .then(function (b) { src._buf = new Uint8Array(b); src.size = src._buf.length; });
        }
        if (src.size < 0 || !src.acceptRanges) {
          return fetch(url).then(function (r) { return r.arrayBuffer(); })
            .then(function (b) { src._buf = new Uint8Array(b); src.size = src._buf.length; });
        }
      });
    };

    src.range = function (start, len) {
      if (src._buf) {
        var end = Math.min(src._buf.length, start + len);
        return Promise.resolve(start >= end ? new Uint8Array(0) : src._buf.subarray(start, end));
      }
      var stop = src.size >= 0 ? Math.min(src.size, start + len) : start + len;
      if (start >= stop) return Promise.resolve(new Uint8Array(0));
      return fetch(url, { headers: { Range: 'bytes=' + start + '-' + (stop - 1) } })
        .then(function (r) {
          if (!r.ok && r.status !== 206) throw new Error('HTTP ' + r.status);
          return r.arrayBuffer();
        })
        .then(function (b) { return new Uint8Array(b); });
    };

    src.asBlob = function () { return null; };
    src.hasMemory = function () { return !!src._buf; };
    src.release = function () { src._buf = null; };
    return src;
  }

  /* ==========================================================================
   * Misc
   * ========================================================================*/

  function concatBytes(list) {
    var total = 0, i;
    for (i = 0; i < list.length; i++) total += list[i].length;
    var out = new Uint8Array(total), o = 0;
    for (i = 0; i < list.length; i++) { out.set(list[i], o); o += list[i].length; }
    return out;
  }

  /** Case-insensitive extension of a file name ('' when there is none). */
  function fileExt(name) {
    if (!name) return '';
    var m = /\.([A-Za-z0-9]{1,8})$/.exec(name);
    return m ? m[1].toLowerCase() : '';
  }

  /* ---- CRC-32 (ISO 3309, as used by PNG/ZIP) ---- */
  var CRC_TABLE = (function () {
    var t = new Uint32Array(256);
    for (var n = 0; n < 256; n++) {
      var c = n;
      for (var k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  /** CRC-32 over one byte array or a list of them. */
  function crc32(parts) {
    var list = Array.isArray(parts) ? parts : [parts];
    var c = 0xFFFFFFFF;
    for (var i = 0; i < list.length; i++) {
      var b = list[i];
      for (var j = 0; j < b.length; j++) c = CRC_TABLE[(c ^ b[j]) & 0xFF] ^ (c >>> 8);
    }
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  /**
   * Guard for counts read out of the file: every entry occupies at least
   * `minBytes`, so a count that cannot fit inside the container is corrupt.
   * Without this, one damaged `stz2`/`stco` count spins the tab forever.
   */
  function safeCount(n, availableBytes, minBytes) {
    if (minBytes <= 0) minBytes = 1;
    var max = Math.max(0, Math.floor(availableBytes / minBytes));
    return n > max ? max : n;
  }

  /** Run `fn` in chunks without blocking the UI thread for too long. */
  function forEachChunk(total, chunkSize, body) {
    return new Promise(function (resolve, reject) {
      var i = 0;
      function step() {
        var end = Math.min(total, i + chunkSize);
        try {
          for (; i < end; i++) body(i);
        } catch (e) { return reject(e); }
        if (i < total) setTimeout(step, 0); else resolve();
      }
      step();
    });
  }

  MA.pad = pad;
  MA.hex = hex;
  MA.formatSize = formatSize;
  MA.formatDuration = formatDuration;
  MA.formatMs = formatMs;
  MA.formatBitrate = formatBitrate;
  MA.formatHz = formatHz;
  MA.formatNum = formatNum;
  MA.formatFps = formatFps;
  MA.formatChannels = formatChannels;
  MA.escapeHtml = escapeHtml;
  MA.clamp = clamp;
  MA.bitsToBytes = bitsToBytes;

  MA.ByteReader = ByteReader;
  MA.BitReader = BitReader;
  MA.SyntaxReader = SyntaxReader;
  MA.BitReaderLSB = BitReaderLSB;
  MA.SyntaxReaderLSB = SyntaxReaderLSB;

  MA.syntaxTable = syntaxTable;
  MA.synSection = synSection;

  MA.unescapeRbsp = unescapeRbsp;
  MA.annexBUnits = annexBUnits;
  MA.walkAnnexB = walkAnnexB;
  MA.splitLengthPrefixedNals = splitLengthPrefixedNals;
  MA.walkLengthPrefixed = walkLengthPrefixed;
  MA.findNalStarts = findNalStarts;

  MA.makeNode = makeNode;
  MA.nodeField = nodeField;
  MA.nodeNote = nodeNote;

  MA.makeByteSource = makeByteSource;
  MA.makeHttpSource = makeHttpSource;

  MA.concatBytes = concatBytes;
  MA.fileExt = fileExt;
  MA.crc32 = crc32;
  MA.safeCount = safeCount;
  MA.forEachChunk = forEachChunk;

  /* ==========================================================================
   * Registries
   *
   * Codec modules call registerCodec(id, impl); container parsers call
   * registerParser(defn). `app.js` resolves frames to their syntax builder
   * through these, which keeps every lazy code path in one place — a frame
   * therefore only has to carry a small recipe, never a closure that could
   * pin the sample buffer (that mistake used to cost ~170 MB on large TS
   * files).
   * ========================================================================*/

  MA.codecs = MA.codecs || {};
  MA.registerCodec = function (id, impl) {
    MA.codecs[id] = impl;
    return impl;
  };
  MA.getCodec = function (id) { return MA.codecs[id] || null; };

  MA.parsers = MA.parsers || {};
  MA.parserList = MA.parserList || [];
  MA.registerParser = function (defn) {
    MA.parsers[defn.id] = defn;
    MA.parserList.push(defn);
    return defn;
  };
  MA.getParser = function (id) { return MA.parsers[id] || null; };

  /* ==========================================================================
   * IVF container
   *
   * The reference container for VP8/VP9/AV1/AV2 elementary streams:
   *   "DKIF", version(2), header size(2), fourcc(4), width(2), height(2),
   *   timebase denominator(4), timebase numerator(4), frame count(4),
   *   unused(4), then per frame: size(4 LE) + timestamp(8 LE) + payload.
   *
   * Shared by every codec that can live in an IVF file, so the layout is
   * implemented once.
   * ========================================================================*/

  var IVF_FOURCC_NAMES = { VP80: 'VP8', VP90: 'VP9', AV01: 'AV1', AV02: 'AV2' };

  /** @returns {null|{frames, info, headerOffset}} — null when not an IVF file. */
  MA.readIvf = function (data, expectedFourcc) {
    if (data.length < 32) return null;
    if (!(data[0] === 0x44 && data[1] === 0x4b && data[2] === 0x49 && data[3] === 0x46)) return null;
    var br = new ByteReader(data);
    var version = br.u16at(4);
    var headerSize = br.u16at(6);
    var fourcc = br.fourcc(8);
    if (expectedFourcc && fourcc !== expectedFourcc) return null;

    var width = br.u16at(12);
    var height = br.u16at(14);
    var timebaseDen = br.u32at(16) || 1;
    var timebaseNum = br.u32at(20) || 1;
    var declared = br.u32at(24);

    var frames = [];
    var p = headerSize >= 32 ? headerSize : 32;
    var guard = 0;
    while (p + 12 <= data.length && guard++ < 200000) {
      var size = br.u32at(p);
      var ts = br.u32at(p + 4) + br.u32at(p + 8) * 0x100000000;
      p += 12;
      if (size <= 0 || p + size > data.length) break;
      frames.push({
        index: frames.length,
        type: 'video',
        keyframe: false,
        codec: IVF_FOURCC_NAMES[fourcc] || fourcc,
        offset: p,
        size: size,
        timestamp: ts * timebaseNum / timebaseDen
      });
      p += size;
    }

    return {
      frames: frames,
      headerOffset: 0,
      info: {
        fourcc: fourcc,
        codecName: IVF_FOURCC_NAMES[fourcc] || fourcc,
        version: version,
        headerSize: headerSize,
        width: width,
        height: height,
        timebase: { numerator: timebaseNum, denominator: timebaseDen },
        frameCount: declared || frames.length,
        fps: timebaseDen > 0 ? timebaseDen / timebaseNum : null
      }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
