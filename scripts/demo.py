"""Generate original procedural GLB studies and serve a read-only local demo.
Never reads E:/3D/Characters. Preview encryption uses the real ingestion engine.
"""
import argparse
import base64
import hashlib
import json
import math
import mimetypes
import struct
import sys
from http.server import ThreadingHTTPServer,BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlparse,parse_qs,unquote
from PIL import Image,ImageDraw,ImageFilter

REPO=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(REPO/'ingestion'))
from my5tb.runtime import services
from my5tb.contracts import safe_path

def mesh(index):
    vertices=[];faces=[];n=48;m=24
    for i in range(n):
        u=2*math.pi*i/n
        for j in range(m):
            v=2*math.pi*j/m
            if index%3==0:
                r=.77+.28*math.cos(v);x=r*math.cos(u);y=.28*math.sin(v);z=r*math.sin(u)
                # The tilted torus is itself the authored 3D sample.
                y,z=y*.75-z*.66,y*.66+z*.75
            elif index%3==1:
                r=.58*(1+.16*math.cos(5*u)*math.sin(v));x=r*math.cos(u)*math.sin(v);y=.95*math.cos(v);z=r*math.sin(u)*math.sin(v)
            else:
                r=.55+.18*math.cos(3*u+v);x=r*math.cos(u);y=.8*math.sin(v);z=r*math.sin(u)
            vertices.append((x,y,z))
    for i in range(n):
        for j in range(m):
            a=i*m+j;b=((i+1)%n)*m+j;c=((i+1)%n)*m+(j+1)%m;d=i*m+(j+1)%m
            faces.extend([(a,b,c),(a,c,d)])
    return vertices,faces

def glb(path,vertices,faces,index):
    positions=b''.join(struct.pack('<fff',*v) for v in vertices)
    indices=b''.join(struct.pack('<HHH',*f) for f in faces)
    blob=positions+indices;blob+=b'\0'*((-len(blob))%4)
    color=[.35,.62,.95,1] if index%2==0 else [.7,.78,.9,1]
    value={'asset':{'version':'2.0','generator':'My5TB procedural demo'},'scene':0,'scenes':[{'nodes':[0]}],'nodes':[{'mesh':0}],
      'meshes':[{'primitives':[{'attributes':{'POSITION':0},'indices':1,'material':0}]}],
      'materials':[{'pbrMetallicRoughness':{'baseColorFactor':color,'metallicFactor':.35,'roughnessFactor':.4},'doubleSided':True}],
      'buffers':[{'byteLength':len(blob)}],'bufferViews':[{'buffer':0,'byteOffset':0,'byteLength':len(positions),'target':34962},{'buffer':0,'byteOffset':len(positions),'byteLength':len(indices),'target':34963}],
      'accessors':[{'bufferView':0,'componentType':5126,'count':len(vertices),'type':'VEC3','min':[min(v[k] for v in vertices) for k in range(3)],'max':[max(v[k] for v in vertices) for k in range(3)]},{'bufferView':1,'componentType':5123,'count':len(faces)*3,'type':'SCALAR'}]}
    text=json.dumps(value,separators=(',',':')).encode();text+=b' '*((-len(text))%4)
    path.write_bytes(struct.pack('<III',0x46546c67,2,12+8+len(text)+8+len(blob))+struct.pack('<II',len(text),0x4e4f534a)+text+struct.pack('<II',len(blob),0x004e4942)+blob)

