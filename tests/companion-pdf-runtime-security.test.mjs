import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { mkdtemp, cp, readFile, rm } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve('companion');
const python = process.env.PYTHON || 'python';
const quote = value => `'${value.replaceAll("'", "''")}'`;

test('bundled PDF dependency meets the patched minimum in both manifest and archive', async () => {
  const manifest = JSON.parse(await readFile(path.join(root, 'runtime-manifest.json'), 'utf8'));
  const archive = path.join(root, manifest.archive);
  assert.equal(createHash('sha256').update(await readFile(archive)).digest('hex'), manifest.sha256);
  const wheel = manifest.packages.filter(row => row.file.startsWith('pypdf-'));
  assert.equal(wheel.length, 1);
  const probe = String.raw`
import json, sys, zipfile
with zipfile.ZipFile(sys.argv[1]) as archive:
    metadata = [name for name in archive.namelist() if name.startswith('Lib/site-packages/pypdf-') and name.endswith('.dist-info/METADATA')]
    assert len(metadata) == 1
    text = archive.read(metadata[0]).decode('utf-8')
    version = next(line.split(': ', 1)[1] for line in text.splitlines() if line.startswith('Version: '))
    details = json.loads(archive.read('zhixue-runtime.json'))
    print(json.dumps({'version': version, 'packages': details['packages']}))
`;
  const result = spawnSync(python, ['-X', 'utf8', '-c', probe, archive], {
    encoding: 'utf8', windowsHide: true, timeout: 15000,
  });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const inspected = JSON.parse(result.stdout);
  const [major, minor] = inspected.version.split('.').map(Number);
  assert.ok(major > 6 || (major === 6 && minor >= 20), `unpatched PDF runtime: ${inspected.version}`);
  assert.equal(wheel[0].file, `pypdf-${inspected.version}-py3-none-any.whl`);
  assert.deepEqual(inspected.packages, manifest.packages);
});

test('actual embedded Windows Python reads a synthetic PDF with the patched package', {
  skip: process.platform !== 'win32',
}, async () => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'zhixue-pdf-runtime-'));
  try {
    for (const name of ['runtime-manifest.json', 'runtime-windows-x64.zip', 'runtime-helpers.ps1']) {
      await cp(path.join(root, name), path.join(temporary, name));
    }
    const probe = String.raw`
import io, json, pypdf
from pypdf.generic import ArrayObject, DecodedStreamObject, DictionaryObject, EncodedStreamObject, NameObject
from pypdf.filters import decode_stream_data
from pypdf.errors import LimitReachedError
writer = pypdf.PdfWriter()
page = writer.add_blank_page(width=200, height=200)
font = DictionaryObject({NameObject('/Type'): NameObject('/Font'), NameObject('/Subtype'): NameObject('/Type1'), NameObject('/BaseFont'): NameObject('/Helvetica')})
page[NameObject('/Resources')] = DictionaryObject({NameObject('/Font'): DictionaryObject({NameObject('/F1'): writer._add_object(font)})})
content = DecodedStreamObject()
content.set_data(b'BT /F1 12 Tf 10 100 Td (Synthetic PDF round trip) Tj ET')
page[NameObject('/Contents')] = writer._add_object(content)
buffer = io.BytesIO()
writer.write(buffer)
buffer.seek(0)
reader = pypdf.PdfReader(buffer, strict=True)
assert len(reader.pages) == 1
assert reader.pages[0].extract_text() == 'Synthetic PDF round trip'
version = tuple(int(value) for value in pypdf.__version__.split('.'))
assert version >= (6, 20, 0), pypdf.__version__
original_configuration = pypdf.get_configuration()
filter_limit = original_configuration.stream_filters_maximum_length
assert 1 <= filter_limit <= 1000
stream = EncodedStreamObject()
stream[NameObject('/Filter')] = ArrayObject([NameObject('/ASCIIHexDecode')] * (filter_limit + 1))
stream._data = b'00>'
try:
    decode_stream_data(stream)
except LimitReachedError as error:
    assert 'Maximum filter count' in str(error)
else:
    raise AssertionError('excessive filter count was accepted')
try:
    pypdf.overwrite_configuration(stream_decoding_work_maximum_length=2)
    stream = EncodedStreamObject()
    stream[NameObject('/Filter')] = NameObject('/ASCIIHexDecode')
    stream._data = b'6162>'
    try:
        decode_stream_data(stream)
    except LimitReachedError as error:
        assert 'accumulated decoding work' in str(error)
    else:
        raise AssertionError('decoding work limit was ignored')
finally:
    pypdf.overwrite_configuration(original_configuration)
print(json.dumps({'pypdf': pypdf.__version__, 'pages': len(reader.pages), 'text': reader.pages[0].extract_text(), 'resourceGuardsVerified': True}))
`;
    const command = `$ErrorActionPreference='Stop'; . ${quote(path.join(temporary, 'runtime-helpers.ps1'))}; $env:PATH=$env:SystemRoot+'\\System32'; $runtime=Get-ZhixueRuntime -Root ${quote(temporary)}; [Console]::In.ReadToEnd() | & $runtime -I -; if($LASTEXITCODE -ne 0){exit $LASTEXITCODE}`;
    const result = spawnSync('pwsh.exe', ['-NoProfile', '-Command', command], {
      input: probe, encoding: 'utf8', windowsHide: true, timeout: 120000,
    });
    assert.equal(result.status, 0, result.stderr || result.error?.message);
    assert.match(result.stdout, /Synthetic PDF round trip/);
  } finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith('zhixue-pdf-runtime-'));
    await rm(temporary, { recursive: true, force: true });
  }
});

test('PDF rebuild pin and source install floor cannot regress the verified bundled version',async()=>{
  const manifest=JSON.parse(await readFile(path.join(root,'runtime-manifest.json'),'utf8'));
  const wheels=manifest.packages.filter(row=>row.file.startsWith('pypdf-'));assert.equal(wheels.length,1);
  const version=/^pypdf-(\d+\.\d+\.\d+)-py3-none-any\.whl$/.exec(wheels[0].file)?.[1];assert.ok(version);
  const pins=[...(await readFile(path.join(root,'runtime-requirements.txt'),'utf8')).matchAll(/^pypdf==(\d+\.\d+\.\d+)\s*$/gm)];
  assert.equal(pins.length,1);assert.equal(pins[0][1],version,'rebuilding must select the verified PDF wheel');
  const floor=/^pypdf>=(\d+\.\d+\.\d+),<7\s*$/m.exec(await readFile(path.join(root,'requirements.txt'),'utf8'))?.[1];
  assert.ok(floor);const [major,minor]=floor.split('.').map(Number);
  assert.ok(major===6&&minor>=20,`source installation can select an older PDF dependency: ${floor}`);
});
