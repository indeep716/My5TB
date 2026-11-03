"""Create/reuse app-owned private folders under limited drive.file permission."""
import hashlib
from .drive_client import BASE

def ensure_folder(drive,name,parent,role):
    identity=hashlib.sha256(('My5TB:folder:'+role).encode()).hexdigest()
    query="trashed=false and mimeType='application/vnd.google-apps.folder' and appProperties has { key='my5tb_folder' and value='"+identity+"' }"
    if parent:query+=" and '"+parent+"' in parents"
    response=drive._request('GET',BASE+'/files',params={'q':query,'fields':'files(id,name)','pageSize':100})
    response.raise_for_status();folders=response.json().get('files',[])
    if len(folders)>1:raise ValueError('Ambiguous duplicate My5TB storage folder; reconcile before continuing')
    if folders:return folders[0]['id']
    metadata={'name':name,'mimeType':'application/vnd.google-apps.folder','appProperties':{'my5tb_folder':identity}}
    if parent:metadata['parents']=[parent]
    response=drive._request('POST',BASE+'/files',params={'fields':'id'},json=metadata)
    response.raise_for_status()
    return response.json()['id']
