import os
os.environ.setdefault('QT_QPA_PLATFORM','offscreen')
from PySide6.QtWidgets import QApplication
from PySide6.QtTest import QTest
from my5tb.ui import Window,ImageDialog
from my5tb.scanner import scan
from PIL import Image
from PySide6.QtGui import QColor,QPalette
from PySide6.QtWidgets import QLabel,QPushButton

def test_window_follows_application_palette_for_light_dark_and_live_changes(tmp_path,monkeypatch):
    config=tmp_path/'theme.toml';config.write_text(f"root = '{tmp_path}'\ndata_dir = '{tmp_path / 'state'}'\nmode = 'offline'\n",encoding='utf-8')
    monkeypatch.setattr(Window,'do_status',lambda self:None)
    app=QApplication.instance() or QApplication([])
    original=app.palette()
    window=Window(config);window.show()
    try:
        for background,text,base in [('#181818','#f0f0f0','#202020'),('#f0f0f0','#181818','#ffffff'),('#181818','#f0f0f0','#202020')]:
            palette=QPalette(original)
            for role,color in [(QPalette.Window,background),(QPalette.WindowText,text),(QPalette.Base,base),(QPalette.Text,text),(QPalette.Button,background),(QPalette.ButtonText,text)]:
                palette.setColor(role,QColor(color))
            app.setPalette(palette);app.processEvents()
            assert window.palette().color(QPalette.Window)==palette.color(QPalette.Window)
            for label in window.findChildren(QLabel):
                assert label.palette().color(QPalette.WindowText)==palette.color(QPalette.WindowText)
            for editor in (window.table,window.log,window.diff,window.status,window.root):
                assert editor.palette().color(QPalette.Base)==palette.color(QPalette.Base)
                assert editor.palette().color(QPalette.Text)==palette.color(QPalette.Text)
            for button in window.findChildren(QPushButton):
                assert button.palette().color(QPalette.Button)==palette.color(QPalette.Button)
                assert button.palette().color(QPalette.ButtonText)==palette.color(QPalette.ButtonText)
    finally:
        window.close();app.setPalette(original)

def test_gui_scans_without_blocking_event_loop(tmp_path):
    root=tmp_path/'source';p=root/'Realism/Artists/Artist/World/Character'
    (p/'file').mkdir(parents=True);(p/'picture').mkdir()
    (p/'file/model.glb').write_bytes(b'model');Image.new('RGB',(8,8)).save(p/'picture/main.png')
    config=tmp_path/'config.toml';config.write_text(f"root = '{root}'\ndata_dir = '{tmp_path / 'state'}'\nmode = 'offline'\n",encoding='utf-8')
    app=QApplication.instance() or QApplication([]);window=Window(config)
    window.do_scan()
    for _ in range(150):
        app.processEvents()
        if window.result and not window.worker.isRunning():break
        QTest.qWait(20)
    assert window.result.complete
    assert window.table.rowCount()==1
    window.do_plan()
    for _ in range(150):
        app.processEvents()
        if window.current_run and not window.worker.isRunning():break
        QTest.qWait(20)
    assert window.current_run['items']
    window.close()

def test_image_grid_decodes_avif_and_click_selects_one_main(tmp_path):
    from PySide6.QtCore import Qt
    from PySide6.QtWidgets import QListView
    app=QApplication.instance() or QApplication([])
    folder=tmp_path/'Character/picture';folder.mkdir(parents=True)
    files=[]
    for i in range(5):
        name=f'picture/{i}.avif'
        Image.new('RGB',(120,240),(i*40,80,120)).save(tmp_path/'Character'/name)
        files.append({'kind':'image','path':name})
    model={'character_name':'Character','local_relative_path':'Character','files':files}
    dialog=ImageDialog(tmp_path,model,{})
    dialog.show();app.processEvents()
    assert dialog.columns.value()==4
    assert dialog.list.viewMode()==QListView.ViewMode.IconMode
    assert all(not dialog.list.item(i).icon().isNull() for i in range(5))
    item=dialog.list.item(2)
    QTest.mouseClick(dialog.list.viewport(),Qt.MouseButton.LeftButton,pos=dialog.list.visualItemRect(item).center())
    assert dialog.isVisible()
    assert dialog.choices()[files[2]['path']]=='main'
    QTest.mouseDClick(dialog.list.viewport(),Qt.MouseButton.LeftButton,pos=dialog.list.visualItemRect(item).center())
    assert dialog.result()==dialog.DialogCode.Accepted
    assert dialog.choices()=={f['path']:('main' if i==2 else 'sub') for i,f in enumerate(files)}
    old=dialog.list.gridSize().width()
    dialog.columns.setValue(2);app.processEvents()
    assert dialog.list.gridSize().width()>old
    dialog.open_preview(item);app.processEvents()
    assert dialog.preview.isVisible()
    assert not dialog.preview.image.pixmap().isNull()
    dialog.preview.close();dialog.close()


