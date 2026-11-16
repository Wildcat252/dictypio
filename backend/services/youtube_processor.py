import yt_dlp
import html
import json
import re
import subprocess
import sys
import xml.etree.ElementTree as ET
import tempfile
import shutil
from concurrent.futures import ThreadPoolExecutor
from typing import List, Dict, Optional, Tuple
from sqlalchemy import or_
from sqlalchemy.orm import Session
from database import Video, Sentence, LearningProgress
from services.audio_files import remove_unreferenced_audio
import os

# YouTube now needs a JavaScript runtime to decode its player; without one
# yt-dlp warns and some formats go missing. yt-dlp only tries deno by default,
# which the servers here lack, so also allow Node (present on Render and on any
# machine that builds the frontend). The first one found is used.
YT_DLP_JS_RUNTIMES = {'deno': {}, 'node': {}}
YT_DLP_JS_RUNTIME_ARGS = [arg for name in YT_DLP_JS_RUNTIMES for arg in ('--js-runtimes', name)]

# YouTube refuses requests from datacenter IPs (Render, cloud hosts) unless they
# carry a signed-in browser's cookies. Point YOUTUBE_COOKIES_FILE at a
# Netscape-format cookies.txt; on Render, a Secret File named
# youtube_cookies.txt is picked up without setting anything.
_COOKIE_SOURCES = (
    os.getenv('YOUTUBE_COOKIES_FILE', '').strip(),
    '/etc/secrets/youtube_cookies.txt',
)
_cookie_copy: Optional[str] = None


def _youtube_cookie_file() -> Optional[str]:
    """A writable copy of the cookies file, or None when there is none.

    yt-dlp saves refreshed cookies back into the file it was given, and
    Render's secret files are read-only, so it works on a private copy.
    """
    global _cookie_copy
    if _cookie_copy and os.path.isfile(_cookie_copy):
        return _cookie_copy
    source = next((p for p in _COOKIE_SOURCES if p and os.path.isfile(p)), None)
    if not source:
        return None
    fd, copy = tempfile.mkstemp(prefix='yt-cookies-', suffix='.txt')
    os.close(fd)
    shutil.copyfile(source, copy)
    _cookie_copy = copy
    return copy


def _private_cookie_copy() -> Optional[str]:
    """A second copy of the cookies for a yt-dlp run that overlaps another one.

    yt-dlp rewrites its cookie file when it exits, so two runs at the same time
    must not share one. The caller removes the copy when its run is over.
    """
    shared = _youtube_cookie_file()
    if not shared:
        return None
    fd, copy = tempfile.mkstemp(prefix='yt-cookies-', suffix='.txt')
    os.close(fd)
    shutil.copyfile(shared, copy)
    return copy


def yt_dlp_common_options(cookie_file: Optional[str] = None) -> Dict:
    """Options every in-process yt-dlp call shares."""
    options: Dict = {'js_runtimes': YT_DLP_JS_RUNTIMES}
    cookie_file = cookie_file or _youtube_cookie_file()
    if cookie_file:
        options['cookiefile'] = cookie_file
    return options


def yt_dlp_common_args(cookie_file: Optional[str] = None) -> List[str]:
    """The same settings for the yt-dlp command line."""
    args = list(YT_DLP_JS_RUNTIME_ARGS)
    cookie_file = cookie_file or _youtube_cookie_file()
    if cookie_file:
        args += ['--cookies', cookie_file]
    return args


