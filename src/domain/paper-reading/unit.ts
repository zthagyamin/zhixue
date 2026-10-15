export type PaperReadingParagraph = {id: string; rawEn: string; pageNumber?: number};
export type PaperReadingDocument = {paperId: string; title: string; sections: {
    id: string; title: string; paragraphs: PaperReadingParagraph[];
}[]};
export type PaperReadingUnit = {
    paperId: string;
    sectionId: string;
    sectionTitle: string;
    paragraphs: PaperReadingParagraph[];
    physicalPages: number[];
    position: number;
    totalParagraphs: number;
    availableParagraphs: number;
    text: string;
    withinTaskBudget: boolean;
};

/** Read-only selection; source IDs and characters remain the original ones. */
export function createPaperReadingUnit(paper: PaperReadingDocument, position: number, count = 1): PaperReadingUnit {
    const total = paper.sections.reduce((sum, section) => sum + section.paragraphs.length, 0);
    if (!Number.isSafeInteger(position) || position < 0 || position >= total) throw Error('reading-unit-position');
    if (!Number.isSafeInteger(count) || count < 1) throw Error('reading-unit-range');
    let start = 0;
    for (const section of paper.sections) {
        const local = position - start;
        if (local >= 0 && local < section.paragraphs.length) {
            const available = section.paragraphs.length - local;
            if (count > available) throw Error('reading-unit-range');
            const paragraphs = section.paragraphs.slice(local, local + count).map(paragraph => ({...paragraph}));
            const text = paragraphs.map(paragraph => paragraph.rawEn).join('\n\n');
            return {paperId: paper.paperId, sectionId: section.id, sectionTitle: section.title,
                paragraphs, physicalPages: [...new Set(paragraphs.flatMap(p => p.pageNumber ? [p.pageNumber] : []))],
                position, totalParagraphs: total, availableParagraphs: available, text, withinTaskBudget: text.length <= 8000};
        }
        start += section.paragraphs.length;
    }
    throw Error('reading-unit-position');
}
