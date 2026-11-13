"""Vector deletion against an in-memory Qdrant. Run from backend/: python -m unittest discover tests"""
import unittest
from unittest import mock

from support import dispose_engine  # sets up the environment first

from qdrant_client import QdrantClient
from qdrant_client.models import PointStruct

from services import qdrant_client as store

tearDownModule = dispose_engine

SENTENCES = store.COLLECTION_SENTENCES
EVENTS = store.COLLECTION_USER_LEARNING_EVENTS


class DeleteVectorsTest(unittest.TestCase):
    def setUp(self):
        self.qdrant = QdrantClient(":memory:")
        self.addCleanup(self.qdrant.close)
        # get_qdrant_client() hands out the shared instance when there is one.
        patcher = mock.patch.object(store, "_client", self.qdrant)
        patcher.start()
        self.addCleanup(patcher.stop)
        store.ensure_collections()
        self._next_id = 1

    def add(self, collection, count=1, **payload):
        vector = [0.1] * store.QDRANT_VECTOR_SIZE
        points = []
        for _ in range(count):
            points.append(PointStruct(id=self._next_id, vector=vector, payload=payload))
            self._next_id += 1
        self.qdrant.upsert(collection_name=collection, points=points)

    def user_ids_left(self, collection):
        records, _ = self.qdrant.scroll(collection_name=collection, limit=1000, with_payload=True)
        return sorted(r.payload["user_id"] for r in records)

    def test_delete_vectors_for_user_spares_other_users(self):
        self.add(SENTENCES, count=3, user_id=1, video_id=10)
        self.add(SENTENCES, count=2, user_id=2, video_id=20)
        self.add(EVENTS, count=2, user_id=1)
        self.add(EVENTS, count=1, user_id=2)

        store.delete_vectors_for_user(1)

        self.assertEqual(self.user_ids_left(SENTENCES), [2, 2])
        self.assertEqual(self.user_ids_left(EVENTS), [2])

    def test_delete_vectors_for_user_goes_past_one_page(self):
        # More than the 256 points one scroll returns.
        self.add(SENTENCES, count=300, user_id=1, video_id=10)
        self.add(SENTENCES, count=1, user_id=2, video_id=20)

        store.delete_vectors_for_user(1)

        self.assertEqual(self.user_ids_left(SENTENCES), [2])

    def test_delete_vectors_for_user_with_nothing_indexed(self):
        self.add(EVENTS, count=1, user_id=2)
        store.delete_vectors_for_user(1)
        self.assertEqual(self.user_ids_left(EVENTS), [2])

    def test_delete_sentence_vectors_for_video_spares_other_videos(self):
        self.add(SENTENCES, count=2, user_id=1, video_id=10)
        self.add(SENTENCES, count=1, user_id=1, video_id=11)

        store.delete_sentence_vectors_for_video(10)

        records, _ = self.qdrant.scroll(collection_name=SENTENCES, limit=10, with_payload=True)
        self.assertEqual([r.payload["video_id"] for r in records], [11])


if __name__ == "__main__":
    unittest.main()
