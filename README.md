# MediaAnalyzer

A pure front-end media file analyser — every byte is parsed in the browser, nothing is uploaded.
No build step, no dependencies, no bundler; open `index.html` and it runs.

Supports video (MP4/MOV/3GP, WebM/Matroska/MKV, FLV, ASF/WMV, TS/M2TS, AVI, Ogg Theora),
audio (MP3, AAC, FLAC, WAV, Ogg Vorbis/Opus/Speex, AC-3/E-AC-3, ASF WMA), images
(PNG/APNG, JPEG, GIF, WebP, BMP, HEIF/HEIC, AVIF), HLS playlists (M3U8) and raw elementary
streams (H.264, H.265, H.266, AV1, IVF). The codec syntax decoders cover H.264/H.265/H.266,
H.263, MPEG-1/2 Video, MPEG-4 Part 2, VP8/VP9, AV1/AV2, AAC, FLAC, MP3 and AC-3/E-AC-3.

---

## What it does

### Overview
Format identification, duration, bitrate, track list (codec, profile/level, resolution, frame
rate, sample rate, channels, bit depth, language), container metadata, an inline preview
where the browser can render one (image / `<audio>` / `<video>`), and — where the bitstream
carries it — an HDR summary (SMPTE ST 2086, CLLI, HDR10+, HDR Vivid).

### File structure
A tree of the container's own structures — MP4 boxes, Matroska EBML elements, ASF objects,
PNG chunks, RIFF chunks, TS tables, JPEG segments. Selecting a node shows its fields with their real byte
offsets; every field is a link that jumps into the hex view.

### Frame analysis
Every frame in **file storage order**, so audio and video interleave exactly as they sit on
disk. Columns: index, type, offset, size, codec, presentation time range and duration. The
table is filterable by kind and paged.

Clicking a frame decodes its syntax from the bitstream:

| Codec | Decoded |
|---|---|
| **H.264 / AVC** | `AVCDecoderConfigurationRecord`, `nal_unit_header()`, `seq_parameter_set_rbsp()` with full VUI + HRD, `pic_parameter_set_rbsp()`, `slice_header()`, `sei_rbsp()` with per-payload decoding |
| **H.265 / HEVC** | NAL header, `profile_tier_level()`, VPS / SPS / PPS, `st_ref_pic_set()`, `slice_segment_header()`, SEI |
| **H.266 / VVC** | 16-bit NAL header, `profile_tier_level()` + `general_constraints_info()`, VPS / SPS / PPS, picture header, APS, SEI |
| **H.263** | 22-bit start codes (picture / GOB), baseline and Plus picture header, CPFMT geometry — FLV Sorenson Spark and ASF "H263" payloads |
| **MPEG-1 / MPEG-2 Video** | Sequence / GOP / picture headers, sequence and picture-coding extensions, slices with their vertical position |
| **MPEG-4 Part 2** | Visual object sequence (profile / level), VOL geometry + timing, GOV time code, VOP headers (I / P / B / S) |
| **VP8** | Frame tag, key-frame start code and dimensions, segmentation, loop filter, token partitions, the six quantiser indices with their delta coding |
| **VP9** | Full uncompressed header: profile, `color_config()`, `frame_size()`, refs, loop filter, quantisation, segmentation, `tile_info()`; the compressed header is marked as range-coded |
| **AV1** | OBU walker, `sequence_header_obu()` with full `color_config()`, frame header, `AV1CodecConfigurationRecord` |
| **AV2** | OBU framing and the configuration record (see the note on the draft spec below) |
| **AAC** | `AudioSpecificConfig`, ADTS fixed + variable header |
| **FLAC** | STREAMINFO, metadata blocks, Vorbis comments, frame + subframe headers |
| **MP3** | Frame header with the full per-version bitrate tables, side information, ID3v2, Xing/LAME |
| **AC-3 / E-AC-3** | Both sync-frame layouts, told apart by `bsid` |

H.264, H.265 and H.266 also share the HDR SEI decoders: SMPTE ST 2086 mastering display
colour volume, CEA-861 content light level, HDR10+ (ST 2094-40), SL-HDR1/2/3 (ETSI
TS 103 433), HDR Vivid (GY/T 315) and alternative transfer characteristics.

The bottom tabs show the frame's own bytes and the original file preview.

### Hexadecimal
Paged hex + ASCII dump. Bytes belonging to a structure are tinted, bytes belonging to a frame
are tinted differently. The right panel lists the structures overlapping the current page;
clicking one selects it. Clicking a byte shows which structure (and which ancestor chain) owns
it. Shift-click extends a selection.

---

## Code layout

```
mediaAnalyzerB/
├── index.html              single page; plain <script> tags so file:// works
├── css/style.css           the whole theme
├── js/
│   ├── util.js             namespace, formatting, ByteReader, BitReader,
│   │                       SyntaxReader (+LSB variants), ByteSource, NAL helpers,
│   │                       structure-tree builders, the IVF reader, registries
│   ├── i18n.js             7 languages
│   ├── detector.js         format sniffing from the first 4 KB plus the extension
│   ├── framesyntax.js      resolves a frame's lazy recipe into syntax tables
│   ├── codecs/             h264 h265 h266 h263 mpeg2 mpeg4p2 vp8 vp9 av1 av2
│   │                       aac flac mp3 ac3, plus the shared hdr-sei decoders
│   ├── parsers/            mp4 matroska asf flv ts ogg audio images riff m3u8
│   │                       elementary
│   ├── ui/                 shell overview structure frames hex
│   └── app.js              language setup, drag & drop, URL loading, the load pipeline
```

