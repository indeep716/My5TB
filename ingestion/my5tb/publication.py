"""Independent publication preferences and private inbox access; never touches Drive."""
import os
import re
import tempfile
from pathlib import Path
from .cloud_api_client import CloudAPI
from .credentials import secret
from .storage import LocalCloud


def valid_id(value):
    if not isinstance(value, str) or not re.fullmatch(r'[a-zA-Z0-9-]{1,80}', value):
        raise ValueError('Invalid model or submission id')
    return value


def publication_selection(ids, published):
    if type(published) is not bool or not isinstance(ids, list) or not 1 <= len(ids) <= 200:
        raise ValueError('Select 1–200 models and a publication state')
    return list(dict.fromkeys(valid_id(value) for value in ids))


class ManagementAPI:
    download_chunk_size = 16 * 1024 * 1024

    def __init__(self, base_url, token):
        self.api = CloudAPI(base_url, token)

    def publication_items(self):
        items = []
        while True:
            page = self.api.request('GET', f'publication?limit=200&offset={len(items)}')
            rows = page['items']
            items.extend(rows)
            if len(items) >= page['total']: return items
            if not rows: raise ValueError('Catalog changed while loading; refresh to try again')

    def set_details(self, item_id, upload_by, link, description):
        return self.api.request('POST', 'publication/details', {'id': valid_id(item_id), 'upload_by': upload_by, 'link': link, 'description': description})

    def set_publication(self, ids, published):
        ids = publication_selection(ids, published)
        return self.api.request('POST', 'publication', {'ids': ids, 'published': published})

    def submission_items(self):
        from urllib.parse import urlencode
        items, query = [], ''
        while True:
            page = self.api.request('GET', 'submissions' + query)
            items.extend(page['items'])
            cursor = page.get('next_before')
            if not cursor: return items
            if not isinstance(cursor, dict) or not isinstance(cursor.get('before'), int) or not isinstance(cursor.get('before_id'), str):
                raise ValueError('Invalid inbox cursor; refresh to try again')
            next_query = '?' + urlencode({'before': cursor['before'], 'before_id': valid_id(cursor['before_id'])})
            if next_query == query: raise ValueError('Inbox pagination did not advance; refresh to try again')
            query = next_query

    def delete_submission(self, item_id):
        return self.api.request('POST', f'submissions/{valid_id(item_id)}/delete', {})

    def download_archive(self, item_id, target, size):
        if type(size) is not int or size < 1: raise ValueError('Invalid archive size')
        return self._download(f'submissions/{valid_id(item_id)}/archive', target, size)

    def download_image(self, item_id, index, target):
        if type(index) is not int or not 1 <= index <= 20: raise ValueError('Invalid image index')
        return self._download(f'submissions/{valid_id(item_id)}/images/{index}', target)

    def _download(self, route, target, size=None):
        target = Path(target)
        handle, part = tempfile.mkstemp(prefix='.my5tb-download-', suffix='.part', dir=target.parent)
        try:
            with os.fdopen(handle, 'wb') as output:
                offset = 0
                while size is None or offset < size:
                    headers = {'Authorization': 'Bearer ' + self.api.token}
                    end = min(size - 1, offset + self.download_chunk_size - 1) if size is not None else None
                    if end is not None: headers['Range'] = f'bytes={offset}-{end}'
                    response = self.api.http.request('GET', self.api.base + '/api/admin/' + route, headers=headers, stream=True, allow_redirects=False)
                    try:
                        if size is not None:
                            expected = f'bytes {offset}-{end}/{size}'
                            if response.status_code != 206 or response.headers.get('Content-Range') != expected:
                                raise ValueError(f'Download rejected or range mismatch (HTTP {response.status_code})')
                        elif response.status_code != 200:
                            raise ValueError(f'Download failed (HTTP {response.status_code})')
                        received = 0
                        for chunk in response.iter_content(chunk_size=256 * 1024):
                            if not chunk: continue
                            received += len(chunk)
                            if received > (end - offset + 1 if end is not None else 32 * 1024 * 1024):
                                raise ValueError('Download exceeds the expected size')
                            output.write(chunk)
                        if end is not None and received != end - offset + 1:
                            raise ValueError('Incomplete download; try again')
                        offset += received
                    finally: response.close()
                    if size is None: break
            os.replace(part, target)
            return str(target)
        finally:
            Path(part).unlink(missing_ok=True)


