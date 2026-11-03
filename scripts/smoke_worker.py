"""Local-only Python → actual Wrangler Worker → D1/R2 → restore smoke.
Original byte blobs use a filesystem fixture; Google Drive is not contacted.
Start wrangler on 127.0.0.1:8788 with the documented local fixture token first.
"""
import sys
import uuid
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ingestion'))
from my5tb.state import State
from my5tb.cloud_api_client import CloudAPI
from my5tb.r2_client import R2Client
from my5tb.storage import LocalBlobs
from my5tb.sync_engine import Engine
from my5tb.backup_restore import Recovery
from my5tb.diff_engine import diff
from my5tb.scanner import scan

def main():
    cloud=CloudAPI('http://127.0.0.1:8788','local-only-test-token-32-characters')
    if cloud.control()['generation']!=0:raise ValueError('Use a fresh local D1 dataset for this smoke')
    work=Path('data')/('worker-smoke-'+str(uuid.uuid4()));root=work/'source'
    p=root/'Realism/Artists/Local fixture/World/Character/version 1'
    (p/'file').mkdir(parents=True);(p/'picture').mkdir()
    (p/'file/fixture.blend').write_bytes(b'local fixture original bytes')
    Image.new('RGB',(24,24),'blue').save(p/'picture/main.png')
    class Blobs(LocalBlobs):
        def upload(self,path,key,public=False):
            if key.startswith('previews/'):return R2Client(cloud).upload(path,key)
            return super().upload(path,key,public)
    blobs=Blobs(work/'blobs');state=State(work/'local/db')
    engine=Engine(root,state,blobs,cloud,b'k'*32);run=engine.plan();generation=engine.apply(run['id'])
    assert generation==1;engine.apply(run['id'])
    restored=work/'restored';newstate=State(work/'new/db');recovery=Recovery(restored,newstate,blobs,cloud)
    recovery.restore();assert cloud.control()['mode']=='RECOVERY_LOCKED';assert diff(scan(restored),newstate.models())==[]
    recovery.unlock();assert cloud.control()['mode']=='NORMAL'
    assert (restored/p.relative_to(root)/'file/fixture.blend').read_bytes()==b'local fixture original bytes'
    state.close();newstate.close()
    print('PASS: Python -> Worker staged publish, idempotent retry, D1/R2 checks, lock, restored bytes, zero diff and unlock. Drive = filesystem fixture.')
if __name__=='__main__':main()
