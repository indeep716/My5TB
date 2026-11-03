import json
from types import SimpleNamespace
import pytest
import requests
from my5tb.google_auth import authorize

def client_file(tmp_path):
    path=tmp_path/'client.json'
    path.write_text(json.dumps({'installed':{'client_id':'client','client_secret':'secret','auth_uri':'https://accounts.google.com/o/oauth2/auth','token_uri':'https://oauth2.googleapis.com/token'}}))
    return path

class Flow:
    def run_local_server(self,**kwargs):
        assert kwargs['host']=='127.0.0.1' and kwargs['port']==0
        assert kwargs['login_hint']=='storage@example.com'
        return SimpleNamespace(token='access',refresh_token='refresh')

class Response:
    def __init__(self,email):self.email=email
    def raise_for_status(self):pass
    def json(self):return {'user':{'emailAddress':self.email}}

def test_authorization_saves_only_after_account_verified(tmp_path):
    saved={}
    result=authorize(client_file(tmp_path),'storage@example.com',flow_factory=lambda *a,**kw:Flow(),get=lambda *a,**kw:Response('storage@example.com'),save=lambda service,name,value:saved.update({name:value}))
    assert saved['google_refresh_token']=='refresh'
    assert saved['google_storage_email']=='storage@example.com'
    assert result=='storage@example.com'

def test_wrong_google_account_is_rejected_without_saving(tmp_path):
    saved=[]
    with pytest.raises(ValueError,match='Wrong Google account'):
        authorize(client_file(tmp_path),'storage@example.com',flow_factory=lambda *a,**kw:Flow(),get=lambda *a,**kw:Response('website@example.com'),save=lambda *a:saved.append(a))
    assert not saved

def test_web_client_is_rejected(tmp_path):
    path=tmp_path/'client.json';path.write_text('{"web":{}}')
    with pytest.raises(ValueError,match='Desktop'):
        authorize(path,'storage@example.com')

def test_drive_api_error_is_actionable_and_does_not_save_tokens(tmp_path):
    class Denied:
        def raise_for_status(self):raise requests.HTTPError('403')
        def json(self):return {'error':{'message':'Google Drive API is disabled','errors':[{'reason':'accessNotConfigured'}]}}
    saved=[]
    with pytest.raises(ValueError,match='Google Drive API is disabled'):
        authorize(client_file(tmp_path),'storage@example.com',flow_factory=lambda *a,**kw:Flow(),get=lambda *a,**kw:Denied(),save=lambda *a:saved.append(a))
    assert not saved
