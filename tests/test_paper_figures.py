import base64
import hashlib
import json
import sys
import tempfile
import unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from paper_library import PaperLibrary

class PaperFiguresTests(unittest.TestCase):
    def setUp(self):
        self.tmp=tempfile.TemporaryDirectory();self.root=Path(self.tmp.name).resolve()
        self.source=self.root/'paper.md';self.source.write_text('Figure 1 explains the result.')
        self.version=hashlib.sha256(self.source.read_bytes()).hexdigest()
        self.image=base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1sAAAAASUVORK5CYII=')
        (self.root/'figure.png').write_bytes(self.image)
        self.figure={'assetId':'fig1','label':'Figure 1','title':'Result','caption':'A registered result.','kind':'image','path':'figure.png','assetVersion':hashlib.sha256(self.image).hexdigest()}
        self.registry=self.root/'paper.md.figures.json';self.write_registry()
        self.service=PaperLibrary(self.root,self.root/'state.db','owner','local')
        self.payload={'localLibraryId':'local','source':{'kind':'vault','path':'paper.md','version':self.version},'assetId':'fig1','assetVersion':self.figure['assetVersion']}
    def tearDown(self):self.tmp.cleanup()
    def write_registry(self):self.registry.write_text(json.dumps({'schemaVersion':1,'sourceVersion':self.version,'figures':[self.figure]}))
    def test_registered_descriptor_excludes_path_and_asset_is_verified(self):
        figures=self.service.read({'kind':'vault','path':'paper.md'})['figures']
        self.assertNotIn('path',figures[0]);self.assertEqual(figures[0]['sourceVersion'],self.version)
        asset=self.service.figure(self.payload)
        self.assertEqual(base64.b64decode(asset['data']),self.image);self.assertEqual(asset['mime'],'image/png')
    def test_opaque_source_resolves_only_registered_current_asset(self):
        payload={k:v for k,v in self.payload.items() if k!='source'}
        payload.update(sourceKey=hashlib.sha256(b'paper.md').hexdigest(),sourceVersion=self.version)
        self.assertEqual(self.service.figure(payload),self.service.figure(self.payload))
        for change in ({'sourceKey':'../paper.md'},{'sourceKey':'0'*64},{'sourceVersion':'0'*64},{'source':self.payload['source']}):
            with self.assertRaises(ValueError):self.service.figure({**payload,**change})
        self.registry.unlink()
        with self.assertRaises(ValueError):self.service.figure(payload)
    def test_rejects_changed_source_asset_and_library(self):
        for change in ({'localLibraryId':'other'},{'assetId':'missing'},{'assetVersion':'0'*64}):
            with self.assertRaises(ValueError):self.service.figure({**self.payload,**change})
        (self.root/'figure.png').write_bytes(b'changed')
        with self.assertRaises(ValueError):self.service.figure(self.payload)
        self.source.write_text('new source')
        with self.assertRaises(ValueError):self.service.figure(self.payload)
    def test_rejects_unsafe_registry_and_unregistered_client_paths(self):
        for path in ('../outside.png','https://example.com/a.png','C:/private.png'):
            self.figure['path']=path;self.write_registry()
            with self.assertRaises(ValueError):self.service.figure(self.payload)
        self.figure['path']='figure.png';self.write_registry()
        with self.assertRaises(ValueError):self.service.figure({**self.payload,'path':'other.png'})
    def test_old_source_has_no_new_metadata(self):
        self.registry.unlink();self.assertNotIn('figures',self.service.read({'kind':'vault','path':'paper.md'}))
    def test_pdf_page_crop_requires_original_pdf_hash_and_valid_page(self):
        import io
        from pypdf import PdfWriter
        writer=PdfWriter();writer.add_blank_page(width=800,height=400).rotate(90)
        output=io.BytesIO();writer.write(output);raw=output.getvalue()
        self.source=self.root/'paper.pdf';self.source.write_bytes(raw);self.version=hashlib.sha256(raw).hexdigest()
        self.registry=self.root/'paper.pdf.figures.json';self.figure.update(kind='pdf',path='paper.pdf',page=1,assetVersion=self.version,region={'x':0,'y':0.25,'width':1,'height':0.5});self.write_registry()
        payload={**self.payload,'source':{'kind':'vault','path':'paper.pdf','version':self.version},'assetVersion':self.version}
        self.assertEqual(base64.b64decode(self.service.figure(payload)['data']),raw)
        self.figure['page']=2;self.write_registry()
        with self.assertRaises(ValueError):self.service.figure(payload)
    def test_oversized_pixels_and_duplicate_ids_are_unavailable(self):
        raw=bytearray(self.image);raw[16:20]=(9000).to_bytes(4,'big');(self.root/'figure.png').write_bytes(raw)
        self.figure['assetVersion']=hashlib.sha256(raw).hexdigest();self.write_registry()
        with self.assertRaisesRegex(ValueError,'too-large'):self.service.figure({**self.payload,'assetVersion':self.figure['assetVersion']})
        data=json.loads(self.registry.read_text());data['figures'].append(self.figure);self.registry.write_text(json.dumps(data))
        self.assertEqual(self.service.read({'kind':'vault','path':'paper.md'})['figuresStatus'],'unavailable')
    def test_bad_registry_does_not_block_reading_text(self):
        self.registry.write_text('invalid')
        doc=self.service.read({'kind':'vault','path':'paper.md'})
        self.assertEqual(doc['figuresStatus'],'unavailable');self.assertTrue(doc['pages'][0]['text'])

if __name__=='__main__':unittest.main()