class YouTubeProcessor:
    # YouTube exposes several subtitle payloads per language. json3 comes first:
    # for automatic captions it is the one that times every word, which is what
    # lets a sentence be cut exactly at its full stop.
    _SUBTITLE_EXT_RANK = (
        'json3',
        'vtt',
        'srv1',
        'srt',
        'ttml',
        'ttml+xml',
        'ass',
        'ssa',
        'srv3',
        'srv2',
        'json',
    )

    # Audio is kept as M4A (AAC). Its index maps every position to a byte
    # offset, so every browser seeks to the same spot; in a VBR MP3 they each
    # guess, and a sentence starts a little off in a different way per browser.
    _AUDIO_FORMAT = 'bestaudio[ext=m4a]/bestaudio/best'
    _AUDIO_EXTENSIONS = ('.m4a', '.mp3', '.webm', '.opus', '.ogg')

    # Sentence shaping.
    _MAX_SENTENCE_WORDS = 22
    _MAX_SENTENCE_SECONDS = 12.0
    _MIN_SENTENCE_WORDS = 3
    _MIN_SPLIT_CHUNK = 4        # a long sentence is never cut closer to an edge than this
    _PAUSE_SPLIT_SECONDS = 0.35  # captions without punctuation are cut at pauses this long
    # Automatic captions only say when a word starts. In fast speech words start
    # about 0.2 s apart; 0.8 s or more to the next one means a pause, so a timed
    # word is taken to last this long at most.
    _TIMED_WORD_SECONDS = 0.45
    # Words a new clause tends to open with: good places to cut a long sentence
    # that has no comma to cut at.
    _CLAUSE_OPENERS = frozenset({
        'and', 'but', 'so', 'because', 'or', 'then', 'which', 'when', 'if',
        'while', 'although', 'however', 'now', 'well',
    })
    _MERGE_GAP_SECONDS = 1.5    # a short sentence joins a neighbour no further away than this
    _MAX_WORD_SECONDS = 1.2     # a word with no known end is assumed to end by then
    _LEAD_IN_SECONDS = 0.15
    _TAIL_SECONDS = 0.2

    _CLOSERS = '"\'”’)]»'
    _OPENERS = '"\'“‘([«'
    _ABBREVIATIONS = frozenset({
        'mr.', 'mrs.', 'ms.', 'dr.', 'prof.', 'sr.', 'jr.', 'st.', 'mt.', 'vs.',
        'gen.', 'col.', 'lt.', 'sgt.', 'capt.', 'gov.', 'sen.', 'rep.', 'rev.',
        'fig.', 'approx.',
    })
    # "(Laughter)", "(Applause)", "(Music playing)": sound descriptions in written captions.
    _SOUND_TAG = re.compile(
        r'\((?:[^()]*\b)?(?:laughter|laughs|laughing|applause|music|cheers|cheering|sighs|silence)\b[^()]*\)',
        re.I,
    )
    _NOISE_TOKENS = frozenset({'-', '–', '—'})

    def __init__(self, download_dir: str = None, audio_dir: str = None):
        # Use absolute paths relative to backend directory (or Electron userData via env)
        backend_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.download_dir = (
            download_dir
            or os.getenv("EAR2FINGER_DOWNLOAD_DIR")
            or os.path.join(backend_dir, "downloads")
        )
        self.audio_dir = (
            audio_dir
            or os.getenv("EAR2FINGER_AUDIO_DIR")
            or os.path.join(backend_dir, "audio")
        )
        os.makedirs(self.download_dir, exist_ok=True)
        os.makedirs(self.audio_dir, exist_ok=True)

    @staticmethod
    def _yt_dlp_cli(cookie_file: Optional[str] = None):
        """Same interpreter + yt-dlp as `import yt_dlp` (Windows often has an older `yt-dlp` earlier on PATH)."""
        return [sys.executable, '-m', 'yt_dlp', *yt_dlp_common_args(cookie_file)]

    @staticmethod
    def _strip_caption_noise(text: str) -> str:
        """Drop what is not speech: ``[Music]``, speaker arrows ``>>``, music notes."""
        t = re.sub(r'\[[^\]]*\]', ' ', text or '')
        t = YouTubeProcessor._SOUND_TAG.sub(' ', t)
        t = re.sub(r'>{2,}|[♪♫]+', ' ', t)
        return re.sub(r'\s+', ' ', t).strip()

    @staticmethod
    def _clean_subtitle_display_text(text: str) -> str:
        """Strip YouTube WebVTT/json3 inline timing and style tags (e.g. ``<00:00:06.799><c>``)."""
        if not text:
            return text
        t = html.unescape(text)
        t = re.sub(r'<\d{1,2}:\d{2}:\d{2}\.\d{3}>', '', t)
        t = re.sub(r'<\d{1,2}:\d{2}\.\d{3}>', '', t)
        t = re.sub(r'</?c[^>]*>', '', t, flags=re.I)
        t = re.sub(r'</?v[^>]*>', '', t, flags=re.I)
        return re.sub(r'\s+', ' ', t).strip()

    def _dedupe_rolling_subtitle_cues(self, segments: List[Dict]) -> List[Dict]:
        """
        YouTube auto captions (json3 / VTT) often use rolling lines: each cue repeats
        the previous phrase and appends words. Remove that overlap so text is not doubled.
        """
        if not segments:
            return segments
        out: List[Dict] = []
        prev_raw = ""
        prev_end: Optional[float] = None
        gap_reset_s = 4.0
        min_suffix = 3

        for seg in segments:
            st = float(seg["start_time"])
            en = float(seg["end_time"])
            t = (seg.get("text") or "").strip()
            if not t:
                continue

            if prev_end is not None and st - prev_end > gap_reset_s:
                prev_raw = ""

            if prev_raw:
                if t.startswith(prev_raw):
                    display = t[len(prev_raw) :].strip()
                else:
                    max_k = min(len(prev_raw), len(t), 240)
                    k = 0
                    for cand in range(max_k, min_suffix - 1, -1):
                        if t.startswith(prev_raw[-cand:]):
                            k = cand
                            break
                    display = t[k:].strip() if k else t
            else:
                display = t

            prev_raw = t
            prev_end = en

            if not display:
                if out:
                    out[-1]["end_time"] = max(float(out[-1]["end_time"]), en)
                continue

            out.append({"start_time": st, "end_time": en, "text": display})
        return out

    @classmethod
    def _subtitle_ext_rank(cls, ext: Optional[str]) -> int:
        e = (ext or '').lower()
        try:
            return cls._SUBTITLE_EXT_RANK.index(e)
        except ValueError:
            return len(cls._SUBTITLE_EXT_RANK)

    def _fetch_first_parseable_subtitle(self, ydl, subtitle_list: List[Dict]) -> Optional[str]:
        """Try subtitle URLs in format order until `parse_subtitles` yields segments."""
        if not subtitle_list:
            return None
        ranked = sorted(subtitle_list, key=lambda x: self._subtitle_ext_rank(x.get('ext')))
        for fmt in ranked:
            url = fmt.get('url')
            if not url:
                continue
            try:
                raw = ydl.urlopen(url).read()
                text = raw.decode('utf-8')
            except Exception:
                continue
            if self.parse_subtitles(text):
                return text
        return None

    def _cleanup_temp_audio(self, video_id: str) -> None:
        prefix = f'{video_id}_temp'
        if not os.path.isdir(self.audio_dir):
            return
        for name in os.listdir(self.audio_dir):
            if name.startswith(prefix):
                try:
                    os.remove(os.path.join(self.audio_dir, name))
                except OSError:
                    pass

    @staticmethod
    def _has_ffmpeg() -> bool:
        """Whether yt-dlp can repackage audio. Without FFmpeg the file is kept as YouTube sends it."""
        try:
            from yt_dlp.postprocessor.ffmpeg import FFmpegPostProcessor

            return bool(FFmpegPostProcessor(None).available)
        except Exception:
            return shutil.which('ffmpeg') is not None

    def _download_audio_via_python_ydl(
        self, youtube_url: str, video_id: str, safe_title: str, cookie_file: Optional[str] = None
    ) -> Optional[str]:
        """
        Download audio using in-process yt_dlp (required when PyInstaller breaks ``-m yt_dlp``).
        Tries an FFmpeg M4A extract first, then the native file if FFmpeg is unavailable.
        """
        temp_prefix = f'{video_id}_temp'
        base_slug = f'{video_id}_{safe_title}'
        temp_pattern = os.path.join(self.audio_dir, f'{temp_prefix}.%(ext)s')

        def pick_temp_file(*suffixes: str) -> Optional[str]:
            for name in os.listdir(self.audio_dir):
                if not name.startswith(temp_prefix):
                    continue
                lower = name.lower()
                for suf in suffixes:
                    if lower.endswith(suf):
                        return os.path.join(self.audio_dir, name)
            return None

        def finalize(ext: str, src_path: str) -> str:
            dest = os.path.join(self.audio_dir, f'{base_slug}{ext}')
            if os.path.exists(dest):
                os.remove(dest)
            shutil.move(src_path, dest)
            return dest

        self._cleanup_temp_audio(video_id)

        if not self._has_ffmpeg():
            return self._download_native_audio(youtube_url, video_id, cookie_file, pick_temp_file, finalize)

        opts_m4a = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(cookie_file),
            'format': self._AUDIO_FORMAT,
            'outtmpl': temp_pattern,
            'postprocessors': [
                {
                    'key': 'FFmpegExtractAudio',
                    'preferredcodec': 'm4a',
                }
            ],
        }
        try:
            with yt_dlp.YoutubeDL(opts_m4a) as ydl_dl:
                ydl_dl.download([youtube_url])
        except Exception as e:
            print(f"Warning: in-process yt-dlp M4A extract failed: {e}")
        else:
            p = pick_temp_file('.m4a')
            if p:
                return finalize('.m4a', p)

        return self._download_native_audio(youtube_url, video_id, cookie_file, pick_temp_file, finalize)

    def _download_native_audio(self, youtube_url, video_id, cookie_file, pick_temp_file, finalize) -> Optional[str]:
        """In-process download of the audio exactly as YouTube has it, with no FFmpeg step."""
        temp_pattern = os.path.join(self.audio_dir, f'{video_id}_temp.%(ext)s')
        self._cleanup_temp_audio(video_id)
        opts_native = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(cookie_file),
            'format': 'bestaudio[ext=m4a]/bestaudio[ext=webm]/bestaudio/ba/b',
            'outtmpl': temp_pattern,
        }
        try:
            with yt_dlp.YoutubeDL(opts_native) as ydl_dl:
                ydl_dl.download([youtube_url])
        except Exception as e:
            print(f"Warning: in-process yt-dlp native audio download failed: {e}")
            return None

        for suf in self._AUDIO_EXTENSIONS:
            p = pick_temp_file(suf)
            if p:
                return finalize(suf, p)
        return None

    @staticmethod
    def _pick_caption_track(info: Dict) -> Optional[Tuple[str, bool]]:
        """The English caption track to fetch, as (language code, is automatic).

        Captions somebody wrote win over automatic ones. yt-dlp already listed
        both while reading the video, so no request is spent on finding out.
        """
        def english(tracks, preferred):
            codes = [c for c in (tracks or {}) if c == 'en' or c.startswith(('en-', 'en_'))]
            for code in preferred:
                if code in codes:
                    return code
            return sorted(codes)[0] if codes else None

        manual = english(info.get('subtitles'), ('en', 'en-US', 'en-GB'))
        if manual:
            return manual, False
        automatic = english(info.get('automatic_captions'), ('en', 'en-orig'))
        if automatic:
            return automatic, True
        return None

    def _read_subtitle_file(self, directory: str) -> Optional[str]:
        """The best subtitle file yt-dlp wrote into ``directory`` that parses."""
        names = sorted(
            os.listdir(directory),
            key=lambda name: self._subtitle_ext_rank(name.rsplit('.', 1)[-1]),
        )
        for name in names:
            try:
                with open(os.path.join(directory, name), 'r', encoding='utf-8') as f:
                    text = f.read()
            except (OSError, UnicodeDecodeError):
                continue
            if self.parse_subtitles(text):
                return text
        return None

    def _download_subtitles(self, youtube_url: str, ydl, info: Dict) -> Optional[str]:
        """Fetch the English captions, in the format that keeps the most timing."""
        subtitles_data = None
        track = self._pick_caption_track(info)
        # Normally one request for the track picked above. If the listing had no
        # English track, still ask for one, written captions first.
        attempts = [track] if track else [('en', False), ('en', True)]
        try:
            for lang, is_auto in attempts:
                with tempfile.TemporaryDirectory() as tmpdir:
                    cmd = self._yt_dlp_cli() + [
                        '--no-playlist',
                        '--write-auto-subs' if is_auto else '--write-subs',
                        '--sub-langs', lang,
                        # No --convert-subs: converting to SRT throws the word timings away.
                        '--sub-format', 'json3/vtt/srt/best',
                        '--skip-download',
                        '--output', os.path.join(tmpdir, '%(id)s.%(ext)s'),
                        '--quiet',
                        youtube_url,
                    ]
                    result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
                    subtitles_data = self._read_subtitle_file(tmpdir)
                    if subtitles_data:
                        break
                    print(
                        f"Warning: no {'automatic' if is_auto else 'manual'} subtitle file "
                        f"written for '{lang}'; yt-dlp said: {result.stderr[-800:]}"
                    )
        except subprocess.TimeoutExpired:
            print("Warning: Subtitle download timed out")
        except Exception as e:
            print(f"Warning: Failed to download subtitles via command-line: {str(e)}")

        # PyInstaller/Electron: `sys.executable` is the frozen backend, not Python, so
        # `run_electron_backend.exe -m yt_dlp` fails without raising — only the API path works.
        if not subtitles_data:
            try:
                subtitles_data = self._extract_subtitles_via_api(ydl, info)
            except Exception as e:
                print(f"Warning: Failed to download subtitles via the API: {str(e)}")
        return subtitles_data

    def _download_audio(self, youtube_url: str, video_id: str, safe_title: str) -> Optional[str]:
        """Download the lesson audio and return its path, or None if that failed."""
        base_path = os.path.join(self.audio_dir, f"{video_id}_{safe_title}")
        for ext in self._AUDIO_EXTENSIONS:
            if os.path.exists(base_path + ext):
                return base_path + ext

        # Runs next to the subtitle download, so it gets cookies of its own.
        cookie_file = _private_cookie_copy()
        try:
            # CLI works in dev (real Python). Packaged PyInstaller needs in-process yt-dlp.
            try:
                temp_output = os.path.join(self.audio_dir, f'{video_id}_temp.%(ext)s')
                # YouTube's M4A is already AAC, so FFmpeg only repackages it instead of
                # re-encoding: much faster than the MP3 conversion this replaces.
                # Without FFmpeg the file is kept as downloaded, in one attempt.
                repackage = [
                    '-x',
                    '--audio-format', 'm4a',
                    '--postprocessor-args', 'ffmpeg:-movflags +faststart',
                ] if self._has_ffmpeg() else []
                cmd = self._yt_dlp_cli(cookie_file) + [
                    '--no-playlist',
                    '-f', self._AUDIO_FORMAT,
                    *repackage,
                    '--output', temp_output,
                    '--quiet',
                    youtube_url,
                ]
                result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
                if result.returncode == 0:
                    wanted = ('.m4a',) if repackage else self._AUDIO_EXTENSIONS
                    for ext in wanted:
                        for file in os.listdir(self.audio_dir):
                            if file.startswith(f'{video_id}_temp') and file.endswith(ext):
                                shutil.move(os.path.join(self.audio_dir, file), base_path + ext)
                                return base_path + ext
                elif result.stderr:
                    print(f"Warning: Audio CLI failed: {result.stderr[:800]}")
            except subprocess.TimeoutExpired:
                print("Warning: Audio download timed out")
            except FileNotFoundError:
                print("Warning: yt-dlp CLI not available for audio.")
            except Exception as e:
                print(f"Warning: Audio CLI error: {e}")

            return self._download_audio_via_python_ydl(
                youtube_url, video_id, safe_title, cookie_file
            )
        finally:
            if cookie_file:
                try:
                    os.remove(cookie_file)
                except OSError:
                    pass

    def extract_video_info(self, youtube_url: str, video_id: str = None) -> Dict:
        """Extract video information, subtitles, and download the audio using yt-dlp"""
        # First, get video info without downloading
        ydl_opts_info = {
            'quiet': True,
            'no_warnings': True,
            'noplaylist': True,
            **yt_dlp_common_options(),
        }

        try:
            with yt_dlp.YoutubeDL(ydl_opts_info) as ydl:
                info = ydl.extract_info(youtube_url, download=False)
                video_id = video_id or info.get('id', 'unknown')
                video_title = info.get('title', 'Unknown')

                # Sanitize filename
                safe_title = "".join(c for c in video_title if c.isalnum() or c in (' ', '-', '_')).rstrip()
                safe_title = safe_title[:100]  # Limit length

                # Subtitles and audio are separate downloads; neither waits for the other.
                with ThreadPoolExecutor(max_workers=2) as pool:
                    subtitles_job = pool.submit(self._download_subtitles, youtube_url, ydl, info)
                    audio_job = pool.submit(self._download_audio, youtube_url, video_id, safe_title)
                    subtitles_data = subtitles_job.result()
                    audio_file_path = audio_job.result()

                return {
                    'title': video_title,
                    'duration': info.get('duration', 0),
                    'subtitles': subtitles_data,
                    'video_id': video_id,
                    'audio_file_path': audio_file_path,
                }
        except Exception as e:
            raise Exception(f"Failed to extract video info: {str(e)}")

    def _extract_subtitles_via_api(self, ydl, info) -> Optional[str]:
        """Fetch subtitles via yt-dlp URLs; prefers VTT/SRT/XML over raw json3."""
        if 'subtitles' in info and info['subtitles']:
            for lang_code, subtitle_list in info['subtitles'].items():
                if lang_code.startswith('en') or lang_code == 'en':
                    subtitles_data = self._fetch_first_parseable_subtitle(ydl, subtitle_list)
                    if subtitles_data:
                        return subtitles_data

        if 'automatic_captions' in info and info['automatic_captions']:
            for lang_code, caption_list in info['automatic_captions'].items():
                if lang_code.startswith('en') or lang_code == 'en':
                    subtitles_data = self._fetch_first_parseable_subtitle(ydl, caption_list)
                    if subtitles_data:
                        return subtitles_data

        return None

    @staticmethod
    def _is_punctuation_only(text: str) -> bool:
        """
        Return True if the given text contains no alphanumeric characters
        (i.e. it's only punctuation/whitespace like '>>', '...', '♪♪', etc.).
        """
        if not text:
            return False
        stripped = text.strip()
        if not stripped:
            return False
        return not any(ch.isalnum() for ch in stripped)

    def _parse_youtube_json3(self, data: dict) -> List[Dict]:
        """YouTube timedtext json3: events with tStartMs, dDurationMs, segs[].utf8.

        Automatic captions time each word (``tOffsetMs`` within the event); those
        segments also carry ``words``, a list of ``{'text', 'start'}``.
        """
        events = [e for e in (data.get('events') or []) if isinstance(e, dict) and e.get('segs')]
        events.sort(key=lambda e: e.get('tStartMs', 0) or 0)
        segments: List[Dict] = []
        for i, ev in enumerate(events):
            start_ms = ev.get('tStartMs', 0) or 0
            dur_ms = ev.get('dDurationMs')
            if dur_ms is None or dur_ms <= 0:
                if i + 1 < len(events):
                    next_ms = events[i + 1].get('tStartMs', start_ms) or start_ms
                    dur_ms = max(50, next_ms - start_ms)
                else:
                    dur_ms = 2000
            segs = [seg for seg in ev.get('segs') or [] if isinstance(seg, dict) and 'utf8' in seg]
            text = ''.join(seg['utf8'] for seg in segs).replace('\n', ' ').strip()
            if not text:
                continue
            start = start_ms / 1000.0
            end = start + dur_ms / 1000.0
            segment = {'start_time': start, 'end_time': end, 'text': text, 'rolling': False}
            word_timed = 'wWinId' in ev or any(
                'tOffsetMs' in seg or 'acAsrConf' in seg for seg in segs
            )
            if word_timed:
                segment['words'] = [
                    {
                        'text': seg['utf8'].replace('\n', ' ').strip(),
                        'start': (start_ms + (seg.get('tOffsetMs') or 0)) / 1000.0,
                    }
                    for seg in segs
                    if seg['utf8'].strip()
                ]
            segments.append(segment)
        return segments

    @staticmethod
    def _parse_youtube_timedtext_xml(xml_content: str) -> List[Dict]:
        """YouTube srv1 / timedtext XML: <text start=\"...\" dur=\"...\">."""
        try:
            root = ET.fromstring(xml_content)
        except ET.ParseError:
            return []

        def local_tag(tag: str) -> str:
            if isinstance(tag, str) and '}' in tag:
                return tag.rsplit('}', 1)[-1]
            return tag

        raw: List[Dict] = []
        for el in root.iter():
            if local_tag(el.tag) != 'text':
                continue
            try:
                start = float(el.attrib.get('start', 0) or 0)
            except ValueError:
                start = 0.0
            try:
                dur = float(el.attrib.get('dur', 0) or 0)
            except ValueError:
                dur = 0.0
            text = ''.join(el.itertext()).strip()
            if not text:
                continue
            raw.append({'start_time': start, 'end_time': start + (dur if dur > 0 else 2.0), 'text': text})

        for i, seg in enumerate(raw):
            if seg['end_time'] <= seg['start_time'] and i + 1 < len(raw):
                seg['end_time'] = max(seg['start_time'] + 0.2, raw[i + 1]['start_time'])
        return raw

    def parse_subtitles(self, subtitle_content: str) -> List[Dict]:
        """Parse subtitle content (SRT, VTT, YouTube json3, or timedtext XML) into segments."""
        if not subtitle_content:
            return []

        stripped = subtitle_content.lstrip('\ufeff').strip()
        if stripped.startswith('{'):
            try:
                data = json.loads(stripped)
            except json.JSONDecodeError:
                data = None
            else:
                if isinstance(data, dict) and 'events' in data:
                    parsed = self._parse_youtube_json3(data)
                    if parsed:
                        return parsed

        if stripped.startswith('<?xml') or stripped.startswith('<transcript'):
            parsed = self._parse_youtube_timedtext_xml(stripped)
            if parsed:
                return parsed

        # Detect format by checking first few lines
        first_lines = subtitle_content.strip().split('\n')[:5]
        is_srt = any(line.strip().isdigit() for line in first_lines if line.strip())

        if is_srt:
            return self._parse_srt_subtitles(subtitle_content)
        else:
            return self._parse_vtt_subtitles(subtitle_content)

    def _parse_srt_subtitles(self, srt_content: str) -> List[Dict]:
        """Parse SRT subtitle content into timestamped segments"""
        if not srt_content:
            return []

        segments = []
        lines = srt_content.split('\n')
        i = 0

        while i < len(lines):
            line = lines[i].strip()

            # Skip empty lines
            if not line:
                i += 1
                continue

            # Check if this is a sequence number (SRT format starts with number)
            if line.isdigit():
                i += 1
                if i >= len(lines):
                    break

                # Next line should be the timestamp
                timestamp_line = lines[i].strip()
                # SRT format: 00:00:00,000 --> 00:00:00,000 (comma for milliseconds)
                timestamp_match = re.match(r'(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})', timestamp_line)

                if timestamp_match:
                    # Convert timestamp to seconds
                    start_seconds = (
                        int(timestamp_match.group(1)) * 3600 +
                        int(timestamp_match.group(2)) * 60 +
                        int(timestamp_match.group(3)) +
                        int(timestamp_match.group(4)) / 1000
                    )
                    end_seconds = (
                        int(timestamp_match.group(5)) * 3600 +
                        int(timestamp_match.group(6)) * 60 +
                        int(timestamp_match.group(7)) +
                        int(timestamp_match.group(8)) / 1000
                    )

                    i += 1
                    # Collect text lines until empty line
                    text_lines = []
                    while i < len(lines) and lines[i].strip():
                        text_lines.append(lines[i].strip())
                        i += 1

                    if text_lines:
                        segments.append({
                            'start_time': start_seconds,
                            'end_time': end_seconds,
                            'text': ' '.join(text_lines),
                        })
                else:
                    i += 1
            else:
                i += 1

        return segments

    def _parse_vtt_subtitles(self, vtt_content: str) -> List[Dict]:
        """Parse WebVTT subtitle content into timestamped segments"""
        if not vtt_content:
            return []

        segments = []
        lines = vtt_content.split('\n')
        current_segment = None

        for line in lines:
            line = line.strip()

            # Skip WebVTT header and empty lines
            if not line or line.startswith('WEBVTT') or line.startswith('NOTE'):
                continue

            # Check for timestamp line (format: 00:00:00.000 --> 00:00:00.000)
            timestamp_match = re.match(r'(\d{2}):(\d{2}):(\d{2})\.(\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})\.(\d{3})', line)
            if timestamp_match:
                # Convert timestamp to seconds
                start_seconds = (
                    int(timestamp_match.group(1)) * 3600 +
                    int(timestamp_match.group(2)) * 60 +
                    int(timestamp_match.group(3)) +
                    int(timestamp_match.group(4)) / 1000
                )
                end_seconds = (
                    int(timestamp_match.group(5)) * 3600 +
                    int(timestamp_match.group(6)) * 60 +
                    int(timestamp_match.group(7)) +
                    int(timestamp_match.group(8)) / 1000
                )

                if current_segment:
                    segments.append(current_segment)

                current_segment = {
                    'start_time': start_seconds,
                    'end_time': end_seconds,
                    'text': ''
                }
            elif current_segment and line:
                # Add text to current segment
                if current_segment['text']:
                    current_segment['text'] += ' ' + line
                else:
                    current_segment['text'] = line

        # Add last segment
        if current_segment:
            segments.append(current_segment)

        return segments

    def _segment_words(self, seg: Dict) -> List[Dict]:
        """The words of one caption cue, each with a start time.

        Word-timed cues keep their own times. Otherwise the cue's time span is
        shared out by word length, which is close enough to cut a sentence that
        ends in the middle of a cue.
        """
        words: List[Dict] = []
        if seg.get('words'):
            for w in seg['words']:
                cleaned = self._strip_caption_noise(self._clean_subtitle_display_text(w.get('text', '')))
                for token in cleaned.split():
                    words.append({'text': token, 'start': float(w['start']), 'end': None, 'timed': True})
        else:
            tokens = seg['text'].split()
            start = float(seg['start_time'])
            span = max(0.0, float(seg['end_time']) - start)
            total = sum(len(t) + 1 for t in tokens) or 1
            done = 0
            for token in tokens:
                word_start = start + span * done / total
                done += len(token) + 1
                words.append({
                    'text': token,
                    'start': word_start,
                    'end': start + span * done / total if span > 0 else None,
                    'timed': False,
                })
        words = [w for w in words if w['text'] not in self._NOISE_TOKENS]
        # A line break in written captions usually falls between phrases. In
        # automatic ones it only marks where the line was full.
        if words and not words[-1]['timed']:
            words[-1]['cue_end'] = True
        return words

    @staticmethod
    def _starts_upper(token: str) -> bool:
        first = next((ch for ch in token if ch.isalnum()), '')
        return first.isupper()

    def _is_sentence_end(self, token: str, next_token: Optional[str]) -> bool:
        """Whether ``token`` closes a sentence: it ends in . ! or ? and is not an abbreviation."""
        core = token.rstrip(self._CLOSERS)
        if not core or core[-1] not in '.!?…':
            return False
        if core.endswith('...') or core.endswith('…'):
            # A trailing-off pause, unless a new sentence clearly starts after it.
            return next_token is None or self._starts_upper(next_token)
        if core[-1] in '!?':
            return True
        bare = core.lstrip(self._OPENERS)
        if bare.lower() in self._ABBREVIATIONS:
            return False
        # "U.S.", "e.g.", and initials such as the "J." in "J. K. Rowling".
        if re.fullmatch(r'(?:[A-Za-z]\.){2,}', bare) or re.fullmatch(r'[A-HJ-Z]\.', bare):
            return next_token is None
        return True

    @staticmethod
    def _speech_end(word: Dict) -> float:
        """When the word has probably been said, which can be before its ``end``."""
        if word['timed']:
            return min(word['end'], word['start'] + YouTubeProcessor._TIMED_WORD_SECONDS)
        return word['end']

    def _pause_after(self, word: Dict, next_word: Dict) -> float:
        """Seconds of silence between two words, as far as the captions tell."""
        return max(0.0, next_word['start'] - self._speech_end(word))

    def _too_long(self, words: List[Dict]) -> bool:
        return (
            len(words) > self._MAX_SENTENCE_WORDS
            or words[-1]['end'] - words[0]['start'] > self._MAX_SENTENCE_SECONDS
        )

    def _best_cut(self, words: List[Dict]) -> Optional[int]:
        """Index of the word to cut a too-long sentence after, or None to leave it whole.

        Prefers a comma, semicolon or colon, then a pause, a line break in
        written captions or a word like "and" or "because" coming next, and
        among equals the place nearest the middle.
        """
        n = len(words)
        if not self._too_long(words) or n < 2 * self._MIN_SPLIT_CHUNK:
            return None
        middle = (n - 2) / 2
        best, best_score = None, None
        for i in range(self._MIN_SPLIT_CHUNK - 1, n - self._MIN_SPLIT_CHUNK):
            core = words[i]['text'].rstrip(self._CLOSERS)
            if core and core[-1] in ',;:':
                score = 2.0
            elif words[i + 1]['text'].lower() in self._CLAUSE_OPENERS:
                score = 0.6
            else:
                score = 0.0
            score += 1.5 * min(self._pause_after(words[i], words[i + 1]), 1.5)
            if words[i].get('cue_end'):
                score += 1.0
            score -= 2.0 * abs(i - middle) / n
            if best_score is None or score > best_score:
                best, best_score = i, score
        return best

    def _split_long(self, words: List[Dict]) -> List[List[Dict]]:
        out: List[List[Dict]] = []
        stack = [words]
        while stack:
            chunk = stack.pop()
            cut = self._best_cut(chunk)
            if cut is None:
                out.append(chunk)
            else:
                stack.append(chunk[cut + 1:])
                stack.append(chunk[:cut + 1])
        return out

    def _split_at_pauses(self, words: List[Dict]) -> List[List[Dict]]:
        """Cut unpunctuated speech wherever the speaker pauses."""
        chunks: List[List[Dict]] = []
        current: List[Dict] = []
        n = len(words)
        hold = False  # the pause found before the previous word is cut after this one
        for i, word in enumerate(words):
            current.append(word)
            if i + 1 >= n:
                break
            paused = self._pause_after(word, words[i + 1]) >= self._PAUSE_SPLIT_SECONDS
            # YouTube often shows the last word before a pause late, so that the
            # pause seems to sit in front of it. A pause on both sides of a word
            # is that case: the word closes the phrase before it.
            if paused and not hold and i + 2 < n and (
                self._pause_after(words[i + 1], words[i + 2]) >= self._PAUSE_SPLIT_SECONDS
            ):
                hold = True
                continue
            if paused or hold:
                chunks.append(current)
                current = []
            hold = False
        if current:
            chunks.append(current)
        return chunks

    def _merge_short(self, chunks: List[List[Dict]]) -> List[List[Dict]]:
        """Join one- and two-word sentences ("Okay.", "Thank you.") to a neighbour."""
        def can_join(left: List[Dict], right: List[Dict]) -> bool:
            return (
                right[0]['start'] - left[-1]['end'] <= self._MERGE_GAP_SECONDS
                and not self._too_long(left + right)
            )

        out: List[List[Dict]] = []
        carried: List[Dict] = []
        for i, chunk in enumerate(chunks):
            chunk = carried + chunk
            carried = []
            if len(chunk) < self._MIN_SENTENCE_WORDS:
                nxt = chunks[i + 1] if i + 1 < len(chunks) else None
                if nxt and can_join(chunk, nxt):
                    carried = chunk
                    continue
                if out and can_join(out[-1], chunk):
                    out[-1] = out[-1] + chunk
                    continue
            out.append(chunk)
        return out

    def segment_into_sentences(self, segments: List[Dict]) -> List[Dict]:
        """
        Turn caption cues into sentences that end where the speaker's sentence ends.

        The cues are flattened into one stream of timed words, which is cut after
        every word ending in ``.`` ``!`` or ``?``. Sentences too long to type in
        one go are cut again at a comma or a pause, and very short ones join a
        neighbour. Captions with no punctuation at all are cut at pauses.

        Each sentence starts just before its first word and ends just after its
        last, never overlapping its neighbours, and start times strictly increase.
        """
        cleaned_segments: List[Dict] = []
        for s in segments:
            text = self._strip_caption_noise(self._clean_subtitle_display_text(s.get("text", "")))
            if not text:
                continue
            if self._is_punctuation_only(text):
                continue
            cleaned = dict(s)
            cleaned["text"] = text
            cleaned_segments.append(cleaned)

        sorted_segments = sorted(cleaned_segments, key=lambda s: s["start_time"])

        # json3 gives each phrase once. The other formats of automatic captions
        # roll: every cue repeats the previous one, which has to be undone.
        if any(s.get('rolling', True) for s in sorted_segments):
            sorted_segments = self._dedupe_rolling_subtitle_cues(sorted_segments)

        words: List[Dict] = []
        for seg in sorted_segments:
            words.extend(self._segment_words(seg))
        if not words:
            return []

        # Starts never go backwards, and a word ends no later than the next one starts.
        for i, word in enumerate(words):
            if i and word['start'] < words[i - 1]['start']:
                word['start'] = words[i - 1]['start']
        for i, word in enumerate(words):
            end = word['end'] if word['end'] is not None else word['start'] + self._MAX_WORD_SECONDS
            if i + 1 < len(words) and words[i + 1]['start'] > word['start']:
                end = min(end, words[i + 1]['start'])
            word['end'] = max(end, word['start'])

        chunks: List[List[Dict]] = []
        current: List[Dict] = []
        for i, word in enumerate(words):
            current.append(word)
            next_token = words[i + 1]['text'] if i + 1 < len(words) else None
            if self._is_sentence_end(word['text'], next_token):
                chunks.append(current)
                current = []
        if current:
            chunks.append(current)

        if len(words) > self._MAX_SENTENCE_WORDS and len(chunks) - 1 < len(words) / 60:
            # Next to no full stops in the whole video: automatic captions
            # without punctuation. Pauses are the only sign of a sentence end.
            chunks = [part for chunk in chunks for part in self._split_at_pauses(chunk)]

        chunks = [part for chunk in chunks for part in self._split_long(chunk)]
        chunks = self._merge_short(chunks)

        sentences: List[Dict] = []
        for idx, chunk in enumerate(chunks):
            first_word = chunk[0]['start']
            # Lead in a little so the first sound is not clipped, but not into
            # the previous sentence's last word.
            floor = min(self._speech_end(chunks[idx - 1][-1]), first_word) if idx else 0.0
            start = max(first_word - self._LEAD_IN_SECONDS, floor, 0.0)
            if sentences and start <= sentences[-1]['start_time']:
                start = sentences[-1]['start_time'] + 0.01
            sentences.append(
                {
                    "sentence_text": " ".join(w['text'] for w in chunk),
                    "start_time": round(start, 3),
                    "end_time": chunk[-1]['end'] + self._TAIL_SECONDS,
                    "sentence_index": idx,
                }
            )
        for idx, sentence in enumerate(sentences):
            end = sentence['end_time']
            if idx + 1 < len(sentences):
                end = min(end, sentences[idx + 1]['start_time'])
            sentence['end_time'] = round(max(end, sentence['start_time'] + 0.01), 3)

        return sentences

    def process_youtube_video(self, youtube_url: str, db: Session, user_id: int) -> Dict:
        """Process a YouTube video: extract, segment, and store in database"""
        youtube_url = youtube_url.strip().rstrip(',;')
        # Each account keeps its own copy of a lesson, so another account's row
        # for the same URL is not a match. Rows from before accounts existed have
        # no owner and go to whoever imports the URL next.
        existing_video = (
            db.query(Video)
            .filter(
                Video.youtube_url == youtube_url,
                or_(Video.user_id == user_id, Video.user_id.is_(None)),
            )
            .order_by(Video.user_id.is_(None), Video.id)
            .first()
        )
        if existing_video:
            was_deleted = getattr(existing_video, "deleted_at", None) is not None

            if was_deleted:
                existing_video.deleted_at = None

            if existing_video.user_id != user_id:
                existing_video.user_id = user_id

            if not was_deleted:
                db.commit()
                sentences = (
                    db.query(Sentence)
                    .filter(Sentence.video_id == existing_video.id)
                    .order_by(Sentence.sentence_index)
                    .all()
                )
                return {
                    'video_id': existing_video.id,
                    'title': existing_video.title,
                    'duration': existing_video.duration,
                    'sentence_count': len(sentences),
                    'message': 'Video already processed',
                }

            # Soft-deleted lesson restored: re-fetch from YouTube and replace sentences/audio.
            db.query(LearningProgress).filter(
                LearningProgress.video_id == existing_video.id
            ).update({LearningProgress.sentence_id: None}, synchronize_session=False)

            old_audio = existing_video.audio_file_path
            existing_video.audio_file_path = None

            db.query(Sentence).filter(Sentence.video_id == existing_video.id).delete(
                synchronize_session=False
            )
            db.flush()
            # Another account's copy of this lesson may still play the same file.
            remove_unreferenced_audio(db, [old_audio])

            video_info = self.extract_video_info(youtube_url)

            if not video_info.get('subtitles'):
                raise Exception("No subtitles available for this video")

            segments = self.parse_subtitles(video_info['subtitles'])

            if not segments:
                raise Exception("Could not parse subtitles from video")

            sentences = self.segment_into_sentences(segments)

            if not sentences:
                raise Exception("Could not segment subtitles into sentences")

            existing_video.title = video_info['title']
            existing_video.duration = video_info['duration']
            existing_video.audio_file_path = video_info.get('audio_file_path')

            for sentence_data in sentences:
                db.add(
                    Sentence(
                        video_id=existing_video.id,
                        sentence_text=sentence_data['sentence_text'],
                        start_time=sentence_data['start_time'],
                        end_time=sentence_data['end_time'],
                        sentence_index=sentence_data['sentence_index'],
                    )
                )

            db.commit()

            from services.qdrant_client import delete_sentence_vectors_for_video

            delete_sentence_vectors_for_video(existing_video.id)

            return {
                'video_id': existing_video.id,
                'title': existing_video.title,
                'duration': existing_video.duration,
                'sentence_count': len(sentences),
                'message': 'Video processed successfully',
            }

        # Extract video info and subtitles
        video_info = self.extract_video_info(youtube_url)

        if not video_info.get('subtitles'):
            raise Exception("No subtitles available for this video")

        segments = self.parse_subtitles(video_info['subtitles'])

        if not segments:
            raise Exception("Could not parse subtitles from video")
        # Segment into sentences
        sentences = self.segment_into_sentences(segments)

        if not sentences:
            raise Exception("Could not segment subtitles into sentences")

        # Store in database
        video = Video(
            user_id=user_id,
            youtube_url=youtube_url,
            title=video_info['title'],
            duration=video_info['duration'],
            audio_file_path=video_info.get('audio_file_path')
        )
        db.add(video)
        db.flush()  # Get video ID

        # Store sentences
        for sentence_data in sentences:
            sentence = Sentence(
                video_id=video.id,
                sentence_text=sentence_data['sentence_text'],
                start_time=sentence_data['start_time'],
                end_time=sentence_data['end_time'],
                sentence_index=sentence_data['sentence_index']
            )
            db.add(sentence)

        db.commit()

        return {
            'video_id': video.id,
            'title': video.title,
            'duration': video.duration,
            'sentence_count': len(sentences),
            'message': 'Video processed successfully'
        }
