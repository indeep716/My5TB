import os
os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
from threading import Event
from PySide6.QtWidgets import QApplication
from PySide6.QtTest import QTest
from my5tb.publication_ui import ManagementPanel


def wait(app, predicate):
    for _ in range(150):
        app.processEvents()
        if predicate(): return
        QTest.qWait(10)
    assert predicate()


def test_publication_panel_pending_success_selection_and_async_failure(monkeypatch):
    import my5tb.publication_ui as module
    app = QApplication.instance() or QApplication([])
    release = Event()
    class Client:
        published = True
        calls = 0
        fail = False
        def publication_items(self):
            self.calls += 1
            release.wait(3)
            if self.fail: raise ValueError('Service unavailable')
            return [{'id': 'model-1', 'title': 'Model', 'published': self.published, 'eligible': True, 'status': 'ACTIVE', 'path': 'Characters/Model'}]
        def set_publication(self, ids, published):
            assert ids == ['model-1']
            self.published = published
    client = Client()
    monkeypatch.setattr(module, 'management_client', lambda config: client)
    panel = ManagementPanel({})
    panel.show()
    try:
        panel.refresh()
        app.processEvents()
        assert panel.is_running()
        assert 'Loading' in panel.status.text()
        assert not panel.refresh_button.isEnabled()
        panel.refresh()
        app.processEvents()
        assert client.calls == 1
        release.set()
        wait(app, lambda: not panel.is_running() and panel.table.rowCount() == 1)
        assert panel.refresh_button.isEnabled()
        panel.table.selectRow(0)
        assert all(button.isEnabled() for button in panel.action_buttons)
        panel.set_publication(False)
        wait(app, lambda: not panel.is_running() and panel.table.item(0, 1).text() == 'Hidden')
        assert 'hidden' in panel.status.text()
        panel.table.selectRow(0)
        panel.search.setText('missing')
        assert not panel.selected_items()
        assert all(not button.isEnabled() for button in panel.action_buttons)
        client.fail = True
        panel.refresh()
        wait(app, lambda: not panel.is_running() and 'Failed:' in panel.status.text())
        assert 'Service unavailable' in panel.status.text()
        assert panel.refresh_button.isEnabled()
        assert panel.search.text() == 'missing'
    finally:
        release.set()
        if panel.worker: panel.worker.wait(4000)
        panel.close()


def test_edit_details_captures_description_before_dialog_close_and_gc(monkeypatch):
    import gc
    import my5tb.publication_ui as module
    app = QApplication.instance() or QApplication([])
    saved = []
    class Client:
        def publication_items(self):
            return [{'id': 'model-1', 'title': 'Model', 'published': True, 'eligible': True, 'status': 'ACTIVE', 'path': 'Characters/Model', 'upload_by': 'Old', 'link': 'https://example.com', 'description': 'Initial'}]
        def set_details(self, item_id, upload_by, link, description):
            gc.collect()
            saved.append((item_id, upload_by, link, description))
    monkeypatch.setattr(module, 'management_client', lambda config: Client())
    monkeypatch.setattr(module.QDialog, 'exec', lambda self: module.QDialog.DialogCode.Accepted)
    panel = ManagementPanel({})
    try:
        panel.render(Client().publication_items())
        panel.table.selectRow(0)
        panel.edit_details()
        wait(app, lambda: not panel.is_running() and len(saved) == 1)
        assert saved == [('model-1', 'Old', 'https://example.com', 'Initial')]
        assert 'Model details saved.' in panel.status.text()
    finally:
        if panel.worker: panel.worker.wait(4000)
        panel.close()


def test_inbox_renders_quarantine_and_empty_states(monkeypatch):
    app = QApplication.instance() or QApplication([])
    panel = ManagementPanel({}, inbox=True)
    try:
        item = {'id': 'submission-1', 'character_name': 'Model', 'artist': 'Artist', 'source': 'Source', 'media_title': 'Game ไทย', 'archive_name': 'model.zip', 'archive_size': 20, 'image_count': 2, 'images': [{'number': 1, 'filename': 'image-1.gif'}], 'status': 'REJECTED', 'created_at': 1, 'report': {'error': 'Unsafe ZIP path'}}
        panel.render([item])
        panel.table.selectRow(0)
        assert not panel.action_buttons[0].isEnabled()
        assert panel.action_buttons[1].isEnabled()
        assert panel.action_buttons[2].isEnabled()
        assert 'Game ไทย' in panel.details.toPlainText()
        assert 'Unsafe ZIP path' in panel.details.toPlainText()
        import my5tb.publication_ui as module
        selected = []
        monkeypatch.setattr(module.QInputDialog, 'getInt', lambda *args: (1, True))
        monkeypatch.setattr(module.QFileDialog, 'getSaveFileName', lambda *args: (selected.append(args[2]) or '', ''))
        panel.download_image()
        assert selected == ['image-1.gif']
        panel.render([])
        assert not panel.details.toPlainText()
        assert 'No submissions' in panel.status.text()
        assert all(not button.isEnabled() for button in panel.action_buttons)
    finally: panel.close()
