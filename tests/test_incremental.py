import threading
import time
import pytest
from PIL import Image
from my5tb.sync_engine import Engine
from my5tb.state import State
from my5tb.storage import LocalCloud,LocalBlobs
from my5tb.transfer import TransferControl,UploadCancelled


def setup_queue(tmp_path):
    root=tmp_path/'source'
    for name in ('A','B'):
        p=root/('Realism/Artists/Artist/World/'+name)
        (p/'file').mkdir(parents=True);(p/'picture').mkdir()
        (p/'file/model.blend').write_bytes(name.encode()*32)
        Image.new('RGB',(16,16),'blue').save(p/'picture/main.png')
    state=State(tmp_path/'state/db');cloud=LocalCloud(tmp_path/'cloud.db');blobs=LocalBlobs(tmp_path/'blobs')
    engine=Engine(root,state,blobs,cloud,b'k'*32);engine.transfer_control=TransferControl()
    return state,cloud,blobs,engine,engine.plan()


def test_models_are_published_individually_and_cancel_keeps_first(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    events=[]
    def progress(value):
        events.append(value)
        if value['completed']==1:
            assert len(cloud.baseline())==1
            assert len(cloud.snapshots())==1
            engine.transfer_control.cancel()
    engine.percentages=progress
    assert engine.apply_incremental(run['id'])==1
    assert state.run_status(run['id'])=='CANCELLED'
    assert len(cloud.baseline())==1
    assert cloud.control()['active_run'] is None
    assert events[-1]['overall_percent']==50
    assert events[-1]['model_percent']==100
    assert len(list((blobs.root/'models').iterdir()))==1
    assert len(engine.plan()['items'])==1


def test_failure_on_second_model_resumes_without_republishing_first(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    original=blobs.upload;failed=False
    def upload(path,key,public=False):
        nonlocal failed
        if path.name=='model.blend' and path.read_bytes().startswith(b'B') and not failed:
            failed=True;raise ConnectionError('disconnect')
        return original(path,key,public)
    blobs.upload=upload
    with pytest.raises(ConnectionError):engine.apply_incremental(run['id'])
    assert len(cloud.baseline())==1
    assert state.run_status(run['id'])=='FAILED'
    engine=Engine(engine.root,state,blobs,cloud,b'k'*32)
    assert engine.apply_incremental(run['id'])==2
    assert len(cloud.baseline())==2
    assert len(cloud.snapshots())==2
    assert engine.apply_incremental(run['id'])==2
    assert len(cloud.snapshots())==2


def test_cancel_in_second_model_retains_uploaded_blob_and_releases_writer(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    original=blobs.upload
    def upload(path,key,public=False):
        result=original(path,key,public)
        if path.name=='model.blend' and path.read_bytes().startswith(b'B'):engine.transfer_control.cancel()
        return result
    blobs.upload=upload
    assert engine.apply_incremental(run['id'])==1
    assert len(cloud.baseline())==1
    assert len(list((blobs.root/'models').iterdir()))==2
    assert cloud.control()['active_run'] is None


def test_pause_continue_and_cancel_wake_waiting_transfer():
    control=TransferControl();control.pause();passed=threading.Event()
    worker=threading.Thread(target=lambda:(control.checkpoint(),passed.set()))
    worker.start();assert not passed.wait(.05)
    control.resume();worker.join(1);assert passed.is_set()
    control.pause();control.cancel()
    with pytest.raises(UploadCancelled):control.checkpoint()


def test_byte_progress_stays_below_100_until_model_committed(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    events=[];engine.percentages=events.append
    original=blobs.upload
    def upload(path,key,public=False):
        if path.name=='model.blend':
            engine.transfer_progress(path,path.stat().st_size//2,path.stat().st_size)
            assert events[-1]['model_percent']<100
            assert events[-1]['completed']==len(cloud.baseline())
        return original(path,key,public)
    blobs.upload=upload
    assert engine.apply_incremental(run['id'])==2
    assert events[-1]['overall_percent']==100
    assert events[-1]['completed']==2

def test_lost_publish_response_recovers_committed_model_without_duplicate(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    original=cloud.publish;failed=False
    def publish(*args):
        nonlocal failed
        result=original(*args)
        if not failed:
            failed=True;raise ConnectionError('lost publish response')
        return result
    cloud.publish=publish
    with pytest.raises(ConnectionError):engine.apply_incremental(run['id'])
    assert len(cloud.baseline())==1
    assert engine.apply_incremental(run['id'])==2
    assert len(cloud.snapshots())==2


def test_incremental_update_keeps_future_model_change_for_later_commit(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    engine.apply_incremental(run['id'])
    for file in engine.root.rglob('*.blend'):file.write_bytes(b'updated')
    run=engine.plan()
    seen=[]
    engine.progress=lambda text:seen.append(len(cloud.baseline())) if text.startswith('Published ') else None
    assert engine.apply_incremental(run['id'])==4
    assert seen==[2,2]
    assert len(cloud.snapshots())==4


def test_dormant_failed_queue_can_be_cancelled_without_losing_published_model(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    original=blobs.upload
    def upload(path,key,public=False):
        if path.name=='model.blend' and path.read_bytes().startswith(b'B'):raise ConnectionError('offline')
        return original(path,key,public)
    blobs.upload=upload
    with pytest.raises(ConnectionError):engine.apply_incremental(run['id'])
    engine.cancel_incremental(run['id'])
    assert cloud.control()['active_run'] is None
    assert len(cloud.baseline())==1
    assert state.run_status(run['id'])=='CANCELLED'

def test_new_plan_cannot_overlap_an_active_child_upload(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    cloud.begin(run['id'],run['generation'],run['epoch'])
    before=state.db.execute('SELECT COUNT(*) FROM runs').fetchone()[0]
    with pytest.raises(ValueError,match='Unfinished upload'):engine.plan()
    assert state.db.execute('SELECT COUNT(*) FROM runs').fetchone()[0]==before
    assert cloud.control()['active_run']==run['id']


def test_batch_continues_after_failure_and_next_plan_retries_only_failed(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    original=blobs.upload
    def upload(path,key,public=False):
        if path.name=='model.blend' and path.read_bytes().startswith(b'A'):raise ConnectionError('fixture failure')
        return original(path,key,public)
    blobs.upload=upload
    engine.apply_incremental(run['id'],continue_on_error=True)
    report=engine.upload_report(run['id'])
    assert (report['passed'],report['failed'],report['remaining'])==(1,1,0)
    assert cloud.control()['active_run'] is None
    assert len(cloud.baseline())==1
    assert cloud.baseline()[0]['character_name']=='B'
    assert len(engine.prepare_upload()['items'])==1
    assert __import__('pathlib').Path(report['log_path']).exists()


def test_prepare_upload_releases_known_interrupted_writer(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    original=blobs.upload
    def fail(*args,**kwargs):raise ConnectionError('offline')
    blobs.upload=fail
    with pytest.raises(ConnectionError):engine.apply_incremental(run['id'])
    assert cloud.control()['active_run']
    fresh=engine.prepare_upload()
    assert cloud.control()['active_run'] is None
    assert len(fresh['items'])==2


def test_desktop_operation_lock_excludes_second_writer(tmp_path):
    from my5tb.operation_lock import operation_lock
    with operation_lock(tmp_path):
        with pytest.raises(ValueError,match='Another My5TB'):
            with operation_lock(tmp_path):pass
    with operation_lock(tmp_path):pass


def test_replaying_old_completed_child_preserves_current_generation(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    engine.apply_incremental(run['id'])
    parent=state.run(run['id']);first=parent['units'][0]['id']
    assert cloud.completed(first)==1
    assert engine.apply(first)==1
    assert state.get('generation')==cloud.control()['generation']==2
    assert not engine.plan()['operations']


def test_completed_reconciliation_rejects_generation_race(tmp_path):
    state,cloud,blobs,engine,run=setup_queue(tmp_path)
    engine.apply_incremental(run['id'])
    first=state.run(run['id'])['units'][0]['id'];state.put('generation',0)
    original=cloud.control;counter=0
    def changing():
        nonlocal counter
        result=original();counter+=1;result['generation']+=counter
        return result
    cloud.control=changing
    with pytest.raises(ValueError,match='changed during reconciliation'):engine.apply(first)
    assert state.get('generation')==0
