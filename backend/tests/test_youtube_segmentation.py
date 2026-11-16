"""Cutting captions into sentences. Run from backend/: python -m unittest discover tests"""
import json
import os
import unittest
from unittest import mock

from support import TMP_DIR, AppTestCase, dispose_engine  # sets up the environment first

from database import SessionLocal, Video
from services import audio_files
from services.youtube_processor import YouTubeProcessor

tearDownModule = dispose_engine


def auto_captions(*events):
    """A json3 payload like YouTube's automatic captions.

    Each event is (start_ms, [(word, offset_ms), ...]).
    """
    out = []
    for start_ms, words in events:
        segs = []
        for i, (word, offset_ms) in enumerate(words):
            seg = {"utf8": word if i == 0 else " " + word, "acAsrConf": 0}
            if offset_ms:
                seg["tOffsetMs"] = offset_ms
            segs.append(seg)
        out.append({"tStartMs": start_ms, "dDurationMs": 4000, "wWinId": 1, "segs": segs})
        # YouTube closes each line with an event that only holds a line break.
        out.append({"tStartMs": start_ms + 10, "wWinId": 1, "aAppend": 1, "segs": [{"utf8": "\n"}]})
    return json.dumps({"events": out})


def spoken(text, start=0.0, step=0.4):
    """One caption event per six words of ``text``, a word every ``step`` seconds."""
    words = text.split()
    events = []
    for i in range(0, len(words), 6):
        line = words[i:i + 6]
        line_start = int((start + i * step) * 1000)
        events.append((line_start, [(w, int(j * step * 1000)) for j, w in enumerate(line)]))
    return auto_captions(*events)


