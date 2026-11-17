"""Turning caption cues into dictation sentences: clean the text, find the
sentence ends, split what is too long and merge what is too short."""
import html
import re
from typing import Dict, List, Optional


class SentenceSegmenterMixin:
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

    @staticmethod
    def _strip_caption_noise(text: str) -> str:
        """Drop what is not speech: ``[Music]``, speaker arrows ``>>``, music notes."""
        t = re.sub(r'\[[^\]]*\]', ' ', text or '')
        t = SentenceSegmenterMixin._SOUND_TAG.sub(' ', t)
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
            return min(word['end'], word['start'] + SentenceSegmenterMixin._TIMED_WORD_SECONDS)
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
