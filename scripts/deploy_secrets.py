"""Install production Worker secrets from the OS credential vault, never stdout/files.
Run only after authorizing deployment and creating the production Worker.
"""
import base64
import json
import os
import secrets
import subprocess
import sys
from pathlib import Path
import keyring

def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    root=Path(__file__).resolve().parents[1]
    token=keyring.get_password('My5TB','admin_token')
    if not token:
        token=secrets.token_urlsafe(48)
        keyring.set_password('My5TB','admin_token',token)
    if len(token)<32 or token.startswith('local-only-test-'):
        raise ValueError('Production admin token must be at least 32 characters and must not be a test fixture')
    preview=keyring.get_password('My5TB','preview_key_b64')
    if not preview:
        preview=base64.b64encode(secrets.token_bytes(32)).decode('ascii')
        keyring.set_password('My5TB','preview_key_b64',preview)
    if len(base64.b64decode(preview,validate=True))!=32:
        raise ValueError('Production preview key must decode to 32 bytes')
    result=subprocess.run(['npx.cmd' if os.name=='nt' else 'npx','wrangler','secret','bulk','--config','cloud/wrangler.jsonc'],cwd=root,input=json.dumps({'ADMIN_TOKEN':token,'PREVIEW_KEY_B64':preview}),text=True,encoding='utf-8',errors='replace',capture_output=True)
    output=result.stdout+result.stderr
    for value in (token,preview):output=output.replace(value,'[REDACTED]')
    print(output)
    if result.returncode:raise SystemExit(result.returncode)
    print('Production secrets stored in Cloudflare and Windows Credential Manager (My5TB). Keep an independent external backup.')
if __name__=='__main__':main()
