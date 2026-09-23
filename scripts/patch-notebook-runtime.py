"""Apply narrowly scoped, asserted compatibility patches to generated payloads."""
from pathlib import Path
import json
import shutil
import sys

ROOT = Path(__file__).resolve().parents[1]


def patch(runtime: Path):
    for name in ("launcher.py", "prism_api.py", "prism_worker.py", "prism_gateway.py"):
        shutil.copy2(ROOT / "notebook" / name, runtime / name)
    target = runtime / "backend/commands/podcast_commands.py"
    text = (ROOT / "notebook/upstream/commands/podcast_commands.py").read_text()
    marker = '        configure("speakers_config", {"profiles": speaker_profiles_dict})'
    assert text.count(marker) == 1
    # podcast-creator validates every supplied profile. Built-in presets do not
    # have configured model IDs yet; do not let unrelated presets break a valid
    # user-selected profile. Fail explicitly if the selected profile is invalid.
    replacement = '''        speaker_profiles_dict = {
            name: profile for name, profile in speaker_profiles_dict.items()
            if profile.get("tts_provider") and profile.get("tts_model")
        }
        episode_profiles_dict = {
            name: profile for name, profile in episode_profiles_dict.items()
            if profile.get("speaker_config") in speaker_profiles_dict
            and profile.get("outline_provider") and profile.get("transcript_provider")
        }
        if speaker_profile.name not in speaker_profiles_dict or episode_profile.name not in episode_profiles_dict:
            raise ValueError("Configure the selected episode and speaker profile models before generating audio")
''' + marker
    target.write_text(text.replace(marker, replacement))
    manifest = runtime / "manifest.json"
    if manifest.exists():
        value = json.loads(manifest.read_text())
        value["knowledgeGateway"] = 1
        manifest.write_text(json.dumps(value, indent=2) + "\n")
    (runtime / "smoke-tested.json").unlink(missing_ok=True)


if __name__ == "__main__":
    patch(Path(sys.argv[1]))
