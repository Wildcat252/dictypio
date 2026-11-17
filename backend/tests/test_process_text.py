"""Custom text lessons: how pasted text is cut into sentences, and its limits."""
from support import AppTestCase, bearer, dispose_engine

from routers import tts as tts_router
from routers import youtube as youtube_router
from routers.youtube import split_custom_text

tearDownModule = dispose_engine


class SplitCustomTextTests(AppTestCase):
    def test_splits_at_sentence_ends_and_keeps_commas(self):
        self.assertEqual(
            split_custom_text("Hello, world. How are you? Fine! One; two: three"),
            ["Hello, world.", "How are you?", "Fine!", "One;", "two:", "three"],
        )

    def test_abbreviations_and_numbers_do_not_split(self):
        self.assertEqual(
            split_custom_text("Mr. Smith paid 3.5 dollars in the U.S. last year. He left."),
            ["Mr. Smith paid 3.5 dollars in the U.S. last year.", "He left."],
        )

    def test_line_breaks_split(self):
        self.assertEqual(
            split_custom_text("A title\n\nFirst line\r\nSecond line."),
            ["A title", "First line", "Second line."],
        )

    def test_long_text_without_punctuation_is_cut(self):
        text = " ".join(["word"] * 1000)
        sentences = split_custom_text(text)
        self.assertGreater(len(sentences), 1)
        self.assertEqual(" ".join(sentences), text)
        for s in sentences:
            self.assertLessEqual(len(s), youtube_router.MAX_CUSTOM_SENTENCE_CHARS)
            self.assertLessEqual(len(s), tts_router.MAX_TEXT_CHARS)

    def test_long_sentence_is_cut_at_a_comma(self):
        first = " ".join(["alpha"] * 40) + ","
        text = first + " " + " ".join(["beta"] * 40) + "."
        sentences = split_custom_text(text)
        self.assertEqual(sentences[0], first)
        self.assertEqual(" ".join(sentences), text)

    def test_one_huge_word_is_cut(self):
        sentences = split_custom_text("x" * 1000)
        self.assertEqual("".join(sentences), "x" * 1000)
        self.assertTrue(all(len(s) <= youtube_router.MAX_CUSTOM_SENTENCE_CHARS for s in sentences))


class ProcessTextEndpointTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.ingested = []
        self._replace(youtube_router, "ingest_sentences_for_video", lambda **kw: self.ingested.append(kw))
        self.token = self.signup()

    def post(self, title="My text", text="One. Two.", token=None):
        headers = bearer(token or self.token)
        return self.client.post("/api/youtube/process_text", json={"title": title, "text": text}, headers=headers)

    def test_creates_a_lesson(self):
        r = self.post(text="Mr. Smith left. He was late.\nBye")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["sentence_count"], 3)
        self.assertEqual(r.json()["title"], "My text")
        self.assertEqual(len(self.ingested), 1)

    def test_requires_login(self):
        r = self.client.post("/api/youtube/process_text", json={"title": "t", "text": "One."})
        self.assertEqual(r.status_code, 401)

    def test_rejects_empty_and_oversized_input(self):
        self.assertEqual(self.post(text="   ").status_code, 400)
        self.assertEqual(self.post(text="x " * youtube_router.MAX_CUSTOM_TEXT_CHARS).status_code, 400)
        self.assertEqual(self.post(title="t" * (youtube_router.MAX_CUSTOM_TITLE_CHARS + 1)).status_code, 400)
        self.assertEqual(self.ingested, [])
