"""Owned bundled Companion with real synthetic pairing and no provider calls."""
import contextlib
import io
import json
import sys
import tempfile
import threading
import types
from http.server import ThreadingHTTPServer
from pathlib import Path

candidate,origin = Path(sys.argv[1]).resolve(),sys.argv[2]
sys.path.insert(0,str(candidate))
import server
assert Path(server.__file__).resolve().is_relative_to(candidate)
with tempfile.TemporaryDirectory(prefix="zhixue-calculation-v76-") as temp:
    root = Path(temp)
    vault = root/"synthetic-vault"
    vault.mkdir()
    server.CONFIG["learning_vault_root"] = str(vault)
    server.CONFIG["allowed_origins"] = [origin]
    server.LOCAL_DATABASE_PATH = root/"synthetic.sqlite"
    sys.modules["keyring"] = types.SimpleNamespace(get_password=lambda *_:None)
    def denied(*_args,**_kwargs):
        raise AssertionError("Provider must not run for numeric grading")
    server.open_deepseek = denied
    server.study_ai_provider.open_request = denied
    server.PAIRING_CODE = "A1B2C3"
    with contextlib.redirect_stdout(io.StringIO()):
        paired = server.pair_account("A1B2C3","synthetic-calculation-user")
    httpd = ThreadingHTTPServer(("127.0.0.1",0),server.Handler)
    thread = threading.Thread(target=httpd.serve_forever,daemon=True)
    thread.start()
    print(json.dumps({"base":"http://127.0.0.1:"+str(httpd.server_port),"session":paired["sessionToken"],
                      "owner":server.installation_owner_hash(),
                      "library":server.local_vault_library_id(vault),
                      "module":server.__file__,"python":sys.version}),flush=True)
    try:
        for line in sys.stdin:
            if line.strip()=="stop":
                break
    finally:
        httpd.shutdown()
        thread.join(3)
        httpd.server_close()
        assert not thread.is_alive()
        assert list(vault.rglob("*.jsonl"))==[]
