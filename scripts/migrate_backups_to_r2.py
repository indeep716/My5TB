"""Copy all legacy private Drive backups to private R2 and verify every byte.
Does not delete Drive content. Run before removing the two legacy folders.
"""
import json
import sys
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'ingestion'))
from my5tb.runtime import settings,services
from my5tb.drive_client import BASE
from my5tb.integrity import sha256_file


def main():
    config_path=Path('data/drive-setup/cloud.toml');config=settings(config_path)
    if not all(role in config.get('drive_folders',{}) for role in ('originals','manifests')):
        print('No legacy Drive backup folders configured; R2-only storage is already enabled.');return
    state,cloud,blobs,engine,recovery=services(config)
    work=Path('data/r2-migration');work.mkdir(parents=True,exist_ok=True)
    report={'files':[],'verified':False}
    try:
        c=cloud.control()
        if c['mode']!='NORMAL' or c['active_run']:raise ValueError('Finish or cancel active uploads before migration')
        def children(folder):
            page=None
            while True:
                params={'q':"'"+folder+"' in parents and trashed=false",'fields':'nextPageToken,files(id,name,mimeType,size,sha256Checksum)','pageSize':1000}
                if page:params['pageToken']=page
                response=blobs.drive._request('GET',BASE+'/files',params=params);response.raise_for_status();payload=response.json()
                for item in payload.get('files',[]):
                    if item['mimeType']=='application/vnd.google-apps.folder':yield from children(item['id'])
                    else:yield item
                page=payload.get('nextPageToken')
                if not page:break
        files=[(role,item) for role in ('originals','manifests') for item in children(config['drive_folders'][role])]
        print('Legacy backup files:',len(files),'max bytes:',max((int(f.get('size',0)) for _,f in files),default=0),flush=True)
        for index,(role,item) in enumerate(files):
            if cloud.control()!=c:raise ValueError('Cloud changed during migration; no Drive folders removed')
            source=work/(item['id']+'.source');restored=work/(item['id']+'.verified')
            if not source.exists() or sha256_file(source)!=item.get('sha256Checksum'):
                blobs.drive.download(item['id'],source)
            sha=sha256_file(source)
            if source.stat().st_size!=int(item['size']) or sha!=item.get('sha256Checksum'):raise ValueError('Legacy file checksum mismatch')
            key=role+'/legacy-'+item['id']+'-'+sha
            blobs.r2.upload(source,key);blobs.r2.download(key,restored)
            if sha256_file(restored)!=sha:raise ValueError('R2 migration checksum mismatch')
            alias=work/'reference.json';alias.write_text(json.dumps({'key':key,'sha256':sha,'size':int(item['size'])}),encoding='utf-8')
            blobs.r2.upload(alias,'references/'+item['id']+'.json')
            report['files'].append({'id':item['id'],'key':key,'sha256':sha,'size':int(item['size'])})
            (work/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
            source.unlink();restored.unlink()
            print(f'Verified {index+1}/{len(files)}',flush=True)
        verified={}
        for snapshot in cloud.snapshots():
            target=work/'snapshot.json';blobs.r2.download(snapshot['manifest_r2_key'],target)
            if sha256_file(target)!=snapshot['manifest_sha256']:raise ValueError('Snapshot checksum mismatch')
            manifest=json.loads(target.read_bytes())
            for model in manifest['models']:
                for f in model['files']:
                    if f['kind']!='image' or f['remote_id'] in verified:continue
                    restored=work/'recovery-image.part';blobs.download(f['remote_id'],restored)
                    if sha256_file(restored)!=f['sha256'] or restored.stat().st_size!=f['size']:raise ValueError('Legacy snapshot image cannot recover from R2')
                    verified[f['remote_id']]=True;restored.unlink()
        if cloud.control()!=c:raise ValueError('Cloud changed during migration; no Drive folders removed')
        report.update(verified=True,snapshot_images_verified=len(verified),generation=c['generation'])
        (work/'report.json').write_text(json.dumps(report,indent=2),encoding='utf-8')
        # Existing snapshots keep immutable IDs; the private aliases resolve them on R2.
        text=config_path.read_text(encoding='utf-8')
        config_path.write_text('\n'.join(line for line in text.splitlines() if not line.startswith(('originals =','manifests =')))+'\n',encoding='utf-8')
        print('MIGRATION VERIFIED:',len(files),'files;',len(verified),'snapshot image references. Drive content has not been deleted.',flush=True)
    finally:state.close()
if __name__=='__main__':main()
