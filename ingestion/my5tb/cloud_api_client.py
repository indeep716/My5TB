from .http import HTTP

class CloudAPI:
    def __init__(self,base_url,token):
        if not base_url.startswith('https://') and not base_url.startswith(('http://127.0.0.1:','http://localhost:')):
            raise ValueError('Cloud API must use HTTPS')
        self.base=base_url.rstrip('/'); self.token=token; self.http=HTTP()
    def request(self,method,path,body=None):
        response=self.http.request(method,self.base+'/api/admin/'+path,headers={'Authorization':'Bearer '+self.token},json=body)
        if not response.ok:
            raise ValueError(f'Cloud API {response.status_code}: {response.json().get("error","request failed")}')
        return response.json()
    def control(self): return self.request('GET','control')
    def baseline(self): return self.request('GET','baseline')
    def snapshots(self): return self.request('GET','snapshots')
    def completed(self,run): return self.request('GET','completed?run_id='+run)['generation']
    def begin(self,run,generation,epoch): return self.request('POST','begin',{'run_id':run,'generation':generation,'epoch':epoch})
    def stage(self,run,item,generation,epoch): return self.request('POST','stage',{'run_id':run,'model':item,'generation':generation,'epoch':epoch})
    def abandon(self,run,generation,epoch): return self.request('POST','abandon',{'run_id':run,'generation':generation,'epoch':epoch})
    def tombstone(self,run,path,generation,epoch): return self.request('POST','tombstone',{'run_id':run,'path':path,'generation':generation,'epoch':epoch})
    def publish(self,run,manifest,remote,sha,generation,epoch):
        return self.request('POST','publish',{'run_id':run,'manifest':manifest,'manifest_remote_id':remote,'manifest_sha256':sha,'generation':generation,'epoch':epoch})['generation']
    def lock(self,owner): return self.request('POST','recovery/lock',{'owner':owner})
    def unlock(self,owner,epoch,generation): return self.request('POST','recovery/unlock',{'owner':owner,'epoch':epoch,'generation':generation,'verified':True})
    def usage(self): return self.request('GET','usage')
