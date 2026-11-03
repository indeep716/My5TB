"""Read-only production acceptance probes. Never prints tokens or key material."""
import base64
import json
import sys
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import keyring
import requests

SITE='https://my5tb-web.pages.dev'
API='https://my5tb-api.my5tb.workers.dev'

def main():
    checks=[]
    def record(name,ok):
        if not ok:raise AssertionError(name)
        checks.append({'check':name,'passed':True})
    paths=['/','/models','/robots.txt','/llms.txt','/api/sections','/api/models','/api/facets','/admin','/api/admin/control']
    def fetch(path):return path,requests.get(SITE+path,timeout=30)
    responses=dict(ThreadPoolExecutor(max_workers=5).map(fetch,paths))
    for path in ['/','/models','/robots.txt','/llms.txt','/api/sections','/api/models','/api/facets']:
        record('Public route '+path,responses[path].status_code==200)
        record('Noindex '+path,'noindex' in responses[path].headers.get('X-Robots-Tag',''))
    record('Pages CSP',"frame-ancestors 'none'" in responses['/'].headers.get('Content-Security-Policy',''))
    record('Robots disallow all','Disallow: /' in responses['/robots.txt'].text)
    record('English page', '<html lang="en">' in responses['/'].text)
    record('Only models enabled',[s['id'] for s in responses['/api/sections'].json()]==['models'])
    listing=responses['/api/models'].json()
    record('Empty production catalog',listing['items']==[] and listing['total']==0)
    record('Admin protected',responses['/admin'].status_code==401)
    record('Admin API protected',responses['/api/admin/control'].status_code==401)
    admin=keyring.get_password('My5TB','admin_token')
    record('Admin token stored',bool(admin and len(admin)>=32))
    c=requests.get(SITE+'/api/admin/control',headers={'Authorization':'Bearer '+admin},timeout=30)
    record('Authenticated proxy',c.status_code==200)
    control=c.json()
    record('Fresh production baseline',control['mode']=='NORMAL' and control['generation']==0 and control['active_run'] is None)
    dashboard=requests.get(SITE+'/admin',auth=('admin',admin),timeout=30)
    record('Authenticated dashboard',dashboard.status_code==200 and 'My5TB / Administration' in dashboard.text)
    record('Admin no-store',dashboard.headers.get('Cache-Control')=='no-store')
    key=requests.get(SITE+'/api/preview-key',timeout=30)
    record('Public preview key configured',key.status_code==200 and len(base64.b64decode(key.json()['key']))==32 and key.json()['key']==keyring.get_password('My5TB','preview_key_b64'))
    direct=requests.get(API+'/api/models',timeout=30)
    record('Direct Worker read API',direct.status_code==200 and direct.json()['total']==0)
    missing=requests.get(SITE+'/api/assets/manifests%2Fnot-public.json',timeout=30)
    record('Private namespace not served',missing.status_code==404)
    report={'site':SITE,'api':API,'checks':checks,'passed':len(checks),'writes_performed':False}
    target=Path(__file__).resolve().parents[1]/'data/deployment/live-checks.json';target.parent.mkdir(parents=True,exist_ok=True);target.write_text(json.dumps(report,indent=2),encoding='utf-8')
    print(f'PASS: {len(checks)} read-only live checks. No content writes or uploads performed.')
if __name__=='__main__':main()
