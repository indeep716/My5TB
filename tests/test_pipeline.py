import copy
from pathlib import Path
import pytest
from PIL import Image
from my5tb.state import State
from my5tb.storage import LocalBlobs, LocalCloud
from my5tb.sync_engine import Engine
from my5tb.backup_restore import Recovery
from my5tb.scanner import scan
from my5tb.diff_engine import diff

@pytest.fixture
def setup(tmp_path):
    root=tmp_path/'source'; root.mkdir()
    p=root/'Realism/Artist/Media/Character/v1'
    (p/'file').mkdir(parents=True); (p/'picture').mkdir()
    (p/'file/model.blend').write_bytes(b'original model')
    Image.new('RGB',(32,32),'blue').save(p/'picture/main.png')
    Image.new('RGB',(32,32),'red').save(p/'picture/ignored.png')
    state=State(tmp_path/'state/master_state.db')
    blobs=LocalBlobs(tmp_path/'blobs')
    cloud=LocalCloud(tmp_path/'cloud.db')
    engine=Engine(root,state,blobs,cloud,b'k'*32)
    return root,p,state,blobs,cloud,engine

def publish(s):
    root,p,state,blobs,cloud,engine=s
    run=engine.plan({'Realism/Artist/Media/Character/v1': {'picture/main.png':'main','picture/ignored.png':'ignore'}})
    engine.apply(run['id'])
    return run

def test_publish_and_resume_idempotent(setup):
    run=publish(setup)
    root,p,state,blobs,cloud,engine=setup
    engine.apply(run['id'])
    assert cloud.control()['generation']==1
    assert len(cloud.baseline())==1
    assert len(list((blobs.root/'originals').iterdir()))==2
    assert engine.plan()['operations']==[]

def test_restore_byte_for_byte_and_zero_diff(setup,tmp_path):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    dest=tmp_path/'restored'
    newstate=State(tmp_path/'new/master_state.db')
    recovery=Recovery(dest,newstate,blobs,cloud)
    recovery.restore()
    assert cloud.control()['mode']=='RECOVERY_LOCKED'
    assert (dest/p.relative_to(root)/'file/model.blend').read_bytes()==b'original model'
    assert (dest/p.relative_to(root)/'picture/ignored.png').read_bytes()==(p/'picture/ignored.png').read_bytes()
    assert diff(scan(dest),newstate.models())==[]
    recovery.unlock()
    assert cloud.control()['mode']=='NORMAL'

def test_corrupt_restore_stays_locked(setup,tmp_path):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    item=cloud.baseline()[0]['files'][0]
    blobs.path(item['remote_id']).write_bytes(b'bad')
    recovery=Recovery(tmp_path/'dest',State(tmp_path/'new/db'),blobs,cloud)
    with pytest.raises(ValueError,match='hash|size'):
        recovery.restore()
    assert cloud.control()['mode']=='RECOVERY_LOCKED'
    assert not (tmp_path/'dest').exists()

def test_lock_fences_old_writer(setup):
    root,p,state,blobs,cloud,engine=setup
    run=engine.plan({'Realism/Artist/Media/Character/v1': {'picture/main.png':'main'}})
    cloud.lock('other')
    with pytest.raises(ValueError,match='locked|fenced'):
        engine.apply(run['id'])

def test_new_device_requires_recovery(setup,tmp_path):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    empty=tmp_path/'empty'; empty.mkdir()
    other=Engine(empty,State(tmp_path/'new/db'),blobs,cloud,b'k'*32)
    with pytest.raises(ValueError,match='Recovery'):
        other.plan()

def test_delete_confirmation_and_retained_snapshot(setup):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    p.rename(p.with_name('v2'))
    run=engine.plan({'Realism/Artist/Media/Character/v2': {'picture/main.png':'main'}})
    with pytest.raises(ValueError,match='confirm'):
        engine.apply(run['id'])
    engine.apply(run['id'],confirm_delete=True,confirm_mass=True)
    assert len(cloud.baseline())==1
    assert cloud.baseline()[0]['local_relative_path'].endswith('v2')
    assert len(cloud.snapshots())==2

def test_changed_source_after_plan_is_blocked(setup):
    root,p,state,blobs,cloud,engine=setup
    run=engine.plan({'Realism/Artist/Media/Character/v1': {'picture/main.png':'main'}})
    (p/'file/model.blend').write_bytes(b'changed after plan')
    with pytest.raises(ValueError,match='changed'):
        engine.apply(run['id'])
    assert cloud.control()['generation']==0

