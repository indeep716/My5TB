"""Loopback OAuth + PKCE. Credentials are saved only after Drive identity matches."""
import json
import time
from pathlib import Path
import keyring
import requests

DRIVE_SCOPE='https://www.googleapis.com/auth/drive.file'

def authorize(client_path,expected_email,flow_factory=None,get=None,save=None,wait_seconds=0):
    config=json.loads(Path(client_path).read_text(encoding='utf-8-sig'))
    client=config.get('installed')
    if not client or not client.get('client_id') or not client.get('client_secret'):
        raise ValueError('A Google OAuth Desktop app client JSON is required')
    if client.get('auth_uri') not in ('https://accounts.google.com/o/oauth2/auth','https://accounts.google.com/o/oauth2/v2/auth') or client.get('token_uri')!='https://oauth2.googleapis.com/token':
        raise ValueError('Unexpected Google OAuth endpoints')
    if flow_factory is None:
        from google_auth_oauthlib.flow import InstalledAppFlow
        flow_factory=InstalledAppFlow.from_client_config
    flow=flow_factory({'installed':client},scopes=[DRIVE_SCOPE],autogenerate_code_verifier=True)
    credentials=flow.run_local_server(host='127.0.0.1',port=0,timeout_seconds=600,open_browser=True,
        login_hint=expected_email,prompt='consent select_account',
        authorization_prompt_message='Opening Google authorization in your default browser. Select the configured storage account.',
        success_message='Authorization received. Return to My5TB while the storage account is verified. You may close this tab.')
    deadline=time.monotonic()+wait_seconds
    announced=False
    while True:
        response=(get or requests.get)('https://www.googleapis.com/drive/v3/about',params={'fields':'user(emailAddress)'},headers={'Authorization':'Bearer '+credentials.token},timeout=30)
        try:
            response.raise_for_status()
            break
        except requests.HTTPError:
            try:detail=response.json().get('error',{})
            except ValueError:detail={}
            message=str(detail.get('message','Drive account verification was denied'))[:1500]
            reasons={item.get('reason') for item in detail.get('errors',[])+detail.get('details',[]) if isinstance(item,dict)}
            if not reasons.intersection({'accessNotConfigured','SERVICE_DISABLED'}) or time.monotonic()>=deadline:
                raise ValueError('Google Drive verification failed: '+message) from None
            if not announced:
                print('Google Drive API activation required: '+message,flush=True)
                print('Enable Drive API in project '+str(client.get('project_id','(OAuth client project)'))+'. Waiting without repeating login; no credentials saved yet.',flush=True)
                announced=True
            time.sleep(10)
    actual=response.json().get('user',{}).get('emailAddress','')
    if actual.casefold()!=expected_email.casefold():
        raise ValueError('Wrong Google account; credentials were not saved. Select the configured storage account and try again.')
    if not credentials.refresh_token:
        raise ValueError('No refresh token received; repeat authorization with consent')
    saver=save or keyring.set_password
    for name,value in {'google_client_id':client['client_id'],'google_client_secret':client['client_secret'],
                       'google_refresh_token':credentials.refresh_token,'google_storage_email':actual}.items():
        saver('My5TB',name,value)
    return actual
