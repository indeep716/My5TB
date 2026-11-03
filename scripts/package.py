"""Package tracked source + production frontend, excluding local data/credentials."""
import hashlib
import subprocess
import zipfile
from pathlib import Path

def main():
    root=Path(__file__).resolve().parents[1]
    if not (root/'dist/index.html').is_file():raise SystemExit('Run npm run build first')
    files=subprocess.check_output(['git','ls-files','-z'],cwd=root).decode().split('\0')
    target=root/'deliverables/My5TB-local-delivery.zip';target.parent.mkdir(exist_ok=True)
    with zipfile.ZipFile(target,'w',zipfile.ZIP_DEFLATED) as archive:
        for name in sorted(filter(None,files)):
            if any(part in {'data','.env','.dev.vars','config.toml','.git','node_modules','.venv'} for part in Path(name).parts):raise ValueError('Sensitive local file unexpectedly tracked: '+name)
            archive.write(root/name,'My5TB/'+name)
        for path in sorted((root/'dist').rglob('*')):
            if path.is_file():archive.write(path,'My5TB/'+path.relative_to(root).as_posix())
    sha=hashlib.sha256(target.read_bytes()).hexdigest();target.with_suffix('.zip.sha256').write_text(sha+'  '+target.name+'\n',encoding='ascii')
    print(str(target));print('SHA-256: '+sha)
if __name__=='__main__':main()
