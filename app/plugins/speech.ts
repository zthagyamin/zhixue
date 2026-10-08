// Web Speech 发音（TypeWords 式：词卡出现即朗读）。浏览器不支持时静默
// 降级，各插件不依赖发音也能完整练习。

export function speakWord(word: string) {
  const target = String(word || "").trim();
  if (!target || typeof window === "undefined" || !window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(target);
    utterance.lang = "en-US";
    utterance.rate = 0.85;
    window.speechSynthesis.speak(utterance);
  } catch {
    // 语音不可用时静默降级。
  }
}

/** End a previous card or a just-concealed word's queued speech; no browser support required. */
export function cancelWordSpeech() {
  if (typeof window === 'undefined') return;
  try { window.speechSynthesis?.cancel(); } catch { /* Speech is optional. */ }
}
