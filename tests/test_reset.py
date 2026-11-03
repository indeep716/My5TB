import hashlib
import pytest
from my5tb.reset import reset_cloud
from my5tb.state import State

class Response:
    def __init__(self,data):self.data=data
    def json(self):return self.data
    def raise_for_status(self):pass

class Cloud:
    def control(self):return {'active_run':None,'mode':'NORMAL','generation':2,'lock_epoch':0}
    def request(self,method,path,body):return {'lock_epoch':1} if path.endswith('start') else {'done':True}

class Drive:
    def __init__(self,foreign=False):
        self.deleted=[]
        self.tree={'root':[{'id':'folder','mimeType':'application/vnd.google-apps.folder','appProperties':{'my5tb_folder':'owned'}}], 'folder':[{'id':'file','name':'model.zip','mimeType':'application/zip','appProperties':{} if foreign else {'my5tb_key':'owned'}}]}
    def _request(self,method,url,**kwargs):
        params=kwargs.get('params',{})
        if 'q' in params:return Response({'files':self.tree.get(params['q'].split("'")[1],[])})
        return Response({'mimeType':'application/vnd.google-apps.folder','appProperties':{'my5tb_folder':hashlib.sha256(b'My5TB:folder:models').hexdigest()}})
    def delete(self,id):
        if id=='folder':assert not self.tree['folder']
        self.deleted.append(id)
        for key in self.tree:self.tree[key]=[item for item in self.tree[key] if item['id']!=id]

class Blobs:
    def __init__(self,foreign=False):self.drive=Drive(foreign);self.folders={'models':'root'}

def test_reset_deletes_drive_files_and_empty_subfolders_but_keeps_root(tmp_path):
    state=State(tmp_path/'db');blobs=Blobs()
    assert reset_cloud(state,Cloud(),blobs)
    assert blobs.drive.deleted==['file','folder']
    assert blobs.drive.tree['root']==[]
    state.close()

def test_reset_preflight_refuses_foreign_items_without_deleting_anything(tmp_path):
    state=State(tmp_path/'db');blobs=Blobs(True)
    with pytest.raises(ValueError,match='unrecognized Drive item'):reset_cloud(state,Cloud(),blobs)
    assert blobs.drive.deleted==[]
    state.close()
