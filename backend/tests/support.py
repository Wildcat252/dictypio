"""Shared setup for the backend tests. Run from backend/: python -m unittest discover tests

Importing this module points the app at a throwaway database with accounts
enabled, so every test module imports it before any app module.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

_tmp = tempfile.TemporaryDirectory(ignore_cleanup_errors=True)
TMP_DIR = Path(_tmp.name)

# The app reads its environment at import time.
# TEST_DATABASE_URL runs the suite against Postgres instead. The tests drop
# every table, so point it only at an empty, throwaway database.
os.environ["DATABASE_URL"] = os.environ.get("TEST_DATABASE_URL") or (
    "sqlite:///" + (TMP_DIR / "test.db").as_posix()
)
os.environ["AUTH_ENABLED"] = "1"
os.environ["SECRET_KEY"] = "test-secret-not-used-anywhere-else"
os.environ.pop("SMTP_HOST", None)
# Test users reuse the ids of real ones, so nothing here may reach a real
# vector store: point the client at a port nothing listens on.
os.environ.pop("QDRANT_LOCAL_PATH", None)
os.environ["QDRANT_URL"] = "http://127.0.0.1:9"
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi.testclient import TestClient  # noqa: E402

import database  # noqa: E402
from main import app  # noqa: E402
from routers import account as account_router  # noqa: E402
from routers import auth as auth_router  # noqa: E402

PASSWORD = "correct horse"


def bearer(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def dispose_engine():
    """Use as tearDownModule: releases the SQLite file so Windows can delete the temp directory."""
    database.engine.dispose()


class AppTestCase(unittest.TestCase):
    """A fresh database per test, with outgoing mail and vector deletion captured."""

    def setUp(self):
        database.Base.metadata.drop_all(bind=database.engine)
        database.init_db()  # also creates the default user, as on a real start
        auth_router._attempts.clear()
        self.client = TestClient(app)

        self.resets = []  # (to_email, reset_url, minutes)
        self.confirmations = []  # (to_email, confirm_url, minutes)
        self.notices = []  # (old_email, new_email)
        self.purged_user_ids = []
        self._replace(auth_router, "send_password_reset", lambda *a: self.resets.append(a))
        self._replace(auth_router, "send_email_changed_notice", lambda *a: self.notices.append(a))
        self._replace(account_router, "send_email_change_confirmation", lambda *a: self.confirmations.append(a))
        self._replace(account_router, "delete_vectors_for_user", self.purged_user_ids.append)

    def _replace(self, module, name, replacement):
        patcher = mock.patch.object(module, name, replacement)
        patcher.start()
        self.addCleanup(patcher.stop)

    def register(self, email="a@example.com", password=PASSWORD):
        return self.client.post("/api/auth/register", json={"email": email, "password": password})

    def login(self, email="a@example.com", password=PASSWORD):
        return self.client.post("/api/auth/login", json={"email": email, "password": password})

    def signup(self, email="a@example.com") -> str:
        """Register and return the session token."""
        r = self.register(email=email)
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["access_token"]

    def me(self, token: str):
        return self.client.get("/api/auth/me", headers=bearer(token))