class SegmentationTest(unittest.TestCase):
    def setUp(self):
        self.processor = YouTubeProcessor(
            download_dir=str(TMP_DIR / "downloads"), audio_dir=str(TMP_DIR / "audio")
        )

    def sentences(self, subtitles):
        result = self.processor.segment_into_sentences(self.processor.parse_subtitles(subtitles))
        self.assert_well_formed(result)
        return result

    def texts(self, subtitles):
        return [s["sentence_text"] for s in self.sentences(subtitles)]

    def assert_well_formed(self, sentences):
        for i, s in enumerate(sentences):
            self.assertEqual(s["sentence_index"], i)
            self.assertGreater(s["end_time"], s["start_time"])
            if i:
                self.assertGreater(s["start_time"], sentences[i - 1]["start_time"])
                self.assertLessEqual(sentences[i - 1]["end_time"], s["start_time"])

    def test_a_sentence_ends_at_its_full_stop_not_at_the_caption_line(self):
        # The full stop falls in the middle of the second caption line.
        subtitles = auto_captions(
            (1000, [("We", 0), ("went", 300), ("to", 600), ("the", 800)]),
            (2200, [("market", 0), ("yesterday.", 500), ("It", 1500), ("was", 1800)]),
            (4400, [("really", 0), ("crowded", 400), ("there.", 900)]),
        )
        result = self.sentences(subtitles)
        self.assertEqual(
            [s["sentence_text"] for s in result],
            ["We went to the market yesterday.", "It was really crowded there."],
        )
        # "It" is spoken at 3.7 s: the second sentence starts just before it,
        # not at the start of its caption line (2.2 s).
        self.assertAlmostEqual(result[1]["start_time"], 3.55, places=2)
        self.assertAlmostEqual(result[0]["start_time"], 0.85, places=2)
        # "yesterday." starts at 2.7 s and the sentence ends before "It".
        self.assertGreater(result[0]["end_time"], 2.7)
        self.assertLessEqual(result[0]["end_time"], 3.7)

    def test_question_and_exclamation_marks_end_sentences(self):
        self.assertEqual(
            self.texts(spoken("Did you see that goal? What a great shot! I could not believe it.")),
            ["Did you see that goal?", "What a great shot!", "I could not believe it."],
        )

    def test_abbreviations_initials_and_decimals_do_not_end_a_sentence(self):
        self.assertEqual(
            self.texts(spoken(
                "Yesterday Dr. Smith moved to the U.S. with J. K. Rowling. "
                "The rent went up by 3.5 percent."
            )),
            [
                "Yesterday Dr. Smith moved to the U.S. with J. K. Rowling.",
                "The rent went up by 3.5 percent.",
            ],
        )

    def test_closing_quote_stays_with_its_sentence(self):
        self.assertEqual(
            self.texts(spoken('Then she said, "We are leaving." Nobody moved an inch.')),
            ['Then she said, "We are leaving."', "Nobody moved an inch."],
        )

    def test_a_long_sentence_is_cut_at_a_comma(self):
        text = (
            "When the rain finally stopped after three long days of storms, "
            "the whole village came out to repair the bridge that connected "
            "them to the market town across the river."
        )
        parts = self.texts(spoken(text))
        self.assertGreater(len(parts), 1)
        self.assertTrue(parts[0].endswith("storms,"), parts)
        self.assertEqual(" ".join(parts), text)
        for part in parts:
            self.assertLessEqual(len(part.split()), YouTubeProcessor._MAX_SENTENCE_WORDS)

    def test_short_sentences_join_a_neighbour(self):
        self.assertEqual(
            self.texts(spoken("Okay. So today we are going to bake some bread. Thank you.")),
            ["Okay. So today we are going to bake some bread. Thank you."],
        )

    def test_a_short_sentence_far_from_the_rest_stays_alone(self):
        subtitles = auto_captions(
            (0, [("Welcome", 0), ("back", 400), ("to", 700), ("the", 900), ("show.", 1100)]),
            (30000, [("Right.", 0)]),
            (60000, [("Here", 0), ("is", 300), ("the", 500), ("first", 700), ("question.", 1000)]),
        )
        self.assertEqual(
            self.texts(subtitles),
            ["Welcome back to the show.", "Right.", "Here is the first question."],
        )

    def test_captions_without_punctuation_are_cut_at_pauses(self):
        # Three bursts of speech with two seconds of silence between them.
        bursts = [
            "so today we are going to look at how bread is made",
            "first you need flour water salt and a little bit of yeast",
            "then you mix everything together and leave it to rest",
        ]
        events, t = [], 0.0
        for burst in bursts:
            words = burst.split()
            for i in range(0, len(words), 6):
                line = words[i:i + 6]
                events.append((int((t + i * 0.3) * 1000), [(w, int(j * 300)) for j, w in enumerate(line)]))
            t += len(words) * 0.3 + 2.0
        self.assertEqual(self.texts(auto_captions(*events)), bursts)

    def test_music_tags_and_speaker_arrows_are_dropped(self):
        subtitles = auto_captions(
            (0, [("[Music]", 0)]),
            (2000, [(">>", 0), ("Hello", 100), ("and", 500), ("welcome", 700), ("everyone.", 1100)]),
        )
        result = self.sentences(subtitles)
        self.assertEqual([s["sentence_text"] for s in result], ["Hello and welcome everyone."])
        self.assertAlmostEqual(result[0]["start_time"], 1.95, places=2)

    def test_sound_descriptions_in_written_captions_are_dropped(self):
        srt = (
            "1\n00:00:01,000 --> 00:00:04,000\nSo, you know -- (Laughter) you get started.\n\n"
            "2\n00:00:04,000 --> 00:00:07,000\n(Audience applause) That was (I think) the plan.\n"
        )
        self.assertEqual(
            self.texts(srt),
            ["So, you know -- you get started.", "That was (I think) the plan."],
        )

    def test_written_captions_without_word_timings_are_cut_at_full_stops_too(self):
        srt = (
            "1\n00:00:01,000 --> 00:00:05,000\nThis is the first sentence. And the\n\n"
            "2\n00:00:05,000 --> 00:00:08,000\nsecond one ends right here.\n\n"
            "3\n00:00:08,500 --> 00:00:11,000\nThe third sentence is last.\n"
        )
        result = self.sentences(srt)
        self.assertEqual(
            [s["sentence_text"] for s in result],
            [
                "This is the first sentence.",
                "And the second one ends right here.",
                "The third sentence is last.",
            ],
        )
        # The second sentence starts inside the first cue, the third at its own cue.
        self.assertGreater(result[1]["start_time"], 3.0)
        self.assertLess(result[1]["start_time"], 5.0)
        self.assertAlmostEqual(result[2]["start_time"], 8.35, places=2)

    def test_written_captions_in_json3_keep_words_that_repeat_across_lines(self):
        # Rolling-caption cleanup must not eat "the" at the start of the second line.
        payload = json.dumps({"events": [
            {"tStartMs": 0, "dDurationMs": 2000, "segs": [{"utf8": "I walked over to the"}]},
            {"tStartMs": 2000, "dDurationMs": 2000, "segs": [{"utf8": "theatre on my own."}]},
        ]})
        self.assertEqual(self.texts(payload), ["I walked over to the theatre on my own."])

    def test_no_captions_gives_no_sentences(self):
        self.assertEqual(self.processor.segment_into_sentences([]), [])
        self.assertEqual(self.sentences(auto_captions((0, [("[Music]", 0)]))), [])


