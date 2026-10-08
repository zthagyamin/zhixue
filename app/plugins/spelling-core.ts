// 拼写练习插件的状态机（借鉴 TypeWords 的逐字母即时反馈）。错误字符会
// 原位标红并阻断输入，必须退格重输——刻意保留这一点摩擦，训练的是
// IELTS 写作真正需要的拼写准确性，而不是"感觉会了"。

export type SpellingState = {
  word: string;
  input: string;
  wrong: string;
  wrongCount: number;
};

export type CharacterState = { char: string; status: "pending" | "correct" | "wrong" };

export function spellingStates(word: string, input: string, wrong: string): CharacterState[] {
  const target = String(word ?? "");
  const states: CharacterState[] = [];
  for (let index = 0; index < target.length; index += 1) {
    const char = target[index];
    if (index < input.length) {
      states.push({ char, status: "correct" });
    } else if (index === input.length && wrong) {
      // 显示打错的字符而不是目标字母，避免默写模式泄露答案。
      states.push({ char: wrong, status: "wrong" });
    } else {
      states.push({ char, status: "pending" });
    }
  }
  return states;
}

export function isSpellingComplete(state: SpellingState): boolean {
  return state.input === state.word && !state.wrong;
}

const ACCEPTED_PATTERN = /^[a-zA-Z'\- ]$/;

/** Commit only a supported single suffix edit; composition is never a bulk shortcut. */
export function evaluateSpellingComposition(state:SpellingState,value:string):SpellingState{
  if(!/^[a-zA-Z' -]*$/.test(value))return state;
  return evaluateSpellingEdit(state,value);
}

// 处理一次按键：正确字符推进输入；错误字符原位标红并计数；已标红时只
// 接受退格。Backspace 先清除标红字符，再回退已输入字符。
export function evaluateKeypress(state: SpellingState, key: string): SpellingState {
  const word = state.word ?? "";
  const expected = word[state.input.length] ?? "";

  if (key === "Backspace") {
    if (state.wrong) return { ...state, wrong: "" };
    if (state.input.length > 0) return { ...state, input: state.input.slice(0, -1) };
    return state;
  }

  if (state.wrong) return state;
  if (!key || key.length !== 1 || !ACCEPTED_PATTERN.test(key)) return state;
  if (expected && key !== expected) {
    return { ...state, wrong: key, wrongCount: state.wrongCount + 1 };
  }
  if (!expected && key === " ") {
    // 单词已打完后的空格无意义，忽略。
    return state;
  }
  if (state.input.length >= word.length) return state;
  return { ...state, input: state.input + key };
}

/** Mobile input events need not carry a printable key; accept only a suffix edit. */
export function evaluateSpellingEdit(state: SpellingState, value: string): SpellingState {
  const current=state.input+state.wrong;
  if(value===current)return state;
  if(current.startsWith(value)){
    let next=state;
    for(let index=current.length;index>value.length;index--)next=evaluateKeypress(next,'Backspace');
    return next;
  }
  if(value.length===current.length+1&&value.startsWith(current))return evaluateKeypress(state,value.slice(-1));
  return state;
}
