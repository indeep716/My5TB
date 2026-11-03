"""Explicit test reset, restricted to configured app-owned Drive folders."""
import uuid
import hashlib
from .drive_client import BASE


def reset_cloud(state,cloud,blobs):
    if not hasattr(blobs,'drive'):
        raise ValueError('Test reset is available in cloud mode only')
    if cloud.control().get('active_run'):raise ValueError('A sync run is active. Use Abandon selected run before resetting.')
    owner=state.get('test_reset_owner') or 'test-reset:'+str(uuid.uuid4())
    state.put('test_reset_owner',owner)
    c=cloud.control()
    # A lost final response may leave a fully reset remote with old local state.
    if not (state.get('test_reset_locked') and c['mode']=='NORMAL' and c['generation']==0):
        locked=cloud.request('POST','test-reset/start',{'owner':owner,'generation':c['generation'],'epoch':c['lock_epoch']})
        state.put('test_reset_locked',True)
        def children(folder):
            entries=[];page=None
            while True:
                params={'q':"'"+folder+"' in parents",'fields':'nextPageToken,files(id,name,mimeType,appProperties)','pageSize':1000}
                if page:params['pageToken']=page
                response=blobs.drive._request('GET',BASE+'/files',params=params);response.raise_for_status()
                result=response.json();entries.extend(result.get('files',[]));page=result.get('nextPageToken')
                if not page:return entries
        pending=[]
        def collect(folder):
            for entry in children(folder):
                props=entry.get('appProperties',{})
                is_folder=entry['mimeType']=='application/vnd.google-apps.folder'
                if not props.get('my5tb_folder' if is_folder else 'my5tb_key'):
                    raise ValueError('Reset refused: unrecognized Drive item inside My5TB storage: '+entry.get('name',entry['id']))
                if is_folder:collect(entry['id'])
                pending.append((entry['id'],is_folder))
        # Preflight the entire tree before deleting; only app-owned descendants qualify.
        for role,folder in blobs.folders.items():
            metadata=blobs.drive._request('GET',BASE+'/files/'+folder,params={'fields':'id,mimeType,appProperties'})
            metadata.raise_for_status();entry=metadata.json()
            identity=hashlib.sha256(('My5TB:folder:'+role).encode()).hexdigest()
            if entry.get('mimeType')!='application/vnd.google-apps.folder' or entry.get('appProperties',{}).get('my5tb_folder')!=identity:raise ValueError('Reset refused: configured folder is not My5TB-owned')
            collect(folder)
        for index,(file_id,is_folder) in enumerate(pending):
            if is_folder and children(file_id):raise ValueError('Drive folder changed during reset; retry after other uploads stop')
            blobs.drive.delete(file_id)
            if hasattr(blobs,'progress'):blobs.progress(f'Drive reset: deleted {index+1}/{len(pending)} files and subfolders')
        for folder in blobs.folders.values():
            if children(folder):raise ValueError('Drive storage changed during reset; no success reported')
        while True:
            try:result=cloud.request('POST','test-reset/step',{'owner':owner,'epoch':locked['lock_epoch']})
            except ValueError:
                c=cloud.control()
                if c['mode']=='NORMAL' and c['generation']==0:break
                raise
            if result['done']:break
    with state.db:
        for table in ('baseline','runs','operations','settings'):state.db.execute('DELETE FROM '+table)
    return True
