import io

import pytest
from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from PIL import Image

from my5tb import images
from my5tb.scanner import scan


def animated_gif(path, size=(20, 10)):
    frames = [Image.new('RGBA', size, (0, 0, 0, 0)) for _ in range(2)]
    frames[0].paste('red', (2, 2, 8, 8))
    frames[1].paste('blue', (2, 2, 8, 8))
    frames[0].save(path, 'GIF', save_all=True, append_images=frames[1:],
                   duration=[80, 170], loop=2, disposal=2, transparency=0)


def test_gif_scan_and_roles(tmp_path):
    folder = tmp_path / 'Characters/Realism/Artists/Artist/World/Hero'
    (folder / 'file').mkdir(parents=True)
    (folder / 'picture').mkdir()
    (folder / 'file/model.glb').write_bytes(b'glTF')
    animated_gif(folder / 'picture/turntable.GIF')
    result = scan(tmp_path)
    assert result.complete, result.errors
    model = result.models[0]
    assert images.select_roles(model) == {'picture/turntable.GIF': 'main'}


def test_encrypted_gif_preview_preserves_animation_timing_loop_and_alpha(tmp_path):
    source = tmp_path / 'turntable.gif'
    target = tmp_path / 'preview.enc'
    animated_gif(source)
    key = b'k' * 32
    assert images.preview(source, target, key) == (20, 10)
    encrypted = target.read_bytes()
    plain = AESGCM(key).decrypt(encrypted[:12], encrypted[12:], None)
    with Image.open(io.BytesIO(plain)) as result:
        assert result.format == 'WEBP'
        assert result.n_frames == 2
        assert result.info['loop'] == 0  # Display previews always loop indefinitely.
        colors, durations = [], []
        for i in range(result.n_frames):
            result.seek(i)
            result.load()
            durations.append(result.info['duration'])
            colors.append(result.convert('RGBA').getpixel((4, 4)))
            assert result.convert('RGBA').getpixel((0, 0))[3] == 0
        assert durations == [80, 170]
        assert colors[0][0] > colors[0][2]
        assert colors[1][2] > colors[1][0]


@pytest.mark.parametrize('limit,value,message', [
    ('MAX_GIF_BYTES', 10, '8 MiB'),
    ('MAX_GIF_FRAMES', 1, 'frames'),
    ('MAX_GIF_DECODED_PIXELS', 300, 'decoded pixels'),
])
def test_gif_limits_reject_before_writing_preview(tmp_path, monkeypatch, limit, value, message):
    source = tmp_path / 'turntable.gif'
    target = tmp_path / 'preview.enc'
    animated_gif(source)
    monkeypatch.setattr(images, limit, value)
    with pytest.raises(ValueError, match=message):
        images.preview(source, target, b'k' * 32)
    assert not target.exists()


def test_gif_preview_resizes_every_frame(tmp_path):
    source = tmp_path / 'wide.gif'
    target = tmp_path / 'preview.enc'
    animated_gif(source, (1800, 20))
    assert images.preview(source, target, b'k' * 32) == (1600, 18)
    data = target.read_bytes()
    with Image.open(io.BytesIO(AESGCM(b'k' * 32).decrypt(data[:12], data[12:], None))) as image:
        assert image.n_frames == 2
        for i in range(2):
            image.seek(i)
            assert image.size == (1600, 18)


def test_desktop_gif_inspection_animates_and_can_pause(tmp_path, monkeypatch):
    import os
    os.environ.setdefault('QT_QPA_PLATFORM', 'offscreen')
    from PySide6.QtTest import QTest
    from PySide6.QtWidgets import QApplication
    from PySide6.QtGui import QMovie
    from my5tb import ui
    monkeypatch.setattr(ui, 'desktop_animations_enabled', lambda: True)
    app = QApplication.instance() or QApplication([])
    path = tmp_path / 'turntable.gif'
    animated_gif(path)
    dialog = ui.FullImageDialog(path)
    dialog.show()
    app.processEvents()
    try:
        assert dialog.movie.state() == QMovie.MovieState.Running
        QTest.qWait(100)
        assert dialog.movie.currentFrameNumber() == 1
        dialog.motion_button.click()
        assert dialog.movie.state() == QMovie.MovieState.Paused
        assert dialog.motion_button.text() == 'Play animation'
        dialog.motion_button.click()
        assert dialog.movie.state() == QMovie.MovieState.Running
    finally:
        dialog.close()
