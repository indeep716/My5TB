import os
from pathlib import Path
import pytest
from test_pipeline import setup,publish
from my5tb.state import State
from my5tb.backup_restore import Recovery
from my5tb.scanner import scan

def test_restore_rejects_hardlinked_part_before_write(setup,tmp_path):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    restore_state=State(tmp_path/'new/db');restore_state.put('recovery_owner','known-owner')
    dest=tmp_path/'dest';staging=tmp_path/'.my5tb-recovery-known-owner'
    model=cloud.baseline()[0];f=model['files'][0]
    part=staging/model['local_relative_path']/(f['path']+'.part');part.parent.mkdir(parents=True)
    outside=tmp_path/'outside';outside.write_bytes(b'keep')
    os.link(outside,part)
    with pytest.raises(ValueError,match='Unsafe|link'):
        Recovery(dest,restore_state,blobs,cloud).restore()
    assert outside.read_bytes()==b'keep'
    assert cloud.control()['mode']=='RECOVERY_LOCKED'

def test_scanner_does_not_descend_through_linked_ancestor(tmp_path,monkeypatch):
    root=tmp_path/'parent/root';root.mkdir(parents=True)
    original=Path.is_junction
    monkeypatch.setattr(Path,'is_junction',lambda p:True if p==root.parent else original(p))
    assert not scan(root).complete

def test_linked_ancestor_is_rejected_before_volume_discovery(tmp_path,monkeypatch):
    import my5tb.scanner as scanner
    root=tmp_path/'parent/root';root.mkdir(parents=True)
    original=Path.is_junction
    monkeypatch.setattr(Path,'is_junction',lambda p:True if p==root.parent else original(p))
    def forbidden(*args):raise AssertionError('must not resolve a linked root')
    monkeypatch.setattr(scanner,'volume_id',forbidden)
    assert not scanner.scan(root).complete

def test_restore_rejects_linked_manifest_partial(setup,tmp_path,monkeypatch):
    from my5tb.manifest import canonical
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    snapshots=cloud.snapshots();manifest=snapshots[0].pop('manifest')
    source=tmp_path/'manifest.json';source.write_bytes(canonical(manifest))
    snapshots[0]['manifest_drive_id']=blobs.upload(source,'manifests/snapshot.json')
    monkeypatch.setattr(cloud,'snapshots',lambda:snapshots)
    newstate=State(tmp_path/'new/db');newstate.put('recovery_owner','known-owner')
    part=tmp_path/'new/staging/manifest-known-owner.part';part.parent.mkdir()
    outside=tmp_path/'outside';outside.write_bytes(b'keep');os.link(outside,part)
    with pytest.raises(ValueError,match='Unsafe|link'):
        Recovery(tmp_path/'dest',newstate,blobs,cloud).restore()
    assert outside.read_bytes()==b'keep'

def test_failed_run_can_be_abandoned_and_replanned(setup,monkeypatch):
    root,p,state,blobs,cloud,engine=setup
    choices={'Realism/Artist/Media/Character/v1':{'picture/main.png':'main'}}
    run=engine.plan(choices)
    original=blobs.upload
    monkeypatch.setattr(blobs,'upload',lambda *a,**kw:(_ for _ in ()).throw(ConnectionError('offline')))
    with pytest.raises(ConnectionError):engine.apply(run['id'])
    engine.abandon(run['id'])
    monkeypatch.setattr(blobs,'upload',original)
    assert engine.apply(engine.plan(choices)['id'])==1

def test_recovered_device_reuses_unchanged_verified_previews(setup,tmp_path):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    newroot=tmp_path/'restored';newstate=State(tmp_path/'new/db')
    recovery=Recovery(newroot,newstate,blobs,cloud);recovery.restore();recovery.unlock()
    from my5tb.sync_engine import Engine
    from my5tb.integrity import sha256_file
    newengine=Engine(newroot,newstate,blobs,cloud,b'k'*32)
    (newroot/p.relative_to(root)/'file/model.blend').write_bytes(b'updated after recovery')
    newengine.apply(newengine.plan()['id'])
    for f in cloud.baseline()[0]['files']:
        if f.get('preview_r2_key'):
            assert sha256_file(blobs.path(f['preview_r2_key']))==f['preview_sha256']
