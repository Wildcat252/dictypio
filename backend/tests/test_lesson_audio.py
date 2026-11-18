"""Lesson audio that went missing, failed downloads, and ranged audio responses.
Run from backend/: python -m unittest discover tests"""
import unittest

from support import TMP_DIR, AppTestCase, bearer, dispose_engine  # sets up the environment first

from database import SessionLocal, Sentence, Video
from routers import youtube as youtube_router
from routers.youtube import AUDIO_RANGE_CHUNK, RangeNotSatisfiable, parse_range
from services import qdrant_client
from services.audio_files import count_audio_lessons
from services.youtube_processor import AudioDownloadError, YouTubeProcessor

tearDownModule = dispose_engine

URL = "https://www.youtube.com/watch?v=lost1234567"
SRT = """1
00:00:00,000 --> 00:00:02,000
Hello there, this is the first sentence.

2
00:00:02,000 --> 00:00:04,000
And here comes the second one.
"""


class ParseRangeTest(unittest.TestCase):
    def test_ranges(self):
        size = 100
        self.assertIsNone(parse_range(None, size))
        self.assertIsNone(parse_range("bytes=0-1,5-6", size))  # several: whole file
        self.assertEqual(parse_range("bytes=0-", size), (0, 99))
        self.assertEqual(parse_range("bytes=10-19", size), (10, 19))
        self.assertEqual(parse_range("bytes=90-500", size), (90, 99))
        self.assertEqual(parse_range("bytes=-30", size), (70, 99))
        self.assertEqual(parse_range("bytes=-500", size), (0, 99))
        for bad in ("bytes=100-", "bytes=20-10", "bytes=-", "bytes=-0"):
            with self.subTest(bad=bad), self.assertRaises(RangeNotSatisfiable):
                parse_range(bad, size)

    def test_a_large_range_is_cut_to_one_chunk(self):
        size = AUDIO_RANGE_CHUNK * 3
        self.assertEqual(parse_range("bytes=0-", size), (0, AUDIO_RANGE_CHUNK - 1))
        start = AUDIO_RANGE_CHUNK * 2 + 5
        self.assertEqual(parse_range(f"bytes={start}-", size), (start, size - 1))


class FailedDownloadTest(unittest.TestCase):
    def test_no_audio_is_an_error_not_a_lesson_without_audio(self):
        processor = YouTubeProcessor(download_dir=str(TMP_DIR / "dl"), audio_dir=str(TMP_DIR / "a"))

        def nothing(_url, _vid, _title, errors):
            errors.append("ERROR: Sign in to confirm you're not a bot")
            return None

        processor._try_download_audio = nothing
        with self.assertRaises(AudioDownloadError) as ctx:
            processor._download_audio(URL, "lost1234567", "Lost")
        self.assertIn("not a bot", str(ctx.exception))
        # The router turns that into the plain "YouTube is blocking" message.
        self.assertTrue(youtube_router.is_youtube_block_error(str(ctx.exception)))


class MissingAudioTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.audio_dir = TMP_DIR / "audio-store"
        self.audio_dir.mkdir(exist_ok=True)
        self.audio = self.audio_dir / "lost1234567_Lost lesson.m4a"
        self.audio.unlink(missing_ok=True)
        self.audio_only_downloads = 0

        def fake_extract(_processor, _url, video_id=None):
            self.audio.write_bytes(b"x" * 1000)
            return {"title": "Lost lesson", "duration": 4, "subtitles": SRT,
                    "video_id": "lost1234567", "audio_file_path": str(self.audio)}

        def fake_audio_only(_processor, _url):
            self.audio_only_downloads += 1
            self.audio.write_bytes(b"y" * 1000)
            return str(self.audio)

        processor = YouTubeProcessor(download_dir=str(TMP_DIR / "dl"), audio_dir=str(self.audio_dir))
        self._replace(youtube_router, "_processor", processor)
        self._replace(YouTubeProcessor, "extract_video_info", fake_extract)
        self._replace(YouTubeProcessor, "download_lesson_audio", fake_audio_only)
        self._replace(youtube_router, "ingest_sentences_for_video", lambda **kw: None)
        self._replace(youtube_router, "delete_sentence_vectors_for_video", lambda video_id: None)
        self._replace(qdrant_client, "delete_sentence_vectors_for_video", lambda video_id: None)

    def import_video(self, token):
        return self.client.post("/api/youtube/process", json={"url": URL}, headers=bearer(token))

    def test_audio_comes_in_ranges(self):
        token = self.signup()
        video_id = self.import_video(token).json()["video_id"]
        r = self.client.get(f"/api/youtube/videos/{video_id}/audio",
                            headers={**bearer(token), "Range": "bytes=100-"})
        self.assertEqual(r.status_code, 206)
        self.assertEqual(r.headers["content-range"], "bytes 100-999/1000")
        self.assertEqual(len(r.content), 900)
        r = self.client.get(f"/api/youtube/videos/{video_id}/audio",
                            headers={**bearer(token), "Range": "bytes=5000-"})
        self.assertEqual(r.status_code, 416)

    def test_lost_audio_is_reported_and_reimport_restores_it(self):
        token = self.signup()
        first = self.import_video(token)
        self.assertEqual(first.status_code, 200, first.text)
        video_id = first.json()["video_id"]
        sentences = first.json()["sentence_count"]
        user_id = self.me(token).json()["id"]

        self.audio.unlink()  # the disk it was on was wiped
        r = self.client.get(f"/api/youtube/videos/{video_id}/audio", headers=bearer(token))
        self.assertEqual(r.status_code, 404)
        self.assertIn("Import the same YouTube link again", r.json()["detail"])
        with SessionLocal() as db:
            self.assertIsNone(db.get(Video, video_id).audio_file_path)
            self.assertEqual(count_audio_lessons(db, user_id), 0)  # frees its slot
            sentence_ids = [s.id for s in db.query(Sentence).filter(Sentence.video_id == video_id)]

        again = self.import_video(token)
        self.assertEqual(again.status_code, 200, again.text)
        self.assertEqual(again.json()["video_id"], video_id)
        self.assertEqual(again.json()["message"], "Audio restored")
        self.assertEqual(again.json()["sentence_count"], sentences)
        self.assertEqual(self.audio_only_downloads, 1)
        with SessionLocal() as db:
            # Same sentence rows: progress on them is kept.
            self.assertEqual(
                [s.id for s in db.query(Sentence).filter(Sentence.video_id == video_id)], sentence_ids)
        r = self.client.get(f"/api/youtube/videos/{video_id}/audio", headers=bearer(token))
        self.assertEqual(r.status_code, 200)

        # With the audio there, importing again changes nothing.
        self.assertEqual(self.import_video(token).json()["message"], "Video already processed")
        self.assertEqual(self.audio_only_downloads, 1)

    def test_an_unmounted_audio_dir_does_not_wipe_lessons(self):
        token = self.signup()
        video_id = self.import_video(token).json()["video_id"]
        self.audio.unlink()
        self.audio_dir.rmdir()  # the bucket mount is missing, not the file
        try:
            r = self.client.get(f"/api/youtube/videos/{video_id}/audio", headers=bearer(token))
            self.assertEqual(r.status_code, 404)
            with SessionLocal() as db:
                self.assertEqual(db.get(Video, video_id).audio_file_path, str(self.audio))
        finally:
            self.audio_dir.mkdir(exist_ok=True)


if __name__ == "__main__":
    unittest.main()
