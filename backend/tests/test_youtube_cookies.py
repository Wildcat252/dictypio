"""yt-dlp cookie settings. Run from backend/: python -m unittest discover tests"""
import os
import unittest
from unittest import mock

from support import TMP_DIR, dispose_engine  # sets up the environment first

from services import youtube_processor as yp

tearDownModule = dispose_engine

COOKIES = "# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t0\tSID\tvalue\n"


class CookieSettingsTest(unittest.TestCase):
    def setUp(self):
        yp._cookie_copy = None
        self.addCleanup(setattr, yp, "_cookie_copy", None)

    def use_sources(self, *paths):
        patcher = mock.patch.object(yp, "_COOKIE_SOURCES", paths)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_without_cookies_only_the_runtime_is_set(self):
        self.use_sources("", str(TMP_DIR / "missing.txt"))
        self.assertEqual(yp.yt_dlp_common_options(), {"js_runtimes": yp.YT_DLP_JS_RUNTIMES})
        self.assertNotIn("--cookies", yp.yt_dlp_common_args())

    def test_cookies_are_used_from_a_private_copy(self):
        source = TMP_DIR / "cookies.txt"
        source.write_text(COOKIES)
        self.use_sources(str(source))

        options = yp.yt_dlp_common_options()
        copy = options["cookiefile"]
        self.assertNotEqual(copy, str(source))
        self.assertEqual(open(copy).read(), COOKIES)
        args = yp.yt_dlp_common_args()
        self.assertEqual(args[args.index("--cookies") + 1], copy)

        # The same copy is reused rather than a new temp file per call.
        self.assertEqual(yp.yt_dlp_common_options()["cookiefile"], copy)
        os.remove(copy)

    def test_first_existing_source_wins(self):
        first, second = TMP_DIR / "first.txt", TMP_DIR / "second.txt"
        second.write_text(COOKIES)
        self.use_sources(str(first), str(second))
        self.assertEqual(open(yp.yt_dlp_common_options()["cookiefile"]).read(), COOKIES)


if __name__ == "__main__":
    unittest.main()
