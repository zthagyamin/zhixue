"""Bounded exact real-polynomial kernel. Closed grammar; no eval or CAS."""
import re
import json
import math
from fractions import Fraction as F

def rat(n,d=1):
    if not d or len(str(abs(n)))>120 or len(str(abs(d)))>120:raise ValueError('limit')
    return F(n,d)
def const(q):return {():q} if q else {}
def canonical(p):
    if sum(sum(len(v) for v in a)+250 for a in p)>8192:raise ValueError('limit')
    out=json.dumps(sorted([[list(a),str(q.numerator),str(q.denominator)] for a,q in p.items()]),separators=(',',':'))
    if len(out)>8192:raise ValueError('limit')
    return out

class Kernel:
    def __init__(self,source,variables):
        if type(source) is not str or not source.strip() or len(source)>512 or type(variables) is not list or len(variables)>4 or any(type(v) is not str or not re.fullmatch('[a-zA-Z]',v) for v in variables) or len(set(variables))!=len(variables):raise ValueError('grammar')
        self.variables=variables;self.tokens=re.findall(r'(?:\d+(?:\.\d+)?|\.\d+)|[A-Za-z]+|[^\s]',source,flags=re.ASCII);self.pos=0;self.ops=0;self.depth=0
        if len(self.tokens)>128:raise ValueError('limit')
    def tick(self):
        self.ops+=1
        if self.ops>30000:raise ValueError('limit')
    def put(self,out,atoms,q):
        self.tick()
        if len(atoms)>16 or sum(len(a) for a in atoms)>8192:raise ValueError('limit')
        a=tuple(sorted(atoms));q=q+out.get(a,0);q=rat(q.numerator,q.denominator)
        if q:out[a]=q
        else:out.pop(a,None)
        if len(out)>256:raise ValueError('limit')
    def add(self,a,b):
        out=a.copy()
        for atoms,q in b.items():self.put(out,atoms,q)
        return out
    def mul(self,a,b):
        out={}
        for x,qx in a.items():
            for y,qy in b.items():
                q=qx*qy;plain=[v for v in x+y if not v.startswith('r:')];rad=1
                for v in x+y:
                    if v.startswith('r:'):
                        n=int(v[2:]);g=math.gcd(rad,n);q*=g;rad=rad//g*(n//g)
                        if rad>1000000000000:raise ValueError('limit')
                if rad!=1:plain.append('r:'+str(rad))
                self.put(out,plain,rat(q.numerator,q.denominator))
        return out
    def inverse(self,p):
        if len(p)!=1:raise ValueError('domain')
        atoms,q=next(iter(p.items()))
        if not atoms:return const(rat(q.denominator,q.numerator))
        if len(atoms)==1 and atoms[0].startswith('r:'):return {atoms:rat(q.denominator,q.numerator*int(atoms[0][2:]))}
        raise ValueError('domain')
    def power(self,p,n):
        if abs(n)>8:raise ValueError('limit')
        if n==0 and (len(p)!=1 or any(not a.startswith('r:') for a in next(iter(p)))):raise ValueError('domain')
        if n<0:p=self.inverse(p);n=-n
        out=const(F(1))
        for _ in range(n):out=self.mul(out,p)
        return out
    def eat(self,s):
        if self.pos<len(self.tokens) and self.tokens[self.pos]==s:self.pos+=1;return True
        return False
    def take(self):
        if self.pos>=len(self.tokens):raise ValueError('grammar')
        t=self.tokens[self.pos];self.pos+=1;return t
    def expression(self):
        self.depth+=1
        if self.depth>16:raise ValueError('limit')
        p=self.product()
        while True:
            if self.eat('+'):p=self.add(p,self.product())
            elif self.eat('-'):p=self.add(p,self.mul(const(F(-1)),self.product()))
            else:break
        self.depth-=1;return p
    def product(self):
        p=self.unary()
        while True:
            if self.eat('*'):p=self.mul(p,self.unary())
            elif self.eat('/'):p=self.mul(p,self.inverse(self.unary()))
            else:break
        return p
    def unary(self):
        self.depth+=1
        if self.depth>16:raise ValueError('limit')
        if self.eat('+'):p=self.unary()
        elif self.eat('-'):p=self.mul(const(F(-1)),self.unary())
        else:p=self.power_expression()
        self.depth-=1;return p
    def power_expression(self):
        p=self.primary()
        if self.eat('^'):
            negative=self.eat('-')
            if not negative:self.eat('+')
            t=self.take()
            if not re.fullmatch('[0-9]',t):raise ValueError('exponent')
            p=self.power(p,int(t)*(-1 if negative else 1))
        return p
    def primary(self):
        self.tick()
        if self.eat('('):
            p=self.expression()
            if not self.eat(')'):raise ValueError('grammar')
            return p
        token=self.take()
        if re.fullmatch(r'(?:[0-9]+(?:\.[0-9]+)?|\.[0-9]+)',token):
            q=F(token);return const(rat(q.numerator,q.denominator))
        if token in self.variables:return {('v:'+token,):F(1)}
        if token in ('sqrt','sin','cos') and self.eat('('):
            p=self.expression()
            if not self.eat(')'):raise ValueError('grammar')
            if token=='sqrt':
                if not p:return {}
                if len(p)!=1:raise ValueError('domain')
                atoms,q=next(iter(p.items()))
                if atoms or q<0 or q.numerator>1000000 or q.denominator>1000000:raise ValueError('domain')
                n=q.numerator*q.denominator;factor=1;i=2
                if n>1000000:raise ValueError('limit')
                while i*i<=n:
                    self.tick()
                    while n%(i*i)==0:n//=i*i;factor*=i
                    i+=1
                return {() if n==1 else ('r:'+str(n),):rat(factor,q.denominator)}
            if not p:return {} if token=='sin' else const(F(1))
            if token=='sin' and all(q.denominator==1 and q.numerator%2==0 for q in p.values()):
                arg=canonical(self.mul(p,const(F(1,2))));return {tuple(sorted(['sin:'+arg,'cos:'+arg])):F(2)}
            return {(token+':'+canonical(p),):F(1)}
        raise ValueError('grammar')
    def parse(self):
        p=self.expression()
        if self.pos!=len(self.tokens):raise ValueError('grammar')
        return p

def compare_expressions(actual,expected,variables):
    try:
        a=Kernel(actual,variables);left=a.parse();right=Kernel(expected,variables).parse();diff=a.add(left,a.mul(const(F(-1)),right))
        if not diff:return {'verdict':'correct','correct':True,'explanation':'在声明的实数域内，两式等价。'}
        if any(not atom.startswith('v:') for atoms in diff for atom in atoms):raise ValueError('unsupported identity')
        return {'verdict':'wrong','correct':False,'explanation':'两式化简后的多项式不相同。'}
    except (ValueError,OverflowError,RecursionError):return {'verdict':'unknown','correct':None,'explanation':'暂不能判定。请检查格式、变量与定义域；当前只支持有限的实数表达式。'}

if __name__=='__main__':
    import sys
    data=json.loads(sys.stdin.read(4096))
    print(json.dumps(compare_expressions(data.get('actual'),data.get('expected'),data.get('variables')),ensure_ascii=True))