class OfflineManagement:
    """Simulator publication preferences stay separate from the snapshot baseline."""
    def __init__(self, path): self.path = path

    def _open(self):
        cloud = LocalCloud(self.path)
        cloud.db.execute('CREATE TABLE IF NOT EXISTS publication_overrides(content_id TEXT PRIMARY KEY,published INTEGER NOT NULL CHECK(published IN (0,1)))')
        cloud.db.execute('CREATE TABLE IF NOT EXISTS model_details(content_id TEXT PRIMARY KEY,payload TEXT NOT NULL)')
        cloud.db.commit()
        return cloud

    def publication_items(self):
        cloud = self._open()
        try:
            import json
            details = {key: json.loads(value) for key, value in cloud.db.execute('SELECT content_id,payload FROM model_details')}
            overrides = dict(cloud.db.execute('SELECT content_id,published FROM publication_overrides'))
            from .contracts import format_artist_name
            from .formats import model_formats
            return [{**details.get(m['id'], {}), 'id': m['id'], 'asset_category': m.get('asset_category', 'Characters'), 'title': m['character_name'] + (' / ' + m['version'] if m.get('version') else ''), 'source': m.get('artist_category', 'Artists'), 'artist': format_artist_name(m.get('artist_name', '')), 'artist_name': format_artist_name(m.get('artist_name', '')), 'media_title': m.get('media_title', ''), 'upload_by': details.get(m['id'], {}).get('upload_by', ''), 'link': details.get(m['id'], {}).get('link', ''), 'description': details.get(m['id'], {}).get('description', ''), 'formats': m.get('formats') or model_formats(m.get('files', [])), 'type': '/'.join(m.get('formats') or model_formats(m.get('files', []))), 'path': m.get('local_relative_path',''), 'status': m['status'], 'published': bool(overrides.get(m['id'], 1)), 'eligible': m['status'] == 'ACTIVE'} for m in cloud.baseline()]
        finally: cloud.db.close()

    def set_details(self, item_id, upload_by, link, description):
        import json
        from urllib.parse import urlsplit
        valid_id(item_id)
        for value, limit in [(upload_by, 200), (link, 2000), (description, 10000)]:
            if not isinstance(value, str) or len(value) > limit: raise ValueError('Invalid model details')
        if link:
            url = urlsplit(link)
            if url.scheme not in {'http', 'https'} or not url.hostname or url.username or url.password: raise ValueError('Use an HTTP or HTTPS link without credentials')
        cloud = self._open()
        try:
            if item_id not in {m['id'] for m in cloud.baseline()}: raise ValueError('Unknown model id')
            cloud.db.execute('CREATE TABLE IF NOT EXISTS model_details(content_id TEXT PRIMARY KEY,payload TEXT NOT NULL)')
            cloud.db.execute('INSERT OR REPLACE INTO model_details VALUES(?,?)', (item_id, json.dumps({'upload_by': upload_by.strip(), 'link': link.strip(), 'description': description.strip()})))
            cloud.db.commit()
        finally: cloud.db.close()
        return {'ok': True}

    def set_publication(self, ids, published):
        ids = publication_selection(ids, published)
        cloud = self._open()
        try:
            known = {m['id'] for m in cloud.baseline()}
            if not set(ids) <= known: raise ValueError('Unknown model id; no publication changes applied')
            with cloud.db:
                cloud.db.executemany('INSERT INTO publication_overrides VALUES(?,?) ON CONFLICT(content_id) DO UPDATE SET published=excluded.published', [(item_id, int(published)) for item_id in ids])
            return {'updated': len(ids), 'published': published}
        finally: cloud.db.close()

    def submission_items(self): return []


def management_client(config):
    if config.get('mode', 'offline') == 'cloud': return ManagementAPI(config['api_url'], secret('admin_token'))
    return OfflineManagement(Path(config.get('data_dir', 'data/local')).parent / 'offline-cloud/cloud.db')
