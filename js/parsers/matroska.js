/* ============================================================================
 * MediaAnalyzer — parsers/matroska.js
 *
 * Matroska / WebM container — EBML, RFC 8794 + Matroska v4 element specs.
 *
 *   - EBML variable length integers (IDs keep the length marker, sizes strip
 *     it) including unknown-size elements, which is how a live WebM signals
 *     an open ended Segment/Cluster
 *   - an element catalogue whose per-master child lists double as the rule
 *     that terminates an unknown-size master
 *   - EBML header / Info / Tracks / Tags / Chapters / Attachments / SeekHead
 *   - Cluster blocks (SimpleBlock + BlockGroup, all four lacing modes) -> frames
 *   - CodecPrivate parsing for AVC, HEVC, AAC, Opus, Vorbis and FLAC
 *
 * The result follows the container contract of js/util.js. A frame never keeps
 * a reference to `ctx.data`: it carries a small lazy `syn` recipe
 * ({codec, kind, offset, size, lengthSize, annexB, ctxKey}) that the app
 * resolves later through MA.buildFrameSyntax(). Only the one or two
 * configuration records get eager `tables`.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});
  var makeNode = MA.makeNode, nodeField = MA.nodeField, nodeNote = MA.nodeNote;
  var synSection = MA.synSection, hex = MA.hex, safeCount = MA.safeCount;

  /* ------------------------------------------------------------- limits */

  var MAX_FRAMES = 50000;             // hard cap on emitted frames
  var MAX_CLUSTER_NODES = 2000;       // structure tree nodes for clusters
  var MAX_BLOCKS_PER_CLUSTER = 256;   // block rows listed under one cluster
  var MAX_ELEMENTS = 2000000;         // iteration guard, a corrupt chain stops here
  var MAX_ID_DEPTH = 32;              // structural recursion guard

  /* ==========================================================================
   * Element catalogue
   *
   * ELS maps an element ID to { name, type } (plus the master it belongs to,
   * which is used to build CHILDREN — the allow-list that tells an
   * unknown-size master where it ends). Types follow the EBML spec:
   *   u unsigned int   i signed int   f float   s ASCII string
   *   8 UTF-8 string   b binary       m master
   * ========================================================================*/

  var ELS = {};
  var CHILDREN = {};

  /** Define one element: id, spec name, value type, containing master (0 = root). */
  function def(id, name, type, parent) {
    ELS[id] = { name: name, type: type, parent: parent || 0 };
    if (parent) (CHILDREN[parent] = CHILDREN[parent] || {})[id] = 1;
    return id;
  }

  /* --- global --- */
  var ID_EBML = def(0x1A45DFA3, 'EBML', 'm');
  def(0x4286, 'EBMLVersion', 'u', ID_EBML);
  def(0x42F7, 'EBMLReadVersion', 'u', ID_EBML);
  def(0x42F2, 'EBMLMaxIDLength', 'u', ID_EBML);
  def(0x42F3, 'EBMLMaxSizeLength', 'u', ID_EBML);
  def(0x4282, 'DocType', 's', ID_EBML);
  def(0x4287, 'DocTypeVersion', 'u', ID_EBML);
  def(0x4285, 'DocTypeReadVersion', 'u', ID_EBML);
  def(0x4281, 'DocTypeExtension', 'm', ID_EBML);
  def(0x4283, 'DocTypeExtensionName', 's', 0x4281);
  def(0x4284, 'DocTypeExtensionVersion', 'u', 0x4281);

  /* --- Segment --- */
  var ID_SEGMENT = def(0x18538067, 'Segment', 'm');
  var ID_SEEKHEAD = def(0x114D9B74, 'SeekHead', 'm', ID_SEGMENT);
  def(0x4DBB, 'Seek', 'm', ID_SEEKHEAD);
  def(0x53AB, 'SeekID', 'b', 0x4DBB);
  def(0x53AC, 'SeekPosition', 'u', 0x4DBB);

  var ID_INFO = def(0x1549A966, 'Info', 'm', ID_SEGMENT);
  def(0x73A4, 'SegmentUID', 'b', ID_INFO);
  def(0x7384, 'SegmentFilename', '8', ID_INFO);
  def(0x3CB923, 'PrevUID', 'b', ID_INFO);
  def(0x3C83AB, 'PrevFilename', '8', ID_INFO);
  def(0x3EB923, 'NextUID', 'b', ID_INFO);
  def(0x3E83BB, 'NextFilename', '8', ID_INFO);
  def(0x4444, 'SegmentFamily', 'b', ID_INFO);
  def(0x2AD7B1, 'TimestampScale', 'u', ID_INFO);      // a.k.a. TimecodeScale
  def(0x4489, 'Duration', 'f', ID_INFO);
  def(0x4461, 'DateUTC', 'i', ID_INFO);
  def(0x7BA9, 'Title', '8', ID_INFO);
  def(0x4D80, 'MuxingApp', '8', ID_INFO);
  def(0x5741, 'WritingApp', '8', ID_INFO);

  var ID_TRACKS = def(0x1654AE6B, 'Tracks', 'm', ID_SEGMENT);
  var ID_TRACKENTRY = def(0xAE, 'TrackEntry', 'm', ID_TRACKS);
  def(0xD7, 'TrackNumber', 'u', ID_TRACKENTRY);
  def(0x73C5, 'TrackUID', 'u', ID_TRACKENTRY);
  def(0x83, 'TrackType', 'u', ID_TRACKENTRY);
  def(0xB9, 'FlagEnabled', 'u', ID_TRACKENTRY);
  def(0x88, 'FlagDefault', 'u', ID_TRACKENTRY);
  def(0x55AA, 'FlagForced', 'u', ID_TRACKENTRY);
  def(0x9C, 'FlagLacing', 'u', ID_TRACKENTRY);
  def(0x6DE7, 'MinCache', 'u', ID_TRACKENTRY);
  def(0x6DF8, 'MaxCache', 'u', ID_TRACKENTRY);
  def(0x23E383, 'DefaultDuration', 'u', ID_TRACKENTRY);
  def(0x234E7A, 'DefaultDecodedFieldDuration', 'u', ID_TRACKENTRY);
  def(0x23314F, 'TrackTimestampScale', 'f', ID_TRACKENTRY);
  def(0x537F, 'TrackOffset', 'i', ID_TRACKENTRY);
  def(0x55EE, 'MaxBlockAdditionID', 'u', ID_TRACKENTRY);
  def(0x536E, 'Name', '8', ID_TRACKENTRY);
  def(0x22B59C, 'Language', 's', ID_TRACKENTRY);
  def(0x22B59D, 'LanguageIETF', 's', ID_TRACKENTRY);
  def(0x86, 'CodecID', 's', ID_TRACKENTRY);
  def(0x63A2, 'CodecPrivate', 'b', ID_TRACKENTRY);
  def(0x258688, 'CodecName', '8', ID_TRACKENTRY);
  def(0x7446, 'AttachmentLink', 'u', ID_TRACKENTRY);
  def(0x3A9697, 'CodecSettings', '8', ID_TRACKENTRY);
  def(0x3B4040, 'CodecInfoURL', 's', ID_TRACKENTRY);
  def(0x26B240, 'CodecDownloadURL', 's', ID_TRACKENTRY);
  def(0xAA, 'CodecDecodeAll', 'u', ID_TRACKENTRY);
  def(0x6FAB, 'TrackOverlay', 'u', ID_TRACKENTRY);
  def(0x56AA, 'CodecDelay', 'u', ID_TRACKENTRY);
  def(0x56BB, 'SeekPreRoll', 'u', ID_TRACKENTRY);

  def(0xE0, 'Video', 'm', ID_TRACKENTRY);
  def(0x9A, 'FlagInterlaced', 'u', 0xE0);
  def(0x9D, 'FieldOrder', 'u', 0xE0);
  def(0x53B8, 'StereoMode', 'u', 0xE0);
  def(0x53C0, 'AlphaMode', 'u', 0xE0);
  def(0xB0, 'PixelWidth', 'u', 0xE0);
  def(0xBA, 'PixelHeight', 'u', 0xE0);
  def(0x54AA, 'PixelCropBottom', 'u', 0xE0);
  def(0x54BB, 'PixelCropTop', 'u', 0xE0);
  def(0x54CC, 'PixelCropLeft', 'u', 0xE0);
  def(0x54DD, 'PixelCropRight', 'u', 0xE0);
  def(0x54B0, 'DisplayWidth', 'u', 0xE0);
  def(0x54BA, 'DisplayHeight', 'u', 0xE0);
  def(0x54B2, 'DisplayUnit', 'u', 0xE0);
  def(0x54B4, 'AspectRatioType', 'u', 0xE0);
  def(0x2EB524, 'ColourSpace', 'b', 0xE0);
  def(0x2FB523, 'GammaValue', 'f', 0xE0);
  def(0x2383E3, 'FrameRate', 'f', 0xE0);
  def(0x55B0, 'Colour', 'm', 0xE0);
  def(0x55B1, 'MatrixCoefficients', 'u', 0x55B0);
  def(0x55B2, 'BitsPerChannel', 'u', 0x55B0);
  def(0x55B3, 'ChromaSubsamplingHorz', 'u', 0x55B0);
  def(0x55B4, 'ChromaSubsamplingVert', 'u', 0x55B0);
  def(0x55B5, 'CbSubsamplingHorz', 'u', 0x55B0);
  def(0x55B6, 'CbSubsamplingVert', 'u', 0x55B0);
  def(0x55B7, 'ChromaSitingHorz', 'u', 0x55B0);
  def(0x55B8, 'ChromaSitingVert', 'u', 0x55B0);
  def(0x55B9, 'Range', 'u', 0x55B0);
  def(0x55BA, 'TransferCharacteristics', 'u', 0x55B0);
  def(0x55BB, 'Primaries', 'u', 0x55B0);
  def(0x55BC, 'MaxCLL', 'u', 0x55B0);
  def(0x55BD, 'MaxFALL', 'u', 0x55B0);
  def(0x55D0, 'MasteringMetadata', 'm', 0x55B0);
  def(0x55D1, 'PrimaryRChromaticityX', 'f', 0x55D0);
  def(0x55D2, 'PrimaryRChromaticityY', 'f', 0x55D0);
  def(0x55D3, 'PrimaryGChromaticityX', 'f', 0x55D0);
  def(0x55D4, 'PrimaryGChromaticityY', 'f', 0x55D0);
  def(0x55D5, 'PrimaryBChromaticityX', 'f', 0x55D0);
  def(0x55D6, 'PrimaryBChromaticityY', 'f', 0x55D0);
  def(0x55D7, 'WhitePointChromaticityX', 'f', 0x55D0);
  def(0x55D8, 'WhitePointChromaticityY', 'f', 0x55D0);
  def(0x55DA, 'LuminanceMax', 'f', 0x55D0);
  def(0x55DB, 'LuminanceMin', 'f', 0x55D0);

  def(0xE1, 'Audio', 'm', ID_TRACKENTRY);
  def(0xB5, 'SamplingFrequency', 'f', 0xE1);
  def(0x78B5, 'OutputSamplingFrequency', 'f', 0xE1);
  def(0x9F, 'Channels', 'u', 0xE1);
  def(0x7D7B, 'ChannelPositions', 'b', 0xE1);
  def(0x6264, 'BitDepth', 'u', 0xE1);

  def(0x6D80, 'ContentEncodings', 'm', ID_TRACKENTRY);
  def(0x6240, 'ContentEncoding', 'm', 0x6D80);
  def(0x5031, 'ContentEncodingOrder', 'u', 0x6240);
  def(0x5032, 'ContentEncodingScope', 'u', 0x6240);
  def(0x5033, 'ContentEncodingType', 'u', 0x6240);
  def(0x5034, 'ContentCompression', 'm', 0x6240);
  def(0x4254, 'ContentCompAlgo', 'u', 0x5034);
  def(0x4255, 'ContentCompSettings', 'b', 0x5034);
  def(0x5035, 'ContentEncryption', 'm', 0x6240);

  var ID_CLUSTER = def(0x1F43B675, 'Cluster', 'm', ID_SEGMENT);
  var ID_CLUSTER_TS = def(0xE7, 'Timestamp', 'u', ID_CLUSTER);   // a.k.a. Timecode
  def(0x5854, 'SilentTracks', 'm', ID_CLUSTER);
  def(0x58D7, 'ClusterPosition', 'u', ID_CLUSTER);
  def(0xAB, 'PrevSize', 'u', ID_CLUSTER);
  var ID_SIMPLEBLOCK = def(0xA3, 'SimpleBlock', 'b', ID_CLUSTER);
  var ID_BLOCKGROUP = def(0xA0, 'BlockGroup', 'm', ID_CLUSTER);
  var ID_BLOCK = def(0xA1, 'Block', 'b', ID_BLOCKGROUP);
  def(0x9B, 'BlockDuration', 'u', ID_BLOCKGROUP);
  def(0xFA, 'ReferencePriority', 'u', ID_BLOCKGROUP);
  def(0xFB, 'ReferenceBlock', 'i', ID_BLOCKGROUP);
  def(0xFD, 'ReferenceVirtual', 'i', ID_BLOCKGROUP);
  def(0xA4, 'CodecState', 'b', ID_BLOCKGROUP);
  def(0x75A1, 'BlockAdditions', 'm', ID_BLOCKGROUP);
  def(0xA6, 'BlockMore', 'm', 0x75A1);
  def(0xEE, 'BlockAddID', 'u', 0xA6);
  def(0xA5, 'BlockAdditional', 'b', 0xA6);
  def(0x8E, 'Slices', 'm', ID_BLOCKGROUP);
  def(0xE8, 'TimeSlice', 'm', 0x8E);
  def(0xCC, 'LaceNumber', 'u', 0xE8);
  def(0xCD, 'FrameNumber', 'u', 0xE8);
  def(0xCB, 'BlockAdditionID', 'u', 0xE8);
  def(0xCE, 'Delay', 'u', 0xE8);
  def(0xCF, 'SliceDuration', 'u', 0xE8);
  def(0xA7, 'EncryptedBlock', 'b', ID_CLUSTER);

  var ID_CUES = def(0x1C53BB6B, 'Cues', 'm', ID_SEGMENT);
  def(0xBB, 'CuePoint', 'm', ID_CUES);
  def(0xB3, 'CueTime', 'u', 0xBB);
  def(0xB7, 'CueTrackPositions', 'm', 0xBB);
  def(0xF7, 'CueTrack', 'u', 0xB7);
  def(0xF1, 'CueClusterPosition', 'u', 0xB7);
  def(0xF0, 'CueRelativePosition', 'u', 0xB7);
  def(0xB2, 'CueDuration', 'u', 0xB7);
  def(0x5378, 'CueBlockNumber', 'u', 0xB7);
  def(0xEA, 'CueCodecState', 'u', 0xB7);
  def(0xDB, 'CueReference', 'm', 0xB7);

  var ID_ATTACHMENTS = def(0x1941A469, 'Attachments', 'm', ID_SEGMENT);
  def(0x61A7, 'AttachedFile', 'm', ID_ATTACHMENTS);
  def(0x467E, 'FileDescription', '8', 0x61A7);
  def(0x466E, 'FileName', '8', 0x61A7);
  def(0x4660, 'FileMimeType', 's', 0x61A7);
  def(0x465C, 'FileData', 'b', 0x61A7);
  def(0x46AE, 'FileUID', 'u', 0x61A7);
  def(0x46A3, 'FileReferral', 'b', 0x61A7);

  var ID_CHAPTERS = def(0x1043A770, 'Chapters', 'm', ID_SEGMENT);
  def(0x45B9, 'EditionEntry', 'm', ID_CHAPTERS);
  def(0x45BC, 'EditionUID', 'u', 0x45B9);
  def(0x45BD, 'EditionFlagHidden', 'u', 0x45B9);
  def(0x45DB, 'EditionFlagDefault', 'u', 0x45B9);
  def(0x45DD, 'EditionFlagOrdered', 'u', 0x45B9);
  def(0xB6, 'ChapterAtom', 'm', 0x45B9);
  def(0x73C4, 'ChapterUID', 'u', 0xB6);
  def(0x5654, 'ChapterStringUID', '8', 0xB6);
  def(0x91, 'ChapterTimeStart', 'u', 0xB6);
  def(0x92, 'ChapterTimeEnd', 'u', 0xB6);
  def(0x98, 'ChapterFlagHidden', 'u', 0xB6);
  def(0x4598, 'ChapterFlagEnabled', 'u', 0xB6);
  def(0x8F, 'ChapterTrack', 'm', 0xB6);
  def(0x80, 'ChapterDisplay', 'm', 0xB6);
  def(0x85, 'ChapString', '8', 0x80);
  def(0x437C, 'ChapLanguage', 's', 0x80);
  def(0x437E, 'ChapLanguageIETF', 's', 0x80);
  def(0x437D, 'ChapCountry', 's', 0x80);

  var ID_TAGS = def(0x1254C367, 'Tags', 'm', ID_SEGMENT);
  def(0x7373, 'Tag', 'm', ID_TAGS);
  def(0x63C0, 'Targets', 'm', 0x7373);
  def(0x68CA, 'TargetTypeValue', 'u', 0x63C0);
  def(0x63CA, 'TargetType', 's', 0x63C0);
  def(0x63C5, 'TagTrackUID', 'u', 0x63C0);
  def(0x63C9, 'TagEditionUID', 'u', 0x63C0);
  def(0x63C4, 'TagChapterUID', 'u', 0x63C0);
  def(0x63C6, 'TagAttachmentUID', 'u', 0x63C0);
  def(0x67C8, 'SimpleTag', 'm', 0x7373);
  def(0x45A3, 'TagName', '8', 0x67C8);
  def(0x447A, 'TagLanguage', 's', 0x67C8);
  def(0x4484, 'TagDefault', 'u', 0x67C8);
  def(0x4487, 'TagString', '8', 0x67C8);
  def(0x4485, 'TagBinary', 'b', 0x67C8);

  /* --- global, allowed under any master --- */
  var ID_VOID = def(0xEC, 'Void', 'b');
  var ID_CRC32 = def(0xBF, 'CRC-32', 'b');

  /* ------------------------------------------------------------ tables */

  var TRACK_TYPES = {
    1: 'video', 2: 'audio', 3: 'complex', 16: 'image', 17: 'subtitle',
    18: 'other', 32: 'other'
  };
  var TRACK_TYPE_NAMES = {
    1: 'video', 2: 'audio', 3: 'complex (A+V muxed)', 16: 'logo (image)',
    17: 'subtitle', 18: 'buttons', 32: 'control'
  };

  var CODEC_NAMES = {
    'V_MPEG4/ISO/AVC': 'H.264 / AVC', 'V_MPEGH/ISO/HEVC': 'H.265 / HEVC',
    'V_MPEG4/ISO/ASP': 'MPEG-4 Visual (ASP)', 'V_MPEG4/ISO/SP': 'MPEG-4 Visual (SP)',
    'V_MPEG4/ISO/AP': 'MPEG-4 Visual (AP)', 'V_MPEG1': 'MPEG-1 Video',
    'V_MPEG2': 'MPEG-2 Video', 'V_VP8': 'VP8', 'V_VP9': 'VP9',
    'V_AV1': 'AV1', 'V_THEORA': 'Theora', 'V_PRORES': 'Apple ProRes',
    'V_FFV1': 'FFV1', 'V_MS/VFW/FOURCC': 'VFW / FourCC video',
    'A_AAC': 'AAC', 'A_OPUS': 'Opus', 'A_VORBIS': 'Vorbis',
    'A_FLAC': 'FLAC', 'A_MPEG/L3': 'MP3', 'A_MPEG/L2': 'MP2',
    'A_MPEG/L1': 'MP1', 'A_AC3': 'AC-3', 'A_EAC3': 'E-AC-3',
    'A_DTS': 'DTS', 'A_TRUEHD': 'TrueHD', 'A_MLP': 'MLP',
    'A_PCM/INT/LIT': 'PCM (integer, little endian)',
    'A_PCM/INT/BIG': 'PCM (integer, big endian)',
    'A_PCM/FLOAT/IEEE': 'PCM (32-bit float)', 'A_ALAC': 'ALAC',
    'S_TEXT/UTF8': 'UTF-8 subtitles', 'S_TEXT/ASS': 'SSA/ASS subtitles',
    'S_TEXT/SSA': 'SSA subtitles', 'S_TEXT/WEBVTT': 'WebVTT',
    'S_TEXT/USF': 'USF subtitles', 'S_HDMV/PGS': 'PGS subtitles',
    'S_VOBSUB': 'VobSub subtitles', 'S_DVBSUB': 'DVB subtitles',
    'S_KATE': 'Kate subtitles'
  };

  /** Container codec id -> the short codec key used by frames and codecs/*.js. */
  function codecKey(codecId) {
    if (!codecId) return '';
    if (codecId.indexOf('V_MPEG4/ISO/AVC') === 0) return 'h264';
    if (codecId.indexOf('V_MPEGH/ISO/HEVC') === 0) return 'h265';
    if (codecId.indexOf('V_MPEGH/ISO/VVC') === 0) return 'h266';
    if (codecId === 'V_VP8' || codecId === 'VP8') return 'vp8';
    if (codecId === 'V_VP9' || codecId === 'VP9') return 'vp9';
    if (codecId.indexOf('V_AV1') === 0) return 'av1';
    if (codecId.indexOf('V_THEORA') === 0) return 'theora';
    if (codecId.indexOf('A_AAC') === 0) return 'aac';
    if (codecId.indexOf('A_OPUS') === 0) return 'opus';
    if (codecId.indexOf('A_VORBIS') === 0) return 'vorbis';
    if (codecId.indexOf('A_FLAC') === 0) return 'flac';
    if (codecId.indexOf('A_MPEG/L3') === 0) return 'mp3';
    if (codecId.indexOf('A_AC3') === 0) return 'ac3';
    if (codecId.indexOf('A_EAC3') === 0) return 'eac3';
    if (codecId.indexOf('A_PCM/INT/LIT') === 0) return 'pcm';
    if (codecId.indexOf('A_ALAC') === 0) return 'alac';
    if (codecId.indexOf('S_TEXT/UTF8') === 0 || codecId.indexOf('S_TEXT/') === 0) return 'text';
    return '';
  }

  function codecName(codecId) {
    if (!codecId) return '';
    if (CODEC_NAMES[codecId]) return CODEC_NAMES[codecId];
    // A_AAC/MPEG4/LC, A_AAC/MPEG2/... etc. collapse onto their family name.
    var family = codecId.split('/')[0];
    if (family === 'A_AAC') return 'AAC (' + codecId.split('/').slice(1).join('/') + ')';
    return CODEC_NAMES[family] || codecId;
  }

  /** Typical decoded samples per packet, used to space out laced audio frames. */
  function audioSamplesPerPacket(codecId) {
    var key = codecKey(codecId);
    if (key === 'aac') return 1024;
    if (key === 'mp3') return 1152;
    if (key === 'opus') return 960;      // 20 ms at 48 kHz
    if (key === 'vorbis') return 1024;
    if (key === 'ac3' || key === 'eac3') return 1536;
    return 0;
  }

  /* ==========================================================================
   * EBML primitives
   * ========================================================================*/

  /**
   * Read one EBML VINT (RFC 8794 §4).
   * @param {boolean} keepMarker  keep the length marker in the value — required
   *                              for element IDs, stripped for sizes/lace values
   * @returns {{value:number,len:number,allOnes:boolean}|null}
   */
  function readVint(data, pos, end, keepMarker) {
    if (pos < 0 || pos >= end) return null;
    var b0 = data[pos], len = 0, mask = 0x80;
    while (len < 8 && !(b0 & mask)) { len++; mask >>= 1; }
    if (len > 7) return null;                       // 0x00 — invalid, not a VINT
    len++;
    if (pos + len > end) return null;
    var v = keepMarker ? b0 : (b0 & (mask - 1));
    var allOnes = false;
    if (!keepMarker) {
      allOnes = (b0 & (mask - 1)) === (mask - 1);
      for (var i = 1; i < len; i++) {
        v = v * 256 + data[pos + i];
        if (allOnes && data[pos + i] !== 0xff) allOnes = false;
      }
    } else {
      for (var j = 1; j < len; j++) v = v * 256 + data[pos + j];
    }
    return { value: v, len: len, allOnes: allOnes };
  }

  /**
   * Read one element header. `end` is the enclosing parent's end; an element
   * with an unknown size is understood to run to that end (live streaming).
   */
  function readElement(data, pos, end) {
    var idv = readVint(data, pos, end, true);
    if (!idv || idv.value === 0) return null;
    var sz = readVint(data, pos + idv.len, end, false);
    if (!sz) return null;
    var dataStart = pos + idv.len + sz.len;
    var declared = sz.allOnes ? (end - dataStart) : sz.value;
    var truncated = dataStart + declared > end;
    var dataEnd = truncated ? end : dataStart + declared;
    if (idv.len > 4) return null;                   // IDs are at most 4 bytes
    return {
      id: idv.value, start: pos, idLen: idv.len, sizeLen: sz.len,
      headerLen: idv.len + sz.len, dataStart: dataStart, dataEnd: dataEnd,
      size: dataEnd - dataStart, unknown: !!sz.allOnes, truncated: truncated
    };
  }

  /** True when `childId` may live inside `parentId` (Void/CRC-32 may anywhere). */
  function childAllowed(parentId, childId) {
    if (childId === ID_VOID || childId === ID_CRC32) return true;
    var set = CHILDREN[parentId];
    if (!set) return true;                          // unknown master: accept
    return !!set[childId];
  }

  /** Iterate the children of a master element. */
  function eachChild(data, el, parentId, cb) {
    var p = el.dataStart, guard = 0;
    while (p < el.dataEnd && guard++ < MAX_ELEMENTS) {
      var child = readElement(data, p, el.dataEnd);
      if (!child) break;
      // An unknown-size master ends where a non-child element begins.
      if (el.unknown && !childAllowed(parentId, child.id)) break;
      cb(child);
      if (child.dataEnd <= p) break;                // corrupt: no progress
      p = child.dataEnd;
    }
  }

  /* ---- value readers (big endian, as EBML mandates) ---- */

  function readUInt(data, s, e) {
    var v = 0, n = 0;
    for (var i = s; i < e && n < 8; i++, n++) v = v * 256 + data[i];
    return v;
  }
  function readSInt(data, s, e) {
    var len = Math.min(e - s, 8);
    if (!len) return 0;
    var v = readUInt(data, s, s + len);
    var bias = Math.pow(2, 8 * len - 1);
    return v >= bias ? v - bias * 2 : v;
  }
  function readFloat(data, s, e) {
    var len = e - s;
    if (len !== 4 && len !== 8) return null;
    var dv = new DataView(data.buffer, data.byteOffset + s, len);
    return len === 4 ? dv.getFloat32(0, false) : dv.getFloat64(0, false);
  }
  function readStr(data, s, e, utf8) {
    if (e <= s) return '';
    try {
      if (utf8) {
        return new TextDecoder('utf-8').decode(data.subarray(s, e)).replace(/\0+$/, '');
      }
      var out = '';
      for (var i = s; i < e; i++) {
        var c = data[i];
        out += (c >= 32 && c < 127) ? String.fromCharCode(c) : '.';
      }
      return out.replace(/\.+$/, '');
    } catch (err) { return ''; }
  }

  /** Value of a scalar element, decoded according to the catalogue type. */
  function elementValue(data, el, type) {
    switch (type) {
      case 'u': return readUInt(data, el.dataStart, el.dataEnd);
      case 'i': return readSInt(data, el.dataStart, el.dataEnd);
      case 'f': return readFloat(data, el.dataStart, el.dataEnd);
      case 's': return readStr(data, el.dataStart, el.dataEnd, false);
      case '8': return readStr(data, el.dataStart, el.dataEnd, true);
      default:  return null;
    }
  }

  /* ==========================================================================
   * Structure-tree helpers
   * ========================================================================*/

  /** Add the element header rows (ID + size) — both link to real bytes. */
  function addHeaderFields(node, el) {
    nodeField(node, 'Element ID', hex(el.id, el.idLen * 2), el.start, el.idLen);
    nodeField(node, 'Size', el.unknown ? 'unknown (runs to parent end)' : el.size,
      el.start + el.idLen, el.sizeLen);
  }

  /** Build a leaf node for a scalar/binary element, with its decoded value. */
  function scalarNode(data, el) {
    var cat = ELS[el.id];
    var name = cat ? cat.name : ('Unknown 0x' + el.id.toString(16).toUpperCase());
    var node = makeNode('element', name, name, el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    var type = cat ? cat.type : null;
    var value;
    if (type === 'b' || type == null) {
      value = el.size <= 16
        ? hexBytes(data, el.dataStart, el.dataEnd)
        : el.size + ' bytes';
    } else {
      value = elementValue(data, el, type);
      if (value == null || value === '') value = el.size + ' bytes';
      else if (typeof value === 'number' && !isFinite(value)) value = String(value);
      else if (typeof value === 'number' && !Number.isInteger(value)) value = MA.formatNum(value);
    }
    if (cat && cat.type === 'm') {
      nodeField(node, 'Value', '(master element)', el.dataStart, 0);
    } else {
      // Clamp the link length: a 4 MB AttachedFile must not select 4 MB in hex.
      nodeField(node, name, value, el.dataStart, Math.min(el.size, 64));
    }
    return node;
  }

  function hexBytes(data, s, e) {
    var out = '', n = Math.min(e - s, 16);
    for (var i = 0; i < n; i++) out += (data[s + i] < 16 ? '0' : '') + data[s + i].toString(16).toUpperCase();
    if (e - s > 16) out += '…';
    return out;
  }

  function note(st, text) {
    if (st && st.result) st.result.notes.push(text);
  }

  /* ==========================================================================
   * Codec private data
   * ========================================================================*/

  /** Copy of a byte range that is safe to keep after `ctx.data` is released. */
  function keep(data, s, e) { return data.slice(s, e); }

  /**
   * V_MPEG4/ISO/AVC — AVCDecoderConfigurationRecord.
   * @returns {{tables:Array, ctx:Object, info:Object, lengthSize:number}|null}
   */
  function avcPrivate(data, start, end) {
    var h264 = MA.getCodec('h264');
    if (!h264 || typeof h264.parseAVCC !== 'function') {
      return { missing: 'h264', tables: null };
    }
    var br = new MA.ByteReader(data);
    br.seek(start);
    var cfg = h264.parseAVCC(br, end, start);
    var tables = [cfg.table];
    if (cfg.spsTables) tables = tables.concat(cfg.spsTables);
    if (cfg.ppsTables) tables = tables.concat(cfg.ppsTables);
    var ctx = {
      codec: 'h264',
      lengthSize: cfg.lengthSize || 4,
      annexB: false,
      sps: (cfg.sps || []).map(function (s) {
        return { data: keep(data, s.offset, s.offset + s.data.length), offset: s.offset };
      }),
      pps: (cfg.pps || []).map(function (p) {
        return { data: keep(data, p.offset, p.offset + p.data.length), offset: p.offset };
      })
    };
    return {
      tables: tables, ctx: ctx, lengthSize: cfg.lengthSize || 4,
      info: cfg.info || {}, profile: cfg.info && cfg.info.profile,
      level: cfg.info && cfg.info.level
    };
  }

  /**
   * V_MPEGH/ISO/HEVC — HEVCDecoderConfigurationRecord. Uses js/codecs/h265.js
   * when it is present, otherwise a self contained reader of the fixed record
   * header so a WebM/HEVC file still reports profile, level and length size.
   */
  function hevcPrivate(data, start, end) {
    var h265 = MA.getCodec('h265');
    if (h265 && typeof h265.parseHVCC === 'function') {
      try {
        var br = new MA.ByteReader(data);
        br.seek(start);
        var cfg = h265.parseHVCC(br, end, start);
        var ctx = {
          codec: 'h265', lengthSize: cfg.lengthSize || 4, annexB: false,
          sets: (cfg.sets || []).map(function (s) {
            return {
              type: s.type,
              data: keep(data, s.offset, s.offset + s.data.length), offset: s.offset
            };
          })
        };
        return {
          tables: [cfg.table].concat(cfg.spsTables || []), ctx: ctx,
          lengthSize: cfg.lengthSize || 4, info: cfg.info || {},
          profile: cfg.info && cfg.info.profile, level: cfg.info && cfg.info.level
        };
      } catch (e) { /* fall through to the built-in reader */ }
    }
    var fallback = hevcPrivateFallback(data, start, end);
    if (h265) fallback.noteMissing = 'h265';
    return fallback;
  }

  var HEVC_PROFILES = {
    1: 'Main', 2: 'Main 10', 3: 'Main Still Picture', 4: 'Range extensions',
    5: 'High throughput', 9: 'Screen content coding'
  };

  /** HEVCDecoderConfigurationRecord (ISO/IEC 14496-15 §8.3.3.1) read in full. */
  function hevcPrivateFallback(data, start, end) {
    var rows = [], sets = [];
    function R(name, syntax, bits, value, note, off) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
                  note: note || '', offset: off, depth: 0 });
    }
    var p = start;
    function u8() { return data[p++]; }
    function u16() { var v = (data[p] << 8) | data[p + 1]; p += 2; return v; }

    try {
      var version = u8();
      R('configurationVersion', 'u(8)', 8, version, '',
        start);
      var b1 = u8();
      var profileSpace = (b1 >> 6) & 3, tier = (b1 >> 5) & 1, profileIdc = b1 & 0x1f;
      R('general_profile_space', 'u(2)', 2, profileSpace, ['none', 'A', 'B', 'C'][profileSpace], start + 1);
      R('general_tier_flag', 'u(1)', 1, tier, tier ? 'high tier' : 'main tier', start + 1);
      R('general_profile_idc', 'u(5)', 5, profileIdc, HEVC_PROFILES[profileIdc] || 'profile ' + profileIdc, start + 1);
      var compat = (data[p] << 24 | data[p + 1] << 16 | data[p + 2] << 8 | data[p + 3]) >>> 0;
      p += 4;
      R('general_profile_compatibility_flags', 'u(32)', 32, hex(compat, 8), '', start + 2);
      var c0 = data[p];
      R('general_progressive_source_flag', 'u(1)', 1, (c0 >> 7) & 1, '', start + 6);
      R('general_interlaced_source_flag', 'u(1)', 1, (c0 >> 6) & 1, '', start + 6);
      R('general_non_packed_constraint_flag', 'u(1)', 1, (c0 >> 5) & 1, '', start + 6);
      R('general_frame_only_constraint_flag', 'u(1)', 1, (c0 >> 4) & 1, '', start + 6);
      p += 6;                                     // the six constraint bytes
      var levelIdc = u8();
      R('general_level_idc', 'u(8)', 8, levelIdc,
        'Level ' + (levelIdc / 30).toFixed(1), start + 12);
      var minSpatial = u16() & 0x0fff;
      R('min_spatial_segmentation_idc', 'u(16)', 16, minSpatial, '', start + 13);
      R('parallelismType', 'u(8)', 8, u8() & 3, '', start + 15);
      R('chromaFormat', 'u(8)', 8, u8() & 3, '', start + 16);
      R('bitDepthLumaMinus8', 'u(8)', 8, u8() & 7, '', start + 17);
      R('bitDepthChromaMinus8', 'u(8)', 8, u8() & 7, '', start + 18);
      var avgFrameRate = u16();
      R('avgFrameRate', 'u(16)', 16, avgFrameRate, avgFrameRate ? (avgFrameRate / 256).toFixed(3) + ' fps' : 'unspecified', start + 19);
      var b21 = u8();
      var lengthSize = (b21 & 3) + 1;
      R('constantFrameRate', 'u(2)', 2, (b21 >> 6) & 3, '', start + 21);
      R('numTemporalLayers', 'u(3)', 3, (b21 >> 3) & 7, '', start + 21);
      R('temporalIdNested', 'u(1)', 1, (b21 >> 2) & 1, '', start + 21);
      R('lengthSizeMinusOne', 'u(2)', 2, b21 & 3, 'NAP length = ' + lengthSize + ' bytes', start + 21);
      var numArrays = u8();
      R('numOfArrays', 'u(8)', 8, numArrays, '', start + 22);

      numArrays = safeCount(numArrays, end - p, 3);
      for (var i = 0; i < numArrays && p + 3 <= end; i++) {
        var b = data[p];
        var nalType = b & 0x3f;
        R('array_completeness[' + i + ']', 'u(1)', 1, (b >> 7) & 1, '', p);
        R('NAL_unit_type[' + i + ']', 'u(6)', 6, nalType, hevcNalName(nalType), p);
        p++;
        var numNalus = u16();
        R('numNalus[' + i + ']', 'u(16)', 16, numNalus, '', p - 2);
        numNalus = safeCount(numNalus, end - p, 2);
        for (var j = 0; j < numNalus && p + 2 <= end; j++) {
          var len = u16();
          R('nalUnitLength[' + i + '][' + j + ']', 'u(16)', 16, len, '', p - 2);
          if (p + len > end) break;
          sets.push({ type: nalType, data: keep(data, p, p + len), offset: p });
          p += len;
        }
      }
    } catch (e) { /* truncated record — keep what was read */ }

    var sps = null, pps = null;
    for (var k = 0; k < sets.length; k++) {
      if (sets[k].type === 33 && !sps) sps = sets[k];
      if (sets[k].type === 34 && !pps) pps = sets[k];
    }
    var width = null, height = null;
    // The HEVC SPS parser lives in codecs/h265.js; without it the dimensions
    // stay unknown (the container does not carry them for HEVC).
    return {
      tables: [synSection('HEVCDecoderConfigurationRecord',
        'ISO/IEC 14496-15 §8.3.3.1 — hvcC (read without codecs/h265.js)', rows)],
      ctx: { codec: 'h265', lengthSize: lengthSizeOf(rows), annexB: false, sets: sets },
      lengthSize: lengthSizeOf(rows),
      info: {
        profile: HEVC_PROFILES[profileOf(rows)] || '', level: levelOf(rows),
        width: width, height: height
      },
      profile: HEVC_PROFILES[profileOf(rows)] || '',
      level: levelOf(rows),
      sps: sps, pps: pps
    };

    function lengthSizeOf(rows) {
      for (var i = 0; i < rows.length; i++)
        if (rows[i].name === 'lengthSizeMinusOne') return rows[i].value + 1;
      return 4;
    }
    function profileOf(rows) {
      for (var i = 0; i < rows.length; i++)
        if (rows[i].name === 'general_profile_idc') return rows[i].value;
      return 0;
    }
    function levelOf(rows) {
      for (var i = 0; i < rows.length; i++)
        if (rows[i].name === 'general_level_idc')
          return 'Level ' + (rows[i].value / 30).toFixed(1);
      return null;
    }
  }

  function hevcNalName(t) {
    var names = {
      32: 'VPS', 33: 'SPS', 34: 'PPS', 35: 'AUD', 39: 'SEI prefix',
      40: 'SEI suffix', 19: 'IDR_W_RADL', 20: 'IDR_N_LP', 21: 'CRA_NUT'
    };
    return names[t] || '';
  }

  var AAC_FREQ = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000,
                  12000, 11025, 8000, 7350, 0, 0, 0];
  var AAC_AOT = {
    1: 'AAC Main', 2: 'AAC LC', 3: 'AAC SSR', 4: 'AAC LTP', 5: 'SBR',
    6: 'AAC Scalable', 7: 'TwinVQ', 17: 'ER AAC LC', 19: 'ER AAC LTP',
    20: 'ER AAC Scalable', 21: 'ER TwinVQ', 22: 'ER BSAC', 23: 'ER AAC LD',
    29: 'PS', 39: 'ER AAC ELD', 42: 'USAC'
  };

  /** A_AAC — AudioSpecificConfig, via codecs/aac.js when available. */
  function aacPrivate(data, start, end) {
    var aac = MA.getCodec('aac');
    if (aac && typeof aac.parseAudioSpecificConfig === 'function') {
      try {
        var res = aac.parseAudioSpecificConfig(data, start, end - start);
        return {
          tables: (res.tables || (res.table ? [res.table] : [])),
          info: {
            sampleRate: res.sampleRate || (res.info && res.info.sampleRate),
            channels: res.channels || (res.info && res.info.channels),
            profile: res.aotName || (res.info && res.info.aotName)
          }
        };
      } catch (e) { /* fall through */ }
    }
    return aacPrivateFallback(data, start, end);
  }

  /** AudioSpecificConfig (ISO/IEC 14496-3 §1.6.2.1) — the leading fields at least. */
  function aacPrivateFallback(data, start, end) {
    var rows = [];
    function R(name, syntax, bits, value, note, off) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
                  note: note || '', offset: off, depth: 0 });
    }
    var info = { profile: '', sampleRate: null, channels: null, aot: null };
    try {
      var r = new MA.BitReader(data, start, end - start, false);
      var aot = r.u(5);
      var bits = 5;
      if (aot === 31) { aot = 32 + r.u(6); bits = 11; }
      info.aot = aot;
      info.profile = AAC_AOT[aot] || ('AOT ' + aot);
      R('audioObjectType', 'u(' + bits + ')', bits, aot, info.profile, start);
      var sfi = r.u(4);
      R('samplingFrequencyIndex', 'u(4)', 4, sfi, AAC_FREQ[sfi] ? AAC_FREQ[sfi] + ' Hz' : 'explicit', start);
      if (sfi === 15) {
        info.sampleRate = r.u(24);
        R('samplingFrequency', 'u(24)', 24, info.sampleRate, '', start);
      } else {
        info.sampleRate = AAC_FREQ[sfi];
      }
      var ch = r.u(4);
      info.channels = ch === 0 ? null : ch;
      R('channelConfiguration', 'u(4)', 4, ch,
        ch === 0 ? 'defined in a program config element' : MA.formatChannels(ch), start);
      R('…', '', '', '', 'GASpecificConfig follows (frameLengthFlag, dependsOnCoreCoder…)', start);
    } catch (e) { /* short or corrupt ASC */ }
    return {
      tables: [synSection('AudioSpecificConfig',
        'ISO/IEC 14496-3 §1.6.2.1 — ' + (end - start) + ' bytes', rows)],
      info: info
    };
  }

  /** A_OPUS — OpusHead (+ OpusTags when the muxer appends it). */
  function opusPrivate(data, start, end) {
    var rows = [], info = {};
    function R(name, syntax, bits, value, note, off, depth) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
                  note: note || '', offset: off, depth: depth || 0 });
    }
    var len = end - start;
    R('magic', 'bytes(8)', 64, len >= 8 ? readStr(data, start, start + 8, false) : '(truncated)',
      'OpusHead', start);
    if (len < 19) {
      R('…', '', '', '', 'CodecPrivate shorter than the 19 byte OpusHead', start);
      return { tables: [synSection('OpusHead', 'RFC 7845 §5.1 — ' + len + ' bytes', rows)], info: info };
    }
    info.version = data[start + 8];
    R('version', 'u(8)', 8, info.version, info.version > 15 ? 'invalid (top 4 bits set)' : '', start + 8);
    info.channels = data[start + 9];
    R('channelCount', 'u(8)', 8, info.channels, MA.formatChannels(info.channels), start + 9);
    info.preSkip = data[start + 10] | (data[start + 11] << 8);
    R('preSkip', 'u(16) le', 16, info.preSkip,
      (info.preSkip / 48000 * 1000).toFixed(2) + ' ms at 48 kHz', start + 10);
    info.inputSampleRate = (data[start + 12] | (data[start + 13] << 8) |
                            (data[start + 14] << 16) | (data[start + 15] << 24)) >>> 0;
    R('inputSampleRate', 'u(32) le', 32, info.inputSampleRate,
      'original rate — playback is always 48000 Hz', start + 12);
    info.gain = readSInt(data, start + 16, start + 18) / 256;
    R('outputGain', 'i(16) le', 16, info.gain.toFixed(2) + ' dB', 'Q7.8 fixed point', start + 16);
    info.mappingFamily = data[start + 18];
    R('channelMappingFamily', 'u(8)', 8, info.mappingFamily,
      info.mappingFamily === 0 ? 'mono/stereo' : 'Vorbis channel order', start + 18);
    if (info.mappingFamily !== 0 && len >= 21) {
      info.streamCount = data[start + 19];
      info.coupledCount = data[start + 20];
      R('streamCount', 'u(8)', 8, info.streamCount, '', start + 19);
      R('coupledCount', 'u(8)', 8, info.coupledCount, '', start + 20);
      var n = safeCount(info.channels, end - (start + 21), 1);
      var order = '';
      for (var i = 0; i < n; i++) {
        var m = data[start + 21 + i];
        order += (i ? ' ' : '') + m;
        R('channelMapping[' + i + ']', 'u(8)', 8, m, '', start + 21 + i);
      }
      if (order) info.channelMapping = order;
    }
    return {
      tables: [synSection('OpusHead', 'RFC 7845 §5.1 — ' + len + ' bytes', rows)],
      info: info
    };
  }

  /** A_VORBIS — Xiph-laced identification + comment + setup packets. */
  function vorbisPrivate(data, start, end) {
    var out = { tables: [], info: {}, packets: [], notes: [] };
    var sizes = xiphLaceSizes(data, start, end);
    if (!sizes) {
      out.notes.push('Vorbis CodecPrivate could not be de-laced.');
      return out;
    }
    var p = start;
    for (var i = 0; i < sizes.count; i++) {
      var s = p + sizes.headerLen;
      var e = s + sizes.sizes[i];
      if (e > end) e = end;
      out.packets.push({ offset: s, size: e - s });
      p = s + sizes.sizes[i];
    }
    // 1st packet — identification header
    if (out.packets[0] && out.packets[0].size >= 30) {
      var id = parseVorbisId(data, out.packets[0].offset, out.packets[0].offset + out.packets[0].size, 'Vorbis identification header');
      out.tables.push(id.table);
      out.info = id.info;
    }
    // 2nd packet — comment header (vendor + user comments)
    if (out.packets[1]) {
      var cm = parseVorbisComment(data, out.packets[1].offset,
        out.packets[1].offset + out.packets[1].size, 'Vorbis comment header');
      out.tables.push(cm.table);
      out.info.vendor = cm.vendor;
      out.info.comments = cm.comments;
    }
    // 3rd packet — setup header: codebooks, thousands of bits, never dumped.
    if (out.packets[2]) {
      var sp = out.packets[2];
      out.tables.push(synSection('Vorbis setup header',
        'Xiph laced packet 3 — ' + sp.size + ' bytes @ ' + hex(sp.offset, 8), [
          { name: 'codebook_count / floors / residues / mappings / modes', syntax: '',
            bits: sp.size * 8, value: sp.size + ' bytes',
            note: 'codebook and mode tables — not decoded', offset: sp.offset, depth: 0 }
        ]));
    }
    return out;
  }

  /** Xiph lacing sizes as used by A_VORBIS CodecPrivate. */
  function xiphLaceSizes(data, start, end) {
    if (start >= end) return null;
    var count = data[start] + 1;                 // packet count - 1
    if (count < 1 || count > 256) return null;
    var sizes = [], p = start + 1, consumed = 0;
    for (var i = 0; i < count - 1; i++) {
      var s = 0, b, guard = 0;
      do {
        if (p >= end || guard++ > 8) return null;
        b = data[p++];
        s += b;
      } while (b === 255);
      sizes.push(s);
      consumed += s;
    }
    sizes.push(Math.max(0, (end - p) - consumed));
    return { sizes: sizes, count: count, headerLen: p - start };
  }

  var VORBIS_BLOCK_SIZES = [64, 128, 256, 512, 1024, 2048, 4096, 8192];

  /** Vorbis identification header (Vorbis I §4.2.2). */
  function parseVorbisId(data, start, end, title) {
    var rows = [], info = {};
    function R(name, syntax, bits, value, note, off) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
                  note: note || '', offset: off, depth: 0 });
    }
    var magic = readStr(data, start + 1, Math.min(start + 7, end), false);
    R('packet_type', 'u(8)', 8, data[start], '0x01 = identification header', start);
    R('vorbis_magic', 'bytes(6)', 48, magic, magic === 'vorbis' ? '' : 'unexpected', start + 1);
    function u32le(o) {
      return (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
    }
    function i32le(o) {
      var v = u32le(o);
      return v > 0x7fffffff ? v - 0x100000000 : v;
    }
    info.version = u32le(start + 7);
    R('vorbis_version', 'u(32) le', 32, info.version, 'must be 0', start + 7);
    info.channels = data[start + 11];
    R('audio_channels', 'u(8)', 8, info.channels, MA.formatChannels(info.channels), start + 11);
    info.sampleRate = u32le(start + 12);
    R('audio_sample_rate', 'u(32) le', 32, info.sampleRate, MA.formatHz(info.sampleRate), start + 12);
    info.bitrateMax = i32le(start + 16);
    R('bitrate_maximum', 'i(32) le', 32, info.bitrateMax, info.bitrateMax > 0 ? MA.formatBitrate(info.bitrateMax) : 'unset', start + 16);
    info.bitrateNominal = i32le(start + 20);
    R('bitrate_nominal', 'i(32) le', 32, info.bitrateNominal, info.bitrateNominal > 0 ? MA.formatBitrate(info.bitrateNominal) : 'unset', start + 20);
    info.bitrateMin = i32le(start + 24);
    R('bitrate_minimum', 'i(32) le', 32, info.bitrateMin, info.bitrateMin > 0 ? MA.formatBitrate(info.bitrateMin) : 'unset', start + 24);
    var bs = data[start + 28];
    info.blocksize0 = VORBIS_BLOCK_SIZES[(bs >> 4) & 0x0f];
    info.blocksize1 = VORBIS_BLOCK_SIZES[bs & 0x0f];
    R('blocksize_0', 'u(4)', 4, (bs >> 4) & 0x0f, 'short block 2^' + ((bs >> 4) & 0x0f) +
      (info.blocksize0 ? ' = ' + info.blocksize0 : ''), start + 28);
    R('blocksize_1', 'u(4)', 4, bs & 0x0f, 'long block 2^' + (bs & 0x0f) +
      (info.blocksize1 ? ' = ' + info.blocksize1 : ''), start + 28);
    R('framing_flag', 'u(1)', 1, data[start + 29] & 1, 'must be 1', start + 29);
    return { rows: rows, info: info, table: synSection(title, 'Vorbis I §4.2.2', rows) };
  }

  /** Vorbis comment header (vendor + user comments). */
  function parseVorbisComment(data, start, end, title) {
    var rows = [], comments = [], vendor = '';
    function R(name, syntax, bits, value, note, off) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
                  note: note || '', offset: off, depth: 0 });
    }
    function u32le(o) {
      return (data[o] | (data[o + 1] << 8) | (data[o + 2] << 16) | (data[o + 3] << 24)) >>> 0;
    }
    var p = start;
    R('packet_type', 'u(8)', 8, data[p], '0x03 = comment header', p); p += 1;
    R('vorbis_magic', 'bytes(6)', 48, readStr(data, p, p + 6, false), '', p); p += 6;
    if (p + 4 > end) return { table: synSection(title, 'truncated', rows), vendor: '', comments: [] };
    var vendorLen = safeCount(u32le(p), end - p - 4, 1);
    R('vendor_length', 'u(32) le', 32, vendorLen, '', p); p += 4;
    vendor = readStr(data, p, Math.min(p + vendorLen, end), true);
    R('vendor_string', 'utf8(' + vendorLen + ')', vendorLen * 8, vendor, '', p);
    p += vendorLen;
    if (p + 4 > end) return { table: synSection(title, 'vendor: ' + vendor, rows), vendor: vendor, comments: [] };
    var count = safeCount(u32le(p), end - p - 4, 4);
    R('user_comment_list_length', 'u(32) le', 32, count, '', p); p += 4;
    for (var i = 0; i < count && p + 4 <= end; i++) {
      var len = safeCount(u32le(p), end - p - 4, 1);
      var off = p;
      p += 4;
      var text = readStr(data, p, Math.min(p + len, end), true);
      R('comment[' + i + ']', 'utf8(' + len + ')', len * 8, text, '', off);
      if (text) comments.push(text);
      p += len;
    }
    return {
      table: synSection(title, 'vendor: ' + vendor + ' — ' + comments.length + ' comment(s)', rows),
      vendor: vendor, comments: comments
    };
  }

  /** A_FLAC — "fLaC" + metadata block chain, or a bare STREAMINFO. */
  function flacPrivate(data, start, end) {
    var rows = [], info = {};
    function R(name, syntax, bits, value, note, off) {
      rows.push({ name: name, syntax: syntax, bits: bits, value: value,
                  note: note || '', offset: off, depth: 0 });
    }
    var p = start;
    var hasMarker = end - start >= 4 && data[p] === 0x66 && data[p + 1] === 0x4C &&
                    data[p + 2] === 0x61 && data[p + 3] === 0x43;
    if (hasMarker) {
      R('magic', 'bytes(4)', 32, 'fLaC', 'FLAC stream marker', p);
      p += 4;
    } else {
      R('magic', '', '', '(absent)',
        'CodecPrivate starts at the STREAMINFO block body', p);
    }
    var blocks = 0;
    while (p < end && blocks < 64) {
      var last, type, len;
      if (hasMarker || blocks > 0) {
        if (p + 4 > end) break;
        var b = data[p];
        last = (b & 0x80) !== 0;
        type = b & 0x7f;
        len = (data[p + 1] << 16) | (data[p + 2] << 8) | data[p + 3];
        R('metadata_block_header[' + blocks + ']', 'u(8) u(24)', 32,
          (last ? 'last ' : '') + flacBlockName(type), 'length ' + len, p);
        p += 4;
      } else {
        last = true; type = 0; len = end - p;
      }
      if (p + len > end) len = end - p;
      if (type === 0 && len >= 34) {
        info = parseFlacStreamInfo(data, p, p + len, R);
      } else if (type === 4 && len >= 4) {
        var vlen = safeCount((data[p] << 24 | data[p + 1] << 16 | data[p + 2] << 8 | data[p + 3]) >>> 0,
          Math.max(0, len - 4), 1);
        info.vendor = readStr(data, p + 4, p + 4 + vlen, true);
        R('vendor_string', 'utf8(' + vlen + ')', vlen * 8, info.vendor, '', p + 4);
      } else if (type === 6) {
        info.picture = true;
        R('PICTURE', '', len * 8, len + ' bytes', 'cover art', p);
      }
      p += len;
      blocks++;
      if (last) break;
    }
    return {
      tables: [synSection('FLAC metadata',
        'CodecPrivate — ' + (end - start) + ' bytes, ' + blocks + ' block(s)', rows)],
      info: info
    };
  }

  function flacBlockName(t) {
    return { 0: 'STREAMINFO', 1: 'PADDING', 2: 'APPLICATION', 3: 'SEEKTABLE',
             4: 'VORBIS_COMMENT', 5: 'CUESHEET', 6: 'PICTURE' }[t] || ('type ' + t);
  }

  function parseFlacStreamInfo(data, s, e, R) {
    var info = {};
    var minBlock = (data[s] << 8) | data[s + 1];
    var maxBlock = (data[s + 2] << 8) | data[s + 3];
    var minFrame = (data[s + 4] << 16) | (data[s + 5] << 8) | data[s + 6];
    var maxFrame = (data[s + 7] << 16) | (data[s + 8] << 8) | data[s + 9];
    R('minBlockSize', 'u(16)', 16, minBlock, '', s);
    R('maxBlockSize', 'u(16)', 16, maxBlock, '', s + 2);
    R('minFrameSize', 'u(24)', 24, minFrame, '', s + 4);
    R('maxFrameSize', 'u(24)', 24, maxFrame, '', s + 7);
    var b = s + 10;
    var sampleRate = (data[b] << 12) | (data[b + 1] << 4) | (data[b + 2] >> 4);
    var channels = ((data[b + 2] >> 1) & 0x07) + 1;
    var bits = (((data[b + 2] & 0x01) << 4) | (data[b + 3] >> 4)) + 1;
    var total = (data[b + 3] & 0x0f) * 4294967296 +
      ((data[b + 4] << 24 | data[b + 5] << 16 | data[b + 6] << 8 | data[b + 7]) >>> 0);
    R('sampleRate', 'u(20)', 20, sampleRate, MA.formatHz(sampleRate), b);
    R('channels', 'u(3)', 3, channels - 1, MA.formatChannels(channels) + ' (stored as n-1)', b + 2);
    R('bitsPerSample', 'u(5)', 5, bits - 1, bits + ' bit (stored as n-1)', b + 2);
    R('totalSamples', 'u(36)', 36, total, '', b + 3);
    R('MD5', 'u(128)', 128, hexBytes(data, b + 8, b + 24), '', b + 8);
    info.sampleRate = sampleRate;
    info.channels = channels;
    info.bitDepth = bits;
    info.totalSamples = total;
    info.minBlockSize = minBlock;
    info.maxBlockSize = maxBlock;
    return info;
  }

  /* ==========================================================================
   * Tracks
   * ========================================================================*/

  function parseTrackEntry(data, el, st) {
    var node = makeNode('element', 'TrackEntry', 'TrackEntry', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    var tk = {
      number: null, uid: null, typeNum: null, codecId: '', codecPrivate: null,
      language: '', name: '', codecName: '', defaultDuration: null,
      width: null, height: null, displayWidth: null, displayHeight: null,
      crop: null, interlaced: null, stereoMode: null, alphaMode: null,
      colour: null, sampleRate: null, outputSampleRate: null, channels: null,
      bitDepth: null, flagDefault: null, flagLacing: null, codecDelay: 0,
      seekPreRoll: null, trackOffset: null, contentEncodings: 0,
      extra: [], contexts: null, headerFrames: []
    };

    eachChild(data, el, ID_TRACKENTRY, function (child) {
      var cat = ELS[child.id];
      var cn = scalarNode(data, child);
      // Keep the tree lean: BlockAdditions style large binaries add no value.
      if (!(cat && cat.type === 'b' && child.size > 64)) node.children.push(cn);
      try {
        switch (child.id) {
          case 0xD7: tk.number = elementValue(data, child, 'u'); break;
          case 0x73C5: tk.uid = elementValue(data, child, 'u'); break;
          case 0x83: tk.typeNum = elementValue(data, child, 'u'); break;
          case 0x86: tk.codecId = elementValue(data, child, 's'); break;
          case 0x258688: tk.codecName = elementValue(data, child, '8'); break;
          case 0x22B59C: tk.language = elementValue(data, child, 's'); break;
          case 0x22B59D: tk.languageIETF = elementValue(data, child, 's'); break;
          case 0x536E: tk.name = elementValue(data, child, '8'); break;
          case 0x23E383: tk.defaultDuration = elementValue(data, child, 'u'); break;
          case 0x88: tk.flagDefault = elementValue(data, child, 'u'); break;
          case 0x9C: tk.flagLacing = elementValue(data, child, 'u'); break;
          case 0x56AA: tk.codecDelay = elementValue(data, child, 'u'); break;
          case 0x56BB: tk.seekPreRoll = elementValue(data, child, 'u'); break;
          case 0x537F: tk.trackOffset = elementValue(data, child, 'i'); break;
          case 0x6D80: tk.contentEncodings = 1; break;
          case 0xE0: parseVideo(data, child, tk, cn); break;
          case 0xE1: parseAudio(data, child, tk, cn); break;
          case 0x63A2: {
            tk.codecPrivate = { offset: child.dataStart, size: child.size };
            cn.fields.push({ name: 'Codec ID', value: tk.codecId || '(later element)',
                             offset: child.start, size: 0 });
            break;
          }
        }
      } catch (e) {
        nodeNote(cn, 'Could not decode: ' + msg(e));
      }
    });

    // ---- codec private data: this is where the real detail lives ----
    if (tk.codecPrivate && tk.codecPrivate.size > 0) {
      var s = tk.codecPrivate.offset, e2 = s + tk.codecPrivate.size;
      var res = null;
      try {
        var cid = tk.codecId || '';
        if (codecKey(cid) === 'h264') res = avcPrivate(data, s, e2);
        else if (codecKey(cid) === 'h265') res = hevcPrivate(data, s, e2);
        else if (codecKey(cid) === 'aac') res = aacPrivate(data, s, e2);
        else if (codecKey(cid) === 'opus') res = opusPrivate(data, s, e2);
        else if (codecKey(cid) === 'vorbis') res = vorbisPrivate(data, s, e2);
        else if (codecKey(cid) === 'flac') res = flacPrivate(data, s, e2);
      } catch (e3) {
        note(st, 'CodecPrivate of track ' + tk.number + ' could not be parsed: ' + msg(e3));
      }
      st.configs.push({ track: tk, res: res, offset: s, size: tk.codecPrivate.size });
      if (res && res.notes) for (var ni = 0; ni < res.notes.length; ni++) note(st, res.notes[ni]);
      if (res && res.missing) {
        note(st, 'js/codecs/' + res.missing + '.js is not loaded — the CodecPrivate of track ' +
          tk.number + ' is shown as raw bytes only.');
      }
    }

    // keep the node's CodecPrivate child in sync with what the codec says
    if (tk.codecId) {
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].code === 'CodecPrivate') {
          nodeField(node.children[i], 'CodecID', tk.codecId, el.start, 0);
          break;
        }
      }
    }
    return { tk: tk, node: node };
  }

  function parseVideo(data, el, tk, node) {
    eachChild(data, el, 0xE0, function (child) {
      var cn = scalarNode(data, child);
      node.children.push(cn);
      switch (child.id) {
        case 0xB0: tk.width = elementValue(data, child, 'u'); break;
        case 0xBA: tk.height = elementValue(data, child, 'u'); break;
        case 0x54B0: tk.displayWidth = elementValue(data, child, 'u'); break;
        case 0x54BA: tk.displayHeight = elementValue(data, child, 'u'); break;
        case 0x9A: tk.interlaced = elementValue(data, child, 'u'); break;
        case 0x53B8: tk.stereoMode = elementValue(data, child, 'u'); break;
        case 0x53C0: tk.alphaMode = elementValue(data, child, 'u'); break;
        case 0x54AA: case 0x54BB: case 0x54CC: case 0x54DD:
          tk.crop = tk.crop || {};
          tk.crop[{ 0x54AA: 'bottom', 0x54BB: 'top', 0x54CC: 'left', 0x54DD: 'right' }[child.id]] =
            elementValue(data, child, 'u');
          break;
        case 0x55B0: parseColour(data, child, tk, cn); break;
      }
    });
  }

  function parseColour(data, el, tk, node) {
    tk.colour = tk.colour || {};
    eachChild(data, el, 0x55B0, function (child) {
      var cn = scalarNode(data, child);
      node.children.push(cn);
      var name = ELS[child.id] && ELS[child.id].name;
      if (!name) return;
      tk.colour[name] = elementValue(data, child, ELS[child.id].type);
    });
  }

  function parseAudio(data, el, tk, node) {
    eachChild(data, el, 0xE1, function (child) {
      var cn = scalarNode(data, child);
      node.children.push(cn);
      switch (child.id) {
        case 0xB5: tk.sampleRate = elementValue(data, child, 'f'); break;
        case 0x78B5: tk.outputSampleRate = elementValue(data, child, 'f'); break;
        case 0x9F: tk.channels = elementValue(data, child, 'u'); break;
        case 0x6264: tk.bitDepth = elementValue(data, child, 'u'); break;
      }
    });
  }

  /* ==========================================================================
   * Clusters and blocks
   * ========================================================================*/

  /** Split a block body into its lace sizes. Returns [{offset,size}] in file order. */
  function splitBlock(data, bodyStart, bodyEnd, lacing) {
    var out = [];
    if (lacing === 0) {
      if (bodyEnd > bodyStart) out.push({ offset: bodyStart, size: bodyEnd - bodyStart });
      return out;
    }
    if (bodyStart >= bodyEnd) return out;
    var count = data[bodyStart] + 1;              // lacing count is byte - 1
    var p = bodyStart + 1;
    var sizes = [], i, guard;

    if (lacing === 1) {
      // ---- Xiph lacing: a sum of 255s terminated by one byte < 255 ----
      for (i = 0; i < count - 1; i++) {
        var sum = 0, b;
        guard = 0;
        do {
          if (p >= bodyEnd || guard++ > 255) return out;
          b = data[p++];
          sum += b;
        } while (b === 255);
        sizes.push(sum);
      }
    } else if (lacing === 2) {
      // ---- fixed size: the remainder is divided equally ----
      var each = Math.floor((bodyEnd - p) / count);
      for (i = 0; i < count - 1; i++) sizes.push(each);
      var used = each * (count - 1);
      sizes.push(Math.max(0, (bodyEnd - p) - used));
      if (each * count !== bodyEnd - p) {
        // Not divisible: the format requires equality, so flag it downstream.
        out.badFixed = true;
      }
    } else {
      // ---- EBML lacing: first size is an unsigned VINT, then signed deltas
      //      biased by 2^(7*len-1) - 1 ----
      var prev = null;
      for (i = 0; i < count - 1; i++) {
        var v = readVint(data, p, bodyEnd, false);
        if (!v) return out;
        p += v.len;
        if (prev === null) {
          prev = v.value;
        } else {
          var bias = Math.pow(2, 7 * v.len - 1) - 1;
          prev = prev + (v.value - bias);
        }
        if (prev < 0) prev = 0;
        sizes.push(prev);
      }
    }
    var declared = 0;
    for (i = 0; i < sizes.length; i++) declared += sizes[i];
    if (lacing !== 2) sizes.push(Math.max(0, (bodyEnd - p) - declared));
    var off = p;
    for (i = 0; i < sizes.length; i++) {
      var sz = Math.min(sizes[i], bodyEnd - off);
      if (sz > 0) out.push({ offset: off, size: sz });
      off += sizes[i];
      if (off > bodyEnd) break;
    }
    return out;
  }

  /** Emit the frames for one (Simple)Block element. */
  function emitBlock(data, el, isSimple, blockDurationNs, clusterTc, st, cn, blocksSeen) {
    var p = el.dataStart, end = el.dataEnd;
    if (p + 4 > end) return;
    var tv = readVint(data, p, end, false);
    if (!tv) return;
    var trackNum = tv.value;
    var q = p + tv.len;
    if (q + 3 > end) return;
    var rel = (data[q] << 8) | data[q + 1];
    if (rel > 0x7fff) rel -= 0x10000;
    var flags = data[q + 2];
    var lacing = (flags >> 1) & 3;
    var key = (flags & 0x80) !== 0;
    var bodyStart = q + 3;

    var tk = st.byNumber[trackNum];
    if (!tk) {
      if (!st.unknownTrackNoted[trackNum]) {
        st.unknownTrackNoted[trackNum] = 1;
        note(st, 'Block at ' + hex(el.start, 8) + ' references track ' + trackNum +
          ', which has no TrackEntry — the frames are skipped.');
      }
      return;
    }
    var key2 = codecKey(tk.codecId);
    var tType = TRACK_TYPES[tk.typeNum] || 'other';
    if (tType === 'subtitle' || tType === 'image' || tType === 'other') {
      // Subtitles are text payloads, not picture data — list the track only.
      st.skippedSubtitles[trackNum] = (st.skippedSubtitles[trackNum] || 0) + 1;
      return;
    }

    var laces = splitBlock(data, bodyStart, end, lacing);
    if (!laces.length) return;

    var baseNs = (clusterTc + rel) * st.timecodeScale;
    if (tk.codecDelay) baseNs -= tk.codecDelay;
    var laceNs = tk.defaultDuration ||
      (tType === 'audio' && tk.sampleRate
        ? (audioSamplesPerPacket(tk.codecId) || 0) * 1e9 / tk.sampleRate
        : 0);
    if (!laceNs && blockDurationNs && laces.length) laceNs = blockDurationNs / laces.length;

    var lengthSize = tk.lengthSize || 0;
    var ctxKey = tk.ctxKey || null;

    for (var i = 0; i < laces.length; i++) {
      if (st.frames.length >= MAX_FRAMES) {
        if (!st.frameCapNoted) {
          st.frameCapNoted = true;
          note(st, 'Frame list truncated at ' + MAX_FRAMES + ' entries — the file is longer than the analyser will list.');
        }
        return;
      }
      var lc = laces[i];
      var ptsNs = baseNs + i * laceNs;
      var f = {
        track: trackNum,
        index: 0,                                   // assigned once the list is sorted
        type: tType === 'video' ? (key ? 'I' : 'P') : 'audio',
        kind: tType === 'video' ? 'video' : 'audio',
        codec: key2 || tk.codecId || '',
        offset: lc.offset,
        size: lc.size,
        ptsSec: ptsNs / 1e9,
        dtsSec: ptsNs / 1e9,
        keyframe: tType === 'video' ? !!key : true,
        label: laces.length > 1 ? ('lace ' + (i + 1) + '/' + laces.length) : undefined,
        syn: {
          codec: key2 || tk.codecId || '',
          kind: 'sample',
          offset: lc.offset,
          size: lc.size,
          lengthSize: lengthSize,
          annexB: false,
          ctxKey: ctxKey
        }
      };
      if (laceNs > 0) f.durationSec = laceNs / 1e9;
      st.frames.push(f);
      tk.frameCount++;
      tk.bytes += lc.size;
    }

    if (cn && blocksSeen < MAX_BLOCKS_PER_CLUSTER) {
      var laceInfo = lacing === 0 ? '' : { 1: ' Xiph lacing x' + laces.length,
                                           2: ' fixed lacing x' + laces.length,
                                           3: ' EBML lacing x' + laces.length }[lacing];
      nodeField(cn, (isSimple ? 'SimpleBlock' : 'Block') + ' (track ' + trackNum + ')' +
        (key && tType === 'video' ? ' [key]' : ''),
        MA.formatSize(el.size - (bodyStart - el.dataStart)) + ' @ ' +
        (baseNs / 1e9).toFixed(3) + ' s' + (laceInfo || ''),
        el.start, el.headerLen + Math.min(el.size, 16));
    }
  }

  function scanCluster(data, el, st) {
    var addNode = st.clusterNodes < MAX_CLUSTER_NODES;
    var node = null;
    if (addNode) {
      node = makeNode('element', 'Cluster',
        'Cluster' + (el.unknown ? ' (unknown size)' : ''), el.start, el.headerLen + el.size);
      addHeaderFields(node, el);
      st.clusterNodes++;
    } else if (!st.clusterCapNoted) {
      st.clusterCapNoted = true;
      note(st, 'Structure tree stops listing clusters after ' + MAX_CLUSTER_NODES +
        ' entries — frame extraction continues to the end of the file.');
    }

    var clusterTc = st.pendingClusterTc || 0;
    var blocks = 0;
    st.pendingClusterTc = 0;

    eachChild(data, el, ID_CLUSTER, function (child) {
      try {
        if (child.id === ID_CLUSTER_TS) {
          clusterTc = readUInt(data, child.dataStart, child.dataEnd);
          if (node) nodeField(node, 'Timestamp', clusterTc + ' (' +
            (clusterTc * st.timecodeScale / 1e9).toFixed(3) + ' s)',
            child.dataStart, child.size);
        } else if (child.id === ID_SIMPLEBLOCK) {
          blocks++;
          emitBlock(data, child, true, 0, clusterTc, st, node, blocks);
        } else if (child.id === ID_BLOCKGROUP) {
          var blockEl = null, durNs = 0;
          eachChild(data, child, ID_BLOCKGROUP, function (g) {
            if (g.id === ID_BLOCK) blockEl = g;
            else if (g.id === 0x9B) durNs = readUInt(data, g.dataStart, g.dataEnd) * st.timecodeScale;
          });
          if (blockEl) {
            blocks++;
            emitBlock(data, blockEl, false, durNs, clusterTc, st, node, blocks);
          }
        } else if (child.id === 0x58D7 || child.id === 0xAB) {
          if (node) nodeField(node, ELS[child.id] ? ELS[child.id].name : 'Position',
            readUInt(data, child.dataStart, child.dataEnd), child.dataStart, child.size);
        } else if (child.id === ID_VOID || child.id === ID_CRC32) {
          /* padding / checksum — no value in the tree */
        } else if (node) {
          nodeNote(node, 'Unhandled element ' +
            (ELS[child.id] ? ELS[child.id].name : '0x' + child.id.toString(16)) +
            ' (' + child.size + ' bytes)');
        }
      } catch (e) {
        if (node) nodeNote(node, 'Block error: ' + msg(e));
      }
    });

    if (node) {
      if (blocks > MAX_BLOCKS_PER_CLUSTER) {
        nodeNote(node, '+ ' + (blocks - MAX_BLOCKS_PER_CLUSTER) + ' more blocks (not listed)');
      }
      st.segNode.children.push(node);
    }
    st.clusters++;
  }

  /* ==========================================================================
   * Info / SeekHead / Cues / Tags / Chapters / Attachments
   * ========================================================================*/

  function parseInfo(data, el, st) {
    var node = makeNode('element', 'Info', 'Segment Info', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    eachChild(data, el, ID_INFO, function (child) {
      var cn = scalarNode(data, child);
      node.children.push(cn);
      try {
        switch (child.id) {
          case 0x2AD7B1: st.timecodeScale = readUInt(data, child.dataStart, child.dataEnd); break;
          case 0x4489: st.durationRaw = readFloat(data, child.dataStart, child.dataEnd); break;
          case 0x4461: st.dateUTC = readSInt(data, child.dataStart, child.dataEnd); break;
          case 0x7BA9: st.title = elementValue(data, child, '8'); break;
          case 0x4D80: st.muxingApp = elementValue(data, child, '8'); break;
          case 0x5741: st.writingApp = elementValue(data, child, '8'); break;
          case 0x73A4: st.segmentUID = hexBytes(data, child.dataStart, child.dataEnd); break;
        }
      } catch (e) { nodeNote(cn, 'Decode error: ' + msg(e)); }
    });
    if (!st.timecodeScale || st.timecodeScale <= 0) st.timecodeScale = 1000000;
    return node;
  }

  function parseSeekHead(data, el, st) {
    var node = makeNode('element', 'SeekHead', 'SeekHead', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    var entries = 0;
    eachChild(data, el, ID_SEEKHEAD, function (seek) {
      if (seek.id !== 0x4DBB) {
        node.children.push(scalarNode(data, seek));
        return;
      }
      var sn = makeNode('element', 'Seek', 'Seek', seek.start, seek.headerLen + seek.size);
      addHeaderFields(sn, seek);
      eachChild(data, seek, 0x4DBB, function (c) {
        if (c.id === 0x53AB) {
          var target = 0;
          for (var i = c.dataStart; i < c.dataEnd && i < c.dataStart + 4; i++)
            target = target * 256 + data[i];
          var known = ELS[target];
          nodeField(sn, 'SeekID', hex(target, 8) + (known ? ' (' + known.name + ')' : ''),
            c.dataStart, c.size);
        } else if (c.id === 0x53AC) {
          var pos = readUInt(data, c.dataStart, c.dataEnd);
          nodeField(sn, 'SeekPosition', pos + ' (' + hex(el.start + pos, 8) + ')',
            c.dataStart, c.size);
        } else {
          nodeField(sn, ELS[c.id] ? ELS[c.id].name : '0x' + c.id.toString(16),
            readUInt(data, c.dataStart, c.dataEnd), c.dataStart, c.size);
        }
      });
      node.children.push(sn);
      entries++;
    });
    if (entries) nodeField(node, 'Entries', entries, el.dataStart, 0);
    return node;
  }

  function parseCues(data, el, st) {
    var node = makeNode('element', 'Cues', 'Cue Index', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    var points = 0, first = null, last = null, tracks = {};
    eachChild(data, el, ID_CUES, function (cue) {
      if (cue.id !== 0xBB) return;
      points++;
      eachChild(data, cue, 0xBB, function (c) {
        if (c.id === 0xB3) {
          var t = readUInt(data, c.dataStart, c.dataEnd);
          if (first === null) first = t;
          last = t;
        } else if (c.id === 0xB7) {
          eachChild(data, c, 0xB7, function (tp) {
            if (tp.id === 0xF7) tracks[readUInt(data, tp.dataStart, tp.dataEnd)] = 1;
          });
        }
      });
    });
    nodeField(node, 'Cue points', points, el.dataStart, 0);
    if (points) {
      nodeField(node, 'Time range',
        (first * st.timecodeScale / 1e9).toFixed(3) + ' s … ' +
        (last * st.timecodeScale / 1e9).toFixed(3) + ' s', el.dataStart, 0);
      nodeField(node, 'Tracks with cues', Object.keys(tracks).join(', '), el.dataStart, 0);
    }
    st.cuePoints = points;
    return node;
  }

  function parseTags(data, el, st) {
    var node = makeNode('element', 'Tags', 'Tags', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    var found = 0;
    function simpleTags(parentEl, parentNode, depth) {
      eachChild(data, parentEl, 0x67C8, function (tagEl) {
        var name = '', value = '', binary = false;
        eachChild(data, tagEl, 0x67C8, function (c) {
          if (c.id === 0x45A3) name = elementValue(data, c, '8');
          else if (c.id === 0x4487) value = elementValue(data, c, '8');
          else if (c.id === 0x4485) { binary = true; value = c.size + ' bytes'; }
          else if (c.id === 0x67C8 && depth < 4) { st.tagDepth = true; }
        });
        if (name) {
          parentNode.children.push(scalarTag(name, value, tagEl));
          st.result.metadata.push({ key: name, value: value });
          found++;
          st.tags.push({ name: name, value: value, binary: binary });
        }
        if (depth < 4) simpleTags(tagEl, parentNode, depth + 1);
      });
    }
    function scalarTag(name, value, tagEl) {
      var n = makeNode('element', name, name, tagEl.start, tagEl.headerLen + tagEl.size);
      nodeField(n, 'TagName', name, tagEl.start, 0);
      if (value !== '') nodeField(n, name, value, tagEl.start + tagEl.headerLen, Math.min(tagEl.size, 32));
      return n;
    }
    eachChild(data, el, ID_TAGS, function (tag) {
      if (tag.id !== 0x7373) return;
      var tn = makeNode('element', 'Tag', 'Tag', tag.start, tag.headerLen + tag.size);
      eachChild(data, tag, 0x7373, function (c) {
        if (c.id === 0x63C0) {
          eachChild(data, c, 0x63C0, function (t) {
            var nm = ELS[t.id] ? ELS[t.id].name : '0x' + t.id.toString(16);
            var v = ELS[t.id] && ELS[t.id].type === 's'
              ? elementValue(data, t, 's') : readUInt(data, t.dataStart, t.dataEnd);
            nodeField(tn, nm, v, t.dataStart, t.size);
          });
        } else if (c.id === 0x67C8) {
          var name = '', value = '';
          eachChild(data, c, 0x67C8, function (x) {
            if (x.id === 0x45A3) name = elementValue(data, x, '8');
            else if (x.id === 0x4487) value = elementValue(data, x, '8');
            else if (x.id === 0x4485) value = x.size + ' bytes (binary)';
          });
          if (name) {
            nodeField(tn, name, value, c.start, Math.min(c.size, 32));
            st.result.metadata.push({ key: name, value: value });
            found++;
          }
        }
      });
      node.children.push(tn);
    });
    if (found) nodeField(node, 'Simple tags', found, el.dataStart, 0);
    return node;
  }

  function parseChapters(data, el, st) {
    var node = makeNode('element', 'Chapters', 'Chapters', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    var count = 0;
    function atom(parentEl, parentNode) {
      eachChild(data, parentEl, 0xB6, function (a) {
        var cn = makeNode('element', 'ChapterAtom', 'Chapter', a.start, a.headerLen + a.size);
        var title = '', startNs = null, endNs = null;
        eachChild(data, a, 0xB6, function (c) {
          if (c.id === 0x91) startNs = readUInt(data, c.dataStart, c.dataEnd);
          else if (c.id === 0x92) endNs = readUInt(data, c.dataStart, c.dataEnd);
          else if (c.id === 0x80) {
            eachChild(data, c, 0x80, function (d) {
              if (d.id === 0x85) title = elementValue(data, d, '8');
              if (d.id === 0x437C) nodeField(cn, 'Language', elementValue(data, d, 's'), d.dataStart, d.size);
            });
          }
          else if (c.id === 0xB6) atom(c, cn);
        });
        nodeField(cn, 'Title', title || '(untitled)', a.start, 0);
        if (startNs != null) nodeField(cn, 'Start', (startNs / 1e9).toFixed(3) + ' s', a.start, 0);
        if (endNs != null) nodeField(cn, 'End', (endNs / 1e9).toFixed(3) + ' s', a.start, 0);
        if (title) st.chapters.push({ title: title, startSec: startNs == null ? null : startNs / 1e9 });
        parentNode.children.push(cn);
        count++;
      });
    }
    eachChild(data, el, ID_CHAPTERS, function (ed) {
      if (ed.id === 0x45B9) atom(ed, node);
    });
    nodeField(node, 'Atoms', count, el.dataStart, 0);
    return node;
  }

  function parseAttachments(data, el, st) {
    var node = makeNode('element', 'Attachments', 'Attachments', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    eachChild(data, el, ID_ATTACHMENTS, function (f) {
      if (f.id !== 0x61A7) return;
      var fn = makeNode('element', 'AttachedFile', 'AttachedFile', f.start, f.headerLen + f.size);
      var name = '', mime = '', size = 0, desc = '';
      eachChild(data, f, 0x61A7, function (c) {
        if (c.id === 0x466E) { name = elementValue(data, c, '8'); nodeField(fn, 'FileName', name, c.dataStart, Math.min(c.size, 64)); }
        else if (c.id === 0x4660) { mime = elementValue(data, c, 's'); nodeField(fn, 'FileMimeType', mime, c.dataStart, c.size); }
        else if (c.id === 0x467E) { desc = elementValue(data, c, '8'); nodeField(fn, 'FileDescription', desc, c.dataStart, Math.min(c.size, 64)); }
        else if (c.id === 0x465C) { size = c.size; nodeField(fn, 'FileData', MA.formatSize(c.size), c.dataStart, Math.min(c.size, 32)); }
        else if (c.id === 0x46AE) nodeField(fn, 'FileUID', readUInt(data, c.dataStart, c.dataEnd), c.dataStart, c.size);
      });
      if (name) st.attachments.push({ name: name, mime: mime, size: size, desc: desc });
      node.children.push(fn);
    });
    nodeField(node, 'Files', st.attachments.length, el.dataStart, 0);
    return node;
  }

  /* ==========================================================================
   * parse()
   * ========================================================================*/

  function msg(e) { return String((e && e.message) || e); }

  function parse(ctx) {
    var data = ctx.data;
    var result = {
      formatId: 'matroska',
      formatName: 'Matroska / WebM',
      durationSec: null,
      bitrate: null,
      tracks: [],
      metadata: [],
      structures: [],
      frames: [],
      notes: [],
      codecContexts: {}
    };

    var st = {
      data: data, result: result, notes: result.notes,
      timecodeScale: 1000000, durationRaw: null, docType: '',
      title: '', muxingApp: '', writingApp: '', dateUTC: null,
      segmentUID: '', cuePoints: 0, clusters: 0,
      tracks: [], byNumber: {}, contexts: result.codecContexts, configs: [],
      frames: result.frames, tags: [], chapters: [], attachments: [],
      clusterNodes: 0, clusterCapNoted: false, frameCapNoted: false,
      unknownTrackNoted: {}, skippedSubtitles: {}, pendingClusterTc: 0,
      elementGuard: 0, segNode: null
    };

    if (!data || data.length < 4) {
      note(st, 'File is too small to contain an EBML header.');
      return result;
    }

    /* ---- EBML header ---- */
    var head = readElement(data, 0, data.length);
    if (!head || head.id !== ID_EBML) {
      note(st, 'No EBML header at offset 0 — the file does not start like a Matroska/WebM stream.');
      return result;
    }
    var headNode = makeNode('element', 'EBML', 'EBML Header', 0, head.headerLen + head.size);
    addHeaderFields(headNode, head);
    eachChild(data, head, ID_EBML, function (child) {
      var cn = scalarNode(data, child);
      headNode.children.push(cn);
      var cat = ELS[child.id];
      if (!cat) return;
      switch (child.id) {
        case 0x4282: st.docType = elementValue(data, child, 's'); break;
        case 0x4287: st.docTypeVersion = elementValue(data, child, 'u'); break;
        case 0x42F2: st.maxIDLength = elementValue(data, child, 'u'); break;
        case 0x42F3: st.maxSizeLength = elementValue(data, child, 'u'); break;
      }
    });
    result.structures.push(headNode);

    var doc = (st.docType || '').toLowerCase();
    if (doc === 'webm') result.formatName = 'WebM (Matroska)';
    else if (doc === 'matroska') result.formatName = 'Matroska';
    else if (doc) result.formatName = 'Matroska (DocType "' + st.docType + '")';

    result.metadata.push({ key: 'DocType', value: st.docType || '(missing)' });
    if (st.docTypeVersion != null)
      result.metadata.push({ key: 'DocTypeVersion', value: st.docTypeVersion });
    result.metadata.push({ key: 'EBMLReadVersion', value: readUIntOf(data, head, 0x42F7) });
    result.metadata.push({ key: 'MuxingApp', value: st.muxingApp || '(none)' });
    result.metadata.push({ key: 'WritingApp', value: st.writingApp || '(none)' });

    /* ---- Segment ---- */
    var seg = null, p = head.dataEnd, guard = 0;
    while (p < data.length && guard++ < 4096) {
      var el = readElement(data, p, data.length);
      if (!el) break;
      if (el.id === ID_SEGMENT) { seg = el; break; }
      p = el.dataEnd;
      if (el.dataEnd <= p) break;
    }
    if (!seg) {
      note(st, 'Segment element not found — the file has an EBML header but no media.');
      return result;
    }
    if (seg.unknown) note(st, 'Segment has an unknown size (live/streamed WebM) — it is read up to the end of the file.');

    var segNode = makeNode('element', 'Segment',
      'Segment' + (seg.unknown ? ' (unknown size)' : ''), seg.start, seg.headerLen + seg.size);
    addHeaderFields(segNode, seg);
    result.structures.push(segNode);
    st.segNode = segNode;

    // Info carries the timecode scale, which every block timestamp needs, so
    // resolve it before walking the clusters.
    preScanInfo(data, seg, st);

    eachChild(data, seg, ID_SEGMENT, function (child) {
      try {
        switch (child.id) {
          case ID_INFO: {
            var infoNode = parseInfo(data, child, st);
            // Replace the scale guessed by the pre-scan with the real value.
            if (st.timecodeScale > 0) segNode.children.push(infoNode);
            break;
          }
          case ID_SEEKHEAD: segNode.children.push(parseSeekHead(data, child, st)); break;
          case ID_TRACKS: parseTracks(data, child, st); break;
          case ID_CLUSTER: scanCluster(data, child, st); break;
          case ID_CUES: segNode.children.push(parseCues(data, child, st)); break;
          case ID_TAGS: segNode.children.push(parseTags(data, child, st)); break;
          case ID_CHAPTERS: segNode.children.push(parseChapters(data, child, st)); break;
          case ID_ATTACHMENTS: segNode.children.push(parseAttachments(data, child, st)); break;
          case ID_VOID:
            segNode.children.push(scalarNode(data, child));
            break;
          case ID_CRC32:
            break;
          default: {
            var un = scalarNode(data, child);
            nodeNote(un, ELS[child.id] ? '' : 'Unknown element');
            segNode.children.push(un);
            break;
          }
        }
      } catch (e) {
        note(st, 'Segment child ' + (ELS[child.id] ? ELS[child.id].name : hex(child.id, 8)) +
          ' at ' + hex(child.start, 8) + ' failed: ' + msg(e));
      }
    });

    finalize(st);
    return result;
  }

  function readUIntOf(data, el, id) {
    var v = null;
    eachChild(data, el, ID_EBML, function (c) {
      if (c.id === id && v === null) v = readUInt(data, c.dataStart, c.dataEnd);
    });
    return v == null ? '(missing)' : v;
  }

  /** Cheap pre-pass so Cluster timestamps use the real TimestampScale. */
  function preScanInfo(data, seg, st) {
    var n = 0;
    eachChild(data, seg, ID_SEGMENT, function (child) {
      if (n++ > 16) return;
      if (child.id !== ID_INFO) return;
      eachChild(data, child, ID_INFO, function (c) {
        if (c.id === 0x2AD7B1) {
          var v = readUInt(data, c.dataStart, c.dataEnd);
          if (v > 0) st.timecodeScale = v;
        }
      });
    });
  }

  /* ==========================================================================
   * Tracks pass + final assembly
   * ========================================================================*/

  function parseTracks(data, el, st) {
    var node = makeNode('element', 'Tracks', 'Tracks', el.start, el.headerLen + el.size);
    addHeaderFields(node, el);
    nodeField(node, 'Track count', '(see TrackEntry children)', el.dataStart, 0);
    var tracksNodeIndex = st.segNode.children.length;
    st.segNode.children.push(node);

    eachChild(data, el, ID_TRACKS, function (child) {
      if (child.id !== ID_TRACKENTRY) {
        node.children.push(scalarNode(data, child));
        return;
      }
      try {
        var res = parseTrackEntry(data, child, st);
        node.children.push(res.node);
        st.tracks.push(res.tk);
        if (res.tk.number != null) st.byNumber[res.tk.number] = res.tk;
      } catch (e) {
        note(st, 'TrackEntry at ' + hex(child.start, 8) + ' failed: ' + msg(e));
      }
    });
    node.fields[2] = { name: 'Track count', value: st.tracks.length, offset: null, size: 0, note: true };
    void tracksNodeIndex;
    return node;
  }

  /** Build the public track objects, codec contexts and configuration frames. */
  function finalize(st) {
    var result = st.result, data = st.data;

    // ---- configuration records become header frames + track fields ----
    for (var i = 0; i < st.configs.length; i++) {
      var cfg = st.configs[i], tk = cfg.track, res = cfg.res;
      if (!res) continue;

      if (res.ctx && res.ctx.codec === 'h264') {
        var key = 'matroska:h264:' + (tk.number == null ? i : tk.number);
        result.codecContexts[key] = res.ctx;
        tk.ctxKey = key;
        tk.lengthSize = res.lengthSize || 4;
        if (res.info) {
          // PixelWidth/Height from the container wins when the parameter set is
          // truncated (a synthetic or damaged SPS gives nonsense geometry).
          if (res.info.width && (!res.info.incomplete || !tk.width)) {
            tk.width = res.info.width; tk.height = res.info.height;
          }
          tk.profile = res.info.profile || tk.profile;
          tk.level = res.info.level || tk.level;
          tk.bitDepth = tk.bitDepth || res.info.bitDepthLuma || null;
          tk.chromaFormat = res.info.chromaFormatIdc;
          tk.fps = tk.fps || res.info.fps || null;
        }
      } else if (res.ctx && res.ctx.codec === 'h265') {
        var hkey = 'matroska:h265:' + (tk.number == null ? i : tk.number);
        result.codecContexts[hkey] = res.ctx;
        tk.ctxKey = hkey;
        tk.lengthSize = res.lengthSize || 4;
        if (res.info) {
          if (res.info.width && (!res.info.incomplete || !tk.width)) {
            tk.width = res.info.width; tk.height = res.info.height;
          }
          tk.profile = res.info.profile || tk.profile;
          tk.level = res.info.level || tk.level;
          tk.bitDepth = tk.bitDepth || res.info.bitDepth || null;
        }
      } else if (res.info) {
        // Opus / Vorbis / AAC / FLAC describe the audio parameters themselves.
        if (res.info.sampleRate && !tk.sampleRate) tk.sampleRate = res.info.sampleRate;
        if (res.info.channels && !tk.channels) tk.channels = res.info.channels;
        if (res.info.bitDepth && !tk.bitDepth) tk.bitDepth = res.info.bitDepth;
        tk.codecInfo = res.info;
        if (res.info.profile && !tk.profile) tk.profile = res.info.profile;
      }
      if (res.tables && res.tables.length) {
        tk.headerTables = res.tables;
        st.frames.push({
          track: tk.number == null ? 0 : tk.number,
          index: 0,
          type: 'header',
          kind: 'header',
          codec: codecKey(tk.codecId) || tk.codecId || '',
          offset: cfg.offset,
          size: cfg.size,
          ptsSec: 0,
          dtsSec: 0,
          keyframe: true,
          label: 'CodecPrivate',
          tables: res.tables
        });
        tk.hasHeaderFrame = true;
      }
    }

    // ---- Opus always plays back at 48 kHz ----
    for (var t = 0; t < st.tracks.length; t++) {
      var tr = st.tracks[t];
      if (codecKey(tr.codecId) === 'opus') {
        tr.inputSampleRate = tr.codecInfo && tr.codecInfo.inputSampleRate;
        tr.preSkip = tr.codecInfo && tr.codecInfo.preSkip;
        tr.sampleRate = 48000;                     // RFC 6716: decoding is 48 kHz
        if (tr.preSkip && st.frames.length) { /* pre-skip shifts PTS below */ }
      }
    }

    // ---- sort frames by file offset (header frames included) ----
    st.frames.sort(function (a, b) {
      return (a.offset - b.offset) || ((a.ptsSec || 0) - (b.ptsSec || 0));
    });
    for (var fi = 0; fi < st.frames.length; fi++) st.frames[fi].index = fi;

    // ---- duration ----
    var duration = null;
    if (st.durationRaw != null && isFinite(st.durationRaw) && st.durationRaw > 0) {
      duration = st.durationRaw * st.timecodeScale / 1e9;
    }
    var endFromFrames = maxPts(st.frames);
    if (duration == null && endFromFrames != null) {
      duration = endFromFrames;
      note(st, 'Info/Duration is missing — the duration was taken from the last block timestamp.');
    }
    result.durationSec = duration;

    // ---- per-track summary ----
    for (var k = 0; k < st.tracks.length; k++) {
      var tk2 = st.tracks[k];
      var type = TRACK_TYPES[tk2.typeNum] || 'other';
      var codecId = tk2.codecId || '';
      var key2 = codecKey(codecId);
      var track = {
        id: tk2.number == null ? 0 : tk2.number,
        type: type,
        codec: key2 || codecId,
        codecName: codecName(codecId) || tk2.codecName || codecId || '(unknown codec)',
        profile: tk2.profile || null,
        level: tk2.level || null,
        width: type === 'video' ? (tk2.width || null) : null,
        height: type === 'video' ? (tk2.height || null) : null,
        fps: null,
        sampleRate: tk2.sampleRate ? Math.round(tk2.sampleRate) : null,
        channels: tk2.channels || null,
        channelLayout: channelLayout(key2, tk2),
        bitDepth: tk2.bitDepth || null,
        durationSec: duration,
        bitrate: null,
        streamSize: tk2.bytes || null,
        sampleCount: tk2.frameCount || 0,
        language: tk2.languageIETF || tk2.language || '',
        handlerName: tk2.codecName || tk2.name || '',
        extra: []
      };
      if (type === 'video') {
        if (tk2.defaultDuration) track.fps = 1e9 / tk2.defaultDuration;
        else if (duration > 0 && tk2.frameCount) track.fps = tk2.frameCount / duration;
      }
      if (duration > 0 && tk2.bytes) track.bitrate = Math.round(tk2.bytes * 8 / duration);
      if (track.bitrate == null && tk2.codecInfo && tk2.codecInfo.bitrateNominal > 0)
        track.bitrate = tk2.codecInfo.bitrateNominal;
      addTrackExtras(track, tk2, type, duration);
      result.tracks.push(track);
    }

    // ---- container level metadata ----
    result.metadata.push({ key: 'TimestampScale', value: st.timecodeScale + ' ns/tick' });
    if (st.durationRaw != null)
      result.metadata.push({ key: 'Duration (raw)', value: MA.formatNum(st.durationRaw) + ' ticks' });
    if (duration != null)
      result.metadata.push({ key: 'Duration', value: MA.formatDuration(duration) });
    if (st.title) result.metadata.push({ key: 'Title', value: st.title });
    if (st.dateUTC != null) {
      try {
        var when = new Date(Date.UTC(2001, 0, 1) + Math.round(st.dateUTC / 1e6));
        result.metadata.push({ key: 'DateUTC', value: when.toISOString().replace('T', ' ').replace('Z', ' UTC') });
      } catch (e) { /* out of range timestamp */ }
    }
    if (st.segmentUID) result.metadata.push({ key: 'SegmentUID', value: st.segmentUID });
    result.metadata.push({ key: 'Clusters', value: st.clusters });
    if (st.cuePoints) result.metadata.push({ key: 'Cue points', value: st.cuePoints });
    if (st.attachments.length) {
      result.metadata.push({ key: 'Attachments', value: st.attachments.length + ' (' +
        st.attachments.map(function (a) { return a.name; }).slice(0, 4).join(', ') +
        (st.attachments.length > 4 ? '…' : '') + ')' });
    }
    for (var c = 0; c < st.chapters.length && c < 16; c++) {
      var ch = st.chapters[c];
      result.metadata.push({ key: 'Chapter' + (c + 1),
        value: (ch.startSec == null ? '' : MA.formatDuration(ch.startSec) + ' ') + ch.title });
    }

    if (st.frames.length >= MAX_FRAMES && !st.frameCapNoted) {
      note(st, 'Only the first ' + MAX_FRAMES + ' frames were listed.');
    }
    for (var s in st.skippedSubtitles) {
      note(st, 'Track ' + s + ' is a subtitle track: ' + st.skippedSubtitles[s] +
        ' block(s) were not turned into frames.');
    }
    if (!st.frames.length) note(st, 'No media blocks were found in the Segment.');
    result.bitrate = (duration > 0) ? Math.round((st.data.length || 0) * 8 / duration) : null;
    if (result.bitrate == null && st.data.length)
      note(st, 'Bitrate could not be computed because the duration is unknown.');
  }

  function maxPts(frames) {
    var max = null;
    for (var i = 0; i < frames.length; i++) {
      var f = frames[i];
      if (f.kind === 'header') continue;
      var end = (f.ptsSec || 0) + (f.durationSec || 0);
      if (max === null || end > max) max = end;
    }
    return max;
  }

  /** Channel order for the mapping families we can name reliably. */
  function channelLayout(codec, tk) {
    var n = tk.channels;
    if (!n) return null;
    if (codec === 'opus' && tk.codecInfo && tk.codecInfo.mappingFamily !== 0) {
      return { 1: 'mono', 2: 'stereo', 3: '2.1', 4: 'quad', 5: '5.0', 6: '5.1 (Vorbis order)',
               7: '6.1', 8: '7.1 (Vorbis order)' }[n] || (n + ' channels (Vorbis order)');
    }
    if (codec === 'flac' || codec === 'vorbis' || codec === 'opus') {
      return { 1: 'mono', 2: 'stereo', 3: '3.0', 4: 'quad', 5: '5.0', 6: '5.1', 7: '6.1', 8: '7.1' }[n] ||
        (n + ' channels');
    }
    return n === 1 ? 'mono' : n === 2 ? 'stereo' : (n + ' channels');
  }

  function addTrackExtras(track, tk, type, duration) {
    var ex = track.extra;
    ex.push({ label: 'Codec ID', value: tk.codecId || '(none)' });
    if (tk.uid != null) ex.push({ label: 'Track UID', value: tk.uid });
    ex.push({ label: 'Track type', value: TRACK_TYPE_NAMES[tk.typeNum] || String(tk.typeNum) });
    if (tk.defaultDuration)
      ex.push({ label: 'DefaultDuration', value: tk.defaultDuration + ' ns (' +
        (1e9 / tk.defaultDuration).toFixed(3) + ' fps)' });
    if (tk.flagDefault != null) ex.push({ label: 'FlagDefault', value: tk.flagDefault });
    if (tk.flagLacing != null) ex.push({ label: 'FlagLacing', value: tk.flagLacing ? 'yes' : 'no' });
    if (tk.language) ex.push({ label: 'Language', value: tk.languageIETF || tk.language });
    if (tk.name) ex.push({ label: 'Track name', value: tk.name });
    if (tk.codecPrivate)
      ex.push({ label: 'CodecPrivate', value: MA.formatSize(tk.codecPrivate.size) + ' @ ' +
        hex(tk.codecPrivate.offset, 8) });
    if (type === 'video') {
      if (tk.width) ex.push({ label: 'Coded size', value: tk.width + ' x ' + tk.height });
      if (tk.displayWidth)
        ex.push({ label: 'Display size', value: tk.displayWidth + ' x ' + tk.displayHeight });
      if (tk.crop && (tk.crop.left || tk.crop.right || tk.crop.top || tk.crop.bottom))
        ex.push({ label: 'Pixel crop', value: 'L' + (tk.crop.left || 0) + ' R' + (tk.crop.right || 0) +
          ' T' + (tk.crop.top || 0) + ' B' + (tk.crop.bottom || 0) });
      if (tk.interlaced != null)
        ex.push({ label: 'FlagInterlaced', value: ['undetermined', 'progressive', 'interlaced'][tk.interlaced] || tk.interlaced });
      if (tk.stereoMode) ex.push({ label: 'StereoMode', value: tk.stereoMode });
      if (tk.alphaMode) ex.push({ label: 'AlphaMode', value: 'present (mode ' + tk.alphaMode + ')' });
      if (tk.chromaFormat != null)
        ex.push({ label: 'Chroma format', value: ['4:0:0', '4:2:0', '4:2:2', '4:4:4'][tk.chromaFormat] || tk.chromaFormat });
      if (tk.colour && (tk.colour.Primaries || tk.colour.Range != null)) {
        var c = tk.colour;
        ex.push({ label: 'Colour', value: 'primaries ' + (c.Primaries == null ? '?' : c.Primaries) +
          ', transfer ' + (c.TransferCharacteristics == null ? '?' : c.TransferCharacteristics) +
          ', matrix ' + (c.MatrixCoefficients == null ? '?' : c.MatrixCoefficients) +
          ', range ' + (c.Range ? 'full' : 'limited') });
      }
      if (tk.lengthSize) ex.push({ label: 'NAL length prefix', value: tk.lengthSize + ' bytes' });
    } else if (type === 'audio') {
      if (tk.outputSampleRate && Math.round(tk.outputSampleRate) !== Math.round(tk.sampleRate))
        ex.push({ label: 'Output sample rate', value: MA.formatHz(tk.outputSampleRate) });
      if (tk.codecInfo) {
        if (tk.codecInfo.inputSampleRate)
          ex.push({ label: 'Input sample rate', value: MA.formatHz(tk.codecInfo.inputSampleRate) +
            ' (playback is 48000 Hz)' });
        if (tk.codecInfo.preSkip != null)
          ex.push({ label: 'Pre-skip', value: tk.codecInfo.preSkip + ' samples (' +
            (tk.codecInfo.preSkip / 480).toFixed(2) + ' ms)' });
        if (tk.codecInfo.blocksize0)
          ex.push({ label: 'Vorbis blocksizes', value: tk.codecInfo.blocksize0 + ' / ' + tk.codecInfo.blocksize1 });
        if (tk.codecInfo.vendor)
          ex.push({ label: 'Vendor', value: tk.codecInfo.vendor });
        if (tk.codecInfo.minBlockSize)
          ex.push({ label: 'FLAC blocksize', value: tk.codecInfo.minBlockSize + '…' + tk.codecInfo.maxBlockSize });
        if (tk.codecInfo.totalSamples)
          ex.push({ label: 'Total samples', value: tk.codecInfo.totalSamples });
        if (tk.codecInfo.mappingFamily != null)
          ex.push({ label: 'Channel mapping family', value: tk.codecInfo.mappingFamily });
      }
    }
    if (tk.codecDelay) ex.push({ label: 'CodecDelay', value: tk.codecDelay + ' ns' });
    if (tk.seekPreRoll) ex.push({ label: 'SeekPreRoll', value: tk.seekPreRoll + ' ns' });
    if (tk.contentEncodings) ex.push({ label: 'ContentEncodings', value: 'present (data is compressed/encrypted)' });
    if (tk.frameCount)
      ex.push({ label: 'Frames', value: tk.frameCount + ' block payload(s)' });
    if (duration > 0 && tk.bytes)
      ex.push({ label: 'Track bytes', value: MA.formatSize(tk.bytes) });
  }

  MA.registerParser({ id: 'matroska', name: 'Matroska / WebM', parse: parse });
})(typeof globalThis !== 'undefined' ? globalThis : this);
