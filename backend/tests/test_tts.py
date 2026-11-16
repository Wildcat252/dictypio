"""Google Text-to-Speech endpoint: auth, validation and free-tier limits."""
from datetime import datetime, timezone

from support import AppTestCase, bearer, dispose_engine

from routers import tts as tts_router
from services import tts as tts_service

tearDownModule = dispose_engine

VOICES = [
    {"name": "en-US-Chirp3-HD-Aoede", "label": "Aoede", "lang": "en-US", "tier": "chirp3hd"},
    {"name": "en-US-Neural2-F", "label": "Neural2 F (female)", "lang": "en-US", "tier": "neural2"},
]


class TtsTests(AppTestCase):
    def setUp(self):
        super().setUp()
        self.calls = []

        async def fake_voices():
            return VOICES

        async def fake_synthesize(text, voice):
            self.calls.append((text, voice))
            return b"ID3fake-mp3"

        self.now = datetime(2026, 11, 15, 10, 0, tzinfo=timezone.utc)
        self._replace(tts_service, "ENABLED", True)
        self._replace(tts_service, "MONTHLY_LIMITS", {"chirp3hd": 100, "neural2": 100})
        self._replace(tts_service, "DAILY_CHARS_PER_USER", 0)
        self._replace(tts_service, "list_voices", fake_voices)
        self._replace(tts_service, "synthesize", fake_synthesize)
        self._replace(tts_service, "_now", lambda: self.now)
        self.token = self.signup()

    def speak(self, text="Hello world", voice="en-US-Chirp3-HD-Aoede", token=None):
        return self.client.post(
            "/api/tts", json={"text": text, "voice": voice}, headers=bearer(token or self.token)
        )

    def usage(self):
        r = self.client.get("/api/tts/status", headers=bearer(self.token))
        self.assertEqual(r.status_code, 200, r.text)
        return r.json()["usage"]

    def test_returns_mp3_and_counts_characters(self):
        r = self.speak("Hello world")
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.headers["content-type"], "audio/mpeg")
        self.assertEqual(r.content, b"ID3fake-mp3")
        self.assertEqual(self.calls, [("Hello world", "en-US-Chirp3-HD-Aoede")])
        self.assertEqual(self.usage()["chirp3hd"], {"used": 11, "limit": 100})
        self.assertEqual(self.usage()["neural2"]["used"], 0)

        self.speak("Hi")
        self.assertEqual(self.usage()["chirp3hd"]["used"], 13)

    def test_requires_login(self):
        r = self.client.post("/api/tts", json={"text": "Hi", "voice": "en-US-Chirp3-HD-Aoede"})
        self.assertEqual(r.status_code, 401)
        self.assertEqual(self.calls, [])

    def test_rejects_unknown_voice_and_bad_text(self):
        self.assertEqual(self.speak(voice="en-US-Standard-A").status_code, 400)
        self.assertEqual(self.speak(text="   ").status_code, 400)
        self.assertEqual(self.speak(text="x" * (tts_router.MAX_TEXT_CHARS + 1)).status_code, 400)
        self.assertEqual(self.calls, [])

    def test_disabled(self):
        tts_service.ENABLED = False
        self.assertEqual(self.speak().status_code, 503)
        r = self.client.get("/api/tts/status", headers=bearer(self.token))
        self.assertEqual(r.json(), {"enabled": False})
        self.assertEqual(self.client.get("/api/tts/voices", headers=bearer(self.token)).json(), [])

    def test_monthly_limit_blocks_before_calling_google(self):
        self.assertEqual(self.speak("x" * 90).status_code, 200)
        r = self.speak("y" * 20)
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["detail"], {"reason": "quota", "tier": "chirp3hd", "period": "month"})
        self.assertEqual(len(self.calls), 1)
        self.assertEqual(self.usage()["chirp3hd"]["used"], 90)
        # The other family has its own allowance.
        self.assertEqual(self.speak("y" * 20, voice="en-US-Neural2-F").status_code, 200)

    def test_new_month_resets(self):
        self.speak("x" * 95)
        self.assertEqual(self.speak("y" * 10).status_code, 429)
        self.now = datetime(2026, 12, 1, 0, 5, tzinfo=timezone.utc)
        self.assertEqual(self.speak("y" * 10).status_code, 200)
        self.assertEqual(self.usage()["chirp3hd"]["used"], 10)

    def test_daily_limit_is_per_user(self):
        tts_service.DAILY_CHARS_PER_USER = 30
        self.assertEqual(self.speak("x" * 25).status_code, 200)
        r = self.speak("y" * 10)
        self.assertEqual(r.status_code, 429)
        self.assertEqual(r.json()["detail"]["period"], "day")

        other = self.signup(email="b@example.com")
        self.assertEqual(self.speak("y" * 10, token=other).status_code, 200)

        self.now = datetime(2026, 11, 16, 0, 5, tzinfo=timezone.utc)
        self.assertEqual(self.speak("y" * 10).status_code, 200)

    def test_google_failure_is_502_and_not_counted(self):
        async def broken(text, voice):
            raise tts_service.TtsError("HTTP 403: API disabled")

        self._replace(tts_service, "synthesize", broken)
        r = self.speak()
        self.assertEqual(r.status_code, 502)
        self.assertIn("API disabled", r.json()["detail"])
        self.assertEqual(self.usage()["chirp3hd"]["used"], 0)


class VoiceLabelTests(AppTestCase):
    def test_tier_and_label(self):
        self.assertEqual(tts_service.tier_of("en-US-Chirp3-HD-Aoede"), "chirp3hd")
        self.assertEqual(tts_service.tier_of("en-GB-Neural2-B"), "neural2")
        self.assertIsNone(tts_service.tier_of("en-US-Standard-A"))
        self.assertEqual(tts_service._label("en-US-Chirp3-HD-Aoede", "FEMALE"), "Aoede")
        self.assertEqual(tts_service._label("en-GB-Neural2-B", "MALE"), "Neural2 B (male)")