### The parser contract

Every container parser registers itself and exposes one entry point:

```js
MA.registerParser({
  id: 'mp4', name: 'MP4 (ISO BMFF)',
  parse: function (ctx) { /* ... */ return result; }
});
```

`ctx` carries `data` (the whole file, valid only during the call), `bytes` (a lazy
`ByteSource`), `name`, `ext`, `size` and the detector's verdict. The result is always:

```js
{
  formatId, formatName, durationSec, bitrate, fileSize,
  tracks:       [{ id, type, codec, codecName, profile, level, width, height, fps,
                   sampleRate, channels, bitDepth, durationSec, bitrate, sampleCount,
                   language, extra: [{label, value}] }],
  structures:   [Node],                    // tree; Node = makeNode + nodeField
  frames:       [Frame],                   // sorted by file offset
  metadata:     [{ key, value }],          // ordered
  notes:        [String],                  // user-visible caveats
  codecContexts:{ key: ctx },              // referenced by frames[i].syn.ctxKey
  codecs:       // per-frame recipes
}
```

A `Frame` is
`{ track, index, type, kind, codec, offset, size, ptsSec, dtsSec, durationSec, keyframe,
   label?, tables?, syn? }`.

### Four invariants worth knowing before changing anything

**1. `nodeField` offsets are absolute.** The UI turns any field with a non-zero `size` into a
jump-to-hex link, so a guessed or zero offset produces a broken affordance. Use `size = 0`
when the extent is unknown, and `MA.nodeNote` (which sets `offset: null`) for free text.

**2. Frames never close over payload bytes.** The obvious implementation is

```js
frame.buildSyntax = () => bytes.range(frame.offset, frame.size).then(parse);
```

but that closure pins whatever the parser had in scope. For a transport stream that was the
reassembled PES payload, and a 131 MB stream kept ~170 MB of it alive after parsing finished.
Instead a frame carries a small recipe:

```js
frame.syn = { codec: 'h264', kind: 'sample', offset, size, lengthSize, ctxKey };
```

and `MA.buildFrameSyntax(result, frame, bytes)` resolves it on demand, reading exactly
`[offset, offset+size)`. For a PES whose packets are not contiguous in the file, `syn.parts`
lists the individual ranges and the resolver stitches them. Only header/config frames (of which
there are one or two) carry eager `tables`.

**3. Counts read out of the file are untrusted.** Every declared entry/sample count is clamped
with `MA.safeCount(n, availableBytes, minBytes)` before it is used to allocate or loop. Without
it a corrupt `stz2` count spins the bit-unpacking loop for billions of iterations and locks the
tab.

**4. The hex view never emits an element per byte.** The natural way to make a
byte clickable is a `<span>` per byte, and that is what this view originally did. At the
64 KB page size the selector offers, one page is 131 072 spans — the tab pegs a core
building them and then dies. Bytes that share a highlight class are grouped into a single
text run instead, so a page inside a large box costs roughly one run per line rather than
thirty-two elements. A single delegated listener on the grid recovers the clicked byte from
the caret position inside the run, which keeps byte picking working at every page size.
Measured on a 4 MB transport stream at 64 KB: 25 198 DOM nodes, flat across 40 re-entries.

### Memory model

The whole file is read once so parsers can work synchronously over it, then `bytes.release()`
drops that copy. Everything afterwards — hex paging, per-frame syntax, the media preview —
reads ranges back from the `File`/`Blob` (or from the HTTP source for online files), so a
large file costs one page of memory per interaction rather than its own size.

---

## Usage

Just open `index.html`. It works from `file://` because the scripts are plain `<script>` tags.

For the online-file feature a static server is nicer (some browsers restrict `fetch` on
`file://`):

```powershell
python -m http.server 8000     # then visit http://localhost:8000
```

Drag a file anywhere on the page, use **Open file**, or use **Open URL** for an HTTP(S) source.
HLS playlists are expanded online by fetching their segments over HTTP(S). 

---

## Notes and limitations

- **AV2 is a draft.** The OBU framing and the configuration record are decoded because they are
  stable; the sequence header internals are not, so those tables report the fields they can
  vouch for and say so. A wrong-but-plausible number would be worse than a gap.
- **VP9/AV1 compressed headers are range coded.** The uncompressed headers (where the
  dimensions, profile, colour config and reference structure live) are decoded in full; the
  boolean-coded remainder is labelled rather than guessed.
- **H.263 is baseline / Plus.** Picture, GOB and CPFMT headers are decoded; later annex
  extensions beyond the Plus picture header are not.
- **MPEG-1/2 and MPEG-4 Part 2 are header-level.** Sequence, VOL, picture and VOP headers are
  decoded; macroblock and motion-vector syntax is reported as payload, not reconstructed.
- **HEIF/HEIC/AVIF stills go through the ISO BMFF item model.** Every item and its properties
  are listed; animated sequences (`avis`, HEIC sequences) enumerate one image frame per item.
- **ASF/WMV and WMA codecs are identified, not decoded.** Only H.263, MPEG-4, AAC and MP3
  payloads in ASF carry per-frame syntax; Windows Media Video/Audio payloads are listed with
  their sample tables but no codec syntax.
- **Subtitle tracks** are listed and their samples are enumerable, but no timed-text syntax is
  decoded.
- **A format is only detected if a parser exists for it.** Naming a format the tool cannot open
  is a dead end, so AMR is deliberately absent; AC-3/E-AC-3 is supported and detected.
- **Codec and syntax terminology stays in English in every locale.** Translating
  `slice_qp_delta` would make it harder to match against the standard, not easier.
