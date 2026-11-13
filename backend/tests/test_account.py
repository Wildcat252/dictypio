"""Account settings: display name, password, email, deletion. Run from backend/: python -m unittest discover tests"""
import unittest

from support import PASSWORD, TMP_DIR, AppTestCase, bearer, dispose_engine  # sets up the environment first

import database
from database import (
    LearningProgress,
    LessonSession,
    Playlist,
    PlaylistVideo,
    PracticeWordState,
    Sentence,
    SessionLocal,
    User,
    UserConfig,
    Video,
)

tearDownModule = dispose_engine

NEW_PASSWORD = "a brand new one"


class ProfileTest(AppTestCase):
    def set_name(self, token, name):
        return self.client.patch("/api/account", json={"display_name": name}, headers=bearer(token))

    def test_new_account_has_no_display_name(self):
        self.assertIsNone(self.me(self.signup()).json()["display_name"])

    def test_set_and_clear_display_name(self):
        token = self.signup()
        r = self.set_name(token, "  Hoang \n  Tran ")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["display_name"], "Hoang Tran")
        self.assertEqual(self.me(token).json()["display_name"], "Hoang Tran")

        self.assertIsNone(self.set_name(token, "   ").json()["display_name"])
        self.assertIsNone(self.me(token).json()["display_name"])

    def test_display_name_length_limit(self):
        token = self.signup()
        self.assertEqual(self.set_name(token, "x" * 50).status_code, 200)
        self.assertEqual(self.set_name(token, "x" * 51).status_code, 422)
        self.assertEqual(self.me(token).json()["display_name"], "x" * 50)

    def test_two_accounts_may_share_a_name(self):
        a, b = self.signup(), self.signup("b@example.com")
        self.assertEqual(self.set_name(a, "Sam").status_code, 200)
        self.assertEqual(self.set_name(b, "Sam").status_code, 200)

    def test_needs_a_session(self):
        self.assertEqual(self.client.patch("/api/account", json={"display_name": "x"}).status_code, 401)


class ChangePasswordTest(AppTestCase):
    def change(self, token, current=PASSWORD, new=NEW_PASSWORD):
        return self.client.post(
            "/api/account/password",
            json={"current_password": current, "new_password": new},
            headers=bearer(token),
        )

    def test_wrong_current_password_changes_nothing(self):
        token = self.signup()
        r = self.change(token, current="not my password")
        # 400, not 401: the frontend signs the user out on a 401.
        self.assertEqual(r.status_code, 400)
        self.assertEqual(self.login().status_code, 200)
        self.assertEqual(self.me(token).status_code, 200)

    def test_rejects_weak_or_unchanged_password(self):
        token = self.signup()
        self.assertEqual(self.change(token, new="short").status_code, 422)
        self.assertEqual(self.change(token, new=PASSWORD).status_code, 400)
        self.assertEqual(self.login().status_code, 200)

    def test_change_password(self):
        old_token = self.signup()
        r = self.change(old_token)
        self.assertEqual(r.status_code, 200, r.text)

        # This session carries on with the new token; older ones are signed out.
        new_token = r.json()["access_token"]
        self.assertEqual(self.me(new_token).json()["email"], "a@example.com")
        self.assertEqual(self.me(old_token).status_code, 401)
        self.assertEqual(self.login().status_code, 401)
        self.assertEqual(self.login(password=NEW_PASSWORD).status_code, 200)

    def test_password_guessing_is_rate_limited(self):
        token = self.signup()
        codes = [self.change(token, current="guess").status_code for _ in range(11)]
        self.assertEqual(codes[:10], [400] * 10)
        self.assertEqual(codes[10], 429)


