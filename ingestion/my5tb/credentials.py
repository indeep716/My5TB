import base64
import os
import keyring

def secret(name,required=True):
    value=os.environ.get('MY5TB_'+name.upper()) or keyring.get_password('My5TB',name)
    if not value and required:
        raise ValueError(f'Missing {name}; use my5tb secret {name} or MY5TB_{name.upper()}')
    return value

def preview_key():
    value=secret('preview_key_b64')
    try:
        key=base64.b64decode(value,validate=True)
    except Exception as exc:
        raise ValueError('Invalid base64 preview key') from exc
    if len(key)!=32:
        raise ValueError('Preview key must decode to 32 bytes')
    return key
