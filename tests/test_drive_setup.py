from my5tb.drive_setup import ensure_folder

class Response:
    def __init__(self,data):self.data=data
    def raise_for_status(self):pass
    def json(self):return self.data

def test_existing_app_folder_is_reused_without_create():
    class Drive:
        def _request(self,method,url,**kwargs):
            assert method=='GET'
            return Response({'files':[{'id':'existing'}]})
    assert ensure_folder(Drive(),'My5TB Storage',None,'root')=='existing'

def test_new_folder_is_private_and_nested():
    calls=[]
    class Drive:
        def _request(self,method,url,**kwargs):
            calls.append((method,kwargs))
            if method=='GET':return Response({'files':[]})
            assert kwargs['json']['parents']==['root-id']
            assert 'permissions' not in kwargs['json']
            return Response({'id':'new-id'})
    assert ensure_folder(Drive(),'Originals','root-id','originals')=='new-id'
