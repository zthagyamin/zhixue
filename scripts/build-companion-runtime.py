"""Build a deterministic offline Windows runtime from verified Python and wheels."""
from __future__ import annotations
import argparse
import hashlib
import json
import tempfile
import zipfile
from pathlib import Path, PurePosixPath

PYTHON_SHA256='d297e5ff019966817ad8502465176139f2d3d840fa4ed84b13bed399a6ab1f15'


def entries(archive):
    for info in archive.infolist():
        name=PurePosixPath(info.filename)
        if name.is_absolute() or '..' in name.parts or '\\' in info.filename or ':' in info.filename or (info.external_attr>>16)&0o170000==0o120000:raise ValueError('unsafe-runtime-archive')
        if not info.is_dir():yield info, name


def build(python_zip,wheels,output):
    if hashlib.sha256(python_zip.read_bytes()).hexdigest()!=PYTHON_SHA256:raise ValueError('python-runtime-hash-mismatch')
    output.parent.mkdir(parents=True,exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='zhixue-runtime-build-') as temporary:
        root=Path(temporary).resolve()
        with zipfile.ZipFile(python_zip) as archive:
            for info,name in entries(archive):
                target=root/str(name);target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(archive.read(info))
        packages=[]
        for wheel in sorted(wheels.glob('*.whl')):
            packages.append({'file':wheel.name,'sha256':hashlib.sha256(wheel.read_bytes()).hexdigest()})
            with zipfile.ZipFile(wheel) as archive:
                for info,name in entries(archive):
                    parts=name.parts
                    if '.data' in parts[0]:
                        if len(parts)<3 or parts[1] not in ('purelib','platlib'):continue
                        parts=parts[2:]
                    target=root/'Lib'/'site-packages'/Path(*parts);raw=archive.read(info)
                    if target.exists() and target.read_bytes()!=raw:raise ValueError('runtime-package-collision')
                    target.parent.mkdir(parents=True,exist_ok=True);target.write_bytes(raw)
        if not packages:raise ValueError('runtime-packages-missing')
        (root/'python314._pth').write_text('python314.zip\n.\nLib\\site-packages\n..\\..\\\nimport site\n',encoding='utf-8')
        (root/'zhixue-runtime.json').write_text(json.dumps({'python':'3.14.7','architecture':'amd64','packages':packages},indent=2),encoding='utf-8')
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED,compresslevel=9) as archive:
            for path in sorted(root.rglob('*')):
                if path.is_file():
                    info=zipfile.ZipInfo(path.relative_to(root).as_posix(),(2026,8,5,0,0,0));info.compress_type=zipfile.ZIP_DEFLATED;info.external_attr=0o100644<<16
                    archive.writestr(info,path.read_bytes())
    manifest={'schemaVersion':1,'pythonVersion':'3.14.7','architecture':'amd64','archive':output.name,'sha256':hashlib.sha256(output.read_bytes()).hexdigest(),
              'pythonSource':'https://www.python.org/ftp/python/3.14.7/python-3.14.7-embed-amd64.zip','pythonSha256':PYTHON_SHA256,'packages':packages}
    (output.parent/'runtime-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'archive':str(output),'bytes':output.stat().st_size,'sha256':manifest['sha256']}))


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--python-zip',type=Path,required=True);p.add_argument('--wheels',type=Path,required=True);p.add_argument('--output',type=Path,required=True);a=p.parse_args();build(a.python_zip,a.wheels,a.output)