def test_source_mutation_after_transfer_blocks_publish(setup,monkeypatch):
    root,p,state,blobs,cloud,engine=setup
    run=engine.plan({'Realism/Artist/Media/Character/v1':{'picture/main.png':'main'}})
    original=cloud.stage
    def mutate(*args):
        result=original(*args)
        (p/'file/model.blend').write_bytes(b'changed late')
        return result
    monkeypatch.setattr(cloud,'stage',mutate)
    with pytest.raises(ValueError,match='changed'):
        engine.apply(run['id'])
    assert cloud.control()['generation']==0

def test_recovery_resumes_after_root_swap_before_database_commit(setup,tmp_path,monkeypatch):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    newstate=State(tmp_path/'new/db');recovery=Recovery(tmp_path/'restored',newstate,blobs,cloud)
    original=newstate.baseline
    def fail(*args):raise OSError('simulated power loss after swap')
    monkeypatch.setattr(newstate,'baseline',fail)
    with pytest.raises(OSError):recovery.restore()
    monkeypatch.setattr(newstate,'baseline',original)
    recovery.restore();recovery.unlock()
    assert cloud.control()['mode']=='NORMAL'

def test_retry_after_preview_upload_response_loss_reuses_ciphertext(setup,monkeypatch):
    root,p,state,blobs,cloud,engine=setup
    run=engine.plan({'Realism/Artist/Media/Character/v1':{'picture/main.png':'main'}})
    original=blobs.upload;lost=False
    def lose(path,key,public=False):
        nonlocal lost
        result=original(path,key,public)
        if key.startswith('previews/') and not lost:
            lost=True;raise ConnectionError('response lost')
        return result
    monkeypatch.setattr(blobs,'upload',lose)
    with pytest.raises(ConnectionError):engine.apply(run['id'])
    engine.apply(run['id'])
    for f in cloud.baseline()[0]['files']:
        if f.get('preview_r2_key'):
            from my5tb.integrity import sha256_file
            assert sha256_file(blobs.path(f['preview_r2_key']))==f['preview_sha256']

def test_missing_preview_staging_can_be_regenerated_safely(setup,monkeypatch):
    root,p,state,blobs,cloud,engine=setup
    run=engine.plan({'Realism/Artist/Media/Character/v1':{'picture/main.png':'main'}})
    original=blobs.upload;lost=False
    def lose(path,key,public=False):
        nonlocal lost
        result=original(path,key,public)
        if key.startswith('previews/') and not lost:
            lost=True;raise ConnectionError('response lost')
        return result
    monkeypatch.setattr(blobs,'upload',lose)
    with pytest.raises(ConnectionError):engine.apply(run['id'])
    import json
    for row in state.db.execute("SELECT payload FROM operations WHERE status='GENERATED'"):
        Path(json.loads(row[0])['encrypted_path']).unlink()
    engine.apply(run['id'])
    from my5tb.integrity import sha256_file
    for f in cloud.baseline()[0]['files']:
        if f.get('preview_r2_key'):assert sha256_file(blobs.path(f['preview_r2_key']))==f['preview_sha256']

def test_category_prefixed_paths_restore_with_zero_diff(setup,tmp_path):
    root,p,state,blobs,cloud,engine=setup
    (root/'Characters').mkdir();(root/'Realism').rename(root/'Characters/Realism')
    path='Characters/Realism/Artist/Media/Character/v1'
    # An unpublished empty local registration can adopt the chosen collection root.
    state.put('root',str(root/'Characters'))
    run=engine.plan({path:{'picture/main.png':'main','picture/ignored.png':'ignore'}})
    assert run['items'][path]['asset_category']=='Characters'
    engine.apply(run['id'])
    dest=tmp_path/'restore';newstate=State(tmp_path/'new/db')
    recovery=Recovery(dest,newstate,blobs,cloud);recovery.restore()
    assert (dest/path/'file/model.blend').read_bytes()==b'original model'
    assert diff(scan(dest),newstate.models())==[]
    recovery.unlock()

def test_published_root_cannot_be_silently_rebased(setup):
    publish(setup)
    root,p,state,blobs,cloud,engine=setup
    state.put('root',str(root/'Characters'))
    with pytest.raises(ValueError,match='Root changed'):engine.plan()
    assert cloud.control()['generation']==1
