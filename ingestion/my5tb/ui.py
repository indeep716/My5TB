from .operation_lock import operation_lock
"""Desktop workflow. All filesystem/network work runs outside the GUI thread."""
import json
import ctypes
import os
from pathlib import Path
from PySide6.QtCore import Qt,QThread,Signal,QTimer,QSize
from PySide6.QtGui import QPixmap,QIcon,QPainter,QPalette,QMovie
from PIL import Image,ImageOps
from PIL.ImageQt import ImageQt
from PySide6.QtWidgets import (QApplication,QMainWindow,QWidget,QVBoxLayout,QHBoxLayout,QLabel,QLineEdit,QPushButton,QFileDialog,QTabWidget,QTableWidget,QTableWidgetItem,QTextEdit,QMessageBox,QDialog,QDialogButtonBox,QListWidget,QListWidgetItem,QComboBox,QAbstractItemView,QProgressBar,QSpinBox,QListView,QStyledItemDelegate,QInputDialog,QSplitter,QFormLayout)
from .runtime import settings,services
from .scanner import scan
from .state import State
from .transfer import TransferControl
from .formats import describe
from .publication_ui import ManagementPanel
from .images import gif_frames,MAX_GIF_DECODED_PIXELS

def model_file_summary(root,result):
    """Per model: inner model files of archives (read-only listing) or the file's own format."""
    summary={}
    for m in result.models:
        parts=[]
        for f in m['files']:
            if f['kind']!='model':continue
            info=describe(Path(root)/m['local_relative_path']/f['path'])
            fmt='/'.join(info['formats'])
            parts.append(f"[{fmt}] {', '.join(info['contents'])} ({Path(f['path']).name})" if info['contents'] else f"[{fmt}] {Path(f['path']).name}")
        summary[m['local_relative_path']]=' | '.join(parts)
    return summary

class Job(QThread):
    success=Signal(object);failure=Signal(str);message=Signal(str);percentages=Signal(dict)
    def __init__(self,task):super().__init__();self.task=task;self.control=TransferControl()
    def run(self):
        try:self.success.emit(self.task())
        except Exception as exc:self.failure.emit(str(exc))

def image_pixmap(path, size):
    """Decode AVIF as well as Qt-native formats, preserving orientation and aspect."""
    with Image.open(path) as source:
        if source.format=='GIF' and source.width*source.height>MAX_GIF_DECODED_PIXELS:
            raise ValueError('GIF exceeds 32 million total decoded pixels')
        image=ImageOps.exif_transpose(source)
        image.thumbnail((size,size))
        return QPixmap.fromImage(ImageQt(image.convert('RGBA')))

def desktop_animations_enabled():
    if os.name=='nt':
        enabled=ctypes.c_int(1)
        if ctypes.windll.user32.SystemParametersInfoW(0x1042,0,ctypes.byref(enabled),0):
            return bool(enabled.value)
    return True

class FullImageDialog(QDialog):
    def __init__(self,path,parent=None):
        super().__init__(parent);self.setWindowTitle(path.name);self.resize(1000,800)
        self.pix=image_pixmap(path,2400);self.movie=None
        layout=QVBoxLayout(self);self.image=QLabel();self.image.setAlignment(Qt.AlignmentFlag.AlignCenter)
        self.image.setMinimumSize(1,1);layout.addWidget(self.image)
        if path.suffix.lower()=='.gif':
            frames,_,_=gif_frames(path)
            animated=len(frames)>1
            for frame in frames:frame.close()
            if animated:
                self.movie=QMovie(str(path));self.movie.setCacheMode(QMovie.CacheMode.CacheNone)
                self.movie.frameChanged.connect(self.render_frame)
                self.motion_button=QPushButton('Pause animation');self.motion_button.setFixedSize(160,34)
                self.motion_button.clicked.connect(self.toggle_motion);layout.addWidget(self.motion_button)
                self.movie.finished.connect(lambda:self.motion_button.setText('Play animation'))
    def render_frame(self,*_):
        pix=self.movie.currentPixmap() if self.movie else self.pix
        if not pix.isNull():
            self.image.setPixmap(pix.scaled(self.image.size(),Qt.AspectRatioMode.KeepAspectRatio,Qt.TransformationMode.SmoothTransformation))
    def toggle_motion(self):
        if self.movie.state()==QMovie.MovieState.NotRunning:
            self.movie.start();self.motion_button.setText('Pause animation');return
        paused=self.movie.state()!=QMovie.MovieState.Paused
        self.movie.setPaused(paused);self.motion_button.setText('Play animation' if paused else 'Pause animation')
    def resizeEvent(self,event):
        super().resizeEvent(event)
        self.render_frame()
    def showEvent(self,event):
        super().showEvent(event)
        if self.movie:
            self.movie.start()
            if not desktop_animations_enabled():
                self.movie.setPaused(True);self.motion_button.setText('Play animation')
        self.render_frame()
    def closeEvent(self,event):
        if self.movie:self.movie.stop()
        super().closeEvent(event)

