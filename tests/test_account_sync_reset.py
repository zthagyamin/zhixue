import sqlite3,sys,tempfile,unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parents[1]/'companion'))
import account_sync_reset
from account_sync_credentials import CREDENTIAL_SERVICE

class Provider:
    def __init__(self):self.values={}
    def get_password(self,service,key):return self.values.get((service,key))
    def delete_password(self,service,key):self.values.pop((service,key),None)

class ResetTests(unittest.TestCase):
    def test_all_machine_secrets_are_removed_before_database_deletion(self):
        with tempfile.TemporaryDirectory() as temp:
            path=Path(temp)/'account-study.db';db=sqlite3.connect(path);db.execute('CREATE TABLE account_sync_links(credential_ref TEXT)');db.executemany('INSERT INTO account_sync_links VALUES(?)',[('machine:one',),('machine:two',)]);db.commit();db.close();provider=Provider();provider.values={(CREDENTIAL_SERVICE,'machine:one'):'a',(CREDENTIAL_SERVICE,'machine:two'):'b'}
            self.assertEqual(account_sync_reset.clear_credentials(path,provider),2);self.assertEqual(provider.values,{})

if __name__=='__main__':unittest.main()
