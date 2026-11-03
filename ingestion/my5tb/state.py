import json
import sqlite3
import time
from pathlib import Path

class State:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(self.path)
        self.db.execute('PRAGMA journal_mode=WAL')
        self.db.execute('PRAGMA synchronous=FULL')
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS baseline(path TEXT PRIMARY KEY,payload TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS operations(key TEXT PRIMARY KEY,payload TEXT NOT NULL,status TEXT NOT NULL,error TEXT);
        ''')
    def get(self, key, default=None):
        row = self.db.execute('SELECT value FROM settings WHERE key=?',(key,)).fetchone()
        return json.loads(row[0]) if row else default
    def put(self, key, value):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',(key,json.dumps(value)))
    def models(self):
        return [json.loads(r[0]) for r in self.db.execute('SELECT payload FROM baseline ORDER BY path')]
    def baseline(self, models, generation):
        with self.db:
            self.db.execute('DELETE FROM baseline')
            self.db.executemany('INSERT INTO baseline VALUES(?,?)',[(m['local_relative_path'],json.dumps(m)) for m in models])
            self.db.execute('INSERT OR REPLACE INTO settings VALUES(?,?)',('generation',json.dumps(generation)))
    def journal(self, key, payload, status='DONE', error=None):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO operations VALUES(?,?,?,?)',(key,json.dumps(payload),status,error))
    def done(self, key):
        row = self.db.execute('SELECT payload,status FROM operations WHERE key=?',(key,)).fetchone()
        return json.loads(row[0]) if row and row[1]=='DONE' else None
    def record(self,key):
        row=self.db.execute('SELECT payload,status FROM operations WHERE key=?',(key,)).fetchone()
        return (json.loads(row[0]),row[1]) if row else (None,None)
    def save_run(self, run, status):
        with self.db:
            self.db.execute('INSERT OR REPLACE INTO runs VALUES(?,?,?)',(run['id'],json.dumps(run),status))
    def run(self, run_id):
        row = self.db.execute('SELECT payload FROM runs WHERE id=?',(run_id,)).fetchone()
        if not row:
            raise ValueError('Unknown run')
        return json.loads(row[0])
    def run_status(self,run_id):
        row=self.db.execute('SELECT status FROM runs WHERE id=?',(run_id,)).fetchone()
        return row[0] if row else None
    def backup(self):
        target = self.path.with_name(self.path.name + f'.{time.time_ns()}.bak')
        dest = sqlite3.connect(target)
        self.db.backup(dest)
        dest.close()
        return target
    def close(self):
        self.db.close()
