import argparse
import base64
from dataclasses import asdict
import getpass
import json
import os
import sys
from pathlib import Path
from .scanner import scan
from .runtime import settings,services

def main():
    if hasattr(sys.stdout,'reconfigure'):sys.stdout.reconfigure(encoding='utf-8')
    parser=argparse.ArgumentParser(description='My5TB safe model ingestion')
    parser.add_argument('--config',default='config.toml')
    sub=parser.add_subparsers(dest='command',required=True)
    p=sub.add_parser('scan');p.add_argument('root');p.add_argument('--output')
    p=sub.add_parser('google-login');p.add_argument('--client',required=True);p.add_argument('--account',required=True)
    sub.add_parser('gui')
    p=sub.add_parser('plan');p.add_argument('--choices',help='JSON mapping model path to image role mapping')
    p=sub.add_parser('apply');p.add_argument('run_id');p.add_argument('--confirm-delete',action='store_true');p.add_argument('--confirm-mass',action='store_true')
    p=sub.add_parser('abandon');p.add_argument('run_id')
    sub.add_parser('restore');sub.add_parser('unlock');sub.add_parser('status')
    p=sub.add_parser('secret');p.add_argument('name',choices=['admin_token','google_client_id','google_client_secret','google_refresh_token','preview_key_b64'])
    args=parser.parse_args()
    if args.command=='google-login':
        from .google_auth import authorize
        account=authorize(args.client,args.account,wait_seconds=600)
        print('Verified Google Drive storage account: '+account)
        print('OAuth credentials saved in Windows Credential Manager. No files uploaded.')
        return
    if args.command=='secret':
        import keyring
        keyring.set_password('My5TB',args.name,getpass.getpass(f'{args.name}: '));print('Stored in OS credential vault. Keep an independent external backup.');return
    if args.command=='scan':
        result=scan(args.root);payload=asdict(result)|{'complete':result.complete}
        text=json.dumps(payload,ensure_ascii=False,indent=2)
        if args.output:
            Path(args.output).parent.mkdir(parents=True,exist_ok=True)
            Path(args.output).write_text(text,encoding='utf-8')
        print(json.dumps({'models':len(result.models),'errors':len(result.errors),'excluded':len(result.excluded),'complete':result.complete}))
        if not args.output:
            for error in result.errors[:30]:print(error)
        return
    if args.command=='gui':
        from .ui import launch
        launch(args.config);return
    state,cloud,blobs,engine,recovery=services(settings(args.config))
    try:
        if args.command=='plan':
            choices=json.loads(Path(args.choices).read_text(encoding='utf-8')) if args.choices else None
            run=engine.plan(choices);print(json.dumps(run,ensure_ascii=False,indent=2))
        elif args.command=='apply':print('Committed generation',engine.apply(args.run_id,args.confirm_delete,args.confirm_mass))
        elif args.command=='abandon':engine.abandon(args.run_id);print('Run abandoned; staged changes discarded, cloud objects retained. Build a new plan.')
        elif args.command=='restore':recovery.restore();print('Verified local baseline established. Cloud remains locked. Run unlock after review.')
        elif args.command=='unlock':recovery.unlock();print('Normal sync resumed.')
        elif args.command=='status':print(json.dumps(cloud.control(),indent=2))
    finally:state.close()

if __name__=='__main__':main()
