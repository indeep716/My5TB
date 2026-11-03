"""Google Drive resumable uploads with preallocated IDs and durable session offsets."""
import time
import hashlib
from pathlib import Path
from .http import HTTP
from .integrity import sha256_file

BASE='https://www.googleapis.com/drive/v3'
class DriveClient:
    def __init__(self,state,client_id,client_secret,refresh_token):
        self.state=state; self.client_id=client_id; self.client_secret=client_secret; self.refresh_token=refresh_token
        self.http=HTTP(); self.token=None; self.expires=0
    def headers(self):
        if not self.token or time.monotonic()>self.expires:
            r=self.http.request('POST','https://oauth2.googleapis.com/token',data={'grant_type':'refresh_token','client_id':self.client_id,'client_secret':self.client_secret,'refresh_token':self.refresh_token})
            r.raise_for_status(); payload=r.json(); self.token=payload['access_token']; self.expires=time.monotonic()+payload.get('expires_in',3600)-60
        return {'Authorization':'Bearer '+self.token}
    def _request(self,method,url,**kwargs):
        if hasattr(self,'transfer_control'):self.transfer_control.checkpoint()
        extra=kwargs.pop('headers',{})
        r=self.http.request(method,url,headers=self.headers()|extra,**kwargs)
        if r.status_code==401:
            self.expires=0
            r=self.http.request(method,url,headers=self.headers()|extra,**kwargs)
        return r
    def upload(self,path,key,folder,public=False,expected_sha=None):
        path=Path(path); size=path.stat().st_size
        expected_sha=expected_sha or sha256_file(path)
        property_key=hashlib.sha256(key.encode()).hexdigest()
        jobkey='drive:'+key
        job=self.state.get(jobkey,{})
        if not job.get('id'):
            r=self._request('GET',BASE+'/files/generateIds',params={'count':1,'space':'drive','type':'files'});r.raise_for_status()
            job={'id':r.json()['ids'][0]};self.state.put(jobkey,job)
        # A previous create/upload may have succeeded just before the connection died.
        existing=self._request('GET',BASE+'/files/'+job['id'],params={'fields':'id,size,appProperties,sha256Checksum'})
        if existing.ok and int(existing.json().get('size',-1))==size and existing.json().get('appProperties',{}).get('my5tb_key')==property_key:
            if existing.json().get('sha256Checksum')!=expected_sha:raise ValueError('Remote checksum mismatch or unavailable')
            if public: self.share(job['id'])
            return job['id']
        if existing.status_code not in (200,404): existing.raise_for_status()
        session=job.get('session'); offset=0
        started=time.monotonic()
        if session:
            status=self._request('PUT',session,headers={'Content-Length':'0','Content-Range':f'bytes */{size}'})
            if status.status_code in (200,201):
                self.verify(job['id'],size,expected_sha)
                if public:self.share(job['id'])
                return job['id']
            if status.status_code==308:
                offset=int(status.headers.get('Range','bytes=0--1').split('-')[-1])+1 if status.headers.get('Range') else 0
            elif status.status_code in (404,410): session=None
            else: status.raise_for_status()
        if not session:
            metadata={'id':job['id'],'name':path.name,'parents':[folder],'appProperties':{'my5tb_key':property_key}}
            r=self._request('POST','https://www.googleapis.com/upload/drive/v3/files',params={'uploadType':'resumable'},json=metadata,headers={'X-Upload-Content-Type':'application/octet-stream','X-Upload-Content-Length':str(size)})
            r.raise_for_status();session=r.headers['Location'];job['session']=session;self.state.put(jobkey,job)
        if hasattr(self,'transfer_progress'):self.transfer_progress(path,offset,size)
        start_offset=offset
        if hasattr(self,'progress'):self.progress(f'Uploading to Drive: {path.name} ({size/1048576:.1f} MB)')
        with path.open('rb') as stream:
            stream.seek(offset)
            while offset<size:
                if hasattr(self,'transfer_control'):self.transfer_control.checkpoint()
                chunk=stream.read(min(8*1024*1024,size-offset))
                if not chunk:raise ValueError('Source file shrank during upload')
                r=self._request('PUT',session,data=chunk,headers={'Content-Length':str(len(chunk)),'Content-Range':f'bytes {offset}-{offset+len(chunk)-1}/{size}'})
                if r.status_code==308:
                    offset=int(r.headers['Range'].split('-')[-1])+1
                    stream.seek(offset)
                else:
                    r.raise_for_status();offset+=len(chunk)
                if hasattr(self,'transfer_progress'):self.transfer_progress(path,offset,size)
                if hasattr(self,'progress'):
                    elapsed=max(.001,time.monotonic()-started)
                    speed=(offset-start_offset)/1048576/elapsed
                    self.progress(f'Drive: {path.name} — {offset/1048576:.1f}/{size/1048576:.1f} MB ({100*offset/max(1,size):.0f}%) · {speed:.1f} MB/s')
        if size==0:
            r=self._request('PUT',session,data=b'',headers={'Content-Length':'0','Content-Range':'bytes */0'});r.raise_for_status()
        self.verify(job['id'],size,expected_sha)
        if public:self.share(job['id'])
        return job['id']
    def verify(self,file_id,size,sha):
        if hasattr(self,'progress'):self.progress('Verifying Drive SHA-256')
        r=self._request('GET',BASE+'/files/'+file_id,params={'fields':'id,size,sha256Checksum'})
        r.raise_for_status();metadata=r.json()
        if int(metadata.get('size',-1))!=size or metadata.get('sha256Checksum')!=sha:
            raise ValueError('Remote checksum mismatch or unavailable; publication blocked')
    def share(self,file_id):
        r=self._request('GET',BASE+f'/files/{file_id}/permissions',params={'fields':'permissions(id,type,role,allowFileDiscovery)'})
        r.raise_for_status()
        if not any(p.get('type')=='anyone' for p in r.json().get('permissions',[])):
            r=self._request('POST',BASE+f'/files/{file_id}/permissions',json={'type':'anyone','role':'reader','allowFileDiscovery':False});r.raise_for_status()
    def download(self,file_id,target):
        target=Path(target);target.parent.mkdir(parents=True,exist_ok=True)
        offset=target.stat().st_size if target.exists() else 0
        r=self._request('GET',BASE+'/files/'+file_id,params={'alt':'media'},headers={'Range':f'bytes={offset}-'} if offset else {},stream=True)
        if r.status_code==416 and offset:
            # Caller verifies full SHA before accepting an already-complete .part file.
            return
        r.raise_for_status()
        if offset and r.status_code!=206:
            offset=0
        if offset and not r.headers.get('Content-Range','').startswith(f'bytes {offset}-'):
            raise ValueError('Invalid download Content-Range')
        with target.open('ab' if offset else 'wb') as stream:
            for chunk in r.iter_content(4*1024*1024):
                if chunk:stream.write(chunk)
    def delete(self,file_id):
        r=self._request('DELETE',BASE+'/files/'+file_id)
        if r.status_code!=404:r.raise_for_status()
