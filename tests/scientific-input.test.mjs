import test from 'node:test';
import assert from 'node:assert/strict';
import {scientificRuntimeRequirement} from '../src/domain/code-execution/index.ts';
for(const [source,expected] of [
  ['print(1)',null],['import numpy as np','numpy'],['from numpy.linalg import norm','numpy'],
  ['import math, numpy as vector','numpy'],['if True: import pandas','pandas'],
  ['import math, \\\n pandas as table','pandas'],['import numpy\nimport pandas','pandas'],
  ['# import pandas\nprint("import numpy")',null],['text="""from pandas import DataFrame"""',null],
  ['print(np.arange(2))','numpy'],['print(pd.Series([1]))','pandas'],
])test('scientific preparation selector: '+JSON.stringify(source),()=>assert.equal(scientificRuntimeRequirement(source),expected));

test('escaped triple quotes do not turn a string body into a scientific import',()=>{
  const source=String.raw`text = """escaped \"""
import pandas
"""
print(1)`;
  assert.equal(scientificRuntimeRequirement(source),null);
});
