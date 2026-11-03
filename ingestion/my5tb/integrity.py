import hashlib
from pathlib import Path

def sha256_file(path: Path, checkpoint=None) -> str:
    before = path.stat()
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(4 * 1024 * 1024), b''):
            if checkpoint:checkpoint()
            h.update(block)
    after = path.stat()
    if (before.st_size, before.st_mtime_ns, before.st_ino) != (after.st_size, after.st_mtime_ns, after.st_ino):
        raise ValueError(f'File changed while hashing: {path.name}')
    return h.hexdigest()
