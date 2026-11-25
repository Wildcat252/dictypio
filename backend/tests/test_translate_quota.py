"""Translation quota errors and the no-Qdrant embedding skip. Run from backend/: python -m unittest discover tests"""
from support import AppTestCase, bearer, dispose_engine  # sets up the environment first

from unittest import mock

from routers import ai_coach as coach_router
from services import qdrant_client as store

tearDownModule = dispose_engine

GEMINI_429 = (
    "Error calling model 'gemini-3-flash-preview' (RESOURCE_EXHAUSTED): 429 RESOURCE_EXHAUSTED. "
    "{'error': {'code': 429, 'message': 'You exceeded your current quota'}}"
)


class TranslateQuotaTest(AppTestCase):
    def setUp(self):
        super().setUp()
        self.token = self.signup()
        # No Google Cloud Translation key: translation goes through Gemini.
        self._replace(coach_router, "GOOGLE_TRANSLATE_API_KEY", None)

    def translate(self):
        return self.client.post(
            "/api/ai/translate",
            json={"text": "Hello there.", "target_lang": "vi"},
            headers=bearer(self.token),
        )

    def test_gemini_quota_error_is_a_plain_429(self):
        async def boom(*args):
            raise RuntimeError(GEMINI_429)

        self._replace(coach_router, "_translate_via_gemini", boom)
        r = self.translate()
        self.assertEqual(r.status_code, 429, r.text)
        detail = r.json()["detail"]
        self.assertIn("Gemini", detail)
        self.assertNotIn("RESOURCE_EXHAUSTED", detail)

    def test_google_cloud_quota_error_is_a_plain_429(self):
        async def boom(*args):
            raise RuntimeError("HTTP 429: Quota exceeded")

        self._replace(coach_router, "GOOGLE_TRANSLATE_API_KEY", "test-key")
        self._replace(coach_router, "_translate_via_google_cloud", boom)
        r = self.translate()
        self.assertEqual(r.status_code, 429, r.text)
        self.assertIn("Google Cloud Translation", r.json()["detail"])

    def test_other_failures_stay_502(self):
        async def boom(*args):
            raise RuntimeError("HTTP 500: backend error")

        self._replace(coach_router, "GOOGLE_TRANSLATE_API_KEY", "test-key")
        self._replace(coach_router, "_translate_via_google_cloud", boom)
        r = self.translate()
        self.assertEqual(r.status_code, 502, r.text)


class EmbeddingSkipTest(AppTestCase):
    def test_no_qdrant_means_no_embedding_call(self):
        factory = mock.Mock()
        self._replace(store, "make_embeddings_for_user", factory)
        self._replace(store, "QDRANT_CONFIGURED", False)
        self.assertEqual(store._embed_texts(None, user_id=1, texts=["a sentence"]), [])
        factory.assert_not_called()

    def test_configured_qdrant_still_embeds(self):
        embeddings = mock.Mock()
        embeddings.embed_documents.return_value = [[0.1, 0.2]]
        self._replace(store, "make_embeddings_for_user", lambda user_id, db: embeddings)
        self._replace(store, "QDRANT_CONFIGURED", True)
        self.assertEqual(store._embed_texts(None, user_id=1, texts=["a sentence"]), [[0.1, 0.2]])
