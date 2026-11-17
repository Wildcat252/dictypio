"""Progress, stats and the practice word list. Run from backend/: python -m unittest discover tests"""
from support import AppTestCase, bearer, dispose_engine  # sets up the environment first

from database import SessionLocal, Sentence, Video
from routers import learning_progress as progress_router

tearDownModule = dispose_engine

SENTENCES = ["The quick brown fox.", "Jumps over the lazy dog.", "And runs away."]


class LearningProgressTest(AppTestCase):
    def setUp(self):
        super().setUp()
        # No vector store in these tests.
        self.ingested = []
        self._replace(
            progress_router,
            "ingest_learning_progress_event",
            lambda learning_progress_id: self.ingested.append(learning_progress_id),
        )
        self.token = self.signup()
        self.user_id = self.me(self.token).json()["id"]
        self.video_id, self.sentence_ids = self.make_video(self.user_id)

    def make_video(self, user_id, url="https://www.youtube.com/watch?v=abc123XYZ_0"):
        db = SessionLocal()
        try:
            video = Video(user_id=user_id, youtube_url=url, title="Lesson", duration=6)
            db.add(video)
            db.flush()
            ids = []
            for i, text in enumerate(SENTENCES):
                s = Sentence(video_id=video.id, sentence_text=text, start_time=i * 2.0,
                             end_time=i * 2.0 + 2, sentence_index=i)
                db.add(s)
                db.flush()
                ids.append(s.id)
            db.commit()
            return video.id, ids
        finally:
            db.close()

    def save(self, sentence_index, data, token=None):
        return self.client.post(
            "/api/user/progress",
            json={
                "video_id": self.video_id,
                "sentence_id": self.sentence_ids[sentence_index],
                "data": data,
            },
            headers=bearer(token or self.token),
        )

    def stats(self, token=None):
        r = self.client.get("/api/user/stats", headers=bearer(token or self.token))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()

    def words(self):
        return self.client.get("/api/user/practice/words", headers=bearer(self.token)).json()

    def seed(self):
        """Three sentences: one clean, one with a twice-hinted word, one with a single hint."""
        r1 = self.save(0, {
            "attempts": 1, "total_words": 4,
            "correct_words": ["The", "quick", "brown", "fox"],
            "words": ["The", "quick", "brown", "fox"], "error_chars": [0, 0, 0, 0],
        })
        r2 = self.save(1, {
            "attempts": 2, "total_words": 5,
            "correct_words": ["Jumps", "over", "the", "dog"],
            "incorrect_words": ["lazy"],
            "hint_words": ["lazy"], "repeat_hint_words": ["lazy"],
            "words": ["Jumps", "over", "the", "lazy", "dog"], "error_chars": [0, 1, 0, 3, 0],
        })
        r3 = self.save(2, {
            "attempts": 1, "total_words": 3,
            "correct_words": ["And", "runs"], "incorrect_words": ["away"],
            "hint_words": ["away"],
            "words": ["And", "runs", "away"], "error_chars": [0, 0, 2],
        })
        for r in (r1, r2, r3):
            self.assertEqual(r.status_code, 200, r.text)


class ProgressEndpointTest(LearningProgressTest):
    def test_saving_twice_updates_the_same_row(self):
        self.save(0, {"attempts": 1})
        self.save(0, {"attempts": 4})
        rows = self.client.get("/api/user/progress", headers=bearer(self.token)).json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["data"], {"attempts": 4})
        self.assertEqual(len(self.ingested), 2)

    def test_progress_can_be_filtered_by_video(self):
        self.save(0, {"attempts": 1})
        mine = self.client.get(f"/api/user/progress?video_id={self.video_id}", headers=bearer(self.token)).json()
        other = self.client.get("/api/user/progress?video_id=999999", headers=bearer(self.token)).json()
        self.assertEqual(len(mine), 1)
        self.assertEqual(other, [])

    def test_unknown_video_or_sentence_is_rejected(self):
        r = self.client.post("/api/user/progress", json={"video_id": 999999, "data": {}}, headers=bearer(self.token))
        self.assertEqual(r.status_code, 404)
        r = self.client.post(
            "/api/user/progress",
            json={"video_id": self.video_id, "sentence_id": 999999, "data": {}},
            headers=bearer(self.token),
        )
        self.assertEqual(r.status_code, 404)

    def test_video_of_another_user_is_rejected(self):
        other = self.signup(email="b@example.com")
        r = self.save(0, {"attempts": 1}, token=other)
        self.assertEqual(r.status_code, 404)


