import json
from pathlib import Path
from .http import HTTP
class R2Client:
    def __init__(self,cloud): self.cloud=cloud;self.http=HTTP()
    def upload(self,path,key):
        if hasattr(self,'transfer_control'):self.transfer_control.checkpoint()
        c=self.cloud.control()
        with Path(path).open('rb') as stream:
            response=self.http.request('PUT',self.cloud.base+'/api/admin/blobs',params={'key':key},headers={'Authorization':'Bearer '+self.cloud.token,'X-Generation':str(c['generation']),'X-Lock-Epoch':str(c['lock_epoch']),'Content-Type':'application/octet-stream'},data=stream.read())
        if not response.ok:raise ValueError(f'R2 upload blocked: {response.status_code}')
        return key

    def reference(self,remote_id):
        response=self.http.request('GET',self.cloud.base+'/api/admin/blobs',params={'key':'references/'+remote_id+'.json'},headers={'Authorization':'Bearer '+self.cloud.token})
        if response.status_code==404:return None
        if not response.ok:raise ValueError(f'R2 reference lookup blocked: {response.status_code}')
        return response.json()
    def download(self,key,target,missing_ok=False):
        response=self.http.request('GET',self.cloud.base+'/api/admin/blobs',params={'key':key},headers={'Authorization':'Bearer '+self.cloud.token},stream=True)
        if missing_ok and response.status_code==404:return False
        if not response.ok:raise ValueError(f'R2 download blocked: {response.status_code}')
        target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
        with target.open('wb') as stream:
            for chunk in response.iter_content(4*1024*1024):
                if chunk:stream.write(chunk)
        return True

class CloudBlobs:
    def __init__(self,drive,r2,folders):self.drive=drive;self.r2=r2;self.folders={'models':folders['models']}
    def validate_storage_folders(self):
        from .drive_client import BASE
        for role,folder in self.folders.items():
            response=self.drive._request('GET',BASE+'/files/'+folder,params={'fields':'id,name,mimeType,trashed'})
            response.raise_for_status();metadata=response.json()
            if metadata.get('trashed'):
                raise ValueError('Drive storage folder '+metadata.get('name',role)+' is in Trash. Restore it in Google Drive before continuing this upload.')
            if metadata.get('mimeType')!='application/vnd.google-apps.folder':raise ValueError('Invalid Drive storage folder: '+role)
        self.storage_checked=True
    def prepare_item(self,item):
        self.validate_storage_folders()
        from .drive_setup import ensure_folder
        self.item_folders={}
        for namespace in ('models',):
            parent=self.folders[namespace]
            for depth,name in enumerate(item['local_relative_path'].split('/')):
                role=namespace+':'+ '/'.join(item['local_relative_path'].split('/')[:depth+1])
                if not hasattr(self,'folder_cache'):self.folder_cache={}
                if role not in self.folder_cache:self.folder_cache[role]=ensure_folder(self.drive,name,parent,role)
                parent=self.folder_cache[role]
            self.item_folders[namespace]=parent
    def upload_verified(self,path,key,sha,public=False):
        return self.upload(path,key,public,expected_sha=sha)
    def upload(self,path,key,public=False,expected_sha=None):
        namespace=key.split('/')[0]
        if namespace in ('previews','originals','manifests','references'):
            self.r2.upload(path,key)
            return key if namespace=='previews' else 'r2:'+key
        if namespace!='models':raise ValueError('Invalid blob namespace')
        if not getattr(self,'storage_checked',False):self.validate_storage_folders()
        remote=self.drive.upload(path,key,getattr(self,'item_folders',{}).get(namespace,self.folders[namespace]),public=public,expected_sha=expected_sha)
        return remote
    def download(self,key,target):
        if key.startswith('r2:'):return self.r2.download(key[3:],target)
        # Legacy snapshots retain their immutable hashes and original Drive IDs.
        # Private R2 aliases redirect migrated image/manifest IDs without rewriting history.
        reference=self.r2.reference(key)
        if reference:return self.r2.download(reference['key'],target)
        return self.drive.download(key,target)
    def delete(self,key):return self.drive.delete(key)