def test_three_images_keep_five_columns_and_two_empty_slots(tmp_path):
    app=QApplication.instance() or QApplication([])
    folder=tmp_path/'Character/picture';folder.mkdir(parents=True)
    files=[]
    for i in range(3):
        path=f'picture/{i}.png'
        Image.new('RGB',(80,160)).save(tmp_path/'Character'/path)
        files.append({'kind':'image','path':path})
    dialog=ImageDialog(tmp_path,{'character_name':'Character','local_relative_path':'Character','files':files},{})
    dialog.columns.setValue(5)
    dialog.show();app.processEvents();dialog.resize_grid();QTest.qWait(100);app.processEvents()
    width=dialog.list.viewport().width()
    assert 0 <= width-dialog.list.gridSize().width()*5 < 9
    assert dialog.list.visualItemRect(dialog.list.item(0)).top()==dialog.list.visualItemRect(dialog.list.item(2)).top()
    dialog.close()


def test_upload_button_prepares_and_applies_without_manual_dry_run(tmp_path,monkeypatch):
    root=tmp_path/'source';p=root/'Realism/Artists/Artist/World/Character'
    (p/'file').mkdir(parents=True);(p/'picture').mkdir()
    (p/'file/model.glb').write_bytes(b'model');Image.new('RGB',(8,8)).save(p/'picture/main.png')
    config=tmp_path/'config.toml';config.write_text(f"root = '{root}'\ndata_dir = '{tmp_path / 'state'}'\nmode = 'offline'\n")
    monkeypatch.setattr(Window,'do_status',lambda self:None)
    from PySide6.QtWidgets import QMessageBox
    messages=[]
    monkeypatch.setattr(QMessageBox,'information',lambda parent,title,text:messages.append(text))
    app=QApplication.instance() or QApplication([]);window=Window(config)
    window.result=scan(root);window.upload_now()
    for _ in range(250):
        app.processEvents();QTest.qWait(20)
        if 'Passed: 1' in window.log.toPlainText():break
    assert 'Passed: 1' in window.log.toPlainText()
    assert window.model_progress.value()==1000
    assert window.overall_progress.value()==1000
    app.processEvents()
    assert not window.pause_button.isEnabled()
    assert messages and 'Failed: 0' in messages[-1] and 'Log:' in messages[-1]
    window.close()


def test_image_choice_survives_close_and_application_restart(tmp_path,monkeypatch):
    from types import SimpleNamespace
    from PySide6.QtCore import Qt
    import my5tb.ui as ui
    app=QApplication.instance() or QApplication([])
    folder=tmp_path/'Character/picture';folder.mkdir(parents=True)
    files=[]
    for i in range(3):
        path=f'picture/{i}.png';Image.new('RGB',(80,160)).save(tmp_path/'Character'/path)
        files.append({'kind':'image','path':path})
    config=tmp_path/'config.toml';config.write_text(f"root = '{tmp_path}'\ndata_dir = '{tmp_path / 'state'}'\nmode = 'offline'\n")
    monkeypatch.setattr(Window,'do_status',lambda self:None)
    def choose_then_close(dialog):
        dialog.columns.setValue(6)
        dialog.show();app.processEvents()
        item=dialog.list.item(1)
        QTest.mouseClick(dialog.list.viewport(),Qt.MouseButton.LeftButton,pos=dialog.list.visualItemRect(item).center())
        dialog.reject()
        return dialog.result()
    monkeypatch.setattr(ui.ImageDialog,'exec',choose_then_close)
    window=Window(config);window.result=SimpleNamespace(models=[{'character_name':'Character','local_relative_path':'Character','files':files}])
    window.table.setRowCount(1);window.table.setCurrentCell(0,0)
    window.choose_images()
    assert window.choices['Character']['picture/1.png']=='main'
    window.close()
    reopened=Window(config)
    assert reopened.grid_columns==6
    assert reopened.choices['Character']=={'picture/0.png':'sub','picture/1.png':'main','picture/2.png':'sub'}
    dialog=ImageDialog(tmp_path,window.result.models[0],reopened.choices['Character'],columns=reopened.grid_columns)
    assert dialog.columns.value()==6
    assert dialog.list.currentItem().data(Qt.ItemDataRole.UserRole)=='picture/1.png'
    dialog.close();reopened.close()

