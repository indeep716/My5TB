"""Set up private app storage and byte-verify a private generated fixture.
Does not publish catalog entries or read the real source collection.
"""
import json
import sys
from pathlib import Path
from PIL import Image
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ingestion'))
from my5tb.credentials import secret
from my5tb.drive_client import DriveClient,BASE
from my5tb.drive_setup import ensure_folder
from my5tb.cloud_api_client import CloudAPI
from my5tb.r2_client import R2Client
from my5tb.state import State
from my5tb.integrity import sha256_file

def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    root=Path(__file__).resolve().parents[1];work=root/'data/drive-setup';work.mkdir(parents=True,exist_ok=True)
    state=State(work/'setup.db')
    try:
        drive=DriveClient(state,secret('google_client_id'),secret('google_client_secret'),secret('google_refresh_token'))
        about=drive._request('GET',BASE+'/about',params={'fields':'user(emailAddress),storageQuota'})
        about.raise_for_status();about=about.json()
        expected='pasit0649514673@gmail.com'
        if about['user']['emailAddress'].casefold()!=expected:raise ValueError('Storage account mismatch; setup blocked')
        folder=ensure_folder(drive,'My5TB Storage',None,'root')
        folders={role:ensure_folder(drive,name,folder,role) for role,name in [('models','Published_Models')]}
        # The parent remains private, even though future selected model files can be link-shared.
        for folder_id in [folder,*folders.values()]:
            permissions=drive._request('GET',BASE+f'/files/{folder_id}/permissions',params={'fields':'permissions(type,role)'})
            permissions.raise_for_status()
            if any(p.get('type') in {'anyone','domain'} for p in permissions.json().get('permissions',[])):
                raise ValueError('Storage folders must not be publicly/domain shared')
        probe=work/'connection-test.png'
        if not probe.exists():Image.new('RGB',(16,16),'#6ea8ff').save(probe)
        sha=sha256_file(probe)
        r2=R2Client(CloudAPI('https://my5tb-web.pages.dev',secret('admin_token')))
        object_key='originals/setup-probe-'+sha
        r2.upload(probe,object_key);file_id='r2:'+object_key
        downloaded=work/'connection-test-restored.part'
        r2.download(object_key,downloaded)
        if sha256_file(downloaded)!=sha:raise ValueError('Private R2 upload/download checksum mismatch')
        manifest={'storage_email':expected,'root_id':folder,'folders':folders,'private_probe_id':file_id,'sha256_verified':True}
        (work/'storage.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
        cloud_config="root = 'E:\\3D'\ndata_dir = 'data/cloud'\nmode = 'cloud'\napi_url = 'https://my5tb-web.pages.dev'\n\n[drive_folders]\n"+''.join(f"{role} = '{folder_id}'\n" for role,folder_id in folders.items())
        (work/'cloud.toml').write_text(cloud_config,encoding='utf-8')
        print('Verified storage account: '+expected)
        print('Private app storage: https://drive.google.com/drive/folders/'+folder)
        print('Created/reused the private Published_Models folder on Drive. Private R2 image upload/download SHA-256 verified.')
        print('Cloud config ready: '+str(work/'cloud.toml'))
        print('No source files uploaded; production catalog unchanged; default desktop config remains offline.')
    finally:state.close()
if __name__=='__main__':main()
