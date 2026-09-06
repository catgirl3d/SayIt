from pathlib import Path


ROOT = Path(__file__).resolve().parents[3]
README_UK = ROOT / "README.md"
README_EN = ROOT / "README.en.md"
SERVER_README = ROOT / "server" / "README.md"


def test_readmes_describe_hotword_support():
    assert "Гарячі слова та правила для застосунків" in README_UK.read_text(encoding="utf-8")
    assert "Hotwords and per-app rules" in README_EN.read_text(encoding="utf-8")
    assert "Hotword Boosting" in SERVER_README.read_text(encoding="utf-8")


def test_server_readme_lists_configured_asr_engines():
    text = SERVER_README.read_text(encoding="utf-8")
    assert "Qwen3-ASR" in text
    assert "FireRedASR2" in text
    assert "Sber GigaAM" in text
