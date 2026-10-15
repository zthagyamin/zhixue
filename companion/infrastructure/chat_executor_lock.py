"""Nonblocking OS execution witness. Contents are never an ownership proof."""
from __future__ import annotations
import errno
import os
import stat
from pathlib import Path
from infrastructure.source_protocol_hash import fingerprint


class ChatExecutorLock:
    def __init__(self, database, scope, request_id):
        database = Path(database).resolve()
        self.directory = database.parent/(database.name+'.chat-executors')
        self.path = self.directory/(fingerprint([str(database),list(scope),request_id])+'.lock')
        self.handle = None

    @staticmethod
    def _linked(path):
        return path.is_symlink() or (hasattr(path,'is_junction') and path.is_junction())

    def acquire(self, *, create=True):
        if self._linked(self.directory):
            raise ValueError('ai-chat-execution-unverified')
        self.directory.mkdir(exist_ok=True)
        if self.directory.resolve()!=self.directory or self._linked(self.path):
            raise ValueError('ai-chat-execution-unverified')
        flags=os.O_RDWR|getattr(os,'O_CLOEXEC',0)|getattr(os,'O_NOFOLLOW',0)
        if create:flags|=os.O_CREAT
        descriptor=os.open(self.path,flags,0o600)
        try:
            actual=os.fstat(descriptor)
            named=os.stat(self.path,follow_symlinks=False)
            if (not stat.S_ISREG(actual.st_mode) or actual.st_nlink!=1 or actual.st_ino==0 or
                    (actual.st_dev,actual.st_ino)!=(named.st_dev,named.st_ino)):
                raise ValueError('ai-chat-execution-unverified')
            if actual.st_size==0:
                os.write(descriptor,b'0')
            os.lseek(descriptor,0,os.SEEK_SET)
            try:
                if os.name=='nt':
                    import msvcrt
                    msvcrt.locking(descriptor,msvcrt.LK_NBLCK,1)
                else:
                    import fcntl
                    fcntl.flock(descriptor,fcntl.LOCK_EX|fcntl.LOCK_NB)
            except OSError as error:
                if error.errno not in (errno.EACCES,errno.EAGAIN):raise
                return False
            self.handle=descriptor
            descriptor=None
            return True
        finally:
            if descriptor is not None:os.close(descriptor)

    def identity(self):
        if self.handle is None:raise ValueError('ai-chat-execution-required')
        value=os.fstat(self.handle)
        return value.st_dev,value.st_ino

    def close(self):
        if self.handle is None:return
        descriptor,self.handle=self.handle,None
        try:
            os.lseek(descriptor,0,os.SEEK_SET)
            if os.name=='nt':
                import msvcrt
                msvcrt.locking(descriptor,msvcrt.LK_UNLCK,1)
            else:
                import fcntl
                fcntl.flock(descriptor,fcntl.LOCK_UN)
        finally:os.close(descriptor)
