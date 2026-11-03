import io
import os
from pathlib import Path
from PIL import Image, ImageOps
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

MAX_GIF_BYTES = 8 * 1024 * 1024
MAX_GIF_FRAMES = 120
MAX_GIF_DECODED_PIXELS = 32_000_000

def gif_frames(source):
    """Decode composited frames with bounded input, frame count and retained pixels.

    Check the canvas budget before loading each frame. Do not use n_frames or
    ImageSequence.Iterator: they can scan/decode an unbounded animation first.
    """
    if Path(source).stat().st_size > MAX_GIF_BYTES:
        raise ValueError('GIF exceeds the 8 MiB image limit')
    frames, durations = [], []
    pixels = 0
    try:
        with Image.open(source) as image:
            if image.format != 'GIF':
                raise ValueError('Expected GIF image')
            # GIF counts repeats after the first play; WebP counts total plays.
            repeats = image.info.get('loop')
            loop = 1 if repeats is None else (0 if repeats == 0 else repeats + 1)
            while True:
                if len(frames) >= MAX_GIF_FRAMES:
                    raise ValueError(f'GIF exceeds {MAX_GIF_FRAMES} frames')
                pixels += image.width * image.height
                if pixels > MAX_GIF_DECODED_PIXELS or max(image.size)>8192:
                    raise ValueError('GIF exceeds 32 million total decoded pixels')
                frame = image.convert('RGBA')
                frame.thumbnail((1600, 1600))
                frames.append(frame)
                durations.append(image.info.get('duration', 100))
                try:
                    image.seek(image.tell() + 1)
                except EOFError:
                    break
        return frames, durations, loop
    except Exception:
        for frame in frames:
            frame.close()
        raise

def preview(source, target, key):
    buffer=io.BytesIO()
    with Image.open(source) as image:
        is_gif=image.format=='GIF'
        if not is_gif:
            image=ImageOps.exif_transpose(image).convert('RGB')
            image.thumbnail((1600,1600))
            width,height=image.size
            image.save(buffer,'WEBP',quality=85,method=4)
    if is_gif:
        frames,durations,loop=gif_frames(source)
        try:
            width,height=frames[0].size
            # Full keyframes prevent WebP delta cropping from losing transparent
            # canvas edges when all moving content fits inside an opaque region.
            frames[0].save(buffer,'WEBP',save_all=len(frames)>1,append_images=frames[1:],
                           duration=durations,loop=0,background=(0,0,0,0),
                           kmin=1,kmax=1,quality=85,method=4)
        finally:
            for frame in frames:frame.close()
    nonce=os.urandom(12)
    # Format: 12-byte random nonce followed by AES-GCM ciphertext+tag.
    target.write_bytes(nonce+AESGCM(key).encrypt(nonce,buffer.getvalue(),None))
    return width,height

def select_roles(model, previous=None, choices=None):
    previous=previous or {}; choices=choices or {}
    paths=[f['path'] for f in model['files'] if f['kind']=='image']
    roles={p: choices.get(p, previous.get(p, 'sub' if previous else 'ignore')) for p in paths}
    if len(paths)==1:
        roles[paths[0]]='main'
    if any(role not in {'main','sub','ignore'} for role in roles.values()):
        raise ValueError('Invalid image role')
    if paths and sum(r=='main' for r in roles.values())!=1:
        raise ValueError(f'Select exactly one main image: {model["local_relative_path"]}')
    return roles
