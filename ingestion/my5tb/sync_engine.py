import copy
import hashlib
import uuid
import json
from pathlib import Path
from .scanner import scan
from .diff_engine import diff
from .manifest import canonical, digest, validate_manifest
from .integrity import sha256_file
from .images import preview, select_roles
from .transfer import UploadCancelled
from .formats import describe, model_formats
from .contracts import format_artist_name

class Engine:
    def __init__(self,root,state,blobs,cloud,preview_key):
        self.root=Path(root).absolute(); self.state=state; self.blobs=blobs; self.cloud=cloud; self.key=preview_key
        if len(preview_key)!=32:
            raise ValueError('AES-256 key must be 32 bytes')
    def checkpoint(self):
        if hasattr(self,'transfer_control'):self.transfer_control.checkpoint()
    def _hash(self,path):
        return sha256_file(path,self.checkpoint)
    def _report_fraction(self,fraction):
        if not hasattr(self,'percentages') or not hasattr(self,'_queue_total'):return
        model_percent=min(99.,95.*max(0.,min(1.,fraction)))
        current_weight=self._queue_weights[self._queue_index]
        overall=100.*(sum(self._queue_weights[:self._queue_index])+current_weight*model_percent/100)/self._queue_total
        self.percentages({'model':self._queue_name,'model_percent':model_percent,'overall_percent':min(99.9,overall),'completed':self._queue_index,'total':len(self._queue_weights)})
    def transfer_progress(self,path,offset,total):
        if getattr(self,'_active_source',None)==Path(path):
            self._report_fraction((self._file_done+min(offset,total))/self._model_bytes)
    def cancel_incremental(self,run_id):
        parent=self.state.run(run_id)
        if not parent.get('incremental'):return self.abandon(run_id)
        for unit in parent['units'][parent.get('done',0):]:
            if self.state.run_status(unit['id']):
                child=self.state.run(unit['id'])
                completed=self.cloud.completed(child['id'])
                if completed is not None:self.state.baseline(self.cloud.baseline(),completed)
                elif self.state.run_status(child['id'])!='ABANDONED':self.abandon(child['id'])
        self.state.save_run(parent,'CANCELLED')
    def apply_incremental(self,run_id,confirm_delete=False,confirm_mass=False,continue_on_error=False):
        """Publish each model using an ordinary fenced, recoverable child run."""
        parent=self.state.run(run_id)
        if self.state.run_status(run_id) in ('ABANDONED','CANCELLED'):
            raise ValueError('This queue was cancelled. Scan to start a new upload.')
        if not parent.get('incremental'):
            if self.cloud.completed(run_id) is not None:return self.apply(run_id,confirm_delete,confirm_mass)
            self._check(parent)
            if parent['deletes'] and not confirm_delete:raise ValueError('Deletion confirmation required')
            if parent['mass_delete'] and not confirm_mass:raise ValueError('Mass deletion second confirmation required')
            if parent['mass_delete'] and parent['baseline'] and not self.cloud.snapshots():raise ValueError('Mass deletion requires a completed recovery snapshot')
            if self.cloud.control()['active_run']==run_id:self.cloud.abandon(run_id,parent['generation'],parent['epoch'])
            units=[{'id':str(uuid.uuid4()),'paths':[path]} for path in parent['items']]
            deleted=[op['path'] for op in parent['operations'] if op['kind']=='DELETE_MODEL']
            if deleted:units.append({'id':str(uuid.uuid4()),'paths':deleted,'deletions':True})
            parent.update(incremental=True,units=units,done=0)
            self.state.save_run(parent,'RUNNING')
        units=parent['units'];self._queue_weights=[max(1,sum(f['size'] for path in unit['paths'] for f in parent['items'].get(path,{}).get('files',[]))) for unit in units]
        self._queue_total=max(1,sum(self._queue_weights))
        child=None
        try:
            for index,unit in enumerate(units):
                if index<parent['done']:continue
                self.checkpoint()
                self._queue_index=index;self._queue_name='Deletions' if unit.get('deletions') else unit['paths'][0]
                self._report_fraction(0)
                child=self.state.run(unit['id']) if self.state.run_status(unit['id']) else None
                if child is None:
                    c=self.cloud.control()
                    if c['generation']!=self.state.get('generation') or c['lock_epoch']!=parent['epoch']:raise ValueError('Cloud changed; recovery or a new upload is required')
                    child=copy.deepcopy(parent)
                    for key in ('incremental','units','done'):child.pop(key,None)
                    child.update(id=unit['id'],parent_id=run_id,scope=unit['paths'],generation=c['generation'],baseline=self.state.models(),operations=[op for op in parent['operations'] if op['path'] in unit['paths']],items={p:m for p,m in parent['items'].items() if p in unit['paths']},deletes=len(unit['paths']) if unit.get('deletions') else 0,mass_delete=parent['mass_delete'] if unit.get('deletions') else False)
                    self.state.save_run(child,'PLANNED')
                try:
                    generation=self.apply(child['id'],confirm_delete,confirm_mass)
                except UploadCancelled:raise
                except Exception as exc:
                    if not continue_on_error:raise
                    completed=self.cloud.completed(child['id'])
                    if completed is not None:
                        self.state.baseline(self.cloud.baseline(),completed);generation=completed
                    else:
                        c=self.cloud.control()
                        if c.get('active_run')==child['id']:
                            self.cloud.abandon(child['id'],c['generation'],c['lock_epoch'])
                        elif c.get('active_run'):raise ValueError('Cloud ownership changed during cleanup') from exc
                        self.state.save_run(child,'ABANDONED')
                        parent.setdefault('errors',[]).append({'model':self._queue_name,'error':str(exc)})
                        parent['done']=index+1;self.state.save_run(parent,'RUNNING');child=None
                        if hasattr(self,'progress'):self.progress('Not published: '+self._queue_name+' - '+str(exc))
                        continue
                parent['done']=index+1;self.state.save_run(parent,'RUNNING');child=None
                if hasattr(self,'percentages'):
                    self.percentages({'model':self._queue_name,'model_percent':100.,'overall_percent':100. if index+1==len(units) else min(99.9,100.*sum(self._queue_weights[:index+1])/self._queue_total),'completed':index+1,'total':len(units)})
                if hasattr(self,'progress'):self.progress('Published '+self._queue_name+f' · generation {generation}')
            self.state.save_run(parent,'PARTIAL' if parent.get('errors') else 'COMPLETED')
            if not units and hasattr(self,'percentages'):self.percentages({'model':'No changes','model_percent':100.,'overall_percent':100.,'completed':0,'total':0})
            return self.state.get('generation',parent['generation'])
        except UploadCancelled:
            # Completed children survive cancellation; unfinished blobs are retained.
            if child is not None:
                if self.cloud.completed(child['id']) is not None:
                    self.state.baseline(self.cloud.baseline(),self.cloud.completed(child['id']))
                else:self.abandon(child['id'])
            self.state.save_run(parent,'CANCELLED')
            if hasattr(self,'progress'):self.progress('Cancelled. Completed models and uploaded files were kept.')
            return self.state.get('generation',parent['generation'])
        except Exception:
            self.state.save_run(parent,'FAILED');raise
    def prepare_upload(self, choices=None):
        """Release an interrupted run owned by this local journal before replanning.
        Caller must hold the desktop operation lock. Never take another device's run.
        """
        c=self.cloud.control()
        if c['mode']!='NORMAL':raise ValueError('Cloud maintenance/recovery must finish before upload')
        active=c.get('active_run')
        if active:
            if not self.state.run_status(active):raise ValueError('An upload on another device owns cloud; stop it on that device first')
            old=self.state.run(active)
            if old.get('dataset_id')!=c['dataset_id']:raise ValueError('Dataset mismatch; refusing to release another dataset')
            completed=self.cloud.completed(active)
            if completed is None:
                self.cloud.abandon(active,c['generation'],c['lock_epoch'])
                self.state.save_run(old,'ABANDONED')
            else:self.state.save_run(old,'COMPLETED')
            if old.get('parent_id'):
                parent=self.state.run(old['parent_id']);self.state.save_run(parent,'CANCELLED')
            self.state.baseline(self.cloud.baseline(),self.cloud.control()['generation'])
            if hasattr(self,'progress'):self.progress('Interrupted local upload cleared; completed models retained')
        return self.plan(choices)

    def upload_report(self, run_id):
        run=self.state.run(run_id);errors=run.get('errors',[])
        units=run.get('units',[]);attempted=run.get('done',0)
        report={'run_id':run_id,'generation':self.state.get('generation',run['generation']),
                'passed':attempted-len(errors),'failed':len(errors),'remaining':len(units)-attempted,
                'cancelled':self.state.run_status(run_id)=='CANCELLED','errors':errors}
        folder=self.state.path.parent/'logs';folder.mkdir(parents=True,exist_ok=True)
        path=folder/('upload-'+run_id+'.json');report['log_path']=str(path.resolve())
        path.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
        return report

    def plan(self,choices=None):
        c=self.cloud.control()
        if c['mode']!='NORMAL':
            raise ValueError('Cloud locked; normal sync blocked')
        if c.get('active_run'):
            active=c['active_run']
            try:
                saved=self.state.run(active);queue=saved.get('parent_id',active)
                raise ValueError('Unfinished upload '+queue+' still owns cloud. Use Load unfinished upload to continue, or Abandon selected run to cancel it while keeping uploaded files.')
            except ValueError as exc:
                if str(exc)!='Unknown run':raise
                raise ValueError('Another device or an unknown upload owns cloud: '+active+'. Finish or cancel it on the owning device before starting a new upload.') from exc
        if self.state.get('device_id') is None:
            if c['generation'] or self.cloud.baseline():
                raise ValueError('Recovery required: cloud exists but local identity is missing')
            self.state.put('device_id',str(uuid.uuid4())); self.state.put('dataset_id',c['dataset_id'])
            self.state.put('generation',0)
        if self.state.get('dataset_id')!=c['dataset_id'] or self.state.get('generation')!=c['generation']:
            raise ValueError('Dataset/generation mismatch; Recovery required')
        result=scan(self.root,self.state.get('volume_id'))
        if self.state.get('root') and self.state.get('root')!=str(self.root):
            if c['generation']!=0 or c['active_run'] is not None or self.state.models() or self.cloud.baseline():
                raise ValueError('Root changed; existing synced paths cannot be rebased automatically')
        operations=diff(result,self.state.models())
        choices=choices or {}
        baseline={m['local_relative_path']:m for m in self.state.models()}
        # Choices alone also represent a metadata/image update.
        for path in choices:
            if path in baseline and choices[path]!=baseline[path].get('roles',{}) and not any(o['path']==path for o in operations):
                current=next((m for m in result.models if m['local_relative_path']==path),None)
                if current:
                    operations.append({'kind':'UPDATE_IMAGE','path':path,'model':current,'before':baseline[path]})
        items={}
        for op in operations:
            if op['kind']=='DELETE_MODEL':
                continue
            path=op['path']; item=copy.deepcopy(op['model']); prior=baseline.get(path,{})
            item['id']=prior.get('id',str(uuid.uuid4()))
            item['roles']=select_roles(item,prior.get('roles'),choices.get(path))
            item['status']='ACTIVE' if item['roles'] else 'DRAFT'
            items[path]=item
        count=sum(o['kind']=='DELETE_MODEL' for o in operations)
        total=len(baseline)
        run={'id':str(uuid.uuid4()),'generation':c['generation'],'epoch':c['lock_epoch'],
             'dataset_id':c['dataset_id'],'volume':result.volume,'operations':operations,'items':items,
             'deletes':count,'mass_delete':bool(count and (count/max(total,1)>.2 or count>=10)),
             'baseline':list(baseline.values())}
        self.state.backup(); self.state.save_run(run,'PLANNED')
        self.state.put('volume_id',result.volume); self.state.put('root',str(self.root))
        return run
    def _check(self,run):
        c=self.cloud.control()
        if c['mode']!='NORMAL' or c['generation']!=run['generation'] or c['lock_epoch']!=run['epoch']:
            raise ValueError('Cloud locked or stale writer fenced')
        return c
    def abandon(self,run_id):
        run=self.state.run(run_id)
        if self.cloud.completed(run_id) is not None:raise ValueError('Completed run cannot be abandoned')
        c=self._check(run)
        if c['active_run']==run_id:self.cloud.abandon(run_id,run['generation'],run['epoch'])
        elif c['active_run'] is not None:raise ValueError('Another run owns cloud')
        self.state.save_run(run,'ABANDONED')
    def apply(self,run_id,confirm_delete=False,confirm_mass=False):
        run=self.state.run(run_id)
        if self.state.run_status(run_id)=='ABANDONED':raise ValueError('Abandoned run cannot be resumed; build a new plan')
        completed=self.cloud.completed(run_id)
        if completed is not None:
            # Historical completion identifies the run, not the current catalog generation.
            for _ in range(3):
                before=self.cloud.control()
                if self.state.get('generation')==before['generation'] and before['generation']>=completed:
                    break
                if before['mode']!='NORMAL' or before.get('active_run'):
                    raise ValueError('Cloud is busy; retry completed-run reconciliation later')
                models=self.cloud.baseline()
                after=self.cloud.control()
                if all(before.get(k)==after.get(k) for k in ('generation','lock_epoch','mode','active_run')):
                    self.state.baseline(models,after['generation'])
                    break
            else:raise ValueError('Cloud changed during reconciliation; retry later')
            self.state.save_run(run,'COMPLETED')
            return completed
        self._check(run)
        if run['deletes'] and not confirm_delete:
            raise ValueError('Deletion confirmation required')
        if run['mass_delete'] and not confirm_mass:
            raise ValueError('Mass deletion second confirmation required')
        if not run['operations']:
            return run['generation']
        self.checkpoint()
        current=scan(self.root,run['volume'])
        current_by={m['local_relative_path']:m for m in current.models}
        if not current.complete:
            raise ValueError('Incomplete scan; apply blocked')
        # Recompute the entire planned diff, including deletes, before any writes.
        expected=[(o['kind'],o['path']) for o in run['operations']]
        actual=[(o['kind'],o['path']) for o in diff(current,run['baseline']) if not run.get('scope') or o['path'] in run['scope']]
        if set(actual)-set(expected) or any(o not in actual and o[0]!='UPDATE_IMAGE' for o in expected):
            raise ValueError('Source changed after plan; make a new plan')
        for path,item in run['items'].items():
            if current_by.get(path,{}).get('files')!=item['files']:
                raise ValueError('Source changed after plan')
        self.cloud.begin(run_id,run['generation'],run['epoch']); self.state.save_run(run,'RUNNING')
        staging=self.state.path.parent/'staging'/run_id; staging.mkdir(parents=True,exist_ok=True)
        models={m['local_relative_path']:m for m in run['baseline']}
        for m in models.values():
            m['artist_name']=format_artist_name(m.get('artist_name',''))
        try:
            if run['mass_delete'] and run['baseline'] and not self.cloud.snapshots():
                raise ValueError('Mass deletion requires a completed recovery snapshot')
            for path,item in run['items'].items():
                item=copy.deepcopy(item)
                self._model_bytes=max(1,sum(f['size'] for f in item['files']));self._file_done=0
                prior={f['path']:f for f in models.get(path,{}).get('files',[])}
                if hasattr(self.blobs,'prepare_item'):self.blobs.prepare_item(item)
                for f in item['files']:
                    self.checkpoint();self._check(run)
                    if hasattr(self,'progress'):self.progress('Computing SHA-256: '+path+'/'+f['path'])
                    source=self.root/path/f['path']
                    sha=self._hash(source); f['sha256']=sha
                    if f['kind']=='model':f.update(describe(source))
                    if f['size']!=source.stat().st_size or f['mtime_ns']!=str(source.stat().st_mtime_ns):
                        raise ValueError('Source changed during upload')
                    old=prior.get(f['path'])
                    if old and old.get('sha256')==sha:
                        f['remote_id']=old['remote_id']
                    else:
                        folder='models' if f['kind']=='model' else 'originals'
                        key=f'{folder}/{item["id"]}-{hashlib.sha256(f["path"].encode()).hexdigest()[:16]}-{sha}'
                        remote=self.state.done(key)
                        if not remote:
                            self.state.journal(key,{'key':key},'UPLOADING')
                            self._active_source=source
                            if hasattr(self.blobs,'upload_verified'):
                                remote={'remote_id':self.blobs.upload_verified(source,key,sha,public=f['kind']=='model')}
                            else:remote={'remote_id':self.blobs.upload(source,key,public=f['kind']=='model')}
                            self._active_source=None
                            if hasattr(self,'progress'):self.progress('Checking source after upload: '+f['path'])
                            if self._hash(source)!=sha:
                                raise ValueError('Source changed during upload')
                            self.state.journal(key,remote)
                        f['remote_id']=remote['remote_id']
                    if f['kind']=='image':
                        f['role']=item['roles'][f['path']]
                        f['sort_order']=list(item['roles']).index(f['path'])
                        if f['role']!='ignore':
                            preview_key=f'previews/{item["id"]}-{sha}-{hashlib.sha256(self.key).hexdigest()[:12]}.bin'
                            previous=self.state.done(preview_key)
                            prefix=preview_key[:-4]
                            if not previous and old and old.get('sha256')==sha and (old.get('preview_r2_key')==preview_key or old.get('preview_r2_key','').startswith(prefix+'-')):
                                previous={k:old[k] for k in ('preview_r2_key','preview_sha256','width','height') if k in old}
                            if previous:
                                f.update(previous)
                            else:
                                encrypted=staging/(sha+'.bin')
                                prepared,status=self.state.record(preview_key)
                                if status=='GENERATED' and Path(prepared['encrypted_path']).exists() and sha256_file(Path(prepared['encrypted_path']))==prepared['preview_sha256']:
                                    encrypted=Path(prepared['encrypted_path'])
                                    width,height=prepared['width'],prepared['height']
                                else:
                                    if hasattr(self,'progress'):self.progress('Creating and encrypting preview: '+f['path'])
                                    width,height=preview(source,encrypted,self.key)
                                    self.state.journal(preview_key,{'encrypted_path':str(encrypted),'preview_sha256':sha256_file(encrypted),'width':width,'height':height},'GENERATED')
                                f['preview_sha256']=sha256_file(encrypted)
                                object_key=prefix+'-'+f['preview_sha256']+'.bin'
                                if hasattr(self,'progress'):self.progress('Uploading encrypted preview: '+f['path'])
                                f['preview_r2_key']=self.blobs.upload(encrypted,object_key)
                                f['width']=width; f['height']=height
                                self.state.journal(preview_key,{k:f[k] for k in ('preview_r2_key','preview_sha256','width','height')})
                    self._file_done+=f['size'];self._report_fraction(self._file_done/self._model_bytes)
                self.checkpoint()
                item['formats']=model_formats(item['files'])
                self.cloud.stage(run_id,item,run['generation'],run['epoch']); models[path]=item
            for op in run['operations']:
                if op['kind']=='DELETE_MODEL':
                    self._check(run)
                    self.cloud.tombstone(run_id,op['path'],run['generation'],run['epoch'])
                    self.state.journal(f'{run_id}:tombstone:{op["path"]}',op)
                    models.pop(op['path'],None)
            manifest={'schema':1,'dataset_id':run['dataset_id'],'generation':run['generation']+1,'models':list(models.values())}
            validate_manifest(manifest)
            if hasattr(self,'progress'):self.progress('Final source integrity verification')
            final_scan=scan(self.root,run['volume'])
            final_by={m['local_relative_path']:m for m in final_scan.models}
            if not final_scan.complete or set(final_by)!={m['local_relative_path'] for m in current.models}:
                raise ValueError('Source changed during sync')
            for item in models.values():
                if run.get('scope') and item['local_relative_path'] not in run['scope']:continue
                latest=final_by[item['local_relative_path']]
                expected_stats=[(f['path'],f['size'],f['mtime_ns']) for f in item['files']]
                if [(f['path'],f['size'],f['mtime_ns']) for f in latest['files']]!=expected_stats:
                    raise ValueError('Source changed during sync')
                if item['local_relative_path'] in run['items']:
                    for f in item['files']:
                        if self._hash(self.root/item['local_relative_path']/f['path'])!=f['sha256']:
                            raise ValueError('Source changed during sync')
            manifest_path=staging/'manifest.json'; manifest_path.write_bytes(canonical(manifest))
            manifest_sha=digest(manifest)
            remote=self.blobs.upload(manifest_path,f'manifests/{run_id}-{manifest_sha}.json')
            # Independent encrypted-preview backup is retained on R2 by the real adapter too.
            self.state.save_run(run,'PUBLISHING'); self._check(run)
            self.checkpoint()
            generation=self.cloud.publish(run_id,manifest,remote,manifest_sha,run['generation'],run['epoch'])
            self.state.baseline(manifest['models'],generation); self.state.save_run(run,'COMPLETED')
            # Objects referenced by immutable recovery snapshots are deliberately retained.
            # Explicit reference-aware GC is separate from publication (see docs/DEPLOY.md).
            return generation
        except Exception as exc:
            self.state.save_run(run,'FAILED'); self.state.journal(run_id,{'run_id':run_id},'FAILED',str(exc))
            raise
