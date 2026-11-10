/* ============================================================================
 * MediaAnalyzer — i18n.js
 *
 * UI localisation. Seven languages, English first (the default) followed by
 * Chinese, French, German, Russian, Spanish and Korean.
 *
 * Keys use a dotted `area.name` convention, e.g. `nav.overview`,
 * `fr.tabSyntax`. Anything missing from a language falls back to English and
 * then to the key itself, so a gap degrades to readable text rather than a
 * blank label.
 *
 * Note: strings produced by the parsers (codec names, syntax element names,
 * format names) are spec terminology and stay in English in every locale —
 * translating `slice_qp_delta` would make it harder to match against the
 * standard, not easier.
 * ==========================================================================*/
(function (root) {
  'use strict';

  var MA = (root.MA = root.MA || {});

  var LANGUAGES = [
    { code: 'en', name: 'English' },
    { code: 'zh', name: '中文' },
    { code: 'fr', name: 'Français' },
    { code: 'de', name: 'Deutsch' },
    { code: 'ru', name: 'Русский' },
    { code: 'es', name: 'Español' },
    { code: 'ko', name: '한국어' }
  ];

  var DICT = {

  /* ======================================================== English ==== */
  en: {
    'app.title': 'Media File Analyzer',
    'app.slogan': 'Parse every detail of the media',
    'app.localOnly': '100% local processing',
    'app.openFile': 'Open file',
    'app.openUrl': 'Open URL',
    'app.dropOverlay': 'Drop the media file to analyze',
    'app.tagline': 'Parse every detail of the media',

    'nav.menu': 'Menu',
    'nav.overview': 'Overview',
    'nav.structure': 'File structure',
    'nav.frames': 'Frame analysis',
    'nav.hex': 'Hexadecimal',

    'welcome.title': 'Media File Analyzer',
    'welcome.desc': 'Parse containers, tracks and codec syntax directly in your browser.\nVideo: MP4, MOV, MKV, WebM, Ogg, FLV, TS, ASF, 264 and more;\nAudio: AAC, FLAC, MP3, M4A, Ogg and more;\nImages: JPEG, PNG, GIF, WebP, BMP, APNG, HEIC, AVIF and more;\nCodecs: H26x, VPx, AV1, AV2, MPEG2, MPEG4, AAC, FLAC, AC3, MP4, Vorbis, Opus',
    'welcome.drop': 'Drop a media file here',
    'welcome.or': 'or',
    'welcome.browse': 'Choose file',
    'welcome.online': 'Online file…',
    'welcome.hint': 'Online files are fetched via HTTP(S); HLS is supported.',
    'welcome.formats': 'Supported formats',

    'url.title': 'Open an online media file',
    'url.placeholder': 'https://example.com/video.mp4',
    'url.hint': 'Online files are fetched via HTTP(S); HLS is supported.',
    'url.analyze': 'Analyze',
    'url.cancel': 'Cancel',

    'ov.fileName': 'File name',
    'ov.format': 'Format',
    'ov.size': 'File size',
    'ov.duration': 'Duration',
    'ov.bitrate': 'Bitrate',
    'ov.streamSize': 'Stream size',
    'ov.images': 'Images',
    'ov.image': 'Image',
    'ov.params': 'Encoding parameters',
    'ov.tracks': 'Tracks',
    'ov.trackCount': '{n} track(s)',
    'ov.preview': 'Preview',
    'ov.collapse': 'Collapse',
    'ov.expand': 'Expand',
    'ov.zoom': 'Click to view full size',
    'ov.noPreview': 'No inline preview is available for this format.',
    'ov.webUnsupported': 'The browser cannot play this format.',
    'ov.rsContainer': 'Reason: the {fmt} container is not supported by browsers.',
    'ov.rsImage': 'Reason: browsers cannot decode {fmt} images.',
    'ov.rsCodec': 'Reason: the browser cannot decode {codec}.',
    'ov.overview': 'Summary',
    'ov.video': 'Video',
    'ov.audio': 'Audio',
    'ov.trackId': 'Track ID',
    'ov.type': 'Type',
    'ov.codec': 'Codec',
    'ov.profile': 'Profile',
    'ov.level': 'Level',
    'ov.resolution': 'Resolution',
    'ov.fps': 'Frame rate',
    'ov.sampleRate': 'Sample rate',
    'ov.channels': 'Channels',
    'ov.bitDepth': 'Bit depth',
    'ov.language': 'Language',
    'ov.samples': 'Samples',
    'ov.metadata': 'Metadata',
    'ov.notes': 'Notes',
    'ov.extra': 'Details',
    'ov.noMetadata': 'This file carries no container metadata.',

    'tr.video': 'Video', 'tr.audio': 'Audio', 'tr.subtitle': 'Subtitle',
    'tr.image': 'Image', 'tr.other': 'Other', 'tr.header': 'Header',

    'st.search': 'Filter boxes…',
    'st.details': 'Details',
    'st.selectNode': 'Select a node in the tree to inspect its fields.',
    'st.type': 'Type', 'st.size': 'Size', 'st.offset': 'Offset',
    'st.children': 'Children', 'st.fields': 'Fields', 'st.field': 'Field',
    'st.value': 'Value', 'st.noMatch': 'No node matches the filter.',
    'st.structure': 'Structure', 'st.viewInHex': 'View in hex',

    'fr.filter': 'Filter',
    'fr.all': 'All',
    'fr.perPage': 'Rows per page',
    'fr.perPageOption': '{n} / page',
    'fr.index': '#', 'fr.type': 'Type', 'fr.offset': 'Offset',
    'fr.size': 'Size', 'fr.codec': 'Codec', 'fr.time': 'Time (start – end)',
    'fr.duration': 'Duration', 'fr.keyframe': 'Key frame',
    'fr.selectFrame': 'Select a frame to inspect its codec syntax.',
    'fr.tabSyntax': 'Codec syntax', 'fr.tabHex': 'Hex data', 'fr.tabPreview': 'Preview',
    'fr.noSyntax': 'No syntax detail is available for this frame.',
    'fr.track': 'Track', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': 'Go', 'fr.frameNo': '#',
    'fr.page': 'Page', 'fr.of': 'of', 'fr.total': '{n} frames in total',
    'fr.prev': 'Previous', 'fr.next': 'Next', 'fr.empty': 'No frames to show.',
    'fr.previewHint': 'The original file is shown for reference.',
    'fr.rawBytes': 'Raw bytes',

    'hex.rowsPerPage': 'Rows per page',
    'hex.address': 'Address',
    'hex.go': 'Go',
    'hex.page': 'Page', 'hex.of': 'of', 'hex.totalBytes': '{n} bytes in total',
    'hex.prev': 'Previous', 'hex.next': 'Next',
    'hex.structures': 'Structures on this page',
    'hex.noStructures': 'No structure starts on this page.',
    'hex.selection': 'Selection',
    'hex.none': 'Click a byte to see the structure it belongs to.',

    'msg.loading': 'Analyzing…',
    'msg.parseFailed': 'Could not parse the file: {msg}',
    'msg.unsupported': 'Unrecognised file format.',
    'msg.noFile': 'Please open a media file first.',
    'msg.empty': 'The file is empty.',
    'msg.tooLarge': 'The file is too large ({size}). The limit is {limit}.',
    'msg.httpError': 'The remote file could not be fetched: {msg}',
    'msg.rtmp': 'Browsers cannot open RTMP/RTSP streams. Use an HTTP(S) URL.',
    'msg.partial': 'The file was only partially analyzed.',

    'common.yes': 'Yes', 'common.no': 'No',
    'common.close': 'Close', 'common.copy': 'Copy',
    'common.unknown': 'Unknown', 'common.none': 'None'
  },

  /* =========================================================== 中文 ==== */
  zh: {
    'app.title': '媒体文件解析工具',
    'app.slogan': '解析媒体的每处信息',
    'app.localOnly': '全程本地处理',
    'app.openFile': '打开文件',
    'app.openUrl': '在线文件',
    'app.dropOverlay': '松开鼠标解析该媒体文件',
    'app.tagline': '解析媒体的每处信息',

    'nav.menu': '功能菜单',
    'nav.overview': '媒体概览',
    'nav.structure': '文件结构',
    'nav.frames': '帧解析',
    'nav.hex': '十六进制',

    'welcome.title': '媒体文件解析工具',
    'welcome.desc': '在浏览器中直接解析容器、轨道与编解码语法。\n支持视频：MP4、MOV、MKV、Webm、Ogg、FLV、TS、asf、264等；\n支持音频：AAC、FLAC、MP3、M4A、Ogg等；\n支持图片：JPEG、PNG、GIF、Webp、BMP、APNG、HEIC、AVIF 等；\n支持Codec：H26x、VPx、AV1、AV2、MPEG2、MPEG4、AAC、FLAC、AC3、MP4、Vorbis、Opus',
    'welcome.drop': '将媒体文件拖到此处',
    'welcome.or': '或',
    'welcome.browse': '选择文件',
    'welcome.online': '在线文件…',
    'welcome.hint': '在线文件通过 HTTP(S)获取；支持HLS。',
    'welcome.formats': '支持的格式',

    'url.title': '打开在线媒体文件',
    'url.placeholder': 'https://example.com/video.mp4',
    'url.hint': '在线文件通过 HTTP(S)获取；支持HLS。',
    'url.analyze': '解析',
    'url.cancel': '取消',

    'ov.fileName': '文件名',
    'ov.format': '格式',
    'ov.size': '文件大小',
    'ov.duration': '时长',
    'ov.bitrate': '码率',
    'ov.streamSize': '流大小',
    'ov.images': '图片列表',
    'ov.image': '图片',
    'ov.params': '编码参数',
    'ov.tracks': '轨道',
    'ov.trackCount': '{n} 条轨道',
    'ov.preview': '预览',
    'ov.collapse': '收起',
    'ov.expand': '展开',
    'ov.zoom': '点击查看大图',
    'ov.noPreview': '该格式不支持内嵌预览。',
    'ov.webUnsupported': 'Web 不支持播放该格式。',
    'ov.rsContainer': '原因：浏览器不支持 {fmt} 容器。',
    'ov.rsImage': '原因：浏览器无法解码 {fmt} 图像。',
    'ov.rsCodec': '原因：浏览器无法解码 {codec} 编码。',
    'ov.overview': '整体信息',
    'ov.video': '视频',
    'ov.audio': '音频',
    'ov.trackId': '轨道 ID',
    'ov.type': '类型',
    'ov.codec': '编码格式',
    'ov.profile': '档次',
    'ov.level': '级别',
    'ov.resolution': '分辨率',
    'ov.fps': '帧率',
    'ov.sampleRate': '采样率',
    'ov.channels': '声道数',
    'ov.bitDepth': '位深',
    'ov.language': '语言',
    'ov.samples': '样本数',
    'ov.metadata': '元数据',
    'ov.notes': '备注',
    'ov.extra': '详细信息',
    'ov.noMetadata': '该文件不包含容器元数据。',

    'tr.video': '视频', 'tr.audio': '音频', 'tr.subtitle': '字幕',
    'tr.image': '图片', 'tr.other': '其他', 'tr.header': '头信息',

    'st.search': '搜索 Box 名称…',
    'st.details': '详细信息',
    'st.selectNode': '在左侧结构树中选择一个节点以查看其字段。',
    'st.type': '类型', 'st.size': '大小', 'st.offset': '偏移',
    'st.children': '子节点', 'st.fields': '字段', 'st.field': '字段',
    'st.value': '值', 'st.noMatch': '没有匹配的节点。',
    'st.structure': '结构', 'st.viewInHex': '在十六进制中查看',

    'fr.filter': '筛选',
    'fr.all': '全部',
    'fr.perPage': '每页条数',
    'fr.perPageOption': '{n} 条 / 页',
    'fr.index': '#', 'fr.type': '类型', 'fr.offset': '偏移',
    'fr.size': '大小', 'fr.codec': '编码格式', 'fr.time': '时间（起 – 止）',
    'fr.duration': '时长', 'fr.keyframe': '关键帧',
    'fr.selectFrame': '选择一帧以查看其编解码语法。',
    'fr.tabSyntax': '编解码语法', 'fr.tabHex': '十六进制数据', 'fr.tabPreview': '预览',
    'fr.noSyntax': '该帧没有可用的语法信息。',
    'fr.track': '轨道', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': '跳转', 'fr.frameNo': '帧号',
    'fr.page': '第', 'fr.of': '/', 'fr.total': '共 {n} 条',
    'fr.prev': '上一页', 'fr.next': '下一页', 'fr.empty': '没有可显示的帧。',
    'fr.previewHint': '此处显示原始文件以供参考。',
    'fr.rawBytes': '原始字节',

    'hex.rowsPerPage': '每页大小',
    'hex.address': '地址',
    'hex.go': '跳转',
    'hex.page': '第', 'hex.of': '/', 'hex.totalBytes': '共 {n} 字节',
    'hex.prev': '上一页', 'hex.next': '下一页',
    'hex.structures': '本页涉及的结构',
    'hex.noStructures': '本页没有结构起始。',
    'hex.selection': '选中内容',
    'hex.none': '点击某个字节可查看它所属的结构。',

    'msg.loading': '正在解析…',
    'msg.parseFailed': '无法解析该文件：{msg}',
    'msg.unsupported': '无法识别的文件格式。',
    'msg.noFile': '请先打开一个媒体文件。',
    'msg.empty': '文件为空。',
    'msg.tooLarge': '文件过大（{size}），上限为 {limit}。',
    'msg.httpError': '无法获取远程文件：{msg}',
    'msg.rtmp': '浏览器无法打开 RTMP/RTSP 流，请使用 HTTP(S) 地址。',
    'msg.partial': '文件仅被部分解析。',

    'common.yes': '是', 'common.no': '否',
    'common.close': '关闭', 'common.copy': '复制',
    'common.unknown': '未知', 'common.none': '无'
  },

  /* ======================================================= Français ==== */
  fr: {
    'app.title': 'Analyseur de fichiers multimédias',
    'app.slogan': 'Analyser chaque information du média',
    'app.localOnly': 'Traitement 100 % local',
    'app.openFile': 'Ouvrir un fichier',
    'app.openUrl': 'Ouvrir une URL',
    'app.dropOverlay': 'Déposez le fichier multimédia à analyser',
    'app.tagline': 'Analyser chaque information du média',

    'nav.menu': 'Menu',
    'nav.overview': 'Aperçu',
    'nav.structure': 'Structure du fichier',
    'nav.frames': 'Analyse des trames',
    'nav.hex': 'Hexadécimal',

    'welcome.title': 'Analyseur de fichiers multimédias',
    'welcome.desc': 'Analysez les conteneurs, les pistes et la syntaxe des codecs directement dans le navigateur.\nVidéo : MP4, MOV, MKV, WebM, Ogg, FLV, TS, ASF, 264 et plus ;\nAudio : AAC, FLAC, MP3, M4A, Ogg et plus ;\nImages : JPEG, PNG, GIF, WebP, BMP, APNG, HEIC, AVIF et plus ;\nCodecs : H26x, VPx, AV1, AV2, MPEG2, MPEG4, AAC, FLAC, AC3, MP4, Vorbis, Opus',
    'welcome.drop': 'Déposez un fichier multimédia ici',
    'welcome.or': 'ou',
    'welcome.browse': 'Choisir un fichier',
    'welcome.online': 'Fichier en ligne…',
    'welcome.hint': 'Les fichiers en ligne sont récupérés via HTTP(S) ; HLS est pris en charge.',
    'welcome.formats': 'Formats pris en charge',

    'url.title': 'Ouvrir un fichier multimédia en ligne',
    'url.placeholder': 'https://exemple.com/video.mp4',
    'url.hint': 'Les fichiers en ligne sont récupérés via HTTP(S) ; HLS est pris en charge.',
    'url.analyze': 'Analyser',
    'url.cancel': 'Annuler',

    'ov.fileName': 'Nom du fichier',
    'ov.format': 'Format',
    'ov.size': 'Taille du fichier',
    'ov.duration': 'Durée',
    'ov.bitrate': 'Débit',
    'ov.streamSize': 'Taille du flux',
    'ov.images': 'Images',
    'ov.image': 'Image',
    'ov.params': 'Paramètres d’encodage',
    'ov.tracks': 'Pistes',
    'ov.trackCount': '{n} piste(s)',
    'ov.preview': 'Aperçu',
    'ov.collapse': 'Réduire',
    'ov.expand': 'Développer',
    'ov.zoom': 'Cliquer pour agrandir',
    'ov.noPreview': 'Aucun aperçu intégré n’est disponible pour ce format.',
    'ov.webUnsupported': 'Le navigateur ne peut pas lire ce format.',
    'ov.rsContainer': 'Raison : le navigateur ne prend pas en charge le conteneur {fmt}.',
    'ov.rsImage': 'Raison : le navigateur ne peut pas décoder les images {fmt}.',
    'ov.rsCodec': 'Raison : le navigateur ne peut pas décoder {codec}.',
    'ov.overview': 'Résumé',
    'ov.video': 'Vidéo',
    'ov.audio': 'Audio',
    'ov.trackId': 'ID de piste',
    'ov.type': 'Type',
    'ov.codec': 'Codec',
    'ov.profile': 'Profil',
    'ov.level': 'Niveau',
    'ov.resolution': 'Résolution',
    'ov.fps': 'Fréquence d’images',
    'ov.sampleRate': 'Fréquence d’échantillonnage',
    'ov.channels': 'Canaux',
    'ov.bitDepth': 'Profondeur de bits',
    'ov.language': 'Langue',
    'ov.samples': 'Échantillons',
    'ov.metadata': 'Métadonnées',
    'ov.notes': 'Remarques',
    'ov.extra': 'Détails',
    'ov.noMetadata': 'Ce fichier ne contient pas de métadonnées de conteneur.',

    'tr.video': 'Vidéo', 'tr.audio': 'Audio', 'tr.subtitle': 'Sous-titres',
    'tr.image': 'Image', 'tr.other': 'Autre', 'tr.header': 'En-tête',

    'st.search': 'Filtrer les boîtes…',
    'st.details': 'Détails',
    'st.selectNode': 'Sélectionnez un nœud dans l’arborescence pour voir ses champs.',
    'st.type': 'Type', 'st.size': 'Taille', 'st.offset': 'Décalage',
    'st.children': 'Enfants', 'st.fields': 'Champs', 'st.field': 'Champ',
    'st.value': 'Valeur', 'st.noMatch': 'Aucun nœud ne correspond au filtre.',
    'st.structure': 'Structure', 'st.viewInHex': 'Voir en hexadécimal',

    'fr.filter': 'Filtrer',
    'fr.all': 'Tout',
    'fr.perPage': 'Lignes par page',
    'fr.perPageOption': '{n} / page',
    'fr.index': 'N°', 'fr.type': 'Type', 'fr.offset': 'Décalage',
    'fr.size': 'Taille', 'fr.codec': 'Codec', 'fr.time': 'Temps (début – fin)',
    'fr.duration': 'Durée', 'fr.keyframe': 'Image clé',
    'fr.selectFrame': 'Sélectionnez une trame pour voir sa syntaxe de codec.',
    'fr.tabSyntax': 'Syntaxe du codec', 'fr.tabHex': 'Données hexadécimales',
    'fr.tabPreview': 'Aperçu',
    'fr.noSyntax': 'Aucun détail de syntaxe n’est disponible pour cette trame.',
    'fr.track': 'Piste', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': 'Aller', 'fr.frameNo': 'N°',
    'fr.page': 'Page', 'fr.of': 'sur', 'fr.total': '{n} trames au total',
    'fr.prev': 'Précédent', 'fr.next': 'Suivant', 'fr.empty': 'Aucune trame à afficher.',
    'fr.previewHint': 'Le fichier d’origine est affiché pour référence.',
    'fr.rawBytes': 'Octets bruts',

    'hex.rowsPerPage': 'Lignes par page',
    'hex.address': 'Adresse',
    'hex.go': 'Aller',
    'hex.page': 'Page', 'hex.of': 'sur', 'hex.totalBytes': '{n} octets au total',
    'hex.prev': 'Précédent', 'hex.next': 'Suivant',
    'hex.structures': 'Structures de cette page',
    'hex.noStructures': 'Aucune structure ne commence sur cette page.',
    'hex.selection': 'Sélection',
    'hex.none': 'Cliquez sur un octet pour voir la structure à laquelle il appartient.',

    'msg.loading': 'Analyse en cours…',
    'msg.parseFailed': 'Impossible d’analyser le fichier : {msg}',
    'msg.unsupported': 'Format de fichier non reconnu.',
    'msg.noFile': 'Veuillez d’abord ouvrir un fichier multimédia.',
    'msg.empty': 'Le fichier est vide.',
    'msg.tooLarge': 'Le fichier est trop volumineux ({size}). La limite est {limit}.',
    'msg.httpError': 'Le fichier distant n’a pas pu être récupéré : {msg}',
    'msg.rtmp': 'Les navigateurs ne peuvent pas ouvrir les flux RTMP/RTSP. Utilisez une URL HTTP(S).',
    'msg.partial': 'Le fichier n’a été analysé que partiellement.',

    'common.yes': 'Oui', 'common.no': 'Non',
    'common.close': 'Fermer', 'common.copy': 'Copier',
    'common.unknown': 'Inconnu', 'common.none': 'Aucun'
  },

  /* ======================================================== Deutsch ==== */
  de: {
    'app.title': 'Mediendatei-Analysator',
    'app.slogan': 'Jede Information des Mediums analysieren',
    'app.localOnly': '100 % lokale Verarbeitung',
    'app.openFile': 'Datei öffnen',
    'app.openUrl': 'URL öffnen',
    'app.dropOverlay': 'Mediendatei zum Analysieren ablegen',
    'app.tagline': 'Jede Information des Mediums analysieren',

    'nav.menu': 'Menü',
    'nav.overview': 'Übersicht',
    'nav.structure': 'Dateistruktur',
    'nav.frames': 'Frame-Analyse',
    'nav.hex': 'Hexadezimal',

    'welcome.title': 'Mediendatei-Analysator',
    'welcome.desc': 'Container, Spuren und Codec-Syntax direkt im Browser analysieren.\nVideo: MP4, MOV, MKV, WebM, Ogg, FLV, TS, ASF, 264 und mehr;\nAudio: AAC, FLAC, MP3, M4A, Ogg und mehr;\nBilder: JPEG, PNG, GIF, WebP, BMP, APNG, HEIC, AVIF und mehr;\nCodecs: H26x, VPx, AV1, AV2, MPEG2, MPEG4, AAC, FLAC, AC3, MP4, Vorbis, Opus',
    'welcome.drop': 'Mediendatei hier ablegen',
    'welcome.or': 'oder',
    'welcome.browse': 'Datei auswählen',
    'welcome.online': 'Online-Datei…',
    'welcome.hint': 'Online-Dateien werden über HTTP(S) abgerufen; HLS wird unterstützt.',
    'welcome.formats': 'Unterstützte Formate',

    'url.title': 'Online-Mediendatei öffnen',
    'url.placeholder': 'https://beispiel.de/video.mp4',
    'url.hint': 'Online-Dateien werden über HTTP(S) abgerufen; HLS wird unterstützt.',
    'url.analyze': 'Analysieren',
    'url.cancel': 'Abbrechen',

    'ov.fileName': 'Dateiname',
    'ov.format': 'Format',
    'ov.size': 'Dateigröße',
    'ov.duration': 'Dauer',
    'ov.bitrate': 'Bitrate',
    'ov.streamSize': 'Datenstromgröße',
    'ov.images': 'Bilder',
    'ov.image': 'Bild',
    'ov.params': 'Kodierungsparameter',
    'ov.tracks': 'Spuren',
    'ov.trackCount': '{n} Spur(en)',
    'ov.preview': 'Vorschau',
    'ov.collapse': 'Einklappen',
    'ov.expand': 'Ausklappen',
    'ov.zoom': 'Klicken für Vollbild',
    'ov.noPreview': 'Für dieses Format ist keine eingebettete Vorschau verfügbar.',
    'ov.webUnsupported': 'Der Browser kann dieses Format nicht wiedergeben.',
    'ov.rsContainer': 'Grund: Der Browser unterstützt den Container {fmt} nicht.',
    'ov.rsImage': 'Grund: Der Browser kann {fmt}-Bilder nicht dekodieren.',
    'ov.rsCodec': 'Grund: Der Browser kann {codec} nicht dekodieren.',
    'ov.overview': 'Zusammenfassung',
    'ov.video': 'Video',
    'ov.audio': 'Audio',
    'ov.trackId': 'Spur-ID',
    'ov.type': 'Typ',
    'ov.codec': 'Codec',
    'ov.profile': 'Profil',
    'ov.level': 'Level',
    'ov.resolution': 'Auflösung',
    'ov.fps': 'Bildrate',
    'ov.sampleRate': 'Abtastrate',
    'ov.channels': 'Kanäle',
    'ov.bitDepth': 'Bittiefe',
    'ov.language': 'Sprache',
    'ov.samples': 'Samples',
    'ov.metadata': 'Metadaten',
    'ov.notes': 'Hinweise',
    'ov.extra': 'Details',
    'ov.noMetadata': 'Diese Datei enthält keine Container-Metadaten.',

    'tr.video': 'Video', 'tr.audio': 'Audio', 'tr.subtitle': 'Untertitel',
    'tr.image': 'Bild', 'tr.other': 'Sonstiges', 'tr.header': 'Kopf',

    'st.search': 'Boxen filtern…',
    'st.details': 'Details',
    'st.selectNode': 'Wählen Sie einen Knoten im Baum, um seine Felder zu sehen.',
    'st.type': 'Typ', 'st.size': 'Größe', 'st.offset': 'Offset',
    'st.children': 'Kinder', 'st.fields': 'Felder', 'st.field': 'Feld',
    'st.value': 'Wert', 'st.noMatch': 'Kein Knoten entspricht dem Filter.',
    'st.structure': 'Struktur', 'st.viewInHex': 'In Hexadezimal anzeigen',

    'fr.filter': 'Filter',
    'fr.all': 'Alle',
    'fr.perPage': 'Zeilen pro Seite',
    'fr.perPageOption': '{n} / Seite',
    'fr.index': 'Nr.', 'fr.type': 'Typ', 'fr.offset': 'Offset',
    'fr.size': 'Größe', 'fr.codec': 'Codec', 'fr.time': 'Zeit (Start – Ende)',
    'fr.duration': 'Dauer', 'fr.keyframe': 'Schlüsselbild',
    'fr.selectFrame': 'Wählen Sie einen Frame, um seine Codec-Syntax zu sehen.',
    'fr.tabSyntax': 'Codec-Syntax', 'fr.tabHex': 'Hexadezimaldaten', 'fr.tabPreview': 'Vorschau',
    'fr.noSyntax': 'Für diesen Frame sind keine Syntaxdetails verfügbar.',
    'fr.track': 'Spur', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': 'Los', 'fr.frameNo': 'Nr.',
    'fr.page': 'Seite', 'fr.of': 'von', 'fr.total': '{n} Frames insgesamt',
    'fr.prev': 'Zurück', 'fr.next': 'Weiter', 'fr.empty': 'Keine Frames anzuzeigen.',
    'fr.previewHint': 'Die Originaldatei wird als Referenz angezeigt.',
    'fr.rawBytes': 'Rohbytes',

    'hex.rowsPerPage': 'Zeilen pro Seite',
    'hex.address': 'Adresse',
    'hex.go': 'Los',
    'hex.page': 'Seite', 'hex.of': 'von', 'hex.totalBytes': '{n} Bytes insgesamt',
    'hex.prev': 'Zurück', 'hex.next': 'Weiter',
    'hex.structures': 'Strukturen auf dieser Seite',
    'hex.noStructures': 'Auf dieser Seite beginnt keine Struktur.',
    'hex.selection': 'Auswahl',
    'hex.none': 'Klicken Sie auf ein Byte, um seine Struktur zu sehen.',

    'msg.loading': 'Analyse läuft…',
    'msg.parseFailed': 'Die Datei konnte nicht analysiert werden: {msg}',
    'msg.unsupported': 'Unbekanntes Dateiformat.',
    'msg.noFile': 'Bitte öffnen Sie zuerst eine Mediendatei.',
    'msg.empty': 'Die Datei ist leer.',
    'msg.tooLarge': 'Die Datei ist zu groß ({size}). Das Limit liegt bei {limit}.',
    'msg.httpError': 'Die entfernte Datei konnte nicht geladen werden: {msg}',
    'msg.rtmp': 'Browser können RTMP/RTSP-Streams nicht öffnen. Verwenden Sie eine HTTP(S)-URL.',
    'msg.partial': 'Die Datei wurde nur teilweise analysiert.',

    'common.yes': 'Ja', 'common.no': 'Nein',
    'common.close': 'Schließen', 'common.copy': 'Kopieren',
    'common.unknown': 'Unbekannt', 'common.none': 'Keine'
  },

  /* ======================================================= Русский ==== */
  ru: {
    'app.title': 'Анализатор медиафайлов',
    'app.slogan': 'Анализируйте каждую информацию медиа',
    'app.localOnly': '100 % локальная обработка',
    'app.openFile': 'Открыть файл',
    'app.openUrl': 'Открыть URL',
    'app.dropOverlay': 'Отпустите, чтобы проанализировать файл',
    'app.tagline': 'Анализируйте каждую информацию медиа',

    'nav.menu': 'Меню',
    'nav.overview': 'Обзор',
    'nav.structure': 'Структура файла',
    'nav.frames': 'Анализ кадров',
    'nav.hex': 'Шестнадцатеричный вид',

    'welcome.title': 'Анализатор медиафайлов',
    'welcome.desc': 'Разбирайте контейнеры, дорожки и синтаксис кодеков прямо в браузере.\nВидео: MP4, MOV, MKV, WebM, Ogg, FLV, TS, ASF, 264 и другие;\nАудио: AAC, FLAC, MP3, M4A, Ogg и другие;\nИзображения: JPEG, PNG, GIF, WebP, BMP, APNG, HEIC, AVIF и другие;\nКодеки: H26x, VPx, AV1, AV2, MPEG2, MPEG4, AAC, FLAC, AC3, MP4, Vorbis, Opus',
    'welcome.drop': 'Перетащите медиафайл сюда',
    'welcome.or': 'или',
    'welcome.browse': 'Выбрать файл',
    'welcome.online': 'Файл в сети…',
    'welcome.hint': 'Онлайн-файлы загружаются через HTTP(S); HLS поддерживается.',
    'welcome.formats': 'Поддерживаемые форматы',

    'url.title': 'Открыть медиафайл из сети',
    'url.placeholder': 'https://example.com/video.mp4',
    'url.hint': 'Онлайн-файлы загружаются через HTTP(S); HLS поддерживается.',
    'url.analyze': 'Анализировать',
    'url.cancel': 'Отмена',

    'ov.fileName': 'Имя файла',
    'ov.format': 'Формат',
    'ov.size': 'Размер файла',
    'ov.duration': 'Длительность',
    'ov.bitrate': 'Битрейт',
    'ov.streamSize': 'Размер потока',
    'ov.images': 'Изображения',
    'ov.image': 'Изображение',
    'ov.params': 'Параметры кодирования',
    'ov.tracks': 'Дорожки',
    'ov.trackCount': 'Дорожек: {n}',
    'ov.preview': 'Предпросмотр',
    'ov.collapse': 'Свернуть',
    'ov.expand': 'Развернуть',
    'ov.zoom': 'Нажмите для увеличения',
    'ov.noPreview': 'Для этого формата встроенный предпросмотр недоступен.',
    'ov.webUnsupported': 'Браузер не может воспроизвести этот формат.',
    'ov.rsContainer': 'Причина: браузер не поддерживает контейнер {fmt}.',
    'ov.rsImage': 'Причина: браузер не может декодировать изображения {fmt}.',
    'ov.rsCodec': 'Причина: браузер не может декодировать {codec}.',
    'ov.overview': 'Сводка',
    'ov.video': 'Видео',
    'ov.audio': 'Аудио',
    'ov.trackId': 'ID дорожки',
    'ov.type': 'Тип',
    'ov.codec': 'Кодек',
    'ov.profile': 'Профиль',
    'ov.level': 'Уровень',
    'ov.resolution': 'Разрешение',
    'ov.fps': 'Частота кадров',
    'ov.sampleRate': 'Частота дискретизации',
    'ov.channels': 'Каналы',
    'ov.bitDepth': 'Разрядность',
    'ov.language': 'Язык',
    'ov.samples': 'Сэмплы',
    'ov.metadata': 'Метаданные',
    'ov.notes': 'Примечания',
    'ov.extra': 'Подробности',
    'ov.noMetadata': 'Этот файл не содержит метаданных контейнера.',

    'tr.video': 'Видео', 'tr.audio': 'Аудио', 'tr.subtitle': 'Субтитры',
    'tr.image': 'Изображение', 'tr.other': 'Другое', 'tr.header': 'Заголовок',

    'st.search': 'Фильтр блоков…',
    'st.details': 'Подробности',
    'st.selectNode': 'Выберите узел в дереве, чтобы увидеть его поля.',
    'st.type': 'Тип', 'st.size': 'Размер', 'st.offset': 'Смещение',
    'st.children': 'Дочерние', 'st.fields': 'Поля', 'st.field': 'Поле',
    'st.value': 'Значение', 'st.noMatch': 'Нет узлов, соответствующих фильтру.',
    'st.structure': 'Структура', 'st.viewInHex': 'Показать в hex',

    'fr.filter': 'Фильтр',
    'fr.all': 'Все',
    'fr.perPage': 'Строк на странице',
    'fr.perPageOption': '{n} / стр.',
    'fr.index': '№', 'fr.type': 'Тип', 'fr.offset': 'Смещение',
    'fr.size': 'Размер', 'fr.codec': 'Кодек', 'fr.time': 'Время (начало – конец)',
    'fr.duration': 'Длительность', 'fr.keyframe': 'Ключевой кадр',
    'fr.selectFrame': 'Выберите кадр, чтобы увидеть синтаксис кодека.',
    'fr.tabSyntax': 'Синтаксис кодека', 'fr.tabHex': 'Hex-данные', 'fr.tabPreview': 'Предпросмотр',
    'fr.noSyntax': 'Для этого кадра нет сведений о синтаксисе.',
    'fr.track': 'Дорожка', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': 'Перейти', 'fr.frameNo': '№',
    'fr.page': 'Страница', 'fr.of': 'из', 'fr.total': 'всего кадров: {n}',
    'fr.prev': 'Назад', 'fr.next': 'Вперёд', 'fr.empty': 'Нет кадров для отображения.',
    'fr.previewHint': 'Исходный файл показан для справки.',
    'fr.rawBytes': 'Необработанные байты',

    'hex.rowsPerPage': 'Строк на странице',
    'hex.address': 'Адрес',
    'hex.go': 'Перейти',
    'hex.page': 'Страница', 'hex.of': 'из', 'hex.totalBytes': 'всего байт: {n}',
    'hex.prev': 'Назад', 'hex.next': 'Вперёд',
    'hex.structures': 'Структуры на этой странице',
    'hex.noStructures': 'На этой странице не начинается ни одна структура.',
    'hex.selection': 'Выделение',
    'hex.none': 'Нажмите на байт, чтобы увидеть его структуру.',

    'msg.loading': 'Анализ…',
    'msg.parseFailed': 'Не удалось разобрать файл: {msg}',
    'msg.unsupported': 'Нераспознанный формат файла.',
    'msg.noFile': 'Сначала откройте медиафайл.',
    'msg.empty': 'Файл пуст.',
    'msg.tooLarge': 'Файл слишком велик ({size}). Ограничение — {limit}.',
    'msg.httpError': 'Не удалось загрузить удалённый файл: {msg}',
    'msg.rtmp': 'Браузеры не открывают потоки RTMP/RTSP. Используйте URL HTTP(S).',
    'msg.partial': 'Файл проанализирован лишь частично.',

    'common.yes': 'Да', 'common.no': 'Нет',
    'common.close': 'Закрыть', 'common.copy': 'Копировать',
    'common.unknown': 'Неизвестно', 'common.none': 'Нет'
  },

  /* ======================================================= Español ==== */
  es: {
    'app.title': 'Analizador de archivos multimedia',
    'app.slogan': 'Analiza cada información del medio',
    'app.localOnly': 'Procesamiento 100 % local',
    'app.openFile': 'Abrir archivo',
    'app.openUrl': 'Abrir URL',
    'app.dropOverlay': 'Suelta el archivo multimedia para analizarlo',
    'app.tagline': 'Analiza cada información del medio',

    'nav.menu': 'Menú',
    'nav.overview': 'Resumen',
    'nav.structure': 'Estructura del archivo',
    'nav.frames': 'Análisis de tramas',
    'nav.hex': 'Hexadecimal',

    'welcome.title': 'Analizador de archivos multimedia',
    'welcome.desc': 'Analiza contenedores, pistas y sintaxis de códecs directamente en el navegador.\nVídeo: MP4, MOV, MKV, WebM, Ogg, FLV, TS, ASF, 264 y más;\nAudio: AAC, FLAC, MP3, M4A, Ogg y más;\nImágenes: JPEG, PNG, GIF, WebP, BMP, APNG, HEIC, AVIF y más;\nCódecs: H26x, VPx, AV1, AV2, MPEG2, MPEG4, AAC, FLAC, AC3, MP4, Vorbis, Opus',
    'welcome.drop': 'Suelta un archivo multimedia aquí',
    'welcome.or': 'o',
    'welcome.browse': 'Elegir archivo',
    'welcome.online': 'Archivo en línea…',
    'welcome.hint': 'Los archivos en línea se obtienen vía HTTP(S); HLS es compatible.',
    'welcome.formats': 'Formatos compatibles',

    'url.title': 'Abrir un archivo multimedia en línea',
    'url.placeholder': 'https://ejemplo.com/video.mp4',
    'url.hint': 'Los archivos en línea se obtienen vía HTTP(S); HLS es compatible.',
    'url.analyze': 'Analizar',
    'url.cancel': 'Cancelar',

    'ov.fileName': 'Nombre del archivo',
    'ov.format': 'Formato',
    'ov.size': 'Tamaño del archivo',
    'ov.duration': 'Duración',
    'ov.bitrate': 'Tasa de bits',
    'ov.streamSize': 'Tamaño del flujo',
    'ov.images': 'Imágenes',
    'ov.image': 'Imagen',
    'ov.params': 'Parámetros de codificación',
    'ov.tracks': 'Pistas',
    'ov.trackCount': '{n} pista(s)',
    'ov.preview': 'Vista previa',
    'ov.collapse': 'Contraer',
    'ov.expand': 'Expandir',
    'ov.zoom': 'Clic para ver en grande',
    'ov.noPreview': 'No hay vista previa integrada para este formato.',
    'ov.webUnsupported': 'El navegador no puede reproducir este formato.',
    'ov.rsContainer': 'Motivo: el navegador no admite el contenedor {fmt}.',
    'ov.rsImage': 'Motivo: el navegador no puede decodificar imágenes {fmt}.',
    'ov.rsCodec': 'Motivo: el navegador no puede decodificar {codec}.',
    'ov.overview': 'Resumen',
    'ov.video': 'Vídeo',
    'ov.audio': 'Audio',
    'ov.trackId': 'ID de pista',
    'ov.type': 'Tipo',
    'ov.codec': 'Códec',
    'ov.profile': 'Perfil',
    'ov.level': 'Nivel',
    'ov.resolution': 'Resolución',
    'ov.fps': 'Velocidad de fotogramas',
    'ov.sampleRate': 'Frecuencia de muestreo',
    'ov.channels': 'Canales',
    'ov.bitDepth': 'Profundidad de bits',
    'ov.language': 'Idioma',
    'ov.samples': 'Muestras',
    'ov.metadata': 'Metadatos',
    'ov.notes': 'Notas',
    'ov.extra': 'Detalles',
    'ov.noMetadata': 'Este archivo no contiene metadatos de contenedor.',

    'tr.video': 'Vídeo', 'tr.audio': 'Audio', 'tr.subtitle': 'Subtítulos',
    'tr.image': 'Imagen', 'tr.other': 'Otro', 'tr.header': 'Cabecera',

    'st.search': 'Filtrar cajas…',
    'st.details': 'Detalles',
    'st.selectNode': 'Selecciona un nodo del árbol para ver sus campos.',
    'st.type': 'Tipo', 'st.size': 'Tamaño', 'st.offset': 'Desplazamiento',
    'st.children': 'Hijos', 'st.fields': 'Campos', 'st.field': 'Campo',
    'st.value': 'Valor', 'st.noMatch': 'Ningún nodo coincide con el filtro.',
    'st.structure': 'Estructura', 'st.viewInHex': 'Ver en hexadecimal',

    'fr.filter': 'Filtrar',
    'fr.all': 'Todo',
    'fr.perPage': 'Filas por página',
    'fr.perPageOption': '{n} / página',
    'fr.index': 'N.º', 'fr.type': 'Tipo', 'fr.offset': 'Desplazamiento',
    'fr.size': 'Tamaño', 'fr.codec': 'Códec', 'fr.time': 'Tiempo (inicio – fin)',
    'fr.duration': 'Duración', 'fr.keyframe': 'Fotograma clave',
    'fr.selectFrame': 'Selecciona una trama para ver su sintaxis de códec.',
    'fr.tabSyntax': 'Sintaxis del códec', 'fr.tabHex': 'Datos hexadecimales',
    'fr.tabPreview': 'Vista previa',
    'fr.noSyntax': 'No hay detalles de sintaxis disponibles para esta trama.',
    'fr.track': 'Pista', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': 'Ir', 'fr.frameNo': 'N.º',
    'fr.page': 'Página', 'fr.of': 'de', 'fr.total': '{n} tramas en total',
    'fr.prev': 'Anterior', 'fr.next': 'Siguiente', 'fr.empty': 'No hay tramas que mostrar.',
    'fr.previewHint': 'Se muestra el archivo original como referencia.',
    'fr.rawBytes': 'Bytes sin procesar',

    'hex.rowsPerPage': 'Filas por página',
    'hex.address': 'Dirección',
    'hex.go': 'Ir',
    'hex.page': 'Página', 'hex.of': 'de', 'hex.totalBytes': '{n} bytes en total',
    'hex.prev': 'Anterior', 'hex.next': 'Siguiente',
    'hex.structures': 'Estructuras de esta página',
    'hex.noStructures': 'Ninguna estructura comienza en esta página.',
    'hex.selection': 'Selección',
    'hex.none': 'Haz clic en un byte para ver la estructura a la que pertenece.',

    'msg.loading': 'Analizando…',
    'msg.parseFailed': 'No se pudo analizar el archivo: {msg}',
    'msg.unsupported': 'Formato de archivo no reconocido.',
    'msg.noFile': 'Abra primero un archivo multimedia.',
    'msg.empty': 'El archivo está vacío.',
    'msg.tooLarge': 'El archivo es demasiado grande ({size}). El límite es {limit}.',
    'msg.httpError': 'No se pudo obtener el archivo remoto: {msg}',
    'msg.rtmp': 'Los navegadores no pueden abrir flujos RTMP/RTSP. Usa una URL HTTP(S).',
    'msg.partial': 'El archivo solo se analizó parcialmente.',

    'common.yes': 'Sí', 'common.no': 'No',
    'common.close': 'Cerrar', 'common.copy': 'Copiar',
    'common.unknown': 'Desconocido', 'common.none': 'Ninguno'
  },

  /* ======================================================== 한국어 ==== */
  ko: {
    'app.title': '미디어 파일 분석기',
    'app.slogan': '미디어의 모든 정보를 분석하다',
    'app.localOnly': '100% 로컬 처리',
    'app.openFile': '파일 열기',
    'app.openUrl': 'URL 열기',
    'app.dropOverlay': '분석할 미디어 파일을 놓으세요',
    'app.tagline': '미디어의 모든 정보를 분석하다',

    'nav.menu': '메뉴',
    'nav.overview': '미디어 개요',
    'nav.structure': '파일 구조',
    'nav.frames': '프레임 분석',
    'nav.hex': '16진수',

    'welcome.title': '미디어 파일 분석기',
    'welcome.desc': '브라우저에서 바로 컨테이너, 트랙, 코덱 구문을 분석합니다.\n비디오: MP4, MOV, MKV, WebM, Ogg, FLV, TS, ASF, 264 등;\n오디오: AAC, FLAC, MP3, M4A, Ogg 등;\n이미지: JPEG, PNG, GIF, WebP, BMP, APNG, HEIC, AVIF 등;\n코덱: H26x, VPx, AV1, AV2, MPEG2, MPEG4, AAC, FLAC, AC3, MP4, Vorbis, Opus',
    'welcome.drop': '미디어 파일을 여기로 끌어다 놓으세요',
    'welcome.or': '또는',
    'welcome.browse': '파일 선택',
    'welcome.online': '온라인 파일…',
    'welcome.hint': '온라인 파일은 HTTP(S)로 가져옵니다; HLS를 지원합니다.',
    'welcome.formats': '지원 형식',

    'url.title': '온라인 미디어 파일 열기',
    'url.placeholder': 'https://example.com/video.mp4',
    'url.hint': '온라인 파일은 HTTP(S)로 가져옵니다; HLS를 지원합니다.',
    'url.analyze': '분석',
    'url.cancel': '취소',

    'ov.fileName': '파일 이름',
    'ov.format': '형식',
    'ov.size': '파일 크기',
    'ov.duration': '재생 시간',
    'ov.bitrate': '비트레이트',
    'ov.streamSize': '스트림 크기',
    'ov.images': '이미지 목록',
    'ov.image': '이미지',
    'ov.params': '인코딩 매개변수',
    'ov.tracks': '트랙',
    'ov.trackCount': '트랙 {n}개',
    'ov.preview': '미리보기',
    'ov.collapse': '접기',
    'ov.expand': '펼치기',
    'ov.zoom': '클릭하여 크게 보기',
    'ov.noPreview': '이 형식은 내장 미리보기를 지원하지 않습니다.',
    'ov.webUnsupported': '브라우저에서 이 형식을 재생할 수 없습니다.',
    'ov.rsContainer': '이유: 브라우저가 {fmt} 컨테이너를 지원하지 않습니다.',
    'ov.rsImage': '이유: 브라우저가 {fmt} 이미지를 디코딩할 수 없습니다.',
    'ov.rsCodec': '이유: 브라우저가 {codec} 코덱을 디코딩할 수 없습니다.',
    'ov.overview': '요약',
    'ov.video': '비디오',
    'ov.audio': '오디오',
    'ov.trackId': '트랙 ID',
    'ov.type': '유형',
    'ov.codec': '코덱',
    'ov.profile': '프로파일',
    'ov.level': '레벨',
    'ov.resolution': '해상도',
    'ov.fps': '프레임 레이트',
    'ov.sampleRate': '샘플 레이트',
    'ov.channels': '채널',
    'ov.bitDepth': '비트 깊이',
    'ov.language': '언어',
    'ov.samples': '샘플 수',
    'ov.metadata': '메타데이터',
    'ov.notes': '비고',
    'ov.extra': '세부 정보',
    'ov.noMetadata': '이 파일에는 컨테이너 메타데이터가 없습니다.',

    'tr.video': '비디오', 'tr.audio': '오디오', 'tr.subtitle': '자막',
    'tr.image': '이미지', 'tr.other': '기타', 'tr.header': '헤더',

    'st.search': '박스 필터…',
    'st.details': '세부 정보',
    'st.selectNode': '트리에서 노드를 선택하면 해당 필드를 볼 수 있습니다.',
    'st.type': '유형', 'st.size': '크기', 'st.offset': '오프셋',
    'st.children': '자식', 'st.fields': '필드', 'st.field': '필드',
    'st.value': '값', 'st.noMatch': '필터와 일치하는 노드가 없습니다.',
    'st.structure': '구조', 'st.viewInHex': '16진수로 보기',

    'fr.filter': '필터',
    'fr.all': '전체',
    'fr.perPage': '페이지당 행',
    'fr.perPageOption': '{n}개 / 페이지',
    'fr.index': '번호', 'fr.type': '유형', 'fr.offset': '오프셋',
    'fr.size': '크기', 'fr.codec': '코덱', 'fr.time': '시간(시작 – 끝)',
    'fr.duration': '길이', 'fr.keyframe': '키 프레임',
    'fr.selectFrame': '프레임을 선택하면 코덱 구문을 볼 수 있습니다.',
    'fr.tabSyntax': '코덱 구문', 'fr.tabHex': '16진수 데이터', 'fr.tabPreview': '미리보기',
    'fr.noSyntax': '이 프레임에는 구문 정보가 없습니다.',
    'fr.track': '트랙', 'fr.pts': 'PTS', 'fr.dts': 'DTS',
    'fr.jump': '이동', 'fr.frameNo': '번호',
    'fr.page': '페이지', 'fr.of': '/', 'fr.total': '총 {n}개 프레임',
    'fr.prev': '이전', 'fr.next': '다음', 'fr.empty': '표시할 프레임이 없습니다.',
    'fr.previewHint': '참고용으로 원본 파일을 표시합니다.',
    'fr.rawBytes': '원시 바이트',

    'hex.rowsPerPage': '페이지당 크기',
    'hex.address': '주소',
    'hex.go': '이동',
    'hex.page': '페이지', 'hex.of': '/', 'hex.totalBytes': '총 {n}바이트',
    'hex.prev': '이전', 'hex.next': '다음',
    'hex.structures': '이 페이지의 구조',
    'hex.noStructures': '이 페이지에서 시작하는 구조가 없습니다.',
    'hex.selection': '선택 영역',
    'hex.none': '바이트를 클릭하면 해당 구조를 볼 수 있습니다.',

    'msg.loading': '분석 중…',
    'msg.parseFailed': '파일을 분석할 수 없습니다: {msg}',
    'msg.unsupported': '인식할 수 없는 파일 형식입니다.',
    'msg.noFile': '먼저 미디어 파일을 열어 주세요.',
    'msg.empty': '파일이 비어 있습니다.',
    'msg.tooLarge': '파일이 너무 큽니다({size}). 한도는 {limit}입니다.',
    'msg.httpError': '원격 파일을 가져올 수 없습니다: {msg}',
    'msg.rtmp': '브라우저는 RTMP/RTSP 스트림을 열 수 없습니다. HTTP(S) URL을 사용하세요.',
    'msg.partial': '파일이 일부만 분석되었습니다.',

    'common.yes': '예', 'common.no': '아니요',
    'common.close': '닫기', 'common.copy': '복사',
    'common.unknown': '알 수 없음', 'common.none': '없음'
  }
  };

  /* ====================================================================== */

  var STORAGE_KEY = 'ma.lang';
  var listeners = [];

  function detectInitial() {
    try {
      var saved = root.localStorage && root.localStorage.getItem(STORAGE_KEY);
      if (saved && DICT[saved]) return saved;
    } catch (e) { /* storage can be blocked */ }
    var nav = (root.navigator && (root.navigator.language || root.navigator.userLanguage)) || 'en';
    var short = String(nav).slice(0, 2).toLowerCase();
    return DICT[short] ? short : 'en';
  }

  var current = detectInitial();

  /**
   * Look up a key.
   * @param {string} key
   * @param {object} [vars] values substituted into `{name}` placeholders
   */
  function t(key, vars) {
    var table = DICT[current] || DICT.en;
    var s = table[key];
    if (s == null) s = DICT.en[key];
    if (s == null) return key;
    if (vars) {
      s = s.replace(/\{(\w+)\}/g, function (m, name) {
        return vars[name] != null ? String(vars[name]) : m;
      });
    }
    return s;
  }

  /**
   * Translate a DOM subtree: `data-i18n` sets textContent, `data-i18n-ph`
   * sets the placeholder. Nodes without the attributes are left alone.
   */
  function applyDOM(scope) {
    var rootNode = scope || root.document;
    if (!rootNode || !rootNode.querySelectorAll) return;
    var nodes = rootNode.querySelectorAll('[data-i18n]');
    for (var i = 0; i < nodes.length; i++) {
      nodes[i].textContent = t(nodes[i].getAttribute('data-i18n'));
    }
    var phs = rootNode.querySelectorAll('[data-i18n-ph]');
    for (var j = 0; j < phs.length; j++) {
      phs[j].setAttribute('placeholder', t(phs[j].getAttribute('data-i18n-ph')));
    }
    var titles = rootNode.querySelectorAll('[data-i18n-title]');
    for (var k = 0; k < titles.length; k++) {
      titles[k].setAttribute('title', t(titles[k].getAttribute('data-i18n-title')));
    }
    if (root.document && root.document.documentElement) {
      root.document.documentElement.lang = current;
    }
  }

  function getLang() { return current; }
  function available() { return LANGUAGES.slice(); }

  function setLang(code) {
    if (!DICT[code] || code === current) return current;
    current = code;
    try {
      if (root.localStorage) root.localStorage.setItem(STORAGE_KEY, code);
    } catch (e) { /* ignore */ }
    applyDOM();
    listeners.forEach(function (fn) {
      try { fn(code); } catch (e) { /* a bad listener must not block the switch */ }
    });
    return current;
  }

  /** Register a callback fired after the language changes (views re-render). */
  function onchange(fn) { listeners.push(fn); }

  /** Languages whose table is complete; used by the dev-time key audit. */
  function missingKeys() {
    var enKeys = Object.keys(DICT.en);
    var out = {};
    Object.keys(DICT).forEach(function (code) {
      if (code === 'en') return;
      var missing = enKeys.filter(function (k) { return DICT[code][k] == null; });
      if (missing.length) out[code] = missing;
    });
    return out;
  }

  MA.i18n = {
    t: t,
    getLang: getLang,
    setLang: setLang,
    applyDOM: applyDOM,
    onchange: onchange,
    available: available,
    missingKeys: missingKeys,
    languages: LANGUAGES,
    dict: DICT
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
