import hashlib
import json
import re
from .contracts import safe_path

def canonical(value) -> bytes:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',',':')).encode('utf-8')

def digest(value) -> str:
    return hashlib.sha256(canonical(value)).hexdigest()

def validate_manifest(value: dict):
    if value.get('schema') != 1 or not isinstance(value.get('generation'), int) or value['generation'] < 0 or not value.get('dataset_id'):
        raise ValueError('Invalid manifest header')
    seen, identities = set(), set()
    for m in value.get('models', []):
        p = safe_path(m['local_relative_path'])
        if p != m['local_relative_path'] or p.casefold() in seen:
            raise ValueError('Duplicate or unnormalized model path')
        seen.add(p.casefold())
        category=m.get('asset_category','Characters')
        if safe_path(category)!=category or '/' in category:
            raise ValueError('Invalid asset category')
        if not m.get('id') or m['id'] in identities or len(p.split('/')) < 3:
            raise ValueError('Invalid model identity/hierarchy')
        identities.add(m['id'])
        files = set()
        for f in m['files']:
            name = safe_path(f['path'])
            if len(name.split('/')) != 2 or name.split('/')[0] not in {'file','picture'} or name.casefold() in files:
                raise ValueError('Invalid or duplicate file path')
            files.add(name.casefold())
            if not isinstance(f.get('size'), int) or f['size'] < 0 or not re.fullmatch('[a-f0-9]{64}', f.get('sha256','')) or not f.get('remote_id'):
                raise ValueError('Invalid manifest file')
    return value
