"""Parsing the subtitle formats YouTube serves (json3, timedtext XML, SRT, WebVTT)
into cues: dicts with text, start and end."""
import json
import re
import xml.etree.ElementTree as ET
from typing import Dict, List


class SubtitleParserMixin:
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
