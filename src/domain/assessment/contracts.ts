export type FSRSRating = "again" | "hard" | "good" | "easy";
export type GradePayload = {
    correct?: boolean | null;
    verdict?: string;
    explanation?: string;
    rating?: FSRSRating;
    source?: "ai" | "self-assess" | string;
    confidence?: number;
    feedback?: string;
    matchedPoints?: string[];
    matchedPointIds?: string[];
    missedPointIds?: string[];
    missedPoints?: string[];
    aiFallback?: boolean;
};
