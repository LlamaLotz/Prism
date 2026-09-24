#!/usr/bin/env python3
"""Reject dSYM lookalikes and verify the packaged universal ONNX runtime."""
import ctypes
import pathlib
import subprocess
import sys


def verify(path: pathlib.Path):
    subprocess.run(['lipo', str(path), '-verify_arch', 'arm64', 'x86_64'], check=True)
    headers = subprocess.check_output(['otool', '-arch', 'all', '-hv', str(path)], text=True)
    slices = [line.split() for line in headers.splitlines() if line.strip().startswith('MH_MAGIC_64')]
    if len(slices) != 2 or any('DYLIB' not in fields for fields in slices):
        raise ValueError('Expected two MH_DYLIB slices; a dSYM is not a runtime library')
    library = ctypes.CDLL(str(path.resolve()))
    # Load on the CI host and check the API's actual version, not its filename.
    class ApiBase(ctypes.Structure):
        _fields_ = [('get_api', ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_uint32)),
                    ('get_version', ctypes.CFUNCTYPE(ctypes.c_char_p))]
    library.OrtGetApiBase.restype = ctypes.POINTER(ApiBase)
    api = library.OrtGetApiBase().contents
    version = api.get_version().decode()
    if version != '1.18.1' or not api.get_api(18):
        raise ValueError(f'Expected ONNX Runtime 1.18.1 with API 18, found {version}')
    print(f'Validated universal ONNX Runtime {version}: {path}')


if __name__ == '__main__':
    verify(pathlib.Path(sys.argv[1]))
