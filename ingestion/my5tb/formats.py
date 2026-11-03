"""Model format detection. Archives are listed read-only (central directory / headers); never extracted."""
import lzma
import struct
import zipfile
from pathlib import Path, PurePosixPath

# Extension -> public format label. Several extensions can share a label (Maya .ma/.mb -> MAYA).
FORMAT_LABELS = {
    '.blend': 'BLEND', '.blen': 'BLEND', '.fbx': 'FBX', '.ma': 'MAYA', '.mb': 'MAYA', '.maya': 'MAYA',
    '.max': 'MAX', '.c4d': 'C4D', '.obj': 'OBJ', '.glb': 'GLB', '.gltf': 'GLTF', '.dae': 'DAE', '.3ds': '3DS', '.abc': 'ABC',
    '.usd': 'USD', '.usda': 'USD', '.usdc': 'USD', '.usdz': 'USDZ', '.stl': 'STL', '.ply': 'PLY',
    '.ztl': 'ZBRUSH', '.zpr': 'ZBRUSH', '.vrm': 'VRM',
    '.pmx': 'MMD', '.pmd': 'MMD', '.mmd': 'MMD', '.vmd': 'MMD', '.vpd': 'MMD', '.pmm': 'MMD', '.x': 'MMD',
    '.unitypackage': 'UNITY', '.uasset': 'UNREAL', '.skp': 'SKP', '.hip': 'HOUDINI', '.spp': 'PAINTER',
}
ARCHIVE_EXT = {'.zip', '.rar', '.7z'}
MAX_LISTED = 500
MAX_HEADER_DICTIONARY = 64 * 1024 * 1024


def _decode_header(packed: bytes, filters: dict) -> bytes:
    # Output limits do not constrain the raw decoder dictionary allocation.
    size = filters.get('dict_size')
    if not isinstance(size, int) or not 0 < size <= MAX_HEADER_DICTIONARY:
        raise ValueError('7z metadata dictionary exceeds memory budget')
    return lzma.LZMADecompressor(lzma.FORMAT_RAW, filters=[filters]).decompress(packed, max_length=8 * 1024 * 1024)


def _rar_names(path: Path) -> list[str]:
    """List file names from RAR4/RAR5 headers without decompressing. Encrypted headers yield []."""
    names = []
    with path.open('rb') as stream:
        signature = stream.read(8)
        if signature.startswith(b'Rar!\x1a\x07\x01\x00'):
            def vint():
                value = shift = 0
                while True:
                    byte = stream.read(1)
                    if not byte: raise EOFError
                    value |= (byte[0] & 0x7f) << shift; shift += 7
                    if not byte[0] & 0x80: return value
            try:
                while len(names) < MAX_LISTED:
                    stream.read(4)  # header CRC
                    size = vint(); start = stream.tell()
                    kind = vint(); flags = vint()
                    extra = vint() if flags & 1 else 0
                    data = vint() if flags & 2 else 0
                    if kind == 4: return []  # archive encryption header: names unavailable
                    if kind == 2:
                        file_flags = vint(); vint(); vint()  # flags, unpacked size, attributes
                        if file_flags & 2: stream.read(4)  # mtime
                        if file_flags & 4: stream.read(4)  # data CRC
                        vint(); vint()  # compression, host OS
                        length = vint(); name = stream.read(length).decode('utf-8', 'replace')
                        if not file_flags & 1: names.append(name)
                    if kind == 5: break
                    stream.seek(start + size + data)
            except (EOFError, struct.error):
                pass
        elif signature[:7] == b'Rar!\x1a\x07\x00':
            stream.seek(7)
            while len(names) < MAX_LISTED:
                header = stream.read(7)
                if len(header) < 7: break
                _, kind, flags, size = struct.unpack('<HBHH', header)
                if size < 7: break
                body = stream.read(size - 7)
                added = struct.unpack('<I', body[:4])[0] if (flags & 0x8000 or kind == 0x74) and len(body) >= 4 else 0
                if kind == 0x74 and len(body) >= 25:
                    length = struct.unpack('<H', body[19:21])[0]
                    raw = body[25:25 + length]
                    name = raw.split(b'\x00')[0].decode('utf-8', 'replace') if b'\x00' in raw else raw.decode('cp437', 'replace')
                    if not flags & 0xe0 == 0xe0: names.append(name.replace('\\', '/'))
                elif kind == 0x7b: break
                stream.seek(added, 1)
    return names


