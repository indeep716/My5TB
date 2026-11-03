"""Read-only scanner. Exclusions are checked BEFORE any descent or stat."""
import ctypes
import os
from pathlib import Path
from .contracts import Scan, safe_path, format_artist_name, MODEL_EXT, IMAGE_EXT

def volume_id(root: Path) -> str:
    root = root.absolute()
    if not root.is_dir():
        raise ValueError('Root unavailable')
    if os.name == 'nt':
        serial = ctypes.c_ulong()
        volume = ctypes.create_unicode_buffer(1024)
        if not ctypes.windll.kernel32.GetVolumePathNameW(str(root), volume, len(volume)):
            raise OSError('Cannot identify volume')
        if not ctypes.windll.kernel32.GetVolumeInformationW(volume.value, None, 0, ctypes.byref(serial), None, None, None, 0):
            raise OSError('Cannot read volume ID')
        return f'win:{serial.value:08x}'
    return f'dev:{root.stat().st_dev}'

def scan(root: Path | str, expected_volume: str | None = None) -> Scan:
    root = Path(root).absolute()
    if any(ancestor.is_symlink() or ancestor.is_junction() for ancestor in [root,*root.parents]):
        return Scan(str(root),'unverified',errors=['Root and ancestors must not be links or junctions'])
    vol = volume_id(root)
    if expected_volume is not None and vol != expected_volume:
        raise ValueError('Wrong volume ID')
    result = Scan(str(root), vol)
    seen: set[str] = set()

    def entries(path):
        items = []
        try:
            for child in path.iterdir():
                relative = child.relative_to(root).as_posix()
                if child.name.startswith('_') or child.name.casefold() in {'desktop.ini','thumbs.db','.ds_store'}:
                    result.excluded.append(relative)
                    continue
                try:
                    if child.is_symlink() or child.is_junction():
                        result.errors.append(f'Link or junction: {relative}')
                        continue
                    normalized = safe_path(relative)
                    key = normalized.casefold()
                    if key in seen:
                        result.errors.append(f'Normalized path collision: {relative}')
                        continue
                    seen.add(key)
                    items.append(child)
                except OSError as exc:
                    result.errors.append(f'Unreadable {relative}: {exc}')
                except ValueError as exc:
                    result.errors.append(str(exc))
        except OSError as exc:
            result.errors.append(f'Incomplete scan: {path}: {exc}')
        return sorted(items, key=lambda p: p.name.casefold())

    def visit(path, depth=0):
        if depth > 12:
            result.errors.append(f'Hierarchy too deep: {path.relative_to(root)}')
            return
        children = entries(path)
        names = {p.name for p in children}
        if 'file' in names or 'picture' in names:
            parts = path.relative_to(root).parts
            style_index = 0 if parts and parts[0] in {'Stylized','Realism'} else 1
            if len(parts) < style_index + 3 or parts[style_index] not in {'Stylized', 'Realism'}:
                result.errors.append(f'Invalid model hierarchy: {path.relative_to(root)}')
                return
            has_source = parts[style_index+1] in {'Artists','Official','RIP'}
            offset = style_index + (2 if has_source else 1)
            if len(parts) < offset + 2 or not {'file','picture'} <= names:
                result.errors.append(f'Missing file/picture or metadata: {path.relative_to(root)}')
                return
            has_world = len(parts) >= offset + 3
            item = {'local_relative_path': safe_path(path.relative_to(root).as_posix()),
                    'asset_category': parts[0] if style_index else 'Characters',
                    'style': parts[style_index], 'artist_category': parts[style_index+1] if has_source else 'Artists',
                    'artist_name': format_artist_name(parts[offset]), 'media_title': parts[offset+1],
                    'character_name': parts[offset+2] if has_world else parts[offset+1],
                    'version': '/'.join(parts[offset+3:]) if has_world else '', 'files': []}
            for child in children:
                if child.name not in {'file','picture'} or not child.is_dir():
                    result.errors.append(f'Unexpected model entry: {child.relative_to(root)}')
                    continue
                for file in entries(child):
                    if file.is_file() and file.suffix.lower() in {'.txt','.md','.pdf','.rtf','.url'}:
                        result.excluded.append(file.relative_to(root).as_posix())
                        continue
                    allowed = MODEL_EXT if child.name == 'file' else IMAGE_EXT
                    if not file.is_file() or file.suffix.lower() not in allowed:
                        result.errors.append(f'Unsupported or nested entry: {file.relative_to(root)}')
                        continue
                    stat = file.stat()
                    item['files'].append({'path': safe_path(file.relative_to(path).as_posix()),
                                          'size': stat.st_size, 'mtime_ns': str(stat.st_mtime_ns),
                                          'kind': 'model' if child.name == 'file' else 'image'})
            if not any(f['kind'] == 'model' for f in item['files']):
                result.errors.append(f'Model has no files: {item["local_relative_path"]}')
            result.models.append(item)
            return
        for child in children:
            if child.is_dir():
                visit(child, depth+1)
            else:
                result.errors.append(f'Unexpected file outside model: {child.relative_to(root)}')
    if any(ancestor.is_symlink() or ancestor.is_junction() for ancestor in [root,*root.parents]):
        result.errors.append('Root and ancestors must not be links or junctions')
    else:
        try:
            visit(root)
        except OSError as exc:
            result.errors.append(f'Incomplete scan: {exc}')
    if volume_id(root) != vol:
        result.errors.append('Volume changed during scan')
    return result
