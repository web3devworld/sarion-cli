#!/usr/bin/env python3
"""Descriptor-relative, no-follow regular-file access. No shell or network.
A pinned root descriptor and each parent descriptor avoid symlink substitution.
All mutations use CAS and rename into the checked parent. Linux reference helper.
"""
import os,sys,json,hashlib,stat,fnmatch,fcntl
DENY={'.git','.sarion','.ssh','.aws','.gnupg','.kube','.npmrc','.netrc','.pypirc','.git-credentials','credentials.json','secrets.json','node_modules','.venv','dist','__pycache__'}
def parts(p):
    if not isinstance(p,str) or not p or p.startswith(('/','\\')) or '\\' in p or ':' in p or '\x00' in p: raise ValueError('Invalid relative path')
    a=p.split('/')
    if any(x in ('','..','.') or x in DENY or x.startswith('.env') or x in ('cli.json','providers.json') or x.endswith(('.pem','.key','.p12','.pfx')) or x.startswith('id_rsa') or x.startswith('id_ed25519') for x in a): raise ValueError('Protected path')
    return a
def parent(root,p,create=False):
    a=parts(p);fd=os.dup(root)
    try:
        for x in a[:-1]:
            if create:
                try:os.mkdir(x,0o755,dir_fd=fd)
                except FileExistsError:pass
            n=os.open(x,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=fd);os.close(fd);fd=n
        return fd,a[-1]
    except:os.close(fd);raise
def read(root,p):
    fd,n=parent(root,p)
    try:
        f=os.open(n,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK,dir_fd=fd)
        try:
            s=os.fstat(f)
            if not stat.S_ISREG(s.st_mode) or s.st_size>65536:raise ValueError('Not a bounded regular file')
            b=os.read(f,65537)
            if len(b)>65536 or b'\x00' in b:raise ValueError('Binary or oversized file')
            return b.decode('utf-8')
        finally:os.close(f)
    finally:os.close(fd)
def walk(root,prefix='',depth=0):
    if depth>30:return []
    result=[]
    for n in sorted(os.listdir(root)):
        try:parts(n)
        except ValueError:continue
        s=os.stat(n,dir_fd=root,follow_symlinks=False)
        if stat.S_ISREG(s.st_mode):result.append(prefix+n)
        elif stat.S_ISDIR(s.st_mode):
            d=os.open(n,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW,dir_fd=root)
            try:result.extend(walk(d,prefix+n+'/',depth+1))
            finally:os.close(d)
        if len(result)>10000:raise ValueError('Repository discovery limit exceeded')
    return result
def apply(root,p,before,after):
    fd,n=parent(root,p,True)
    try:
        try:
            s=os.stat(n,dir_fd=fd,follow_symlinks=False)
            if not stat.S_ISREG(s.st_mode) or s.st_nlink!=1:raise ValueError('Unsafe write target')
            current=read(root,p)
        except FileNotFoundError:current=None
        actual=None if current is None else hashlib.sha256(current.encode()).hexdigest()
        if actual!=before:raise ValueError('File hash conflict')
        if after is None:os.unlink(n,dir_fd=fd)
        else:
            data=after.encode()
            if len(data)>65536:raise ValueError('Oversized patch')
            tmp='.sarion-tmp-'+os.urandom(12).hex();f=os.open(tmp,os.O_CREAT|os.O_EXCL|os.O_WRONLY|os.O_NOFOLLOW,0o600,dir_fd=fd)
            try:
                os.write(f,data);os.fsync(f)
                if current is not None:os.fchmod(f,s.st_mode&0o777)
            finally:os.close(f)
            try:os.rename(tmp,n,src_dir_fd=fd,dst_dir_fd=fd)
            except:os.unlink(tmp,dir_fd=fd);raise
        os.fsync(fd)
        return {'path':p,'beforeHash':before,'afterHash':None if after is None else hashlib.sha256(after.encode()).hexdigest(),'status':'verified'}
    finally:os.close(fd)
def main():
    if sys.argv[1]=='lock':
        f=os.open(sys.argv[2],os.O_CREAT|os.O_RDWR|os.O_NOFOLLOW,0o600)
        try:fcntl.flock(f,fcntl.LOCK_EX|fcntl.LOCK_NB)
        except BlockingIOError:sys.exit(3)
        print('locked',flush=True);sys.stdin.read();os.close(f);return
    r=json.load(sys.stdin);root=os.open(r['root'],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
    try:
        s=os.fstat(root)
        if r.get('identity')!=str(s.st_dev)+':'+str(s.st_ino):raise ValueError('Workspace identity changed')
        op=r['op']
        if op=='read':out=read(root,r['path'])
        elif op=='list':out=walk(root)
        elif op=='search':
            query=r['query'];files=r['files']
            if not isinstance(query,str) or not query or len(query)>1000 or len(files)>10000:raise ValueError('Search limit')
            hits=[];size=0
            for p in files:
                try:content=read(root,p)
                except (OSError,ValueError,UnicodeError):continue
                for line,value in enumerate(content.splitlines(),1):
                    if query in value:
                        excerpt=value[:500];size+=len(excerpt.encode());hits.append({'path':p,'line':line,'text':excerpt})
                    if len(hits)>=200 or size>=60000:break
                if len(hits)>=200 or size>=60000:break
            out={'matches':hits,'truncated':len(hits)>=200 or size>=60000}
        elif op=='validate':
            parts(r['path']);out=True
        elif op=='apply':out=apply(root,r['path'],r['beforeHash'],r['after'])
        else:raise ValueError('Unsupported filesystem operation')
        print(json.dumps({'ok':True,'result':out}))
    finally:os.close(root)
try:main()
except Exception as e:print(json.dumps({'ok':False,'error':str(e)[:200]}));sys.exit(1)