def _7z_uint(buf: bytes, pos: int) -> tuple[int, int]:
    b = buf[pos]; pos += 1
    mask = 0x80; val = 0
    for i in range(8):
        if not (b & mask):
            return val | ((b & (mask - 1)) << (8 * i)), pos
        val |= buf[pos] << (8 * i); pos += 1
        mask >>= 1
    return val, pos


def _7z_names(path: Path) -> list[str]:
    """List file names from 7z headers read-only without extracting archive streams."""
    with path.open('rb') as stream:
        sig = stream.read(32)
        if len(sig) < 32 or sig[:6] != b'7z\xbc\xaf\x27\x1c':
            return []
        next_offset, next_size, _ = struct.unpack('<QQI', sig[12:32])
        if next_size <= 0 or next_size > 4 * 1024 * 1024:
            return []
        stream.seek(32 + next_offset)
        hdr = stream.read(next_size)
        if not hdr:
            return []
        if hdr[0] == 0x17 and len(hdr) > 4 and hdr[1] == 0x06:
            pos = 2
            pack_pos, pos = _7z_uint(hdr, pos)
            _, pos = _7z_uint(hdr, pos)
            if pos < len(hdr) and hdr[pos] == 0x09:
                pos += 1
                pack_size, pos = _7z_uint(hdr, pos)
                if 0 < pack_size <= 8 * 1024 * 1024:
                    stream.seek(32 + pack_pos)
                    packed = stream.read(pack_size)
                    idx = hdr.find(b'\x03\x01\x01\x05')
                    if idx != -1 and idx + 9 <= len(hdr):
                        dec = lzma._decode_filter_properties(lzma.FILTER_LZMA1, hdr[idx + 4:idx + 9])
                        hdr = _decode_header(packed, dec)
                    else:
                        idx2 = hdr.find(b'\x21\x01')
                        if idx2 != -1 and idx2 + 3 <= len(hdr):
                            dec = lzma._decode_filter_properties(lzma.FILTER_LZMA2, hdr[idx2 + 2:idx2 + 3])
                            hdr = _decode_header(packed, dec)
        pos = 0
        while True:
            idx = hdr.find(b'\x11', pos)
            if idx == -1 or idx + 3 >= len(hdr):
                break
            try:
                size, next_p = _7z_uint(hdr, idx + 1)
                if size >= 4 and next_p + size <= len(hdr) and hdr[next_p] == 0 and (size - 1) % 2 == 0:
                    raw_names = hdr[next_p + 1:next_p + size].decode('utf-16le', errors='ignore').split('\x00')
                    names = [n.replace('\\', '/') for n in raw_names if n]
                    if names and all(not any(ord(c) < 32 for c in n) for n in names[:10]):
                        return names[:MAX_LISTED]
            except (IndexError, ValueError):
                pass
            pos = idx + 1
    return []


def archive_entries(path: Path) -> list[str]:
    suffix = path.suffix.lower()
    try:
        if suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                return [i.filename for i in archive.infolist() if not i.is_dir()][:MAX_LISTED]
        if suffix == '.rar':
            return _rar_names(path)
        if suffix == '.7z':
            return _7z_names(path)
    except (OSError, zipfile.BadZipFile, lzma.LZMAError, struct.error, IndexError, ValueError):
        return []
    return []


def describe(path: Path) -> dict:
    """Return {'formats': [...labels], 'contents': [inner model file names]} for one model file."""
    path = Path(path); suffix = path.suffix.lower()
    if suffix not in ARCHIVE_EXT:
        label = FORMAT_LABELS.get(suffix, suffix.lstrip('.').upper())
        return {'formats': [label], 'contents': []}
    contents = sorted({PurePosixPath(n).name for n in archive_entries(path)
                       if PurePosixPath(n).suffix.lower() in FORMAT_LABELS and not PurePosixPath(n).name.startswith('._')},
                      key=str.casefold)
    formats = sorted({FORMAT_LABELS[PurePosixPath(n).suffix.lower()] for n in contents})
    return {'formats': formats or [suffix.lstrip('.').upper()], 'contents': contents[:200]}


def model_formats(files: list[dict]) -> list[str]:
    return sorted({label for f in files if f.get('kind') == 'model' for label in f.get('formats', [])})