class CaptionTrackTest(unittest.TestCase):
    def test_written_captions_win_over_automatic_ones(self):
        info = {
            "subtitles": {"live_chat": [], "en-GB": [], "fr": []},
            "automatic_captions": {"en": [], "en-orig": [], "de": []},
        }
        self.assertEqual(YouTubeProcessor._pick_caption_track(info), ("en-GB", False))

    def test_automatic_captions_are_the_fallback(self):
        info = {"subtitles": {"fr": []}, "automatic_captions": {"en-orig": [], "en": [], "de": []}}
        self.assertEqual(YouTubeProcessor._pick_caption_track(info), ("en", True))

    def test_no_english_track(self):
        self.assertIsNone(YouTubeProcessor._pick_caption_track({"subtitles": {"enm": []}}))
        self.assertIsNone(YouTubeProcessor._pick_caption_track({}))


class SeekableAudioTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.mp3 = TMP_DIR / "old lesson.mp3"
        self.mp3.write_bytes(b"old mp3")
        self.m4a = TMP_DIR / "old lesson.m4a"
        self.m4a.unlink(missing_ok=True)
        self.addCleanup(self.mp3.unlink, missing_ok=True)
        self.addCleanup(self.m4a.unlink, missing_ok=True)
        audio_files._convert_locks.clear()

        self.db = SessionLocal()
        self.addCleanup(self.db.close)
        for user_id in (1, 2):
            self.db.add(Video(
                user_id=user_id,
                youtube_url="https://www.youtube.com/watch?v=abc123XYZ_0",
                title="Old lesson",
                duration=10,
                audio_file_path=str(self.mp3),
            ))
        self.db.commit()

    def paths(self):
        self.db.expire_all()
        return {path for (path,) in self.db.query(Video.audio_file_path)}

    def fake_ffmpeg(self, returncode=0):
        """Stand in for FFmpeg: writes the output file it was asked for."""
        def run(cmd, **_kwargs):
            if returncode == 0:
                with open(cmd[-1], "wb") as f:
                    f.write(b"converted")
            return mock.Mock(returncode=returncode, stderr="boom")

        self._replace(audio_files.shutil, "which", lambda _name: "ffmpeg")
        self._replace(audio_files.subprocess, "run", run)

    def test_an_mp3_is_converted_once_for_every_lesson_that_shares_it(self):
        self.fake_ffmpeg()
        self.assertEqual(audio_files.ensure_seekable_audio(self.db, str(self.mp3)), str(self.m4a))
        self.assertEqual(self.m4a.read_bytes(), b"converted")
        self.assertFalse(self.mp3.exists())
        self.assertEqual(self.paths(), {str(self.m4a)})

        # A request that still holds the old path is sent to the converted file.
        self.assertEqual(audio_files.ensure_seekable_audio(self.db, str(self.mp3)), str(self.m4a))

    def test_without_ffmpeg_the_mp3_is_served_as_before(self):
        self._replace(audio_files.shutil, "which", lambda _name: None)
        self.assertEqual(audio_files.ensure_seekable_audio(self.db, str(self.mp3)), str(self.mp3))
        self.assertTrue(self.mp3.exists())
        self.assertEqual(self.paths(), {str(self.mp3)})

    def test_a_failed_conversion_keeps_the_mp3(self):
        self.fake_ffmpeg(returncode=1)
        self.assertEqual(audio_files.ensure_seekable_audio(self.db, str(self.mp3)), str(self.mp3))
        self.assertTrue(self.mp3.exists())
        self.assertEqual(os.listdir(TMP_DIR).count("old lesson.converting.m4a"), 0)
        self.assertEqual(self.paths(), {str(self.mp3)})

    def test_other_formats_are_left_alone(self):
        self.fake_ffmpeg()
        self.assertEqual(audio_files.ensure_seekable_audio(self.db, "lesson.m4a"), "lesson.m4a")
        self.assertIsNone(audio_files.ensure_seekable_audio(self.db, None))


if __name__ == "__main__":
    unittest.main()