def render(path,vertices,faces,index,angle=0):
    size=720;bg=(224,234,247) if index%2==0 else (231,236,243)
    image=Image.new('RGB',(size,size),bg);draw=ImageDraw.Draw(image)
    for x in range(0,size,60):draw.line((x,0,x,size),fill=tuple(max(0,c-6) for c in bg))
    for y in range(0,size,60):draw.line((0,y,size,y),fill=tuple(max(0,c-6) for c in bg))
    shadow=Image.new('RGBA',(size,size));sd=ImageDraw.Draw(shadow);sd.ellipse((145,490,580,575),fill=(37,69,116,55));shadow=shadow.filter(ImageFilter.GaussianBlur(22));image.paste(shadow,(0,0),shadow)
    transformed=[]
    for x,y,z in vertices:
        a=.52+angle;x,z=x*math.cos(a)-z*math.sin(a),x*math.sin(a)+z*math.cos(a)
        a=.25;y,z=y*math.cos(a)-z*math.sin(a),y*math.sin(a)+z*math.cos(a)
        transformed.append((x,y,z))
    for face in sorted(faces,key=lambda f:sum(transformed[i][2] for i in f)):
        a,b,c=[transformed[i] for i in face]
        ab=[b[k]-a[k] for k in range(3)];ac=[c[k]-a[k] for k in range(3)]
        normal=(ab[1]*ac[2]-ab[2]*ac[1],ab[2]*ac[0]-ab[0]*ac[2],ab[0]*ac[1]-ab[1]*ac[0]);length=math.sqrt(sum(x*x for x in normal)) or 1
        shade=.52+.48*abs((normal[0]*-.5+normal[1]*.7+normal[2]*.5)/length)
        base=(89,154,233) if index%2==0 else (148,170,200)
        color=tuple(min(255,int(c*shade+55)) for c in base)
        coords=[(size/2+v[0]*205,size/2-v[1]*205) for v in (a,b,c)]
        draw.polygon(coords,fill=color)
        if index in (0,3,5):draw.line(coords+[coords[0]],fill=tuple(max(0,c-18) for c in color),width=1)
    image.save(path)