def test_grid_preview_keeps_top_and_bottom_of_portrait(tmp_path):
    from PySide6.QtCore import QRect
    from PySide6.QtGui import QImage,QPainter,QColor
    from PySide6.QtWidgets import QStyleOptionViewItem
    app=QApplication.instance() or QApplication([])
    folder=tmp_path/'Character/picture';folder.mkdir(parents=True)
    image=Image.new('RGB',(100,200),'blue')
    image.paste('red',(0,0,100,40));image.paste('lime',(0,160,100,200));image.save(folder/'image.png')
    dialog=ImageDialog(tmp_path,{'character_name':'Character','local_relative_path':'Character','files':[{'kind':'image','path':'picture/image.png'}]},{})
    target=QImage(200,230,QImage.Format.Format_ARGB32);target.fill(QColor('white'))
    option=QStyleOptionViewItem();option.rect=QRect(0,0,200,230);option.palette=app.palette()
    painter=QPainter(target)
    dialog.list.itemDelegate().paint(painter,option,dialog.list.model().index(0,0));painter.end()
    assert target.pixelColor(100,5)==QColor('red')
    assert target.pixelColor(100,195)==QColor('lime')
    assert target.pixelColor(10,100)==QColor('white')
    dialog.close()


def test_archive_and_directory_model_format_detection(tmp_path):
    import zipfile
    from my5tb.formats import describe
    from my5tb.ui import model_file_summary
    from my5tb.scanner import scan
    model_dir=tmp_path/'Characters/Realism/Artists/Artist/World/Hero'
    (model_dir/'file').mkdir(parents=True);(model_dir/'picture').mkdir()
    Image.new('RGB',(32,32),'blue').save(model_dir/'picture/main.png')
    with zipfile.ZipFile(model_dir/'file/bundle.zip','w') as archive:
        archive.writestr('Hero_rig.blend',b'BLENDER')
        archive.writestr('Hero_mesh.fbx',b'FBX')
        archive.writestr('Hero_scene.ma',b'MAYA')
        archive.writestr('readme.txt',b'ignored text')
    (model_dir/'file/preview.glb').write_bytes(b'glTF')
    info=describe(model_dir/'file/bundle.zip')
    assert info['formats']==['BLEND','FBX','MAYA']
    assert info['contents']==['Hero_mesh.fbx','Hero_rig.blend','Hero_scene.ma']
    result=scan(tmp_path)
    assert result.complete and len(result.models)==1
    summary=model_file_summary(tmp_path,result)[result.models[0]['local_relative_path']]
    assert '[BLEND/FBX/MAYA] Hero_mesh.fbx, Hero_rig.blend, Hero_scene.ma (bundle.zip)' in summary
    assert '[GLB] preview.glb' in summary


def test_window_layout_tabs_settings_sorting_and_resizable_console(tmp_path,monkeypatch):
    from PySide6.QtCore import Qt
    config=tmp_path/'config.toml';config.write_text(f"root = '{tmp_path}'\ndata_dir = '{tmp_path / 'state'}'\nmode = 'offline'\n",encoding='utf-8')
    monkeypatch.setattr(Window,'do_status',lambda self:None)
    app=QApplication.instance() or QApplication([])
    window=Window(config);window.show();app.processEvents()
    try:
        # 1. No top title or mode labels
        label_texts=[label.text() for label in window.findChildren(QLabel)]
        assert not any('COLLECTION CONTROL' in t for t in label_texts)
        assert not any('CLOUD MODE' in t or 'OFFLINE SIMULATOR' in t for t in label_texts)
        # 2. Tab titles have no numeric prefixes and include Settings
        tab_names=[window.tabs.tabText(i) for i in range(window.tabs.count())]
        assert tab_names==['Collection','Diff & journal','Recovery','System','Publication','Submission inbox','Settings']
        # 3. Collection, Publication, and Submission inbox tables have Source, Artist, World / series, Upload by, Link, Type and sorting enabled
        for table in (window.table,window.publication_panel.table,window.submission_panel.table):
            assert table.isSortingEnabled()
            headers=[table.horizontalHeaderItem(c).text() for c in range(table.columnCount())]
            for expected in ('Source','Artist','World / series','Upload by','Link','Type'):
                assert expected in headers
        # 4. Console is inside a vertical QSplitter and has no fixed 130px maximum height
        assert window.splitter.orientation()==Qt.Orientation.Vertical
        assert window.log.maximumHeight()>1000
        # 5. Current model and Overall progress bars share the same horizontal row
        assert abs(window.model_progress.mapTo(window,window.model_progress.rect().topLeft()).y()-window.overall_progress.mapTo(window,window.overall_progress.rect().topLeft()).y())<=4
        # 6. Settings persist across window restarts
        window.type_show_combo.setCurrentText('Scenes')
        window.default_columns_spin.setValue(5)
        window.console_height_spin.setValue(220)
    finally:
        window.close()
    reopened=Window(config)
    try:
        assert reopened.type_show=='Scenes'
        assert reopened.grid_columns==5
        assert reopened.console_height==220
    finally:
        reopened.close()
