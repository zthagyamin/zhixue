import {wordQueueStatus} from './presentation';

type WordQueueItem = {
  key: string;
  label: string;
  stage: number;
  threeStage: boolean;
};

export function WordStudyQueue({items, currentIndex, ready, onChoose}: {
  items: WordQueueItem[];
  currentIndex: number;
  ready: boolean;
  onChoose: (index: number) => void;
}) {
  return <div className="word-stage-list">
    {items.map((item, index) => <button
      key={item.key}
      type="button"
      className={index === currentIndex ? 'active' : ''}
      aria-current={index === currentIndex ? 'step' : undefined}
      onClick={() => onChoose(index)}
    >
      <span className="min-w-0 flex-1">{item.label}</span>
      {item.threeStage && <small className="max-w-[10rem] shrink-0 text-right text-xs leading-relaxed">
        {wordQueueStatus(item.stage, ready)}
      </small>}
    </button>)}
  </div>;
}

export function WordProgressHelp() {
  return <section aria-label="词汇进度说明">
    <h3>本组进度</h3>
    <p>完成数包含已有的有效学习记录，不等于本次刚学的词数，也不代表长期掌握。正常学习依次核对认义、语境和闭卷自评；到期词可能直接进行简短回忆核对。</p>
  </section>;
}