class ImageGrid(QListWidget):
    resized=Signal()
    def resizeEvent(self,event):
        super().resizeEvent(event)
        self.resized.emit()
    def mouseDoubleClickEvent(self,event):
        item=self.itemAt(event.position().toPoint())
        if item is not None:
            self.setCurrentItem(item)
            self.itemDoubleClicked.emit(item)
            event.accept()
        else:super().mouseDoubleClickEvent(event)

class GridImageDelegate(QStyledItemDelegate):
    def paint(self,painter,option,index):
        painter.save()
        rect=option.rect
        photo=rect.adjusted(0,0,0,-30)
        icon=index.data(Qt.ItemDataRole.DecorationRole)
        if icon and not icon.isNull():
            pix=icon.pixmap(QSize(1024,1024))
            scaled=pix.scaled(photo.size(),Qt.AspectRatioMode.KeepAspectRatio,Qt.TransformationMode.SmoothTransformation)
            painter.setClipRect(photo)
            painter.drawPixmap(photo.x()+(photo.width()-scaled.width())//2,photo.y()+(photo.height()-scaled.height())//2,scaled)
            painter.setClipping(False)
        painter.setPen(option.palette.color(QPalette.ColorRole.Text))
        painter.drawText(rect.adjusted(4,rect.height()-28,-4,0),Qt.AlignmentFlag.AlignVCenter,option.fontMetrics.elidedText(index.data(),Qt.TextElideMode.ElideMiddle,rect.width()-8))
        if str(index.data()).startswith('MAIN'):
            pen=painter.pen();pen.setColor(option.palette.color(QPalette.ColorRole.Highlight));pen.setWidth(4);painter.setPen(pen);painter.drawRect(photo.adjusted(2,2,-2,-2))
        painter.restore()

class ImageDialog(QDialog):
    rolesChanged=Signal(dict)
    columnsChanged=Signal(int)
    def __init__(self,root,model,previous,parent=None,columns=4):
        super().__init__(parent);self.setWindowTitle('Image grid · Double-click to select — '+model['character_name']);self.resize(1100,760)
        self.folder=root/model['local_relative_path'];self.roles={};self.paths={};self.preview=None
        layout=QVBoxLayout(self)
        layout.addWidget(QLabel('Click to choose Main; all other images become Sub. Choices save automatically. Double-click to confirm and close.'))
        toolbar=QHBoxLayout();toolbar.addWidget(QLabel('Grid columns (fewer = larger images)'))
        self.columns=QSpinBox();self.columns.setRange(1,8);self.columns.setValue(columns);toolbar.addWidget(self.columns);toolbar.addStretch();layout.addLayout(toolbar)
        inspect=QPushButton('Open selected image');inspect.setFixedSize(170,34)
        inspect.clicked.connect(lambda:self.open_preview(self.list.currentItem()) if self.list.currentItem() else None);toolbar.addWidget(inspect)
        self.list=ImageGrid();self.list.setViewMode(QListView.ViewMode.IconMode)
        self.list.setResizeMode(QListView.ResizeMode.Adjust);self.list.setMovement(QListView.Movement.Static)
        self.list.setSelectionMode(QAbstractItemView.SelectionMode.SingleSelection)
        self.list.setVerticalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOn);self.list.setWordWrap(True);self.list.setSpacing(0);self.list.setItemDelegate(GridImageDelegate(self.list))
        self.list.setHorizontalScrollBarPolicy(Qt.ScrollBarPolicy.ScrollBarAlwaysOff);layout.addWidget(self.list)
        for f in sorted([f for f in model['files'] if f['kind']=='image'],key=lambda f:list(previous).index(f['path']) if f['path'] in previous else 10000):
            path=f['path'];self.roles[path]=previous.get(path,'sub')
            item=QListWidgetItem();item.setData(Qt.ItemDataRole.UserRole,path)
            try:
                pix=image_pixmap(self.folder/path,1024);item.setIcon(QIcon(pix))
                item.setToolTip(path+(' — GIF poster; Open selected image to play' if Path(path).suffix.lower()=='.gif' else ' — double-click to choose Main'))
            except Exception as exc:
                item.setToolTip(path+' — preview unavailable: '+str(exc))
            self.list.addItem(item);self.paths[path]=item
        self.refresh_labels()
        self.list.itemClicked.connect(self.select_main)
        self.list.itemDoubleClicked.connect(self.confirm_main)
        for path,item in self.paths.items():
            if self.roles[path]=='main':self.list.setCurrentItem(item)
        self.columns.valueChanged.connect(self.resize_grid)
        self.columns.valueChanged.connect(self.columnsChanged.emit)
        self.list.resized.connect(lambda:QTimer.singleShot(0,self.resize_grid))
        buttons=QDialogButtonBox(QDialogButtonBox.StandardButton.Ok|QDialogButtonBox.StandardButton.Close)
        buttons.accepted.connect(self.validate);buttons.rejected.connect(self.reject);layout.addWidget(buttons)
        QTimer.singleShot(0,self.resize_grid)
    def refresh_labels(self):
        for path,item in self.paths.items():item.setText(self.roles[path].upper()+'  ·  '+Path(path).name)
    def select_main(self,item):
        selected=item.data(Qt.ItemDataRole.UserRole)
        self.roles={path:('main' if path==selected else 'sub') for path in self.roles}
        self.refresh_labels();self.list.viewport().update();self.rolesChanged.emit(self.choices())
    def confirm_main(self,item):
        self.select_main(item);self.accept()
    def open_preview(self,item):
        try:
            self.preview=FullImageDialog(self.folder/item.data(Qt.ItemDataRole.UserRole),self);self.preview.show()
        except Exception as exc:QMessageBox.warning(self,'Preview unavailable',str(exc))
    def resize_grid(self):
        columns=self.columns.value()
        width=max(1,(self.list.viewport().width()-4)//columns)
        self.list.setGridSize(QSize(width,width+30));self.list.setIconSize(QSize(max(1,width-8),max(1,width-8)))
        for item in self.paths.values():item.setSizeHint(QSize(max(1,width-8),width+22))
        self.list.doItemsLayout()
    def resizeEvent(self,event):
        super().resizeEvent(event)
        if hasattr(self,'list'):self.resize_grid()
    def choices(self):return dict(self.roles)
    def validate(self):
        if sum(v=='main' for v in self.choices().values())!=1:
            QMessageBox.warning(self,'Main image required','Click one image to choose Main.');return
        self.accept()

class Window(QMainWindow):
    def __init__(self,config_path):
        super().__init__();self.config_path=config_path;self.config=settings(config_path);self.worker=None;self.current_run=None;self.result=None;self.baseline={};self.choices={};self.recovery_only=False
        self.load_image_choices(self.config['root'])
        self.setWindowTitle('My5TB · Upload collection');self.resize(1180,800)
        central=QWidget();self.setCentralWidget(central);layout=QVBoxLayout(central)
        self.splitter=QSplitter(Qt.Orientation.Vertical);layout.addWidget(self.splitter,1)
        self.tabs=QTabWidget();self.splitter.addWidget(self.tabs)
        catalog=QWidget();cl=QVBoxLayout(catalog);self.table=QTableWidget(0,10);self.table.setHorizontalHeaderLabels(['Asset category','Model / version','Source','Artist','World / series','Upload by','Link','Type','Images','Path']);self.table.horizontalHeader().setStretchLastSection(True);self.table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows);self.table.setEditTriggers(QAbstractItemView.EditTrigger.NoEditTriggers);self.table.setSortingEnabled(True);cl.addWidget(self.table);self.table.cellDoubleClicked.connect(lambda row,column:self.choose_images())
        buttons=QHBoxLayout();self.scan_button=QPushButton('Scan collection');self.scan_button.clicked.connect(self.do_scan);buttons.addWidget(self.scan_button)
        select=QPushButton('Choose image roles');select.clicked.connect(self.choose_images);buttons.addWidget(select)
        plan=QPushButton('Upload collection now');plan.clicked.connect(self.upload_now);buttons.addWidget(plan);cl.addLayout(buttons);self.tabs.addTab(catalog,'Collection')
        diffpage=QWidget();dl=QVBoxLayout(diffpage);self.diff=QTextEdit();self.diff.setReadOnly(True);dl.addWidget(self.diff)
        row=QHBoxLayout();apply=QPushButton('Apply selected run');apply.clicked.connect(self.apply_run);row.addWidget(apply);resume=QPushButton('Load unfinished upload');resume.clicked.connect(self.resume_run);row.addWidget(resume);abandon=QPushButton('Abandon selected run');abandon.clicked.connect(self.abandon_run);row.addWidget(abandon);dl.addLayout(row);self.tabs.addTab(diffpage,'Diff & journal')
        recovery=QWidget();rl=QVBoxLayout(recovery);rl.addWidget(QLabel('Recovery locks cloud writes while public browsing remains available.\nChoose a new, empty destination in Settings. Originals are hash-verified before the atomic folder swap.\nA separate Resume Normal Sync action verifies zero diff and hashes again.'))
        restore=QPushButton('Start / resume verified restore');restore.clicked.connect(self.do_restore);rl.addWidget(restore);unlock=QPushButton('Resume Normal Sync');unlock.clicked.connect(self.do_unlock);rl.addWidget(unlock);rl.addStretch();self.tabs.addTab(recovery,'Recovery')
        statuspage=QWidget();sl=QVBoxLayout(statuspage);self.status=QTextEdit();self.status.setReadOnly(True);sl.addWidget(self.status);refresh=QPushButton('Refresh control & inventory');refresh.clicked.connect(self.do_status);sl.addWidget(refresh);reset=QPushButton('Reset all My5TB test data');reset.clicked.connect(self.reset_test_data);sl.addWidget(reset);self.tabs.addTab(statuspage,'System')
        self.publication_panel=ManagementPanel(self.config,parent=self);self.tabs.addTab(self.publication_panel,'Publication')
        self.submission_panel=ManagementPanel(self.config,inbox=True,parent=self);self.tabs.addTab(self.submission_panel,'Submission inbox')
        settings_page=QWidget();settings_layout=QVBoxLayout(settings_page);settings_form=QFormLayout();settings_layout.addLayout(settings_form)
        root_row=QHBoxLayout();self.root=QLineEdit(self.config['root']);root_row.addWidget(self.root,1);browse=QPushButton('Choose folder');browse.clicked.connect(self.choose_root);root_row.addWidget(browse)
        settings_form.addRow('Root / recovery destination',root_row)
        self.type_show_combo=QComboBox();self.type_show_combo.addItems(['All','Characters','Scenes','Motions','Plugins','Shaders','Courses']);self.type_show_combo.setCurrentText(self.type_show if self.type_show in {'All','Characters','Scenes','Motions','Plugins','Shaders','Courses'} else 'All')
        self.type_show_combo.currentTextChanged.connect(self.save_type_show);settings_form.addRow('Type show (all tabs)',self.type_show_combo)
        self.default_columns_spin=QSpinBox();self.default_columns_spin.setRange(1,8);self.default_columns_spin.setValue(self.grid_columns)
        self.default_columns_spin.valueChanged.connect(self.save_grid_columns);settings_form.addRow('Default image grid columns',self.default_columns_spin)
        self.console_height_spin=QSpinBox();self.console_height_spin.setRange(60,600);self.console_height_spin.setValue(self.console_height)
        self.console_height_spin.valueChanged.connect(self.save_console_height);settings_form.addRow('Default console height (px)',self.console_height_spin)
        settings_layout.addStretch();self.tabs.addTab(settings_page,'Settings')
        console_box=QWidget();console_layout=QVBoxLayout(console_box);console_layout.setContentsMargins(0,4,0,0)
        self.progress=QProgressBar();self.progress.hide();console_layout.addWidget(self.progress);self.log=QTextEdit();self.log.setReadOnly(True);self.log.setMinimumHeight(60);console_layout.addWidget(self.log)
        self.splitter.addWidget(console_box);self.splitter.setStretchFactor(0,1);self.splitter.setStretchFactor(1,0);self.splitter.setSizes([max(200,800-self.console_height),self.console_height])
        self.splitter.splitterMoved.connect(self.on_splitter_moved)
        progress_row=QHBoxLayout()
        left_progress=QHBoxLayout();self.model_progress_label=QLabel('Current model');left_progress.addWidget(self.model_progress_label)
        self.model_progress=QProgressBar();self.model_progress.setRange(0,1000);self.model_progress.setValue(0);self.model_progress.setFormat('%p%');left_progress.addWidget(self.model_progress,1)
        right_progress=QHBoxLayout();self.overall_label=QLabel('Overall');right_progress.addWidget(self.overall_label)
        self.overall_progress=QProgressBar();self.overall_progress.setRange(0,1000);self.overall_progress.setValue(0);self.overall_progress.setFormat('%p%');right_progress.addWidget(self.overall_progress,1)
        progress_row.addLayout(left_progress,1);progress_row.addLayout(right_progress,1);layout.addLayout(progress_row)
        controls=QHBoxLayout();self.pause_button=QPushButton('Pause');self.pause_button.setEnabled(False);self.pause_button.clicked.connect(self.toggle_pause);controls.addWidget(self.pause_button)
        self.cancel_button=QPushButton('Cancel remaining · keep uploaded');self.cancel_button.setEnabled(False);self.cancel_button.clicked.connect(self.cancel_upload);controls.addWidget(self.cancel_button);layout.addLayout(controls)
        # Keep the native Windows style/palette so light, dark and accessibility
        # theme changes update text, surfaces, selection and disabled controls together.
        self.root.setFixedHeight(32);self.root.setMinimumWidth(160)
        self.type_show_combo.setFixedHeight(32);self.default_columns_spin.setFixedHeight(32);self.console_height_spin.setFixedHeight(32)
        self.model_progress_label.setFixedHeight(22);self.model_progress_label.setMinimumWidth(120)
        self.overall_label.setFixedHeight(22);self.overall_label.setMinimumWidth(120)
        self.model_progress.setFixedHeight(22);self.overall_progress.setFixedHeight(22);self.progress.setFixedHeight(22)
        self.table.setWordWrap(False);self.table.verticalHeader().setDefaultSectionSize(28);self.table.setTextElideMode(Qt.TextElideMode.ElideRight)
        for col,width in ((0,110),(1,180),(2,95),(3,140),(4,140),(5,110),(6,150),(7,190),(8,80)):self.table.setColumnWidth(col,width)
        for button in self.findChildren(QPushButton):button.setFixedHeight(34)
        self.apply_type_show(self.type_show)
        QTimer.singleShot(0,self.do_status)
    def toggle_pause(self):
        if not self.worker or not self.worker.isRunning():return
        if self.worker.control.paused:
            self.worker.control.resume();self.pause_button.setText('Pause');self.log.append('Continuing upload')
        else:
            self.worker.control.pause();self.pause_button.setText('Continue');self.log.append('Pause requested. The current network request will finish before pausing.')
    def cancel_upload(self):
        if not self.worker or not self.worker.isRunning():return
        self.worker.control.cancel();self.pause_button.setEnabled(False);self.cancel_button.setEnabled(False)
        self.log.append('Cancel requested. Completed models and uploaded files will be kept.')
    def show_percentages(self,value):
        half_width=max(120,(self.width()-60)//4)
        self.model_progress_label.setText(self.model_progress_label.fontMetrics().elidedText('Current model: '+value['model'],Qt.TextElideMode.ElideRight,half_width))
        self.model_progress.setValue(round(value['model_percent']*10))
        self.model_progress.setFormat(f"{value['model_percent']:.1f}%")
        self.overall_label.setText(f"Overall · {value['completed']}/{value['total']} committed")
        self.overall_progress.setValue(round(value['overall_percent']*10))
        self.overall_progress.setFormat(f"{value['overall_percent']:.1f}%")
    def load_image_choices(self,root):
        self.choice_key='image_choices:'+str(Path(root).resolve()).casefold()
        state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
        try:
            saved_root=state.get('default_root')
            if saved_root and root==self.config.get('root') and Path(saved_root).exists():
                self.config['root']=saved_root
                root=saved_root
                self.choice_key='image_choices:'+str(Path(root).resolve()).casefold()
            self.choices=state.get(self.choice_key,{})
            self.grid_columns=int(state.get('grid_columns',4))
            self.type_show=str(state.get('type_show','All'))
            self.console_height=int(state.get('console_height',130))
        finally:state.close()
    def save_grid_columns(self,columns):
        state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
        try:state.put('grid_columns',int(columns));self.grid_columns=int(columns)
        finally:state.close()
        if hasattr(self,'default_columns_spin') and self.default_columns_spin.value()!=int(columns):
            self.default_columns_spin.blockSignals(True);self.default_columns_spin.setValue(int(columns));self.default_columns_spin.blockSignals(False)
    def save_type_show(self,category):
        state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
        try:state.put('type_show',str(category));self.type_show=str(category)
        finally:state.close()
        self.apply_type_show(self.type_show)
    def apply_type_show(self,category):
        self.filter_collection_rows()
        if hasattr(self,'publication_panel'):self.publication_panel.set_type_filter(category)
        if hasattr(self,'submission_panel'):self.submission_panel.set_type_filter(category)
    def filter_collection_rows(self):
        target=(self.type_show or '').strip().casefold()
        for row in range(self.table.rowCount()):
            cell=self.table.item(row,0)
            model=cell.data(Qt.ItemDataRole.UserRole) if cell else None
            cat=str((model or {}).get('asset_category') or (cell.text() if cell else 'Characters')).casefold()
            match=not target or target=='all' or cat==target
            self.table.setRowHidden(row,not match)
    def save_console_height(self,height):
        height=int(height)
        state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
        try:state.put('console_height',height);self.console_height=height
        finally:state.close()
        if hasattr(self,'splitter'):
            total=max(300,sum(self.splitter.sizes()))
            self.splitter.setSizes([max(120,total-height),height])
    def on_splitter_moved(self,*_):
        sizes=self.splitter.sizes()
        if len(sizes)==2 and sizes[1]>=60:
            self.console_height=sizes[1]
            if hasattr(self,'console_height_spin'):
                self.console_height_spin.blockSignals(True);self.console_height_spin.setValue(min(600,max(60,sizes[1])));self.console_height_spin.blockSignals(False)
            state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
            try:state.put('console_height',int(self.console_height))
            finally:state.close()
    def save_image_choices(self,path,roles):
        state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
        try:
            # Merge the individual model so another open window cannot erase other choices.
            saved=state.get(self.choice_key,{})
            saved[path]=dict(roles);state.put(self.choice_key,saved);self.choices=saved
        finally:state.close()
        for r in range(self.table.rowCount()):
            cell=self.table.item(r,0)
            model=cell.data(Qt.ItemDataRole.UserRole) if cell else None
            if model and model.get('local_relative_path')==path:
                img_cell=self.table.item(r,8)
                if img_cell:img_cell.setText(str(len(roles))+' · Main selected')
                return
        row=self.table.currentRow()
        if row>=0:
            img_cell=self.table.item(row,8) or self.table.item(row,3)
            if img_cell:img_cell.setText(str(len(roles))+' · Main selected')
    def choose_root(self):
        path=QFileDialog.getExistingDirectory(self,'Choose collection or empty recovery destination',self.root.text())
        if path:
            self.root.setText(path);self.result=None;self.current_run=None;self.load_image_choices(path)
            state=State(Path(self.config.get('data_dir','data/local'))/'master_state.db')
            try:state.put('default_root',path)
            finally:state.close()
    def execute(self,label,action,callback=None,transfer=False):
        if self.worker and self.worker.isRunning():return
        if self.publication_panel.is_running() or self.submission_panel.is_running():
            self.log.append('Wait for the publication or inbox operation to finish.');return
        config=self.config|{'root':self.root.text()}
        def task():
            with operation_lock(config.get('data_dir','data/local')):
                state,cloud,blobs,engine,recovery=services(config)
                try:
                    engine.progress=self.worker.message.emit
                    blobs.progress=self.worker.message.emit
                    engine.percentages=self.worker.percentages.emit
                    engine.transfer_control=self.worker.control
                    if hasattr(blobs,'drive'):
                        blobs.drive.progress=self.worker.message.emit
                        blobs.drive.transfer_control=self.worker.control
                        blobs.drive.transfer_progress=engine.transfer_progress
                        blobs.r2.transfer_control=self.worker.control
                    return action(state,cloud,engine,recovery)
                finally:state.close()
        self.tabs.setEnabled(False);self.root.setEnabled(False);self.progress.setRange(0,0);self.progress.show();self.log.append(label)
        self.worker=Job(task);self.worker.message.connect(self.log.append);self.worker.percentages.connect(self.show_percentages)
        self.pause_button.setText('Pause');self.pause_button.setEnabled(transfer);self.cancel_button.setEnabled(transfer)
        def success(value):
            self.log.append(label+' — done')
            if callback:callback(value)
        self.worker.success.connect(success);self.worker.failure.connect(lambda message:(self.log.append('Blocked: '+message),QMessageBox.warning(self,'Operation blocked',message)))
        def finished():
            self.tabs.setEnabled(True);self.root.setEnabled(True);self.progress.hide()
            self.pause_button.setEnabled(False);self.cancel_button.setEnabled(False)
            for index in (0,1):self.tabs.setTabEnabled(index,not self.recovery_only)
            if getattr(self,'upload_pending',False):
                self.upload_pending=False;QTimer.singleShot(0,self.apply_run)
        self.worker.finished.connect(finished);self.worker.start()
    def do_scan(self):
        root=self.root.text();self.load_image_choices(root)
        def done(value):
            self.result=value['scan'];self.baseline={m['local_relative_path']:m for m in value['baseline']}
            self.table.setSortingEnabled(False)
            self.table.setRowCount(len(self.result.models))
            for i,m in enumerate(self.result.models):
                base=self.baseline.get(m['local_relative_path'],{})
                cells=[
                    m.get('asset_category','Characters'),
                    m['character_name']+(' / '+m['version'] if m.get('version') else ''),
                    m.get('artist_category','Artists'),
                    m.get('artist_name',''),
                    m.get('media_title',''),
                    str(m.get('upload_by') or base.get('upload_by') or ''),
                    str(m.get('link') or base.get('link') or ''),
                    value['formats'].get(m['local_relative_path'],''),
                    str(sum(f['kind']=='image' for f in m['files'])),
                    m['local_relative_path']
                ]
                for j,text in enumerate(cells):
                    item=QTableWidgetItem(text)
                    if j==0:item.setData(Qt.ItemDataRole.UserRole,m)
                    self.table.setItem(i,j,item)
            self.table.setSortingEnabled(True)
            self.filter_collection_rows()
            if self.result.models:self.table.setCurrentCell(0,0)
            self.log.append(f'{len(self.result.models)} models; {len(self.result.errors)} invalid; {len(self.result.excluded)} excluded')
            for error in self.result.errors[:20]:self.log.append(error)
            if value['needs_recovery']:
                self.tabs.setCurrentIndex(2);QMessageBox.information(self,'Recovery required','Cloud data exists but this device has no baseline. Use the Recovery tab. Normal sync is blocked.')
        self.execute('Scanning (underscore directories excluded)',lambda s,c,e,r:(lambda result:{'scan':result,'formats':model_file_summary(root,result),'baseline':s.models(),'needs_recovery':s.get('device_id') is None and c.control()['generation']>0})(scan(root,s.get('volume_id'))),done)
    def choose_images(self):
        if not self.result:
            QMessageBox.information(self,'Scan required','Click Scan collection first.');return
        if not self.result.models:return
        if self.table.currentRow()<0:self.table.setCurrentCell(0,0)
        row=self.table.currentRow()
        cell=self.table.item(row,0)
        m=(cell.data(Qt.ItemDataRole.UserRole) if cell else None) or self.result.models[min(row,len(self.result.models)-1)]
        path=m['local_relative_path'];images=[f for f in m['files'] if f['kind']=='image']
        if not images:QMessageBox.information(self,'No images','This model will remain a draft.');return
        self.load_image_choices(self.root.text())
        dialog=ImageDialog(Path(self.root.text()),m,self.choices.get(path,self.baseline.get(path,{}).get('roles',{})),self,columns=self.grid_columns)
        dialog.columnsChanged.connect(self.save_grid_columns)
        dialog.rolesChanged.connect(lambda roles:self.save_image_choices(path,roles))
        if dialog.exec():
            self.save_image_choices(path,dialog.choices())
    def do_plan(self,auto_upload=False):
        if self.result:
            for i,m in enumerate(self.result.models):
                images=[f for f in m['files'] if f['kind']=='image'];prior=self.baseline.get(m['local_relative_path'],{}).get('roles',{})
                paths={f['path'] for f in images}
                if len(images)>1 and m['local_relative_path'] not in self.choices and (bool(paths-set(prior)) or not any(p in paths and role=='main' for p,role in prior.items())):
                    for r in range(self.table.rowCount()):
                        cell=self.table.item(r,0)
                        row_model=cell.data(Qt.ItemDataRole.UserRole) if cell else None
                        if row_model and row_model.get('local_relative_path')==m['local_relative_path']:
                            self.table.setCurrentCell(r,0);break
                    else:
                        self.table.setCurrentCell(min(i,max(0,self.table.rowCount()-1)),0)
                    self.choose_images()
                    if m['local_relative_path'] not in self.choices:return
        choices=json.loads(json.dumps(self.choices))
        def done(run):
            self.current_run=run;self.diff.setPlainText(json.dumps({'run_id':run['id'],'generation':run['generation'],'deletes':run['deletes'],'mass_delete':run['mass_delete'],'operations':[{'kind':o['kind'],'path':o['path']} for o in run['operations']]},indent=2,ensure_ascii=False));self.tabs.setCurrentIndex(1)
            if auto_upload:self.upload_pending=True
        self.execute('Preparing upload',lambda s,c,e,r:e.prepare_upload(choices),done)
    def upload_now(self):
        if not self.result:
            QMessageBox.information(self,'Scan required','Click Scan collection first.');return
        self.do_plan(auto_upload=True)
    def reset_test_data(self):
        text,ok=QInputDialog.getText(self,'Delete My5TB test data','Permanently delete the My5TB catalog, R2 images/manifests, and all My5TB files and subfolders inside Published_Models on Google Drive. Local source files and account credentials are kept. Type RESET MY5TB to continue:')
        if not ok or text!='RESET MY5TB':return
        from .reset import reset_cloud
        def done(_):
            self.current_run=None;self.result=None;self.baseline={};self.choices={};self.recovery_only=False
            self.table.setRowCount(0);self.diff.clear();self.log.append('My5TB reset complete: Drive files/subfolders, R2 backups and catalog cleared. Scan to start again.')
        self.execute('Resetting My5TB test data',lambda s,c,e,r:reset_cloud(s,c,e.blobs),done)
    def apply_run(self):
        if not self.current_run:return
        run=self.current_run
        if run['deletes'] and QMessageBox.question(self,'Confirm deletions',f'Hide {run["deletes"]} models and retain snapshot-referenced files for recovery?')!=QMessageBox.StandardButton.Yes:return
        if run['mass_delete'] and QMessageBox.warning(self,'Mass deletion',f'{run["deletes"]} deletions exceed the guard threshold. A completed recovery snapshot is required. Confirm again?',QMessageBox.StandardButton.Yes|QMessageBox.StandardButton.No)!=QMessageBox.StandardButton.Yes:return
        def upload(s,c,e,r):
            try:e.apply_incremental(run['id'],True,True,continue_on_error=True)
            except Exception as exc:
                report=e.upload_report(run['id'])
                raise ValueError(str(exc)+'\nUpload log: '+report['log_path']) from exc
            return e.upload_report(run['id'])
        def done(report):
            message=f"Passed: {report['passed']}\nFailed: {report['failed']}\nRemaining: {report['remaining']}\nLog: {report['log_path']}"
            self.log.append(message)
            QMessageBox.information(self,'Upload cancelled' if report['cancelled'] else 'Upload finished',message)
        self.execute('Applying / resuming journal '+run['id'],upload,done,transfer=True)
    def resume_run(self):
        def done(runs):
            if not runs:QMessageBox.information(self,'Journal','No pending runs.');return
            self.current_run=runs[0];self.diff.setPlainText(json.dumps(self.current_run,indent=2,ensure_ascii=False));self.log.append('Unfinished upload loaded. Click Apply selected run to continue; completed models will be skipped.')
        self.execute('Reading journal',lambda s,c,e,r:[json.loads(row[0]) for row in s.db.execute("SELECT payload FROM runs WHERE status NOT IN ('COMPLETED','PARTIAL','ABANDONED','CANCELLED') AND json_extract(payload,'$.parent_id') IS NULL ORDER BY rowid DESC LIMIT 1")],done)
    def abandon_run(self):
        if not self.current_run:return
        run_id=self.current_run['id']
        self.execute('Abandoning staged run '+run_id,lambda s,c,e,r:e.cancel_incremental(run_id),lambda _:self.log.append('Remaining upload cancelled. Completed models and files were kept. Scan to start a new upload.'))
    def do_restore(self):
        if QMessageBox.question(self,'Start recovery','Lock cloud writes and restore the latest completed snapshot to the destination in Settings?')!=QMessageBox.StandardButton.Yes:return
        self.execute('Restoring verified snapshot',lambda s,c,e,r:r.restore(),lambda _:self.log.append('BASELINE_ESTABLISHED — review then Resume Normal Sync'))
    def do_unlock(self):self.execute('Verifying hashes and zero diff before unlock',lambda s,c,e,r:r.unlock(),lambda _:setattr(self,'recovery_only',False))
    def do_status(self):
        def done(value):
            self.status.setPlainText(json.dumps(value,indent=2))
            self.recovery_only=value['control']['mode']!='NORMAL' or value['needs_recovery']
            if self.recovery_only:self.tabs.setCurrentIndex(2);self.log.append('Recovery required. Normal sync controls are disabled.')
        self.execute('Reading system status',lambda s,c,e,r:{'control':c.control(),'inventory':c.usage() if hasattr(c,'usage') else {'models':len(c.baseline()),'snapshots':len(c.snapshots())},'recovery':s.get('recovery_status'),'needs_recovery':s.get('device_id') is None and c.control()['generation']>0,'quota_note':'Live quota counters are available in provider consoles.'},done)
    def closeEvent(self,event):
        if (self.worker and self.worker.isRunning()) or self.publication_panel.is_running() or self.submission_panel.is_running():QMessageBox.information(self,'Operation running','Wait for the current operation to finish. Interrupted uploads can be resumed from the journal.');event.ignore()
        else:event.accept()

def launch(config_path):
    app=QApplication.instance() or QApplication([]);window=Window(config_path);window.show();app.exec()
