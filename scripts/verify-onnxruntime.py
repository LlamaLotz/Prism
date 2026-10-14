#!/usr/bin/env python3
"""Verify the packaged ONNX runtime version/API (and universal macOS slices)."""
import ctypes
import pathlib
import subprocess
import sys


def verify(path: pathlib.Path):
    if sys.platform == 'darwin':
        subprocess.run(['lipo', str(path), '-verify_arch', 'arm64', 'x86_64'], check=True)
        headers = subprocess.check_output(['otool', '-arch', 'all', '-hv', str(path)], text=True)
        slices = [line.split() for line in headers.splitlines() if line.strip().startswith('MH_MAGIC_64')]
        if len(slices) != 2 or any('DYLIB' not in fields for fields in slices):
            raise ValueError('Expected two MH_DYLIB slices; a dSYM is not a runtime library')
    if sys.platform == 'win32':
        # Fail even on development/CI machines with a global CRT installed.
        # Check architecture from PE headers before attempting native loading.
        for name in ('onnxruntime.dll', 'msvcp140.dll', 'vcruntime140.dll', 'vcruntime140_1.dll'):
            dependency = path.parent / name
            if not dependency.is_file():
                raise ValueError(f'Missing bundled Windows runtime dependency: {dependency}')
        for dependency in path.parent.glob('*.dll'):
            data = dependency.read_bytes()
            if len(data) < 64 or data[:2] != b'MZ':
                raise ValueError(f'Invalid PE image: {dependency}')
            offset = int.from_bytes(data[60:64], 'little')
            if data[offset:offset + 4] != b'PE\0\0' or data[offset + 4:offset + 6] != b'\x64\x86':
                raise ValueError(f'Expected an x64 PE image: {dependency}')
        # Match Prism: search the bundle directory and trusted default paths.
        library = ctypes.CDLL(str(path.resolve()), winmode=0x100 | 0x1000)
    else:
        library = ctypes.CDLL(str(path.resolve()))
    # Load on the CI host and check the API's actual version, not its filename.
    class ApiBase(ctypes.Structure):
        _fields_ = [('get_api', ctypes.CFUNCTYPE(ctypes.c_void_p, ctypes.c_uint32)),
                    ('get_version', ctypes.CFUNCTYPE(ctypes.c_char_p))]
    library.OrtGetApiBase.argtypes = []
    library.OrtGetApiBase.restype = ctypes.POINTER(ApiBase)
    api = library.OrtGetApiBase().contents
    version = api.get_version().decode()
    if version != '1.18.1' or not api.get_api(18):
        raise ValueError(f'Expected ONNX Runtime 1.18.1 with API 18, found {version}')
    print(f'Validated ONNX Runtime {version}: {path}')


if __name__ == '__main__':
    verify(pathlib.Path(sys.argv[1]))
