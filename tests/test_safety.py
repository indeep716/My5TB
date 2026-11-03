import json
from pathlib import Path
import pytest
from my5tb.scanner import scan, volume_id
from my5tb.diff_engine import diff
from my5tb.manifest import validate_manifest, canonical, digest

def model(root, path="Realism/Artist/Media/Character/v1"):
    p = root / path
    (p / "file").mkdir(parents=True)
    (p / "picture").mkdir()
    (p / "file" / "model.blend").write_bytes(b"model")
    return p

def test_versions_and_legacy_category(tmp_path):
    model(tmp_path)
    model(tmp_path, "Realism/Artist/Media/Character/v2")
    result = scan(tmp_path)
    assert result.complete and len(result.models) == 2
    assert result.models[0]["artist_category"] == "Artists"
    assert result.models[0]["character_name"] == "Character"

def test_underscore_never_descended(tmp_path, monkeypatch):
    model(tmp_path)
    model(tmp_path, "_Stylized/secret/Media/Character")
    original = Path.iterdir
    def checked(path):
        assert not any(x.startswith("_") for x in path.relative_to(tmp_path).parts)
        return original(path)
    monkeypatch.setattr(Path, "iterdir", checked)
    assert len(scan(tmp_path).models) == 1

def test_rename_is_delete_add(tmp_path):
    p = model(tmp_path)
    before = scan(tmp_path)
    p.rename(p.with_name("v2"))
    ops = diff(scan(tmp_path), before.models)
    assert {o["kind"] for o in ops} == {"DELETE_MODEL", "ADD_MODEL"}

def test_invalid_scan_blocks_all(tmp_path):
    p = model(tmp_path)
    before = scan(tmp_path)
    (p / "file" / "bad.exe").write_bytes(b"bad")
    with pytest.raises(ValueError, match="scan"):
        diff(scan(tmp_path), before.models)

def test_volume_guard(tmp_path):
    assert volume_id(tmp_path)
    with pytest.raises(ValueError, match="volume"):
        scan(tmp_path, expected_volume="wrong")

def test_normalized_collision(tmp_path):
    model(tmp_path, "Realism/Artist/Media/Caf\u00e9")
    model(tmp_path, "Realism/Artist/Media/Cafe\u0301")
    assert not scan(tmp_path).complete

@pytest.mark.parametrize("path", ["../escape", "/abs", "C:/escape", "a/../../b", "a\\b", "a/CON", "a/file.", "a/_private/f"])
def test_manifest_rejects_unsafe_path(path):
    m = {"schema": 1, "dataset_id": "d", "generation": 1, "models": [{"local_relative_path": path, "files": []}]}
    with pytest.raises(ValueError):
        validate_manifest(m)

def test_manifest_hash_is_deterministic():
    assert canonical({"b": 2,"a": "ไทย"}) == canonical({"a": "ไทย", "b":2})
    assert len(digest({"x": 1})) == 64

def test_windows_metadata_is_excluded_without_reading(tmp_path):
    p=model(tmp_path)
    (p/'desktop.ini').write_bytes(b'system metadata')
    (p/'picture'/'Thumbs.db').write_bytes(b'cache')
    assert scan(tmp_path).complete

def test_avif_original_is_supported(tmp_path):
    from PIL import Image
    p=model(tmp_path)
    Image.new('RGB',(8,8)).save(p/'picture'/'main.avif')
    assert scan(tmp_path).complete

def test_collection_root_preserves_asset_category_and_versions(tmp_path):
    model(tmp_path,'Characters/Realism/Artists/Artist/Media/Character/v1')
    model(tmp_path,'Props/Stylized/Artists/Artist/Media/Chair/v2')
    result=scan(tmp_path)
    assert result.complete
    assert {m['asset_category'] for m in result.models}=={'Characters','Props'}
    character=next(m for m in result.models if m['asset_category']=='Characters')
    assert character['local_relative_path']=='Characters/Realism/Artists/Artist/Media/Character/v1'
    assert character['style']=='Realism' and character['artist_name']=='Artist'
    assert character['character_name']=='Character' and character['version']=='v1'

def test_category_rename_is_delete_add(tmp_path):
    model(tmp_path,'Characters/Realism/Artists/Artist/Media/Character')
    before=scan(tmp_path)
    (tmp_path/'Characters').rename(tmp_path/'Figures')
    operations=diff(scan(tmp_path),before.models)
    assert {o['kind'] for o in operations}=={'DELETE_MODEL','ADD_MODEL'}
    assert operations[0]['path'].startswith('Characters/')

def test_style_must_follow_optional_category_directly(tmp_path):
    model(tmp_path,'Characters/Unexpected/Realism/Artists/Artist/Media/Character')
    assert not scan(tmp_path).complete


def test_artist_character_layout_without_world_and_note_exclusion(tmp_path):
    p = model(tmp_path, 'Characters/Realism/Artists/Wildeer Studio/Lara Croft')
    (p / 'file' / 'info.txt').write_text('readme', encoding='utf-8')
    result = scan(tmp_path)
    assert result.complete and len(result.models) == 1
    m = result.models[0]
    assert m['artist_name'] == 'Wildeer Studio'
    assert m['media_title'] == 'Lara Croft' and m['character_name'] == 'Lara Croft'
    assert [f['path'] for f in m['files']] == ['file/model.blend']
    assert 'Characters/Realism/Artists/Wildeer Studio/Lara Croft/file/info.txt' in result.excluded


def test_dual_artist_parentheses_normalized_to_pipe_and_mmd_formats(tmp_path):
    import zipfile
    from ingestion.my5tb.formats import describe
    p = model(tmp_path, 'Characters/Stylized/Artists/clearday (バニラケーキ)/Zenless Zone Zero/Yixuan')
    (p / 'file' / 'model.blend').unlink()
    with zipfile.ZipFile(p / 'file' / 'yixuan.zip', 'w') as zf:
        zf.writestr('Yixuan/model.pmx', b'pmx')
        zf.writestr('Yixuan/motion.vmd', b'vmd')
    result = scan(tmp_path)
    assert result.complete and len(result.models) == 1
    m = result.models[0]
    assert m['local_relative_path'] == 'Characters/Stylized/Artists/clearday (バニラケーキ)/Zenless Zone Zero/Yixuan'
    assert m['artist_name'] == 'clearday | バニラケーキ'
    info = describe(p / 'file' / 'yixuan.zip')
    assert info['formats'] == ['MMD']
    assert info['contents'] == ['model.pmx', 'motion.vmd']
