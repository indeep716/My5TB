from dataclasses import dataclass, field
from pathlib import PurePosixPath
import re
import unicodedata

MODEL_EXT = {'.zip', '.rar', '.7z', '.blend', '.blen', '.fbx', '.ma', '.mb', '.maya', '.max', '.c4d', '.obj', '.glb', '.gltf', '.dae', '.3ds',
             '.abc', '.usd', '.usda', '.usdc', '.usdz', '.stl', '.ply', '.ztl', '.zpr', '.vrm', '.pmx', '.pmd', '.mmd', '.vmd', '.vpd', '.pmm', '.x',
             '.unitypackage', '.uasset', '.skp', '.hip', '.spp'}
IMAGE_EXT = {'.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif'}

def format_artist_name(value: str) -> str:
    if not isinstance(value, str):
        return ''
    formatted = re.sub(r'\s*[\(（]\s*([^\)）]+?)\s*[\)）]', r' | \1', value).strip(' |')
    return re.sub(r'\s*\|\s*', ' | ', formatted) if formatted else value.strip()

def safe_path(value: str) -> str:
    if not isinstance(value, str) or not value or '\\' in value:
        raise ValueError('Unsafe path')
    normalized = unicodedata.normalize('NFC', value)
    parts = normalized.split('/')
    reserved = {'CON','PRN','AUX','NUL'} | {f'{prefix}{i}' for prefix in ('COM','LPT') for i in range(1,10)}
    if any(not p or p in {'.','..'} or p.startswith('_') or p.endswith((' ', '.')) or
           re.search(r'[\x00-\x1f<>:"|?*]', p) or p.split('.')[0].upper() in reserved for p in parts):
        raise ValueError(f'Unsafe path: {value}')
    if PurePosixPath(normalized).is_absolute():
        raise ValueError('Absolute path')
    return normalized

@dataclass
class Scan:
    root: str
    volume: str
    models: list[dict] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    excluded: list[str] = field(default_factory=list)
    @property
    def complete(self):
        return not self.errors
