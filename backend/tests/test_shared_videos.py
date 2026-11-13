"""Two accounts importing the same YouTube video. Run from backend/: python -m unittest discover tests"""
import unittest
from unittest import mock

from support import PASSWORD, TMP_DIR, AppTestCase, bearer, dispose_engine  # sets up the environment first

from database import SessionLocal, Video
from routers import youtube as youtube_router
from services import qdrant_client
from services.youtube_processor import YouTubeProcessor

tearDownModule = dispose_engine

URL = "https://www.youtube.com/watch?v=abc123XYZ_0"
SRT = """1
00:00:00,000 --> 00:00:02,000
Hello there, this is the first sentence.

2
00:00:02,000 --> 00:00:04,000
And here comes the second one.
"""


class SharedVideoTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.audio = TMP_DIR / "abc123XYZ_0_Shared lesson.mp3"
        self.audio.unlink(missing_ok=True)
        self.downloads = 0

        def fake_extract(_processor, _url, video_id=None):
            # Like the real one: the path depends only on the video, and an
            # existing file is reused instead of downloaded again.
            if not self.audio.exists():
                self.audio.write_bytes(b"not really audio")
                self.downloads += 1
            return {
                "title": "Shared lesson",
                "duration": 4,
                "subtitles": SRT,
                "video_id": "abc123XYZ_0",
                "audio_file_path": str(self.audio),
            }

        processor = YouTubeProcessor(download_dir=str(TMP_DIR / "dl"), audio_dir=str(TMP_DIR))
        self._replace(youtube_router, "_processor", processor)
        self._replace(YouTubeProcessor, "extract_video_info", fake_extract)
        # No vector store in these tests.
        self._replace(youtube_router, "ingest_sentences_for_video", lambda **kw: None)
        self._replace(youtube_router, "delete_sentence_vectors_for_video", lambda video_id: None)
        self._replace(qdrant_client, "delete_sentence_vectors_for_video", lambda video_id: None)

    def import_video(self, token):
        return self.client.post("/api/youtube/process", json={"url": URL}, headers=bearer(token))

    def lessons(self, token):
        return self.client.get("/api/youtube/videos", headers=bearer(token)).json()

    def delete_lesson(self, token, video_id):
        return self.client.delete(f"/api/youtube/videos/{video_id}", headers=bearer(token))

    def audio_status(self, token, video_id):
        return self.client.get(f"/api/youtube/videos/{video_id}/audio", headers=bearer(token)).status_code

    def two_accounts_with_the_lesson(self):
        a, b = self.signup(), self.signup("b@example.com")
        first, second = self.import_video(a), self.import_video(b)
        self.assertEqual(first.status_code, 200, first.text)
        self.assertEqual(second.status_code, 200, second.text)
        return a, b, first.json()["video_id"], second.json()["video_id"]

    def test_each_account_gets_its_own_copy(self):
        a, b, a_video, b_video = self.two_accounts_with_the_lesson()
        self.assertNotEqual(a_video, b_video)
        self.assertEqual([v["id"] for v in self.lessons(a)], [a_video])
        self.assertEqual([v["id"] for v in self.lessons(b)], [b_video])
        self.assertEqual(self.lessons(b)[0]["sentence_count"], self.lessons(a)[0]["sentence_count"])
        self.assertGreater(self.lessons(b)[0]["sentence_count"], 0)
        # One download serves both.
        self.assertEqual(self.downloads, 1)
        # Neither can reach the other's copy.
        self.assertEqual(self.audio_status(a, b_video), 404)

    def test_importing_twice_reuses_the_accounts_copy(self):
        a = self.signup()
        first = self.import_video(a).json()
        again = self.import_video(a).json()
        self.assertEqual(again["video_id"], first["video_id"])
        self.assertEqual(len(self.lessons(a)), 1)

    def test_deleting_one_copy_keeps_the_shared_audio(self):
        a, b, a_video, b_video = self.two_accounts_with_the_lesson()

        self.assertEqual(self.delete_lesson(a, a_video).status_code, 200)
        self.assertTrue(self.audio.exists())
        self.assertEqual(self.audio_status(b, b_video), 200)
        self.assertEqual(self.lessons(a), [])

        # The last copy takes the file with it.
        self.assertEqual(self.delete_lesson(b, b_video).status_code, 200)
        self.assertFalse(self.audio.exists())

    def test_reimporting_a_deleted_copy_keeps_the_shared_audio(self):
        a, b, a_video, b_video = self.two_accounts_with_the_lesson()
        self.assertEqual(self.delete_lesson(a, a_video).status_code, 200)

        restored = self.import_video(a)
        self.assertEqual(restored.status_code, 200, restored.text)
        self.assertEqual(restored.json()["video_id"], a_video)
        self.assertEqual(self.downloads, 1)
        self.assertEqual(self.audio_status(a, a_video), 200)
        self.assertEqual(self.audio_status(b, b_video), 200)

    def test_deleting_an_account_keeps_audio_others_use(self):
        a, b, _a_video, b_video = self.two_accounts_with_the_lesson()

        r = self.client.post("/api/account/delete", json={"password": PASSWORD}, headers=bearer(a))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertTrue(self.audio.exists())
        self.assertEqual(self.audio_status(b, b_video), 200)

        r = self.client.post("/api/account/delete", json={"password": PASSWORD}, headers=bearer(b))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertFalse(self.audio.exists())

    def test_ownerless_row_goes_to_the_importer(self):
        # Rows from before accounts existed have no user_id.
        with SessionLocal() as db:
            legacy = Video(user_id=None, youtube_url=URL, title="Legacy", duration=4.0)
            db.add(legacy)
            db.commit()
            legacy_id = legacy.id
        a, b = self.signup(), self.signup("b@example.com")

        claimed = self.import_video(a)
        self.assertEqual(claimed.status_code, 200, claimed.text)
        self.assertEqual(claimed.json()["video_id"], legacy_id)
        self.assertNotEqual(self.import_video(b).json()["video_id"], legacy_id)


class BlockedByYouTubeTest(AppTestCase):
    def import_with(self, error):
        def fail(_processor, _url, video_id=None):
            raise Exception(f"Failed to extract video info: {error}")

        self._replace(YouTubeProcessor, "extract_video_info", fail)
        self._replace(youtube_router, "_processor", YouTubeProcessor(
            download_dir=str(TMP_DIR / "dl"), audio_dir=str(TMP_DIR)))
        self.attempts = getattr(self, "attempts", 0) + 1
        token = self.signup(f"blocked{self.attempts}@example.com")
        return self.client.post("/api/youtube/process", json={"url": URL}, headers=bearer(token))

    def test_a_block_gets_a_plain_message(self):
        for error in (
            "ERROR: [youtube] abc: Failed to extract any player response; please report this issue on ...",
            "ERROR: [youtube] abc: Sign in to confirm you’re not a bot",
            "HTTP Error 429: Too Many Requests",
        ):
            with self.subTest(error=error[:40]):
                r = self.import_with(error)
                self.assertEqual(r.status_code, 503, r.text)
                self.assertEqual(r.json()["detail"], youtube_router.YOUTUBE_BLOCKED_MESSAGE)
                self.assertNotIn("yt-dlp", r.json()["detail"])

    def test_other_failures_keep_their_message(self):
        r = self.import_with("Video unavailable")
        self.assertEqual(r.status_code, 500)
        self.assertIn("Video unavailable", r.json()["detail"])


if __name__ == "__main__":
    unittest.main()
