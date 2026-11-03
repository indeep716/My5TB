import base64
import tomllib
from pathlib import Path
from .state import State
from .storage import LocalBlobs,LocalCloud
from .credentials import secret,preview_key
from .cloud_api_client import CloudAPI
from .drive_client import DriveClient
from .r2_client import R2Client,CloudBlobs
from .sync_engine import Engine
from .backup_restore import Recovery

def settings(path):
    config=tomllib.loads(Path(path).read_text(encoding='utf-8'))
    if config.get('mode','offline') not in ('offline','cloud'):raise ValueError('Mode must be offline or cloud')
    return config

def services(config):
    data=Path(config.get('data_dir','data/local'));state=State(data/'master_state.db')
    if config.get('mode','offline')=='offline':
        cloud=LocalCloud(data.parent/'offline-cloud/cloud.db');blobs=LocalBlobs(data.parent/'offline-cloud/blobs')
        # Fixed fixture key is exclusively for offline generated examples.
        key=b'My5TB-offline-example-key-32bytes!'
        key=key[:32]
    else:
        cloud=CloudAPI(config['api_url'],secret('admin_token'))
        drive=DriveClient(state,secret('google_client_id'),secret('google_client_secret'),secret('google_refresh_token'))
        blobs=CloudBlobs(drive,R2Client(cloud),config['drive_folders']);key=preview_key()
    root=Path(config['root'])
    return state,cloud,blobs,Engine(root,state,blobs,cloud,key),Recovery(root,state,blobs,cloud)
