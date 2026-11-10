/* ============================================================================
 * MediaAnalyzer — parsers/mp4.js
 *
 * ISO Base Media File Format (ISO/IEC 14496-12) — MP4, MOV, M4A, 3GP, and the
 * HEIF/AVIF still-image brands.
 *
 * Covers both layouts:
 *   - progressive  : moov/trak/mdia/minf/stbl sample tables
 *   - fragmented   : moov/mvex + a chain of moof/traf/trun runs (DASH, CMAF,
 *                    HLS-fMP4, and anything written by a modern packager)
 *
 * A previous implementation only named the fragment boxes and therefore
 * reported zero frames for every fMP4 file; the fragment path here builds
 * real samples from tfhd/tfdt/trun plus the trex defaults.
 *
 * Field offsets recorded on structure nodes are ABSOLUTE file offsets, because
 * the UI turns every field with a non-zero size into a jump-to-hex link.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var MAX_FIELD_ROWS = 32;       // repeated rows shown per table in the tree
  var MAX_FRAMES = 60000;        // expanded sample cap
  var MAX_BOX_DEPTH = 32;
  var MAX_BOXES = 200000;

  /* ------------------------------------------------------------------ names */

  var BOX_NAMES = {
    ftyp: 'File Type Box', styp: 'Segment Type Box', moov: 'Movie Box',
    mdat: 'Media Data Box', free: 'Free Space Box', skip: 'Skip Box',
    wide: 'Wide Box', pnot: 'Preview Container', junk: 'Junk Box',
    mvhd: 'Movie Header Box', trak: 'Track Box', tkhd: 'Track Header Box',
    edts: 'Edit Box', elst: 'Edit List Box', mdia: 'Media Box',
    mdhd: 'Media Header Box', hdlr: 'Handler Reference Box',
    minf: 'Media Information Box', dinf: 'Data Information Box',
    dref: 'Data Reference Box', url: 'Data Entry URL Box', urn: 'Data Entry URN Box',
    stbl: 'Sample Table Box', stsd: 'Sample Description Box',
    stts: 'Decoding Time to Sample Box', ctts: 'Composition Time to Sample Box',
    stsc: 'Sample To Chunk Box', stsz: 'Sample Size Box', stz2: 'Compact Sample Size Box',
    stco: 'Chunk Offset Box', co64: 'Chunk Large Offset Box',
    stss: 'Sync Sample Box', stsh: 'Shadow Sync Sample Box',
    sdtp: 'Independent and Disposable Samples Box', sgpd: 'Sample Group Description Box',
    sbgp: 'Sample to Group Box', subs: 'Sub-Sample Information Box',
    padb: 'Padding Bits Box', stdp: 'Degradation Priority Box',
    avcC: 'AVC Decoder Configuration Record', hvcC: 'HEVC Decoder Configuration Record',
    vvcC: 'VVC Decoder Configuration Record', av1C: 'AV1 Codec Configuration Box',
    vpcC: 'VP Codec Configuration Box', dvcC: 'Dolby Vision Configuration Box',
    esds: 'Elementary Stream Descriptor Box', btrt: 'Bit Rate Box',
    pasp: 'Pixel Aspect Ratio Box', clap: 'Clean Aperture Box',
    colr: 'Colour Information Box', mdcv: 'Mastering Display Colour Volume Box',
    clli: 'Content Light Level Box', smdm: 'SMPTE 2086 Mastering Display Box',
    udta: 'User Data Box', meta: 'Metadata Box', ilst: 'Metadata Item List',
    vmhd: 'Video Media Header Box', smhd: 'Sound Media Header Box',
    hmhd: 'Hint Media Header Box', nmhd: 'Null Media Header Box',
    auth: 'Author Box', gnre: 'Genre Box', dscp: 'Description Box',
    perf: 'Performer Box', albm: 'Album Box',
    keys: 'Metadata Item Keys Box', data: 'Metadata Item Data Box',
    hdlr2: 'Handler Box', moof: 'Movie Fragment Box', mfhd: 'Movie Fragment Header Box',
    traf: 'Track Fragment Box', tfhd: 'Track Fragment Header Box',
    tfdt: 'Track Fragment Decode Time Box', trun: 'Track Fragment Run Box',
    mvex: 'Movie Extends Box', mehd: 'Movie Extends Header Box',
    trex: 'Track Extends Box', sidx: 'Segment Index Box', ssix: 'Sub-Segment Index Box',
    saiz: 'Sample Auxiliary Information Sizes', saio: 'Sample Auxiliary Information Offsets',
    sinf: 'Protection Scheme Information Box', schm: 'Scheme Type Box',
    schi: 'Scheme Information Box', frma: 'Original Format Box',
    enca: 'Encrypted Audio Sample Entry', encv: 'Encrypted Visual Sample Entry',
    pssh: 'Protection System Specific Header', cprt: 'Copyright Box',
    mfra: 'Movie Fragment Random Access Box', tfra: 'Track Fragment Random Access Box',
    mfro: 'Movie Fragment Random Access Offset Box', tref: 'Track Reference Box',
    // HEIF / AVIF item-based layout
    pitm: 'Primary Item Box', iloc: 'Item Location Box', iinf: 'Item Information Box',
    infe: 'Item Information Entry', iprp: 'Item Properties Box',
    ipco: 'Item Property Container', ipma: 'Item Property Association',
    ispe: 'Image Spatial Extents', irot: 'Image Rotation', pixi: 'Pixel Information',
    iref: 'Item Reference Box', idat: 'Item Data Box', grpl: 'Group List Box',
    thmb: 'Thumbnail Reference', thum: 'Thumbnail Reference (deprecated)',
    cdsc: 'Describes Reference', auxl: 'Auxiliary Image Reference',
    dimg: 'Derived Image Reference', base: 'Base Image Reference',
    // QuickTime
    cmov: 'Compressed Movie Box', 'clip': 'Clipping Region Box', matt: 'Matte Box',
    'rmra': 'Reference Movie Array', 'rmda': 'Reference Movie Descriptor'
  };

  /** Boxes whose payload is a list of child boxes. */
  var CONTAINERS = {
    moov: 1, trak: 1, edts: 1, mdia: 1, minf: 1, dinf: 1, stbl: 1, udta: 1,
    moof: 1, traf: 1, mvex: 1, mfra: 1, sinf: 1, schi: 1, iprp: 1, ipco: 1,
    iref: 1, grpl: 1, rmra: 1, rmda: 1, ilst: 1, 'strk': 1, 'stri': 1
  };

  /** FullBoxes whose payload is a list of child boxes (a 4-byte header first). */
  var FULLBOX_CONTAINERS = { meta: 1, ipro: 1, iref: 1 };

  var VISUAL_ENTRIES = {
    avc1: 1, avc2: 1, avc3: 1, avc4: 1, hvc1: 1, hev1: 1, hvc2: 1, hev2: 1,
    vvc1: 1, vvi1: 1, av01: 1, av1x: 1, vp08: 1, vp09: 1, mp4v: 1, s263: 1,
    encv: 1, mjpg: 1, jpeg: 1, png: 1, 'dvav': 1, 'dva1': 1, 'dvhe': 1, 'dvh1': 1
  };
  var AUDIO_ENTRIES = {
    mp4a: 1, 'ac-3': 1, 'ec-3': 1, 'ac-4': 1, Opus: 1, fLaC: 1, alac: 1,
    'dtsc': 1, 'dtsh': 1, 'dtsl': 1, 'dtse': 1, enca: 1,
    samr: 1, sawb: 1, sevc: 1, sqcp: 1, 'twos': 1, 'sowt': 1, 'lpcm': 1
  };
  var SUBTITLE_ENTRIES = { text: 1, tx3g: 1, wvtt: 1, stpp: 1, 'c608': 1, 'c708': 1 };
  var IMAGE_ENTRIES = { avif: 1, heic: 1, heix: 1, mif1: 1, msf1: 1, grid: 1, iovl: 1 };

  /**
   * HEIF item types that carry (or derive) a decodable picture. Coded items
   * reuse the sample-entry fourccs ('hvc1', 'av01', 'jpeg', …), derived items
   * have their own types ('grid', 'iovl').
   */
  var IMAGE_ITEM_TYPES = {
    heic: 1, heix: 1, mif1: 1, msf1: 1, avif: 1, avis: 1,
    hvc1: 1, hev1: 1, avc1: 1, av01: 1, jpeg: 1, png: 1, grid: 1, iovl: 1
  };
  var ITEM_ROLE_NAME = {
    thmb: 'thumbnail', thum: 'thumbnail', auxl: 'auxiliary',
    dimg: 'derived', cdsc: 'described', base: 'base'
  };

  /** ftyp brands that identify a HEIF/HEIC still image. */
  var HEIF_BRANDS = { heic: 1, heix: 1, hevc: 1, hevx: 1, mif1: 1, msf1: 1, avif: 1, avis: 1 };

  /** colr 'nclx' index → display names (MediaInfo-style). */
  var COLOUR_PRIMARIES = {
    1: 'BT.709', 4: 'BT.470 System M', 5: 'BT.601 PAL', 6: 'BT.601 NTSC',
    7: 'SMPTE 240M', 9: 'BT.2020', 11: 'DCI-P3', 12: 'Display P3'
  };
  var COLOUR_TRANSFER = {
    1: 'BT.709', 4: 'Gamma 2.2', 5: 'Gamma 2.8', 6: 'BT.601', 7: 'SMPTE 240M',
    8: 'Linear', 13: 'sRGB', 16: 'PQ (HDR)', 18: 'HLG (HDR)'
  };
  var COLOUR_MATRIX = {
    0: 'Identity (RGB)', 1: 'BT.709', 5: 'BT.601 PAL', 6: 'BT.601 NTSC',
    9: 'BT.2020', 11: 'DCI-P3', 12: 'Display P3'
  };

  var CODEC_NAME = {
    avc1: 'H.264 / AVC', avc2: 'H.264 / AVC', avc3: 'H.264 / AVC (in-band SPS/PPS)',
    avc4: 'H.264 / AVC (in-band SPS/PPS)', hvc1: 'H.265 / HEVC', hev1: 'H.265 / HEVC (in-band parameter sets)',
    hvc2: 'H.265 / HEVC (layered)', hev2: 'H.265 / HEVC (layered)',
    vvc1: 'H.266 / VVC', vvi1: 'H.266 / VVC (in-band parameter sets)',
    av01: 'AV1', av1x: 'AV1', vp08: 'VP8', vp09: 'VP9', mp4v: 'MPEG-4 Visual',
    s263: 'H.263', mp4a: 'AAC (MPEG-4 Audio)', 'ac-3': 'AC-3 (Dolby Digital)',
    'ec-3': 'E-AC-3 (Dolby Digital Plus)', 'ac-4': 'AC-4', Opus: 'Opus', fLaC: 'FLAC',
    alac: 'Apple Lossless', dtsc: 'DTS', dtsh: 'DTS-HD', dtsl: 'DTS-HD Master',
    dtse: 'DTS Express', samr: 'AMR-NB', sawb: 'AMR-WB', twos: 'PCM (big endian)',
    sowt: 'PCM (little endian)', lpcm: 'PCM', text: '3GPP Timed Text',
    tx3g: '3GPP Timed Text', wvtt: 'WebVTT', stpp: 'TTML', c608: 'CEA-608',
    c708: 'CEA-708', encv: 'Encrypted video', enca: 'Encrypted audio',
    avif: 'AVIF image', heic: 'HEIF image', heix: 'HEIF image', mif1: 'HEIF image'
  };

  /** fourcc -> [codecId, display name, kind] for track construction. */
  var CODEC_MAP = {
    avc1: ['h264', 'video'], avc2: ['h264', 'video'], avc3: ['h264', 'video'], avc4: ['h264', 'video'],
    hvc1: ['h265', 'video'], hev1: ['h265', 'video'], hvc2: ['h265', 'video'], hev2: ['h265', 'video'],
    vvc1: ['h266', 'video'], vvi1: ['h266', 'video'],
    av01: ['av1', 'video'], av1x: ['av1', 'video'],
    vp08: ['vp8', 'video'], vp09: ['vp9', 'video'],
    mp4v: ['mpeg4', 'video'],
    mp4a: ['aac', 'audio'], Opus: ['opus', 'audio'], fLaC: ['flac', 'audio'],
    'ac-3': [null, 'audio'], 'ec-3': [null, 'audio'], alac: [null, 'audio'],
    twos: [null, 'audio'], sowt: [null, 'audio'], lpcm: [null, 'audio']
  };

  var HANDLER_TYPE = {
    vide: 'video', soun: 'audio', subt: 'subtitle', text: 'subtitle',
    sbtl: 'subtitle', clcp: 'subtitle', meta: 'metadata', hint: 'hint',
    pict: 'image', auxv: 'video', tmcd: 'timecode'
  };

  var META_KEYS = {
    '©nam': 'title', '©ART': 'artist', '©alb': 'album',
    '©day': 'date', '©cmt': 'comment', '©gen': 'genre',
    '©wrt': 'composer', '©too': 'encoder', '©mak': 'make',
    '©mod': 'model', '©swr': 'software', '©cpy': 'copyright',
    '©des': 'description', '©dir': 'director', '©st3': 'subtitle',
    'covr': 'cover art', 'trkn': 'track number', 'disk': 'disc number',
    'desc': 'description', 'ldes': 'long description', 'titl': 'title',
    'auth': 'author', 'gnre': 'genre', 'perf': 'performer', 'albm': 'album',
    'yrrc': 'year', 'cprt': 'copyright', 'name': 'name'
  };

  /** Well-known iTunes metadata data-box type indicators. */
  var DATA_TYPES = {
    0: 'binary', 1: 'UTF-8', 2: 'UTF-16', 3: 'S/JIS', 4: 'UTF-8 sort',
    5: 'UTF-16 sort', 12: 'BMP', 13: 'JPEG', 14: 'PNG', 21: 'signed int',
    22: 'unsigned int', 23: 'float32', 24: 'float64', 27: 'BMP'
  };

  /* ================================================================ helpers */

  function addMeta(P, key, value) {
    if (value == null || value === '') return;
    if (P.metaSeen[key]) return;                 // first occurrence wins
    P.metaSeen[key] = 1;
    P.metadata.push({ key: key, value: String(value) });
  }

  function readUtf8(data, start, end) {
    var stop = start;
    while (stop < end && data[stop] !== 0) stop++;
    try { return new TextDecoder('utf-8').decode(data.subarray(start, stop)); }
    catch (e) {
      var s = '';
      for (var i = start; i < stop; i++) s += String.fromCharCode(data[i]);
      return s;
    }
  }

  function brandName(brand) {
    var m = {
      isom: 'ISO Base Media', iso2: 'ISO Base Media v2', iso4: 'ISO Base Media v4',
      iso5: 'ISO Base Media v5', iso6: 'ISO Base Media v6', mp41: 'MP4 v1',
      mp42: 'MP4 v2', avc1: 'MP4 (AVC)', dash: 'DASH segment', msdh: 'DASH segment',
      cmfc: 'CMAF chunk', cmfs: 'CMAF segment', iso8: 'ISO Base Media v8',
      M4V: 'Apple M4V', M4A: 'Apple M4A', M4P: 'Apple M4P', qt: 'QuickTime',
      '3gp4': '3GPP', '3gp5': '3GPP', '3g2a': '3GPP2', avif: 'AVIF image',
      avis: 'AVIF sequence', heic: 'HEIF image', heix: 'HEIF image',
      hevc: 'HEIF (HEVC)', mif1: 'HEIF image', msf1: 'HEIF sequence',
      f4v: 'Flash MP4', f4a: 'Flash audio', isml: 'Smooth Streaming'
    };
    return m[brand] || brand;
  }

  /* ================================================================ main */

  function parse(ctx) {
    var data = ctx.data;
    var br = new MA.ByteReader(data);

    var P = {
      brand: '', brandName: '', minorVersion: 0, compatible: [],
      mvhd: null,
      traks: [],          // track state, in declaration order
      trak: null,         // track currently being walked
      fragmentTrak: null, // trak resolved via tfhd track_ID inside a moof
      trex: {},           // track_ID -> fragment defaults
      metadata: [],
      metaSeen: {},
      structures: [],
      notes: [],
      fragments: [],      // samples discovered in moof boxes
      fragCount: 0,
      maxDepth: 0,
      boxesSeen: 0
    };

    walkBoxes(br, 0, data.length, 0, P, P.structures, null);

    var result = {
      formatId: 'mp4',
      formatName: 'MP4 (ISO Base Media File Format)',
      durationSec: null,
      bitrate: null,
      tracks: [],
      metadata: P.metadata,
      structures: P.structures,
      frames: [],
      notes: P.notes,
      codecContexts: {},
      extra: []
    };

    if (P.mvhd && P.mvhd.timescale > 0) {
      result.durationSec = P.mvhd.duration / P.mvhd.timescale;
      result.extra.push({ label: 'Timescale', value: P.mvhd.timescale + ' ticks/s' });
    }
    if (P.brand) {
      result.brand = P.brand;
      result.brandName = brandName(P.brand);
      result.formatName = (HEIF_BRANDS[P.brand] ? 'HEIF/HEIC image (ISO BMFF)' : 'MP4 (ISO BMFF)') + ' — ' + P.brand;
      if (P.compatible.length) {
        result.extra.push({ label: 'Compatible brands', value: P.compatible.join(', ') });
      }
    }
    if (P.fragCount) {
      result.extra.push({ label: 'Movie fragments', value: String(P.fragCount) });
      result.formatName += ' (fragmented)';
    }

    // ---- tracks + frames -------------------------------------------------
    var frames = [];
    P.traks.forEach(function (tk) {
      var built = buildTrack(tk, P, result, data);
      if (built) {
        result.tracks.push(built.track);
        if (built.configFrame) frames.push(built.configFrame);
        for (var i = 0; i < built.frames.length; i++) frames.push(built.frames[i]);
      }
    });

    // Fragment samples are attributed to their track and merged in.
    if (P.fragCount || P.traks.some(function (tk) { return tk.truns && tk.truns.length; })) {
      var fragFrames = buildFragmentFrames(P, result, data);
      for (var f = 0; f < fragFrames.length && frames.length < MAX_FRAMES; f++) frames.push(fragFrames[f]);
    }

    // HEIF/AVIF: expose every image item as an image "frame" — the primary
    // picture plus thumbnails/derivatives — with dimensions, storage extents
    // and item roles resolved from ipma/iref.
    var imageItems = collectImageItems(P);
    if (imageItems.length) buildImageItemFrames(P, result, frames, imageItems);

    // MediaInfo-style container stats: mdat distribution, faststart layout,
    // movie timestamps and per-type stream counts.
    pushContainerStats(P, result, ctx);

    frames.sort(function (a, b) {
      return (a.offset - b.offset) || ((a.dtsSec || 0) - (b.dtsSec || 0));
    });
    if (frames.length > MAX_FRAMES) {
      frames.length = MAX_FRAMES;
      result.notes.push('Frame list capped at ' + MAX_FRAMES + ' samples.');
    }
    // Re-number so the list reads 1..N after sorting.
    frames.forEach(function (fr, i) { fr.listIndex = i + 1; });
    result.frames = frames;

    // ---- bitrate ---------------------------------------------------------
    var bytes = 0, dur = 0;
    result.tracks.forEach(function (t) {
      if (t.bitrate && t.durationSec) bytes += t.bitrate * t.durationSec / 8;
      dur = Math.max(dur, t.durationSec || 0);
    });
    if (dur > 0 && bytes > 0) result.bitrate = Math.round(bytes * 8 / dur);
    else if (dur > 0) result.bitrate = Math.round(ctx.size * 8 / dur);

    if (!result.frames.length && !P.notes.length) {
      P.notes.push('No samples were found. The file may use a layout this build does not expand yet.');
    }
    return result;
  }

  /* ======================================================== HEIF image items */

  /**
   * MediaInfo-style container stats: which bytes are header, how much is
   * media data (mdat), what trails the last mdat, whether the file is
   * faststart (moov before the first mdat), plus movie timestamps.
   */
  function pushContainerStats(P, result, ctx) {
    var counts = {};
    result.tracks.forEach(function (t) { counts[t.type] = (counts[t.type] || 0) + 1; });
    if (Object.keys(counts).length) {
      result.extra.push({
        label: 'Streams',
        value: Object.keys(counts).map(function (k) { return k + ' ' + counts[k]; }).join(', ')
      });
    }

    var firstMdat = null, lastMdat = null, moovOffset = null;
    (function walk(nodes) {
      (nodes || []).forEach(function (n) {
        if (n.code === 'mdat') {
          if (!firstMdat) firstMdat = n;
          lastMdat = n;
        } else if (n.code === 'moov' && moovOffset == null) {
          moovOffset = n.offset;
        }
        if (n.code !== 'mdat') walk(n.children);
      });
    })(result.structures);
    if (firstMdat) {
      var dataBytes = 0;
      // MediaInfo counts every byte inside mdat boxes, headers included.
      (function sumMdat(nodes) {
        (nodes || []).forEach(function (n) {
          if (n.code === 'mdat') dataBytes += n.size;
          if (n.code !== 'mdat') sumMdat(n.children);
        });
      })(result.structures);
      result.extra.push({ label: 'Header size', value: MA.formatSize(firstMdat.offset) });
      result.extra.push({ label: 'Media data size', value: MA.formatSize(dataBytes) });
      var footer = Math.max(0, ctx.size - (lastMdat.offset + lastMdat.size));
      if (footer > 0) result.extra.push({ label: 'Footer size', value: MA.formatSize(footer) });
      if (moovOffset != null) {
        result.extra.push({
          label: 'Streamable',
          value: moovOffset < firstMdat.offset ? 'yes — moov precedes mdat (faststart)'
                                               : 'no — mdat precedes moov'
        });
      }
    }

    var encDate = macTime(P.mvhd && P.mvhd.creation);
    var tagDate = macTime(P.mvhd && P.mvhd.modification);
    if (encDate) result.extra.push({ label: 'Encoded date', value: encDate });
    if (tagDate) result.extra.push({ label: 'Tagged date', value: tagDate });
  }

  /**
   * mvhd timestamps use two conventions in the wild: QuickTime-era tools
   * write seconds since 1904 (Mac epoch), ffmpeg & friends write Unix
   * seconds. A value at or beyond the Mac epoch of 1970-01-01 (2082844800)
   * can only be a post-1970 Mac-epoch date, so split on that.
   */
  function macTime(t) {
    if (!t) return null;
    try {
      var ms = t >= 2082844800 ? (t - 2082844800) * 1000 : t * 1000;
      var d = new Date(ms);
      if (isNaN(d.getTime()) || d.getFullYear() < 1971) return null;
      return d.toISOString().replace('T', ' ').replace(/\.\d+Z$/, ' UTC');
    } catch (e) { return null; }
  }

  /**
   * Resolve ipma associations (item → ipco property indexes) into per-item
   * properties: ispe dimensions, irot rotation, pixi channel info and the
   * codec configuration record (hvcC/av1C).
   */
  function resolveItemProps(P) {
    Object.keys(P.ipma || {}).forEach(function (idStr) {
      var it = P.items && P.items[idStr];
      if (!it) return;
      it.props = it.props || {};
      (P.ipma[idStr] || []).forEach(function (a) {
        var prop = P.ipcoProps && P.ipcoProps[a.index - 1];
        if (!prop) return;
        if (prop.type === 'ispe' && prop.ispe && (!it.props.ispe || it.props.ispeFromOrder)) {
          it.props.ispe = { width: prop.ispe.width, height: prop.ispe.height };
          delete it.props.ispeFromOrder;
        } else if (prop.type === 'irot' && prop.irot != null && it.props.irot == null) {
          it.props.irot = prop.irot;
        } else if (prop.type === 'pixi' && prop.pixi && !it.props.pixi) {
          it.props.pixi = prop.pixi;
        } else if (prop.cfg && !it.props.cfg) {
          it.props.cfg = prop.cfg;
        }
      });
    });
  }

  /** All items carrying a picture, primary first. */
  function collectImageItems(P) {
    resolveItemProps(P);
    var items = P.items || {};
    var iloc = P.iloc || {};
    var out = [];
    Object.keys(items).forEach(function (idStr) {
      var id = Number(idStr);
      var it = items[idStr];
      var isImage = IMAGE_ITEM_TYPES[it.type] ||
        (P.metaHandler === 'pict' && !/^(mime|Exif|feop|ipc[OC])$/.test(it.type));
      if (!isImage) return;
      var role = null, roleOf = null;
      (P.itemRefs || []).forEach(function (r) {
        if (r.from === id && ITEM_ROLE_NAME[r.type] && !role) {
          role = ITEM_ROLE_NAME[r.type];
          roleOf = r.to && r.to.length ? r.to[0] : null;
        }
      });
      out.push({ id: id, item: it, iloc: iloc[idStr] || null,
                 isPrimary: id === P.primaryItem, role: role, roleOf: roleOf });
    });
    out.sort(function (a, b) { return (b.isPrimary - a.isPrimary) || (a.id - b.id); });
    return out;
  }

  /**
   * One image frame per HEIF/AVIF item plus a single image track. The frame
   * syntax carries the item metadata (role, dimensions, extents) and, when a
   * decoder configuration record is bound via ipma, its SPS/PPS tables.
   */
  function buildImageItemFrames(P, result, frames, imageItems) {
    var primary = null;
    imageItems.forEach(function (e) { if (e.isPrimary && !primary) primary = e; });
    if (!primary) primary = imageItems[0];
    var pispe = primary.item.props && primary.item.props.ispe;
    var pcfg = primary.item.props && primary.item.props.cfg;

    var imageTrack = {
      id: 0, type: 'image',
      codec: (pcfg && pcfg.codecId) || primary.item.type,
      codecName: CODEC_NAME[primary.item.type] || 'HEIF/AVIF image item',
      width: pispe ? pispe.width : null,
      height: pispe ? pispe.height : null,
      sampleCount: imageItems.length,
      streamSize: null,
      language: '',
      extra: []
    };

    imageItems.forEach(function (entry, i) {
      var it = entry.item;
      var ispe = it.props && it.props.ispe;
      var icfg = it.props && it.props.cfg;
      var extents = ((entry.iloc && entry.iloc.extents) || []).filter(function (x) { return x.length > 0; });
      var offset = extents.length ? extents[0].offset : 0;
      var size = extents.reduce(function (s, x) { return s + x.length; }, 0);
      imageTrack.streamSize = (imageTrack.streamSize || 0) + size;

      var roleText = entry.isPrimary ? 'primary' : (entry.role || 'image');
      if (entry.role === 'thumbnail' && entry.roleOf != null) roleText += ' of item ' + entry.roleOf;
      var label = 'Item ' + entry.id + ' (' + it.type + ')' +
        (ispe ? ' · ' + ispe.width + '×' + ispe.height : '') +
        ' — ' + roleText;

      var rows = [
        { name: 'item_ID', syntax: '', bits: '', value: entry.id, note: '', offset: 0, depth: 0 },
        { name: 'item_type', syntax: '', bits: '', value: "'" + it.type + "'", note: it.name || '', offset: 0, depth: 0 },
        { name: 'role', syntax: '', bits: '', value: roleText,
          note: entry.isPrimary ? 'from pitm' : (entry.role ? 'from iref' : ''), offset: 0, depth: 0 },
        { name: 'width', syntax: '', bits: '', value: ispe ? ispe.width : '—',
          note: ispe ? '' : 'no ispe property', offset: 0, depth: 0 },
        { name: 'height', syntax: '', bits: '', value: ispe ? ispe.height : '—', note: '', offset: 0, depth: 0 }
      ];
      if (it.props.irot != null) {
        rows.push({ name: 'rotation', syntax: '', bits: '', value: it.props.irot + '°', note: 'irot property', offset: 0, depth: 0 });
      }
      if (it.props.pixi) {
        rows.push({ name: 'pixel_info', syntax: '', bits: '',
                    value: it.props.pixi.channels + ' channel(s), ' + it.props.pixi.bits + ' bit(s)',
                    note: 'pixi property', offset: 0, depth: 0 });
      }
      if (icfg && icfg.info && icfg.info.profile != null) {
        rows.push({ name: 'profile', syntax: '', bits: '', value: String(icfg.info.profile), note: '', offset: 0, depth: 0 });
        rows.push({ name: 'level', syntax: '', bits: '', value: String(icfg.info.level), note: '', offset: 0, depth: 0 });
      }
      if (it.hidden) {
        rows.push({ name: 'hidden_item', syntax: '', bits: '', value: 'yes', note: '', offset: 0, depth: 0 });
      }
      extents.forEach(function (x, xi) {
        rows.push({ name: 'extent[' + xi + '].offset', syntax: '', bits: '', value: MA.hex(x.offset, 8), note: '', offset: x.offset, depth: 0 });
        rows.push({ name: 'extent[' + xi + '].length', syntax: '', bits: '', value: x.length + ' bytes', note: '', offset: x.offset, depth: 0 });
      });

      var tables = [MA.synSection('HEIF item', label, rows)];
      if (icfg && icfg.tables) {
        for (var t = 0; t < icfg.tables.length; t++) {
          if (icfg.tables[t]) tables.push(icfg.tables[t]);
        }
      }

      frames.push({
        track: 0, index: i + 1, type: 'image', kind: 'image',
        codec: (icfg && icfg.codecId) || it.type,
        codecName: CODEC_NAME[it.type] || '',
        offset: offset, size: size, keyframe: true, label: label,
        tables: tables,
        imageInfo: {
          role: roleText,
          width: ispe ? ispe.width : null,
          height: ispe ? ispe.height : null,
          codec: (icfg && icfg.codecId) || it.type,
          codecName: CODEC_NAME[it.type] || it.type,
          params: [
            icfg && icfg.info && icfg.info.profile != null ? 'profile ' + icfg.info.profile : null,
            icfg && icfg.info && icfg.info.level != null ? 'level ' + icfg.info.level : null,
            it.props.irot != null ? 'rotated ' + it.props.irot + '°' : null,
            it.props.pixi ? it.props.pixi.channels + 'ch ' + it.props.pixi.bits + 'bit' : null
          ].filter(Boolean).join(', ')
        }
        /* No preview recipe: the extent is a raw coded bitstream (HEVC/AV1),
         * not a self-contained image file — browsers cannot decode it. */
      });
    });

    var parts = imageItems.map(function (e) {
      var ispe = e.item.props && e.item.props.ispe;
      return 'item ' + e.id + (e.isPrimary ? ' (primary)' : (e.role ? ' (' + e.role + ')' : '')) +
        (ispe ? ' ' + ispe.width + '×' + ispe.height : '');
    });
    result.notes.push('HEIF item layout: ' + parts.join(', ') + '.');
    result.extra.push({ label: 'Image items', value: String(imageItems.length) });
    result.extra.push({ label: 'Primary item',
                        value: primary.id + (pispe ? ' (' + pispe.width + '×' + pispe.height + ')' : '') });
    if (imageTrack.streamSize) {
      imageTrack.extra.push({ label: 'Image items bytes', value: MA.formatSize(imageTrack.streamSize) });
    }
    result.tracks.push(imageTrack);
  }

  /* ============================================================ box walker */

  function walkBoxes(br, start, end, depth, P, out, parentType) {
    if (depth > MAX_BOX_DEPTH) return out;
    var data = br.u8;
    var p = start;
    var limit = Math.min(end, data.length);

    while (p + 8 <= limit) {
      if (++P.boxesSeen > MAX_BOXES) {
        P.notes.push('Structure truncated after ' + MAX_BOXES + ' boxes.');
        break;
      }
      var boxStart = p;
      var size = br.u32at(p);
      var type = br.fourcc(p + 4);
      var hdrLen = 8;
      var payloadStart = p + 8;

      if (size === 1) {
        if (p + 16 > limit) break;
        size = br.u64at(p + 8);
        hdrLen = 16; payloadStart = p + 16;
      } else if (size === 0) {
        size = limit - p;                    // box runs to the end of the file
      }
      if (size < hdrLen || boxStart + size > limit) {
        // A truncated final box is common in live captures; stop cleanly.
        if (!P.notes.length || P.notes[P.notes.length - 1].indexOf('truncated') < 0) {
          P.notes.push('Truncated box "' + type + '" at ' + MA.hex(boxStart, 8) +
                       ' (declared ' + size + ' bytes, only ' + (limit - boxStart) + ' available).');
        }
        break;
      }
      var boxEnd = boxStart + size;

      var node = MA.makeNode('box', type, BOX_NAMES[type] || '', boxStart, size);
      MA.nodeField(node, 'size', size + ' B', boxStart, 4);
      MA.nodeField(node, 'type', "'" + type + "'", boxStart + 4, 4);
      if (hdrLen === 16) MA.nodeField(node, 'largesize', String(size), boxStart + 8, 8);
      if (type === 'uuid' && payloadStart + 16 <= boxEnd) {
        MA.nodeField(node, 'usertype', br.guid(payloadStart), payloadStart, 16);
      }

      // Fragment bookkeeping: `default-base-is-moof` resolves sample offsets
      // against the start of the enclosing moof, and each traf gets its own
      // tfhd which the following trun boxes refer to.
      var prevTrak = P.trak;
      var prevMoof = P.moofOffset;
      var prevTfhd = P.currentTfhd;
      var prevFragTrak = P.fragmentTrak;
      if (type === 'moof') { P.moofOffset = boxStart; P.fragmentTrak = null; }
      if (type === 'traf') { P.currentTfhd = null; P.fragmentTrak = null; }
      // Remember which metadata key the following `data` box belongs to.
      if (parentType === 'ilst') P.lastIlstKey = type;

      // A "trak" starts a new track context; everything inside it is routed there.
      if (type === 'trak') {
        P.trak = {
          index: P.traks.length, node: node,
          tkhd: null, mdhd: null, hdlr: null, samples: {}, config: {},
          stsdNode: null, built: null
        };
        P.traks.push(P.trak);
      }

      var childStart = payloadStart;
      var isContainer = CONTAINERS[type] || FULLBOX_CONTAINERS[type];
      if (FULLBOX_CONTAINERS[type]) {
        // QuickTime writes a `meta` box without the version/flags header, so
        // only consume those 4 bytes when the payload is not already a box
        // chain.
        if (!(type === 'meta' && isBoxChain(br, payloadStart, boxEnd))) {
          var fb = readFull(br, payloadStart, node);
          childStart = payloadStart + 4;
          if (type === 'iref') P.irefVersion = fb.version;
        }
      }

      try {
        if (type === 'stsd') {
          annotateStsd(br, node, payloadStart, boxEnd, P, depth);
        } else if (isContainer) {
          node.children = walkBoxes(br, childStart, boxEnd, depth + 1, P, [], type);
          if (type === 'trak') annotateTrakContainer(node, P.trak);
          if (!node.children.length && boxEnd > childStart) {
            payloadFields(node, br, childStart, boxEnd);
          }
        } else if (parentType === 'iref') {
          parseIrefChild(br, type, node, payloadStart, boxEnd, P);
        } else if (!annotateBox(br, type, node, payloadStart, boxEnd, P, depth)) {
          // Unknown box: only descend when the payload really is a box chain
          // (isBoxChain checks raw fourcc bytes). Leaf boxes such as auth /
          // gnre / cprt carry text or integers, and must not grow phantom
          // children, so their bytes are surfaced as ASCII + hex instead.
          if (isBoxChain(br, payloadStart, boxEnd)) {
            node.children = walkBoxes(br, payloadStart, boxEnd, depth + 1, P, [], type);
          } else {
            payloadFields(node, br, payloadStart, boxEnd);
          }
        }
      } catch (e) {
        MA.nodeNote(node, 'Parse error: ' + (e && e.message || e));
        P.notes.push('Error parsing "' + type + '" at ' + MA.hex(boxStart, 8) + ': ' + (e && e.message || e));
      }

      // HEIF properties live in ipco as an ordered 1-based list; ipma refers
      // to entries by that index. Capture what each property box told us.
      if (parentType === 'ipco') {
        P.ipcoProps = P.ipcoProps || [];
        P.ipcoProps.push({
          index: P.ipcoProps.length + 1, type: type, node: node,
          ispe: (type === 'ispe' && P.lastIspe) ? { width: P.lastIspe.width, height: P.lastIspe.height } : null,
          irot: (type === 'irot' && P.lastIrot != null) ? P.lastIrot : null,
          pixi: (type === 'pixi' && P.lastPixi) ? P.lastPixi : null,
          cfg: node._codecCfg || null
        });
      }

      if (type === 'trak') P.trak = prevTrak;
      if (type === 'moof') { P.moofOffset = prevMoof; P.fragmentTrak = prevFragTrak; }
      if (type === 'traf') { P.currentTfhd = prevTfhd; P.fragmentTrak = prevFragTrak; }

      out.push(node);
      if (boxEnd <= p) break;               // defensive: never spin
      p = boxEnd;
    }
    return out;
  }

  /**
   * Raw payload preview for boxes without a schema (auth, gnre, cprt, …).
   * Two field rows — an ASCII rendering and a hex dump — both anchored at the
   * payload start with the full payload length, so their offset links in the
   * structure panel jump to (and select) the bytes in the hex view.
   */
  function payloadFields(node, br, ps, pe) {
    var len = pe - ps;
    if (len <= 0) return;
    var data = br.u8;
    var show = Math.min(len, 64);
    var ascii = '', hex = '';
    for (var i = 0; i < show; i++) {
      var b = data[ps + i];
      ascii += (b >= 0x20 && b < 0x7f) ? String.fromCharCode(b) : '.';
      hex += MA.pad(b.toString(16), 2, '0') + (i % 8 === 7 && i !== show - 1 ? '  ' : ' ');
    }
    var tail = len > show ? '…' : '';
    MA.nodeField(node, 'ASCII', ascii + tail, ps, len);
    MA.nodeField(node, 'hex', hex.replace(/\s+$/, '') + (tail ? '  ' + tail : ''), ps, len);
  }

  /**
   * Strict "is a complete box chain" test. The fourcc bytes are inspected raw:
   * ByteReader.fourcc() maps non-printables to '.', so a version/flags header
   * (00 00 00 00) would pass a sanitised check. A size of 0 (extends to end)
   * is rejected too, because a real payload chain must be self-describing.
   */
  function isBoxChain(br, start, end) {
    if (end - start < 8) return false;
    var data = br.u8, p = start, n = 0;
    while (p + 8 <= end && n < 8) {
      var s = br.u32at(p);
      var len = s;
      if (s === 1) { if (p + 16 > end) return false; len = br.u64at(p + 8); }
      else if (s === 0) return false;
      if (len < 8 || p + len > end) return false;
      for (var i = 0; i < 4; i++) {
        var c = data[p + 4 + i];
        if (c < 0x20 || c > 0x7e) return false;
      }
      p += len; n++;
    }
    return n > 0 && p === end;
  }

  function readFull(br, ps, node) {
    var vf = br.u32at(ps);
    if (node) {
      MA.nodeField(node, 'version', (vf >>> 24), ps, 1);
      MA.nodeField(node, 'flags', '0x' + MA.pad((vf & 0xffffff).toString(16), 6, '0'), ps + 1, 3);
    }
    return { version: vf >>> 24, flags: vf & 0xffffff, p: ps + 4 };
  }

  /**
   * Clamp a file-declared count. Every table entry occupies at least
   * `minBytes`, so a count that cannot fit inside the box is corrupt; without
   * this a damaged stz2 count spins the bit-unpacking loop for billions of
   * iterations and locks the tab.
   */
  function entryCount(n, ps, pe, minBytes, node, label) {
    var max = Math.max(0, Math.floor((pe - ps) / Math.max(1, minBytes)));
    if (n > max) {
      if (node) MA.nodeField(node, label + ' (rejected: exceeds box size)', n + ' > max ' + max, ps, 4);
      return max;
    }
    return n;
  }

  /* ============================================================= annotators */

  function annotateTrakContainer(node, tk) {
    if (!tk) return;
    if (tk.tkhd) tk.tkhd.node = node.children.filter(function (c) { return c.code === 'tkhd'; })[0];
  }

  /** @returns true when the box type was recognised and annotated. */
  function annotateBox(br, type, node, ps, pe, P, depth) {
    var tk = P.trak;
    var data = br.u8;

    switch (type) {
      case 'ftyp': case 'styp': {
        MA.nodeField(node, 'major_brand', "'" + br.fourcc(ps) + "'", ps, 4);
        MA.nodeField(node, 'minor_version', br.u32at(ps + 4), ps + 4, 4);
        var brands = [], q = ps + 8;
        while (q + 4 <= pe && brands.length < 64) { brands.push(br.fourcc(q)); q += 4; }
        MA.nodeField(node, 'compatible_brands', brands.join(', '), ps + 8, Math.max(0, q - ps - 8));
        if (type === 'ftyp') {
          P.brand = br.fourcc(ps);
          P.minorVersion = br.u32at(ps + 4);
          P.compatible = brands;
        }
        return true;
      }
      case 'mvhd': parseMvhd(br, node, ps, pe, P); return true;
      case 'tkhd': parseTkhd(br, node, ps, pe, tk); return true;
      case 'mdhd': parseMdhd(br, node, ps, pe, tk); return true;
      case 'hdlr': parseHdlr(br, node, ps, pe, tk, P); return true;
      case 'elst': parseElst(br, node, ps, pe, tk); return true;
      case 'vmhd': case 'smhd': case 'hmhd': case 'nmhd': {
        readFull(br, ps, node);
        var mq = ps + 4;
        if (type === 'vmhd') {
          MA.nodeField(node, 'graphicsmode', br.u16at(mq), mq, 2);
          MA.nodeField(node, 'opcolor', [br.u16at(mq + 2), br.u16at(mq + 4), br.u16at(mq + 6)].join(' '),
                       mq + 2, 6);
        } else if (type === 'smhd') {
          var rawBal = br.u16at(mq);
          MA.nodeField(node, 'balance', ((rawBal >= 0x8000 ? rawBal - 0x10000 : rawBal) / 256),
                       mq, 2);
          MA.nodeField(node, 'reserved', br.u16at(mq + 2), mq + 2, 2);
        } else if (type === 'hmhd') {
          MA.nodeField(node, 'maxPDUsize', br.u16at(mq), mq, 2);
          MA.nodeField(node, 'avgPDUsize', br.u16at(mq + 2), mq + 2, 2);
          MA.nodeField(node, 'maxbitrate', br.u32at(mq + 4), mq + 4, 4);
          MA.nodeField(node, 'avgbitrate', br.u32at(mq + 8), mq + 8, 4);
        }
        return true;
      }
      case 'stts': parseStts(br, node, ps, pe, tk); return true;
      case 'ctts': parseCtts(br, node, ps, pe, tk); return true;
      case 'stsc': parseStsc(br, node, ps, pe, tk); return true;
      case 'stsz': parseStsz(br, node, ps, pe, tk, false); return true;
      case 'stz2': parseStsz(br, node, ps, pe, tk, true); return true;
      case 'stco': parseChunkOffsets(br, node, ps, pe, tk, false); return true;
      case 'co64': parseChunkOffsets(br, node, ps, pe, tk, true); return true;
      case 'stss': parseStss(br, node, ps, pe, tk); return true;
      case 'stsh': parseStsh(br, node, ps, pe); return true;
      case 'sdtp': parseSdtp(br, node, ps, pe, tk); return true;
      case 'dref': parseDref(br, node, ps, pe, P); return true;
      case 'pasp': {
        MA.nodeField(node, 'hSpacing', br.u32at(ps), ps, 4);
        MA.nodeField(node, 'vSpacing', br.u32at(ps + 4), ps + 4, 4);
        return true;
      }
      case 'clap': {
        MA.nodeField(node, 'cleanApertureWidthN', br.u32at(ps), ps, 4);
        MA.nodeField(node, 'cleanApertureWidthD', br.u32at(ps + 4), ps + 4, 4);
        MA.nodeField(node, 'cleanApertureHeightN', br.u32at(ps + 8), ps + 8, 4);
        MA.nodeField(node, 'cleanApertureHeightD', br.u32at(ps + 12), ps + 12, 4);
        return true;
      }
      case 'colr': {
        var ctype = br.fourcc(ps);
        MA.nodeField(node, 'colour_type', "'" + ctype + "'", ps, 4);
        if (ctype === 'nclx' || ctype === 'nclc') {
          var cp = br.u16at(ps + 4), ct = br.u16at(ps + 6), cm = br.u16at(ps + 8);
          MA.nodeField(node, 'colour_primaries', cp, ps + 4, 2);
          MA.nodeField(node, 'transfer_characteristics', ct, ps + 6, 2);
          MA.nodeField(node, 'matrix_coefficients', cm, ps + 8, 2);
          var fullRange = null;
          if (ctype === 'nclx') {
            fullRange = (br.u8at(ps + 10) >> 7) & 1;
            MA.nodeField(node, 'full_range_flag', fullRange, ps + 10, 1);
          }
          if (tk) tk.config.colour = { primaries: cp, transfer: ct, matrix: cm, fullRange: fullRange };
        } else if (ctype === 'prof' || ctype === 'rICC') {
          MA.nodeField(node, 'ICC profile', (pe - ps - 4) + ' bytes', ps + 4, pe - ps - 4);
        }
        return true;
      }
      case 'btrt': {
        MA.nodeField(node, 'bufferSizeDB', br.u32at(ps), ps, 4);
        MA.nodeField(node, 'maxBitrate', br.u32at(ps + 4) + ' bps', ps + 4, 4);
        MA.nodeField(node, 'avgBitrate', br.u32at(ps + 8) + ' bps', ps + 8, 4);
        if (tk) { tk.config.maxBitrate = br.u32at(ps + 4); tk.config.avgBitrate = br.u32at(ps + 8); }
        return true;
      }
      case 'avcC': parseAvcC(br, node, ps, pe, tk, P); return true;
      case 'hvcC': parseHvcC(br, node, ps, pe, tk, P); return true;
      case 'vvcC': parseVvcC(br, node, ps, pe, tk, P); return true;
      case 'av1C': parseAv1C(br, node, ps, pe, tk, P); return true;
      case 'vpcC': parseVpcC(br, node, ps, pe, tk, P); return true;
      case 'esds': parseEsds(br, node, ps, pe, tk, P); return true;
      case 'dvcC': case 'dvvC': {
        MA.nodeField(node, 'dv_version_major', data[ps], ps, 1);
        MA.nodeField(node, 'dv_version_minor', data[ps + 1], ps + 1, 1);
        var b = data[ps + 2];
        MA.nodeField(node, 'dv_profile', b >> 1, ps + 2, 1);
        MA.nodeField(node, 'dv_level', ((b & 1) << 5) | (data[ps + 3] >> 3), ps + 2, 2);
        MA.nodeField(node, 'rpu_present_flag', (data[ps + 3] >> 2) & 1, ps + 3, 1);
        MA.nodeField(node, 'el_present_flag', (data[ps + 3] >> 1) & 1, ps + 3, 1);
        MA.nodeField(node, 'bl_present_flag', data[ps + 3] & 1, ps + 3, 1);
        return true;
      }
      /* ---------------- fragments ---------------- */
      case 'mfhd': {
        readFull(br, ps, node);
        MA.nodeField(node, 'sequence_number', br.u32at(ps + 4), ps + 4, 4);
        P.fragCount++;
        return true;
      }
      case 'tfhd': parseTfhd(br, node, ps, pe, P); return true;
      case 'tfdt': {
        var f = readFull(br, ps, node);
        var t = f.version === 1 ? br.u64at(ps + 4) : br.u32at(ps + 4);
        MA.nodeField(node, 'baseMediaDecodeTime', String(t), ps + 4, f.version === 1 ? 8 : 4);
        if (tk) tk.baseMediaDecodeTime = t;
        if (P.fragmentTrak) P.fragmentTrak.baseMediaDecodeTime = t;
        return true;
      }
      case 'trun': parseTrun(br, node, ps, pe, P); return true;
      case 'trex': parseTrex(br, node, ps, pe, P); return true;
      case 'mehd': {
        var mf = readFull(br, ps, node);
        MA.nodeField(node, 'fragment_duration', String(mf.version === 1 ? br.u64at(ps + 4) : br.u32at(ps + 4)),
                     ps + 4, mf.version === 1 ? 8 : 4);
        return true;
      }
      case 'sidx': parseSidx(br, node, ps, pe); return true;
      case 'pssh': {
        readFull(br, ps, node);
        MA.nodeField(node, 'system_ID', br.guid(ps + 4), ps + 4, 16);
        var kidCount = br.u32at(ps + 20);
        MA.nodeField(node, 'kid_count', kidCount, ps + 20, 4);
        MA.nodeField(node, 'data_size', pe - (ps + 24 + kidCount * 16), ps + 24 + kidCount * 16,
                     Math.max(0, pe - (ps + 24 + kidCount * 16)));
        P.notes.push('File contains a Protection System Specific Header (DRM).');
        return true;
      }
      case 'schm': {
        readFull(br, ps, node);
        MA.nodeField(node, 'scheme_type', "'" + br.fourcc(ps + 4) + "'", ps + 4, 4);
        MA.nodeField(node, 'scheme_version', br.u32at(ps + 8), ps + 8, 4);
        return true;
      }
      case 'frma': {
        MA.nodeField(node, 'data_format', "'" + br.fourcc(ps) + "'", ps, 4);
        return true;
      }
      /* ---------------- HEIF / AVIF ---------------- */
      case 'pitm': {
        var pf = readFull(br, ps, node);
        P.primaryItem = pf.version === 0 ? br.u16at(ps + 4) : br.u32at(ps + 4);
        MA.nodeField(node, 'item_ID', P.primaryItem, ps + 4, pf.version === 0 ? 2 : 4);
        return true;
      }
      case 'ispe': {
        readFull(br, ps, node);
        var w = br.u32at(ps + 4), h = br.u32at(ps + 8);
        MA.nodeField(node, 'image_width', w, ps + 4, 4);
        MA.nodeField(node, 'image_height', h, ps + 8, 4);
        P.lastIspe = { width: w, height: h, node: node };
        return true;
      }
      case 'pixi': {
        readFull(br, ps, node);
        var nch = data[ps + 4];
        MA.nodeField(node, 'num_channels', nch, ps + 4, 1);
        var bits = [];
        for (var i = 0; i < nch && ps + 5 + i < pe; i++) bits.push(data[ps + 5 + i]);
        if (bits.length) MA.nodeField(node, 'bits_per_channel', bits.join(', '), ps + 5, bits.length);
        P.lastPixi = { channels: nch, bits: bits.join(', ') };
        return true;
      }
      case 'irot': {
        readFull(br, ps, node);
        var angle = (data[ps + 4] & 3) * 90;
        MA.nodeField(node, 'angle', angle + '°', ps + 4, 1);
        P.lastIrot = angle;
        return true;
      }
      case 'ipma': parseIpma(br, node, ps, pe, P); return true;
      case 'idat': {
        readFull(br, ps, node);
        P.idatOffset = ps + 4;
        MA.nodeField(node, 'data', (pe - ps - 4) + ' bytes', ps + 4, Math.max(0, pe - ps - 4));
        return true;
      }
      case 'iloc': parseIloc(br, node, ps, pe, P); return true;
      case 'iinf': parseIinf(br, node, ps, pe, P, depth); return true;
      case 'infe': parseInfe(br, node, ps, pe, P); return true;
      case 'mdat': return true;             // payload is media data, not structure
      case 'free': case 'skip': case 'wide': case 'junk': return true;

      // A metadata item payload (the child of an ilst key such as "©nam").
      // It holds a typed value, never child boxes — descending here used to
      // produce a chain of bogus "boxes" read out of the value bytes.
      case 'data': {
        var valueType = (br.u32at(ps) >>> 24) & 0xff;
        MA.nodeField(node, 'type', valueType + ' (' + (DATA_TYPES[valueType] || 'unknown') + ')', ps, 4);
        MA.nodeField(node, 'locale', br.u32at(ps + 4), ps + 4, 4);
        var vStart = ps + 8;
        var vLen = Math.max(0, pe - vStart);
        var key = P.lastIlstKey ? (META_KEYS[P.lastIlstKey] || P.lastIlstKey) : 'metadata';
        if (valueType === 1 && vLen > 0) {              // UTF-8 text
          var text = readUtf8(data, vStart, pe);
          MA.nodeField(node, 'value', text, vStart, vLen);
          addMeta(P, key, text);
        } else if ((valueType === 21 || valueType === 22) && vLen >= 4) {   // signed/unsigned int
          MA.nodeField(node, 'value', String(br.u32at(vStart)), vStart, vLen);
          addMeta(P, key, String(br.u32at(vStart)));
        } else if (valueType === 13 || valueType === 14 || valueType === 12) {  // JPEG/PNG/BMP cover art
          MA.nodeField(node, 'value', MA.formatSize(vLen) + ' cover art', vStart, vLen);
          addMeta(P, key, MA.formatSize(vLen) + ' image');
        } else if ((P.lastIlstKey === 'trkn' || P.lastIlstKey === 'disk') && vLen >= 6) {
          var num = (data[vStart + 2] << 8) | data[vStart + 3];
          var of = (data[vStart + 4] << 8) | data[vStart + 5];
          var s = num + (of ? ' of ' + of : '');
          MA.nodeField(node, 'value', s, vStart, vLen);
          addMeta(P, key, s);
        } else {
          MA.nodeField(node, 'value', '<binary ' + vLen + ' bytes>', vStart, vLen);
        }
        return true;
      }
      case 'keys': {
        readFull(br, ps, node);
        var keyCount = entryCount(br.u32at(ps + 4), ps, pe, 8, node, 'entry_count');
        MA.nodeField(node, 'entry_count', keyCount, ps + 4, 4);
        return true;
      }
      default: return false;
    }
  }

  /* ---------------------------------------------------------- full boxes */

  function parseMvhd(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    var creation, modification, timescale, duration;
    if (f.version === 1) {
      MA.nodeField(node, 'creation_time', String(br.u64at(p)), p, 8); creation = br.u64at(p); p += 8;
      MA.nodeField(node, 'modification_time', String(br.u64at(p)), p, 8); modification = br.u64at(p); p += 8;
      MA.nodeField(node, 'timescale', br.u32at(p), p, 4); timescale = br.u32at(p); p += 4;
      MA.nodeField(node, 'duration', String(br.u64at(p)), p, 8); duration = br.u64at(p); p += 8;
    } else {
      MA.nodeField(node, 'creation_time', br.u32at(p), p, 4); creation = br.u32at(p); p += 4;
      MA.nodeField(node, 'modification_time', br.u32at(p), p, 4); modification = br.u32at(p); p += 4;
      MA.nodeField(node, 'timescale', br.u32at(p), p, 4); timescale = br.u32at(p); p += 4;
      MA.nodeField(node, 'duration', br.u32at(p), p, 4); duration = br.u32at(p); p += 4;
    }
    var rate = br.u32at(p);
    MA.nodeField(node, 'rate', (rate / 65536).toFixed(3), p, 4); p += 4;
    MA.nodeField(node, 'volume', (br.u16at(p) / 256).toFixed(2), p, 2); p += 2;
    p += 2 + 8;                                    // reserved
    MA.nodeField(node, 'matrix', matrixString(br, p), p, 36); p += 36;
    p += 24;                                       // pre_defined
    MA.nodeField(node, 'next_track_ID', br.u32at(p), p, 4);

    if (timescale > 0) {
      MA.nodeField(node, 'duration (time)', MA.formatDuration(duration / timescale), ps, 0);
    }
    P.mvhd = { timescale: timescale, duration: duration,
               creation: creation, modification: modification };
  }

  function matrixString(br, p) {
    var m = [];
    for (var i = 0; i < 9; i++) m.push(br.u32at(p + i * 4));
    return '[' + m.join(' ') + ']';
  }

  function parseTkhd(br, node, ps, pe, tk) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    if (f.version === 1) {
      MA.nodeField(node, 'creation_time', String(br.u64at(p)), p, 8); p += 8;
      MA.nodeField(node, 'modification_time', String(br.u64at(p)), p, 8); p += 8;
    } else {
      MA.nodeField(node, 'creation_time', br.u32at(p), p, 4); p += 4;
      MA.nodeField(node, 'modification_time', br.u32at(p), p, 4); p += 4;
    }
    var trackId = br.u32at(p);
    MA.nodeField(node, 'track_ID', trackId, p, 4); p += 4;
    p += 4;                                        // reserved
    var duration = f.version === 1 ? br.u64at(p) : br.u32at(p);
    MA.nodeField(node, 'duration', String(duration), p, f.version === 1 ? 8 : 4);
    p += f.version === 1 ? 8 : 4;
    p += 8;                                        // reserved[2]
    var layer = br.u16at(p); MA.nodeField(node, 'layer', layer, p, 2); p += 2;
    var altGroup = br.u16at(p); MA.nodeField(node, 'alternate_group', altGroup, p, 2); p += 2;
    var volume = br.u16at(p);
    MA.nodeField(node, 'volume', (volume / 256).toFixed(2), p, 2); p += 2;
    p += 2;                                        // reserved
    MA.nodeField(node, 'matrix', matrixString(br, p), p, 36); p += 36;
    var tw = br.u32at(p) / 65536, th = br.u32at(p + 4) / 65536;
    MA.nodeField(node, 'width', tw.toFixed(2), p, 4);
    MA.nodeField(node, 'height', th.toFixed(2), p + 4, 4);

    var flags = f.flags;
    MA.nodeField(node, 'track_enabled', (flags & 1) ? 'yes' : 'no', ps + 1, 3);
    MA.nodeField(node, 'track_in_movie', (flags & 2) ? 'yes' : 'no', ps + 1, 3);
    MA.nodeField(node, 'track_in_preview', (flags & 4) ? 'yes' : 'no', ps + 1, 3);

    if (tk) tk.tkhd = {
      id: trackId, width: tw, height: th, duration: duration,
      layer: layer, alternateGroup: altGroup, volume: volume / 256,
      enabled: (flags & 1) === 1
    };
  }

  function parseMdhd(br, node, ps, pe, tk) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    if (f.version === 1) {
      MA.nodeField(node, 'creation_time', String(br.u64at(p)), p, 8); p += 8;
      MA.nodeField(node, 'modification_time', String(br.u64at(p)), p, 8); p += 8;
    } else {
      MA.nodeField(node, 'creation_time', br.u32at(p), p, 4); p += 4;
      MA.nodeField(node, 'modification_time', br.u32at(p), p, 4); p += 4;
    }
    var timescale = br.u32at(p);
    MA.nodeField(node, 'timescale', timescale, p, 4); p += 4;
    var duration = f.version === 1 ? br.u64at(p) : br.u32at(p);
    MA.nodeField(node, 'duration', String(duration), p, f.version === 1 ? 8 : 4);
    p += f.version === 1 ? 8 : 4;
    var langBits = br.u16at(p);
    var lang = String.fromCharCode(
      0x60 + ((langBits >> 10) & 0x1f),
      0x60 + ((langBits >> 5) & 0x1f),
      0x60 + (langBits & 0x1f));
    MA.nodeField(node, 'language', "'" + lang + "'", p, 2);
    p += 2;
    MA.nodeField(node, 'pre_defined', br.u16at(p), p, 2);
    if (timescale > 0) MA.nodeField(node, 'duration (time)', MA.formatDuration(duration / timescale), ps, 0);

    if (tk) tk.mdhd = { timescale: timescale, duration: duration, language: lang };
  }

  function parseHdlr(br, node, ps, pe, tk, P) {
    readFull(br, ps, node);
    MA.nodeField(node, 'pre_defined', br.u32at(ps + 4), ps + 4, 4);
    var handler = br.fourcc(ps + 8);
    MA.nodeField(node, 'handler_type', "'" + handler + "'", ps + 8, 4);
    MA.nodeField(node, 'reserved', '0x' + MA.pad(br.u32at(ps + 12).toString(16), 8, '0'), ps + 12, 12);
    var nameBytes = pe - (ps + 24);
    var nm = nameBytes > 0 ? readCString(br.u8, ps + 24, pe) : '';
    if (nameBytes > 0) MA.nodeField(node, 'name', nm || '(empty)', ps + 24, nameBytes);
    if (tk) tk.hdlr = { handler: handler, name: nm };
    else P.metaHandler = handler;          // meta box handler ('pict' for HEIF)
  }

  function readCString(data, start, end) {
    var s = '';
    for (var i = start; i < end && i < start + 256; i++) {
      if (data[i] === 0) break;
      s += data[i] >= 32 ? String.fromCharCode(data[i]) : '.';
    }
    return s;
  }

  function parseElst(br, node, ps, pe, tk) {
    var f = readFull(br, ps, node);
    var count = entryCount(br.u32at(ps + 4), ps, pe, f.version === 1 ? 20 : 12, node, 'entry_count');
    MA.nodeField(node, 'entry_count', count, ps + 4, 4);
    var p = ps + 8;
    var entries = [];
    for (var i = 0; i < count; i++) {
      var segDur, mediaTime, rate;
      if (f.version === 1) {
        segDur = br.u64at(p); mediaTime = br.u64at(p + 8); rate = br.u32at(p + 16) / 65536; p += 20;
      } else {
        segDur = br.u32at(p); mediaTime = br.u32at(p + 4) | 0; rate = br.u32at(p + 8) / 65536; p += 12;
      }
      entries.push({ segmentDuration: segDur, mediaTime: mediaTime, mediaRate: rate });
      if (i < MAX_FIELD_ROWS) {
        MA.nodeField(node, 'entry[' + i + '].segment_duration', String(segDur), p - (f.version === 1 ? 20 : 12), f.version === 1 ? 8 : 4);
        MA.nodeField(node, 'entry[' + i + '].media_time', String(mediaTime), p - (f.version === 1 ? 12 : 8), f.version === 1 ? 8 : 4);
      }
    }
    if (count > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (count - MAX_FIELD_ROWS) + ' more entries');
    if (tk) tk.elst = entries;
  }

  /** dref — a FullBox whose payload is entry_count followed by child boxes. */
  function parseDref(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var count = entryCount(br.u32at(ps + 4), ps, pe, 8, node, 'entry_count');
    MA.nodeField(node, 'entry_count', count, ps + 4, 4);
    var prevTrak = P.trak;
    P.trak = null;                       // url/urn entries belong to no track
    node.children = walkBoxes(br, ps + 8, pe, 0, P, [], 'dref');
    P.trak = prevTrak;
  }

  /** iinf — entry_count (16 or 32 bit) followed by infe boxes. */
  function parseIinf(br, node, ps, pe, P, depth) {
    var f = readFull(br, ps, node);
    var entrySize = f.version < 1 ? 2 : 4;
    var count = entrySize === 2 ? br.u16at(ps + 4) : br.u32at(ps + 4);
    count = entryCount(count, ps, pe, 8, node, 'entry_count');
    MA.nodeField(node, 'entry_count', count, ps + 4, entrySize);
    var prevTrak = P.trak;
    P.trak = null;
    node.children = walkBoxes(br, ps + 4 + entrySize, pe, depth + 1, P, [], 'iinf');
    P.trak = prevTrak;
  }

  /* ------------------------------------------------------- sample tables */

  function parseStts(br, node, ps, pe, tk) {
    readFull(br, ps, node);
    var n = entryCount(br.u32at(ps + 4), ps, pe, 8, node, 'entry_count');
    MA.nodeField(node, 'entry_count', n, ps + 4, 4);
    var p = ps + 8, arr = [], total = 0, guard = 0;
    for (var i = 0; i < n; i++) {
      var count = br.u32at(p), delta = br.u32at(p + 4);
      arr.push([count, delta]);
      total += count;
      if (i < MAX_FIELD_ROWS) {
        MA.nodeField(node, 'entry[' + i + '].sample_count', count, p, 4);
        MA.nodeField(node, 'entry[' + i + '].sample_delta', delta, p + 4, 4);
      }
      p += 8;
      if (++guard > 2000000) break;
    }
    if (n > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (n - MAX_FIELD_ROWS) + ' more entries');
    if (tk) { tk.samples.stts = arr; tk.samples.sttsTotal = total; }
  }

  function parseCtts(br, node, ps, pe, tk) {
    var f = readFull(br, ps, node);
    var n = entryCount(br.u32at(ps + 4), ps, pe, 8, node, 'entry_count');
    MA.nodeField(node, 'entry_count', n, ps + 4, 4);
    var p = ps + 8, arr = [];
    for (var i = 0; i < n; i++) {
      var count = br.u32at(p);
      var off = f.version === 0 ? br.u32at(p + 4) : (br.u32at(p + 4) | 0);
      arr.push([count, off]);
      if (i < MAX_FIELD_ROWS) {
        MA.nodeField(node, 'entry[' + i + '].sample_count', count, p, 4);
        MA.nodeField(node, 'entry[' + i + '].sample_offset', off, p + 4, 4);
      }
      p += 8;
    }
    if (n > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (n - MAX_FIELD_ROWS) + ' more entries');
    if (tk) tk.samples.ctts = arr;
  }

  function parseStsc(br, node, ps, pe, tk) {
    readFull(br, ps, node);
    var n = entryCount(br.u32at(ps + 4), ps, pe, 12, node, 'entry_count');
    MA.nodeField(node, 'entry_count', n, ps + 4, 4);
    var p = ps + 8, arr = [];
    for (var i = 0; i < n; i++) {
      var fc = br.u32at(p), spc = br.u32at(p + 4), sdi = br.u32at(p + 8);
      arr.push([fc, spc, sdi]);
      if (i < MAX_FIELD_ROWS) {
        MA.nodeField(node, 'entry[' + i + '].first_chunk', fc, p, 4);
        MA.nodeField(node, 'entry[' + i + '].samples_per_chunk', spc, p + 4, 4);
        MA.nodeField(node, 'entry[' + i + '].sample_description_index', sdi, p + 8, 4);
      }
      p += 12;
    }
    if (n > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (n - MAX_FIELD_ROWS) + ' more entries');
    if (tk) tk.samples.stsc = arr;
  }

  function parseStsz(br, node, ps, pe, tk, compact) {
    readFull(br, ps, node);
    if (compact) {
      MA.nodeField(node, 'reserved', br.u8at(ps + 4), ps + 4, 1);
      var fieldSize = br.u8at(ps + 5);
      MA.nodeField(node, 'field_size', fieldSize, ps + 5, 1);
      var nC = entryCount(br.u32at(ps + 6), ps, pe, Math.max(1, Math.ceil(fieldSize / 8)), node, 'sample_count');
      MA.nodeField(node, 'sample_count', nC, ps + 6, 4);
      var sizesC = [], acc = 0, bits = 0, pC = ps + 10, guardC = 0;
      while (sizesC.length < nC && pC < pe && ++guardC < 4000000) {
        acc = acc * 256 + br.u8at(pC++); bits += 8;
        while (bits >= fieldSize && sizesC.length < nC) {
          sizesC.push(Math.floor(acc / Math.pow(2, bits - fieldSize)) % Math.pow(2, fieldSize));
          bits -= fieldSize;
          acc = acc % Math.pow(2, bits);
        }
      }
      if (tk) tk.samples.sizes = sizesC;
      MA.nodeField(node, 'sample size entries', sizesC.slice(0, MAX_FIELD_ROWS).join(', '), ps + 10, Math.max(0, pC - ps - 10));
      if (sizesC.length > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (sizesC.length - MAX_FIELD_ROWS) + ' more entries');
      return;
    }
    var uniform = br.u32at(ps + 4);
    var n = entryCount(br.u32at(ps + 8), ps, pe, uniform === 0 ? 4 : 0, node, 'sample_count');
    MA.nodeField(node, 'sample_size', uniform === 0 ? '0 (per-sample table follows)' : uniform, ps + 4, 4);
    MA.nodeField(node, 'sample_count', n, ps + 8, 4);
    if (uniform !== 0) {
      if (tk) tk.samples.sizes = new Array(n).fill(uniform);
      return;
    }
    var sizes = new Array(n);
    for (var i = 0; i < n; i++) sizes[i] = br.u32at(ps + 12 + i * 4);
    if (tk) tk.samples.sizes = sizes;
    MA.nodeField(node, 'entry_size (first ' + Math.min(n, MAX_FIELD_ROWS) + ')',
                 sizes.slice(0, MAX_FIELD_ROWS).join(', '), ps + 12, Math.min(n, MAX_FIELD_ROWS) * 4);
    if (n > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (n - MAX_FIELD_ROWS) + ' more entries');
  }

  function parseChunkOffsets(br, node, ps, pe, tk, wide) {
    readFull(br, ps, node);
    var n = entryCount(br.u32at(ps + 4), ps, pe, wide ? 8 : 4, node, 'entry_count');
    MA.nodeField(node, 'entry_count', n, ps + 4, 4);
    var arr = new Array(n), p = ps + 8;
    for (var i = 0; i < n; i++) {
      arr[i] = wide ? br.u64at(p) : br.u32at(p);
      if (i < MAX_FIELD_ROWS) MA.nodeField(node, 'chunk_offset[' + i + ']', MA.hex(arr[i], 8), p, wide ? 8 : 4);
      p += wide ? 8 : 4;
    }
    if (n > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (n - MAX_FIELD_ROWS) + ' more entries');
    if (tk) tk.samples.chunkOffsets = arr;
  }

  function parseStss(br, node, ps, pe, tk) {
    readFull(br, ps, node);
    var n = entryCount(br.u32at(ps + 4), ps, pe, 4, node, 'entry_count');
    MA.nodeField(node, 'entry_count', n, ps + 4, 4);
    var set = {}, p = ps + 8;
    for (var i = 0; i < n; i++) {
      var v = br.u32at(p);
      set[v] = 1;
      if (i < MAX_FIELD_ROWS) MA.nodeField(node, 'sample_number[' + i + '] (1-based)', v, p, 4);
      p += 4;
    }
    if (n > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (n - MAX_FIELD_ROWS) + ' more entries');
    if (tk) tk.samples.stss = set;
  }

  function parseStsh(br, node, ps, pe) {
    readFull(br, ps, node);
    var n = entryCount(br.u32at(ps + 4), ps, pe, 8, node, 'entry_count');
    MA.nodeField(node, 'entry_count', n, ps + 4, 4);
    for (var i = 0; i < Math.min(n, MAX_FIELD_ROWS); i++) {
      MA.nodeField(node, 'entry[' + i + '].sync_sample_number', br.u32at(ps + 8 + i * 8), ps + 8 + i * 8, 4);
    }
  }

  function parseSdtp(br, node, ps, pe, tk) {
    readFull(br, ps, node);
    var n = Math.min(pe - ps - 4, MAX_FIELD_ROWS);
    MA.nodeField(node, 'sample_count (from stsz)', pe - ps - 4, ps + 4, Math.max(0, pe - ps - 4));
    var isLeading = [], dependsOn = [], isDependedOn = [], hasRedundancy = [];
    for (var i = 0; i < n; i++) {
      var b = br.u8at(ps + 4 + i);
      isLeading.push((b >> 6) & 3);
      dependsOn.push((b >> 4) & 3);
      isDependedOn.push((b >> 2) & 3);
      hasRedundancy.push(b & 3);
    }
    if (n) {
      MA.nodeField(node, 'sample_depends_on (first ' + n + ')', dependsOn.join(','), ps + 4, n);
    }
    if (tk) tk.samples.sdtp = { isLeading: isLeading, dependsOn: dependsOn,
                                isDependedOn: isDependedOn, hasRedundancy: hasRedundancy };
  }

  /* ------------------------------------------------------- sample entries */

  function annotateStsd(br, node, ps, pe, P, depth) {
    readFull(br, ps, node);
    var count = entryCount(br.u32at(ps + 4), ps, pe, 8, node, 'entry_count');
    MA.nodeField(node, 'entry_count', count, ps + 4, 4);
    node.children = [];
    var q = ps + 8;

    for (var i = 0; i < count && q + 8 <= pe; i++) {
      var entryStart = q;
      var entrySize = br.u32at(q);
      var entryType = br.fourcc(q + 4);
      if (entrySize < 8 || entryStart + entrySize > pe) break;
      var entryEnd = entryStart + entrySize;

      var en = MA.makeNode('entry', entryType,
        (CODEC_NAME[entryType] || entryType) + ' SampleEntry', entryStart, entrySize);
      MA.nodeField(en, 'size', entrySize + ' B', entryStart, 4);
      MA.nodeField(en, 'type', "'" + entryType + "'", entryStart + 4, 4);

      var p = entryStart + 8;
      var tk = P.trak;

      if (VISUAL_ENTRIES[entryType] || IMAGE_ENTRIES[entryType]) {
        p += 6;
        MA.nodeField(en, 'data_reference_index', br.u16at(p), p, 2); p += 2;
        p += 16;                                   // pre_defined / reserved
        var width = br.u16at(p), height = br.u16at(p + 2);
        MA.nodeField(en, 'width', width, p, 2);
        MA.nodeField(en, 'height', height, p + 2, 2);
        p += 4;
        MA.nodeField(en, 'horizresolution', (br.u32at(p) / 65536).toFixed(2) + ' dpi', p, 4); p += 4;
        MA.nodeField(en, 'vertresolution', (br.u32at(p) / 65536).toFixed(2) + ' dpi', p, 4); p += 4;
        p += 4;                                    // reserved
        MA.nodeField(en, 'frame_count', br.u16at(p), p, 2); p += 2;
        var compressor = readCString(br.u8, p, p + 32);
        MA.nodeField(en, 'compressorname', compressor || '(empty)', p, 32); p += 32;
        MA.nodeField(en, 'depth', '0x' + MA.pad(br.u16at(p).toString(16), 4, '0'), p, 2); p += 2;
        MA.nodeField(en, 'pre_defined', br.u16at(p), p, 2); p += 2;

        if (tk) {
          tk.config.codecType = tk.config.codecType || entryType;
          tk.config.width = width; tk.config.height = height;
          tk.config.compressor = compressor;
          tk.config.kind = 'video';
        }
      } else if (AUDIO_ENTRIES[entryType]) {
        p += 6;
        MA.nodeField(en, 'data_reference_index', br.u16at(p), p, 2); p += 2;
        p += 8;                                    // reserved
        var channels = br.u16at(p);
        var sampleSize = br.u16at(p + 2);
        MA.nodeField(en, 'channelcount', channels, p, 2);
        MA.nodeField(en, 'samplesize', sampleSize + ' bits', p + 2, 2);
        p += 4;
        p += 4;                                    // pre_defined + reserved
        var rate = br.u32at(p) / 65536;
        MA.nodeField(en, 'samplerate', MA.formatHz(rate), p, 4); p += 4;

        // QuickTime sound descriptions (version 1/2) insert extra fields before
        // the child boxes. In plain ISO BMFF the very next bytes are already a
        // box header, so only take the QuickTime branch when they are not —
        // otherwise the esds box size gets eaten as a "samplesPerPacket".
        var nextSize = br.u32at(p);
        var nextType = br.fourcc(p + 4);
        var looksLikeBox = nextSize >= 8 && p + nextSize <= entryEnd &&
                           /^[\x20-\x7e]{4}$/.test(nextType);
        if (entryType === 'mp4a' && !looksLikeBox && p + 16 <= entryEnd) {
          var qtVersion = br.u16at(p);
          if (qtVersion === 1) {
            MA.nodeField(en, 'samplesPerPacket', br.u32at(p + 4), p + 4, 4);
            MA.nodeField(en, 'bytesPerPacket', br.u32at(p + 8), p + 8, 4);
            MA.nodeField(en, 'bytesPerFrame', br.u32at(p + 12), p + 12, 4);
            MA.nodeField(en, 'bytesPerSample', br.u32at(p + 16), p + 16, 4);
            p += 20;
          } else if (qtVersion === 2) {
            MA.nodeField(en, 'version', 2, p, 2);
            MA.nodeField(en, 'sizeOfStructOnly', br.u32at(p + 4), p + 4, 4);
            MA.nodeField(en, 'audioSampleRate', br.u64at(p + 8) / 65536, p + 8, 8);
            p += 36;
            if (p + 20 <= entryEnd) p += 20;      // channel layout / reserved tail
          }
        }
        if (tk) {
          tk.config.codecType = tk.config.codecType || entryType;
          tk.config.channels = channels;
          tk.config.sampleSize = sampleSize;
          tk.config.sampleRate = rate;
          tk.config.kind = 'audio';
        }
      } else {
        p += 6;
        MA.nodeField(en, 'data_reference_index', br.u16at(p), p, 2); p += 2;
        if (SUBTITLE_ENTRIES[entryType] && p + 8 <= entryEnd) {
          MA.nodeField(en, 'reserved', br.u32at(p), p, 4); p += 4;
          MA.nodeField(en, 'reserved', br.u32at(p), p, 4); p += 4;
        }
        if (tk) {
          tk.config.codecType = tk.config.codecType || entryType;
          tk.config.kind = SUBTITLE_ENTRIES[entryType] ? 'subtitle' : 'other';
        }
      }

      // Child boxes of the sample entry (avcC, hvcC, esds, pasp, colr, sinf …)
      if (p + 8 <= entryEnd) {
        en.children = walkBoxes(br, p, entryEnd, depth + 1, P, [], entryType);
      }
      if (tk) tk.stsdNode = en;
      node.children.push(en);
      q = entryStart + entrySize;
    }
  }

  /* ---------------------------------------------- codec configuration boxes */

  function parseAvcC(br, node, ps, pe, tk, P) {
    var codec = MA.getCodec('h264');
    br.seek(ps);                       // parseAVCC reads from the cursor
    var cfg = codec ? codec.parseAVCC(br, pe, ps) : null;
    if (!cfg) { MA.nodeNote(node, 'H.264 codec module unavailable'); return; }
    cfg.table.rows.forEach(function (r) {
      MA.nodeField(node, r.name, String(r.value), r.offset || ps, 0);
    });
    node._tables = [cfg.table].concat(cfg.spsTables || [], cfg.ppsTables || []);
    if (tk) {
      tk.config.codecId = 'h264';
      tk.config.kind = 'video';
      tk.config.avcc = {
        lengthSize: cfg.lengthSize,
        ctx: codec.ctxFromAVCC(cfg),
        tables: node._tables
      };
      Object.assign(tk.config, {
        width: cfg.info.width || tk.config.width,
        height: cfg.info.height || tk.config.height,
        profile: cfg.info.profile,
        level: cfg.info.level,
        fps: cfg.info.fps
      });
    }
  }

  function parseHvcC(br, node, ps, pe, tk, P) {
    var codec = MA.getCodec('h265');
    if (!codec || !codec.parseHVCC) {
      MA.nodeNote(node, 'HEVC configuration record (' + (pe - ps) + ' bytes) — codec module unavailable');
      if (tk) { tk.config.codecId = 'h265'; tk.config.kind = 'video'; }
      return;
    }
    br.seek(ps);
    var cfg = codec.parseHVCC(br, pe, ps);
    (cfg.table ? cfg.table.rows : []).forEach(function (r) {
      MA.nodeField(node, r.name, String(r.value), r.offset || ps, 0);
    });
    node._tables = [cfg.table].concat(cfg.spsTables || [], cfg.ppsTables || [], cfg.vpsTables || []);
    // HEIF image items reference this record through ipma; keep the parsed
    // config on the node so the item can build a codec context for its data.
    if (!tk) {
      node._codecCfg = { codecId: 'h265', lengthSize: cfg.lengthSize,
                         ctx: codec.ctxFromConfig ? codec.ctxFromConfig(cfg) : {},
                         tables: node._tables, info: cfg.info };
    }
    if (tk) {
      tk.config.codecId = 'h265';
      tk.config.kind = 'video';
      tk.config.hvcc = { lengthSize: cfg.lengthSize, ctx: codec.ctxFromConfig ? codec.ctxFromConfig(cfg) : {}, tables: node._tables };
      if (cfg.info) Object.assign(tk.config, {
        width: cfg.info.width || tk.config.width,
        height: cfg.info.height || tk.config.height,
        profile: cfg.info.profile,
        level: cfg.info.level
      });
    }
  }

  function parseVvcC(br, node, ps, pe, tk, P) {
    var codec = MA.getCodec('h266');
    if (!codec || !codec.parseVVCC) {
      MA.nodeNote(node, 'VVC configuration record (' + (pe - ps) + ' bytes) — codec module unavailable');
      if (tk) { tk.config.codecId = 'h266'; tk.config.kind = 'video'; }
      return;
    }
    br.seek(ps);
    var cfg = codec.parseVVCC(br, pe, ps);
    (cfg.table ? cfg.table.rows : []).forEach(function (r) {
      MA.nodeField(node, r.name, String(r.value), r.offset || ps, 0);
    });
    node._tables = [cfg.table].concat(cfg.spsTables || [], cfg.ppsTables || [], cfg.vpsTables || []);
    if (tk) {
      tk.config.codecId = 'h266';
      tk.config.kind = 'video';
      tk.config.vvcc = { lengthSize: cfg.lengthSize, ctx: codec.ctxFromConfig ? codec.ctxFromConfig(cfg) : {}, tables: node._tables };
      // Only adopt SPS-derived dimensions when they are plausible — a config
      // record whose PTL block this build cannot navigate (e.g. the draft
      // layout in h266.mp4) can leave the SPS reader misaligned and reporting
      // a nonsense size, which must not override the container's tkhd values.
      if (cfg.info && cfg.info.width > 0 && cfg.info.height > 0) Object.assign(tk.config, {
        width: cfg.info.width, height: cfg.info.height
      });
    }
  }

  function parseAv1C(br, node, ps, pe, tk, P) {
    br.seek(ps);
    var b0 = br.u8at(ps), b1 = br.u8at(ps + 1), b2 = br.u8at(ps + 2), b3 = br.u8at(ps + 3);
    MA.nodeField(node, 'marker', (b0 >> 7) & 1, ps, 1);
    MA.nodeField(node, 'version', b0 & 0x7f, ps, 1);
    var profile = (b1 >> 5) & 7, level = b1 & 0x1f;
    MA.nodeField(node, 'seq_profile', profile, ps + 1, 1);
    MA.nodeField(node, 'seq_level_idx_0', level, ps + 1, 1);
    MA.nodeField(node, 'seq_tier_0', (b2 >> 7) & 1, ps + 2, 1);
    var highBitdepth = (b2 >> 6) & 1, twelveBit = (b2 >> 5) & 1, mono = (b2 >> 4) & 1;
    MA.nodeField(node, 'high_bitdepth', highBitdepth, ps + 2, 1);
    MA.nodeField(node, 'twelve_bit', twelveBit, ps + 2, 1);
    MA.nodeField(node, 'monochrome', mono, ps + 2, 1);
    var subX = (b2 >> 3) & 1, subY = (b2 >> 2) & 1;
    MA.nodeField(node, 'chroma_subsampling_x', subX, ps + 2, 1);
    MA.nodeField(node, 'chroma_subsampling_y', subY, ps + 2, 1);
    MA.nodeField(node, 'chroma_sample_position', b2 & 3, ps + 2, 1);
    MA.nodeField(node, 'initial_presentation_delay_present', (b3 >> 4) & 1, ps + 3, 1);
    if (!tk) {
      node._codecCfg = { codecId: 'av1', lengthSize: 4, ctx: null, tables: null,
                         info: { profile: 'Profile ' + profile, level: 'Level ' + level } };
    }
    if (tk) {
      tk.config.codecId = 'av1'; tk.config.kind = 'video';
      tk.config.profile = 'Profile ' + profile; tk.config.level = 'Level ' + level;
      tk.config.bitDepth = twelveBit ? 12 : (highBitdepth ? 10 : 8);
      var codec = MA.getCodec('av1');
      tk.config.config = codec && codec.parseAv1C ? codec.parseAv1C(br, pe, ps) : null;
    }
  }

  function parseVpcC(br, node, ps, pe, tk, P) {
    var vf = br.u32at(ps);
    var version = vf >>> 24;
    MA.nodeField(node, 'version', version, ps, 1);
    MA.nodeField(node, 'profile', br.u8at(ps + 4), ps + 4, 1);
    MA.nodeField(node, 'level', br.u8at(ps + 5), ps + 5, 1);
    var bits = br.u8at(ps + 6);
    MA.nodeField(node, 'bit_depth (luma)', (bits >> 4) & 0xf, ps + 6, 1);
    MA.nodeField(node, 'bit_depth (chroma)', bits & 0xf, ps + 6, 1);
    MA.nodeField(node, 'chroma_subsampling', br.u8at(ps + 7), ps + 7, 1);
    MA.nodeField(node, 'video_full_range_flag', br.u8at(ps + 8), ps + 8, 1);
    MA.nodeField(node, 'colour_primaries', br.u8at(ps + 9), ps + 9, 1);
    MA.nodeField(node, 'transfer_characteristics', br.u8at(ps + 10), ps + 10, 1);
    MA.nodeField(node, 'matrix_coefficients', br.u8at(ps + 11), ps + 11, 1);
    if (pe > ps + 12) MA.nodeField(node, 'codec_initialization_data_size', br.u16at(ps + 12), ps + 12, 2);
    if (tk) {
      tk.config.kind = 'video';
      tk.config.bitDepth = (bits >> 4) & 0xf;
      tk.config.profile = 'Profile ' + br.u8at(ps + 4);
      tk.config.level = 'Level ' + br.u8at(ps + 5);
    }
  }

  function parseEsds(br, node, ps, pe, tk, P) {
    readFull(br, ps, node);
    var data = br.u8;
    var TAG_NAMES = {
      0x03: 'ES_Descriptor', 0x04: 'DecoderConfigDescriptor',
      0x05: 'DecoderSpecificInfo', 0x06: 'SLConfigDescriptor',
      0x0e: 'ES_ID_Inc', 0x0f: 'ES_ID_Ref'
    };
    var OTI_NAMES = {
      0x20: 'MPEG-4 Visual', 0x21: 'H.264/AVC', 0x23: 'H.265/HEVC',
      0x40: 'MPEG-4 Audio (AAC)', 0x66: 'MPEG-2 AAC Main', 0x67: 'MPEG-2 AAC LC',
      0x68: 'MPEG-2 AAC SSR', 0x69: 'MPEG-2 Audio', 0x6b: 'MPEG-1 Audio',
      0x6c: 'JPEG', 0x6d: 'PNG', 0x6e: 'JPEG2000', 0xa3: 'Vorbis', 0xa5: 'AC-3',
      0xa6: 'E-AC-3', 0xa9: 'DTS', 0xad: 'Opus', 0xa1: 'FLAC'
    };

    /* MPEG-4 descriptors nest: ES_Descriptor holds DecoderConfigDescriptor,
     * which in turn holds DecoderSpecificInfo. A flat walk stops after the
     * outer descriptor's declared length, so the walk recurses into each
     * descriptor's payload once its fixed header fields are consumed. */
    function walkDescriptors(p, end, depth, oti) {
      var guard = 0;
      while (p < end && ++guard < 32) {
        var tag = data[p++];
        if (tag === 0 || tag === 0xff) break;
        var len = 0, b, sh = 0;
        do { b = data[p++]; len = (len << 7) | (b & 0x7f); sh += 7; } while ((b & 0x80) && sh < 28 && p < end);
        var dStart = p;
        var dEnd = Math.min(dStart + len, end);
        var tagName = TAG_NAMES[tag] || ('descriptor 0x' + tag.toString(16));
        MA.nodeField(node, tagName + '.length', len, p - (sh / 7 + 1), sh / 7 + 1);

        if (tag === 0x03 && dStart + 3 <= dEnd) {
          var esFlags = data[dStart + 2];
          MA.nodeField(node, 'ES_ID', (data[dStart] << 8) | data[dStart + 1], dStart, 2);
          MA.nodeField(node, 'streamDependenceFlag', (esFlags >> 7) & 1, dStart + 2, 1);
          MA.nodeField(node, 'URL_Flag', (esFlags >> 6) & 1, dStart + 2, 1);
          MA.nodeField(node, 'OCRstreamFlag', (esFlags >> 5) & 1, dStart + 2, 1);
          MA.nodeField(node, 'streamPriority', esFlags & 0x1f, dStart + 2, 1);
          var child = dStart + 3;
          if (esFlags & 0x80) child += 1;                              // dependsOn_ES_ID
          if (esFlags & 0x40 && child < dEnd) child += 1 + data[child]; // URL string
          if (esFlags & 0x20) child += 2;                              // OCR_ES_ID
          if (child < dEnd) walkDescriptors(child, dEnd, depth + 1, oti);
        } else if (tag === 0x04 && dStart + 13 <= dEnd) {
          oti = data[dStart];
          MA.nodeField(node, 'objectTypeIndication', '0x' + MA.pad(oti.toString(16), 2, '0') +
                      ' (' + (OTI_NAMES[oti] || 'unknown') + ')', dStart, 1);
          var st = data[dStart + 1] >> 2;
          MA.nodeField(node, 'streamType', st + (st === 5 ? ' (visual)' : st === 4 ? ' (audio)' : st === 3 ? ' (scene)' : ''), dStart + 1, 1);
          MA.nodeField(node, 'upStream', (data[dStart + 1] >> 1) & 1, dStart + 1, 1);
          MA.nodeField(node, 'bufferSizeDB', (data[dStart + 2] << 16) | (data[dStart + 3] << 8) | data[dStart + 4], dStart + 2, 3);
          var maxBr = ((data[dStart + 5] << 24) | (data[dStart + 6] << 16) | (data[dStart + 7] << 8) | data[dStart + 8]) >>> 0;
          var avgBr = ((data[dStart + 9] << 24) | (data[dStart + 10] << 16) | (data[dStart + 11] << 8) | data[dStart + 12]) >>> 0;
          MA.nodeField(node, 'maxBitrate', maxBr + ' bps', dStart + 5, 4);
          MA.nodeField(node, 'avgBitrate', avgBr + ' bps', dStart + 9, 4);
          if (tk) { tk.config.maxBitrate = maxBr; tk.config.avgBitrate = avgBr; }
          if (dStart + 13 < dEnd) walkDescriptors(dStart + 13, dEnd, depth + 1, oti);
        } else if (tag === 0x05) {
          if (oti === 0x20 || (tk && tk.config.codecId === 'mpeg4')) {
            /* MPEG-4 Visual: the DecoderSpecificInfo holds the start-code units
             * the decoder would otherwise see in-band — VOS (0xB0, profile and
             * level) and the VOL (0x20-0x2F, geometry + timing). Mining the VOL
             * here lets later VOP headers size their time_increment field. */
            var m4 = MA.getCodec('mpeg4');
            if (m4 && m4.parseVOL) {
              var dsi = data.subarray(dStart, dEnd);
              var units = MA.annexBUnits(dsi, dsi.length);
              var mined = false;
              for (var ui = 0; ui < units.length; ui++) {
                var ucode = dsi[units[ui].start];
                var ubase = dStart + units[ui].start;
                try {
                  if (ucode >= 0x20 && ucode <= 0x2F) {
                    var vol = m4.parseVOL(dsi.subarray(units[ui].start + 1, units[ui].end), ubase + 1);
                    vol.tables[0].rows.forEach(function (r) {
                      MA.nodeField(node, 'DecoderSpecificInfo.' + r.name, String(r.value),
                                   r.offset != null ? r.offset : ubase, 0);
                    });
                    node._tables = (node._tables || []).concat(vol.tables);
                    if (tk) {
                      if (!tk.config.ctx) tk.config.ctx = {};
                      tk.config.ctx.vol = vol.info;
                      if (vol.info.width) {
                        tk.config.width = tk.config.width || vol.info.width;
                        tk.config.height = tk.config.height || vol.info.height;
                      }
                    }
                    mined = true;
                  } else if (ucode === 0xB0 && units[ui].start + 1 < units[ui].end) {
                    var palByte = dsi[units[ui].start + 1];
                    var palText = m4.palName ? m4.palName(palByte) : ('0x' + MA.pad(palByte.toString(16), 2, '0'));
                    MA.nodeField(node, 'DecoderSpecificInfo.profile_and_level_indication', palText, ubase + 1, 1);
                    if (tk) tk.config.profile = tk.config.profile || palText;
                    mined = true;
                  }
                } catch (e) { /* a damaged descriptor must not abort the box parse */ }
              }
              if (!mined) MA.nodeField(node, 'DecoderSpecificInfo', len + ' bytes', dStart, len);
            } else {
              MA.nodeField(node, 'DecoderSpecificInfo', len + ' bytes (codec module unavailable)', dStart, len);
            }
          } else {
            var aac = MA.getCodec('aac');
            if (aac && aac.parseAudioSpecificConfig) {
              var asc = aac.parseAudioSpecificConfig(data, dStart, len);
              asc.table.rows.forEach(function (r) {
                MA.nodeField(node, 'AudioSpecificConfig.' + r.name, String(r.value), r.offset || dStart, 0);
              });
              node._tables = (node._tables || []).concat([asc.table]);
              if (tk) {
                tk.config.codecId = 'aac';
                tk.config.kind = 'audio';
                tk.config.asc = asc;
                Object.assign(tk.config, {
                  sampleRate: asc.info.sampleRate || tk.config.sampleRate,
                  channels: asc.info.channels || tk.config.channels,
                  profile: asc.info.aotName,
                  codecName: asc.info.aotName
                });
              }
            } else {
              MA.nodeField(node, 'AudioSpecificConfig', len + ' bytes (codec module unavailable)', dStart, len);
            }
          }
        } else if (tag === 0x06 && dStart < dEnd) {
          MA.nodeField(node, 'SLConfigDescriptor.predefined', data[dStart], dStart, 1);
        }
        p = dEnd;
      }
    }
    walkDescriptors(ps + 4, pe, 0, 0);
  }

  /* -------------------------------------------------------------- fragments */

  function parseTfhd(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    var trackId = br.u32at(p);
    MA.nodeField(node, 'track_ID', trackId, p, 4); p += 4;

    var tf = { trackId: trackId, flags: f.flags, sampleCount: 0, runs: [],
               moofOffset: P.moofOffset };
    if (f.flags & 0x000001) { tf.baseDataOffset = br.u64at(p); MA.nodeField(node, 'base_data_offset', String(tf.baseDataOffset), p, 8); p += 8; }
    if (f.flags & 0x000002) { tf.sampleDescriptionIndex = br.u32at(p); MA.nodeField(node, 'sample_description_index', tf.sampleDescriptionIndex, p, 4); p += 4; }
    if (f.flags & 0x000008) { tf.defaultSampleDuration = br.u32at(p); MA.nodeField(node, 'default_sample_duration', tf.defaultSampleDuration, p, 4); p += 4; }
    if (f.flags & 0x000010) { tf.defaultSampleSize = br.u32at(p); MA.nodeField(node, 'default_sample_size', tf.defaultSampleSize, p, 4); p += 4; }
    if (f.flags & 0x000020) { tf.defaultSampleFlags = br.u32at(p); MA.nodeField(node, 'default_sample_flags', '0x' + MA.pad(tf.defaultSampleFlags.toString(16), 8, '0'), p, 4); p += 4; }

    MA.nodeField(node, 'default-base-is-moof', (f.flags & 0x020000) ? 'yes' : 'no', ps + 1, 3);
    MA.nodeField(node, 'duration-is-empty', (f.flags & 0x010000) ? 'yes' : 'no', ps + 1, 3);

    // A moof is a *top-level* box, so by the time it is walked P.trak has
    // already been restored to null. Resolve the traf against the moov track
    // carrying the same track_ID.
    var fragTrak = null;
    for (var ti = 0; ti < P.traks.length; ti++) {
      if (P.traks[ti].tkhd && P.traks[ti].tkhd.id === trackId) { fragTrak = P.traks[ti]; break; }
    }
    P.fragmentTrak = fragTrak;
    if (fragTrak) fragTrak.tfhd = tf;
    if (P.trak) P.trak.tfhd = tf;
    P.currentTfhd = tf;
  }

  function parseTrun(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    var sampleCount = br.u32at(p);
    MA.nodeField(node, 'sample_count', sampleCount, p, 4); p += 4;

    var run = { sampleCount: sampleCount, flags: f.flags, version: f.version, samples: [] };
    if (f.flags & 0x000001) { run.dataOffset = br.u32at(p) | 0; MA.nodeField(node, 'data_offset', run.dataOffset, p, 4); p += 4; }
    if (f.flags & 0x000004) { run.firstSampleFlags = br.u32at(p); MA.nodeField(node, 'first_sample_flags', '0x' + MA.pad(run.firstSampleFlags.toString(16), 8, '0'), p, 4); p += 4; }

    // Each sample record is at most 16 bytes; bound the loop by the box size.
    var perSample = ((f.flags & 0x000100) ? 4 : 0) + ((f.flags & 0x000200) ? 4 : 0) +
                    ((f.flags & 0x000400) ? 4 : 0) + ((f.flags & 0x000800) ? 4 : 0);
    var maxSamples = perSample > 0 ? Math.floor((pe - p) / perSample) : sampleCount;
    var n = Math.min(sampleCount, Math.max(0, maxSamples));
    if (n < sampleCount) {
      MA.nodeField(node, 'sample_count (rejected: exceeds box size)', sampleCount + ' > max ' + n, ps + 4, 4);
    }
    var rowLimit = Math.min(n, MAX_FIELD_ROWS);
    for (var i = 0; i < n; i++) {
      var s = {};
      if (f.flags & 0x000100) { s.duration = br.u32at(p); p += 4; }
      if (f.flags & 0x000200) { s.size = br.u32at(p); p += 4; }
      if (f.flags & 0x000400) { s.flags = br.u32at(p); p += 4; }
      if (f.flags & 0x000800) {
        s.ctts = f.version === 0 ? br.u32at(p) : (br.u32at(p) | 0);
        p += 4;
      }
      run.samples.push(s);
      if (i < rowLimit) {
        var desc = [];
        if (s.duration != null) desc.push('dur=' + s.duration);
        if (s.size != null) desc.push('size=' + s.size);
        if (s.flags != null) desc.push('flags=0x' + MA.pad(s.flags.toString(16), 8, '0'));
        if (s.ctts != null) desc.push('ctts=' + s.ctts);
        MA.nodeField(node, 'sample[' + i + ']', desc.join(' '), ps + 8, 0);
      }
    }
    if (n > rowLimit) MA.nodeNote(node, '… ' + (n - rowLimit) + ' more samples');

    if (P.currentTfhd) P.currentTfhd.runs.push(run);
    var runTrak = P.fragmentTrak || P.trak;
    if (runTrak) {
      runTrak.truns = runTrak.truns || [];
      runTrak.truns.push({ tfhd: P.currentTfhd, run: run });
    }
  }

  function parseTrex(br, node, ps, pe, P) {
    readFull(br, ps, node);
    var trackId = br.u32at(ps + 4);
    MA.nodeField(node, 'track_ID', trackId, ps + 4, 4);
    MA.nodeField(node, 'default_sample_description_index', br.u32at(ps + 8), ps + 8, 4);
    var duration = br.u32at(ps + 12);
    MA.nodeField(node, 'default_sample_duration', duration, ps + 12, 4);
    var size = br.u32at(ps + 16);
    MA.nodeField(node, 'default_sample_size', size, ps + 16, 4);
    var flags = br.u32at(ps + 20);
    MA.nodeField(node, 'default_sample_flags', '0x' + MA.pad(flags.toString(16), 8, '0'), ps + 20, 4);
    P.trex[trackId] = { duration: duration, size: size, flags: flags,
                        descriptionIndex: br.u32at(ps + 8) };
  }

  function parseSidx(br, node, ps, pe) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    MA.nodeField(node, 'reference_ID', br.u32at(p), p, 4); p += 4;
    MA.nodeField(node, 'timescale', br.u32at(p), p, 4);
    var timescale = br.u32at(p); p += 4;
    var ept = f.version === 0 ? br.u32at(p) : br.u64at(p);
    MA.nodeField(node, 'earliest_presentation_time', String(ept), p, f.version === 0 ? 4 : 8);
    p += f.version === 0 ? 4 : 8;
    MA.nodeField(node, 'first_offset', String(f.version === 0 ? br.u32at(p) : br.u64at(p)), p, f.version === 0 ? 4 : 8);
    p += f.version === 0 ? 4 : 8;
    p += 2;                                          // reserved
    var count = br.u16at(p);
    MA.nodeField(node, 'reference_count', count, p, 2);
    p += 2;
    for (var i = 0; i < Math.min(count, MAX_FIELD_ROWS) && p + 12 <= pe; i++) {
      var w0 = br.u32at(p);
      var refType = (w0 >> 31) & 1;
      var refSize = w0 & 0x7fffffff;
      var dur = br.u32at(p + 4);
      var w2 = br.u32at(p + 8);
      MA.nodeField(node, 'reference[' + i + ']',
        (refType ? 'index' : 'media') + ', size=' + refSize + ', duration=' + dur +
        ' (' + (timescale ? (dur / timescale).toFixed(3) + ' s' : '') + '), SAP=' +
        (((w2 >> 31) & 1) ? 'yes type ' + ((w2 >> 28) & 7) : 'no'), p, 12);
      p += 12;
    }
    if (count > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (count - MAX_FIELD_ROWS) + ' more references');
  }

  function parseIloc(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var data = br.u8;
    var p = ps + 4;
    var offsetSize = (data[p] >> 4) & 0xf, lengthSize = data[p] & 0xf;
    var baseOffsetSize = (data[p + 1] >> 4) & 0xf, indexSize = (f.version === 1 || f.version === 2) ? (data[p + 1] & 0xf) : 0;
    MA.nodeField(node, 'offset_size', offsetSize, p, 1);
    MA.nodeField(node, 'length_size', lengthSize, p, 1);
    MA.nodeField(node, 'base_offset_size', baseOffsetSize, p + 1, 1);
    if (indexSize) MA.nodeField(node, 'index_size', indexSize, p + 1, 1);
    p += 2;
    var count = f.version < 2 ? br.u16at(p) : br.u32at(p);
    p += f.version < 2 ? 2 : 4;
    MA.nodeField(node, 'item_count', count, ps + 6, f.version < 2 ? 2 : 4);

    P.iloc = P.iloc || {};
    function readSized(n) { var v = 0; for (var i = 0; i < n; i++) v = v * 256 + data[p++]; return v; }

    for (var i = 0; i < Math.min(count, 4096) && p < pe; i++) {
      var itemId = f.version < 2 ? br.u16at(p) : br.u32at(p);
      p += f.version < 2 ? 2 : 4;
      var construction = 0;
      if (f.version === 1 || f.version === 2) { construction = br.u16at(p); p += 2; }  // construction_method
      p += 2;                                              // data_reference_index
      var baseOffset = readSized(baseOffsetSize);
      var extentCount = br.u16at(p); p += 2;
      var extents = [];
      for (var e = 0; e < Math.min(extentCount, 64); e++) {
        if (indexSize) readSized(indexSize);
        var extOffset = readSized(offsetSize);
        var extLen = readSized(lengthSize);
        extents.push({
          // construction_method 1 = offsets are relative to the idat payload.
          offset: construction === 1 && P.idatOffset != null ? P.idatOffset + extOffset
                                                            : baseOffset + extOffset,
          length: extLen
        });
      }
      P.iloc[itemId] = { baseOffset: baseOffset, construction: construction, extents: extents };
      var first = extents[0];
      var cmNote = construction ? ', construction=' + (construction === 1 ? 'idat' : construction) : '';
      if (i < MAX_FIELD_ROWS) MA.nodeField(node, 'item[' + i + ']', 'ID=' + itemId +
        ', base=' + baseOffset + ', offset=' + (first ? first.offset : '?') +
        ', length=' + (first ? first.length : '?') + ', extents=' + extentCount + cmNote, ps, 0);
    }
  }

  function parseInfe(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    var itemId = f.version >= 3 ? br.u32at(p) : br.u16at(p);
    p += f.version >= 3 ? 4 : 2;
    p += 2;                                     // protection_index
    var type = br.fourcc(p); p += 4;
    var name = readCString(br.u8, p, pe);
    MA.nodeField(node, 'item_ID', itemId, ps + 4, f.version >= 3 ? 4 : 2);
    MA.nodeField(node, 'item_type', "'" + type + "'", p - 4, 4);
    MA.nodeField(node, 'item_name', name, p, Math.max(0, Math.min(pe - p, 256)));
    if (f.version >= 2) {
      MA.nodeField(node, 'hidden_item', (f.flags & 1) ? 'yes' : 'no', ps + 1, 3);
    }
    P.items = P.items || {};
    var item = P.items[itemId] || (P.items[itemId] = { type: type, name: name, props: {} });
    item.type = type; item.name = name;
    item.hidden = !!(f.flags & 1);
    if (P.lastIspe) {
      item.props.ispe = P.lastIspe;              // order-based fallback…
      item.props.ispeFromOrder = true;           // …ipma overrides it later
      P.lastIspe = null;
    }
    return true;
  }

  /**
   * ipma — Item Property Association: binds each item to entries of the ipco
   * container by 1-based index. This is what turns a generic list of property
   * boxes (ispe/hvcC/…) into per-image dimensions and codec configs.
   */
  function parseIpma(br, node, ps, pe, P) {
    var f = readFull(br, ps, node);
    var p = ps + 4;
    var count = entryCount(br.u32at(p), p, pe, 2, node, 'entry_count');
    MA.nodeField(node, 'entry_count', count, p, 4);
    p += 4;
    P.ipma = P.ipma || {};
    for (var i = 0; i < count && p < pe; i++) {
      var itemId = f.version < 1 ? br.u16at(p) : br.u32at(p);
      p += f.version < 1 ? 2 : 4;
      var assocCount = br.u8at(p); p++;
      var assocs = [];
      for (var a = 0; a < assocCount && p < pe; a++) {
        if (f.flags & 1) {
          var v = br.u16at(p); p += 2;
          assocs.push({ essential: (v >> 15) & 1, index: v & 0x7fff });
        } else {
          var b = br.u8at(p); p++;
          assocs.push({ essential: (b >> 7) & 1, index: b & 0x7f });
        }
      }
      P.ipma[itemId] = assocs;
      if (i < MAX_FIELD_ROWS) {
        MA.nodeField(node, 'item[' + i + '].item_ID', itemId, ps, 0);
        MA.nodeField(node, 'item[' + i + '].property_indexes',
          assocs.map(function (as) { return as.index + (as.essential ? '!' : ''); }).join(', '), ps, 0);
      }
    }
    if (count > MAX_FIELD_ROWS) MA.nodeNote(node, '… ' + (count - MAX_FIELD_ROWS) + ' more entries');
  }

  /** A child of iref ('thmb', 'cdsc', …): from_item → to_item links. */
  var REF_NAMES = {
    thmb: 'thumbnail', thum: 'thumbnail (deprecated)', cdsc: 'describes',
    auxl: 'auxiliary image', dimg: 'derived image', base: 'base image'
  };

  function parseIrefChild(br, type, node, ps, pe, P) {
    var idSize = (P.irefVersion || 0) >= 1 ? 4 : 2;
    if (pe - ps < idSize + 2) return;
    var from = idSize === 4 ? br.u32at(ps) : br.u16at(ps);
    var count = br.u16at(ps + idSize);
    var to = [];
    var q = ps + idSize + 2;
    for (var i = 0; i < count && q + idSize <= pe; i++) {
      to.push(idSize === 4 ? br.u32at(q) : br.u16at(q));
      q += idSize;
    }
    MA.nodeField(node, 'from_item_ID', from, ps, idSize);
    MA.nodeField(node, 'reference_count', count, ps + idSize, 2);
    MA.nodeField(node, 'to_item_IDs', to.join(', '), ps + idSize + 2, Math.max(0, q - (ps + idSize + 2)));
    node.name = REF_NAMES[type] ? REF_NAMES[type] + ' reference' : node.name;
    P.itemRefs = P.itemRefs || [];
    P.itemRefs.push({ type: type, from: from, to: to });
  }

  /* ======================================================== track building */

  function buildTrack(tk, P, result, data) {
    var cfg = tk.config || {};
    var st = tk.samples || {};
    var mdhd = tk.mdhd || {};
    var tkhd = tk.tkhd || {};
    var timescale = mdhd.timescale || (P.mvhd && P.mvhd.timescale) || 1;
    var handler = tk.hdlr ? tk.hdlr.handler : '';

    var kind = cfg.kind || HANDLER_TYPE[handler] || 'other';
    var fourcc = cfg.codecType || '';
    var map = CODEC_MAP[fourcc] || [null, null];
    if (!cfg.codecId && map[0]) cfg.codecId = map[0];

    // ---- per-sample sizes ----
    var sizes = st.sizes || [];
    var sampleCount = sizes.length || (st.sttsTotal || 0);

    // ---- decode times from stts ----
    var dts = new Float64Array(sampleCount);
    var totalDur = 0, idx = 0, stts = st.stts || [];
    for (var i = 0; i < stts.length && idx < sampleCount; i++) {
      var cnt = stts[i][0], delta = stts[i][1];
      for (var c = 0; c < cnt && idx < sampleCount; c++) { dts[idx++] = totalDur; totalDur += delta; }
    }
    for (; idx < sampleCount; idx++) dts[idx] = totalDur;    // stts shorter than stsz

    // ---- composition offsets from ctts ----
    var ctts = new Float64Array(sampleCount);
    var cttsTable = st.ctts || [];
    if (cttsTable.length) {
      var ci = 0, remaining = cttsTable[0][0];
      for (var j = 0; j < sampleCount; j++) {
        while (remaining <= 0 && ci < cttsTable.length - 1) { ci++; remaining = cttsTable[ci][0]; }
        ctts[j] = cttsTable[ci][1];
        remaining--;
      }
    }

    // ---- sample offsets from stsc + stco ----
    var chunkOffsets = st.chunkOffsets || [];
    var sampleOffsets = new Float64Array(sampleCount);
    var haveOffsets = false;
    if (chunkOffsets.length) {
      var stsc = (st.stsc && st.stsc.length) ? st.stsc : [[1, sampleCount, 1]];
      var si = 0, row = 0;
      for (var ch = 0; ch < chunkOffsets.length && si < sampleCount; ch++) {
        while (row + 1 < stsc.length && (ch + 1) >= stsc[row + 1][0]) row++;
        var perChunk = stsc[row][1];
        var off = chunkOffsets[ch];
        for (var k = 0; k < perChunk && si < sampleCount; k++) {
          sampleOffsets[si] = off;
          off += sizes[si] || 0;
          si++;
          haveOffsets = true;
        }
      }
    }

    var durationSec = mdhd.duration ? mdhd.duration / timescale : totalDur / timescale;
    if (!durationSec && P.mvhd && P.mvhd.timescale) {
      durationSec = tkhd.duration ? tkhd.duration / P.mvhd.timescale : 0;
    }
    var totalBytes = 0;
    for (var b = 0; b < sizes.length; b++) totalBytes += sizes[b];
    var bitrate = cfg.maxBitrate || (durationSec > 0 ? Math.round(totalBytes * 8 / durationSec) : null);

    var codecName = cfg.codecName ||
      (cfg.asc && cfg.asc.info && cfg.asc.info.aotName) ||
      CODEC_NAME[fourcc] || fourcc || 'unknown';

    var track = {
      id: tkhd.id || (tk.index + 1),
      type: kind,
      codec: cfg.codecId || fourcc,
      codecName: codecName,
      profile: cfg.profile || '',
      level: cfg.level || '',
      width: cfg.width || (tkhd.width ? Math.round(tkhd.width) : null),
      height: cfg.height || (tkhd.height ? Math.round(tkhd.height) : null),
      sampleRate: cfg.sampleRate || null,
      channels: cfg.channels || null,
      bitDepth: cfg.bitDepth || cfg.sampleSize || null,
      durationSec: durationSec || null,
      timescale: timescale,
      bitrate: bitrate,
      streamSize: totalBytes || null,
      sampleCount: sampleCount,
      language: mdhd.language || '',
      handlerName: tk.hdlr ? tk.hdlr.name : '',
      fps: (kind === 'video' && durationSec > 0 && sampleCount) ? sampleCount / durationSec : null,
      extra: []
    };
    // tkhd stores the display dimensions (SAR already applied); the decoder
    // config stores the coded ones. The gap is the pixel aspect ratio.
    if (tkhd.width && tkhd.height) {
      track.extra.push({ label: 'Display aspect ratio', value: (tkhd.width / tkhd.height).toFixed(3) });
    }
    if (tkhd.width && cfg.width && Math.abs(tkhd.width - cfg.width) > 0.01) {
      track.extra.push({ label: 'Pixel aspect ratio', value: (tkhd.width / cfg.width).toFixed(3) });
    }
    if (cfg.colour) {
      var col = cfg.colour;
      if (col.primaries != null) track.extra.push({ label: 'Colour primaries', value: COLOUR_PRIMARIES[col.primaries] || ('index ' + col.primaries) });
      if (col.transfer != null) track.extra.push({ label: 'Transfer characteristics', value: COLOUR_TRANSFER[col.transfer] || ('index ' + col.transfer) });
      if (col.matrix != null) track.extra.push({ label: 'Matrix coefficients', value: COLOUR_MATRIX[col.matrix] || ('index ' + col.matrix) });
      if (col.fullRange != null) track.extra.push({ label: 'Colour range', value: col.fullRange ? 'Full' : 'Limited' });
    }
    if (cfg.avcc) track.extra.push({ label: 'NAL length size', value: cfg.avcc.lengthSize + ' bytes' });
    if (cfg.compressor) track.extra.push({ label: 'Compressor', value: cfg.compressor });
    if (tk.elst && tk.elst.length) {
      track.extra.push({ label: 'Edit list', value: tk.elst.length + ' entries' });
    }

    // ---- config/header pseudo frame ----
    var configFrame = null;
    var configTables = (cfg.avcc && cfg.avcc.tables) || (cfg.hvcc && cfg.hvcc.tables) ||
                       (cfg.vvcc && cfg.vvcc.tables) || (cfg.asc ? [cfg.asc.table] : null);
    if (configTables && configTables.length) {
      var cfgNode = findNode(tk.node, ['avcC', 'hvcC', 'vvcC', 'esds', 'av1C', 'vpcC']);
      configFrame = {
        track: track.id, index: 0, type: 'header', kind: 'header',
        codec: track.codec,
        offset: cfgNode ? cfgNode.offset : 0,
        size: cfgNode ? cfgNode.size : 0,
        keyframe: false,
        label: cfgNode ? cfgNode.code : 'DecoderConfigurationRecord',
        tables: configTables
      };
    }

    // ---- sample frames ----
    var cap = Math.min(sampleCount, MAX_FRAMES);
    var ctxKey = null;
    if (cfg.avcc || cfg.hvcc || cfg.vvcc || cfg.asc || cfg.ctx) {
      ctxKey = track.id + ':' + track.codec;
      result.codecContexts[ctxKey] = cfg.avcc ? cfg.avcc.ctx :
                                     cfg.hvcc ? cfg.hvcc.ctx :
                                     cfg.vvcc ? cfg.vvcc.ctx :
                                     cfg.asc ? cfg.asc.info :
                                     cfg.ctx || {};
    }
    var syncSet = st.stss || null;
    var frames = new Array(cap);
    var baseOffset = chunkOffsets.length ? chunkOffsets[0] : 0;

    for (var fi = 0; fi < cap; fi++) {
      var isKey;
      if (syncSet) isKey = !!syncSet[fi + 1];
      else isKey = (fi === 0) || undefined;
      var typeLabel;
      if (kind === 'video') {
        typeLabel = syncSet ? (isKey ? 'I' : 'P/B') : (fi === 0 ? 'I' : '—');
      } else if (kind === 'audio') typeLabel = 'audio';
      else if (kind === 'image') typeLabel = 'image';
      else typeLabel = 'sample';

      var fr = {
        track: track.id,
        index: fi + 1,
        type: typeLabel,
        kind: kind === 'subtitle' ? 'other' : kind,
        codec: track.codec,
        offset: sampleOffsets[fi] || baseOffset,
        size: sizes[fi] || 0,
        dtsSec: dts[fi] / timescale,
        ptsSec: (dts[fi] + ctts[fi]) / timescale,
        durationSec: (dts[fi + 1] != null && fi + 1 < cap ? (dts[fi + 1] - dts[fi]) : (stts.length ? stts[stts.length - 1][1] : 0)) / timescale,
        keyframe: !!isKey
      };

      if (kind === 'video' && (cfg.avcc || cfg.hvcc || cfg.vvcc)) {
        fr.syn = {
          codec: track.codec, kind: 'sample',
          offset: fr.offset, size: fr.size, base: fr.offset,
          lengthSize: (cfg.avcc && cfg.avcc.lengthSize) || (cfg.hvcc && cfg.hvcc.lengthSize) ||
                      (cfg.vvcc && cfg.vvcc.lengthSize) || 4,
          ctxKey: ctxKey
        };
      } else if (kind === 'video' && cfg.codecId === 'mpeg4') {
        // MPEG-4 Visual samples are start-code framed (VOP data), not
        // length-prefixed — the codec module scans the start codes itself.
        fr.syn = { codec: 'mpeg4', kind: 'raw', offset: fr.offset, size: fr.size, base: fr.offset, ctxKey: ctxKey };
      } else if (kind === 'video' && cfg.codecId) {
        fr.syn = { codec: cfg.codecId, kind: 'sample', offset: fr.offset, size: fr.size, base: fr.offset, lengthSize: 4, ctxKey: ctxKey };
      } else if (cfg.asc) {
        // Raw AAC has no per-frame header — hand the ASC to the codec module so
        // it can describe the access unit honestly.
        fr.syn = { codec: 'aac', kind: 'sample', offset: fr.offset, size: fr.size, base: fr.offset, ctxKey: ctxKey };
      } else if (cfg.codecId) {
        fr.syn = { codec: cfg.codecId, kind: 'raw', offset: fr.offset, size: fr.size, base: fr.offset, ctxKey: ctxKey };
      } else {
        // Subtitle / timed-text / unknown sample entries: no codec module can
        // decode these, but the frame still reports what the container knows.
        fr.syn = { codec: null, kind: 'raw', offset: fr.offset, size: fr.size, base: fr.offset };
      }
      frames[fi] = fr;
    }

    tk.built = frames;
    return { track: track, frames: frames, configFrame: configFrame };
  }

  function findNode(root, codes) {
    var found = null;
    (function walk(n) {
      if (found || !n) return;
      if (codes.indexOf(n.code) >= 0) { found = n; return; }
      (n.children || []).forEach(walk);
    })(root);
    return found;
  }

  /* ------------------------------------------------- fragmented samples */

  function buildFragmentFrames(P, result, data) {
    var out = [];
    var byTrack = {};
    result.tracks.forEach(function (t) { byTrack[t.id] = t; });

    P.traks.forEach(function (tk) {
      if (!tk.truns || !tk.truns.length) return;
      var trackId = tk.tkhd ? tk.tkhd.id : (tk.index + 1);
      var track = byTrack[trackId];
      var timescale = (tk.mdhd && tk.mdhd.timescale) || (P.mvhd && P.mvhd.timescale) || 1;
      var def = P.trex[trackId] || {};
      var decodeTime = tk.baseMediaDecodeTime || 0;
      var seq = 0;
      var cfg = tk.config || {};
      var ctxKey = trackId + ':' + (cfg.codecId || '');
      if (cfg.avcc || cfg.hvcc || cfg.vvcc || cfg.asc || cfg.ctx) {
        result.codecContexts[ctxKey] = cfg.avcc ? cfg.avcc.ctx :
                                       cfg.hvcc ? cfg.hvcc.ctx :
                                       cfg.vvcc ? cfg.vvcc.ctx :
                                       cfg.asc ? cfg.asc.info : cfg.ctx;
      }

      tk.truns.forEach(function (entry) {
        var tfhd = entry.tfhd || {};
        var run = entry.run;
        // Base offset: explicit, or the enclosing moof when default-base-is-moof.
        var base = tfhd.baseDataOffset != null ? tfhd.baseDataOffset
                 : (tfhd.moofOffset != null ? tfhd.moofOffset : 0);
        var offset = base + (run.dataOffset || 0);
        var sampleDuration = tfhd.defaultSampleDuration || def.duration || 0;
        var sampleSize = tfhd.defaultSampleSize || def.size || 0;

        for (var i = 0; i < run.samples.length && out.length < MAX_FRAMES; i++) {
          var s = run.samples[i];
          var dur = s.duration != null ? s.duration : sampleDuration;
          var size = s.size != null ? s.size : sampleSize;
          var flags = s.flags != null ? s.flags : (i === 0 && run.firstSampleFlags != null
                        ? run.firstSampleFlags : (tfhd.defaultSampleFlags != null
                        ? tfhd.defaultSampleFlags : def.flags || 0));
          var isKey = (flags & 0x00010000) === 0;      // sample_is_non_sync_sample
          var cts = s.ctts || 0;

          var kind = (track && track.type) || 'video';
          var typeLabel = kind === 'video' ? (isKey ? 'I' : 'P/B')
                        : kind === 'audio' ? 'audio' : 'sample';

          var fr = {
            track: trackId, index: ++seq, type: typeLabel,
            kind: kind === 'subtitle' ? 'other' : kind,
            codec: (track && track.codec) || (cfg.codecId || ''),
            offset: offset, size: size,
            dtsSec: decodeTime / timescale,
            ptsSec: (decodeTime + cts) / timescale,
            durationSec: dur / timescale,
            keyframe: isKey
          };
          if (cfg.codecId && (kind === 'video' || kind === 'audio')) {
            fr.syn = {
              codec: cfg.codecId,
              kind: (cfg.avcc || cfg.hvcc || cfg.vvcc) ? 'sample' : (cfg.asc ? 'sample' : 'raw'),
              offset: offset, size: size, base: offset,
              lengthSize: (cfg.avcc && cfg.avcc.lengthSize) || (cfg.hvcc && cfg.hvcc.lengthSize) ||
                          (cfg.vvcc && cfg.vvcc.lengthSize) || 4,
              ctxKey: ctxKey
            };
          }
          out.push(fr);
          offset += size;
          decodeTime += dur;
        }
      });

      if (track) {
        track.sampleCount = (track.sampleCount || 0) + seq;
        track.fragmentSamples = seq;
        if (!track.sampleCount) track.sampleCount = seq;
      }
    });

    if (out.length >= MAX_FRAMES) P.notes.push('Fragment frame list capped at ' + MAX_FRAMES + ' samples.');
    return out;
  }

  MA.registerParser({
    id: 'mp4',
    name: 'MP4 (ISO BMFF)',
    extensions: ['mp4', 'm4v', 'm4a', 'mov', '3gp', 'avif', 'heic', 'mif1'],
    parse: parse
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
