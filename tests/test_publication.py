import json
import pytest
from my5tb.publication import ManagementAPI, OfflineManagement
from my5tb.storage import LocalCloud


def seed(cloud, models, generation=1):
    cloud.db.execute('INSERT INTO snapshots VALUES(?,?,?,?)', (f'run-{generation}', generation, json.dumps({'models': models}), 'hash'))
    cloud.db.commit()


def test_publication_override_survives_new_baseline_without_mutating_snapshots(tmp_path):
    cloud = LocalCloud(tmp_path / 'cloud.db')
    model = {'id': 'model-1', 'character_name': 'Model', 'local_relative_path': 'Realism/A/B/C', 'status': 'ACTIVE'}
    seed(cloud, [model])
    cloud.db.close()
    admin = OfflineManagement(tmp_path / 'cloud.db')
    assert admin.publication_items()[0]['published'] is True
    admin.set_publication(['model-1'], False)
    cloud = LocalCloud(tmp_path / 'cloud.db')
    assert cloud.baseline() == [model]
    seed(cloud, [model | {'character_name': 'Updated'}], 2)
    cloud.db.close()
    assert admin.publication_items()[0]['published'] is False
    assert admin.publication_items()[0]['title'] == 'Updated'
    admin.set_publication(['model-1'], True)
    assert admin.publication_items()[0]['published'] is True


def test_publication_rejects_unknown_ids_atomically(tmp_path):
    cloud = LocalCloud(tmp_path / 'cloud.db')
    seed(cloud, [{'id': 'known', 'character_name': 'Known', 'status': 'ACTIVE'}])
    cloud.db.close()
    admin = OfflineManagement(tmp_path / 'cloud.db')
    with pytest.raises(ValueError, match='Unknown'):
        admin.set_publication(['known', 'missing'], False)
    assert admin.publication_items()[0]['published'] is True
    with pytest.raises(ValueError):
        admin.set_publication(['known'], 'false')


def test_cloud_lists_every_publication_page_and_preserves_auth_boundary():
    api = ManagementAPI('https://api.example', 'secret')
    calls = []
    def request(method, path, body=None):
        calls.append((method, path, body))
        if 'offset=0' in path: return {'items': [{'id': 'first'}], 'total': 2}
        return {'items': [{'id': 'second'}], 'total': 2}
    api.api.request = request
    assert [m['id'] for m in api.publication_items()] == ['first', 'second']
    assert 'offset=1' in calls[1][1]
    api.set_publication(['first'], False)
    assert calls[-1] == ('POST', 'publication', {'ids': ['first'], 'published': False})
    with pytest.raises(ValueError): api.delete_submission('../outside')


def test_inbox_pagination_uses_timestamp_and_id_cursor():
    api = ManagementAPI('https://api.example', 'secret')
    calls = []
    def request(method, path, body=None):
        calls.append(path)
        if '?' not in path:
            return {'items': [{'id': 'first'}], 'next_before': {'before': 100, 'before_id': 'first'}}
        return {'items': [{'id': 'second'}], 'next_before': None}
    api.api.request = request
    assert api.submission_items() == [{'id': 'first'}, {'id': 'second'}]
    assert calls == ['submissions', 'submissions?before=100&before_id=first']


class DownloadResponse:
    ok = True
    def __init__(self, data, start, total, broken=False):
        self.data = data
        self.status_code = 206
        self.headers = {'Content-Range': f'bytes {start}-{start + len(data)-1}/{total}'}
        self.broken = broken
        self.closed = False
    def iter_content(self, chunk_size):
        yield self.data
        if self.broken: raise OSError('connection lost')
    def close(self): self.closed = True


def test_download_streams_bounded_ranges_and_replaces_only_after_success(tmp_path):
    api = ManagementAPI('https://api.example', 'secret')
    api.download_chunk_size = 3
    responses = []
    def request(method, url, **kwargs):
        assert url == 'https://api.example/api/admin/submissions/sub-1/archive'
        assert kwargs['allow_redirects'] is False
        assert kwargs['headers']['Authorization'] == 'Bearer secret'
        start, end = map(int, kwargs['headers']['Range'][6:].split('-'))
        response = DownloadResponse(b'abcdefg'[start:end+1], start, 7)
        responses.append(response)
        return response
    api.api.http.request = request
    target = tmp_path / 'model.zip'
    target.write_bytes(b'old')
    api.download_archive('sub-1', target, 7)
    assert target.read_bytes() == b'abcdefg'
    assert len(responses) == 3 and all(r.closed for r in responses)
    api.api.http.request = lambda *a, **kw: DownloadResponse(b'bad', 0, 7, broken=True)
    with pytest.raises(OSError): api.download_archive('sub-1', target, 7)
    assert target.read_bytes() == b'abcdefg'
    assert list(tmp_path.iterdir()) == [target]