class ChangeEmailTest(AppTestCase):
    def request_change(self, token, new_email="new@example.com", password=PASSWORD):
        return self.client.post(
            "/api/account/email",
            json={"new_email": new_email, "current_password": password},
            headers=bearer(token),
        )

    def link_token(self, token, new_email="new@example.com"):
        """Ask for the change and return the token from the emailed link."""
        r = self.request_change(token, new_email)
        self.assertEqual(r.status_code, 200, r.text)
        to_email, url, _minutes = self.confirmations[-1]
        self.assertEqual(to_email, new_email.strip().lower())
        return url.split("/confirm-email#token=")[1]

    def confirm(self, link_token):
        return self.client.post("/api/auth/confirm-email-change", json={"token": link_token})

    def test_request_needs_the_current_password(self):
        token = self.signup()
        self.assertEqual(self.request_change(token, password="not my password").status_code, 400)
        self.assertEqual(self.confirmations, [])

    def test_request_rejects_unusable_addresses(self):
        token = self.signup()
        self.signup("b@example.com")
        self.assertEqual(self.request_change(token, "not-an-email").status_code, 422)
        self.assertEqual(self.request_change(token, "A@example.com").status_code, 400)  # already mine
        self.assertEqual(self.request_change(token, "b@example.com").status_code, 400)  # someone else's
        self.assertEqual(self.confirmations, [])

    def test_email_stays_until_the_link_is_confirmed(self):
        token = self.signup()
        self.link_token(token, "  New@Example.com ")
        self.assertEqual(self.confirmations[-1][0], "new@example.com")
        self.assertEqual(self.me(token).json()["email"], "a@example.com")
        self.assertEqual(self.login(email="new@example.com").status_code, 401)
        self.assertEqual(self.login().status_code, 200)

    def test_confirming_switches_the_email(self):
        token = self.signup()
        r = self.confirm(self.link_token(token))
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json()["email"], "new@example.com")

        # Same session, new address; the old address hears about it.
        self.assertEqual(self.me(token).json()["email"], "new@example.com")
        self.assertEqual(self.login(email="new@example.com").status_code, 200)
        self.assertEqual(self.login().status_code, 401)
        self.assertEqual(self.notices, [("a@example.com", "new@example.com")])

    def test_link_works_once(self):
        token = self.signup()
        link = self.link_token(token)
        self.assertEqual(self.confirm(link).status_code, 200)
        self.assertEqual(self.confirm(link).status_code, 400)
        self.assertEqual(len(self.notices), 1)

    def test_an_older_link_dies_when_a_newer_one_is_used(self):
        token = self.signup()
        first = self.link_token(token, "first@example.com")
        second = self.link_token(token, "second@example.com")
        self.assertEqual(self.confirm(second).status_code, 200)
        self.assertEqual(self.confirm(first).status_code, 400)
        self.assertEqual(self.me(token).json()["email"], "second@example.com")

    def test_link_dies_with_a_password_change(self):
        token = self.signup()
        link = self.link_token(token)
        r = self.client.post(
            "/api/account/password",
            json={"current_password": PASSWORD, "new_password": NEW_PASSWORD},
            headers=bearer(token),
        )
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(self.confirm(link).status_code, 400)

    def test_address_taken_before_confirming(self):
        token = self.signup()
        link = self.link_token(token)
        self.signup("new@example.com")
        self.assertEqual(self.confirm(link).status_code, 400)
        self.assertEqual(self.me(token).json()["email"], "a@example.com")

    def test_only_an_email_change_token_confirms(self):
        session_token = self.signup()
        self.client.post("/api/auth/forgot-password", json={"email": "a@example.com"})
        reset_token = self.resets[-1][1].split("#token=")[1]
        for token in ("garbage", session_token, reset_token):
            with self.subTest(token=token[:12]):
                self.assertEqual(self.confirm(token).status_code, 400)
        self.assertEqual(self.me(session_token).json()["email"], "a@example.com")

    def test_link_token_is_not_a_session(self):
        token = self.signup()
        self.assertEqual(self.me(self.link_token(token)).status_code, 401)

    def test_old_address_can_be_registered_again(self):
        # Both the account that took over the default user and a later one.
        for email in ("a@example.com", "b@example.com"):
            with self.subTest(email=email):
                token = self.signup(email)
                moved = "moved-" + email
                self.assertEqual(self.confirm(self.link_token(token, moved)).status_code, 200)
                self.assertEqual(self.register(email=email).status_code, 200)
                self.assertEqual(self.me(token).json()["email"], moved)

    def test_confirmation_mail_is_rate_limited(self):
        token = self.signup()
        codes = [self.request_change(token, f"n{i}@example.com").status_code for i in range(6)]
        self.assertEqual(codes, [200] * 5 + [429])
        self.assertEqual(len(self.confirmations), 5)