class StatsTest(LearningProgressTest):
    def test_empty_history(self):
        s = self.stats()
        self.assertEqual(s["total_sentences_practiced"], 0)
        self.assertEqual(s["top_incorrect_words"], [])
        self.assertEqual(s["daily"], [])
        self.assertIsNone(s["sentence_error_rate"])

    def test_totals(self):
        self.seed()
        s = self.stats()
        self.assertEqual(s["total_videos_practiced"], 1)
        self.assertEqual(s["total_sentences_practiced"], 3)
        self.assertEqual(s["total_attempts"], 4)
        self.assertEqual(s["total_words_seen"], 12)
        self.assertEqual(s["unique_words_seen"], 12)
        self.assertEqual(s["total_incorrect_words"], 2)
        self.assertEqual(s["total_hints_used"], 2)

    def test_distributions(self):
        self.seed()
        s = self.stats()
        # Error rates per sentence: 0, 1/5, 1/3.
        self.assertAlmostEqual(s["sentence_error_rate"]["p50"], 0.2)
        self.assertAlmostEqual(s["sentence_error_rate"]["mean"], (0 + 0.2 + 1 / 3) / 3)
        self.assertAlmostEqual(s["sentence_length_words"]["mean"], 4.0)
        self.assertAlmostEqual(s["sentence_length_words"]["p25"], 3.5)
        self.assertAlmostEqual(s["sentence_length_words"]["p75"], 4.5)
        # Hints per sentence: 0, 1, 1.
        self.assertAlmostEqual(s["sentence_hint_usage"]["p50"], 1.0)

    def test_only_a_twice_hinted_word_is_tricky(self):
        self.seed()
        s = self.stats()
        tricky = [w["word"] for w in s["top_incorrect_words"]]
        self.assertEqual(tricky, ["lazy"])  # "away" was hinted once only
        lazy = s["top_incorrect_words"][0]
        self.assertEqual(lazy["repeat_hint_count"], 1)
        self.assertEqual(lazy["hint_count"], 1)
        self.assertEqual(lazy["incorrect_count"], 1)
        self.assertEqual(lazy["error_char_count"], 3)
        self.assertAlmostEqual(lazy["latest_spell_retry_times"], 4.0)
        self.assertAlmostEqual(lazy["average_spell_retry_times"], 4.0)

    def test_hint_words_list_every_hinted_word(self):
        self.seed()
        self.assertEqual({w["word"] for w in self.stats()["top_hint_words"]}, {"lazy", "away"})

    def test_daily_breakdown_matches_the_totals(self):
        self.seed()
        s = self.stats()
        self.assertEqual(len(s["daily"]), 1)
        day = s["daily"][0]
        for key in ("total_sentences_practiced", "total_attempts", "total_words_seen",
                    "unique_words_seen", "total_incorrect_words", "total_hints_used"):
            self.assertEqual(day[key], s[key], key)

    def test_stats_are_per_user(self):
        self.seed()
        other = self.signup(email="b@example.com")
        self.assertEqual(self.stats(token=other)["total_sentences_practiced"], 0)

    def test_malformed_fields_are_ignored(self):
        r = self.save(0, {"attempts": None, "incorrect_words": "fox", "hint_words": {"a": 1},
                          "words": ["fox"], "error_chars": ["x"]})
        self.assertEqual(r.status_code, 200, r.text)
        s = self.stats()
        self.assertEqual(s["total_attempts"], 0)
        self.assertEqual(s["total_incorrect_words"], 1)
        self.assertEqual(s["total_hints_used"], 0)


class PracticeWordsTest(LearningProgressTest):
    def test_tricky_sentence_is_the_one_hinted_twice(self):
        self.seed()
        rows = self.client.get("/api/user/tricky-sentences", headers=bearer(self.token)).json()
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]["word"], "lazy")
        self.assertEqual(rows[0]["sentence"], SENTENCES[1])
        self.assertEqual(rows[0]["sentence_id"], self.sentence_ids[1])

    def test_bin_and_recover(self):
        self.seed()
        self.client.post("/api/user/practice/words/bin", json={"word": "lazy"}, headers=bearer(self.token))
        self.assertEqual(self.words()["binned"], ["lazy"])
        self.client.post("/api/user/practice/words/recover", json={"word": "lazy"}, headers=bearer(self.token))
        self.assertEqual(self.words(), {"binned": [], "deleted": [], "custom": []})

    def test_custom_word_survives_bin_and_recover(self):
        r = self.client.post("/api/user/practice/words/add", json={"words": [" rhythm ", ""]},
                             headers=bearer(self.token))
        self.assertEqual(r.json()["custom"], ["rhythm"])
        self.client.post("/api/user/practice/words/bin", json={"word": "rhythm"}, headers=bearer(self.token))
        self.assertEqual(self.words()["binned"], ["rhythm"])
        self.client.post("/api/user/practice/words/recover", json={"word": "rhythm"}, headers=bearer(self.token))
        self.assertEqual(self.words(), {"binned": [], "deleted": [], "custom": ["rhythm"]})

    def test_delete_clears_the_history_of_the_word(self):
        self.seed()
        r = self.client.delete("/api/user/practice/words/away", headers=bearer(self.token))
        self.assertEqual(r.json()["rows_updated"], 1)
        self.assertEqual(self.words()["deleted"], ["away"])
        s = self.stats()
        self.assertEqual(s["total_hints_used"], 1)
        self.assertEqual([w["word"] for w in s["top_hint_words"]], ["lazy"])

    def test_deleted_word_has_no_tricky_sentence(self):
        self.seed()
        self.client.delete("/api/user/practice/words/lazy", headers=bearer(self.token))
        rows = self.client.get("/api/user/tricky-sentences", headers=bearer(self.token)).json()
        self.assertEqual(rows, [])
