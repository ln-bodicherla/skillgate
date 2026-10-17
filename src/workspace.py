"""Trusted rootless tmpfs holder. No skill code executes in this process."""
import ctypes
import json
import os
import signal
import sys

path = os.fsencode(sys.argv[1])
limit = int(sys.argv[2])
libc = ctypes.CDLL(None, use_errno=True)
# Tear down the private namespace if the controller disappears.
if libc.prctl(1, signal.SIGKILL, 0, 0, 0) != 0:
    raise OSError(ctypes.get_errno(), 'prctl failed')
if os.getppid() == 1:
    sys.exit(1)
if libc.mount(b'tmpfs', path, b'tmpfs', 6, f'size={limit},nr_inodes=4096,mode=0700'.encode()) != 0:
    raise OSError(ctypes.get_errno(), 'tmpfs mount failed')
stats = os.statvfs(path)
print(json.dumps({'pid': os.getpid(), 'bytes': stats.f_blocks * stats.f_frsize}), flush=True)
sys.stdin.buffer.read(1)
