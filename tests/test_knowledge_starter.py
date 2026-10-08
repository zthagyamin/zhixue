import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
from note_imports import read_local_documents,learning_items

class StarterKitTests(unittest.TestCase):
    def test_downloaded_material_folder_is_usable_and_does_not_import_guides(self):
        kit=Path(__file__).resolve().parents[1]/'public/knowledge-starter-kit'
        with tempfile.TemporaryDirectory() as temporary,zipfile.ZipFile(kit/'structure.zip') as archive:
            archive.extractall(temporary)
            root=Path(temporary)/'knowledge-starter-kit';docs=read_local_documents(root/'Starter/materials');items=learning_items(docs,'starter-fixture')
            self.assertEqual(len(docs),5);self.assertEqual(len(items),8)
            self.assertEqual({i['kind'] for i in items},{'vocabulary','quiz','code'})
            for name in ['README.md','QUICKSTART.md','CONNECTIONS.md','WORKFLOW.md','TROUBLESHOOTING.md']:
                self.assertEqual((root/name).read_bytes().replace(b'\r\n',b'\n'),(kit/name).read_bytes().replace(b'\r\n',b'\n'))
            self.assertEqual(len(list((root/'Templates').glob('*.md'))),5)
            exercise=next(i for i in items if i['kind']=='code');namespace={}
            exec(exercise['solutionCode'],namespace);exec(exercise['testCode'],namespace)
            self.assertNotIn('stateRef',exercise);self.assertNotIn('sourceNote',exercise)

if __name__=='__main__':unittest.main()
