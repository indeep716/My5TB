"""Filesystem cloud simulator; real adapters implement this same interface."""
import hashlib
import json
import shutil
import sqlite3
import threading
from pathlib import Path
from .contracts import safe_path
from .manifest import canonical, digest, validate_manifest

class LocalBlobs:
    def __init__(self, root):
        self.root=Path(root); self.root.mkdir(parents=True,exist_ok=True)
    def path(self, key):
        return self.root.joinpath(*safe_path(key).split('/'))
    def upload(self, path, key, public=False):
        dest=self.path(key); dest.parent.mkdir(parents=True,exist_ok=True)
        if not dest.exists():
            part=dest.with_suffix(dest.suffix+'.part')
            shutil.copyfile(path,part); part.replace(dest)
        return key
    def download(self, key, target):
        source=self.path(key); target=Path(target)
        target.parent.mkdir(parents=True,exist_ok=True)
        # Resume a local copy with the same .part semantics as the Drive adapter.
        offset=target.stat().st_size if target.exists() else 0
        if offset > source.stat().st_size:
            target.unlink(); offset=0
        with source.open('rb') as src, target.open('ab') as dst:
            src.seek(offset); shutil.copyfileobj(src,dst)
    def delete(self,key):
        self.path(key).unlink(missing_ok=True)

class LocalCloud:
    def __init__(self,path,dataset_id='models'):
        self.path=Path(path); self.path.parent.mkdir(parents=True,exist_ok=True)
        self.db=sqlite3.connect(self.path)
        self.dataset_id=dataset_id
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS control(id TEXT PRIMARY KEY,generation INTEGER,mode TEXT,lock_epoch INTEGER,lock_owner TEXT,active_run TEXT);
        CREATE TABLE IF NOT EXISTS snapshots(id TEXT PRIMARY KEY,generation INTEGER UNIQUE,payload TEXT,sha256 TEXT);
        CREATE TABLE IF NOT EXISTS staged(run TEXT,path TEXT,payload TEXT,PRIMARY KEY(run,path));
        CREATE TABLE IF NOT EXISTS completed(run TEXT PRIMARY KEY,generation INTEGER);
        CREATE TABLE IF NOT EXISTS tombstones(path TEXT PRIMARY KEY);
        ''')
        self.db.execute('INSERT OR IGNORE INTO control VALUES(?,0,\'NORMAL\',0,NULL,NULL)',(dataset_id,)); self.db.commit()
    def control(self):
        row=self.db.execute('SELECT generation,mode,lock_epoch,lock_owner,active_run FROM control WHERE id=?',(self.dataset_id,)).fetchone()
        return dict(zip(('generation','mode','lock_epoch','lock_owner','active_run'),row)) | {'dataset_id':self.dataset_id}
    def _guard(self,generation,epoch,run=None):
        c=self.control()
        if c['mode']!='NORMAL' or c['generation']!=generation or c['lock_epoch']!=epoch or (run and c['active_run']!=run):
            raise ValueError('Cloud locked or stale writer fenced')
    def completed(self,run):
        row=self.db.execute('SELECT generation FROM completed WHERE run=?',(run,)).fetchone()
        return row[0] if row else None
    def begin(self,run,generation,epoch):
        with self.db:
            self._guard(generation,epoch)
            if self.control()['active_run'] not in (None,run):
                raise ValueError('Another sync run owns cloud')
            self.db.execute('UPDATE control SET active_run=? WHERE id=?',(run,self.dataset_id))
    def stage(self,run,item,generation,epoch):
        with self.db:
            self._guard(generation,epoch,run)
            self.db.execute('INSERT OR REPLACE INTO staged VALUES(?,?,?)',(run,item['local_relative_path'],json.dumps(item)))
    def abandon(self,run,generation,epoch):
        with self.db:
            self._guard(generation,epoch,run)
            self.db.execute('DELETE FROM staged WHERE run=?',(run,))
            self.db.execute('DELETE FROM tombstones')
            self.db.execute('UPDATE control SET active_run=NULL WHERE id=?',(self.dataset_id,))
    def tombstone(self,run,path,generation,epoch):
        with self.db:
            self._guard(generation,epoch,run)
            self.db.execute('INSERT OR IGNORE INTO tombstones VALUES(?)',(path,))
    def publish(self,run,manifest,manifest_remote_id,manifest_sha256,generation,epoch):
        if self.completed(run) is not None:
            return self.completed(run)
        validate_manifest(manifest)
        if manifest['generation']!=generation+1 or digest(manifest)!=manifest_sha256:
            raise ValueError('Invalid snapshot')
        with self.db:
            self._guard(generation,epoch,run)
            self.db.execute('INSERT INTO snapshots VALUES(?,?,?,?)',(run,generation+1,json.dumps(manifest),manifest_sha256))
            self.db.execute('INSERT INTO completed VALUES(?,?)',(run,generation+1))
            self.db.execute('UPDATE control SET generation=?,active_run=NULL WHERE id=?',(generation+1,self.dataset_id))
            self.db.execute('DELETE FROM staged WHERE run=?',(run,))
            self.db.execute('DELETE FROM tombstones')
        return generation+1
    def baseline(self):
        rows=self.db.execute('SELECT payload FROM snapshots ORDER BY generation DESC LIMIT 1').fetchone()
        return json.loads(rows[0])['models'] if rows else []
    def snapshots(self):
        return [{'id':r[0],'generation':r[1],'manifest':json.loads(r[2]),'manifest_sha256':r[3],'completed':1} for r in self.db.execute('SELECT id,generation,payload,sha256 FROM snapshots ORDER BY generation DESC')]
    def lock(self,owner):
        with self.db:
            c=self.control()
            if c['mode']=='RECOVERY_LOCKED' and c['lock_owner']!=owner:
                raise ValueError('Recovery owned by another session')
            if c['mode']=='NORMAL':
                self.db.execute("UPDATE control SET mode='RECOVERY_LOCKED',lock_owner=?,lock_epoch=lock_epoch+1,active_run=NULL WHERE id=?",(owner,self.dataset_id))
        return self.control()
    def unlock(self,owner,epoch,generation):
        with self.db:
            c=self.control()
            if c['mode']!='RECOVERY_LOCKED' or c['lock_owner']!=owner or c['lock_epoch']!=epoch or c['generation']!=generation:
                raise ValueError('Recovery lock mismatch')
            self.db.execute("UPDATE control SET mode='NORMAL',lock_owner=NULL,lock_epoch=lock_epoch+1 WHERE id=?",(self.dataset_id,))
            self.db.execute('DELETE FROM tombstones')
