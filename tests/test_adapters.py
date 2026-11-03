from pathlib import Path
import hashlib
from my5tb.drive_client import DriveClient
from my5tb.state import State
import pytest

class Response:
    def __init__(self,status=200,data=None,headers=None,content=b''):
        self.status_code=status;self._data=data;self.headers=headers or {};self.content=content;self.ok=status<400
    def json(self):return self._data
    def raise_for_status(self):
        if self.status_code>=400:raise ValueError(f'HTTP {self.status_code}')
    def iter_content(self,*args):yield self.content

def test_drive_resumes_existing_session_without_new_file(tmp_path,monkeypatch):
    state=State(tmp_path/'state.db');source=tmp_path/'model.glb';source.write_bytes(b'abcdefgh')
    state.put('drive:models/key',{'id':'preallocated','session':'https://upload.test/session'})
    drive=DriveClient(state,'id','secret','refresh');calls=[]
    def request(method,url,**kwargs):
        calls.append((method,url,kwargs))
        if method=='GET':
            return Response(200,{'size':'8','sha256Checksum':hashlib.sha256(b'abcdefgh').hexdigest()}) if any(c[2].get('data')==b'efgh' for c in calls) else Response(404)
        if kwargs.get('headers',{}).get('Content-Length')=='0':return Response(308,headers={'Range':'bytes=0-3'})
        assert kwargs['data']==b'efgh'
        assert kwargs['headers']['Content-Range']=='bytes 4-7/8'
        return Response(200,{'id':'preallocated'})
    monkeypatch.setattr(drive,'_request',request)
    assert drive.upload(source,'models/key','folder')=='preallocated'
    assert not any(method=='POST' for method,_,_ in calls)

def test_download_ignored_range_restarts_instead_of_appending(tmp_path,monkeypatch):
    state=State(tmp_path/'state.db');target=tmp_path/'file.part';target.write_bytes(b'ab')
    drive=DriveClient(state,'id','secret','refresh')
    monkeypatch.setattr(drive,'_request',lambda *a,**kw:Response(200,content=b'abcdef'))
    drive.download('id',target)
    assert target.read_bytes()==b'abcdef'

def test_download_wrong_range_is_rejected(tmp_path,monkeypatch):
    state=State(tmp_path/'state.db');target=tmp_path/'file.part';target.write_bytes(b'ab')
    drive=DriveClient(state,'id','secret','refresh')
    monkeypatch.setattr(drive,'_request',lambda *a,**kw:Response(206,headers={'Content-Range':'bytes 1-6/7'},content=b'abcdef'))
    with pytest.raises(ValueError,match='Range'):drive.download('id',target)

def test_drive_rejects_remote_checksum_mismatch(tmp_path,monkeypatch):
    state=State(tmp_path/'state.db');source=tmp_path/'model.glb';source.write_bytes(b'correct')
    state.put('drive:models/key',{'id':'allocated'})
    drive=DriveClient(state,'id','secret','refresh')
    monkeypatch.setattr(drive,'_request',lambda *a,**kw:Response(200,{'id':'allocated','size':'7','appProperties':{'my5tb_key':hashlib.sha256(b'models/key').hexdigest()},'sha256Checksum':'0'*64}))
    with pytest.raises(ValueError,match='checksum'):drive.upload(source,'models/key','folder')


def test_drive_reuses_engine_hash_but_still_verifies_remote(tmp_path,monkeypatch):
    import my5tb.drive_client as module
    state=State(tmp_path/'state.db');source=tmp_path/'model.glb';source.write_bytes(b'correct')
    sha=hashlib.sha256(b'correct').hexdigest()
    state.put('drive:models/key',{'id':'allocated'})
    drive=DriveClient(state,'id','secret','refresh')
    def redundant_hash(path):raise AssertionError('Engine already hashed this file')
    monkeypatch.setattr(module,'sha256_file',redundant_hash)
    metadata={'id':'allocated','size':'7','appProperties':{'my5tb_key':hashlib.sha256(b'models/key').hexdigest()},'sha256Checksum':sha}
    monkeypatch.setattr(drive,'_request',lambda *a,**kw:Response(200,metadata))
    assert drive.upload(source,'models/key','folder',expected_sha=sha)=='allocated'
    metadata['sha256Checksum']='0'*64
    with pytest.raises(ValueError,match='checksum'):drive.upload(source,'models/key','folder',expected_sha=sha)
    state.close()

def test_cloud_upload_refuses_trashed_storage_folder(tmp_path,monkeypatch):
    from my5tb.r2_client import CloudBlobs
    state=State(tmp_path/'state.db');drive=DriveClient(state,'id','secret','refresh');calls=[]
    def request(method,url,**kwargs):
        calls.append(method)
        return Response(200,{'id':'models','name':'Published_Models','mimeType':'application/vnd.google-apps.folder','trashed':True})
    monkeypatch.setattr(drive,'_request',request)
    blobs=CloudBlobs(drive,None,{'models':'models','originals':'originals','manifests':'manifests'})
    with pytest.raises(ValueError,match='in Trash'):blobs.prepare_item({'local_relative_path':'Characters/Realism/Artists/Artist/World/Model'})
    assert calls==['GET']
    state.close()

def test_images_and_manifests_only_go_to_r2(tmp_path):
    from my5tb.r2_client import CloudBlobs
    class NoDrive:
        def upload(self,*args,**kwargs):raise AssertionError('Images/manifests must never go to Drive')
    class R2:
        def __init__(self):self.keys=[]
        def upload(self,path,key):self.keys.append(key);return key
        def download(self,key,target):Path(target).write_bytes(b'original');return True
        def reference(self,id):return {'key':'originals/legacy'}
    r2=R2();blobs=CloudBlobs(NoDrive(),r2,{'models':'models','originals':'old','manifests':'old'})
    assert blobs.folders=={'models':'models'}
    assert blobs.upload(tmp_path/'image','originals/hash')=='r2:originals/hash'
    assert blobs.upload(tmp_path/'manifest','manifests/hash')=='r2:manifests/hash'
    assert blobs.upload(tmp_path/'preview','previews/hash')=='previews/hash'
    blobs.download('legacy-drive-id',tmp_path/'restored')
    assert (tmp_path/'restored').read_bytes()==b'original'