def seed_lesson_data(user_id: int, tag: str):
    """One row in every per-user table, plus an audio file on disk. Returns the file's path."""
    audio = TMP_DIR / f"{tag}.mp3"
    audio.write_bytes(b"not really audio")
    with SessionLocal() as db:
        playlist = Playlist(user_id=user_id, name=f"{tag} playlist")
        video = Video(
            user_id=user_id,
            youtube_url=f"https://youtu.be/{tag}",
            title=tag,
            audio_file_path=str(audio),
        )
        db.add_all([playlist, video])
        db.flush()
        sentence = Sentence(
            video_id=video.id, sentence_text="Hello there.", start_time=0.0, end_time=1.0, sentence_index=0
        )
        db.add(sentence)
        db.flush()
        db.add_all(
            [
                PlaylistVideo(playlist_id=playlist.id, video_id=video.id),
                LearningProgress(user_id=user_id, video_id=video.id, sentence_id=sentence.id, data="{}"),
                LessonSession(user_id=user_id, video_id=video.id),
                PracticeWordState(user_id=user_id, word="hello"),
                UserConfig(user_id=user_id, key="ai_provider", value="gemini"),
            ]
        )
        db.commit()
    return audio


ALL_TABLES = (
    User,
    Playlist,
    Video,
    Sentence,
    PlaylistVideo,
    LearningProgress,
    LessonSession,
    PracticeWordState,
    UserConfig,
)


def table_counts() -> dict:
    with SessionLocal() as db:
        return {model.__tablename__: db.query(model).count() for model in ALL_TABLES}


class DeleteAccountTest(AppTestCase):
    def delete(self, token, password=PASSWORD):
        return self.client.post("/api/account/delete", json={"password": password}, headers=bearer(token))

    def test_wrong_password_deletes_nothing(self):
        token = self.signup()
        audio = seed_lesson_data(self.me(token).json()["id"], "mine")
        before = table_counts()

        self.assertEqual(self.delete(token, password="not my password").status_code, 400)
        self.assertEqual(table_counts(), before)
        self.assertTrue(audio.exists())
        self.assertEqual(self.purged_user_ids, [])
        self.assertEqual(self.me(token).status_code, 200)

    def test_delete_removes_everything_of_that_account_only(self):
        mine, theirs = self.signup(), self.signup("b@example.com")
        my_id, their_id = self.me(mine).json()["id"], self.me(theirs).json()["id"]
        my_audio = seed_lesson_data(my_id, "mine")
        their_audio = seed_lesson_data(their_id, "theirs")
        self.assertEqual(table_counts(), {model.__tablename__: 2 for model in ALL_TABLES})

        r = self.delete(mine)
        self.assertEqual(r.status_code, 200, r.text)

        # One row left per table, and it is the other account's.
        self.assertEqual(table_counts(), {model.__tablename__: 1 for model in ALL_TABLES})
        with SessionLocal() as db:
            self.assertEqual(db.query(User).one().id, their_id)
            for model in (Playlist, Video, LearningProgress, LessonSession, PracticeWordState, UserConfig):
                self.assertEqual(db.query(model).one().user_id, their_id, model.__tablename__)
            video_id = db.query(Video).one().id
            self.assertEqual(db.query(Sentence).one().video_id, video_id)
            self.assertEqual(db.query(PlaylistVideo).one().video_id, video_id)

        self.assertFalse(my_audio.exists())
        self.assertTrue(their_audio.exists())
        self.assertEqual(self.purged_user_ids, [my_id])

        self.assertEqual(self.me(mine).status_code, 401)
        self.assertEqual(self.login().status_code, 401)
        self.assertEqual(self.me(theirs).status_code, 200)

    def test_missing_audio_file_does_not_block_deletion(self):
        token = self.signup()
        audio = seed_lesson_data(self.me(token).json()["id"], "gone")
        audio.unlink()
        self.assertEqual(self.delete(token).status_code, 200)
        self.assertEqual(table_counts()["users"], 0)

    def test_deleted_email_can_sign_up_again_with_a_clean_slate(self):
        token = self.signup()
        seed_lesson_data(self.me(token).json()["id"], "old")
        self.assertEqual(self.delete(token).status_code, 200)

        fresh = self.signup()
        self.assertEqual(table_counts()["videos"], 0)
        self.assertEqual(self.client.get("/api/youtube/videos", headers=bearer(fresh)).json(), [])

    def test_default_user_recreated_after_deletion_is_not_handed_out(self):
        first, second = self.signup(), self.signup("b@example.com")
        self.assertTrue(self.me(first).json()["is_superuser"])
        self.assertEqual(self.delete(first).status_code, 200)

        # A restart puts the local default user back, with superuser rights.
        database.init_db()
        with SessionLocal() as db:
            default_id = db.query(User).filter(User.username == "default").one().id

        third = self.register(email="c@example.com").json()["user"]
        self.assertNotEqual(third["id"], default_id)
        self.assertFalse(third["is_superuser"])
        self.assertEqual(self.me(second).status_code, 200)


if __name__ == "__main__":
    unittest.main()
