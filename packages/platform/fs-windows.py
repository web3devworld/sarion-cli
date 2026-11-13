#!/usr/bin/env python3
"""Windows file tools. Lock every ancestor against rename/delete; reject reparse
points and alternate streams. No shell, network, or arbitrary process support.
Requires native qualification; no weaker fallback on an API failure.
"""
import ctypes, ctypes.wintypes as W, os, sys, json, stat, hashlib, msvcrt
from contextlib import contextmanager
K=ctypes.WinDLL('kernel32',use_last_error=True)
K.CreateFileW.argtypes=[W.LPCWSTR,W.DWORD,W.DWORD,W.LPVOID,W.DWORD,W.DWORD,W.HANDLE]
K.CreateFileW.restype=W.HANDLE
K.CloseHandle.argtypes=[W.HANDLE]
K.GetFileInformationByHandle.argtypes=[W.HANDLE,W.LPVOID]
class INFO(ctypes.Structure):
    _fields_=[('attrs',W.DWORD),('created',W.FILETIME),('accessed',W.FILETIME),('written',W.FILETIME),('volume',W.DWORD),('high',W.DWORD),('low',W.DWORD),('links',W.DWORD),('indexhigh',W.DWORD),('indexlow',W.DWORD)]
DENY={'.git','.sarion','.ssh','.aws','.gnupg','.kube','.npmrc','.netrc','.pypirc','.git-credentials','credentials.json','secrets.json','node_modules','.venv','dist','__pycache__','cli.json','providers.json'}
def parts(p):
    if not isinstance(p,str) or not p or '\\' in p or ':' in p or '\x00' in p:raise ValueError('Invalid relative path')
    a=p.split('/')
    for x in a:
        low=x.lower()
        if not x or x in ('.','..') or x.endswith((' ','.')) or low in DENY or low.startswith(('.env','id_rsa','id_ed25519')) or low.endswith(('.pem','.key','.p12','.pfx')) or low.split('.')[0] in {'con','prn','aux','nul','com1','com2','com3','com4','lpt1','lpt2','lpt3'}:raise ValueError('Protected path')
    return a
def handle(p,directory=True):
    h=K.CreateFileW(p,0x80000000,3,None,3,0x00200000|0x02000000,None)
    if h==W.HANDLE(-1).value:raise ctypes.WinError(ctypes.get_last_error())
    info=INFO()
    if not K.GetFileInformationByHandle(h,ctypes.byref(info)) or info.attrs&0x400 or (not directory and (info.attrs&0x10 or info.links!=1)):
        K.CloseHandle(h);raise ValueError('Reparse point or unsafe file')
    return h
@contextmanager
def parents(root,p,create=False):
    a=parts(p);held=[]
    try:
        drive,tail=os.path.splitdrive(root);cur=drive+os.sep
        held.append(handle(cur))
        for x in tail.strip(os.sep).split(os.sep)+a[:-1]:
            if not x:continue
            cur=os.path.join(cur,x)
            if create and not os.path.exists(cur):os.mkdir(cur)
            held.append(handle(cur))
        yield os.path.join(cur,a[-1])
    finally:
        for h in reversed(held):K.CloseHandle(h)
def read(root,p):
    with parents(root,p) as target:
        h=handle(target,False)
        try:
            fd=msvcrt.open_osfhandle(h,os.O_RDONLY|os.O_BINARY);h=None
            with os.fdopen(fd,'rb') as f:b=f.read(65537)
            if len(b)>65536 or b'\x00' in b:raise ValueError('Binary or oversized file')
            return b.decode('utf8')
        finally:
            if h is not None:K.CloseHandle(h)
def walk(root,prefix='',depth=0):
    if depth>30:return []
    out=[]
    for e in sorted(os.scandir(os.path.join(root,*prefix.rstrip('/').split('/')) if prefix else root),key=lambda e:e.name):
        p=prefix+e.name
        try:parts(p)
        except ValueError:continue
        with parents(root,p) as target:
            h=handle(target)
            try:
                if e.is_dir(follow_symlinks=False):out.extend(walk(root,p+'/',depth+1))
                elif e.is_file(follow_symlinks=False):out.append(p)
            finally:K.CloseHandle(h)
        if len(out)>10000:raise ValueError('Repository discovery limit exceeded')
    return out
def apply(root,p,before,after):
    with parents(root,p,True) as target:
        try:current=read(root,p)
        except FileNotFoundError:current=None
        except OSError as e:
            if e.winerror==2:current=None
            else:raise
        actual=None if current is None else hashlib.sha256(current.encode()).hexdigest()
        if actual!=before:raise ValueError('File hash conflict')
        if after is None:os.unlink(target)
        else:
            data=after.encode()
            if len(data)>65536:raise ValueError('Oversized patch')
            tmp=os.path.join(os.path.dirname(target),'.sarion-tmp-'+os.urandom(12).hex())
            try:
                with open(tmp,'xb') as f:f.write(data);f.flush();os.fsync(f.fileno())
                os.replace(tmp,target)
            finally:
                if os.path.exists(tmp):os.unlink(tmp)
        return {'path':p,'beforeHash':before,'afterHash':None if after is None else hashlib.sha256(after.encode()).hexdigest(),'status':'verified'}
def main():
    if sys.argv[1]=='lock':
        with open(sys.argv[2],'a+b') as f:
            if os.fstat(f.fileno()).st_size==0:f.write(b'0');f.flush()
            f.seek(0);msvcrt.locking(f.fileno(),msvcrt.LK_NBLCK,1)
            print('locked',flush=True);sys.stdin.read()
        return
    r=json.load(sys.stdin);root=os.path.abspath(r['root']);st=os.stat(root)
    if r['identity']!=str(st.st_dev)+':'+str(st.st_ino):raise ValueError('Workspace identity changed')
    op=r['op']
    if op=='read':out=read(root,r['path'])
    elif op=='list':out=walk(root)
    elif op=='validate':parts(r['path']);out=True
    elif op=='apply':out=apply(root,r['path'],r['beforeHash'],r['after'])
    elif op=='search':
        if not isinstance(r['query'],str) or not r['query'] or len(r['query'])>1000 or len(r['files'])>10000:raise ValueError('Search limit')
        hits=[];size=0
        for p in r['files']:
            try:text=read(root,p)
            except (OSError,ValueError,UnicodeError):continue
            for line,value in enumerate(text.splitlines(),1):
                if r['query'] in value:
                    excerpt=value[:500];size+=len(excerpt.encode());hits.append({'path':p,'line':line,'text':excerpt})
                if len(hits)>=200 or size>=60000:break
            if len(hits)>=200 or size>=60000:break
        out={'matches':hits,'truncated':len(hits)>=200 or size>=60000}
    else:raise ValueError('Unsupported operation')
    print(json.dumps({'ok':True,'result':out}))
try:main()
except Exception as e:print(json.dumps({'ok':False,'error':str(e)[:200]}));sys.exit(1)
