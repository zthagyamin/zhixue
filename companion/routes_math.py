"""Authenticated math routes; session and Origin remain the HTTP boundary."""
import re
from infrastructure.math_grade_adapter import create_native_math_application


def post_math(self,services,request_path,hashed_user,payload=None):
    try:
        app=create_native_math_application(services,hashed_user)
        action=request_path.rsplit('/',1)[1]
        if '/source/' in request_path:
            result=app.source(action,payload)
        elif '/mapping/' in request_path:
            result=app.mapping(action,payload)
        else:
            result=getattr(app,action)(payload)
    except ValueError as error:
        code=str(error)
        if not re.fullmatch(r'[a-z][a-z0-9-]{1,100}',code):
            code='native-math-unavailable'
        self.send_json(409 if code.startswith('native-math-') else 400,{'error':code})
        return
    except Exception:
        self.send_json(503,{'error':'native-math-storage-unavailable'})
        return
    self.send_json(200,result)
