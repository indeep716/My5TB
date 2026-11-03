import json
import os
import re
import uuid
from pathlib import Path
from .manifest import validate_manifest, digest
from .integrity import sha256_file
from .scanner import scan
from .diff_engine import diff

def reject_linked_file(path):
    for ancestor in [path,*path.parents]:
        if ancestor.is_symlink() or ancestor.is_junction():raise ValueError('Unsafe linked recovery path')
    if path.exists() and (not path.is_file() or path.stat().st_nlink!=1):raise ValueError('Unsafe linked recovery file')

class Recovery:
    def __init__(self,root,state,blobs,cloud):
        self.root=Path(root).absolute(); self.state=state; self.blobs=blobs; self.cloud=cloud
    def restore(self):
        owner=self.state.get('recovery_owner') or str(uuid.uuid4())
        if not re.fullmatch(r'[A-Za-z0-9-]{1,80}',owner):raise ValueError('Invalid recovery session owner')
        if any(p.is_symlink() or p.is_junction() for p in [self.root,*self.root.parents]):raise ValueError('Unsafe recovery destination')
        self.state.put('recovery_owner',owner)
        control=self.cloud.lock(owner)
        self.state.put('recovery_epoch',control['lock_epoch']); self.state.put('recovery_status','RESTORING')
        try:
            snapshots=self.cloud.snapshots()
            if not snapshots:
                raise ValueError('No completed snapshot')
            snapshot=snapshots[0]
            manifest=snapshot.get('manifest')
            if manifest is None:
                temp=self.state.path.parent/'staging'/f'manifest-{owner}.part'
                reject_linked_file(temp)
                self.blobs.download('r2:'+snapshot['manifest_r2_key'] if snapshot.get('manifest_r2_key') else snapshot['manifest_drive_id'],temp)
                if sha256_file(temp)!=snapshot['manifest_sha256']:
                    temp.unlink(missing_ok=True); raise ValueError('Manifest hash mismatch')
                manifest=json.loads(temp.read_bytes())
            validate_manifest(manifest)
            if digest(manifest)!=snapshot['manifest_sha256'] or manifest['dataset_id']!=control['dataset_id'] or manifest['generation']!=control['generation']:
                raise ValueError('Snapshot hash/dataset/generation mismatch')
            # Same-volume staging guarantees atomic root rename (never overwrite a source root).
            staging=self.root.parent/f'.my5tb-recovery-{owner}'
            pending=self.state.get('pending_restore')
            swapped=bool(pending=={'root':str(self.root),'sha256':snapshot['manifest_sha256']} and self.root.exists() and not staging.exists())
            if swapped:
                staging=self.root
            for ancestor in [staging,*staging.parents]:
                if ancestor.is_symlink() or ancestor.is_junction():
                    raise ValueError('Unsafe recovery ancestor')
            staging.mkdir(parents=True,exist_ok=True)
            if staging.is_symlink() or staging.is_junction():
                raise ValueError('Unsafe staging directory')
            self.state.put('recovery_status','VERIFYING')
            for m in manifest['models']:
                for directory in ('file','picture'):
                    folder=staging/m['local_relative_path']/directory
                    for ancestor in [folder,*folder.parents]:
                        if ancestor==staging.parent:break
                        if ancestor.is_symlink() or ancestor.is_junction():raise ValueError('Unsafe recovery path')
                    folder.mkdir(parents=True,exist_ok=True)
                for f in m['files']:
                    target=staging/m['local_relative_path']/f['path']
                    # Reject pre-existing symlink/junction ancestors on resumed restores.
                    for ancestor in [target,*target.parents]:
                        if ancestor==staging.parent:
                            break
                        if ancestor.is_symlink() or ancestor.is_junction():
                            raise ValueError('Unsafe recovery path')
                    part=target.with_name(target.name+'.part')
                    for candidate in (target,part):
                        reject_linked_file(candidate)
                    if not target.exists() or sha256_file(target)!=f['sha256']:
                        self.blobs.download(f['remote_id'],part)
                        if part.stat().st_size!=f['size'] or sha256_file(part)!=f['sha256']:
                            part.unlink(missing_ok=True)
                            raise ValueError('Restored file hash/size mismatch')
                        part.replace(target)
                    os.utime(target,ns=(int(f['mtime_ns']),int(f['mtime_ns'])))
            restored=scan(staging)
            if diff(restored,manifest['models']):
                raise ValueError('Recovery zero diff verification failed')
            # Baseline is still not usable while the remote lock is held.
            if not swapped and self.root.exists():
                if any(self.root.iterdir()):
                    raise ValueError('Recovery destination must be absent or empty')
                self.root.rmdir()
            if not swapped:
                self.state.put('pending_restore',{'root':str(self.root),'sha256':snapshot['manifest_sha256']})
                staging.replace(self.root)
            self.state.put('recovery_status_before_swap','SWAPPED')
            self.state.baseline(manifest['models'],manifest['generation'])
            self.state.put('dataset_id',manifest['dataset_id']); self.state.put('device_id',str(uuid.uuid4()))
            self.state.put('volume_id',scan(self.root).volume); self.state.put('root',str(self.root))
            self.state.put('recovery_status','BASELINE_ESTABLISHED')
            return manifest
        except Exception:
            self.state.put('recovery_status','FAILED_LOCKED')
            raise
    def unlock(self):
        if self.state.get('recovery_status')!='BASELINE_ESTABLISHED':
            raise ValueError('Verified recovery baseline required')
        result=scan(self.root,self.state.get('volume_id'))
        if diff(result,self.state.models()):
            raise ValueError('Nonzero diff; recovery remains locked')
        for m in self.state.models():
            for f in m['files']:
                if sha256_file(self.root/m['local_relative_path']/f['path'])!=f['sha256']:
                    raise ValueError('Recovery hash mismatch')
        self.cloud.unlock(self.state.get('recovery_owner'),self.state.get('recovery_epoch'),self.state.get('generation'))
        self.state.put('recovery_status','NORMAL')
