"""Sign up, sign in and password reset. Run from backend/: python -m unittest discover tests"""
import unittest
from unittest import mock

from support import PASSWORD, AppTestCase, bearer, dispose_engine  # sets up the environment first

import auth
import database
from database import Playlist, SessionLocal, User
from fastapi.testclient import TestClient
from main import app

tearDownModule = dispose_engine


class AuthFlowTest(AppTestCase):
    def reset_token_for(self, email="a@example.com"):
        self.client.post("/api/auth/forgot-password", json={"email": email})
        return self.resets[-1][1].split("#token=")[1]

    def test_config_reports_enabled(self):
        self.assertEqual(self.client.get("/api/auth/config").json(), {"auth_enabled": True})

    def test_register_then_me(self):
        r = self.register(email="  A@Example.com ")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["user"]["email"], "a@example.com")
        me = self.me(r.json()["access_token"])
        self.assertEqual(me.json()["email"], "a@example.com")

    def test_register_rejects_bad_input(self):
        self.assertEqual(self.register(email="not-an-email").status_code, 422)
        self.assertEqual(self.register(password="short").status_code, 422)

    def test_duplicate_email_rejected(self):
        self.register()
        self.assertEqual(self.register(email="A@example.com").status_code, 400)

    def test_login(self):
        self.register()
        self.assertEqual(self.login().status_code, 200)
        self.assertEqual(self.login(password="wrong password").status_code, 401)
        self.assertEqual(self.login(email="nobody@example.com").status_code, 401)

    def test_default_user_password_does_not_log_in(self):
        self.assertEqual(self.login(email="default", password="default").status_code, 422)

    def test_data_routes_need_token(self):
        self.assertEqual(self.client.get("/api/playlists").status_code, 401)
        self.assertEqual(self.client.get("/api/playlists", headers=bearer("garbage")).status_code, 401)
        token = self.signup()
        self.assertEqual(self.client.get("/api/playlists", headers=bearer(token)).status_code, 200)

    def test_first_account_takes_over_default_user(self):
        with SessionLocal() as db:
            default = db.query(User).filter(User.username == "default").one()
            default_id = default.id
            db.add(Playlist(user_id=default_id, name="Before accounts"))
            db.commit()

        first = self.register().json()
        self.assertEqual(first["user"]["id"], default_id)
        self.assertTrue(first["user"]["is_superuser"])
        with SessionLocal() as db:
            owned = db.query(Playlist).filter(Playlist.user_id == first["user"]["id"]).all()
            self.assertEqual([p.name for p in owned], ["Before accounts"])

        second = self.register(email="b@example.com").json()
        self.assertNotEqual(second["user"]["id"], default_id)
        self.assertFalse(second["user"]["is_superuser"])
        with SessionLocal() as db:
            self.assertEqual(db.query(Playlist).filter(Playlist.user_id == second["user"]["id"]).count(), 0)

    def test_forgot_password_does_not_reveal_accounts(self):
        self.register()
        known = self.client.post("/api/auth/forgot-password", json={"email": "a@example.com"})
        unknown = self.client.post("/api/auth/forgot-password", json={"email": "nobody@example.com"})
        self.assertEqual(known.status_code, 200)
        self.assertEqual(known.json(), unknown.json())
        self.assertEqual(len(self.resets), 1)
        self.assertEqual(self.resets[0][0], "a@example.com")

    def test_forgot_password_mail_is_rate_limited(self):
        self.register()
        for _ in range(5):
            r = self.client.post("/api/auth/forgot-password", json={"email": "a@example.com"})
            self.assertEqual(r.status_code, 200)
        self.assertEqual(len(self.resets), 3)

    def test_reset_password(self):
        old_token = self.signup()
        reset_token = self.reset_token_for()
        new_password = "a brand new one"

        r = self.client.post(
            "/api/auth/reset-password", json={"token": reset_token, "new_password": new_password}
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.login().status_code, 401)
        self.assertEqual(self.login(password=new_password).status_code, 200)

        # The link works once, and sessions from before the reset are signed out.
        again = self.client.post(
            "/api/auth/reset-password", json={"token": reset_token, "new_password": "yet another one"}
        )
        self.assertEqual(again.status_code, 400)
        self.assertEqual(self.me(old_token).status_code, 401)

    def test_reset_rejects_wrong_tokens(self):
        login_token = self.signup()
        for token in ("garbage", login_token):
            r = self.client.post(
                "/api/auth/reset-password", json={"token": token, "new_password": "a brand new one"}
            )
            self.assertEqual(r.status_code, 400)

    def test_reset_token_is_not_a_session(self):
        self.register()
        self.assertEqual(self.me(self.reset_token_for()).status_code, 401)

    def test_login_is_rate_limited(self):
        self.register()
        codes = [self.login(password="wrong password").status_code for _ in range(11)]
        self.assertEqual(codes[:10], [401] * 10)
        self.assertEqual(codes[10], 429)


class AuthDisabledTest(unittest.TestCase):
    """The desktop configuration: no accounts, everything runs as the default user."""

    def setUp(self):
        database.Base.metadata.drop_all(bind=database.engine)
        database.init_db()
        patcher = mock.patch.object(auth, "AUTH_ENABLED", False)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.client = TestClient(app)

    def test_runs_as_default_user_without_token(self):
        self.assertEqual(self.client.get("/api/auth/config").json(), {"auth_enabled": False})
        self.assertEqual(self.client.get("/api/playlists").status_code, 200)
        self.assertIsNone(self.client.get("/api/auth/me").json()["email"])

    def test_account_endpoints_are_hidden(self):
        credentials = {"email": "a@example.com", "password": PASSWORD}
        calls = [
            ("post", "/api/auth/register", credentials),
            ("post", "/api/auth/login", credentials),
            ("post", "/api/auth/confirm-email-change", {"token": "x"}),
            ("patch", "/api/account", {"display_name": "Local"}),
            ("post", "/api/account/password", {"current_password": "default", "new_password": PASSWORD}),
            ("post", "/api/account/email", {"new_email": "a@example.com", "current_password": "default"}),
            ("post", "/api/account/delete", {"password": "default"}),
        ]
        for method, url, body in calls:
            with self.subTest(url=url):
                r = getattr(self.client, method)(url, json=body)
                self.assertEqual(r.status_code, 404, r.text)
        # In particular the local user survived the delete attempt.
        with SessionLocal() as db:
            self.assertEqual(db.query(User).filter(User.username == "default").count(), 1)


if __name__ == "__main__":
    unittest.main()
