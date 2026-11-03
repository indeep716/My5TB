"""Desktop catalog publication and quarantined submission controls."""
from pathlib import Path
from PySide6.QtCore import Qt, QThread, Signal
from PySide6.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QLabel, QLineEdit,
    QTableWidget, QTableWidgetItem, QPushButton, QAbstractItemView, QFileDialog,
    QMessageBox, QInputDialog, QPlainTextEdit, QDialog, QDialogButtonBox)
from .publication import management_client


class ManagementJob(QThread):
    success = Signal(object)
    failure = Signal(str)

    def __init__(self, action, parent=None):
        super().__init__(parent)
        self.action = action

    def run(self):
        try: self.success.emit(self.action())
        except Exception as exc: self.failure.emit(str(exc))


class ManagementPanel(QWidget):
    def __init__(self, config, inbox=False, parent=None):
        super().__init__(parent)
        self.config, self.inbox, self.worker, self.items = config, inbox, None, []
        layout = QVBoxLayout(self)
        note = ('Private submissions remain separate from the public catalog. Download for manual review or delete from the inbox.'
                if inbox else 'Hide or show catalog models without removing uploaded files. Future collection uploads preserve this setting.')
        description = QLabel(note)
        description.setFixedHeight(36)
        description.setWordWrap(True)
        layout.addWidget(description)
        self.search = QLineEdit()
        self.search.setPlaceholderText('Filter submissions by name, artist, source or world' if inbox else 'Filter published catalog by name, artist, source, world, type or path')
        self.search.setFixedHeight(32)
        self.search.textChanged.connect(self.filter_rows)
        layout.addWidget(self.search)
        headers = (['Model', 'Source', 'Artist', 'World / series', 'Upload by', 'Link', 'Type', 'Archive', 'Status', 'Received']
                   if inbox else
                   ['Model / version', 'Publication', 'Catalog status', 'Source', 'Artist', 'World / series', 'Upload by', 'Link', 'Type', 'Path'])
        self.table = QTableWidget(0, len(headers))
        self.table.setHorizontalHeaderLabels(headers)
        self.table.horizontalHeader().setStretchLastSection(True)
        self.table.setSortingEnabled(True)
        self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
        self.table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection if not inbox else QAbstractItemView.SelectionMode.SingleSelection)
        self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers)
        self.table.setWordWrap(False)
        self.table.verticalHeader().setDefaultSectionSize(28)
        self.table.verticalHeader().setMinimumSectionSize(28)
        self.table.setTextElideMode(Qt.TextElideMode.ElideRight)
        widths = ([160, 95, 130, 140, 110, 150, 90, 160, 90] if inbox else [180, 90, 120, 95, 130, 140, 110, 150, 90])
        for col, width in enumerate(widths): self.table.setColumnWidth(col, width)
        self.table.itemSelectionChanged.connect(self.update_actions)
        layout.addWidget(self.table)
        if inbox:
            self.details = QPlainTextEdit()
            self.details.setReadOnly(True)
            self.details.setFixedHeight(150)
            self.details.setAccessibleName('Submission details and archive inspection report')
            self.details.setPlaceholderText('Select a submission to inspect its metadata, validation report and largest files.')
            layout.addWidget(self.details)
        self.status = QLabel('Click Refresh to load the private inbox.' if inbox else 'Click Refresh to load all catalog models, including hidden models.')
        self.status.setFixedHeight(44)
        self.status.setWordWrap(True)
        self.status.setAccessibleName('Submission inbox status' if inbox else 'Publication status')
        layout.addWidget(self.status)
        controls = QHBoxLayout()
        self.refresh_button = QPushButton('Refresh inbox' if inbox else 'Refresh catalog')
        self.refresh_button.clicked.connect(self.refresh)
        controls.addWidget(self.refresh_button)
        self.action_buttons = []
        if inbox:
            for title, action in [('Download archive', self.download_archive), ('Download image', self.download_image), ('Delete submission', self.delete_submission)]:
                button = QPushButton(title)
                button.clicked.connect(action)
                controls.addWidget(button)
                self.action_buttons.append(button)
        else:
            for title, published in [('Hide selected', False), ('Show selected', True)]:
                button = QPushButton(title)
                button.clicked.connect(lambda checked=False, state=published: self.set_publication(state))
                controls.addWidget(button)
                self.action_buttons.append(button)
        for button in [self.refresh_button, *self.action_buttons]: button.setFixedSize(164, 34)
        if not inbox:
            self.edit_button = QPushButton('Edit model details')
            self.edit_button.setFixedSize(164, 34)
            self.edit_button.clicked.connect(self.edit_details)
            controls.addWidget(self.edit_button)
            self.action_buttons.append(self.edit_button)
        controls.addStretch()
        layout.addLayout(controls)
        self.update_actions()

    def is_running(self): return self.worker is not None and self.worker.isRunning()

    def selected_items(self):
        selected = []
        for index in self.table.selectionModel().selectedRows():
            if self.table.isRowHidden(index.row()): continue
            cell = self.table.item(index.row(), 0)
            item = cell.data(Qt.ItemDataRole.UserRole) if cell is not None else None
            selected.append(item if isinstance(item, dict) else self.items[index.row()])
        return selected

    def update_actions(self):
        selected, idle = self.selected_items(), not self.is_running()
        for button in self.action_buttons: button.setEnabled(bool(selected) and idle)
        self.refresh_button.setEnabled(idle)
        if self.inbox and selected:
            self.action_buttons[0].setEnabled(idle and selected[0]['status'] == 'READY')
            self.action_buttons[1].setEnabled(idle and selected[0].get('image_count', 0) > 0)
        if self.inbox and hasattr(self, 'details'):
            import json
            item = selected[0] if selected else None
            self.details.setPlainText(json.dumps({key: item.get(key) for key in ('source', 'artist', 'media_title', 'character_name', 'archive_name', 'archive_size', 'upload_by', 'link', 'description', 'status', 'report')}, ensure_ascii=False, indent=2) if item else '')

    def filter_rows(self):
        query = self.search.text().strip().casefold()
        category = getattr(self, 'type_filter', 'All')
        for row in range(self.table.rowCount()):
            cell0 = self.table.item(row, 0)
            item = cell0.data(Qt.ItemDataRole.UserRole) if cell0 is not None else {}
            item_cat = (item.get('asset_category') or 'Characters') if isinstance(item, dict) else 'Characters'
            cat_match = category in ('', 'All') or item_cat.casefold() == category.casefold()
            text = ' '.join((self.table.item(row, col).text() if self.table.item(row, col) else '') for col in range(self.table.columnCount()))
            self.table.setRowHidden(row, (not cat_match) or (query not in text.casefold()))
        self.update_actions()

    def set_type_filter(self, category):
        self.type_filter = category or 'All'
        self.filter_rows()

    def run(self, pending, action, success):
        if self.is_running(): return
        self.status.setText(pending)
        self.table.setEnabled(False)
        self.worker = ManagementJob(lambda: action(management_client(self.config)), self)
        self.worker.success.connect(success)
        self.worker.failure.connect(lambda message: self.status.setText('Failed: ' + message + ' · Retry with Refresh or repeat the action.'))
        self.worker.finished.connect(self.finished)
        self.worker.start()
        self.update_actions()

    def finished(self):
        self.table.setEnabled(True)
        self.update_actions()

    def render(self, items, message=None):
        from datetime import datetime
        self.items = items
        sorting = self.table.isSortingEnabled()
        self.table.setSortingEnabled(False)
        self.table.clearSelection()
        self.table.setRowCount(len(items))
        for row, item in enumerate(items):
            if self.inbox:
                received = datetime.fromtimestamp(item['created_at']).strftime('%Y-%m-%d %H:%M')
                report = item.get('report') if isinstance(item.get('report'), dict) else {}
                formats = report.get('formats') or ([Path(item.get('archive_name', '')).suffix.lstrip('.').upper()] if item.get('archive_name') else [])
                fmt_text = '/'.join(str(f) for f in formats if f)
                values = [item.get('character_name', ''), item.get('source', ''), item.get('artist', ''), item.get('media_title', ''), item.get('upload_by', ''), item.get('link', ''), fmt_text, item.get('archive_name', ''), item.get('status', ''), received]
            else:
                parts = str(item.get('path', '')).split('/')
                style_idx = 0 if parts and parts[0] in {'Stylized', 'Realism'} else 1
                has_src = len(parts) > style_idx + 1 and parts[style_idx + 1] in {'Artists', 'Official', 'RIP'}
                offset = style_idx + (2 if has_src else 1)
                source = item.get('source') or (parts[style_idx + 1] if has_src else ('Artists' if len(parts) > style_idx else ''))
                artist = item.get('artist') or item.get('artist_name') or (parts[offset] if len(parts) > offset else '')
                world = item.get('media_title') or (parts[offset + 1] if len(parts) > offset + 1 else '')
                formats = item.get('formats') or ([item['type']] if item.get('type') else [])
                fmt_text = item.get('type') or '/'.join(str(f) for f in formats if f)
                values = [item.get('title', ''), 'Shown' if item.get('published') else 'Hidden', item.get('status', '') + ('' if item.get('eligible') else ' · not public'), source, artist, world, item.get('upload_by', ''), item.get('link', ''), fmt_text, item.get('path', '')]
            for col, text in enumerate(values):
                cell = QTableWidgetItem(str(text))
                cell.setToolTip(str(text))
                if col == 0:
                    cell.setData(Qt.ItemDataRole.UserRole, item)
                self.table.setItem(row, col, cell)
        self.table.setSortingEnabled(sorting)
        self.filter_rows()
        empty = 'No submissions in the inbox.' if self.inbox else 'No catalog models yet. Upload the collection first.'
        summary = (f'{len(items)} submissions · Select a row to review or delete.' if self.inbox else f'{len(items)} catalog models · Select rows to hide or show.') if items else empty
        self.status.setText((message + ' ' + empty) if message and not items else message or summary)

    def refresh(self):
        self.run('Loading private submissions…' if self.inbox else 'Loading catalog publication states…',
                 lambda client: client.submission_items() if self.inbox else client.publication_items(), self.render)

    def set_publication(self, published):
        selected = self.selected_items()
        if not selected: return
        if len(selected) > 200:
            self.status.setText('Select up to 200 models per publication change.')
            return
        ids = [item['id'] for item in selected]
        def change(client):
            client.set_publication(ids, published)
            return client.publication_items()
        self.run('Showing selected models…' if published else 'Hiding selected models…', change,
                 lambda items: self.render(items, f'{len(ids)} models ' + ('shown.' if published else 'hidden.')))

    def edit_details(self):
        selected = self.selected_items()
        if len(selected) != 1:
            self.status.setText('Select exactly one published model to edit its details.')
            return
        item = selected[0]
        dialog = QDialog(self)
        dialog.setWindowTitle('Optional model details')
        dialog.resize(560, 430)
        layout = QVBoxLayout(dialog)
        inputs = []
        for label, key, limit in [('Upload by', 'upload_by', 200), ('Link (HTTP / HTTPS)', 'link', 2000)]:
            layout.addWidget(QLabel(label))
            field = QLineEdit(item.get(key, ''))
            field.setMaxLength(limit)
            layout.addWidget(field)
            inputs.append(field)
        layout.addWidget(QLabel('Description (optional, up to 10000 characters)'))
        description = QPlainTextEdit(item.get('description', ''))
        layout.addWidget(description)
        buttons = QDialogButtonBox(QDialogButtonBox.StandardButton.Save | QDialogButtonBox.StandardButton.Cancel)
        buttons.accepted.connect(dialog.accept)
        buttons.rejected.connect(dialog.reject)
        layout.addWidget(buttons)
        if dialog.exec() != QDialog.DialogCode.Accepted: return
        desc_text = description.toPlainText()
        if len(desc_text) > 10000:
            self.status.setText('Description must contain 10000 characters or fewer.')
            return
        values = [field.text().strip() for field in inputs]
        def save(client):
            client.set_details(item['id'], *values, desc_text)
            return client.publication_items()
        self.run('Saving model details…', save, lambda items: self.render(items, 'Model details saved.'))

    def download_archive(self):
        selected = self.selected_items()
        if not selected: return
        item = selected[0]
        filename = item['archive_name'].replace('\\', '/').split('/')[-1]
        target, _ = QFileDialog.getSaveFileName(self, 'Save submitted archive for manual review', filename, 'Model archives (*.zip *.rar *.7z)')
        if not target: return
        self.run('Downloading private archive…', lambda client: client.download_archive(item['id'], target, item['archive_size']),
                 lambda path: self.status.setText('Archive saved: ' + path + ' · Review manually before adding to your collection.'))

    def download_image(self):
        selected = self.selected_items()
        if not selected: return
        item = selected[0]
        index, ok = QInputDialog.getInt(self, 'Choose submitted image', 'Image number', 1, 1, item['image_count'])
        if not ok: return
        image = next((value for value in item.get('images', []) if value['number'] == index), {})
        filename = Path(image.get('filename', f"{item['id']}-image-{index}")).name
        target, _ = QFileDialog.getSaveFileName(self, 'Save submitted image', filename, 'Images (*.png *.jpg *.jpeg *.webp *.gif);;All files (*)')
        if not target: return
        self.run('Downloading private image…', lambda client: client.download_image(item['id'], index, target),
                 lambda path: self.status.setText('Image saved: ' + path))

    def delete_submission(self):
        selected = self.selected_items()
        if not selected: return
        item = selected[0]
        if QMessageBox.question(self, 'Delete private submission', f"Permanently delete {item['character_name']} and its submitted archive/images from the inbox? This cannot be undone.") != QMessageBox.StandardButton.Yes: return
        def remove(client):
            client.delete_submission(item['id'])
            return client.submission_items()
        self.run('Deleting private submission…', remove, lambda items: self.render(items, 'Submission deleted.'))
