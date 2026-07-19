from html.parser import HTMLParser
from pathlib import Path
import re
import unittest


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
WORKBENCH = REPOSITORY_ROOT / "prototype" / "web-workbench"


class WorkbenchHtmlParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.ids: list[str] = []
        self.scripts: list[str] = []
        self.stylesheets: list[str] = []
        self.english_lyric_option = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = dict(attrs)
        if values.get("id"):
            self.ids.append(values["id"] or "")
        if tag == "script" and values.get("src"):
            self.scripts.append(values["src"] or "")
        if tag == "link" and values.get("rel") == "stylesheet" and values.get("href"):
            self.stylesheets.append(values["href"] or "")
        if tag == "option" and values.get("value") == "en":
            self.english_lyric_option = True


class WebWorkbenchStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.html = (WORKBENCH / "index.html").read_text(encoding="utf-8")
        cls.javascript = (WORKBENCH / "app.js").read_text(encoding="utf-8")
        cls.styles = (WORKBENCH / "styles.css").read_text(encoding="utf-8")
        cls.parser = WorkbenchHtmlParser()
        cls.parser.feed(cls.html)

    def test_entrypoint_has_unique_ids_and_local_assets(self) -> None:
        self.assertEqual(len(self.parser.ids), len(set(self.parser.ids)))
        self.assertEqual(self.parser.scripts, ["desktop-bridge.js", "app.js"])
        self.assertEqual(self.parser.stylesheets, ["styles.css"])
        self.assertNotRegex(self.html, r"https?://")
        self.assertNotRegex(self.styles, r"https?://")

    def test_lyrics_are_limited_to_chinese_and_japanese(self) -> None:
        self.assertFalse(self.parser.english_lyric_option)
        self.assertIn('<option value="zh">中文</option>', self.html)
        self.assertIn('<option value="ja">日文</option>', self.html)
        self.assertIn('new Set(["zh", "ja"])', self.javascript)

    def test_user_content_is_not_inserted_with_inner_html(self) -> None:
        self.assertNotIn("innerHTML", self.javascript)
        self.assertIn("textContent", self.javascript)

    def test_project_and_analysis_versions_are_explicit(self) -> None:
        self.assertIn('PROJECT_SCHEMA = "miku-workbench-project/0.1.0"', self.javascript)
        self.assertIn('ANALYSIS_SCHEMA = "0.1.0"', self.javascript)
        self.assertIn("validateAnalysis", self.javascript)

    def test_analysis_validation_covers_every_rendered_inference_layer(self) -> None:
        for layer, field in (
            ("waveform", "bins"),
            ("short_time_energy", "bins"),
            ("tempo", "candidates"),
            ("key", "candidates"),
            ("chords", "windows"),
            ("sections", "boundaries"),
            ("sections", "regions"),
        ):
            self.assertIn(f'["{layer}", "{field}"]', self.javascript)
        self.assertIn("validateInterval", self.javascript)

    def test_project_import_rejects_duplicate_ids_and_unsupported_languages(self) -> None:
        self.assertIn("seenLyricIds.has(id)", self.javascript)
        self.assertIn("maximumLyricNumber + 1", self.javascript)
        self.assertIn('new Set(["zh", "ja"]).has(region.language)', self.javascript)

    def test_audio_association_checks_duration_and_sha256(self) -> None:
        self.assertIn("checkAudioAssociation", self.javascript)
        self.assertIn("state.audioSha256", self.javascript)
        self.assertIn("expectedHash !== state.audioSha256", self.javascript)

    def test_tempo_validation_and_rendering_have_iteration_guards(self) -> None:
        self.assertIn("candidateItem.bpm > 1000", self.javascript)
        self.assertIn("candidateItem.first_beat_seconds < 0", self.javascript)
        self.assertIn("maximumLines", self.javascript)
        self.assertIn("estimatedLineCount", self.javascript)

    def test_local_audio_urls_are_created_and_released(self) -> None:
        bridge = (WORKBENCH / "desktop-bridge.js").read_text(encoding="utf-8")
        self.assertIn("URL.createObjectURL(blob)", bridge)
        self.assertIn("URL.revokeObjectURL(url)", bridge)
        self.assertIn("bridge.revokeObjectUrl(state.audioUrl)", self.javascript)
        self.assertIn('addEventListener("pagehide"', self.javascript)

    def test_required_controls_are_wired(self) -> None:
        required_ids = {
            "analysis-file", "audio-file", "play-button", "timeline-canvas",
            "selection-start", "selection-end", "lyric-language", "lyric-text",
            "save-lyric-button", "chord-label", "save-chord-button",
            "restore-chord-button", "import-project-button", "export-project-button",
        }
        self.assertTrue(required_ids.issubset(set(self.parser.ids)))
        for identifier in required_ids:
            self.assertRegex(self.javascript, re.escape(identifier))


if __name__ == "__main__":
    unittest.main()