def prepare():
    data=REPO/'data/demo';root=data/'source';root.mkdir(parents=True,exist_ok=True)
    names=['Orbital Study','Celestial Form','Ribbon No. 03','Lunar Loop','Soft Monument','Continuum']
    for index,name in enumerate(names):
        p=root/('Stylized' if index%2==0 else 'Realism')/'Artists'/'My5TB Studio'/'Spatial Studies'/name
        (p/'file').mkdir(parents=True,exist_ok=True);(p/'picture').mkdir(exist_ok=True)
        if not (p/'file'/f'{name}.glb').exists():
            vertices,faces=mesh(index);glb(p/'file'/f'{name}.glb',vertices,faces,index)
            render(p/'picture'/'main.png',vertices,faces,index)
            render(p/'picture'/'detail.png',vertices,faces,index,1.0)
    config={'root':str(root),'data_dir':str(data/'local'),'mode':'offline'}
    state,cloud,blobs,engine,recovery=services(config)
    if not cloud.baseline():
        from my5tb.scanner import scan
        choices={m['local_relative_path']:{'picture/main.png':'main','picture/detail.png':'sub'} for m in scan(root).models}
        engine.apply(engine.plan(choices)['id'])
    models=cloud.baseline();state.close()
    # Snapshot in-memory public projection: original/private-image IDs never reach the browser.
    import time
    now=int(time.time())
    items=[]
    for idx,m in enumerate(models):
        mfiles=[{'filename':Path(f['path']).name,'size':f['size'],'sha256':f['sha256'],'formats':f.get('formats',['GLB']),'contents':f.get('contents',[]),'url':'/demo-download/'+f['remote_id']} for f in m['files'] if f['kind']=='model']
        mformats=sorted({fmt for f in mfiles for fmt in f['formats']})
        items.append({'id':m['id'],'slug':m['id'],'title':m['character_name'],'asset_category':m.get('asset_category','Characters'),'style':m['style'],'artist_category':m['artist_category'],'artist_name':m['artist_name'],'media_title':m['media_title'],'character_name':m['character_name'],'version':m.get('version',''),
          'created_at':now-idx*2*86400,'formats':mformats,'files':mfiles,
          'images':[{'key':f['preview_r2_key'],'sha256':f['preview_sha256'],'role':f['role'],'width':f['width'],'height':f['height']} for f in sorted(m['files'],key=lambda f:0 if f.get('role')=='main' else 1) if f['kind']=='image' and f.get('role')!='ignore']})
    return items,blobs

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8787);parser.add_argument('--prepare-only',action='store_true');args=parser.parse_args()
    items,blobs=prepare()
    if args.prepare_only:print(f'Prepared {len(items)} original demo models');return
    class Handler(BaseHTTPRequestHandler):
        def send(self,value,status=200,mime='application/json'):
            data=json.dumps(value,ensure_ascii=False).encode() if mime=='application/json' else value
            self.send_response(status);self.send_header('Content-Type',mime);self.send_header('Content-Length',str(len(data)));self.send_header('X-Robots-Tag','noindex, nofollow, noarchive, nosnippet');self.send_header('Cache-Control','no-store');self.end_headers();self.wfile.write(data)
        def do_GET(self):
            url=urlparse(self.path);path=url.path;params=parse_qs(url.query)
            if path=='/api/preview-key':return self.send({'key':base64.b64encode(b'My5TB-offline-example-key-32bytes!'[:32]).decode()})
            if path=='/api/facets':return self.send({k:sorted({m[k] for m in items}) for k in ('asset_category','style','artist_category','artist_name','media_title')}|{'format':sorted({fmt for m in items for fmt in m.get('formats',[])})})
            if path=='/api/sections':return self.send([{'id':'models','title':'Models','route':'/models','enabled':1}])
            if path=='/api/models':
                result=items
                for k in ('asset_category','style','artist_category','artist_name','media_title'):
                    if params.get(k):result=[m for m in result if m[k]==params[k][0]]
                if params.get('format'):result=[m for m in result if params['format'][0].upper() in m.get('formats',[])]
                if params.get('q'):
                    q=params['q'][0].casefold();result=[m for m in result if q in ' '.join(str(m[k]) for k in ('title','artist_name','media_title')).casefold()]
                limit=15;max_page=max(1,(len(result)+limit-1)//limit);page=min(max(1,int(params.get('page',['1'])[0])),max_page);return self.send({'items':result[(page-1)*limit:page*limit],'total':len(result),'page':page,'limit':limit,'demo':True})
            if path.startswith('/api/models/'):
                m=next((m for m in items if m['id']==path.split('/')[-1]),None);return self.send(m if m else {'error':'Not found'},200 if m else 404)
            if path.startswith('/api/assets/'):
                key=unquote(path[len('/api/assets/'):])
                if not any(i['key']==key for m in items for i in m['images']):return self.send({'error':'Not found'},404)
                return self.send(blobs.path(key).read_bytes(),mime='application/octet-stream')
            if path.startswith('/demo-download/'):
                key=unquote(path[len('/demo-download/'):])
                # Only public model file keys are downloadable; originals/manifests are private.
                if not any(f['url']=='/demo-download/'+key for m in items for f in m['files']):return self.send({'error':'Not found'},404)
                return self.send(blobs.path(key).read_bytes(),mime='model/gltf-binary')
            if path.startswith('/api/'):return self.send({'error':'Not found'},404)
            requested=REPO/'dist'/path.lstrip('/')
            if not requested.resolve().is_relative_to((REPO/'dist').resolve()):return self.send({'error':'Not found'},404)
            if not requested.is_file():requested=REPO/'dist/index.html'
            if not requested.exists():return self.send({'error':'Run npm run build first'},503)
            return self.send(requested.read_bytes(),mime=mimetypes.guess_type(requested.name)[0] or 'application/octet-stream')
        def log_message(self,*args):pass
    print(f'My5TB local demo: http://127.0.0.1:{args.port}',flush=True)
    ThreadingHTTPServer(('127.0.0.1',args.port),Handler).serve_forever()
if __name__=='__main__':main()
